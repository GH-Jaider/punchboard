// Plays the sound slots on this computer from the companion itself, so no
// browser tab has to be open, focused or clicked for a deck's sound button
// to work.
//
// macOS: a helper kept alive (helpers/mac-player.js, run by the built-in
// osascript) starts sounds at once, changes their volume while they play and
// reports when they end; afplay is the fallback if the helper cannot start.
// Windows: PowerShell's MediaPlayer, one process per sound, built in.
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { pathToFileURL } from "node:url"
import { powershellExe, psQuote } from "./powershell.ts"

export interface PlayerOptions {
  /** The macOS helper script (helpers/mac-player.js). */
  helper: string
  /** Fader position 0..1, read as each sound starts. */
  volume: () => number
  /** A sound stopped: on its own (`ranMs` = how long it played) or on request (null). */
  onEnded: (slot: number, ranMs: number | null) => void
  log: (message: string) => void
}

export interface Player {
  play(slot: number, file: string): void
  /** Stops a slot. Returns whether it was playing. */
  stop(slot: number): boolean
  /** Stops a slot and resolves once it has really ended (its file let go), or after 2 s. */
  stopAndWait(slot: number): Promise<void>
  stopAll(): void
  playing(): number[]
  startedAt(slot: number): number | null
  /** Applies a fader move to sounds already playing, where the player can. */
  setVolume(level: number): void
  dispose(): void
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))
/** A fader at half feels like half as loud with a squared gain, not linear. */
export const gainFor = (level: number): number => clamp01(level) * clamp01(level)

// Re-exported for tests: the one quoting rule lives in powershell.ts.
export { psQuote }

/** The one-shot command that plays a file, exposed for tests. `unknownLengthMs`
    is for tests only: how long to play when the length never shows (a machine
    with no sound device). Otherwise a sound whose length never shows is one
    that could not be opened, and the script says so and exits. */
export function playCommand(file: string, level: number, platform: NodeJS.Platform = process.platform, unknownLengthMs: number | null = null): { file: string; args: string[] } | null {
  const gain = gainFor(level)
  if (platform === "darwin") return { file: "afplay", args: ["-v", String(gain), file] }
  if (platform === "win32") {
    // MediaPlayer opens in the background: wait for the length (5 s at most),
    // play, then wait it out while listening on stdin, where each line is a
    // new volume (the fader moving while the sound plays). The stream is read
    // asynchronously: Console.In would block, and the sound would never end.
    // Killing the process, or closing stdin, stops the sound.
    // The file goes as a proper file URI: [Uri] on a bare path reads # as a
    // fragment and % as an escape.
    const uri = pathToFileURL(file, { windows: true }).href
    const unknown = unknownLengthMs === null
      ? "if (-not $p.NaturalDuration.HasTimeSpan) { [Console]::Out.WriteLine('length unknown'); $p.Close(); exit 3 }"
      : ""
    const script = [
      "Add-Type -AssemblyName PresentationCore",
      `$u = [Uri]${psQuote(uri)}`,
      "if (-not [IO.File]::Exists($u.LocalPath)) { [Console]::Out.WriteLine('missing file'); exit 2 }",
      "$p = New-Object System.Windows.Media.MediaPlayer",
      "$p.Open($u)",
      "$w = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $w -lt 100) { Start-Sleep -Milliseconds 50; $w++ }",
      unknown,
      `$p.Volume = ${gain}`,
      "$p.Play()",
      `$ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { ${unknownLengthMs ?? 0} }`,
      // The length found and the volume taken: the companion counts the
      // sound's run time from here, and tests read both.
      "[Console]::Out.WriteLine('length ' + $ms + ' start ' + $p.Volume.ToString([Globalization.CultureInfo]::InvariantCulture))",
      "$end = [DateTime]::Now.AddMilliseconds($ms + 200)",
      "$in = New-Object System.IO.StreamReader([Console]::OpenStandardInput())",
      "$read = $in.ReadLineAsync()",
      // The new volume is applied as it comes: the companion already keeps it
      // within 0..1. (Clamping here with [Math]::Min(1, $v) picked the integer
      // overload and turned 0.2 into 0 and 0.7 into 1: silence or full.)
      // stdin closing means the companion is gone: the sound ends with it.
      "while ([DateTime]::Now -lt $end) { if ($read.IsCompleted) { $line = $read.Result; if ($null -eq $line) { break }; $v = 0.0; if ([double]::TryParse($line, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$v)) { $p.Volume = $v; [Console]::Out.WriteLine('volume ' + $v.ToString([Globalization.CultureInfo]::InvariantCulture) + ' now ' + $p.Volume.ToString([Globalization.CultureInfo]::InvariantCulture)) }; $read = $in.ReadLineAsync() }; Start-Sleep -Milliseconds 40 }",
      "$p.Close()"
    ].filter(Boolean).join("; ")
    return { file: powershellExe(), args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] }
  }
  return null
}

interface Running {
  /** When the sound began playing: ordered, then corrected once the player says it started. */
  startedAt: number
  /** The player said it started, so its run time can be trusted. */
  confirmed: boolean
  stopping: boolean
  file: string
  child?: ChildProcess
  /** stopAndWait callers, told when it ends. */
  waiters: (() => void)[]
}

interface HelperEvent { event?: string; slot?: number; message?: string }

export function createPlayer(options: PlayerOptions): Player {
  const running = new Map<number, Running>()
  let helper: ChildProcess | null = null
  /** The current helper said "ready": it runs, so a crash later is not a reason to give it up. */
  let helperReady = false
  let helperBroken = process.platform !== "darwin"
  let buffered = ""

  function finish(slot: number, entry: Running, ranMs: number | null): void {
    if (running.get(slot) !== entry) return
    running.delete(slot)
    for (const done of entry.waiters.splice(0)) done()
    options.onEnded(slot, ranMs)
  }

  const ranFor = (entry: Running): number | null => (entry.stopping || !entry.confirmed ? null : Date.now() - entry.startedAt)

  // ------------------------------------------------------------ the helper

  function onHelperLine(line: string): void {
    let event: HelperEvent
    try { event = JSON.parse(line) as HelperEvent } catch { return }
    if (event.event === "ready") {
      helperReady = true
      return
    }
    const slot = Number(event.slot)
    const entry = running.get(slot)
    if (event.event === "started" && entry && !entry.child) {
      entry.startedAt = Date.now()
      entry.confirmed = true
    }
    // An "ended" before "started" belongs to the sound this one replaced.
    if (event.event === "ended" && entry && !entry.child && entry.confirmed) finish(slot, entry, ranFor(entry))
    if (event.event === "error") {
      options.log(`Sound ${Number.isFinite(slot) ? slot : "?"} could not be played: ${event.message ?? "unknown error"}`)
      if (entry && !entry.child) finish(slot, entry, null)
    }
  }

  function startHelper(): ChildProcess | null {
    if (helper || helperBroken) return helper
    const child = spawn("osascript", ["-l", "JavaScript", options.helper], { stdio: ["pipe", "pipe", "ignore"] })
    helper = child
    helperReady = false
    buffered = ""
    // A helper that died leaves a broken pipe: writing to it is not fatal.
    child.stdin?.on("error", () => { /* reported by its exit */ })
    child.stdout?.on("data", (chunk: Buffer) => {
      if (helper !== child) return
      buffered += chunk.toString("utf8")
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) onHelperLine(line)
    })
    child.on("error", (error) => {
      if (helper !== child) return
      options.log(`The sound helper could not start (${error.message}); using afplay instead.`)
      helperBroken = true
      dropHelper(child)
    })
    child.on("exit", () => {
      if (helper !== child) return
      // Dying before it was ready would happen again on every press.
      if (!helperReady) {
        options.log("The sound helper stopped as it started; using afplay instead.")
        helperBroken = true
      }
      dropHelper(child)
    })
    return child
  }

  /** The helper went away: what it was playing is over, and what it was
      asked to play but never started plays through afplay instead. */
  function dropHelper(child: ChildProcess): void {
    if (helper !== child) return
    helper = null
    helperReady = false
    for (const [slot, entry] of [...running]) {
      if (entry.child) continue
      if (entry.confirmed || entry.stopping) {
        finish(slot, entry, null)
        continue
      }
      try {
        spawnPlay(slot, entry.file).waiters = entry.waiters
      } catch (error) {
        options.log(`Sound ${slot} could not be played: ${error instanceof Error ? error.message : String(error)}`)
        finish(slot, entry, null)
      }
    }
  }

  function tell(command: Record<string, unknown>): boolean {
    const child = startHelper()
    if (!child?.stdin?.writable) return false
    child.stdin.write(`${JSON.stringify(command)}\n`)
    return true
  }

  // --------------------------------------------------------------- playing

  /** One process for one sound: afplay on macOS, the PowerShell script on Windows. */
  function spawnPlay(slot: number, file: string): Running {
    const spec = playCommand(file, options.volume())
    if (!spec) throw new Error("Playing sounds works on macOS and Windows only for now.")
    const windows = process.platform === "win32"
    // stdin stays open on Windows: the fader's new volumes reach a playing
    // sound there, and stdout says when the sound really started.
    const child = spawn(spec.file, spec.args, { stdio: windows ? ["pipe", "pipe", "ignore"] : ["ignore", "ignore", "ignore"], windowsHide: true })
    // A sound that ends while a volume is on its way closes the pipe; that is not an error.
    child.stdin?.on("error", () => { /* the sound has finished */ })
    // afplay says nothing, so its run time counts from the start (it adds
    // ~0.7 s of its own); the Windows script prints "length …" as it plays.
    const entry: Running = { child, startedAt: Date.now(), confirmed: !windows, stopping: false, file, waiters: [] }
    running.set(slot, entry)
    let out = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8")
      const lines = out.split(/\r?\n/)
      out = lines.pop() ?? ""
      for (const line of lines) {
        if (/^length \d+/.test(line) && !entry.confirmed) {
          entry.startedAt = Date.now()
          entry.confirmed = true
        } else if (line === "length unknown" || line === "missing file") {
          options.log(`Sound ${slot} could not be played: ${line === "missing file" ? "its file is missing" : "the file could not be opened"}.`)
        }
      }
    })
    child.on("error", (error) => {
      options.log(`Sound ${slot} could not be played: ${error.message}`)
      finish(slot, entry, null)
    })
    child.on("exit", (code) => finish(slot, entry, code !== 0 ? null : ranFor(entry)))
    return entry
  }

  function play(slot: number, file: string): void {
    stop(slot)
    const gain = gainFor(options.volume())
    if (!helperBroken && tell({ cmd: "play", slot, file, volume: gain })) {
      running.set(slot, { startedAt: Date.now(), confirmed: false, stopping: false, file, waiters: [] })
      return
    }
    spawnPlay(slot, file)
  }

  function stop(slot: number): boolean {
    const entry = running.get(slot)
    if (!entry) return false
    entry.stopping = true
    if (entry.child) entry.child.kill()
    else if (!tell({ cmd: "stop", slot })) finish(slot, entry, null)
    return true
  }

  function stopAndWait(slot: number): Promise<void> {
    const entry = running.get(slot)
    if (!entry) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000)
      entry.waiters.push(() => { clearTimeout(timer); resolve() })
      stop(slot)
    })
  }

  function stopAll(): void {
    for (const slot of [...running.keys()]) stop(slot)
  }

  function setVolume(level: number): void {
    const gain = gainFor(level)
    if (helper) tell({ cmd: "volume", volume: gain })
    // Windows: each playing sound reads its new volume from stdin.
    for (const entry of running.values()) {
      if (entry.child?.stdin?.writable) entry.child.stdin.write(`${gain}\n`)
    }
  }

  function dispose(): void {
    stopAll()
    const child = helper
    if (!child) return
    tell({ cmd: "quit" })
    setTimeout(() => { if (helper === child) child.kill() }, 300).unref()
  }

  return {
    play,
    stop,
    stopAndWait,
    stopAll,
    setVolume,
    dispose,
    playing: () => [...running.keys()],
    startedAt: (slot) => running.get(slot)?.startedAt ?? null
  }
}
