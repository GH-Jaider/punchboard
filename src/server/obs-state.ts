// What OBS is doing right now, as the decks show it: the live scene, what is
// muted, streaming, recording, visible or filtered, and every OBS fader's
// volume. Read in full when the link comes up or the decks change, then kept
// current from OBS's own events, so a change made in OBS itself (a click in
// its mixer, a stream that drops) shows on every deck at once.
import type OBSWebSocket from "obs-websocket-js"
import type { ObsNames } from "../shared/api.ts"
import { stateKeyOf } from "../shared/model.ts"
import type { Library, Step } from "../shared/types.ts"

export interface ObsStateOptions {
  library: () => Library
  setToggles: (changes: Record<string, boolean>) => void
  setLevels: (changes: Record<string, number>) => void
}

export type ObsState = ReturnType<typeof createObsState>

/** OBS faders are cubic; decks show the position, not the gain. */
export const faderPosition = (mul: number): number => Math.max(0, Math.min(1, Math.cbrt(Math.max(0, mul))))

const quietly = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null)

export function createObsState(options: ObsStateOptions) {
  let socket: OBSWebSocket | null = null
  /** OBS names scene items by number in its events; the key each belongs to. */
  const sceneItems = new Map<string, string>()
  const itemKey = (sceneName: string, itemId: number): string => `${sceneName}\n${itemId}`

  function libraryParts(): { steps: Step[]; faderInputs: Set<string> } {
    const steps: Step[] = []
    const faderInputs = new Set<string>()
    for (const profile of options.library().profiles) {
      for (const button of profile.buttons) {
        if (button.control === "fader") {
          if (button.fader.target === "obs_input" && button.fader.inputName) faderInputs.add(button.fader.inputName)
        } else {
          for (const step of button.steps) if (stateKeyOf(step)) steps.push(step)
        }
      }
    }
    return { steps, faderInputs }
  }

  /** Reads every state a deck could show. Anything OBS cannot answer (a
      renamed source, a replay buffer that is not set up) just stays off. */
  async function refresh(): Promise<void> {
    const obs = socket
    if (!obs) return
    const toggles: Record<string, boolean> = {}
    const levels: Record<string, number> = {}
    const { steps, faderInputs } = libraryParts()
    const reads: Promise<unknown>[] = [
      quietly(obs.call("GetCurrentProgramScene")).then((r) => { if (r) toggles[`scene:${r.currentProgramSceneName}`] = true }),
      quietly(obs.call("GetStreamStatus")).then((r) => { toggles.stream = Boolean(r?.outputActive) }),
      quietly(obs.call("GetRecordStatus")).then((r) => { toggles.record = Boolean(r?.outputActive) }),
      quietly(obs.call("GetVirtualCamStatus")).then((r) => { toggles.virtualcam = Boolean(r?.outputActive) }),
      quietly(obs.call("GetReplayBufferStatus")).then((r) => { toggles.replaybuffer = Boolean(r?.outputActive) })
    ]
    const seen = new Set<string>()
    for (const step of steps) {
      const key = stateKeyOf(step)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (step.type === "obs_toggle_mute" && step.sourceName) {
        reads.push(quietly(obs.call("GetInputMute", { inputName: step.sourceName })).then((r) => { toggles[key] = Boolean(r?.inputMuted) }))
      } else if (step.type === "obs_toggle_filter" && step.sourceName && step.filterName) {
        reads.push(quietly(obs.call("GetSourceFilter", { sourceName: step.sourceName, filterName: step.filterName })).then((r) => { toggles[key] = Boolean(r?.filterEnabled) }))
      } else if (step.type === "obs_toggle_source" && step.sceneName && step.sourceName) {
        const sceneName = step.sceneName
        reads.push((async () => {
          const found = await quietly(obs.call("GetSceneItemId", { sceneName, sourceName: step.sourceName! }))
          if (!found) return
          sceneItems.set(itemKey(sceneName, found.sceneItemId), key)
          const enabled = await quietly(obs.call("GetSceneItemEnabled", { sceneName, sceneItemId: found.sceneItemId }))
          toggles[key] = Boolean(enabled?.sceneItemEnabled)
        })())
      }
    }
    for (const inputName of faderInputs) {
      reads.push(quietly(obs.call("GetInputVolume", { inputName })).then((r) => { if (r) levels[`obs:${inputName}`] = faderPosition(r.inputVolumeMul) }))
    }
    await Promise.all(reads)
    if (socket !== obs) return
    options.setToggles(toggles)
    options.setLevels(levels)
  }

  /** Starts following a freshly connected OBS. */
  function attach(obs: OBSWebSocket): void {
    socket = obs
    sceneItems.clear()
    const set = (key: string, value: boolean): void => { if (socket === obs) options.setToggles({ [key]: value }) }
    obs.on("CurrentProgramSceneChanged", (event) => set(`scene:${event.sceneName}`, true))
    obs.on("InputMuteStateChanged", (event) => set(`mute:${event.inputName}`, event.inputMuted))
    obs.on("StreamStateChanged", (event) => set("stream", event.outputActive))
    obs.on("RecordStateChanged", (event) => set("record", event.outputActive))
    obs.on("VirtualcamStateChanged", (event) => set("virtualcam", event.outputActive))
    obs.on("ReplayBufferStateChanged", (event) => set("replaybuffer", event.outputActive))
    obs.on("SourceFilterEnableStateChanged", (event) => set(`filter:${event.sourceName}\n${event.filterName}`, event.filterEnabled))
    obs.on("SceneItemEnableStateChanged", (event) => {
      const key = sceneItems.get(itemKey(event.sceneName, event.sceneItemId))
      if (key) set(key, event.sceneItemEnabled)
    })
    obs.on("InputVolumeChanged", (event) => {
      if (socket === obs) options.setLevels({ [`obs:${event.inputName}`]: faderPosition(event.inputVolumeMul) })
    })
    // Renaming or rebuilding things in OBS can change what the decks point at.
    const reread = (): void => { refresh().catch(() => { /* OBS went away mid-read */ }) }
    obs.on("InputNameChanged", reread)
    obs.on("SceneNameChanged", reread)
    obs.on("SceneItemCreated", reread)
    obs.on("SceneItemRemoved", reread)
    reread()
  }

  function detach(): void {
    socket = null
    sceneItems.clear()
  }

  return { attach, detach, refresh: (): void => { refresh().catch(() => { /* retried on the next change */ }) } }
}

/** Every name the Control Center's pickers offer, read from OBS in one go. */
export async function readObsNames(obs: OBSWebSocket): Promise<ObsNames> {
  const [sceneList, inputList] = await Promise.all([obs.call("GetSceneList"), obs.call("GetInputList")])
  // OBS lists scenes bottom-up; its own window shows the highest index first.
  const scenes = sceneList.scenes
    .slice()
    .sort((a, b) => Number(b.sceneIndex) - Number(a.sceneIndex))
    .map((scene) => String(scene.sceneName))
  const inputs = inputList.inputs.map((input) => String(input.inputName))

  const sceneItems: Record<string, string[]> = {}
  const found: Record<string, string[]> = {}
  const audioInputs: string[] = []
  await Promise.all([
    ...scenes.map(async (sceneName) => {
      const items = await quietly(obs.call("GetSceneItemList", { sceneName }))
      sceneItems[sceneName] = items ? items.sceneItems.map((item) => String(item.sourceName)).reverse() : []
    }),
    // Only inputs with audio answer a mute question.
    ...inputs.map(async (inputName) => {
      if (await quietly(obs.call("GetInputMute", { inputName }))) audioInputs.push(inputName)
    }),
    ...[...scenes, ...inputs].map(async (sourceName) => {
      const list = await quietly(obs.call("GetSourceFilterList", { sourceName }))
      if (list && list.filters.length) found[sourceName] = list.filters.map((filter) => String(filter.filterName))
    })
  ])
  audioInputs.sort((a, b) => inputs.indexOf(a) - inputs.indexOf(b))
  // Scenes first, then inputs, each in OBS's order, whatever order OBS answered in.
  const filters: Record<string, string[]> = {}
  for (const sourceName of [...scenes, ...inputs]) {
    const list = found[sourceName]
    if (list) filters[sourceName] = list
  }
  return { connected: true, scenes, sceneItems, audioInputs, filters }
}
