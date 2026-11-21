//! The deck model, shared by the server, the Control Center and the deck.
//! Everything that reaches disk or the network is one of these shapes.
//! (src/shared/types.ts)
//!
//! Each type serializes to exactly the JSON the TypeScript writes: the same
//! names, the same order, and an absent field where TypeScript has
//! `undefined`.
use serde::{Deserialize, Serialize};

use super::js;

// ------------------------------------------------------------------ steps

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    ObsScene,
    ObsToggleSource,
    ObsToggleMute,
    ObsStartStopStream,
    ObsToggleRecord,
    ObsToggleFilter,
    ObsToggleVirtualcam,
    ObsSaveReplay,
    ObsStudioTransition,
    OpenUrl,
    LaunchApp,
    PlaySound,
    Hotkey,
    MediaKey,
    StopSounds,
    BrowserTile,
    GoToDeck,
    None,
}

impl ActionType {
    /// The name stored in a deck file ("obs_toggle_mute").
    pub fn as_str(self) -> &'static str {
        match self {
            ActionType::ObsScene => "obs_scene",
            ActionType::ObsToggleSource => "obs_toggle_source",
            ActionType::ObsToggleMute => "obs_toggle_mute",
            ActionType::ObsStartStopStream => "obs_start_stop_stream",
            ActionType::ObsToggleRecord => "obs_toggle_record",
            ActionType::ObsToggleFilter => "obs_toggle_filter",
            ActionType::ObsToggleVirtualcam => "obs_toggle_virtualcam",
            ActionType::ObsSaveReplay => "obs_save_replay",
            ActionType::ObsStudioTransition => "obs_studio_transition",
            ActionType::OpenUrl => "open_url",
            ActionType::LaunchApp => "launch_app",
            ActionType::PlaySound => "play_sound",
            ActionType::Hotkey => "hotkey",
            ActionType::MediaKey => "media_key",
            ActionType::StopSounds => "stop_sounds",
            ActionType::BrowserTile => "browser_tile",
            ActionType::GoToDeck => "go_to_deck",
            ActionType::None => "none",
        }
    }
}

/// What an on/off step does: flip the state, or set it whatever it was.
/// Absent means "toggle". A macro wants "on" or "off", so it does the same
/// thing every time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetMode {
    Toggle,
    On,
    Off,
}

impl SetMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SetMode::Toggle => "toggle",
            SetMode::On => "on",
            SetMode::Off => "off",
        }
    }
}

/// The music keys a keyboard has, sent to whatever app is playing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKey {
    PlayPause,
    Next,
    Previous,
}

impl MediaKey {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKey::PlayPause => "play_pause",
            MediaKey::Next => "next",
            MediaKey::Previous => "previous",
        }
    }
}

/// One action in a button's macro.
///
/// The Control Center's `open` flag (whether the step's editor is expanded)
/// is never saved, so it has no field here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Step {
    pub id: String,
    /// Wait before this step runs, 0..60000 ms. Not always a whole number:
    /// the TypeScript keeps a fraction it is given.
    #[serde(
        rename = "delayMs",
        serialize_with = "js::serialize_number",
        deserialize_with = "js::deserialize_number"
    )]
    pub delay_ms: f64,
    /// What it does, with the fields that action uses. Written as `type`
    /// followed by those fields.
    #[serde(flatten)]
    pub action: Action,
}

impl Step {
    pub fn action_type(&self) -> ActionType {
        self.action.action_type()
    }
}

/// What a step does. The fields present depend on the action, as in the
/// TypeScript union.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    ObsScene {
        #[serde(rename = "sceneName", default, skip_serializing_if = "Option::is_none")]
        scene_name: Option<String>,
    },
    ObsToggleSource {
        #[serde(rename = "sceneName", default, skip_serializing_if = "Option::is_none")]
        scene_name: Option<String>,
        #[serde(
            rename = "sourceName",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<SetMode>,
    },
    ObsToggleMute {
        #[serde(
            rename = "sourceName",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<SetMode>,
    },
    ObsStartStopStream {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<SetMode>,
    },
    ObsToggleRecord {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<SetMode>,
    },
    ObsToggleFilter {
        #[serde(
            rename = "sourceName",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        source_name: Option<String>,
        #[serde(
            rename = "filterName",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        filter_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<SetMode>,
    },
    ObsToggleVirtualcam {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        set: Option<SetMode>,
    },
    ObsSaveReplay,
    ObsStudioTransition,
    OpenUrl {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// A link the tablet opens itself.
    BrowserTile {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// `app_name` is what the picker showed; `app_path` is what gets launched.
    LaunchApp {
        #[serde(rename = "appPath", default, skip_serializing_if = "Option::is_none")]
        app_path: Option<String>,
        #[serde(rename = "appName", default, skip_serializing_if = "Option::is_none")]
        app_name: Option<String>,
    },
    PlaySound {
        /// 1..LIMITS.sound_slots.
        #[serde(rename = "soundId", default, skip_serializing_if = "Option::is_none")]
        sound_id: Option<u8>,
    },
    /// `keys` is a canonical combination such as "ctrl+shift+k" (see keys.rs).
    Hotkey {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        keys: Option<String>,
    },
    MediaKey {
        #[serde(rename = "mediaKey", default, skip_serializing_if = "Option::is_none")]
        media_key: Option<MediaKey>,
    },
    StopSounds,
    /// Switches the device that pressed it to another deck (profile).
    GoToDeck {
        #[serde(rename = "profileId", default, skip_serializing_if = "Option::is_none")]
        profile_id: Option<String>,
    },
    None,
}

impl Action {
    pub fn action_type(&self) -> ActionType {
        match self {
            Action::ObsScene { .. } => ActionType::ObsScene,
            Action::ObsToggleSource { .. } => ActionType::ObsToggleSource,
            Action::ObsToggleMute { .. } => ActionType::ObsToggleMute,
            Action::ObsStartStopStream { .. } => ActionType::ObsStartStopStream,
            Action::ObsToggleRecord { .. } => ActionType::ObsToggleRecord,
            Action::ObsToggleFilter { .. } => ActionType::ObsToggleFilter,
            Action::ObsToggleVirtualcam { .. } => ActionType::ObsToggleVirtualcam,
            Action::ObsSaveReplay => ActionType::ObsSaveReplay,
            Action::ObsStudioTransition => ActionType::ObsStudioTransition,
            Action::OpenUrl { .. } => ActionType::OpenUrl,
            Action::BrowserTile { .. } => ActionType::BrowserTile,
            Action::LaunchApp { .. } => ActionType::LaunchApp,
            Action::PlaySound { .. } => ActionType::PlaySound,
            Action::Hotkey { .. } => ActionType::Hotkey,
            Action::MediaKey { .. } => ActionType::MediaKey,
            Action::StopSounds => ActionType::StopSounds,
            Action::GoToDeck { .. } => ActionType::GoToDeck,
            Action::None => ActionType::None,
        }
    }

    /// The step's on/off mode as stored: `None` where the TypeScript has no
    /// `set` field or leaves it undefined.
    pub fn set(&self) -> Option<SetMode> {
        match self {
            Action::ObsToggleSource { set, .. }
            | Action::ObsToggleMute { set, .. }
            | Action::ObsStartStopStream { set }
            | Action::ObsToggleRecord { set }
            | Action::ObsToggleFilter { set, .. }
            | Action::ObsToggleVirtualcam { set } => *set,
            _ => Option::None,
        }
    }
}

/// The free-text fields a step can carry, edited through ACTION_FIELDS.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StepTextField {
    SceneName,
    SourceName,
    FilterName,
    Url,
    AppPath,
}

impl StepTextField {
    pub fn as_str(self) -> &'static str {
        match self {
            StepTextField::SceneName => "sceneName",
            StepTextField::SourceName => "sourceName",
            StepTextField::FilterName => "filterName",
            StepTextField::Url => "url",
            StepTextField::AppPath => "appPath",
        }
    }
}

// ---------------------------------------------------------------- buttons

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonColorId {
    Accent,
    Blue,
    Indigo,
    Violet,
    Pink,
    Rose,
    Red,
    Orange,
    Amber,
    Yellow,
    Lime,
    Green,
    Mint,
    Cyan,
    Slate,
    White,
}

/// A preset colour, or any colour as #rrggbb (kept as typed, either case).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ButtonColor {
    Preset(ButtonColorId),
    Hex(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FaderTarget {
    ObsInput,
    Sounds,
    System,
    App,
}

impl FaderTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            FaderTarget::ObsInput => "obs_input",
            FaderTarget::Sounds => "sounds",
            FaderTarget::System => "system",
            FaderTarget::App => "app",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fader {
    pub target: FaderTarget,
    /// OBS input name; only used when target is "obs_input".
    #[serde(rename = "inputName")]
    pub input_name: String,
    /// The application whose volume it sets, when target is "app": on Windows
    /// the process name without .exe, lower-cased ("chrome", "spotify"); on a
    /// Mac "music" or "spotify". Kept when the target changes, like inputName.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// The app's name as the picker showed it ("Google Chrome"), so the
    /// Control Center and error messages can name an app that is not running.
    #[serde(rename = "appName", default, skip_serializing_if = "Option::is_none")]
    pub app_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlyphStyle {
    Outlined,
    Rounded,
    Sharp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlyphSource {
    Google,
}

/// A Google Material Symbol stored as vector paths, so decks need no internet.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Glyph {
    pub source: GlyphSource,
    pub name: String,
    pub style: GlyphStyle,
    pub fill: bool,
    #[serde(rename = "viewBox")]
    pub view_box: String,
    pub paths: Vec<String>,
}

/// A press button, or a fader with its settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "control", rename_all = "lowercase")]
pub enum Control {
    Press,
    Fader { fader: Fader },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Button {
    pub id: String,
    /// Position in the grid, row-major from 0. May sit outside the grid
    /// ("parked"). A whole number, but as large as a file says: the
    /// TypeScript keeps 1e300, and Infinity (written as null).
    #[serde(
        serialize_with = "js::serialize_number",
        deserialize_with = "js::deserialize_number"
    )]
    pub slot: f64,
    pub label: String,
    /// A built-in icon id (see ICONS). Used when there is no glyph or image.
    pub icon: String,
    pub color: ButtonColor,
    /// Kept on faders too, so switching back to a button restores its macro.
    pub steps: Vec<Step>,
    /// Present on a two-state macro (Stream Deck's "multi action switch"): the
    /// first press runs `steps` and leaves the button on, the next runs these
    /// and turns it off.
    #[serde(rename = "offSteps", default, skip_serializing_if = "Option::is_none")]
    pub off_steps: Option<Vec<Step>>,
    /// A custom uploaded image as a data: URI.
    #[serde(rename = "iconData", default, skip_serializing_if = "Option::is_none")]
    pub icon_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glyph: Option<Glyph>,
    /// For a button that lights up (mute, record, a two-state macro…): the icon
    /// it shows while on, such as a crossed-out microphone while muted.
    #[serde(rename = "onGlyph", default, skip_serializing_if = "Option::is_none")]
    pub on_glyph: Option<Glyph>,
    /// Written as `control`, then `fader` on a fader.
    #[serde(flatten)]
    pub control: Control,
}

impl Button {
    /// The fader's settings, on a fader.
    pub fn fader(&self) -> Option<&Fader> {
        match &self.control {
            Control::Fader { fader } => Some(fader),
            Control::Press => None,
        }
    }

    pub fn is_fader(&self) -> bool {
        matches!(self.control, Control::Fader { .. })
    }
}

// --------------------------------------------------------------- library

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PinchZoom {
    Gesture,
    Keys,
}

/// A deck that is one big trackpad for this computer's mouse instead of buttons.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrackpadSettings {
    /// Cursor speed, 0.5..3.
    #[serde(
        serialize_with = "js::serialize_number",
        deserialize_with = "js::deserialize_number"
    )]
    pub speed: f64,
    /// Content follows the fingers, as on a Mac. Off: the classic wheel direction.
    #[serde(rename = "naturalScroll")]
    pub natural_scroll: bool,
    /// "gesture": a real trackpad pinch, zooming the way the app does it (a map,
    /// a photo, a page without reflowing). "keys": Cmd/Ctrl + and −, for apps
    /// that ignore the gesture.
    #[serde(rename = "pinchZoom")]
    pub pinch_zoom: PinchZoom,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// 2..8
    pub columns: u8,
    /// 1..6
    pub rows: u8,
    pub buttons: Vec<Button>,
    #[serde(rename = "updatedAt", default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Present on a trackpad deck. Its buttons, if any, are kept for switching back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trackpad: Option<TrackpadSettings>,
    /// Kept in the Control Center but not offered on devices: no tab, though a
    /// "Go to another deck" button still opens it (a folder). Only ever
    /// absent or true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Library {
    /// Always 1.
    pub version: u8,
    #[serde(rename = "activeProfileId")]
    pub active_profile_id: String,
    pub profiles: Vec<Profile>,
}

// ------------------------------------------------------------------ themes

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeId {
    Studio,
    Hardware,
    HardwareDark,
    Broadcast,
}
