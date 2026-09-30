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
import { fileURLToPath } from "node:url"

export interface PlayerOptions {
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

const HELPER = fileURLToPath(new URL("./helpers/mac-player.js", import.meta.url))

/** The one-shot command that plays a file, exposed for tests. */
export function playCommand(file: string, level: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  const gain = gainFor(level)
  if (platform === "darwin") return { file: "afplay", args: ["-v", String(gain), file] }
  if (platform === "win32") {
    // MediaPlayer opens in the background: wait for the length (5 s at most),
    // play, sleep it out, exit. Killing the process stops the sound.
    const script = [
      "Add-Type -AssemblyName PresentationCore",
      "$p = New-Object System.Windows.Media.MediaPlayer",
      `$p.Open([Uri]'${file.replace(/'/g, "''")}')`,
      "$w = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $w -lt 100) { Start-Sleep -Milliseconds 50; $w++ }",
      `$p.Volume = ${gain}`,
      "$p.Play()",
      "$ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { 60000 }",
      "Start-Sleep -Milliseconds ($ms + 200)",
      "$p.Close()"
    ].join("; ")
    return { file: "powershell", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] }
  }
  return null
}

interface Running {
  startedAt: number
  stopping: boolean
  child?: ChildProcess
}

interface HelperEvent { event?: string; slot?: number; message?: string }

export function createPlayer(options: PlayerOptions): Player {
  const running = new Map<number, Running>()
  let helper: ChildProcess | null = null
  let helperBroken = process.platform !== "darwin"
  let buffered = ""

  function finish(slot: number, entry: Running, ranMs: number | null): void {
    if (running.get(slot) !== entry) return
    running.delete(slot)
    options.onEnded(slot, ranMs)
  }

  // ------------------------------------------------------------ the helper

  function onHelperLine(line: string): void {
    let event: HelperEvent
    try { event = JSON.parse(line) as HelperEvent } catch { return }
    const slot = Number(event.slot)
    const entry = running.get(slot)
    if (event.event === "ended" && entry) finish(slot, entry, entry.stopping ? null : Date.now() - entry.startedAt)
    if (event.event === "error") {
      options.log(`Sound ${Number.isFinite(slot) ? slot : "?"} could not be played: ${event.message ?? "unknown error"}`)
      if (entry) finish(slot, entry, null)
    }
  }

  function startHelper(): ChildProcess | null {
    if (helper || helperBroken) return helper
    const child = spawn("osascript", ["-l", "JavaScript", HELPER], { stdio: ["pipe", "pipe", "ignore"] })
    helper = child
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) onHelperLine(line)
    })
    child.on("error", (error) => {
      options.log(`The sound helper could not start (${error.message}); using afplay instead.`)
      helperBroken = true
      dropHelper(child)
    })
    child.on("exit", () => dropHelper(child))
    return child
  }

  /** The helper went away: whatever it was playing is over. */
  function dropHelper(child: ChildProcess): void {
    if (helper !== child) return
    helper = null
    for (const [slot, entry] of [...running]) if (!entry.child) finish(slot, entry, null)
  }

  function tell(command: Record<string, unknown>): boolean {
    const child = startHelper()
    if (!child?.stdin?.writable) return false
    child.stdin.write(`${JSON.stringify(command)}\n`)
    return true
  }

  // --------------------------------------------------------------- playing

  function play(slot: number, file: string): void {
    stop(slot)
    const gain = gainFor(options.volume())
    if (!helperBroken && tell({ cmd: "play", slot, file, volume: gain })) {
      running.set(slot, { startedAt: Date.now(), stopping: false })
      return
    }
    const spec = playCommand(file, options.volume())
    if (!spec) throw new Error("Playing sounds works on macOS and Windows only for now.")
    const child = spawn(spec.file, spec.args, { stdio: "ignore", windowsHide: true })
    const entry: Running = { child, startedAt: Date.now(), stopping: false }
    running.set(slot, entry)
    child.on("error", (error) => {
      options.log(`Sound ${slot} could not be played: ${error.message}`)
      finish(slot, entry, null)
    })
    child.on("exit", (code) => finish(slot, entry, entry.stopping || code !== 0 ? null : Date.now() - entry.startedAt))
  }

  function stop(slot: number): boolean {
    const entry = running.get(slot)
    if (!entry) return false
    entry.stopping = true
    if (entry.child) entry.child.kill()
    else if (!tell({ cmd: "stop", slot })) finish(slot, entry, null)
    return true
  }

  function stopAll(): void {
    for (const slot of [...running.keys()]) stop(slot)
  }

  function setVolume(level: number): void {
    if (helper) tell({ cmd: "volume", volume: gainFor(level) })
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
    stopAll,
    setVolume,
    dispose,
    playing: () => [...running.keys()],
    startedAt: (slot) => running.get(slot)?.startedAt ?? null
  }
}
