// Sends a key combination to whatever is focused on this computer, the way a
// hardware deck's hotkey button does.
//
// macOS: System Events key codes through the built-in osascript. The first
// time, macOS asks whether the app running Punchboard (Terminal) may control
// the computer; that is approved once under Accessibility.
// Windows: System.Windows.Forms.SendKeys through PowerShell, no permission
// needed. SendKeys has no Win key and cannot reach apps running as
// administrator.
import { execFile } from "node:child_process"
import { parseCombo } from "../shared/keys.ts"
import type { KeyCombo, Modifier } from "../shared/keys.ts"

// Virtual key codes for the physical keys, as macOS numbers them.
const MAC_CODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, equal: 24, "9": 25, "7": 26, minus: 27, "8": 28, "0": 29,
  bracketright: 30, o: 31, u: 32, bracketleft: 33, i: 34, p: 35, enter: 36, l: 37, j: 38, quote: 39, k: 40,
  semicolon: 41, backslash: 42, comma: 43, slash: 44, n: 45, m: 46, period: 47, tab: 48, space: 49, backquote: 50,
  backspace: 51, escape: 53, f17: 64, f18: 79, f19: 80, f20: 90, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101,
  f11: 103, f13: 105, f16: 106, f14: 107, f10: 109, f12: 111, f15: 113, home: 115, pageup: 116, delete: 117,
  f4: 118, end: 119, f2: 120, pagedown: 121, f1: 122, left: 123, right: 124, down: 125, up: 126
}
const MAC_MODIFIERS: Record<Modifier, string> = { ctrl: "control down", alt: "option down", shift: "shift down", meta: "command down" }

// SendKeys tokens. Letters and digits are themselves; characters SendKeys
// treats specially go in braces.
const WIN_KEYS: Record<string, string> = {
  enter: "{ENTER}", space: " ", tab: "{TAB}", escape: "{ESC}", backspace: "{BACKSPACE}", delete: "{DELETE}",
  up: "{UP}", down: "{DOWN}", left: "{LEFT}", right: "{RIGHT}", home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
  minus: "-", equal: "=", comma: ",", period: ".", slash: "/", backquote: "`", bracketleft: "{[}", bracketright: "{]}",
  backslash: "\\", semicolon: ";", quote: "'"
}
const WIN_MODIFIERS: Record<Modifier, string> = { ctrl: "^", alt: "%", shift: "+", meta: "" }

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
  if (code === undefined) throw new Error(`The ${combo.key.toUpperCase()} key cannot be sent on macOS.`)
  const using = combo.modifiers.map((modifier) => MAC_MODIFIERS[modifier]).join(", ")
  return `tell application "System Events" to key code ${code}${using ? ` using {${using}}` : ""}`
}

/** The SendKeys string for one combination, exposed for tests. */
export function windowsKeys(combo: KeyCombo): string {
  if (combo.modifiers.indexOf("meta") !== -1) throw new Error("The Windows key cannot be part of a combination here; use Ctrl, Alt and Shift.")
  const fn = /^f([0-9]{1,2})$/.exec(combo.key)
  if (fn && Number(fn[1]) > 16) throw new Error(`Windows can send F1 to F16 only, not ${combo.key.toUpperCase()}.`)
  const key = fn ? `{F${fn[1]}}` : WIN_KEYS[combo.key] ?? combo.key
  return combo.modifiers.map((modifier) => WIN_MODIFIERS[modifier]).join("") + key
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
  const keys = windowsKeys(combo).replace(/'/g, "''")
  const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`
  try {
    await run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
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
