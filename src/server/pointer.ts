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
const WINDOWS = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PunchboardPointer {
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Run(string line) {
    var p = line.Split(' ');
    switch (p[0]) {
      case "m": mouse_event(0x0001, int.Parse(p[1]), int.Parse(p[2]), 0, UIntPtr.Zero); break;
      case "s":
        int dy = int.Parse(p[2]) * 3, dx = -int.Parse(p[1]) * 3;
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
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        mouse_event(0x0800, 0, 0, int.Parse(p[1]) * 120, UIntPtr.Zero);
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
        break;
      case "k":
        var keys = Array.ConvertAll(p[1].Split(','), byte.Parse);
        foreach (var k in keys) keybd_event(k, 0, 1, UIntPtr.Zero);
        for (int i = keys.Length - 1; i >= 0; i--) keybd_event(keys[i], 0, 3, UIntPtr.Zero);
        break;
    }
  }
}
"@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line -eq "q") { break }
  try { [PunchboardPointer]::Run($line) } catch { [Console]::Out.WriteLine('{"error":"' + $_.Exception.Message.Replace('"', "'") + '"}') }
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

// Windows virtual keys, pressed in order and released in reverse.
const VK = { win: 0x5b, ctrl: 0x11, alt: 0x12, shift: 0x10, tab: 0x09, d: 0x44, s: 0x53, left: 0x25, right: 0x27 }
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

export function createPointer(options: PointerOptions) {
  let helper: ChildProcess | null = null
  let buffered = ""
  let leftHeld = false

  function start(): ChildProcess | null {
    if (helper) return helper
    let child: ChildProcess
    if (process.platform === "darwin") {
      child = spawn("osascript", ["-l", "JavaScript", options.macHelper], { stdio: ["pipe", "pipe", "ignore"] })
    } else if (process.platform === "win32") {
      const encoded = Buffer.from(WINDOWS, "utf16le").toString("base64")
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
    } else {
      options.onProblem("The trackpad works on macOS and Windows only for now.")
      return null
    }
    helper = child
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
    }
    child.on("error", (error) => {
      options.log(`The trackpad helper could not start: ${error.message}`)
      gone()
    })
    child.on("exit", gone)
    return child
  }

  // Tests set PUNCHBOARD_POINTER_LOG to a file: lines go there, the mouse stays put.
  const testLog = process.env.PUNCHBOARD_POINTER_LOG

  function send(message: unknown): void {
    const line = pointerLine(message)
    if (!line) return
    if (line === "d") leftHeld = true
    if (line === "u") leftHeld = false
    // Turned into zoom steps before anything is written, so tests see what the computer would.
    if (line.startsWith("pinch ")) return pinchSteps(line)
    if (testLog) return fs.appendFileSync(testLog, `${line}\n`)
    if (line === "app") return openLauncher()
    const child = start()
    if (child?.stdin?.writable) child.stdin.write(`${line}\n`)
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

  /** A deck went away mid-drag: never leave the button held down. */
  function release(): void {
    if (leftHeld) send(["u"])
  }

  function dispose(): void {
    release()
    const child = helper
    if (!child) return
    child.stdin?.write("q\n")
    setTimeout(() => { if (helper === child) child.kill() }, 300).unref()
  }

  return { send, release, dispose }
}
