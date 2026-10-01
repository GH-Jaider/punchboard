// What OBS is doing right now, as the decks show it: the live scene, what is
// muted, streaming, recording, visible or filtered, and every OBS fader's
// volume. Read in full when the link comes up or the decks change, then kept
// current from OBS's own events, so a change made in OBS itself (a click in
// its mixer, a stream that drops) shows on every deck at once. Only what the
// decks use is followed.
import type OBSWebSocket from "obs-websocket-js"
import type { ObsNames } from "../shared/api.ts"
import { stateKeyOf } from "../shared/model.ts"
import type { Library, Step } from "../shared/types.ts"
import { obsCall } from "./obs.ts"

export interface ObsStateOptions {
  library: () => Library
  setToggles: (changes: Record<string, boolean>) => void
  setLevels: (changes: Record<string, number>) => void
  /** Forgets fader levels OBS can no longer vouch for (a renamed input). */
  dropLevels: (keys: string[]) => void
}

export type ObsState = ReturnType<typeof createObsState>

/** OBS faders are cubic; decks show the position, not the gain. */
export const faderPosition = (mul: number): number => Math.max(0, Math.min(1, Math.cbrt(Math.max(0, mul))))

const quietly = <T>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null)

// OBS's outputs are four fixed states, read and followed whether or not a
// button shows them yet: they change rarely and cost nothing to keep.
const OUTPUT_KEYS = ["stream", "record", "virtualcam", "replaybuffer"]

// Rebuilding a scene in OBS sends one event per item; one read covers them all.
const REFRESH_DEBOUNCE_MS = 150

/** What the library looks at in OBS. Every other input, filter and source is
    somebody else's business: OBS reports all of them, and following them
    would broadcast to every deck for each drag in OBS's mixer. */
interface Used {
  steps: Step[]
  /** Every state key a button shows, plus OBS's outputs. */
  keys: Set<string>
  /** The scene keys among them, so a scene no button shows can turn them off. */
  scenes: string[]
  faderInputs: Set<string>
}

export function createObsState(options: ObsStateOptions) {
  let socket: OBSWebSocket | null = null
  /** OBS names scene items by number in its events; the key each belongs to. */
  const sceneItems = new Map<string, string>()
  const itemKey = (sceneName: string, itemId: number): string => `${sceneName}\n${itemId}`
  let used: Used | null = null
  let usedFor: Library | null = null
  // A refresh reads for a while; an event that lands meanwhile is newer than
  // what it read. Each event stamps its key, and a refresh skips any key
  // stamped after it started.
  let tick = 0
  const changedAt = new Map<string, number>()
  let sceneChangedAt = 0
  let refreshes = 0
  let refreshTimer: NodeJS.Timeout | undefined

  /** The library's view of OBS, worked out again whenever the library is replaced. */
  function libraryParts(): Used {
    const library = options.library()
    if (used && usedFor === library) return used
    const steps: Step[] = []
    const keys = new Set<string>(OUTPUT_KEYS)
    const faderInputs = new Set<string>()
    for (const profile of library.profiles) {
      for (const button of profile.buttons) {
        if (button.control === "fader") {
          if (button.fader.target === "obs_input" && button.fader.inputName) faderInputs.add(button.fader.inputName)
        } else {
          for (const list of [button.steps, button.offSteps ?? []]) {
            for (const step of list) {
              const key = stateKeyOf(step)
              if (!key) continue
              steps.push(step)
              keys.add(key)
            }
          }
        }
      }
    }
    used = { steps, keys, scenes: [...keys].filter((key) => key.startsWith("scene:")), faderInputs }
    usedFor = library
    return used
  }

  /** The scene buttons as OBS's program scene leaves them: that one lit, the
      rest off, all off when it is a scene no button shows (or unknown). */
  function sceneToggles(sceneName: string | null): Record<string, boolean> {
    const parts = libraryParts()
    const toggles: Record<string, boolean> = {}
    for (const key of parts.scenes) toggles[key] = false
    if (sceneName !== null && parts.keys.has(`scene:${sceneName}`)) toggles[`scene:${sceneName}`] = true
    return toggles
  }

  /** Reads every state a deck could show. Anything OBS cannot answer (a
      renamed source, a replay buffer that is not set up) shows as off. */
  async function refresh(): Promise<void> {
    const obs = socket
    if (!obs) return
    const mine = ++refreshes
    const startedAt = tick
    const toggles: Record<string, boolean> = {}
    const levels: Record<string, number> = {}
    const missing: string[] = []
    const items = new Map<string, string>()
    let programScene: string | null = null
    const parts = libraryParts()
    const reads: Promise<unknown>[] = [
      quietly(obsCall(obs, "GetCurrentProgramScene")).then((r) => { if (r) programScene = r.currentProgramSceneName }),
      quietly(obsCall(obs, "GetStreamStatus")).then((r) => { toggles.stream = Boolean(r?.outputActive) }),
      quietly(obsCall(obs, "GetRecordStatus")).then((r) => { toggles.record = Boolean(r?.outputActive) }),
      quietly(obsCall(obs, "GetVirtualCamStatus")).then((r) => { toggles.virtualcam = Boolean(r?.outputActive) }),
      quietly(obsCall(obs, "GetReplayBufferStatus")).then((r) => { toggles.replaybuffer = Boolean(r?.outputActive) })
    ]
    const seen = new Set<string>()
    for (const step of parts.steps) {
      const key = stateKeyOf(step)
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (step.type === "obs_toggle_mute" && step.sourceName) {
        reads.push(quietly(obsCall(obs, "GetInputMute", { inputName: step.sourceName })).then((r) => { toggles[key] = Boolean(r?.inputMuted) }))
      } else if (step.type === "obs_toggle_filter" && step.sourceName && step.filterName) {
        reads.push(quietly(obsCall(obs, "GetSourceFilter", { sourceName: step.sourceName, filterName: step.filterName })).then((r) => { toggles[key] = Boolean(r?.filterEnabled) }))
      } else if (step.type === "obs_toggle_source" && step.sceneName && step.sourceName) {
        const sceneName = step.sceneName
        const sourceName = step.sourceName
        reads.push((async () => {
          // Off unless OBS confirms it: a renamed scene or source must not stay lit.
          toggles[key] = false
          const found = await quietly(obsCall(obs, "GetSceneItemId", { sceneName, sourceName }))
          if (!found) return
          items.set(itemKey(sceneName, found.sceneItemId), key)
          const enabled = await quietly(obsCall(obs, "GetSceneItemEnabled", { sceneName, sceneItemId: found.sceneItemId }))
          toggles[key] = Boolean(enabled?.sceneItemEnabled)
        })())
      }
    }
    for (const inputName of parts.faderInputs) {
      const key = `obs:${inputName}`
      reads.push(quietly(obsCall(obs, "GetInputVolume", { inputName })).then((r) => {
        if (r) levels[key] = faderPosition(r.inputVolumeMul)
        else missing.push(key)
      }))
    }
    await Promise.all(reads)
    // A newer refresh (or another OBS) has the better answer.
    if (socket !== obs || mine !== refreshes) return
    const newer = (key: string): boolean => (changedAt.get(key) ?? 0) > startedAt
    for (const key of Object.keys(toggles)) if (newer(key)) delete toggles[key]
    for (const key of Object.keys(levels)) if (newer(key)) delete levels[key]
    if (sceneChangedAt <= startedAt) Object.assign(toggles, sceneToggles(programScene))
    sceneItems.clear()
    for (const [item, key] of items) sceneItems.set(item, key)
    options.setToggles(toggles)
    options.setLevels(levels)
    const gone = missing.filter((key) => !newer(key))
    if (gone.length) options.dropLevels(gone)
  }

  function refreshSoon(): void {
    refreshTimer ??= setTimeout(() => {
      refreshTimer = undefined
      refresh().catch(() => { /* OBS went away mid-read */ })
    }, REFRESH_DEBOUNCE_MS)
  }

  /** Starts following a freshly connected OBS. */
  function attach(obs: OBSWebSocket): void {
    detach()
    socket = obs
    const set = (key: string, value: boolean): void => {
      if (socket !== obs || !libraryParts().keys.has(key)) return
      changedAt.set(key, ++tick)
      options.setToggles({ [key]: value })
    }
    obs.on("CurrentProgramSceneChanged", (event) => {
      if (socket !== obs) return
      sceneChangedAt = ++tick
      options.setToggles(sceneToggles(event.sceneName))
    })
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
      if (socket !== obs || !libraryParts().faderInputs.has(event.inputName)) return
      const key = `obs:${event.inputName}`
      changedAt.set(key, ++tick)
      options.setLevels({ [key]: faderPosition(event.inputVolumeMul) })
    })
    // Renaming or rebuilding things in OBS can change what the decks point at.
    obs.on("InputNameChanged", refreshSoon)
    obs.on("SceneNameChanged", refreshSoon)
    obs.on("SceneItemCreated", refreshSoon)
    obs.on("SceneItemRemoved", refreshSoon)
    refresh().catch(() => { /* OBS went away mid-read */ })
  }

  function detach(): void {
    socket = null
    sceneItems.clear()
    changedAt.clear()
    clearTimeout(refreshTimer)
    refreshTimer = undefined
  }

  return { attach, detach, refresh: (): void => { refresh().catch(() => { /* retried on the next change */ }) } }
}

/** Every name the Control Center's pickers offer, read from OBS in one go. */
export async function readObsNames(obs: OBSWebSocket): Promise<ObsNames> {
  const [sceneList, inputList] = await Promise.all([obsCall(obs, "GetSceneList"), obsCall(obs, "GetInputList")])
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
      const items = await quietly(obsCall(obs, "GetSceneItemList", { sceneName }))
      sceneItems[sceneName] = items ? items.sceneItems.map((item) => String(item.sourceName)).reverse() : []
    }),
    // Only inputs with audio answer a mute question.
    ...inputs.map(async (inputName) => {
      if (await quietly(obsCall(obs, "GetInputMute", { inputName }))) audioInputs.push(inputName)
    }),
    ...[...scenes, ...inputs].map(async (sourceName) => {
      const list = await quietly(obsCall(obs, "GetSourceFilterList", { sourceName }))
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
