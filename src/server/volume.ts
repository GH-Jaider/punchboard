// Fader targets. Levels are always 0..1 as the fader shows them; each target
// converts to its own scale.
import { execFile } from "node:child_process"
import type { Fader } from "../shared/types.ts"
import type { ObsLink } from "./obs.ts"
import type { Config } from "./config.ts"

export { faderLevelKey as levelKey } from "../shared/model.ts"

export interface VolumeContext {
  obs: ObsLink
  config: Config
  saveConfig: () => void
}

const clamp01 = (value: unknown): number => Math.max(0, Math.min(1, Number(value) || 0))

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())))
  })
}

function requireMac(): void {
  if (process.platform !== "darwin") throw new Error("Computer volume can only be controlled on macOS for now.")
}

function requireInput(fader: Fader): string {
  if (!fader.inputName) throw new Error("Add the exact OBS input name first.")
  return fader.inputName
}

// OBS's own mixer faders are cubic: a fader at 50% is 0.125 of full signal.
// Using the same curve keeps a deck fader and the OBS fader in line.
export async function readLevel(fader: Fader, context: VolumeContext): Promise<number> {
  switch (fader.target) {
    case "sounds":
      return clamp01(context.config.soundVolume)
    case "system":
      requireMac()
      return clamp01(Number(await osascript("output volume of (get volume settings)")) / 100)
    case "obs_input": {
      const obs = await context.obs.connect()
      const { inputVolumeMul } = await obs.call("GetInputVolume", { inputName: requireInput(fader) })
      return clamp01(Math.cbrt(inputVolumeMul))
    }
  }
}

export async function writeLevel(fader: Fader, level: unknown, context: VolumeContext): Promise<number> {
  const value = clamp01(level)
  switch (fader.target) {
    case "sounds":
      context.config.soundVolume = value
      context.saveConfig()
      return value
    case "system":
      requireMac()
      await osascript(`set volume output volume ${Math.round(value * 100)}`)
      return value
    case "obs_input": {
      const obs = await context.obs.connect()
      await obs.call("SetInputVolume", { inputName: requireInput(fader), inputVolumeMul: value ** 3 })
      return value
    }
  }
}
