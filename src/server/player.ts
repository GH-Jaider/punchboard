// Plays the sound slots on this computer from the companion itself, so no
// browser tab has to be open, focused or clicked for a deck's sound button
// to work. macOS: afplay, built in. Windows: PowerShell's MediaPlayer, built
// in. Each sound is one child process; stopping it is killing it.
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"

export interface PlayerOptions {
  /** 0..1, read as each sound starts (afplay cannot change mid-play). */
  volume: () => number
  /** A sound stopped: on its own (`ranMs` = how long it played) or on request (null). */
  onEnded: (slot: number, ranMs: number | null) => void
  log: (message: string) => void
}

interface Running {
  child: ChildProcess
  startedAt: number
  stopping: boolean
}

export type Player = ReturnType<typeof createPlayer>

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/** The command that plays one file at one volume, exposed for tests. */
export function playCommand(file: string, volume: number, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } | null {
  if (platform === "darwin") return { file: "afplay", args: ["-v", String(clamp01(volume)), file] }
  if (platform === "win32") {
    // MediaPlayer opens in the background: wait for the length (5 s at most),
    // play, sleep it out, exit. Killing the process stops the sound.
    const script = [
      "Add-Type -AssemblyName PresentationCore",
      "$p = New-Object System.Windows.Media.MediaPlayer",
      `$p.Open([Uri]'${file.replace(/'/g, "''")}')`,
      "$w = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $w -lt 100) { Start-Sleep -Milliseconds 50; $w++ }",
      `$p.Volume = ${clamp01(volume)}`,
      "$p.Play()",
      "$ms = if ($p.NaturalDuration.HasTimeSpan) { [int]$p.NaturalDuration.TimeSpan.TotalMilliseconds } else { 60000 }",
      "Start-Sleep -Milliseconds ($ms + 200)",
      "$p.Close()"
    ].join("; ")
    return { file: "powershell", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] }
  }
  return null
}

export function createPlayer(options: PlayerOptions) {
  const running = new Map<number, Running>()

  function finish(slot: number, entry: Running, ranMs: number | null): void {
    if (running.get(slot) !== entry) return
    running.delete(slot)
    options.onEnded(slot, ranMs)
  }

  /** Starts a slot's file; a slot already playing restarts. Throws on unsupported systems. */
  function play(slot: number, file: string): void {
    const spec = playCommand(file, options.volume())
    if (!spec) throw new Error("Playing sounds works on macOS and Windows only for now.")
    stop(slot)
    const child = spawn(spec.file, spec.args, { stdio: "ignore", windowsHide: true })
    const entry: Running = { child, startedAt: Date.now(), stopping: false }
    running.set(slot, entry)
    child.on("error", (error) => {
      options.log(`Sound ${slot} could not be played: ${error.message}`)
      finish(slot, entry, null)
    })
    child.on("exit", (code) => {
      finish(slot, entry, entry.stopping || code !== 0 ? null : Date.now() - entry.startedAt)
    })
  }

  function stop(slot: number): boolean {
    const entry = running.get(slot)
    if (!entry) return false
    entry.stopping = true
    entry.child.kill()
    return true
  }

  function stopAll(): void {
    for (const slot of [...running.keys()]) stop(slot)
  }

  const playing = (): number[] => [...running.keys()]
  const startedAt = (slot: number): number | null => running.get(slot)?.startedAt ?? null

  return { play, stop, stopAll, playing, startedAt }
}
