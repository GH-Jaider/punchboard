// Fader targets. Levels are always 0..1 as the fader shows them; each target
// converts to its own scale.
const { execFile } = require("child_process")
const { getObsClient } = require("./actions")
// Two faders on the same target share one level, keyed the same way everywhere.
const { faderLevelKey: levelKey } = require("../public/deck-shared.js")

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0))

function osascript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 3000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())))
  })
}

function requireMac() {
  if (process.platform !== "darwin") throw new Error("Computer volume can only be controlled on macOS for now.")
}

// OBS's own mixer faders are cubic: a fader at 50% is 0.125 of full signal.
// Using the same curve means a deck fader and the OBS fader line up.
async function readLevel(fader, context) {
  switch (fader.target) {
    case "sounds":
      return clamp01(context.config.soundVolume)
    case "system": {
      requireMac()
      return clamp01(Number(await osascript("output volume of (get volume settings)")) / 100)
    }
    case "obs_input": {
      if (!fader.inputName) throw new Error("Add the exact OBS input name first.")
      const obs = await getObsClient(context.config)
      const { inputVolumeMul } = await obs.call("GetInputVolume", { inputName: fader.inputName })
      return clamp01(Math.cbrt(inputVolumeMul))
    }
    default:
      throw new Error("That fader has no target.")
  }
}

async function writeLevel(fader, level, context) {
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
      if (!fader.inputName) throw new Error("Add the exact OBS input name first.")
      const obs = await getObsClient(context.config)
      await obs.call("SetInputVolume", { inputName: fader.inputName, inputVolumeMul: value ** 3 })
      return value
    }
    default:
      throw new Error("That fader has no target.")
  }
}

module.exports = { levelKey, readLevel, writeLevel }
