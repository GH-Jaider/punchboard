// Runs a button's macro on this computer.
//
// Every stateful action reports the state OBS actually ended up in, rather
// than the companion guessing, so a lit tile always matches reality.
import { ACTION_META, LIMITS } from "../shared/actions.ts"
import { webAddress } from "../shared/links.ts"
import type { SetMode, Step } from "../shared/types.ts"
import type { Config } from "./config.ts"
import { HttpError } from "./http.ts"
import { sendKeys, sendMediaKey } from "./keys.ts"
import { launchApp } from "./launch.ts"
import { obsCall, type ObsLink } from "./obs.ts"

let openModule: Promise<(target: string) => Promise<unknown>> | null = null
function loadOpen(): Promise<(target: string) => Promise<unknown>> {
  openModule ??= import("open").then((module) => module.default)
  return openModule
}

/** Where an on/off step leaves its state: flipped, or set whatever it was. */
const wanted = (set: SetMode | undefined, current: boolean): boolean => (set === "on" ? true : set === "off" ? false : !current)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(LIMITS.maxDelayMs, ms))))

/** Checks a saved list of steps before any of it runs: the button's, or a
    two-state macro's second list. */
export function prepareSteps(list: readonly Step[]): Step[] {
  const steps: Step[] = list.length ? [...list] : [{ id: "step", type: "none", delayMs: 0 }]
  if (steps.length > LIMITS.maxSteps) throw new HttpError(400, `A macro can hold at most ${LIMITS.maxSteps} steps.`)
  for (const step of steps) {
    if (step.type === "browser_tile" && !webAddress(step.url)) throw new HttpError(400, "Add a web address for the device link first.")
  }
  return steps
}

export interface ActionContext {
  config: Config
  obs: ObsLink
  /** Toggles a sound slot on this computer's speakers. */
  onSound: (slot: number) => void
  stopSounds: () => void
}

interface ActionResult {
  /** The on/off state an action left behind, for actions that have one. */
  active?: boolean
}

async function runAction(step: Step, context: ActionContext): Promise<ActionResult> {
  if (step.delayMs) await sleep(step.delayMs)

  switch (step.type) {
    case "hotkey":
      await sendKeys(step.keys)
      return {}

    case "launch_app": {
      if (!step.appPath) throw new Error("Choose an application, or enter its full path, first.")
      await launchApp(step.appPath)
      return {}
    }

    case "open_url": {
      const address = webAddress(step.url)
      if (!address) throw new Error("Add a web address for the link first.")
      await (await loadOpen())(address)
      return {}
    }

    case "obs_scene": {
      if (!step.sceneName) throw new Error("Choose the OBS scene first.")
      const obs = await context.obs.connect()
      await obsCall(obs, "SetCurrentProgramScene", { sceneName: step.sceneName })
      return { active: true }
    }

    case "obs_toggle_mute": {
      if (!step.sourceName) throw new Error("Choose the OBS audio input first.")
      const obs = await context.obs.connect()
      const { inputMuted } = await obsCall(obs, "GetInputMute", { inputName: step.sourceName })
      const muted = wanted(step.set, inputMuted)
      if (muted !== inputMuted) await obsCall(obs, "SetInputMute", { inputName: step.sourceName, inputMuted: muted })
      // Lit means muted: that is the state worth spotting from across a room.
      return { active: muted }
    }

    case "obs_toggle_source": {
      if (!step.sceneName || !step.sourceName) throw new Error("Choose the scene and the source first.")
      const obs = await context.obs.connect()
      const { sceneItemId } = await obsCall(obs, "GetSceneItemId", { sceneName: step.sceneName, sourceName: step.sourceName })
      const { sceneItemEnabled } = await obsCall(obs, "GetSceneItemEnabled", { sceneName: step.sceneName, sceneItemId })
      const visible = wanted(step.set, sceneItemEnabled)
      if (visible !== sceneItemEnabled) await obsCall(obs, "SetSceneItemEnabled", { sceneName: step.sceneName, sceneItemId, sceneItemEnabled: visible })
      return { active: visible }
    }

    case "obs_start_stop_stream": {
      const obs = await context.obs.connect()
      const { outputActive } = await obsCall(obs, "GetStreamStatus")
      const live = wanted(step.set, outputActive)
      if (live !== outputActive) await obsCall(obs, live ? "StartStream" : "StopStream")
      return { active: live }
    }

    case "obs_toggle_record": {
      const obs = await context.obs.connect()
      const { outputActive } = await obsCall(obs, "GetRecordStatus")
      const recording = wanted(step.set, outputActive)
      if (recording !== outputActive) await obsCall(obs, recording ? "StartRecord" : "StopRecord")
      return { active: recording }
    }

    case "obs_toggle_filter": {
      if (!step.sourceName || !step.filterName) throw new Error("Choose the source and the filter first.")
      const obs = await context.obs.connect()
      const { filterEnabled } = await obsCall(obs, "GetSourceFilter", { sourceName: step.sourceName, filterName: step.filterName })
      const enabled = wanted(step.set, filterEnabled)
      if (enabled !== filterEnabled) await obsCall(obs, "SetSourceFilterEnabled", { sourceName: step.sourceName, filterName: step.filterName, filterEnabled: enabled })
      return { active: enabled }
    }

    case "obs_toggle_virtualcam": {
      const obs = await context.obs.connect()
      const { outputActive } = await obsCall(obs, "GetVirtualCamStatus")
      const running = wanted(step.set, outputActive)
      if (running !== outputActive) await obsCall(obs, running ? "StartVirtualCam" : "StopVirtualCam")
      return { active: running }
    }

    case "obs_save_replay": {
      const obs = await context.obs.connect()
      const { outputActive } = await obsCall(obs, "GetReplayBufferStatus")
      if (!outputActive) throw new Error("OBS's replay buffer is off. Start it in OBS (Start Replay Buffer, under Controls), then press again.")
      await obsCall(obs, "SaveReplayBuffer")
      return { active: true }
    }

    case "obs_studio_transition": {
      const obs = await context.obs.connect()
      const { studioModeEnabled } = await obsCall(obs, "GetStudioModeEnabled")
      if (!studioModeEnabled) throw new Error("Studio Mode is off in OBS, so there is no preview to send live.")
      await obsCall(obs, "TriggerStudioModeTransition")
      return {}
    }

    case "media_key":
      await sendMediaKey(step.mediaKey ?? "play_pause")
      return {}

    case "stop_sounds":
      context.stopSounds()
      return {}

    // The companion plays it through this computer's output; the tablet
    // never loads the audio. Pressing again stops it.
    case "play_sound":
      context.onSound(Math.max(1, Math.min(LIMITS.soundSlots, Number(step.soundId) || 1)))
      return {}

    // Only the device can open its own browser or change its own deck; the caller handles those.
    case "browser_tile":
    case "go_to_deck":
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
  deckId: string | null
}

/** Runs a macro in order and reports what the deck needs to know afterwards.
    A failing step stops the rest, and the message says which one it was. */
export async function runSteps(steps: readonly Step[], context: ActionContext): Promise<MacroResult> {
  let active: boolean | undefined
  let tabletUrl: string | null = null
  let deckId: string | null = null

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!
    // Every step's wait applies, in order, including the steps that do nothing
    // here: "Do nothing" with a wait is a pause, and a link or deck change
    // waits like any other step. The device opens the link or changes deck
    // when the whole macro is done, so their wait delays the steps after them.
    if (step.type === "none" || step.type === "browser_tile" || step.type === "go_to_deck") {
      if (step.delayMs) await sleep(step.delayMs)
    }
    if (step.type === "none") continue
    // Only the first link and deck count: a device can open one page or show one deck per press.
    if (step.type === "browser_tile") {
      tabletUrl ??= webAddress(step.url)
      continue
    }
    if (step.type === "go_to_deck") {
      deckId ??= step.profileId ?? null
      continue
    }
    try {
      const result = await runAction(step, context)
      if (typeof result.active === "boolean") active = result.active
    } catch (error) {
      if (steps.length < 2) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Step ${index + 1} of ${steps.length} (${ACTION_META[step.type].label}) failed, so the rest did not run: ${reason}`)
    }
  }
  return { active, tabletUrl, deckId }
}
