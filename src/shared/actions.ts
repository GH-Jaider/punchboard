// What each action is called, where it runs, and which fields it needs. The
// Control Center builds its editors from these tables instead of if-chains.
import { formatCombo, isMacLike } from "./keys.ts"
import type { ActionType, FaderTarget, Step, StepTextField } from "./types.ts"

export type ActionGroup = "OBS" | "This computer" | "This tablet" | "Other"

export interface ActionMeta { label: string; group: ActionGroup; hint: string }

export const ACTION_META: Readonly<Record<ActionType, ActionMeta>> = {
  obs_scene: { label: "Switch scene", group: "OBS", hint: "Make an OBS scene the live program scene." },
  obs_toggle_source: { label: "Show / hide source", group: "OBS", hint: "Toggle one source's visibility inside a scene." },
  obs_toggle_mute: { label: "Mute / unmute input", group: "OBS", hint: "Toggle mute on a single OBS audio input." },
  obs_start_stop_stream: { label: "Start / stop stream", group: "OBS", hint: "Go live, or end the stream if it is already running." },
  obs_toggle_record: { label: "Start / stop recording", group: "OBS", hint: "Begin recording, or stop and save the current take." },
  open_url: { label: "Open link on computer", group: "This computer", hint: "Opens in the default browser on the machine running the companion." },
  launch_app: { label: "Launch an app", group: "This computer", hint: "Starts an application on the machine running the companion." },
  play_sound: { label: "Play a sound", group: "This computer", hint: "Plays through the computer's audio output, not the tablet's." },
  hotkey: { label: "Key combination", group: "This computer", hint: "Presses keys on this computer as if typed, for an OBS hotkey or any app's shortcut. They go to whatever is in front, so global hotkeys work best." },
  browser_tile: { label: "Open link on the tablet", group: "This tablet", hint: "Opens a site in the tablet's own browser, for chat or a dashboard." },
  none: { label: "Do nothing", group: "Other", hint: "A spacer or a label-only tile." }
}

export const ACTION_TYPES = Object.keys(ACTION_META) as ActionType[]
export const ACTION_GROUPS: readonly ActionGroup[] = ["OBS", "This computer", "This tablet", "Other"]

export const isActionType = (value: unknown): value is ActionType => typeof value === "string" && Object.prototype.hasOwnProperty.call(ACTION_META, value)

/** Actions whose on/off state the companion reports back, so a tile can show it. */
export const STATEFUL_ACTIONS: readonly ActionType[] = ["obs_toggle_mute", "obs_start_stop_stream", "obs_toggle_record", "obs_toggle_source"]

export interface FieldSpec { key: StepTextField; label: string; placeholder: string }

export const ACTION_FIELDS: Readonly<Partial<Record<ActionType, readonly FieldSpec[]>>> = {
  obs_scene: [{ key: "sceneName", label: "Scene name", placeholder: "Exact OBS scene name" }],
  obs_toggle_source: [
    { key: "sceneName", label: "Scene name", placeholder: "Exact OBS scene name" },
    { key: "sourceName", label: "Source name", placeholder: "Exact OBS source name" }
  ],
  obs_toggle_mute: [{ key: "sourceName", label: "Input name", placeholder: "Exact OBS input name" }],
  open_url: [{ key: "url", label: "Link", placeholder: "example.com" }],
  browser_tile: [{ key: "url", label: "Link", placeholder: "example.com" }]
}

/** Reads a text field from any step; undefined when that step type has none. */
export function stepText(step: Step, key: StepTextField): string | undefined {
  const value = (step as Partial<Record<StepTextField, unknown>>)[key]
  return typeof value === "string" ? value : undefined
}

/** One-line description of a step, for collapsed step lists and screen readers. */
export function stepSummary(step: Step | undefined): string {
  if (!step) return "Empty step"
  const meta = ACTION_META[step.type]
  const detail = step.type === "launch_app" ? step.appName || step.appPath || ""
    : stepText(step, "sceneName") || stepText(step, "sourceName") || stepText(step, "url") ||
      (step.type === "play_sound" ? `Sound ${step.soundId ?? 1}` : step.type === "hotkey" ? formatCombo(step.keys, isMacLike()) : "")
  return detail ? `${meta.label} · ${detail}` : meta.label
}

export interface FaderTargetMeta { label: string; hint: string }

export const FADER_TARGETS: Readonly<Record<FaderTarget, FaderTargetMeta>> = {
  obs_input: { label: "OBS input volume", hint: "The volume of one OBS audio source, on the same curve as OBS's own mixer." },
  sounds: { label: "Punchboard sounds volume", hint: "How loud Play a sound buttons are on this computer." },
  system: { label: "This computer's volume", hint: "The main output volume. macOS only for now." }
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
