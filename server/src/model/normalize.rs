//! Creating, reading and repairing decks. Anything read from disk, a backup
//! file or the network goes through `normalize_library`, which turns unknown
//! input into a valid Library or fills in safe defaults.
//! (src/shared/model.ts)
//!
//! The input is whatever JSON held, so the reading is done on
//! `serde_json::Value` with JavaScript's own conversions (js.rs): a deck
//! file has to come out of here exactly as it came out of the TypeScript.
use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::{Map, Value};

use super::actions::{action_type, fader_target, media_key, set_mode, LIMITS};
use super::colors::button_color;
use super::default_glyphs::{
    default_fader_glyph, default_press_glyph, DEFAULT_FADER_GLYPH_NAME, DEFAULT_PRESS_GLYPH_NAME,
};
use super::icons::{is_icon_id, is_safe_icon_data, safe_glyph, DEFAULT_ICON};
use super::ids::Ids;
use super::js;
use super::keys::{combo_to_string, parse_combo_value};
use super::types::{
    Action, ActionType, Button, ButtonColor, ButtonColorId, Control, Fader, FaderTarget, Library,
    PinchZoom, Profile, SetMode, Step, TrackpadSettings,
};
use crate::translate::Translate;

type Fields = Map<String, Value>;

/// The object in `raw`, or an empty one: arrays, text and null have no fields.
fn record(raw: &Value) -> Cow<'_, Fields> {
    raw.as_object().map(Cow::Borrowed).unwrap_or_default()
}

/// A field that holds text.
fn text(fields: &Fields, key: &str) -> Option<String> {
    fields.get(key).and_then(Value::as_str).map(str::to_string)
}

/// A field that holds text with something in it (`text(x) || …`).
fn filled(fields: &Fields, key: &str) -> Option<String> {
    text(fields, key).filter(|value| !value.is_empty())
}

/// `Number(fields[key])`: a field that is not there is NaN, not null's 0.
fn number(fields: &Fields, key: &str) -> f64 {
    fields.get(key).map_or(f64::NAN, js::to_number)
}

/// `value || fallback` for numbers: 0 and NaN are the fallback.
fn or(value: f64, fallback: f64) -> f64 {
    if value == 0.0 || value.is_nan() {
        fallback
    } else {
        value
    }
}

// -------------------------------------------------------------------- steps

/// A delay as stored: `Number(value) || 0`, held to 0..LIMITS.max_delay_ms.
pub fn clamp_delay(value: Option<&Value>) -> f64 {
    js::clamp(
        or(value.map_or(f64::NAN, js::to_number), 0.0),
        0.0,
        f64::from(LIMITS.max_delay_ms),
    )
}

/// Builds a step of one type, keeping only the fields that type uses.
pub fn make_step(action: ActionType, fields: &Map<String, Value>, ids: &Ids) -> Step {
    let id = filled(fields, "id").unwrap_or_else(|| ids.next_id("step"));
    let delay_ms = clamp_delay(fields.get("delayMs"));
    // "toggle" is the default, so it is left out rather than stored.
    let set = fields
        .get("set")
        .and_then(set_mode)
        .filter(|mode| *mode != SetMode::Toggle);
    let action = match action {
        ActionType::ObsScene => Action::ObsScene {
            scene_name: text(fields, "sceneName"),
        },
        ActionType::ObsToggleSource => Action::ObsToggleSource {
            scene_name: text(fields, "sceneName"),
            source_name: text(fields, "sourceName"),
            set,
        },
        ActionType::ObsToggleMute => Action::ObsToggleMute {
            source_name: text(fields, "sourceName"),
            set,
        },
        ActionType::ObsStartStopStream => Action::ObsStartStopStream { set },
        ActionType::ObsToggleRecord => Action::ObsToggleRecord { set },
        ActionType::ObsToggleFilter => Action::ObsToggleFilter {
            source_name: text(fields, "sourceName"),
            filter_name: text(fields, "filterName"),
            set,
        },
        ActionType::ObsToggleVirtualcam => Action::ObsToggleVirtualcam { set },
        ActionType::ObsSaveReplay => Action::ObsSaveReplay,
        ActionType::ObsStudioTransition => Action::ObsStudioTransition,
        ActionType::OpenUrl => Action::OpenUrl {
            url: text(fields, "url"),
        },
        ActionType::BrowserTile => Action::BrowserTile {
            url: text(fields, "url"),
        },
        ActionType::LaunchApp => Action::LaunchApp {
            app_path: text(fields, "appPath"),
            app_name: text(fields, "appName"),
        },
        ActionType::PlaySound => {
            let sound_id = number(fields, "soundId").floor();
            let known = sound_id >= 1.0 && sound_id <= f64::from(LIMITS.sound_slots);
            Action::PlaySound {
                sound_id: known.then_some(sound_id as u8),
            }
        }
        ActionType::Hotkey => {
            // Stored in the one canonical spelling ("ctrl+shift+k"), whatever order it came in.
            let combo = fields.get("keys").and_then(parse_combo_value);
            Action::Hotkey {
                keys: combo.as_ref().map(combo_to_string),
            }
        }
        ActionType::MediaKey => Action::MediaKey {
            media_key: Some(
                fields
                    .get("mediaKey")
                    .and_then(media_key)
                    .unwrap_or(super::types::MediaKey::PlayPause),
            ),
        },
        ActionType::StopSounds => Action::StopSounds,
        ActionType::GoToDeck => Action::GoToDeck {
            profile_id: text(fields, "profileId"),
        },
        ActionType::None => Action::None,
    };
    Step {
        id,
        delay_ms,
        action,
    }
}

/// A new step of one type, with nothing filled in.
pub fn create_step(action: ActionType, ids: &Ids) -> Step {
    make_step(action, &Map::new(), ids)
}

pub fn normalize_step(raw: &Value, ids: &Ids) -> Step {
    let fields = record(raw);
    let action = fields
        .get("type")
        .and_then(Value::as_str)
        .and_then(action_type)
        .unwrap_or(ActionType::None);
    make_step(action, &fields, ids)
}

/// Changes a step's action, keeping its id and delay and dropping fields that no longer apply.
pub fn retype_step(step: &Step, action: ActionType, ids: &Ids) -> Step {
    // The id rides in the fields, so an empty one is replaced as makeStep does it.
    let mut fields = Map::new();
    fields.insert("id".to_string(), Value::String(step.id.clone()));
    let mut kept = make_step(action, &fields, ids);
    kept.delay_ms = js::clamp(or(step.delay_ms, 0.0), 0.0, f64::from(LIMITS.max_delay_ms));
    kept
}

// ------------------------------------------------------------------ buttons

/// The longest app key kept. Process names are short; a longer one is not a
/// process anyone picked.
pub const APP_KEY_MAX: usize = 64;
const APP_NAME_MAX: usize = 80;

/// An app's key as stored: trimmed, lower-cased, without ".exe", and only
/// letters, digits, spaces and . _ + - (every Windows process name people
/// play sound from fits; quotes, slashes and control characters never reach
/// the volume helpers). None when nothing safe is left.
pub fn normalize_app_key(value: &Value) -> Option<String> {
    let lowered = js::trim(value.as_str()?).to_lowercase();
    let key = js::trim(lowered.strip_suffix(".exe").unwrap_or(&lowered));
    let first = key.bytes().next()?;
    let safe = (first.is_ascii_lowercase() || first.is_ascii_digit())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b" ._+-".contains(&b));
    (key.len() <= APP_KEY_MAX && safe).then(|| key.to_string())
}

/// An app's display name: one line, no control characters, not too long.
fn normalize_app_name(value: Option<&Value>) -> Option<String> {
    let given = value?.as_str()?;
    // Control characters become spaces, then every run of spaces is one.
    let mut line = String::new();
    let mut in_space = false;
    for c in given.chars() {
        if c <= '\u{1f}' || c == '\u{7f}' || js::is_space(c) {
            in_space = true;
            continue;
        }
        if in_space {
            line.push(' ');
        }
        in_space = false;
        line.push(c);
    }
    // A run at the start left one space, and one at the end none: the trim.
    let name = js::slice_utf16(js::trim(&line), APP_NAME_MAX);
    (!name.is_empty()).then(|| name.to_string())
}

fn normalize_fader(raw: Option<&Value>) -> Fader {
    let fields = raw.map(record).unwrap_or_default();
    let mut fader = Fader {
        target: fields
            .get("target")
            .and_then(fader_target)
            .unwrap_or(FaderTarget::Sounds),
        input_name: text(&fields, "inputName").unwrap_or_default(),
        app: None,
        app_name: None,
    };
    // The name only means something next to the app it names.
    if let Some(app) = fields.get("app").and_then(normalize_app_key) {
        fader.app = Some(app);
        fader.app_name = normalize_app_name(fields.get("appName"));
    }
    fader
}

/// The longest image data URI kept: LIMITS.max_icon_bytes of image, base64-encoded, plus its prefix.
const MAX_ICON_DATA_LENGTH: usize = LIMITS.max_icon_bytes.div_ceil(3) * 4 + 64;

fn normalize_steps(raw: &[Value], ids: &Ids) -> Vec<Step> {
    raw.iter()
        .take(LIMITS.max_steps)
        .map(|step| normalize_step(step, ids))
        .collect()
}

pub fn normalize_button(raw: &Value, ids: &Ids) -> Button {
    let fields = record(raw);
    // Older decks stored a single `action` per button; macros need a list.
    let none = serde_json::json!({ "type": "none" });
    let single = [fields
        .get("action")
        .filter(|action| !action.is_null())
        .unwrap_or(&none)
        .clone()];
    let raw_steps = match fields.get("steps").and_then(Value::as_array) {
        Some(steps) if !steps.is_empty() => steps.as_slice(),
        _ => &single,
    };
    // The id is made before the steps', so the counter runs as it does in TypeScript.
    let id = filled(&fields, "id").unwrap_or_else(|| ids.next_id("btn"));
    let steps = normalize_steps(raw_steps, ids);
    let off_steps = fields
        .get("offSteps")
        .and_then(Value::as_array)
        .map(|steps| normalize_steps(steps, ids));
    Button {
        id,
        slot: js::max(0.0, or(number(&fields, "slot"), 0.0).floor()),
        label: text(&fields, "label").unwrap_or_default(),
        icon: filled(&fields, "icon")
            .filter(|icon| is_icon_id(icon))
            .unwrap_or_else(|| DEFAULT_ICON.to_string()),
        color: fields
            .get("color")
            .and_then(button_color)
            .unwrap_or(ButtonColor::Preset(ButtonColorId::Accent)),
        steps,
        off_steps,
        icon_data: text(&fields, "iconData")
            .filter(|data| is_safe_icon_data(data) && data.len() <= MAX_ICON_DATA_LENGTH),
        glyph: fields.get("glyph").and_then(safe_glyph),
        on_glyph: fields.get("onGlyph").and_then(safe_glyph),
        control: if fields.get("control").and_then(Value::as_str) == Some("fader") {
            Control::Fader {
                fader: normalize_fader(fields.get("fader")),
            }
        } else {
            Control::Press
        },
    }
}

pub fn create_empty_button(slot: f64, ids: &Ids) -> Button {
    // The button's id first, then its step's.
    let id = ids.next_id("btn");
    Button {
        id,
        slot,
        label: String::new(),
        icon: DEFAULT_ICON.to_string(),
        color: ButtonColor::Preset(ButtonColorId::Accent),
        steps: vec![create_step(ActionType::None, ids)],
        off_steps: None,
        icon_data: None,
        glyph: Some(default_press_glyph()),
        on_glyph: None,
        control: Control::Press,
    }
}

/// Whether the button still shows the icon it was created with.
fn has_default_icon(button: &Button) -> bool {
    if button
        .icon_data
        .as_deref()
        .is_some_and(|data| !data.is_empty())
    {
        return false;
    }
    match &button.glyph {
        None => button.icon == DEFAULT_ICON,
        Some(glyph) => {
            glyph.name == DEFAULT_PRESS_GLYPH_NAME || glyph.name == DEFAULT_FADER_GLYPH_NAME
        }
    }
}

/// The same button as a fader (`fader` true) or a press button. Steps are kept either way.
pub fn with_control(button: &Button, fader: bool) -> Button {
    let mut next = button.clone();
    if fader {
        let settings = button.fader().cloned().unwrap_or(Fader {
            target: FaderTarget::Sounds,
            input_name: String::new(),
            app: None,
            app_name: None,
        });
        next.control = Control::Fader { fader: settings };
        if has_default_icon(button) {
            next.glyph = Some(default_fader_glyph());
        }
        return next;
    }
    // The fader settings cannot ride along: they live in the control.
    next.control = Control::Press;
    if button.glyph.is_some() && has_default_icon(button) {
        next.glyph = Some(default_press_glyph());
    }
    next
}

// ----------------------------------------------------------------- profiles

pub fn create_empty_profile(name: &str, ids: &Ids) -> Profile {
    Profile {
        id: ids.next_id("profile"),
        name: name.to_string(),
        columns: 4,
        rows: 3,
        buttons: Vec::new(),
        updated_at: Some(ids.now_iso()),
        trackpad: None,
        hidden: None,
    }
}

/// `clamp(Math.floor(Number(value)) || fallback, min, max)`.
fn grid_size(fields: &Fields, key: &str, fallback: u8, min: u8, max: u8) -> u8 {
    js::clamp(
        or(number(fields, key).floor(), f64::from(fallback)),
        f64::from(min),
        f64::from(max),
    ) as u8
}

fn normalize_profile(raw: &Value, t: &dyn Translate, ids: &Ids) -> Profile {
    let fields = record(raw);
    let id = filled(&fields, "id").unwrap_or_else(|| ids.next_id("profile"));
    let name = filled(&fields, "name").unwrap_or_else(|| t.t("shared.model.defaultDeckName", &[]));
    let buttons = fields
        .get("buttons")
        .and_then(Value::as_array)
        .map(|buttons| {
            buttons
                .iter()
                .map(|button| normalize_button(button, ids))
                .collect()
        });
    Profile {
        id,
        name,
        columns: grid_size(
            &fields,
            "columns",
            4,
            LIMITS.columns.min,
            LIMITS.columns.max,
        ),
        rows: grid_size(&fields, "rows", 3, LIMITS.rows.min, LIMITS.rows.max),
        buttons: buttons.unwrap_or_default(),
        updated_at: filled(&fields, "updatedAt"),
        trackpad: fields
            .get("trackpad")
            .filter(|trackpad| trackpad.is_object())
            .map(normalize_trackpad),
        hidden: (fields.get("hidden") == Some(&Value::Bool(true))).then_some(true),
    }
}

/// The decks devices offer as tabs: every deck not switched off.
pub fn shown_profiles(library: &Library) -> Vec<&Profile> {
    library
        .profiles
        .iter()
        .filter(|profile| profile.hidden != Some(true))
        .collect()
}

pub const TRACKPAD_SPEED_MIN: f64 = 0.5;
pub const TRACKPAD_SPEED_MAX: f64 = 3.0;
pub const DEFAULT_TRACKPAD: TrackpadSettings = TrackpadSettings {
    speed: 1.5,
    natural_scroll: true,
    pinch_zoom: PinchZoom::Gesture,
};

pub fn normalize_trackpad(raw: &Value) -> TrackpadSettings {
    let fields = record(raw);
    // Only a number counts: Number(null) and Number("") are 0, which is not a speed anyone chose.
    let speed = match fields.get("speed") {
        Some(given @ Value::Number(_)) => js::to_number(given),
        Some(Value::String(given)) if !js::trim(given).is_empty() => js::string_to_number(given),
        _ => f64::NAN,
    };
    TrackpadSettings {
        speed: if speed.is_finite() {
            js::clamp(speed, TRACKPAD_SPEED_MIN, TRACKPAD_SPEED_MAX)
        } else {
            DEFAULT_TRACKPAD.speed
        },
        natural_scroll: fields
            .get("naturalScroll")
            .and_then(Value::as_bool)
            .unwrap_or(DEFAULT_TRACKPAD.natural_scroll),
        pinch_zoom: if fields.get("pinchZoom").and_then(Value::as_str) == Some("keys") {
            PinchZoom::Keys
        } else {
            PinchZoom::Gesture
        },
    }
}

// ------------------------------------------------------------------ library

/// The minimum shape a file needs before it is worth normalizing as a deck.
pub fn is_library_shape(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    fields
        .get("version")
        .is_some_and(|version| version.is_number() && js::to_number(version) == 1.0)
        && fields.get("activeProfileId").is_some_and(Value::is_string)
        && fields.get("profiles").is_some_and(Value::is_array)
}

/// The ids seen so far. The TypeScript keeps them as the keys of a plain
/// object, and "__proto__" is not a key one can set that way: an id spelled
/// so is never remembered, so two of them are never told apart. Kept, so a
/// deck file reads the same in both companions.
#[derive(Default)]
struct Seen(HashSet<String>);

impl Seen {
    fn has(&self, id: &str) -> bool {
        self.0.contains(id)
    }

    fn add(&mut self, id: &str) {
        if id != "__proto__" {
            self.0.insert(id.to_string());
        }
    }
}

/// Makes every deck id and every button id unique, and gives every button a
/// slot of its own. A hand-edited file, an old bug or a merged backup can
/// repeat them, and a repeated one can never be pressed or edited: the first
/// one found always wins. The later one gets a new id, and the first free
/// slot, which is past the grid when the grid is full (the Control Center
/// offers those back).
fn repair_ids(profiles: &mut [Profile], ids: &Ids) {
    let mut profile_ids = Seen::default();
    // Across decks too: a two-state macro keeps its on/off by button id.
    let mut button_ids = Seen::default();
    for profile in profiles {
        if profile_ids.has(&profile.id) {
            profile.id = ids.next_id("profile");
        }
        profile_ids.add(&profile.id);
        // Slots are whole numbers (or Infinity), never NaN or -0: their bits tell them apart.
        let mut slots: HashSet<u64> = HashSet::new();
        let mut moved: Vec<usize> = Vec::new();
        for (at, button) in profile.buttons.iter_mut().enumerate() {
            if button_ids.has(&button.id) {
                button.id = ids.next_id("btn");
            }
            button_ids.add(&button.id);
            if !slots.insert(button.slot.to_bits()) {
                moved.push(at);
            }
        }
        let mut free = 0.0_f64;
        for at in moved {
            while slots.contains(&free.to_bits()) {
                free += 1.0;
            }
            profile.buttons[at].slot = free;
            slots.insert(free.to_bits());
        }
    }
}

pub fn normalize_library(raw: &Value, t: &dyn Translate, ids: &Ids) -> Library {
    let fields = record(raw);
    let mut profiles: Vec<Profile> = match fields.get("profiles").and_then(Value::as_array) {
        Some(profiles) => profiles
            .iter()
            .map(|profile| normalize_profile(profile, t, ids))
            .collect(),
        None => Vec::new(),
    };
    if profiles.is_empty() {
        profiles.push(create_empty_profile(
            &t.t("shared.model.defaultDeckName", &[]),
            ids,
        ));
    }
    repair_ids(&mut profiles, ids);
    let requested = text(&fields, "activeProfileId");
    let active_profile_id = match requested {
        Some(requested) if profiles.iter().any(|profile| profile.id == requested) => requested,
        _ => profiles[0].id.clone(),
    };
    Library {
        version: 1,
        active_profile_id,
        profiles,
    }
}

// ---------------------------------------------------------------- questions

/// Buttons whose slot sits outside the grid after it was shrunk.
pub fn parked_buttons(profile: &Profile) -> Vec<&Button> {
    let cells = f64::from(profile.rows) * f64::from(profile.columns);
    profile
        .buttons
        .iter()
        .filter(|button| button.slot >= cells)
        .collect()
}

fn does_something(steps: &[Step]) -> bool {
    steps.iter().any(|step| step.action != Action::None)
}

pub fn is_configured(button: &Button) -> bool {
    if let Some(fader) = button.fader() {
        return match fader.target {
            FaderTarget::ObsInput => !fader.input_name.is_empty(),
            FaderTarget::App => fader.app.as_deref().is_some_and(|app| !app.is_empty()),
            _ => true,
        };
    }
    does_something(&button.steps) || button.off_steps.as_deref().is_some_and(does_something)
}

/// The sound slot a single-step "Play a sound" button toggles, or 0. Those light up while playing.
pub fn sound_slot_of(button: &Button) -> u8 {
    if button.is_fader() || is_switch(button) || button.steps.len() != 1 {
        return 0;
    }
    match button.steps[0].action {
        Action::PlaySound { sound_id } => sound_id
            .filter(|id| *id != 0)
            .unwrap_or(1)
            .clamp(1, LIMITS.sound_slots),
        _ => 0,
    }
}

/// The name of the live state a step reads or changes, shared by every
/// button that touches the same thing: two buttons muting one mic light up
/// together, whichever deck they are on. None for steps without one.
pub fn state_key_of(step: &Step) -> Option<String> {
    fn filled(value: &Option<String>) -> Option<&str> {
        value.as_deref().filter(|text| !text.is_empty())
    }
    match &step.action {
        Action::ObsScene { scene_name } => filled(scene_name).map(|scene| format!("scene:{scene}")),
        Action::ObsToggleMute { source_name, .. } => {
            filled(source_name).map(|source| format!("mute:{source}"))
        }
        Action::ObsToggleSource {
            scene_name,
            source_name,
            ..
        } => Some(format!(
            "source:{}\n{}",
            filled(scene_name)?,
            filled(source_name)?
        )),
        Action::ObsToggleFilter {
            source_name,
            filter_name,
            ..
        } => Some(format!(
            "filter:{}\n{}",
            filled(source_name)?,
            filled(filter_name)?
        )),
        Action::ObsStartStopStream { .. } => Some("stream".to_string()),
        Action::ObsToggleRecord { .. } => Some("record".to_string()),
        Action::ObsToggleVirtualcam { .. } => Some("virtualcam".to_string()),
        Action::ObsSaveReplay => Some("replaybuffer".to_string()),
        _ => None,
    }
}

/// Whether a button is a two-state macro: press for `steps`, press again for `off_steps`.
pub fn is_switch(button: &Button) -> bool {
    !button.is_fader() && button.off_steps.is_some()
}

/// The state a button shows, or None: a two-state macro shows its own on/off,
/// a single step the state it acts on. A plain macro has no one state to show.
pub fn button_state_key(button: &Button) -> Option<String> {
    if button.is_fader() {
        return None;
    }
    if is_switch(button) {
        return Some(format!("switch:{}", button.id));
    }
    match button.steps.as_slice() {
        [only] => state_key_of(only),
        _ => None,
    }
}

/// Whether the deck can show this button's live on/off state.
pub fn is_stateful(button: &Button) -> bool {
    sound_slot_of(button) != 0 || button_state_key(button).is_some()
}

/// Two faders on the same target share one level; this is its key everywhere.
pub fn fader_level_key(fader: &Fader) -> String {
    match fader.target {
        FaderTarget::ObsInput => format!("obs:{}", fader.input_name),
        FaderTarget::App => format!("app:{}", fader.app.as_deref().unwrap_or("")),
        target => target.as_str().to_string(),
    }
}

/// A friendly name for an app fader's app: the saved name, or its key with a
/// capital ("spotify" reads "Spotify").
pub fn app_display_name(fader: &Fader, t: &dyn Translate) -> String {
    if let Some(name) = fader.app_name.as_deref().filter(|name| !name.is_empty()) {
        return name.to_string();
    }
    let key = fader.app.as_deref().unwrap_or("");
    let mut letters = key.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => t.t("shared.model.unnamedApp", &[]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{brief, cases, ids_of, same, same_text, EchoVars, Locale};
    use crate::translate::Keys;
    use serde_json::json;

    // ------------------------------------------------ against the TypeScript

    #[test]
    fn normalize_library_matches_the_typescript() {
        let all = cases("model-normalizeLibrary.json");
        assert!(all.len() >= 1000, "{} cases", all.len());
        for case in &all {
            let library = normalize_library(&case["input"], &EchoVars, &ids_of(case));
            // The same text, key for key: this is what is written to disk.
            same_text(
                &format!("normalizeLibrary({})", brief(&case["input"])),
                &library,
                &case["output"],
            );
            same(
                "isLibraryShape",
                &is_library_shape(&case["input"]),
                &case["shape"],
            );
        }
    }

    #[test]
    fn normalize_library_matches_the_typescript_in_each_language() {
        for code in ["en", "es"] {
            let locale = Locale::load(code);
            let all = cases(&format!("model-normalizeLibrary-{code}.json"));
            assert!(all.len() >= 30, "{} cases", all.len());
            for case in &all {
                let library = normalize_library(&case["input"], &locale, &ids_of(case));
                same_text(
                    &format!("normalizeLibrary({}) in {code}", brief(&case["input"])),
                    &library,
                    &case["output"],
                );
            }
        }
    }

    #[test]
    fn a_normalized_library_reads_back_as_itself() {
        // What Deserialize makes of a saved deck is what was saved.
        for case in cases("model-normalizeLibrary.json")
            .iter()
            .filter(|case| !case["output"].to_string().contains("null"))
        {
            let library: Library =
                serde_json::from_value(case["output"].clone()).expect("a library");
            same_text("a library read back", &library, &case["output"]);
        }
    }

    #[test]
    fn is_library_shape_matches_the_typescript() {
        let all = cases("model-isLibraryShape.json");
        assert!(all.len() >= 200, "{} cases", all.len());
        for case in &all {
            same(
                &format!("isLibraryShape({})", brief(&case["input"])),
                &is_library_shape(&case["input"]),
                &case["output"],
            );
        }
    }

    #[test]
    fn normalize_button_matches_the_typescript() {
        let all = cases("model-normalizeButton.json");
        assert!(all.len() >= 1000, "{} cases", all.len());
        for case in &all {
            let button = normalize_button(&case["input"], &ids_of(case));
            same_text(
                &format!("normalizeButton({})", brief(&case["input"])),
                &button,
                &case["output"],
            );
        }
    }

    #[test]
    fn normalize_step_matches_the_typescript() {
        let all = cases("model-normalizeStep.json");
        assert!(all.len() >= 1000, "{} cases", all.len());
        for case in &all {
            let step = normalize_step(&case["input"], &ids_of(case));
            same_text(
                &format!("normalizeStep({})", brief(&case["input"])),
                &step,
                &case["output"]["step"],
            );
            same(
                "clampDelay",
                &js_number(clamp_delay(case["input"].get("delayMs"))),
                &case["output"]["delay"],
            );
        }
    }

    /// A number as `JSON.stringify` writes it.
    fn js_number(number: f64) -> Value {
        #[derive(serde::Serialize)]
        struct Wrapped(#[serde(serialize_with = "js::serialize_number")] f64);
        serde_json::to_value(Wrapped(number)).expect("a number")
    }

    #[test]
    fn making_steps_matches_the_typescript() {
        let all = cases("model-makeStep.json");
        assert!(all.len() >= 300, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let action = action_type(input["type"].as_str().expect("a type")).expect("an action");
            let ids = ids_of(case);
            let made = make_step(action, input["fields"].as_object().expect("fields"), &ids);
            same_text(
                &format!("makeStep({})", brief(input)),
                &made,
                &case["output"]["made"],
            );
            // retypeStep, to every other action, keeps the id and the delay only.
            for (other, theirs) in case["output"]["retyped"].as_object().expect("retyped") {
                let retyped = retype_step(&made, action_type(other).expect("an action"), &ids);
                same_text(
                    &format!("retypeStep({}, {other})", brief(input)),
                    &retyped,
                    theirs,
                );
            }
        }
        for case in cases("model-createStep.json") {
            let action = action_type(case["input"].as_str().expect("a type")).expect("an action");
            same_text(
                "createStep",
                &create_step(action, &ids_of(&case)),
                &case["output"],
            );
        }
    }

    #[test]
    fn normalize_trackpad_matches_the_typescript() {
        let all = cases("model-normalizeTrackpad.json");
        assert!(all.len() >= 200, "{} cases", all.len());
        for case in &all {
            same_text(
                &format!("normalizeTrackpad({})", brief(&case["input"])),
                &normalize_trackpad(&case["input"]),
                &case["output"],
            );
        }
        let constants = &cases("model-constants.json")[0]["output"];
        same_text(
            "DEFAULT_TRACKPAD",
            &DEFAULT_TRACKPAD,
            &constants["DEFAULT_TRACKPAD"],
        );
        assert_eq!(
            constants["TRACKPAD_SPEED"]["min"].as_f64(),
            Some(TRACKPAD_SPEED_MIN)
        );
        assert_eq!(
            constants["TRACKPAD_SPEED"]["max"].as_f64(),
            Some(TRACKPAD_SPEED_MAX)
        );
        assert_eq!(constants["APP_KEY_MAX"], json!(APP_KEY_MAX));
    }

    #[test]
    fn normalize_app_key_matches_the_typescript() {
        let all = cases("model-normalizeAppKey.json");
        assert!(all.len() >= 200, "{} cases", all.len());
        for case in &all {
            same(
                &format!("normalizeAppKey({})", brief(&case["input"])),
                &normalize_app_key(&case["input"]),
                &case["output"],
            );
        }
    }

    #[test]
    fn button_questions_match_the_typescript() {
        let english = Locale::load("en");
        let all = cases("model-buttonQuestions.json");
        assert!(all.len() >= 1000, "{} cases", all.len());
        for case in &all {
            let name = brief(&case["input"]);
            let button: Button = serde_json::from_value(case["input"].clone()).expect("a button");
            let output = &case["output"];
            same(
                &format!("isConfigured({name})"),
                &is_configured(&button),
                &output["isConfigured"],
            );
            same(
                &format!("isSwitch({name})"),
                &is_switch(&button),
                &output["isSwitch"],
            );
            same(
                &format!("buttonStateKey({name})"),
                &button_state_key(&button),
                &output["buttonStateKey"],
            );
            same(
                &format!("soundSlotOf({name})"),
                &sound_slot_of(&button),
                &output["soundSlotOf"],
            );
            same(
                &format!("isStateful({name})"),
                &is_stateful(&button),
                &output["isStateful"],
            );
            let keys: Vec<Option<String>> = button.steps.iter().map(state_key_of).collect();
            same(&format!("stateKeyOf({name})"), &keys, &output["stateKeys"]);
            same(
                &format!("withControl({name}, fader)"),
                &with_control(&button, true),
                &output["asFader"],
            );
            same(
                &format!("withControl({name}, press)"),
                &with_control(&button, false),
                &output["asPress"],
            );
            if let Some(fader) = button.fader() {
                same(
                    &format!("faderLevelKey({name})"),
                    &fader_level_key(fader),
                    &output["faderLevelKey"],
                );
                same(
                    &format!("appDisplayName({name})"),
                    &app_display_name(fader, &EchoVars),
                    &output["appDisplayName"]["echo"],
                );
                same(
                    &format!("appDisplayName({name}) in English"),
                    &app_display_name(fader, &english),
                    &output["appDisplayName"]["en"],
                );
            }
        }
    }

    #[test]
    fn library_questions_match_the_typescript() {
        let all = cases("model-libraryQuestions.json");
        assert!(all.len() >= 100, "{} cases", all.len());
        for case in &all {
            let library: Library =
                serde_json::from_value(case["input"].clone()).expect("a library");
            let shown: Vec<&str> = shown_profiles(&library)
                .iter()
                .map(|profile| profile.id.as_str())
                .collect();
            same("shownProfiles", &shown, &case["output"]["shown"]);
            let parked: Vec<Vec<&str>> = library
                .profiles
                .iter()
                .map(|profile| {
                    parked_buttons(profile)
                        .iter()
                        .map(|button| button.id.as_str())
                        .collect()
                })
                .collect();
            same("parkedButtons", &parked, &case["output"]["parked"]);
        }
    }

    #[test]
    fn creating_matches_the_typescript() {
        for case in cases("model-createEmptyButton.json") {
            let slot = case["input"].as_f64().expect("a slot");
            same(
                "createEmptyButton",
                &create_empty_button(slot, &ids_of(&case)),
                &case["output"],
            );
        }
        for case in cases("model-createEmptyProfile.json") {
            let name = case["input"].as_str().expect("a name");
            same_text(
                "createEmptyProfile",
                &create_empty_profile(name, &ids_of(&case)),
                &case["output"],
            );
        }
    }

    // --------------------- the assertions of tests/library.test.mjs (unitChecks)

    fn ids() -> Ids {
        Ids::new(|| 1_750_000_000_000)
    }

    fn deck(name: &str, buttons: Value) -> Value {
        json!({ "id": name.to_lowercase(), "name": name, "columns": 4, "rows": 3, "buttons": buttons })
    }

    fn press(id: &str, slot: u32) -> Value {
        json!({ "id": id, "slot": slot, "label": id, "icon": "zap", "color": "accent", "control": "press", "steps": [{ "id": format!("s_{id}"), "type": "none", "delayMs": 0 }] })
    }

    fn with(mut value: Value, fields: Value) -> Value {
        for (key, field) in fields.as_object().expect("fields") {
            value[key] = field.clone();
        }
        value
    }

    fn library(profiles: Value, active: &str) -> Library {
        normalize_library(
            &json!({ "version": 1, "activeProfileId": active, "profiles": profiles }),
            &Keys,
            &ids(),
        )
    }

    #[test]
    fn repeated_ids_and_slots_are_repaired() {
        let repaired = library(
            json!([
                deck(
                    "One",
                    json!([press("x", 0), press("x", 1), press("y", 1), press("z", 2)])
                ),
                with(
                    deck("One", json!([])),
                    json!({ "name": "Copy", "buttons": [press("x", 0)] })
                )
            ]),
            "one",
        );
        // Repeated deck ids are made unique
        assert_eq!(repaired.profiles[0].id, "one");
        assert_ne!(repaired.profiles[1].id, "one");
        // Repeated button ids are made unique, across decks too
        let button_ids: Vec<&str> = repaired
            .profiles
            .iter()
            .flat_map(|profile| profile.buttons.iter().map(|button| button.id.as_str()))
            .collect();
        assert_eq!(
            button_ids.iter().collect::<HashSet<_>>().len(),
            button_ids.len()
        );
        assert_eq!(button_ids[0], "x");
        // Two buttons in one slot: the later one moves to a free slot
        let slots: Vec<f64> = repaired.profiles[0]
            .buttons
            .iter()
            .map(|button| button.slot)
            .collect();
        assert_eq!(slots, [0.0, 1.0, 3.0, 2.0]);
        // A repaired deck stays as it is
        let again = normalize_library(
            &serde_json::to_value(&repaired).expect("a library"),
            &Keys,
            &ids(),
        );
        assert_eq!(
            serde_json::to_string(&again).expect("text"),
            serde_json::to_string(&repaired).expect("text")
        );
    }

    #[test]
    fn with_the_grid_full_a_repeated_slot_is_parked_past_the_grid() {
        let full = library(
            json!([with(
                deck("F", json!([])),
                json!({ "columns": 2, "rows": 1, "buttons": [press("p", 0), press("q", 1), press("r", 1)] })
            )]),
            "f",
        );
        assert_eq!(full.profiles[0].buttons[2].slot, 2.0);
    }

    fn button(fields: Value) -> Button {
        library(
            json!([deck("D", json!([with(press("b", 0), fields)]))]),
            "d",
        )
        .profiles[0]
            .buttons[0]
            .clone()
    }

    fn step_of(fields: Value) -> Step {
        button(json!({ "steps": [with(json!({ "id": "s", "delayMs": 0 }), fields)] })).steps[0]
            .clone()
    }

    #[test]
    fn an_icon_named_constructor_falls_back_to_the_default() {
        assert_eq!(button(json!({ "icon": "constructor" })).icon, "radio");
        assert_eq!(button(json!({ "icon": "__proto__" })).icon, "radio");
        assert_eq!(button(json!({ "icon": "mic" })).icon, "mic");
    }

    #[test]
    fn sound_8_9_is_sound_8() {
        let sound = |id: Value| match step_of(json!({ "type": "play_sound", "soundId": id })).action
        {
            Action::PlaySound { sound_id } => sound_id,
            other => panic!("not a sound step: {other:?}"),
        };
        assert_eq!(sound(json!(8.9)), Some(8));
        assert_eq!(sound(json!(9)), None);
        assert_eq!(sound(json!(0.5)), None);
    }

    #[test]
    fn key_combinations_are_stored_in_their_canonical_form() {
        let keys = |typed: &str| match step_of(json!({ "type": "hotkey", "keys": typed })).action {
            Action::Hotkey { keys } => keys,
            other => panic!("not a key step: {other:?}"),
        };
        assert_eq!(keys("Shift + CTRL+K").as_deref(), Some("ctrl+shift+k"));
        assert_eq!(keys("ctrl+nope"), None);
    }

    #[test]
    fn a_picture_is_kept_within_the_size_limit_and_dropped_over_it() {
        let icon = |bytes: usize| {
            format!(
                "data:image/png;base64,{}",
                "A".repeat(bytes.div_ceil(3) * 4)
            )
        };
        assert!(button(json!({ "iconData": icon(700 * 1024) }))
            .icon_data
            .is_some());
        assert!(button(json!({ "iconData": icon(2 * 1024 * 1024) }))
            .icon_data
            .is_none());
    }

    #[test]
    fn a_missing_trackpad_speed_is_the_default_not_the_minimum() {
        let speed = |value: Option<Value>| {
            let trackpad = match value {
                Some(value) => json!({ "speed": value }),
                None => json!({}),
            };
            library(
                json!([with(deck("T", json!([])), json!({ "trackpad": trackpad }))]),
                "t",
            )
            .profiles[0]
                .trackpad
                .clone()
                .expect("a trackpad")
                .speed
        };
        assert_eq!(speed(Some(Value::Null)), 1.5);
        assert_eq!(speed(Some(json!(""))), 1.5);
        assert_eq!(speed(None), 1.5);
        assert_eq!(speed(Some(json!(2))), 2.0);
        assert_eq!(speed(Some(json!("2.5"))), 2.5);
        assert_eq!(speed(Some(json!(0))), 0.5);
    }

    #[test]
    fn a_library_without_a_version_is_still_normalized() {
        // tests/trackpad.test.mjs builds its decks this way.
        let made = normalize_library(
            &json!({ "activeProfileId": "pad", "profiles": [
                { "id": "pad", "name": "Pad", "columns": 3, "rows": 2, "buttons": [], "trackpad": { "speed": 2, "naturalScroll": true, "pinchZoom": "gesture" } },
                { "id": "keys", "name": "Keys", "columns": 3, "rows": 2, "buttons": [] }
            ] }),
            &Keys,
            &ids(),
        );
        assert_eq!(made.version, 1);
        assert_eq!(made.active_profile_id, "pad");
        assert_eq!(
            made.profiles[0].trackpad,
            Some(TrackpadSettings {
                speed: 2.0,
                natural_scroll: true,
                pinch_zoom: PinchZoom::Gesture
            })
        );
        assert_eq!(made.profiles[1].trackpad, None);
    }

    // ------------------------ the assertions of tests/app-volume.test.mjs (model)

    fn fader(fields: Value) -> Fader {
        let made = normalize_button(
            &json!({ "id": "f", "slot": 0, "label": "", "control": "fader", "steps": [], "fader": fields }),
            &ids(),
        );
        made.fader().cloned().expect("a fader")
    }

    #[test]
    fn app_faders_are_cleaned() {
        let chrome = fader(
            json!({ "target": "app", "app": "  Chrome.EXE ", "appName": " Google\nChrome  " }),
        );
        // An app key is trimmed, lower-cased and loses .exe
        assert_eq!(chrome.app.as_deref(), Some("chrome"));
        // An app name becomes one clean line
        assert_eq!(chrome.app_name.as_deref(), Some("Google Chrome"));
        // App faders keep their target
        assert_eq!(chrome.target, FaderTarget::App);
        // An app fader's level key is its own
        assert_eq!(fader_level_key(&chrome), "app:chrome");
        let obs = Fader {
            target: FaderTarget::ObsInput,
            input_name: "chrome".to_string(),
            app: None,
            app_name: None,
        };
        assert_eq!(fader_level_key(&obs), "obs:chrome");
        assert_eq!(app_display_name(&chrome, &Keys), "Google Chrome");
    }

    #[test]
    fn an_unsafe_app_key_is_dropped_and_its_name_with_it() {
        let long = "a".repeat(65);
        for (what, app) in [
            ("a path", json!("..\\evil")),
            ("quotes", json!("a\"b")),
            ("a line break", json!("a\nb")),
            ("nothing", json!("  ")),
            ("a number", json!(7)),
            ("65 letters", json!(long)),
            ("a leading dot", json!(".hidden")),
        ] {
            let result = fader(json!({ "target": "app", "app": app, "appName": "Something" }));
            assert!(
                result.app.is_none() && result.app_name.is_none(),
                "An app key with {what}: {result:?}"
            );
        }
    }

    #[test]
    fn spaces_dots_dashes_and_digits_are_kept() {
        assert_eq!(
            normalize_app_key(&json!("Battle.net Launcher-2")).as_deref(),
            Some("battle.net launcher-2")
        );
    }

    #[test]
    fn an_old_fader_comes_back_as_it_was_without_app_fields() {
        let old = fader(json!({ "target": "system", "inputName": "" }));
        assert_eq!(
            serde_json::to_string(&old).expect("text"),
            r#"{"target":"system","inputName":""}"#
        );
        // An unknown target still falls back to the sounds fader
        assert_eq!(
            fader(json!({ "target": "app_x" })).target,
            FaderTarget::Sounds
        );
    }

    #[test]
    fn an_app_fader_without_an_app_is_not_configured_yet() {
        let made = library(
            json!([{ "id": "p", "name": "P", "buttons": [
                { "id": "a", "slot": 0, "control": "fader", "fader": { "target": "app" }, "steps": [] },
                { "id": "b", "slot": 1, "control": "fader", "fader": { "target": "app", "app": "spotify" }, "steps": [] }
            ] }]),
            "p",
        );
        let (unset, spotify) = (&made.profiles[0].buttons[0], &made.profiles[0].buttons[1]);
        assert!(!is_configured(unset) && is_configured(spotify));
        // An app without a saved name is named from its key
        assert_eq!(
            app_display_name(spotify.fader().expect("a fader"), &Keys),
            "Spotify"
        );
    }

    #[test]
    fn the_libraries_of_the_app_volume_tests_normalize() {
        let apps = library(
            json!([{ "id": "p", "name": "P", "buttons": [
                { "id": "a", "slot": 0, "control": "fader", "fader": { "target": "app", "app": "spotify" }, "steps": [] },
                { "id": "b", "slot": 1, "control": "fader", "fader": { "target": "app", "app": "chrome" }, "steps": [] },
                { "id": "c", "slot": 2, "control": "fader", "fader": { "target": "app", "app": "chrome" }, "steps": [] }
            ] }]),
            "p",
        );
        let keys: Vec<String> = apps.profiles[0]
            .buttons
            .iter()
            .filter_map(Button::fader)
            .map(fader_level_key)
            .collect();
        assert_eq!(keys, ["app:spotify", "app:chrome", "app:chrome"]);
        assert!(
            library(json!([{ "id": "p", "name": "P", "buttons": [] }]), "p").profiles[0]
                .buttons
                .is_empty()
        );
    }
}
