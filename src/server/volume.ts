// Fader targets. Levels are always 0..1 as the fader shows them; each target
// converts to its own scale.
import { execFile } from "node:child_process"
import type { Fader } from "../shared/types.ts"
import { obsCall, type ObsLink } from "./obs.ts"
import type { Config } from "./config.ts"
import { faderPosition } from "./obs-state.ts"
import { readWindowsVolume, writeWindowsVolume } from "./win-volume.ts"
import { appDisplayName } from "../shared/model.ts"
import { appVolume } from "./app-volume.ts"
import type { AppVolume } from "./app-volume.ts"
import { latestWins } from "./latest-wins.ts"

export { faderLevelKey as levelKey } from "../shared/model.ts"
export { latestWins } from "./latest-wins.ts"

export interface VolumeContext {
  obs: ObsLink
  config: Config
  saveConfig: () => void
  /** Applies the sounds fader to what is playing right now. */
  setSoundVolume: (level: number) => void
  /** App volume faders; this system's unless a test brings its own. */
  apps?: AppVolume
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

function requireApp(fader: Fader): string {
  if (!fader.app) throw new Error("Choose the app first.")
  return fader.app
}

// OBS's own mixer faders are cubic: a fader at 50% is 0.125 of full signal.
// Using the same curve keeps a deck fader and the OBS fader in line.
/** A fader's level now, or null when nobody can say (an app that is closed). */
export async function readLevel(fader: Fader, context: VolumeContext): Promise<number | null> {
  switch (fader.target) {
    case "app":
      return (context.apps ?? appVolume).read(requireApp(fader))
    case "sounds":
      return clamp01(context.config.soundVolume)
    case "system":
      return readSystem()
    case "obs_input": {
      const obs = await context.obs.connect()
      const { inputVolumeMul } = await obsCall(obs, "GetInputVolume", { inputName: requireInput(fader) })
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
    case "app":
      return (context.apps ?? appVolume).write(requireApp(fader), appDisplayName(fader), value)
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
      await obsCall(obs, "SetInputVolume", { inputName: requireInput(fader), inputVolumeMul: value ** 3 })
      return value
    }
  }
}
