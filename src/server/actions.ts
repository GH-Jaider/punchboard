// Runs a button's macro on this computer.
//
// Every stateful action reports the state OBS actually ended up in, rather
// than the companion guessing, so a lit tile always matches reality.
import OBSWebSocket from "obs-websocket-js"
import { LIMITS } from "../shared/actions.ts"
import type { Button, Step } from "../shared/types.ts"
import type { Config } from "./config.ts"
import { HttpError, errorText } from "./http.ts"

let obsClientPromise: Promise<OBSWebSocket> | null = null

export function getObsClient(config: Config): Promise<OBSWebSocket> {
  if (!config.obs.address) throw new Error("Add the OBS WebSocket address in the Control Center first.")
  if (!obsClientPromise) {
    const client = new OBSWebSocket()
    obsClientPromise = client
      .connect(config.obs.address, config.obs.password || undefined)
      .then(() => {
        // A dropped connection clears the cache, or every later press would
        // reuse a dead socket and report a confusing error.
        client.once("ConnectionClosed", () => { obsClientPromise = null })
        return client
      })
      .catch((error: unknown) => {
        obsClientPromise = null
        throw new Error(`Could not reach OBS at ${config.obs.address}. Start OBS, enable its WebSocket server, then try again. (${errorText(error)})`)
      })
  }
  return obsClientPromise
}

/** Drops the cached OBS connection after its address or password changes. */
export function resetObsClient(): void {
  const pending = obsClientPromise
  obsClientPromise = null
  if (pending) pending.then((client) => client.disconnect()).catch(() => {})
}

let openModule: Promise<(target: string) => Promise<unknown>> | null = null
function loadOpen(): Promise<(target: string) => Promise<unknown>> {
  openModule ??= import("open").then((module) => module.default)
  return openModule
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(LIMITS.maxDelayMs, ms))))

/** An http(s) address, normalised, or null. */
export function webAddress(value: string | undefined): string | null {
  try {
    const destination = new URL(value ?? "")
    return destination.protocol === "http:" || destination.protocol === "https:" ? destination.href : null
  } catch {
    return null
  }
}

/** Checks a saved button's macro before any of it runs. */
export function prepareSteps(button: Button): Step[] {
  const steps: Step[] = button.steps.length ? button.steps : [{ id: "step", type: "none", delayMs: 0 }]
  if (steps.length > LIMITS.maxSteps) throw new HttpError(400, `A macro can hold at most ${LIMITS.maxSteps} steps.`)
  for (const step of steps) {
    if (step.type === "browser_tile" && !webAddress(step.url)) throw new HttpError(400, "Add a valid http or https address for the tablet link.")
  }
  return steps
}

export interface ActionContext {
  config: Config
  /** Toggles a sound slot on the Control Center's audio output. */
  onSound: (slot: number) => void
}

interface ActionResult {
  /** The on/off state an action left behind, for actions that have one. */
  active?: boolean
}

async function runAction(step: Step, context: ActionContext): Promise<ActionResult> {
  const { config } = context
  if (step.delayMs) await sleep(step.delayMs)

  switch (step.type) {
    case "hotkey":
      throw new Error("Keyboard shortcuts need an accessibility-approved helper, which this companion does not ship yet.")

    case "launch_app": {
      if (!step.appPath) throw new Error("Choose an application, or enter its full path, first.")
      await (await loadOpen())(step.appPath)
      return {}
    }

    case "open_url": {
      if (!step.url || !/^https?:\/\//i.test(step.url)) throw new Error("Add a valid http or https link first.")
      await (await loadOpen())(step.url)
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
    // never loads the audio. Pressing again stops it.
    case "play_sound":
      context.onSound(Math.max(1, Math.min(LIMITS.soundSlots, Number(step.soundId) || 1)))
      return {}

    // Only the tablet can open its own browser; the caller handles it.
    case "browser_tile":
    case "none":
      return {}

    default: {
      const unknown: never = step
      throw new Error(`Unknown action ${(unknown as Step).type}`)
    }
  }
}

export interface MacroResult {
  active: boolean | undefined
  tabletUrl: string | null
}

/** Runs a macro in order and reports what the deck needs to know afterwards. */
export async function runSteps(steps: readonly Step[], context: ActionContext): Promise<MacroResult> {
  let active: boolean | undefined
  let tabletUrl: string | null = null

  for (const step of steps) {
    if (step.type === "none") continue
    if (step.type === "browser_tile") {
      // Only the first tablet link is honoured; a tablet cannot usefully open
      // several tabs from one press.
      tabletUrl ??= webAddress(step.url)
      continue
    }
    const result = await runAction(step, context)
    if (typeof result.active === "boolean") active = result.active
  }
  return { active, tabletUrl }
}
