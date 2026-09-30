// Moves this computer's mouse for trackpad decks. Like the sound player, a
// helper is started once and kept running, because a finger sends dozens of
// moves a second:
//   macOS    helpers/mac-pointer.js under the built-in osascript
//   Windows  a PowerShell loop around user32's mouse_event
// Both take the same lines: "m dx dy", "s dx dy", "c left|right", "d", "u".
import { spawn } from "node:child_process"
import fs from "node:fs"
import type { ChildProcess } from "node:child_process"
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

/** Turns one message from a deck into a helper line, or null if it is not one. */
export function pointerLine(message: PointerMessage | unknown): string | null {
  if (!Array.isArray(message)) return null
  const [kind, a, b] = message as unknown[]
  const x = Number(a)
  const y = Number(b)
  if (kind === "m" && Number.isFinite(x) && Number.isFinite(y)) return `m ${clamp(x, 400)} ${clamp(y, 400)}`
  if (kind === "s" && Number.isFinite(x) && Number.isFinite(y)) return `s ${clamp(x, 2000)} ${clamp(y, 2000)}`
  if (kind === "c" && (a === "left" || a === "right")) return `c ${a}`
  if (kind === "d" || kind === "u") return kind
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
    if (testLog) return fs.appendFileSync(testLog, `${line}\n`)
    const child = start()
    if (child?.stdin?.writable) child.stdin.write(`${line}\n`)
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
