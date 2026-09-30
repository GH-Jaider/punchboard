// The deck model, shared by the server, the Control Center and the deck.
// Everything that reaches disk or the network is one of these shapes.

// ------------------------------------------------------------------ steps

export type ActionType =
  | "obs_scene"
  | "obs_toggle_source"
  | "obs_toggle_mute"
  | "obs_start_stop_stream"
  | "obs_toggle_record"
  | "open_url"
  | "launch_app"
  | "play_sound"
  | "hotkey"
  | "browser_tile"
  | "none"

interface StepBase {
  id: string
  /** Wait before this step runs, 0..60000 ms. */
  delayMs: number
  /** Control Center only: whether the step's editor is expanded. Never saved. */
  open?: boolean
}

export interface SceneStep extends StepBase { type: "obs_scene"; sceneName?: string }
export interface SourceStep extends StepBase { type: "obs_toggle_source"; sceneName?: string; sourceName?: string }
export interface MuteStep extends StepBase { type: "obs_toggle_mute"; sourceName?: string }
export interface StreamStep extends StepBase { type: "obs_start_stop_stream" }
export interface RecordStep extends StepBase { type: "obs_toggle_record" }
export interface OpenUrlStep extends StepBase { type: "open_url"; url?: string }
export interface TabletLinkStep extends StepBase { type: "browser_tile"; url?: string }
export interface LaunchAppStep extends StepBase { type: "launch_app"; appPath?: string }
export interface SoundStep extends StepBase { type: "play_sound"; soundId?: number }
/** `keys` is a canonical combination such as "ctrl+shift+k" (see keys.ts). */
export interface HotkeyStep extends StepBase { type: "hotkey"; keys?: string }
export interface NoopStep extends StepBase { type: "none" }

/** One action in a button's macro. The fields present depend on `type`. */
export type Step =
  | SceneStep
  | SourceStep
  | MuteStep
  | StreamStep
  | RecordStep
  | OpenUrlStep
  | TabletLinkStep
  | LaunchAppStep
  | SoundStep
  | HotkeyStep
  | NoopStep

/** The free-text fields a step can carry, edited through ACTION_FIELDS. */
export type StepTextField = "sceneName" | "sourceName" | "url" | "appPath"

// ---------------------------------------------------------------- buttons

export type ButtonColorId =
  | "accent" | "blue" | "indigo" | "violet" | "pink" | "rose" | "red" | "orange"
  | "amber" | "yellow" | "lime" | "green" | "mint" | "cyan" | "slate" | "white"

export type FaderTarget = "obs_input" | "sounds" | "system"

export interface Fader {
  target: FaderTarget
  /** OBS input name; only used when target is "obs_input". */
  inputName: string
}

export type GlyphStyle = "outlined" | "rounded" | "sharp"

/** A Google Material Symbol stored as vector paths, so decks need no internet. */
export interface Glyph {
  source: "google"
  name: string
  style: GlyphStyle
  fill: boolean
  viewBox: string
  paths: string[]
}

interface ButtonBase {
  id: string
  /** Position in the grid, row-major from 0. May sit outside the grid ("parked"). */
  slot: number
  label: string
  /** A built-in icon id (see ICONS). Used when there is no glyph or image. */
  icon: string
  color: ButtonColorId
  /** A custom uploaded image as a data: URI. */
  iconData?: string | null
  glyph?: Glyph
  /** Kept on faders too, so switching back to a button restores its macro. */
  steps: Step[]
}

export interface PressButton extends ButtonBase { control: "press" }
export interface FaderButton extends ButtonBase { control: "fader"; fader: Fader }

export type Button = PressButton | FaderButton

// --------------------------------------------------------------- library

export interface Profile {
  id: string
  name: string
  /** 2..8 */
  columns: number
  /** 1..6 */
  rows: number
  buttons: Button[]
  updatedAt?: string
}

export interface Library {
  version: 1
  activeProfileId: string
  profiles: Profile[]
}

// ------------------------------------------------------------------ themes

export type ThemeId = "studio" | "hardware" | "broadcast"
