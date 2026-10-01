// Fader targets. Levels are always 0..1 as the fader shows them; each target
// converts to its own scale.
import { execFile } from "node:child_process"
import type { Fader } from "../shared/types.ts"
import type { ObsLink } from "./obs.ts"
import type { Config } from "./config.ts"
import { faderPosition } from "./obs-state.ts"
import { readWindowsVolume, writeWindowsVolume } from "./win-volume.ts"

export { faderLevelKey as levelKey } from "../shared/model.ts"

export interface VolumeContext {
  obs: ObsLink
  config: Config
  saveConfig: () => void
  /** Applies the sounds fader to what is playing right now. */
  setSoundVolume: (level: number) => void
}

const clamp01 = (value: unknown): number => Math.max(0, Math.min(1, Number(value) || 0))

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())))
  })
}

async function readSystem(): Promise<number> {
  if (process.platform === "darwin") return clamp01(Number(await osascript("output volume of (get volume settings)")) / 100)
  if (process.platform === "win32") return readWindowsVolume()
  throw new Error("The computer's volume can be controlled on macOS and Windows only.")
}

/** Runs one write at a time; while one is in flight only the newest level
    waits, and goes next. A drag posts every ~90 ms and each write takes about
    as long, so writes run side by side would finish in any order and could
    leave an older level set. Callers that arrive meanwhile share the write in
    flight. Exposed for tests. */
export function latestWins(write: (level: number) => Promise<number>): (level: number) => Promise<number> {
  let inFlight: Promise<number> | null = null
  let next: number | null = null
  const run = (level: number): Promise<number> => {
    if (inFlight) {
      next = level
      return inFlight
    }
    inFlight = write(level).finally(() => {
      inFlight = null
      if (next !== null) {
        const queued = next
        next = null
        run(queued).catch(() => { /* reported by the next caller */ })
      }
    })
    return inFlight
  }
  return run
}

const writeMacVolume = latestWins(async (level) => {
  await osascript(`set volume output volume ${Math.round(level * 100)}`)
  return level
})

async function writeSystem(level: number): Promise<number> {
  if (process.platform === "darwin") {
    await writeMacVolume(level)
    return level
  }
  if (process.platform === "win32") return writeWindowsVolume(level)
  throw new Error("The computer's volume can be controlled on macOS and Windows only.")
}

function requireInput(fader: Fader): string {
  if (!fader.inputName) throw new Error("Choose the OBS audio input first.")
  return fader.inputName
}

// OBS's own mixer faders are cubic: a fader at 50% is 0.125 of full signal.
// Using the same curve keeps a deck fader and the OBS fader in line.
export async function readLevel(fader: Fader, context: VolumeContext): Promise<number> {
  switch (fader.target) {
    case "sounds":
      return clamp01(context.config.soundVolume)
    case "system":
      return readSystem()
    case "obs_input": {
      const obs = await context.obs.connect()
      const { inputVolumeMul } = await obs.call("GetInputVolume", { inputName: requireInput(fader) })
      return faderPosition(inputVolumeMul)
    }
  }
}

/** A level a fader can be set to: a finite number. Anything else (missing,
    null, text) is refused rather than read as 0, which would mute. */
export const isLevel = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export async function writeLevel(fader: Fader, level: unknown, context: VolumeContext): Promise<number> {
  if (!isLevel(level)) throw new Error("The level must be a number from 0 to 1.")
  const value = clamp01(level)
  switch (fader.target) {
    case "sounds":
      context.config.soundVolume = value
      context.saveConfig()
      context.setSoundVolume(value)
      return value
    case "system":
      await writeSystem(value)
      return value
    case "obs_input": {
      const obs = await context.obs.connect()
      await obs.call("SetInputVolume", { inputName: requireInput(fader), inputVolumeMul: value ** 3 })
      return value
    }
  }
}
