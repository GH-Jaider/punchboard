// The computer's main volume on Windows, through the Core Audio endpoint API.
// PowerShell compiles the small C# bridge once and then stays running,
// reading one command per line, because a fader sends several levels a second
// and compiling for each would lag behind the finger. Each command carries an
// id its answer repeats, so an answer that comes late (or never) cannot shift
// every later one onto the wrong request.
//   "<id> get"     answers "<id> ok <level>", 0..1
//   "<id> <0..1>"  sets the level and answers the same way
//   on failure     "<id> error <message, on one line>"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

const BRIDGE = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid context);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class PunchboardVolume {
  static IAudioEndpointVolume Endpoint() {
    var devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice device;
    Marshal.ThrowExceptionForHR(devices.GetDefaultAudioEndpoint(0, 1, out device));
    Guid id = typeof(IAudioEndpointVolume).GUID;
    object endpoint;
    Marshal.ThrowExceptionForHR(device.Activate(ref id, 23, IntPtr.Zero, out endpoint));
    return (IAudioEndpointVolume)endpoint;
  }
  public static float Get() { float level; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out level)); return level; }
  public static float Set(float level) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(level, Guid.Empty)); return Get(); }
}
"@
[Console]::Out.WriteLine("ready")
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $at = $line.IndexOf(" ")
  if ($at -lt 1) { continue }
  $id = $line.Substring(0, $at)
  $command = $line.Substring($at + 1)
  try {
    if ($command -eq "get") { $v = [PunchboardVolume]::Get() }
    else { $v = [PunchboardVolume]::Set([float]::Parse($command, [Globalization.CultureInfo]::InvariantCulture)) }
    [Console]::Out.WriteLine($id + " ok " + $v.ToString([Globalization.CultureInfo]::InvariantCulture))
  } catch {
    [Console]::Out.WriteLine($id + " error " + ($_.Exception.Message -replace "[\r\n]+", " "))
  }
}
`

interface Waiting {
  resolve: (level: number) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

/** How long one answer may take once the bridge runs, and how long the
    bridge's first-time compile may take before it is given up on. */
const ANSWER_MS = 8000
const START_MS = 30000

let bridge: ChildProcess | null = null
let ready = false
let startTimer: NodeJS.Timeout | undefined
let buffered = ""
let lastId = 0
const waiting = new Map<number, Waiting>()

function settle(id: number): Waiting | undefined {
  const entry = waiting.get(id)
  if (!entry) return undefined
  waiting.delete(id)
  clearTimeout(entry.timer)
  return entry
}

function failAll(error: Error): void {
  for (const id of [...waiting.keys()]) settle(id)?.reject(error)
}

/** An answer's clock starts once the bridge is ready, not during its compile. */
function startClock(id: number): void {
  const entry = waiting.get(id)
  if (!entry || entry.timer) return
  entry.timer = setTimeout(() => settle(id)?.reject(new Error("Windows took too long to answer about the volume.")), ANSWER_MS)
}

/** Forgets the bridge and fails whatever was waiting on it. */
function drop(child: ChildProcess, error: Error): void {
  if (bridge !== child) return
  bridge = null
  ready = false
  buffered = ""
  clearTimeout(startTimer)
  failAll(error)
}

function onLine(line: string): void {
  if (line === "ready") {
    ready = true
    clearTimeout(startTimer)
    for (const id of waiting.keys()) startClock(id)
    return
  }
  const match = /^(\d+) (ok|error) ?(.*)$/.exec(line)
  if (!match) return
  // An answer nobody waits for any more (it timed out) is dropped.
  const entry = settle(Number(match[1]))
  if (!entry) return
  if (match[2] === "ok") entry.resolve(Math.max(0, Math.min(1, Number(match[3]) || 0)))
  else entry.reject(new Error(`Windows would not change the volume: ${match[3] ?? ""}`))
}

function start(): ChildProcess {
  if (bridge) return bridge
  // The script travels as an argument, so stdin carries only the commands.
  const encoded = Buffer.from(BRIDGE, "utf16le").toString("base64")
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  bridge = child
  ready = false
  child.stdin?.on("error", () => { /* reported by its exit */ })
  child.stdout?.on("data", (chunk: Buffer) => {
    if (bridge !== child) return
    buffered += chunk.toString("utf8")
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ""
    for (const line of lines) if (line.trim()) onLine(line.trim())
  })
  const gone = (): void => drop(child, new Error("The volume helper stopped; try again."))
  child.on("error", gone)
  child.on("exit", gone)
  clearTimeout(startTimer)
  startTimer = setTimeout(() => {
    drop(child, new Error("Windows took too long to start the volume helper."))
    child.kill()
  }, START_MS)
  startTimer.unref()
  return child
}

function ask(command: string): Promise<number> {
  const child = start()
  lastId += 1
  const id = lastId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    if (ready) startClock(id)
    child.stdin?.write(`${id} ${command}\n`)
  })
}

export const readWindowsVolume = (): Promise<number> => ask("get")

// While a drag is in flight only the newest level matters: one set at a time,
// and whatever arrived meanwhile is sent next.
let inFlight: Promise<number> | null = null
let next: number | null = null

export function writeWindowsVolume(level: number): Promise<number> {
  if (inFlight) {
    next = level
    return inFlight
  }
  inFlight = ask(level.toFixed(3)).finally(() => {
    inFlight = null
    if (next !== null) {
      const queued = next
      next = null
      writeWindowsVolume(queued).catch(() => { /* reported by the next caller */ })
    }
  })
  return inFlight
}

/** Closes the bridge. Anything still waiting fails at once, and a queued
    write is dropped rather than starting a new bridge. */
export function stopWindowsVolume(): void {
  next = null
  const child = bridge
  if (!child) return
  child.stdin?.end()
  drop(child, new Error("The volume helper stopped."))
}
