// The computer's main volume on Windows, through the Core Audio endpoint API.
// PowerShell compiles the small C# bridge once and then stays running,
// reading one command per line, because a fader sends several levels a second
// and compiling for each would lag behind the finger.
//   "get"     answers the level, 0..1
//   "<0..1>"  sets the level and answers it
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
  try {
    if ($line -eq "get") { $v = [PunchboardVolume]::Get() }
    else { $v = [PunchboardVolume]::Set([float]::Parse($line, [Globalization.CultureInfo]::InvariantCulture)) }
    [Console]::Out.WriteLine("ok " + $v.ToString([Globalization.CultureInfo]::InvariantCulture))
  } catch {
    [Console]::Out.WriteLine("error " + $_.Exception.Message)
  }
}
`

interface Waiting {
  resolve: (level: number) => void
  reject: (error: Error) => void
}

let bridge: ChildProcess | null = null
let buffered = ""
const waiting: Waiting[] = []

function failAll(error: Error): void {
  for (const entry of waiting.splice(0)) entry.reject(error)
}

function start(): ChildProcess {
  if (bridge) return bridge
  // The script travels as an argument, so stdin carries only the commands.
  const encoded = Buffer.from(BRIDGE, "utf16le").toString("base64")
  const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
  bridge = child
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8")
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ""
    for (const line of lines) {
      if (line === "ready" || !line.trim()) continue
      const entry = waiting.shift()
      if (!entry) continue
      if (line.startsWith("ok ")) entry.resolve(Math.max(0, Math.min(1, Number(line.slice(3)) || 0)))
      else entry.reject(new Error(`Windows would not change the volume: ${line.replace(/^error /, "")}`))
    }
  })
  const gone = (): void => {
    if (bridge !== child) return
    bridge = null
    buffered = ""
    failAll(new Error("The volume helper stopped; try again."))
  }
  child.on("error", gone)
  child.on("exit", gone)
  return child
}

function ask(command: string): Promise<number> {
  const child = start()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry)
      if (index !== -1) waiting.splice(index, 1)
      reject(new Error("Windows took too long to answer about the volume."))
    }, 8000)
    const entry: Waiting = {
      resolve: (level) => { clearTimeout(timer); resolve(level) },
      reject: (error) => { clearTimeout(timer); reject(error) }
    }
    waiting.push(entry)
    child.stdin?.write(`${command}\n`)
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

export function stopWindowsVolume(): void {
  bridge?.stdin?.end()
  bridge = null
}
