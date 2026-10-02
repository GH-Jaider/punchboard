// The computer's volume on Windows, through Core Audio: the main output
// (the endpoint API) and each application's own (its audio sessions, the
// mixer Windows shows as "Volume mixer"). PowerShell compiles the small C#
// bridge once and then stays running, reading one command per line, because
// a fader sends several levels a second and compiling for each would lag
// behind the finger. Each command carries an id its answer repeats, so an
// answer that comes late (or never) cannot shift every later one onto the
// wrong request.
//   "<id> get"                  answers "<id> ok <level>", 0..1
//   "<id> <0..1>"               sets the level and answers the same way
//   "<id> app-get <key>"        an app's level: "<id> ok <level>", or
//                               "<id> ok none" when it has no audio session
//   "<id> app-set <0..1> <key>" sets every session of every process named
//                               <key> and answers like app-get (the level
//                               comes first: a key may hold spaces)
//   "<id> list <pid>"           "<id> ok <JSON>": [{"key","name","level"}]
//                               for every app with an audio session, leaving
//                               out <pid> (the companion) and its children
//   on failure                  "<id> error <message, on one line>"
// The app key is the process name without .exe, lower-cased ("chrome"), so a
// fader keeps working across restarts, and one key covers all of an app's
// processes: Chrome plays from several.
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { powershellExe } from "./powershell.ts"

export const BRIDGE = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid context);
  int j();
  int GetMasterVolumeLevelScalar(out float level);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object endpoint); }
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out uint count); int Item(uint index, out IMMDevice device); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int flow, int stateMask, out IMMDeviceCollection devices);
  int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int f(); int g(); int GetSessionEnumerator(out IAudioSessionEnumerator sessions); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int count); int GetSession(int index, out IAudioSessionControl2 session); }
// IAudioSessionControl's nine methods (only GetState is used), then
// IAudioSessionControl2's identifiers, process id and system-sounds test.
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int GetState(out int state);
  int f(); int g(); int h(); int i(); int j(); int k(); int l(); int m();
  int n(); int o();
  int GetProcessId(out uint id);
  int IsSystemSoundsSession();
}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume {
  int SetMasterVolume(float level, ref Guid context);
  int GetMasterVolume(out float level);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class PunchboardVolume {
  static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
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

  class Session { public string Key; public int Pid; public ISimpleAudioVolume Volume; }

  // Every live app session on every active output, not just the default
  // one: a game or Discord may play to a headset while the rest plays to
  // the speakers. The system sounds session, sessions that have ended and
  // those of processes already gone are left out. A computer with no output
  // (or no audio service) has no sessions, which is not an error.
  static List<Session> Sessions() {
    var found = new List<Session>();
    var names = new Dictionary<int, string>();
    IMMDeviceCollection devices = null;
    uint count = 0;
    try {
      if (((IMMDeviceEnumerator)new MMDeviceEnumerator()).EnumAudioEndpoints(0, 1, out devices) != 0 || devices.GetCount(out count) != 0) return found;
    } catch (COMException) { return found; }
    for (uint d = 0; d < count; d++) {
      IMMDevice device;
      if (devices.Item(d, out device) != 0) continue;
      Guid id = typeof(IAudioSessionManager2).GUID;
      object manager;
      if (device.Activate(ref id, 23, IntPtr.Zero, out manager) != 0) continue;
      IAudioSessionEnumerator sessions;
      if (((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions) != 0) continue;
      int total;
      if (sessions.GetCount(out total) != 0) continue;
      for (int i = 0; i < total; i++) {
        IAudioSessionControl2 session;
        if (sessions.GetSession(i, out session) != 0) continue;
        int state;
        uint pid;
        if (session.GetState(out state) != 0 || state == 2) continue;
        if (session.IsSystemSoundsSession() == 0) continue;
        // A session shared by several processes answers with a success code
        // other than 0 and no one process: it belongs to no app key.
        if (session.GetProcessId(out pid) != 0 || pid == 0) continue;
        string key;
        if (!names.TryGetValue((int)pid, out key)) {
          try { using (var process = Process.GetProcessById((int)pid)) key = process.ProcessName.ToLowerInvariant(); } catch { key = null; }
          names[(int)pid] = key;
        }
        if (key == null) continue;
        var volume = session as ISimpleAudioVolume;
        if (volume == null) continue;
        found.Add(new Session { Key = key, Pid = (int)pid, Volume = volume });
      }
    }
    return found;
  }

  static string Level(float level) { return Math.Max(0f, Math.Min(1f, level)).ToString(Invariant); }

  public static string GetApp(string key) {
    foreach (var session in Sessions()) {
      if (session.Key != key) continue;
      float level;
      if (session.Volume.GetMasterVolume(out level) == 0) return Level(level);
    }
    return "none";
  }

  public static string SetApp(string key, float level) {
    Guid context = Guid.Empty;
    float now = -1f;
    foreach (var session in Sessions()) {
      if (session.Key != key) continue;
      Marshal.ThrowExceptionForHR(session.Volume.SetMasterVolume(level, ref context));
      float read;
      if (now < 0f && session.Volume.GetMasterVolume(out read) == 0) now = read;
    }
    if (now < 0f) return "none";
    return Level(now);
  }

  static string Json(string text) {
    var json = new StringBuilder("\"");
    foreach (char c in text) {
      // Plain ASCII only, whatever code page the console has.
      if (c == '"' || c == '\\') json.Append('\\').Append(c);
      else if (c < ' ' || c > '~') json.Append("\\u").Append(((int)c).ToString("x4"));
      else json.Append(c);
    }
    return json.Append('"').ToString();
  }

  static string FriendlyName(int pid, string fallback) {
    try {
      using (var process = Process.GetProcessById(pid)) {
        string description = process.MainModule.FileVersionInfo.FileDescription;
        if (!String.IsNullOrEmpty(description) && description.Trim().Length > 0) return description.Trim();
        return process.ProcessName;
      }
    } catch { return fallback; }
  }

  public static string List(int[] own) {
    var skip = new HashSet<int>(own);
    var seen = new HashSet<string>();
    var items = new List<string>();
    foreach (var session in Sessions()) {
      if (skip.Contains(session.Pid) || session.Key == "punchboard" || seen.Contains(session.Key)) continue;
      float level;
      if (session.Volume.GetMasterVolume(out level) != 0) continue;
      seen.Add(session.Key);
      items.Add("{\"key\":" + Json(session.Key) + ",\"name\":" + Json(FriendlyName(session.Pid, session.Key)) + ",\"level\":" + Level(level) + "}");
    }
    return "[" + String.Join(",", items.ToArray()) + "]";
  }
}
"@
[Console]::Out.WriteLine("ready")
$invariant = [Globalization.CultureInfo]::InvariantCulture
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $at = $line.IndexOf(" ")
  if ($at -lt 1) { continue }
  $id = $line.Substring(0, $at)
  $command = $line.Substring($at + 1)
  try {
    if ($command -eq "get") { $text = [PunchboardVolume]::Get().ToString($invariant) }
    elseif ($command.StartsWith("app-get ")) { $text = [PunchboardVolume]::GetApp($command.Substring(8)) }
    elseif ($command.StartsWith("app-set ")) {
      $rest = $command.Substring(8)
      $space = $rest.IndexOf(" ")
      if ($space -lt 1) { throw "app-set needs a level and an app." }
      $text = [PunchboardVolume]::SetApp($rest.Substring($space + 1), [float]::Parse($rest.Substring(0, $space), $invariant))
    }
    elseif ($command.StartsWith("list ")) {
      # The companion and everything it started (this bridge, the sound
      # player) are Punchboard itself, not apps to offer.
      $own = New-Object 'System.Collections.Generic.HashSet[int]'
      [void]$own.Add([int]::Parse($command.Substring(5), $invariant))
      try {
        $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop)
        $grew = $true
        while ($grew) {
          $grew = $false
          foreach ($p in $all) { if ($own.Contains([int]$p.ParentProcessId) -and $p.ProcessId -ne 0 -and $own.Add([int]$p.ProcessId)) { $grew = $true } }
        }
      } catch { [void]$own.Add($PID) }
      $ids = New-Object 'int[]' $own.Count
      $own.CopyTo($ids)
      $text = [PunchboardVolume]::List($ids)
    }
    else { $text = [PunchboardVolume]::Set([float]::Parse($command, $invariant)).ToString($invariant) }
    [Console]::Out.WriteLine($id + " ok " + $text)
  } catch {
    [Console]::Out.WriteLine($id + " error " + ($_.Exception.Message -replace "[\r\n]+", " "))
  }
}
`

interface Waiting {
  /** What follows "ok" in the answer. */
  resolve: (text: string) => void
  reject: (error: Error) => void
  /** How an error answer begins, so it says what failed. */
  failure: string
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
  if (match[2] === "ok") entry.resolve(match[3] ?? "")
  else entry.reject(new Error(`${entry.failure}: ${match[3] ?? ""}`))
}

function start(): ChildProcess {
  if (bridge) return bridge
  // The script travels as an argument, so stdin carries only the commands.
  const encoded = Buffer.from(BRIDGE, "utf16le").toString("base64")
  const child = spawn(powershellExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true })
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

/** Sends one command; resolves with what follows "ok" in its answer. */
function ask(command: string, failure = "Windows would not change the volume"): Promise<string> {
  const child = start()
  lastId += 1
  const id = lastId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, failure })
    if (ready) startClock(id)
    child.stdin?.write(`${id} ${command}\n`)
  })
}

const toLevel = (text: string): number => Math.max(0, Math.min(1, Number(text) || 0))
/** An app's level, or null for "none": it has no audio session right now. */
const toAppLevel = (text: string): number | null => (text === "none" ? null : toLevel(text))

export const readWindowsVolume = (): Promise<number> => ask("get").then(toLevel)

/** One app's volume (see the protocol above), or null when the app is not
    playing through Windows right now. `key` is a normalised app key, which
    never holds a line break. */
export const readWindowsAppVolume = (key: string): Promise<number | null> =>
  ask(`app-get ${key}`, "Windows could not read the app's volume").then(toAppLevel)

/** Sets every session of the app; null when it has none. One at a time per
    app is the caller's business (see latestWinsPerKey in latest-wins.ts). */
export const writeWindowsAppVolume = (key: string, level: number): Promise<number | null> =>
  ask(`app-set ${level.toFixed(3)} ${key}`, "Windows would not change the app's volume").then(toAppLevel)

export interface WindowsAudioApp { key: string; name: string; level: number }

/** The bridge's list, checked entry by entry: anything malformed is left out. */
export function parseAppList(text: string): WindowsAudioApp[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new Error("Windows sent a list of apps that could not be read.") }
  if (!Array.isArray(raw)) throw new Error("Windows sent a list of apps that could not be read.")
  const apps: WindowsAudioApp[] = []
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue
    const fields = item as Record<string, unknown>
    if (typeof fields.key !== "string" || !fields.key) continue
    const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : fields.key
    apps.push({ key: fields.key, name, level: toLevel(String(fields.level)) })
  }
  return apps
}

/** Every app with an audio session, without the companion's own processes. */
export const listWindowsAudioApps = (): Promise<WindowsAudioApp[]> =>
  ask(`list ${process.pid}`, "Windows could not list the apps playing sound").then(parseAppList)

// While a drag is in flight only the newest level matters: one set at a time,
// and whatever arrived meanwhile is sent next.
let inFlight: Promise<number> | null = null
let next: number | null = null

export function writeWindowsVolume(level: number): Promise<number> {
  if (inFlight) {
    next = level
    return inFlight
  }
  inFlight = ask(level.toFixed(3)).then(toLevel).finally(() => {
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
