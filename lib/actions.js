// Actions that run through the local companion.
//
// Every stateful action reports the state OBS actually ended up in, rather
// than the companion guessing. The previous build derived the new state with
// `!toggleStates.get(key)` and then only stored it when it was true, so a
// tile latched "on" after its first press and never came back.

let openModulePromise = null
function loadOpen() {
  if (!openModulePromise) openModulePromise = import("open").then((m) => m.default)
  return openModulePromise
}

let obsClientPromise = null
function getObsClient(config) {
  if (!config.obs.address) throw new Error("Add the OBS WebSocket address in the Control Center first.")
  if (!obsClientPromise) {
    const { default: OBSWebSocket } = require("obs-websocket-js")
    const client = new OBSWebSocket()
    obsClientPromise = client
      .connect(config.obs.address, config.obs.password || undefined)
      .then(() => {
        // A dropped connection has to clear the cache, otherwise every later
        // press reuses a dead socket and reports a confusing error.
        client.once("ConnectionClosed", () => { obsClientPromise = null })
        return client
      })
      .catch((error) => {
        obsClientPromise = null
        throw new Error(`Could not reach OBS at ${config.obs.address}. Start OBS, enable its WebSocket server, then try again. (${error.message})`)
      })
  }
  return obsClientPromise
}

// Called when the OBS address or password changes. The cached connection was
// made with the old credentials and would otherwise be reused until restart.
function resetObsClient() {
  const pending = obsClientPromise
  obsClientPromise = null
  if (pending) pending.then((client) => client.disconnect()).catch(() => {})
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(60000, Number(ms) || 0))))

// Returns `{ active }` for the actions that have an on/off state, so the deck
// can light the tile to match reality. Returns `{}` for everything else.
async function runAction(step, context) {
  const { config } = context
  if (step.delayMs) await sleep(step.delayMs)

  switch (step.type) {
    case "hotkey":
      throw new Error("Keyboard shortcuts need an accessibility-approved helper, which this companion does not ship yet.")

    case "launch_app": {
      if (!step.appPath) throw new Error("Choose an application, or enter its full path, first.")
      const open = await loadOpen()
      await open(step.appPath)
      return {}
    }

    case "open_url": {
      if (!step.url || !/^https?:\/\//i.test(step.url)) throw new Error("Add a valid http or https link first.")
      const open = await loadOpen()
      await open(step.url)
      return {}
    }

    case "obs_scene": {
      if (!step.sceneName) throw new Error("Add the exact OBS scene name first.")
      const obs = await getObsClient(config)
      await obs.call("SetCurrentProgramScene", { sceneName: step.sceneName })
      return {}
    }

    case "obs_toggle_mute": {
      if (!step.sourceName) throw new Error("Add the exact OBS input name first.")
      const obs = await getObsClient(config)
      const { inputMuted } = await obs.call("ToggleInputMute", { inputName: step.sourceName })
      // Lit means muted: that is the state worth spotting from across a room.
      return { active: Boolean(inputMuted) }
    }

    case "obs_toggle_source": {
      if (!step.sceneName || !step.sourceName) throw new Error("Add both the scene name and the source name first.")
      const obs = await getObsClient(config)
      const { sceneItemId } = await obs.call("GetSceneItemId", { sceneName: step.sceneName, sourceName: step.sourceName })
      const { sceneItemEnabled } = await obs.call("GetSceneItemEnabled", { sceneName: step.sceneName, sceneItemId })
      await obs.call("SetSceneItemEnabled", { sceneName: step.sceneName, sceneItemId, sceneItemEnabled: !sceneItemEnabled })
      return { active: !sceneItemEnabled }
    }

    case "obs_start_stop_stream": {
      const obs = await getObsClient(config)
      const { outputActive } = await obs.call("GetStreamStatus")
      await obs.call(outputActive ? "StopStream" : "StartStream")
      return { active: !outputActive }
    }

    case "obs_toggle_record": {
      const obs = await getObsClient(config)
      const { outputActive } = await obs.call("GetRecordStatus")
      await obs.call(outputActive ? "StopRecord" : "StartRecord")
      return { active: !outputActive }
    }

    // The Control Center plays it through this computer's output; the tablet
    // never loads the audio. `onSound` toggles it, so pressing again stops it.
    case "play_sound":
      context.onSound(Math.max(1, Math.min(8, Number(step.soundId) || 1)))
      return {}

    case "browser_tile":
      // Handled by the caller: only the tablet can open its own browser.
      return {}

    default:
      return {}
  }
}

// Runs a macro in order and reports what the deck needs to know afterwards.
// A single-step macro behaves exactly as a plain action did.
async function runSteps(steps, context) {
  let active
  let tabletUrl = null

  for (const step of steps) {
    if (step.type === "none") continue
    if (step.type === "browser_tile") {
      // Only the first tablet link in a macro is honoured; a tablet cannot
      // meaningfully open six tabs from one press.
      if (!tabletUrl && step.tabletUrl) tabletUrl = step.tabletUrl
      continue
    }
    const result = await runAction(step, context)
    if (typeof result.active === "boolean") active = result.active
  }

  return { active, tabletUrl }
}

module.exports = { runAction, runSteps, getObsClient, resetObsClient }
