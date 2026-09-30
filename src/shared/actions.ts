// What each action is called, where it runs, and which fields it needs. The
// Control Center builds its editors from these tables instead of if-chains.
import { formatCombo, isMacLike } from "./keys.ts"
import type { ActionType, FaderTarget, MediaKey, SetMode, Step, StepTextField } from "./types.ts"

export type ActionGroup = "OBS" | "This computer" | "On the deck" | "Other"

export interface ActionMeta { label: string; group: ActionGroup; hint: string }

export const ACTION_META: Readonly<Record<ActionType, ActionMeta>> = {
  obs_scene: { label: "Switch scene", group: "OBS", hint: "Make an OBS scene the live program scene. The button lights up while that scene is live." },
  obs_toggle_source: { label: "Show / hide source", group: "OBS", hint: "Toggle one source's visibility inside a scene. Lit while it is visible." },
  obs_toggle_mute: { label: "Mute / unmute input", group: "OBS", hint: "Toggle mute on one OBS audio input. Lit while it is muted." },
  obs_toggle_filter: { label: "Turn a filter on / off", group: "OBS", hint: "Switch one of a source's filters, such as a voice changer or a colour correction. Lit while it is on." },
  obs_start_stop_stream: { label: "Start / stop stream", group: "OBS", hint: "Go live, or end the stream if it is already running. Lit while live." },
  obs_toggle_record: { label: "Start / stop recording", group: "OBS", hint: "Begin recording, or stop and save the current take. Lit while recording." },
  obs_toggle_virtualcam: { label: "Start / stop virtual camera", group: "OBS", hint: "OBS's output as a camera for Zoom, Meet or Discord. Lit while it runs." },
  obs_save_replay: { label: "Save replay", group: "OBS", hint: "Saves the last moments from OBS's replay buffer. Lit while the buffer is running; start it in OBS (Start Replay Buffer)." },
  obs_studio_transition: { label: "Studio Mode: send preview live", group: "OBS", hint: "In Studio Mode, puts the preview scene on air with the current transition." },
  open_url: { label: "Open link on computer", group: "This computer", hint: "Opens in the default browser on the computer running Punchboard." },
  launch_app: { label: "Launch an app", group: "This computer", hint: "Starts an application on the computer running Punchboard." },
  play_sound: { label: "Play a sound", group: "This computer", hint: "Plays through the computer's speakers, not the device's. Press again to stop it." },
  stop_sounds: { label: "Stop all sounds", group: "This computer", hint: "Silences every Punchboard sound that is playing." },
  media_key: { label: "Music controls", group: "This computer", hint: "The play / pause and track keys, for whatever plays music on the computer: Spotify, Apple Music, YouTube in a browser." },
  hotkey: { label: "Key combination", group: "This computer", hint: "Presses keys on this computer as if typed, for an OBS hotkey or any app's shortcut. They go to whatever is in front, so global hotkeys work best." },
  go_to_deck: { label: "Go to another deck", group: "On the deck", hint: "Switches the device that pressed it to another deck, like a folder. Add a button there to come back." },
  browser_tile: { label: "Open link on the device", group: "On the deck", hint: "Opens a site in the device's own browser, for chat or a dashboard." },
  none: { label: "Do nothing", group: "Other", hint: "A spacer or a label-only tile." }
}

export const ACTION_TYPES = Object.keys(ACTION_META) as ActionType[]
export const ACTION_GROUPS: readonly ActionGroup[] = ["OBS", "This computer", "On the deck", "Other"]

export const isActionType = (value: unknown): value is ActionType => typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTION_META, value)

/** Actions whose live state OBS reports, so a tile can light up with it. */
export const STATEFUL_ACTIONS: readonly ActionType[] = [
  "obs_scene", "obs_toggle_mute", "obs_start_stop_stream", "obs_toggle_record", "obs_toggle_source",
  "obs_toggle_filter", "obs_toggle_virtualcam", "obs_save_replay"
]

/** How each on/off action words its three modes. */
export const SET_LABELS: Readonly<Partial<Record<ActionType, Readonly<Record<SetMode, string>>>>> = {
  obs_toggle_mute: { toggle: "Mute / unmute", on: "Mute", off: "Unmute" },
  obs_toggle_source: { toggle: "Show / hide", on: "Show source", off: "Hide source" },
  obs_toggle_filter: { toggle: "Turn on / off", on: "Turn filter on", off: "Turn filter off" },
  obs_start_stop_stream: { toggle: "Start / stop", on: "Start stream", off: "Stop stream" },
  obs_toggle_record: { toggle: "Start / stop", on: "Start recording", off: "Stop recording" },
  obs_toggle_virtualcam: { toggle: "Start / stop", on: "Start virtual camera", off: "Stop virtual camera" }
}
export const SET_MODES: readonly SetMode[] = ["toggle", "on", "off"]
export const isSetMode = (value: unknown): value is SetMode => value === "toggle" || value === "on" || value === "off"

/** A step's mode, for the actions that have one; null for the rest. */
export function setModeOf(step: Step): SetMode | null {
  if (!SET_LABELS[step.type]) return null
  return (step as { set?: SetMode }).set ?? "toggle"
}

export const MEDIA_KEYS: Readonly<Record<MediaKey, string>> = { play_pause: "Play / pause", next: "Next track", previous: "Previous track" }
export const isMediaKey = (value: unknown): value is MediaKey => typeof value === "string" && Object.prototype.hasOwnProperty.call(MEDIA_KEYS, value)

/** Which list of names from OBS a field picks from (see ObsNames). */
export type ObsPick = "scene" | "sceneItem" | "audioInput" | "filterSource" | "filter"

export interface FieldSpec { key: StepTextField; label: string; placeholder: string; pick?: ObsPick }

export const ACTION_FIELDS: Readonly<Partial<Record<ActionType, readonly FieldSpec[]>>> = {
  obs_scene: [{ key: "sceneName", label: "Scene", placeholder: "Exact OBS scene name", pick: "scene" }],
  obs_toggle_source: [
    { key: "sceneName", label: "Scene", placeholder: "Exact OBS scene name", pick: "scene" },
    { key: "sourceName", label: "Source", placeholder: "Exact OBS source name", pick: "sceneItem" }
  ],
  obs_toggle_mute: [{ key: "sourceName", label: "Audio input", placeholder: "Exact OBS input name", pick: "audioInput" }],
  obs_toggle_filter: [
    { key: "sourceName", label: "Source", placeholder: "Exact OBS source or scene name", pick: "filterSource" },
    { key: "filterName", label: "Filter", placeholder: "Exact filter name", pick: "filter" }
  ],
  open_url: [{ key: "url", label: "Link", placeholder: "example.com" }],
  browser_tile: [{ key: "url", label: "Link", placeholder: "example.com" }]
}

/** Reads a text field from any step; undefined when that step type has none. */
export function stepText(step: Step, key: StepTextField): string | undefined {
  const value = (step as Partial<Record<StepTextField, unknown>>)[key]
  return typeof value === "string" ? value : undefined
}

// A step only stores a deck's id; whoever shows summaries knows the names.
let deckName: (profileId: string) => string | undefined = () => undefined
export function nameDecksWith(lookup: (profileId: string) => string | undefined): void {
  deckName = lookup
}

function stepDetail(step: Step): string {
  switch (step.type) {
    case "launch_app": return step.appName || step.appPath || ""
    case "play_sound": return `Sound ${step.soundId ?? 1}`
    case "hotkey": return formatCombo(step.keys, isMacLike())
    case "media_key": return step.mediaKey ? MEDIA_KEYS[step.mediaKey] : ""
    case "go_to_deck": return (step.profileId && deckName(step.profileId)) || ""
    case "obs_toggle_source": return step.sourceName || step.sceneName || ""
    case "obs_toggle_filter": return step.filterName ? `${step.filterName}${step.sourceName ? ` on ${step.sourceName}` : ""}` : step.sourceName || ""
    default: return stepText(step, "sceneName") || stepText(step, "sourceName") || stepText(step, "url") || ""
  }
}

/** One-line description of a step, for collapsed step lists and screen readers. */
export function stepSummary(step: Step | undefined): string {
  if (!step) return "Empty step"
  const detail = stepDetail(step)
  // "Mute · Mic" says more than "Mute / unmute input · Mic" once the mode is fixed.
  const mode = setModeOf(step)
  const label = mode && mode !== "toggle" ? SET_LABELS[step.type]![mode] : ACTION_META[step.type].label
  return detail ? `${label} · ${detail}` : label
}

export interface FaderTargetMeta { label: string; hint: string }

export const FADER_TARGETS: Readonly<Record<FaderTarget, FaderTargetMeta>> = {
  obs_input: { label: "OBS input volume", hint: "The volume of one OBS audio source, on the same curve as OBS's own mixer." },
  sounds: { label: "Punchboard sounds volume", hint: "How loud Play a sound buttons are on this computer." },
  system: { label: "This computer's volume", hint: "The main output volume of the computer running Punchboard." }
}

export const isFaderTarget = (value: unknown): value is FaderTarget => typeof value === "string" && Object.prototype.hasOwnProperty.call(FADER_TARGETS, value)

/** Limits enforced on both sides. */
export const LIMITS = {
  maxSteps: 12,
  maxDelayMs: 60000,
  soundSlots: 8,
  maxSoundBytes: 8 * 1024 * 1024,
  maxIconBytes: 750 * 1024,
  columns: { min: 2, max: 8 },
  rows: { min: 1, max: 6 }
} as const
