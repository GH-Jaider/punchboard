// What each action is called, where it runs, and which fields it needs. The
// Control Center builds its editors from these tables instead of if-chains.
import { t } from "./i18n.ts"
import { formatCombo, isMacLike } from "./keys.ts"
import type { ActionType, FaderTarget, MediaKey, SetMode, Step, StepTextField } from "./types.ts"

export type ActionGroup = "OBS" | "This computer" | "On the deck" | "Other"

export interface ActionMeta { label: string; group: ActionGroup; hint: string }

/** An action's entry; its name and hint are read in the page's language when shown. */
const actionMeta = (type: ActionType, group: ActionGroup): ActionMeta => ({
  group,
  get label() { return t(`shared.action.${type}.label`) },
  get hint() { return t(`shared.action.${type}.hint`) }
})

export const ACTION_META: Readonly<Record<ActionType, ActionMeta>> = {
  obs_scene: actionMeta("obs_scene", "OBS"),
  obs_toggle_source: actionMeta("obs_toggle_source", "OBS"),
  obs_toggle_mute: actionMeta("obs_toggle_mute", "OBS"),
  obs_toggle_filter: actionMeta("obs_toggle_filter", "OBS"),
  obs_start_stop_stream: actionMeta("obs_start_stop_stream", "OBS"),
  obs_toggle_record: actionMeta("obs_toggle_record", "OBS"),
  obs_toggle_virtualcam: actionMeta("obs_toggle_virtualcam", "OBS"),
  obs_save_replay: actionMeta("obs_save_replay", "OBS"),
  obs_studio_transition: actionMeta("obs_studio_transition", "OBS"),
  open_url: actionMeta("open_url", "This computer"),
  launch_app: actionMeta("launch_app", "This computer"),
  play_sound: actionMeta("play_sound", "This computer"),
  stop_sounds: actionMeta("stop_sounds", "This computer"),
  media_key: actionMeta("media_key", "This computer"),
  hotkey: actionMeta("hotkey", "This computer"),
  go_to_deck: actionMeta("go_to_deck", "On the deck"),
  browser_tile: actionMeta("browser_tile", "On the deck"),
  none: actionMeta("none", "Other")
}

export const ACTION_TYPES = Object.keys(ACTION_META) as ActionType[]
export const ACTION_GROUPS: readonly ActionGroup[] = ["OBS", "This computer", "On the deck", "Other"]

const GROUP_KEYS: Readonly<Record<ActionGroup, string>> = { OBS: "obs", "This computer": "computer", "On the deck": "deck", Other: "other" }

/** A group's name as the action picker shows it. */
export const actionGroupLabel = (group: ActionGroup): string => t(`shared.actionGroup.${GROUP_KEYS[group]}`)

export const isActionType = (value: unknown): value is ActionType => typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTION_META, value)

/** Actions whose live state OBS reports, so a tile can light up with it. */
export const STATEFUL_ACTIONS: readonly ActionType[] = [
  "obs_scene", "obs_toggle_mute", "obs_start_stop_stream", "obs_toggle_record", "obs_toggle_source",
  "obs_toggle_filter", "obs_toggle_virtualcam", "obs_save_replay"
]

/** How each on/off action words its three modes, read in the page's language. */
const setLabels = (type: ActionType): Readonly<Record<SetMode, string>> => ({
  get toggle() { return t(`shared.setMode.${type}.toggle`) },
  get on() { return t(`shared.setMode.${type}.on`) },
  get off() { return t(`shared.setMode.${type}.off`) }
})

/** How each on/off action words its three modes. */
export const SET_LABELS: Readonly<Partial<Record<ActionType, Readonly<Record<SetMode, string>>>>> = {
  obs_toggle_mute: setLabels("obs_toggle_mute"),
  obs_toggle_source: setLabels("obs_toggle_source"),
  obs_toggle_filter: setLabels("obs_toggle_filter"),
  obs_start_stop_stream: setLabels("obs_start_stop_stream"),
  obs_toggle_record: setLabels("obs_toggle_record"),
  obs_toggle_virtualcam: setLabels("obs_toggle_virtualcam")
}
export const SET_MODES: readonly SetMode[] = ["toggle", "on", "off"]
export const isSetMode = (value: unknown): value is SetMode => value === "toggle" || value === "on" || value === "off"

/** A step's mode, for the actions that have one; null for the rest. */
export function setModeOf(step: Step): SetMode | null {
  if (!SET_LABELS[step.type]) return null
  return (step as { set?: SetMode }).set ?? "toggle"
}

export const MEDIA_KEYS: Readonly<Record<MediaKey, string>> = {
  get play_pause() { return t("shared.mediaKey.play_pause") },
  get next() { return t("shared.mediaKey.next") },
  get previous() { return t("shared.mediaKey.previous") }
}
export const isMediaKey = (value: unknown): value is MediaKey => typeof value === "string" && Object.prototype.hasOwnProperty.call(MEDIA_KEYS, value)

/** Which list of names from OBS a field picks from (see ObsNames). */
export type ObsPick = "scene" | "sceneItem" | "audioInput" | "filterSource" | "filter"

export interface FieldSpec { key: StepTextField; label: string; placeholder: string; pick?: ObsPick }

/** A field of an action's editor; its label and placeholder are read in the page's language. */
function field(type: ActionType, key: StepTextField, pick?: ObsPick): FieldSpec {
  const spec: FieldSpec = {
    key,
    get label() { return t(`shared.field.${type}.${key}.label`) },
    get placeholder() { return t(`shared.field.${type}.${key}.placeholder`) }
  }
  if (pick) spec.pick = pick
  return spec
}

export const ACTION_FIELDS: Readonly<Partial<Record<ActionType, readonly FieldSpec[]>>> = {
  obs_scene: [field("obs_scene", "sceneName", "scene")],
  obs_toggle_source: [
    field("obs_toggle_source", "sceneName", "scene"),
    field("obs_toggle_source", "sourceName", "sceneItem")
  ],
  obs_toggle_mute: [field("obs_toggle_mute", "sourceName", "audioInput")],
  obs_toggle_filter: [
    field("obs_toggle_filter", "sourceName", "filterSource"),
    field("obs_toggle_filter", "filterName", "filter")
  ],
  open_url: [field("open_url", "url")],
  browser_tile: [field("browser_tile", "url")]
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
    case "play_sound": return t("shared.step.sound", { number: step.soundId ?? 1 })
    case "hotkey": return formatCombo(step.keys, isMacLike())
    case "media_key": return step.mediaKey ? MEDIA_KEYS[step.mediaKey] : ""
    case "go_to_deck": return (step.profileId && deckName(step.profileId)) || ""
    case "obs_toggle_source": return step.sourceName || step.sceneName || ""
    case "obs_toggle_filter": return step.filterName ? (step.sourceName ? t("shared.step.filterOn", { filter: step.filterName, source: step.sourceName }) : step.filterName) : step.sourceName || ""
    default: return stepText(step, "sceneName") || stepText(step, "sourceName") || stepText(step, "url") || ""
  }
}

/** One-line description of a step, for collapsed step lists and screen readers. */
export function stepSummary(step: Step | undefined): string {
  if (!step) return t("shared.step.empty")
  const detail = stepDetail(step)
  // "Mute · Mic" says more than "Mute / unmute input · Mic" once the mode is fixed.
  const mode = setModeOf(step)
  const label = mode && mode !== "toggle" ? SET_LABELS[step.type]![mode] : ACTION_META[step.type].label
  return detail ? `${label} · ${detail}` : label
}

export interface FaderTargetMeta { label: string; hint: string }

/** A fader target's entry, read in the page's language. */
const faderTarget = (target: FaderTarget): FaderTargetMeta => ({
  get label() { return t(`shared.fader.${target}.label`) },
  get hint() { return t(`shared.fader.${target}.hint`) }
})

export const FADER_TARGETS: Readonly<Record<FaderTarget, FaderTargetMeta>> = {
  obs_input: faderTarget("obs_input"),
  sounds: faderTarget("sounds"),
  system: faderTarget("system"),
  app: faderTarget("app")
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
