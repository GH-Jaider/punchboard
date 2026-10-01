// Sends a key combination to whatever is focused on this computer, the way a
// hardware deck's hotkey button does.
//
// macOS: System Events key codes through the built-in osascript. The first
// time, macOS asks whether the app running Punchboard (Terminal) may control
// the computer; that is approved once under Accessibility.
// Windows: SendInput with keyboard scan codes, from a PowerShell helper that
// stays running (see WINDOWS_KEY_HELPER), no permission needed. Scan codes name the physical key, like the stored
// combination does, so Ctrl+= stays the key right of 0 on a Spanish or
// French keyboard; SendKeys, used before, typed characters instead (Ctrl+=
// became Ctrl+Shift+0 there). Like any program, it cannot reach apps running
// as administrator.
import { execFile, spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { MODIFIERS, parseCombo, unsendableReason } from "../shared/keys.ts"
import type { KeyCombo, Modifier } from "../shared/keys.ts"
import type { MediaKey } from "../shared/types.ts"
import { cleanPowerShellError, powershellArgs, powershellExe, psQuote, wrapScript } from "./powershell.ts"

// Virtual key codes for the physical keys, as macOS numbers them. F21 to F24
// have none: macOS cannot send them (src/shared/keys.ts says so when one is
// recorded).
export const MAC_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, equal: 24, "9": 25, "7": 26, minus: 27, "8": 28, "0": 29,
  bracketright: 30, o: 31, u: 32, bracketleft: 33, i: 34, p: 35, enter: 36, l: 37, j: 38, quote: 39, k: 40,
  semicolon: 41, backslash: 42, comma: 43, slash: 44, n: 45, m: 46, period: 47, tab: 48, space: 49, backquote: 50,
  backspace: 51, escape: 53, f17: 64, f18: 79, f19: 80, f20: 90, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101,
  f11: 103, f13: 105, f16: 106, f14: 107, f10: 109, f12: 111, f15: 113, home: 115, pageup: 116, delete: 117,
  f4: 118, end: 119, f2: 120, pagedown: 121, f1: 122, left: 123, right: 124, down: 125, up: 126
}
const MAC_MODIFIERS: Record<Modifier, string> = { ctrl: "control down", alt: "option down", shift: "shift down", meta: "command down" }

// Scan codes (set 1, what Windows calls a scan code) of the physical keys on
// a US keyboard, which is where KeyboardEvent.code takes its names from.
// EXTENDED marks the keys that arrive with an E0 prefix: without the extended
// flag, the arrows, Home, End, Page Up/Down and Delete would be read as the
// number pad's keys (8, 2, 4, 6... with Num Lock on).
const EXTENDED = 0xe000
export const WIN_SCAN_CODES: Record<string, number> = {
  escape: 0x01, "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06, "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0a, "0": 0x0b,
  minus: 0x0c, equal: 0x0d, backspace: 0x0e, tab: 0x0f,
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19, bracketleft: 0x1a, bracketright: 0x1b, enter: 0x1c,
  a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26, semicolon: 0x27, quote: 0x28, backquote: 0x29,
  backslash: 0x2b, z: 0x2c, x: 0x2d, c: 0x2e, v: 0x2f, b: 0x30, n: 0x31, m: 0x32, comma: 0x33, period: 0x34, slash: 0x35,
  space: 0x39,
  f1: 0x3b, f2: 0x3c, f3: 0x3d, f4: 0x3e, f5: 0x3f, f6: 0x40, f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
  // F13 to F24 as Windows' own keyboard layouts map them (kbd.h: T64 to T6E, then T76).
  f13: 0x64, f14: 0x65, f15: 0x66, f16: 0x67, f17: 0x68, f18: 0x69, f19: 0x6a, f20: 0x6b, f21: 0x6c, f22: 0x6d, f23: 0x6e, f24: 0x76,
  home: EXTENDED | 0x47, up: EXTENDED | 0x48, pageup: EXTENDED | 0x49, left: EXTENDED | 0x4b, right: EXTENDED | 0x4d,
  end: EXTENDED | 0x4f, down: EXTENDED | 0x50, pagedown: EXTENDED | 0x51, delete: EXTENDED | 0x53
}
// The left-hand modifier keys, which is what a person pressing them uses.
export const WIN_MODIFIER_SCAN_CODES: Record<Modifier, number> = { ctrl: 0x1d, alt: 0x38, shift: 0x2a, meta: EXTENDED | 0x5b }

// KEYBDINPUT.dwFlags.
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const KEYEVENTF_SCANCODE = 0x8

/** One keyboard event SendInput is given. */
export interface ScanInput {
  scan: number
  flags: number
}

/** The key presses for one combination, in order: the modifiers down in
    their fixed order, the key down and up, the modifiers up in reverse.
    Exposed for tests. */
export function windowsInputs(combo: KeyCombo): ScanInput[] {
  const key = WIN_SCAN_CODES[combo.key]
  if (key === undefined) throw new Error(`The ${combo.key.toUpperCase()} key cannot be sent on Windows.`)
  const modifiers = MODIFIERS.filter((modifier) => combo.modifiers.indexOf(modifier) !== -1).map((modifier) => WIN_MODIFIER_SCAN_CODES[modifier])
  const event = (code: number, up: boolean): ScanInput => ({
    scan: code & 0xff,
    flags: KEYEVENTF_SCANCODE | (code & EXTENDED ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0)
  })
  const down = modifiers.concat(key).map((code) => event(code, false))
  const up = [key].concat(modifiers.slice().reverse()).map((code) => event(code, true))
  return down.concat(up)
}

// SendInput's INPUT holds a union of the mouse, keyboard and hardware
// events; the mouse one is the largest, so it is declared too, or the size
// passed to SendInput would be wrong and Windows would refuse every event.
// The presses go in one call and the releases in another a moment later:
// some programs (games among them) look at which keys are down rather than
// at the events, and miss a key that is down and up in the same instant.
// The releases are in a finally, so a modifier is never left held down.
// No single quotes in here: it travels inside a PowerShell '...' string
// (psQuote would double them, but C# does not need any).
export const SCAN_KEYS_TYPE = `using System;
using System.Runtime.InteropServices;
using System.Threading;
namespace Punchboard {
  public static class ScanKeys {
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public static int Size { get { return Marshal.SizeOf(typeof(INPUT)); } }
    static INPUT[] Build(int[] scans, int[] flags, int from, int count) {
      INPUT[] inputs = new INPUT[count];
      for (int i = 0; i < count; i++) {
        inputs[i].type = 1;
        inputs[i].u.key.scan = (ushort)scans[from + i];
        inputs[i].u.key.flags = (uint)flags[from + i];
      }
      return inputs;
    }
    static uint Post(INPUT[] inputs) { return inputs.Length == 0 ? 0 : SendInput((uint)inputs.Length, inputs, Size); }
    public static int Send(int[] scans, int[] flags, int downs, bool dryRun) {
      if (scans.Length != flags.Length || downs < 0 || downs > scans.Length) throw new ArgumentException("The key list is malformed.");
      INPUT[] press = Build(scans, flags, 0, downs);
      INPUT[] release = Build(scans, flags, downs, scans.Length - downs);
      if (dryRun) return press.Length + release.Length;
      uint sent = 0;
      try {
        sent += Post(press);
        Thread.Sleep(30);
      } finally {
        sent += Post(release);
      }
      return (int)sent;
    }
    // The music keys mean the same on every layout: virtual keys, extended.
    public static void Media(byte vk) {
      keybd_event(vk, 0, 1, UIntPtr.Zero);
      keybd_event(vk, 0, 3, UIntPtr.Zero);
    }
  }
}`

// Compiling the C# takes PowerShell a second or more, too long to wait at
// every press of a hotkey, so it is compiled once by a helper that then stays
// running and reads one command per line (as the volume helper does):
//   "keys DOWNS SCANS FLAGS"  presses: DOWNS of the comma-separated events
//                             are presses, the rest releases
//   "dry DOWNS SCANS FLAGS"   builds the same events without sending them,
//                             and answers what it built (for the tests)
//   "media VK"                taps one music key
// Each answers one line, "ok ..." or "error MESSAGE". Numbers are parsed
// with the invariant culture, whatever the computer's language.
export const WINDOWS_KEY_HELPER = [
  `Add-Type -IgnoreWarnings -TypeDefinition ${psQuote(SCAN_KEYS_TYPE)}`,
  "$inv = [Globalization.CultureInfo]::InvariantCulture",
  "[Console]::Out.WriteLine('ready')",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "  try {",
  "    $parts = $line.Trim().Split(' ')",
  "    if ($parts[0] -eq 'media') {",
  "      [Punchboard.ScanKeys]::Media([byte]::Parse($parts[1], $inv))",
  "      [Console]::Out.WriteLine('ok')",
  "    } elseif (($parts[0] -eq 'keys' -or $parts[0] -eq 'dry') -and $parts.Length -eq 4) {",
  "      $downs = [int]::Parse($parts[1], $inv)",
  "      $scans = [int[]]@($parts[2].Split(',') | ForEach-Object { [int]::Parse($_, $inv) })",
  "      $flags = [int[]]@($parts[3].Split(',') | ForEach-Object { [int]::Parse($_, $inv) })",
  "      $sent = [Punchboard.ScanKeys]::Send($scans, $flags, $downs, ($parts[0] -eq 'dry'))",
  // SendInput does not say why it refused; a locked screen or an app run as
  // administrator in front are the usual reasons.
  "      if ($sent -ne $scans.Length) { [Console]::Out.WriteLine('error Windows took ' + $sent + ' of ' + $scans.Length + ' key events: is the screen locked, or an app running as administrator in front?') }",
  "      elseif ($parts[0] -eq 'dry') { [Console]::Out.WriteLine('ok ' + $sent + ' ' + [Punchboard.ScanKeys]::Size + ' ' + ($scans -join ',') + ' ' + ($flags -join ',')) }",
  "      else { [Console]::Out.WriteLine('ok ' + $sent) }",
  "    } else {",
  "      [Console]::Out.WriteLine('error Punchboard sent the key helper something it does not know.')",
  "    }",
  "  } catch {",
  "    [Console]::Out.WriteLine('error ' + ($_.Exception.Message -replace '\\s+', ' '))",
  "  }",
  "}"
].join("\n")

/** The helper command for one combination, exposed for tests. */
export function windowsKeyLine(combo: KeyCombo, dryRun = false): string {
  const inputs = windowsInputs(combo)
  const scans = inputs.map((input) => String(input.scan)).join(",")
  const flags = inputs.map((input) => String(input.flags)).join(",")
  return `${dryRun ? "dry" : "keys"} ${combo.modifiers.length + 1} ${scans} ${flags}`
}

interface Waiting {
  resolve: (answer: string) => void
  reject: (error: Error) => void
}

let helper: ChildProcess | null = null
let buffered = ""
let errors = ""
const waiting: Waiting[] = []

function startHelper(): ChildProcess {
  if (helper) return helper
  const child = spawn(powershellExe(), powershellArgs(wrapScript(WINDOWS_KEY_HELPER)), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  helper = child
  buffered = ""
  errors = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8")
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (line === "ready" || !line.trim()) continue
      const entry = waiting.shift()
      if (!entry) continue
      if (/^ok\b/.test(line)) entry.resolve(line.slice(2).trim())
      else entry.reject(new Error(line.replace(/^error /, "")))
    }
  })
  // Only read if the helper dies: a compile error, for one.
  child.stderr?.on("data", (chunk: Buffer) => { if (errors.length < 8000) errors += chunk.toString("utf8") })
  const gone = (): void => {
    if (helper !== child) return
    helper = null
    const reason = cleanPowerShellError(errors) || "The key helper stopped; press again."
    for (const entry of waiting.splice(0)) entry.reject(new Error(reason))
  }
  child.on("error", gone)
  child.on("exit", gone)
  child.stdin?.on("error", () => { /* reported by "exit" */ })
  return child
}

/** Sends one command to the key helper and resolves with its answer, after
    "ok". Exposed for tests. The first one waits for PowerShell to start and
    compile, so the time allowed is generous; an answer that never comes
    stops the helper, so it cannot be taken for the next command's. */
export function windowsKeyRequest(command: string, timeoutMs = 20000): Promise<string> {
  const child = startHelper()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry)
      if (index !== -1) waiting.splice(index, 1)
      reject(new Error("Windows took too long to take the keys."))
      child.kill()
    }, timeoutMs)
    const entry: Waiting = {
      resolve: (answer) => { clearTimeout(timer); resolve(answer) },
      reject: (error) => { clearTimeout(timer); reject(error) }
    }
    waiting.push(entry)
    child.stdin?.write(`${command}\n`)
  })
}

/** Lets the helper end (its input closes), for tests and shutdown. */
export function stopWindowsKeys(): void {
  helper?.stdin?.end()
  helper = null
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()))
      else resolve(String(stdout))
    })
  })
}

/** The AppleScript for one combination, exposed for tests. */
export function macScript(combo: KeyCombo): string {
  const code = MAC_CODES[combo.key]
  if (code === undefined) throw new Error(unsendableReason(combo.key, "mac") ?? `The ${combo.key.toUpperCase()} key cannot be sent on macOS.`)
  const using = combo.modifiers.map((modifier) => MAC_MODIFIERS[modifier]).join(", ")
  return `tell application "System Events" to key code ${code}${using ? ` using {${using}}` : ""}`
}

async function sendMac(combo: KeyCombo): Promise<void> {
  try {
    await run("osascript", ["-e", macScript(combo)])
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (/not allowed|assistive|accessibility|1002/i.test(text)) {
      throw new Error("macOS needs permission first: open System Settings › Privacy & Security › Accessibility, allow the app that runs Punchboard (Terminal), then press again.")
    }
    throw new Error(`Could not send the keys. (${text})`)
  }
}

async function sendWindows(combo: KeyCombo): Promise<void> {
  try {
    await windowsKeyRequest(windowsKeyLine(combo))
  } catch (error) {
    throw new Error(`Could not send the keys. (${error instanceof Error ? error.message : String(error)})`)
  }
}

export async function sendKeys(text: string | undefined): Promise<void> {
  const combo = parseCombo(text)
  if (!combo) throw new Error("Record a key combination for this step first.")
  if (process.platform === "darwin") return sendMac(combo)
  if (process.platform === "win32") return sendWindows(combo)
  throw new Error("Key combinations work on macOS and Windows only for now.")
}

// ------------------------------------------------------------- media keys

// The keyboard's music keys are not ordinary keys: macOS sends them as
// "system defined" events (NX_KEYTYPE_*), Windows as VK_MEDIA_* virtual keys.
// They mean the same on every layout, so virtual keys are right for them.
const MAC_MEDIA: Record<MediaKey, number> = { play_pause: 16, next: 17, previous: 18 }
const WIN_MEDIA: Record<MediaKey, number> = { play_pause: 0xb3, next: 0xb0, previous: 0xb1 }

/** The JXA that presses and releases one media key, exposed for tests.
    With `dryRun` it builds the events without sending them. */
export function macMediaScript(key: MediaKey, dryRun = false): string {
  return `ObjC.import("Cocoa"); ObjC.import("CoreGraphics");
ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []]);
ObjC.bindFunction("CGRequestPostEventAccess", ["bool", []]);
if (!$.CGPreflightPostEventAccess()) { $.CGRequestPostEventAccess(); throw new Error("not allowed to post events"); }
function send(down) {
  var event = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    14, $.NSMakePoint(0, 0), down ? 0xa00 : 0xb00, 0, 0, null, 8, (${MAC_MEDIA[key]} << 16) | ((down ? 0xa : 0xb) << 8), -1);
  // performSelector hands back the real CGEventRef; the CGEvent property does not survive the bridge.
  var cg = event.performSelector("CGEvent");
  if (${dryRun ? "true" : "false"}) return $.CFGetTypeID(cg) === $.CGEventGetTypeID();
  $.CGEventPost(0, cg);
  return true;
}
String(send(true) && send(false));`
}

/** The key helper's command for one music key, exposed for tests. */
export const windowsMediaLine = (key: MediaKey): string => `media ${WIN_MEDIA[key]}`

export async function sendMediaKey(key: MediaKey): Promise<void> {
  if (process.platform === "darwin") {
    try {
      await run("osascript", ["-l", "JavaScript", "-e", macMediaScript(key)])
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (/not allowed/i.test(text)) {
        throw new Error("macOS needs permission first: open System Settings › Privacy & Security › Accessibility, allow Punchboard, then press again.")
      }
      throw new Error(`Could not send the music key. (${text})`)
    }
    return
  }
  if (process.platform === "win32") {
    try {
      await windowsKeyRequest(windowsMediaLine(key))
    } catch (error) {
      throw new Error(`Could not send the music key. (${error instanceof Error ? error.message : String(error)})`)
    }
    return
  }
  throw new Error("Music controls work on macOS and Windows only for now.")
}
