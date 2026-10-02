// The deck model, shared by the server, the Control Center and the deck.
// Everything that reaches disk or the network is one of these shapes.

// ------------------------------------------------------------------ steps

export type ActionType =
  | "obs_scene"
  | "obs_toggle_source"
  | "obs_toggle_mute"
  | "obs_start_stop_stream"
  | "obs_toggle_record"
  | "obs_toggle_filter"
  | "obs_toggle_virtualcam"
  | "obs_save_replay"
  | "obs_studio_transition"
  | "open_url"
  | "launch_app"
  | "play_sound"
  | "hotkey"
  | "media_key"
  | "stop_sounds"
  | "browser_tile"
  | "go_to_deck"
  | "none"

/** What an on/off step does: flip the state, or set it whatever it was.
    Absent means "toggle". A macro wants "on" or "off", so it does the same
    thing every time. */
export type SetMode = "toggle" | "on" | "off"

interface StepBase {
  id: string
  /** Wait before this step runs, 0..60000 ms. */
  delayMs: number
  /** Control Center only: whether the step's editor is expanded. Never saved. */
  open?: boolean
}

export interface SceneStep extends StepBase { type: "obs_scene"; sceneName?: string }
export interface SourceStep extends StepBase { type: "obs_toggle_source"; sceneName?: string; sourceName?: string; set?: SetMode }
export interface MuteStep extends StepBase { type: "obs_toggle_mute"; sourceName?: string; set?: SetMode }
export interface StreamStep extends StepBase { type: "obs_start_stop_stream"; set?: SetMode }
export interface RecordStep extends StepBase { type: "obs_toggle_record"; set?: SetMode }
export interface FilterStep extends StepBase { type: "obs_toggle_filter"; sourceName?: string; filterName?: string; set?: SetMode }
export interface VirtualcamStep extends StepBase { type: "obs_toggle_virtualcam"; set?: SetMode }
export interface ReplayStep extends StepBase { type: "obs_save_replay" }
export interface StudioTransitionStep extends StepBase { type: "obs_studio_transition" }
export interface OpenUrlStep extends StepBase { type: "open_url"; url?: string }
export interface TabletLinkStep extends StepBase { type: "browser_tile"; url?: string }
/** `appName` is what the picker showed; `appPath` is what gets launched. */
export interface LaunchAppStep extends StepBase { type: "launch_app"; appPath?: string; appName?: string }
export interface SoundStep extends StepBase { type: "play_sound"; soundId?: number }
/** `keys` is a canonical combination such as "ctrl+shift+k" (see keys.ts). */
export interface HotkeyStep extends StepBase { type: "hotkey"; keys?: string }
/** The music keys a keyboard has, sent to whatever app is playing. */
export type MediaKey = "play_pause" | "next" | "previous"
export interface MediaKeyStep extends StepBase { type: "media_key"; mediaKey?: MediaKey }
export interface StopSoundsStep extends StepBase { type: "stop_sounds" }
/** Switches the device that pressed it to another deck (profile). */
export interface GoToDeckStep extends StepBase { type: "go_to_deck"; profileId?: string }
export interface NoopStep extends StepBase { type: "none" }

/** One action in a button's macro. The fields present depend on `type`. */
export type Step =
  | SceneStep
  | SourceStep
  | MuteStep
  | StreamStep
  | RecordStep
  | FilterStep
  | VirtualcamStep
  | ReplayStep
  | StudioTransitionStep
  | OpenUrlStep
  | TabletLinkStep
  | LaunchAppStep
  | SoundStep
  | HotkeyStep
  | MediaKeyStep
  | StopSoundsStep
  | GoToDeckStep
  | NoopStep

/** The free-text fields a step can carry, edited through ACTION_FIELDS. */
export type StepTextField = "sceneName" | "sourceName" | "filterName" | "url" | "appPath"

// ---------------------------------------------------------------- buttons

/** A preset colour, or any colour as #rrggbb. */
export type ButtonColor = ButtonColorId | HexColor
export type HexColor = `#${string}`

export type ButtonColorId =
  | "accent" | "blue" | "indigo" | "violet" | "pink" | "rose" | "red" | "orange"
  | "amber" | "yellow" | "lime" | "green" | "mint" | "cyan" | "slate" | "white"

export type FaderTarget = "obs_input" | "sounds" | "system" | "app"

export interface Fader {
  target: FaderTarget
  /** OBS input name; only used when target is "obs_input". */
  inputName: string
  /** The application whose volume it sets, when target is "app": on Windows
      the process name without .exe, lower-cased ("chrome", "spotify"); on a
      Mac "music" or "spotify". Kept when the target changes, like inputName. */
  app?: string
  /** The app's name as the picker showed it ("Google Chrome"), so the
      Control Center and error messages can name an app that is not running. */
  appName?: string
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
  color: ButtonColor
  /** A custom uploaded image as a data: URI. */
  iconData?: string | null
  glyph?: Glyph
  /** For a button that lights up (mute, record, a two-state macro…): the icon
      it shows while on, such as a crossed-out microphone while muted. */
  onGlyph?: Glyph
  /** Kept on faders too, so switching back to a button restores its macro. */
  steps: Step[]
  /** Present on a two-state macro (Stream Deck's "multi action switch"): the
      first press runs `steps` and leaves the button on, the next runs these
      and turns it off. */
  offSteps?: Step[]
}

export interface PressButton extends ButtonBase { control: "press" }
export interface FaderButton extends ButtonBase { control: "fader"; fader: Fader }

export type Button = PressButton | FaderButton

// --------------------------------------------------------------- library

/** A deck that is one big trackpad for this computer's mouse instead of buttons. */
export interface TrackpadSettings {
  /** Cursor speed, 0.5..3. */
  speed: number
  /** Content follows the fingers, as on a Mac. Off: the classic wheel direction. */
  naturalScroll: boolean
  /** "gesture": a real trackpad pinch, zooming the way the app does it (a map,
      a photo, a page without reflowing). "keys": Cmd/Ctrl + and −, for apps
      that ignore the gesture. */
  pinchZoom: PinchZoom
}

export type PinchZoom = "gesture" | "keys"

export interface Profile {
  id: string
  name: string
  /** Kept in the Control Center but not offered on devices: no tab, though a
      "Go to another deck" button still opens it (a folder). */
  hidden?: boolean
  /** Present on a trackpad deck. Its buttons, if any, are kept for switching back. */
  trackpad?: TrackpadSettings
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

export type ThemeId = "studio" | "hardware" | "hardware-dark" | "broadcast"
