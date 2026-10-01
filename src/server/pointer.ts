// Moves this computer's mouse for trackpad decks. Like the sound player, a
// helper is started once and kept running, because a finger sends dozens of
// moves a second:
//   macOS    helpers/mac-pointer.js under the built-in osascript
//   Windows  a PowerShell loop around user32's mouse_event
// Both take the same lines: "m dx dy", "s dx dy", "c left|right", "d", "u",
// and "k …" for a gesture's shortcut ("z ±1" zooms on Windows).
import { spawn } from "node:child_process"
import fs from "node:fs"
import type { ChildProcess } from "node:child_process"
import { spawn as spawnApp } from "node:child_process"
import type { PointerMessage } from "../shared/api.ts"

export interface PointerOptions {
  /** helpers/mac-pointer.js */
  macHelper: string
  log: (message: string) => void
  /** A problem worth showing on the deck, such as a missing permission. */
  onProblem: (message: string) => void
}

export type Pointer = ReturnType<typeof createPointer>

// Scroll arrives in pixels (positive is up and left). Windows counts wheel
// units, 120 to a notch, with positive meaning up and right.
export const WINDOWS_POINTER = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
public static class PunchboardPointer {
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  // Numbers come from the companion, never in this computer's own format.
  static int Int(string text) { return int.Parse(text, NumberStyles.Integer, CultureInfo.InvariantCulture); }
  static byte Key(string text) { return byte.Parse(text, NumberStyles.Integer, CultureInfo.InvariantCulture); }
  // Only these keys are "extended". Flagging a plain modifier presses its
  // right-hand twin instead: Alt becomes AltGr on Spanish and German layouts.
  static bool Extended(byte k) {
    return k == 0x5B || k == 0x5C || (k >= 0x21 && k <= 0x28) || k == 0x2D || k == 0x2E || (k >= 0xAD && k <= 0xB7);
  }
  // A message may hold quotes, backslashes or line breaks; the companion reads one JSON object per line.
  public static string Error(string message) {
    var text = new StringBuilder("{\"error\":\"");
    foreach (char c in message ?? "") {
      if (c == '"' || c == '\\') text.Append('\\').Append(c);
      else if (c < ' ') text.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
      else text.Append(c);
    }
    return text.Append("\"}").ToString();
  }
  public static void Run(string line) {
    var p = line.Split(' ');
    switch (p[0]) {
      case "m": mouse_event(0x0001, Int(p[1]), Int(p[2]), 0, UIntPtr.Zero); break;
      case "s":
        int dy = Int(p[2]) * 3, dx = -Int(p[1]) * 3;
        if (dy != 0) mouse_event(0x0800, 0, 0, dy, UIntPtr.Zero);
        if (dx != 0) mouse_event(0x1000, 0, 0, dx, UIntPtr.Zero);
        break;
      case "c":
        if (p[1] == "right") { mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero); }
        else { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
        break;
      case "d": mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); break;
      case "u": mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); break;
      case "z":
        keybd_event(0xA2, 0, 0, UIntPtr.Zero);
        mouse_event(0x0800, 0, 0, Int(p[1]) * 120, UIntPtr.Zero);
        keybd_event(0xA2, 0, 2, UIntPtr.Zero);
        break;
      case "k":
        var keys = Array.ConvertAll(p[1].Split(','), Key);
        foreach (var k in keys) keybd_event(k, 0, Extended(k) ? 1u : 0u, UIntPtr.Zero);
        for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, Extended(keys[i]) ? 3u : 2u, UIntPtr.Zero);
        break;
    }
  }
}
"@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq "q") { break }
  try { [PunchboardPointer]::Run($line) } catch { [Console]::Out.WriteLine([PunchboardPointer]::Error($_.Exception.Message)) }
}
`

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, Math.round(value)))

// ---------------------------------------------------------------- gestures
//
// No system lets a program perform a real trackpad gesture, so each one
// becomes the shortcut that system already has for it. Swipes are named for
// what the fingers did: fingers moving left bring in what is on the right.

const MAC_FLAGS = { cmd: 0x100000, ctrl: 0x40000, shift: 0x20000, alt: 0x80000, fn: 0x800000 }
/** macOS key codes. Arrows carry the fn flag, as a real keyboard sends them. */
const MAC_KEY = { up: 126, down: 125, left: 123, right: 124, d: 2, f11: 103, equal: 24, minus: 27 }
const mac = (code: number, flags: number): string => `k ${code} ${flags}`
const macArrow = (code: number): string => mac(code, MAC_FLAGS.ctrl | MAC_FLAGS.fn)

const MAC_GESTURES: Record<string, string> = {
  up: macArrow(MAC_KEY.up), // Mission Control
  down: macArrow(MAC_KEY.down), // App Exposé
  left: macArrow(MAC_KEY.right), // the desktop or full-screen app to the right
  right: macArrow(MAC_KEY.left), // … and to the left
  tap: mac(MAC_KEY.d, MAC_FLAGS.ctrl | MAC_FLAGS.cmd), // Look Up
  spread: mac(MAC_KEY.f11, 0), // Show Desktop
  pinch: "app" // the app launcher, opened by name below
}

// Windows virtual keys, pressed in order and released in reverse. Modifiers
// are the left-hand keys (VK_LCONTROL, VK_LMENU, VK_LSHIFT), sent without the
// extended flag, so no keyboard layout reads Alt as AltGr.
const VK = { win: 0x5b, ctrl: 0xa2, alt: 0xa4, shift: 0xa0, tab: 0x09, d: 0x44, s: 0x53, left: 0x25, right: 0x27 }
const win = (...keys: number[]): string => `k ${keys.join(",")}`
const WINDOWS_GESTURES: Record<string, string> = {
  up: win(VK.win, VK.tab), // Task View
  down: win(VK.win, VK.d), // Show Desktop
  left: win(VK.alt, VK.tab), // the next app
  right: win(VK.alt, VK.shift, VK.tab), // … the previous one
  tap: win(VK.win, VK.s), // Search
  spread: win(VK.win, VK.d),
  pinch: win(VK.win, VK.tab)
}
// Four fingers left and right move between virtual desktops on Windows.
const WINDOWS_FOUR: Record<string, string> = {
  left: win(VK.ctrl, VK.win, VK.right),
  right: win(VK.ctrl, VK.win, VK.left)
}

/** Turns one message from a deck into a helper line, or null if it is not one.
    "app" asks for the app launcher, which is opened rather than typed. */
export function pointerLine(message: PointerMessage | unknown, platform: NodeJS.Platform = process.platform): string | null {
  if (!Array.isArray(message)) return null
  const [kind, a, b] = message as unknown[]
  const x = Number(a)
  const y = Number(b)
  if (kind === "m" && Number.isFinite(x) && Number.isFinite(y)) return `m ${clamp(x, 400)} ${clamp(y, 400)}`
  if (kind === "s" && Number.isFinite(x) && Number.isFinite(y)) return `s ${clamp(x, 2000)} ${clamp(y, 2000)}`
  if (kind === "c" && (a === "left" || a === "right")) return `c ${a}`
  if (kind === "d" || kind === "u") return kind
  if (kind === "z" && (x === 1 || x === -1)) {
    // Pinch zoom: Cmd +/- on a Mac, Ctrl + wheel on Windows.
    return platform === "darwin" ? mac(x > 0 ? MAC_KEY.equal : MAC_KEY.minus, MAC_FLAGS.cmd) : `z ${x}`
  }
  if (kind === "p" && (a === "begin" || a === "change" || a === "end") && Number.isFinite(y)) {
    // A real magnify gesture on a Mac: phases as the system numbers them
    // (began 1, changed 2, ended 4), the magnification kept to a sane step.
    // Windows has no such event; the pointer turns it into zoom steps.
    const magnification = Math.max(-0.5, Math.min(0.5, y))
    return platform === "darwin" ? `p ${a === "begin" ? 1 : a === "change" ? 2 : 4} ${magnification.toFixed(4)}` : `pinch ${a} ${magnification.toFixed(4)}`
  }
  if (kind === "g" && (a === 3 || a === 4) && typeof b === "string" && Object.prototype.hasOwnProperty.call(MAC_GESTURES, b)) {
    if (platform === "darwin") return MAC_GESTURES[b] ?? null
    return (a === 4 ? WINDOWS_FOUR[b] : undefined) ?? WINDOWS_GESTURES[b] ?? null
  }
  return null
}

/** A helper that dies sooner than this after starting counts as failing. */
const QUICK_DEATH_MS = 10000
/** The longest wait before starting a failing helper again. */
const MAX_RETRY_MS = 30000
/** Quick deaths in a row before the deck is told. */
const DEATHS_REPORTED = 3

function spawnHelper(macHelper: string): ChildProcess | null {
  if (process.platform === "darwin") {
    return spawn("osascript", ["-l", "JavaScript", macHelper], { stdio: ["pipe", "pipe", "ignore"] })
  }
  if (process.platform === "win32") {
    const encoded = Buffer.from(WINDOWS_POINTER, "utf16le").toString("base64")
    return spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  }
  return null
}

/** Who sent a message: each open trackpad socket is its own owner. */
export type PointerOwner = object

export function createPointer(options: PointerOptions & {
  /** Tests start a stand-in helper here, so the real mouse is never touched. */
  spawn?: () => ChildProcess | null
  /** Tests ignore PUNCHBOARD_POINTER_LOG with this, to reach the helper. */
  ignoreTestLog?: boolean
}) {
  let helper: ChildProcess | null = null
  let buffered = ""
  // The computer has one left button and one pinch in progress, whoever holds
  // them. A deck that goes away lets go only of what it holds itself, never
  // of a drag another deck is in the middle of.
  let leftHeld = false
  let leftOwner: PointerOwner | null = null
  let pinchOpen = false
  let pinchOwner: PointerOwner | null = null
  let stopping = false
  // A helper that keeps dying (osascript refused, PowerShell blocked) is
  // started again after a growing wait, not on every move a finger sends.
  let quickDeaths = 0
  let retryAt = 0
  let reported = false

  function start(): ChildProcess | null {
    if (helper) return helper
    if (Date.now() < retryAt) return null
    const child = options.spawn ? options.spawn() : spawnHelper(options.macHelper)
    if (!child) {
      if (!reported) options.onProblem("The trackpad works on macOS and Windows only for now.")
      reported = true
      return null
    }
    helper = child
    const startedAt = Date.now()
    // A helper that dies while moves stream in makes its stdin fail with
    // EPIPE, after the write has returned. Unheard, that error ends the companion.
    child.stdin?.on("error", (error) => options.log(`The trackpad helper stopped reading: ${error.message}`))
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      const lines = buffered.split(/\r?\n/)
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        let problem: string | undefined
        try { problem = (JSON.parse(line) as { error?: string }).error } catch { continue }
        if (!problem) continue
        options.log(`Trackpad: ${problem}`)
        options.onProblem(/not allowed/i.test(problem)
          ? "macOS needs permission first: System Settings › Privacy & Security › Accessibility, allow Punchboard (or Terminal when run from source)."
          : `The computer refused the trackpad: ${problem}`)
      }
    })
    const gone = (): void => {
      if (helper !== child) return
      helper = null
      buffered = ""
      if (stopping) return
      if (Date.now() - startedAt >= QUICK_DEATH_MS) {
        // It ran a good while: start the next one straight away.
        quickDeaths = 0
        retryAt = 0
        reported = false
        return
      }
      quickDeaths += 1
      retryAt = Date.now() + Math.min(MAX_RETRY_MS, 500 * 2 ** (quickDeaths - 1))
      if (quickDeaths >= DEATHS_REPORTED && !reported) {
        reported = true
        options.log("The trackpad helper keeps stopping; trying again less often.")
        options.onProblem("The trackpad helper on this computer keeps stopping. Restart Punchboard; if it goes on, check that nothing blocks osascript or PowerShell.")
      }
    }
    child.on("error", (error) => {
      options.log(`The trackpad helper could not start: ${error.message}`)
      gone()
    })
    child.on("exit", gone)
    return child
  }

  /** Writes a line if the helper is alive to read it. */
  function write(child: ChildProcess | null, line: string): void {
    const stdin = child?.stdin
    if (!child || !stdin || child.exitCode !== null || child.signalCode !== null || stdin.destroyed || !stdin.writable) return
    stdin.write(`${line}\n`)
  }

  // Tests set PUNCHBOARD_POINTER_LOG to a file: lines go there, the mouse stays put.
  const testLog = options.ignoreTestLog ? undefined : process.env.PUNCHBOARD_POINTER_LOG

  function send(message: unknown, owner: PointerOwner | null = null): void {
    const line = pointerLine(message)
    if (!line) return
    if (line === "d") { leftHeld = true; leftOwner = owner }
    if (line === "u") { leftHeld = false; leftOwner = null }
    const phase: unknown = Array.isArray(message) && message[0] === "p" ? message[1] : undefined
    if (phase === "begin" || phase === "change") { pinchOpen = true; pinchOwner = owner }
    if (phase === "end") { pinchOpen = false; pinchOwner = null }
    // Turned into zoom steps before anything is written, so tests see what the computer would.
    if (line.startsWith("pinch ")) return pinchSteps(line)
    if (testLog) return fs.appendFileSync(testLog, `${line}\n`)
    if (line === "app") return openLauncher()
    write(start(), line)
  }

  // Windows: a pinch becomes Ctrl + wheel steps, about one per 35% of zoom.
  let pinchCarry = 0
  function pinchSteps(line: string): void {
    const parts = line.split(" ")
    if (parts[1] === "begin") pinchCarry = 0
    pinchCarry += Math.log(1 + (Number(parts[2]) || 0))
    while (Math.abs(pinchCarry) >= 0.3) {
      const zoomIn = pinchCarry > 0
      send(["z", zoomIn ? 1 : -1])
      pinchCarry += zoomIn ? -0.3 : 0.3
    }
    if (parts[1] === "end") pinchCarry = 0
  }

  /** Four fingers pinching on a Mac: the app launcher (Apps on macOS 26, Launchpad before). */
  function openLauncher(): void {
    const tryApp = (names: string[]): void => {
      const [name, ...rest] = names
      if (!name) return
      spawnApp("open", ["-a", name], { stdio: "ignore" }).on("exit", (code) => { if (code !== 0) tryApp(rest) })
    }
    tryApp(["Apps", "Launchpad"])
  }

  /** A deck went away mid-drag or mid-pinch: never leave the button held
      down or a pinch open. Only what this owner started is let go; null lets
      go of everything. */
  function release(owner: PointerOwner | null = null): void {
    if (leftHeld && (owner === null || leftOwner === owner)) send(["u"])
    if (pinchOpen && (owner === null || pinchOwner === owner)) send(["p", "end", 0])
  }

  function dispose(): void {
    release()
    stopping = true
    const child = helper
    if (!child) return
    write(child, "q")
    setTimeout(() => { if (helper === child) child.kill() }, 300).unref()
  }

  return { send, release, dispose }
}
