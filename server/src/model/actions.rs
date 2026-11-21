//! What each action is called, where it runs, and which fields it needs. The
//! Control Center builds its editors from these tables instead of if-chains.
//! (src/shared/actions.ts)
//!
//! Where the TypeScript tables hold a label that reads the page's language
//! when shown, there is a function here that takes the translator.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::keys::format_combo;
use super::types::{Action, ActionType, FaderTarget, MediaKey, SetMode, Step, StepTextField};
use crate::translate::{Translate, Var};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ActionGroup {
    #[serde(rename = "OBS")]
    Obs,
    #[serde(rename = "This computer")]
    Computer,
    #[serde(rename = "On the deck")]
    Deck,
    Other,
}

/// Every action, in the order the picker lists them (not the order of the
/// `ActionType` enum), with the group it belongs to.
const ACTION_META: [(ActionType, ActionGroup); 18] = [
    (ActionType::ObsScene, ActionGroup::Obs),
    (ActionType::ObsToggleSource, ActionGroup::Obs),
    (ActionType::ObsToggleMute, ActionGroup::Obs),
    (ActionType::ObsToggleFilter, ActionGroup::Obs),
    (ActionType::ObsStartStopStream, ActionGroup::Obs),
    (ActionType::ObsToggleRecord, ActionGroup::Obs),
    (ActionType::ObsToggleVirtualcam, ActionGroup::Obs),
    (ActionType::ObsSaveReplay, ActionGroup::Obs),
    (ActionType::ObsStudioTransition, ActionGroup::Obs),
    (ActionType::OpenUrl, ActionGroup::Computer),
    (ActionType::LaunchApp, ActionGroup::Computer),
    (ActionType::PlaySound, ActionGroup::Computer),
    (ActionType::StopSounds, ActionGroup::Computer),
    (ActionType::MediaKey, ActionGroup::Computer),
    (ActionType::Hotkey, ActionGroup::Computer),
    (ActionType::GoToDeck, ActionGroup::Deck),
    (ActionType::BrowserTile, ActionGroup::Deck),
    (ActionType::None, ActionGroup::Other),
];

/// `ACTION_TYPES`: every action, in the picker's order.
pub fn action_types() -> impl Iterator<Item = ActionType> {
    ACTION_META.iter().map(|meta| meta.0)
}

pub const ACTION_GROUPS: [ActionGroup; 4] = [
    ActionGroup::Obs,
    ActionGroup::Computer,
    ActionGroup::Deck,
    ActionGroup::Other,
];

/// `ACTION_META[type].group`.
pub fn action_group(action: ActionType) -> ActionGroup {
    ACTION_META
        .iter()
        .find(|meta| meta.0 == action)
        .map_or(ActionGroup::Other, |meta| meta.1)
}

/// `ACTION_META[type].label`.
pub fn action_label(action: ActionType, t: &dyn Translate) -> String {
    t.t(&format!("shared.action.{}.label", action.as_str()), &[])
}

/// `ACTION_META[type].hint`.
pub fn action_hint(action: ActionType, t: &dyn Translate) -> String {
    t.t(&format!("shared.action.{}.hint", action.as_str()), &[])
}

/// A group's name as the action picker shows it.
pub fn action_group_label(group: ActionGroup, t: &dyn Translate) -> String {
    let key = match group {
        ActionGroup::Obs => "obs",
        ActionGroup::Computer => "computer",
        ActionGroup::Deck => "deck",
        ActionGroup::Other => "other",
    };
    t.t(&format!("shared.actionGroup.{key}"), &[])
}

/// The action a stored name is, if it is one.
pub fn action_type(value: &str) -> Option<ActionType> {
    action_types().find(|action| action.as_str() == value)
}

/// `isActionType` on anything a deck file held.
pub fn is_action_type(value: &Value) -> bool {
    value.as_str().and_then(action_type).is_some()
}

/// Actions whose live state OBS reports, so a tile can light up with it.
pub const STATEFUL_ACTIONS: [ActionType; 8] = [
    ActionType::ObsScene,
    ActionType::ObsToggleMute,
    ActionType::ObsStartStopStream,
    ActionType::ObsToggleRecord,
    ActionType::ObsToggleSource,
    ActionType::ObsToggleFilter,
    ActionType::ObsToggleVirtualcam,
    ActionType::ObsSaveReplay,
];

/// The on/off actions: the keys of `SET_LABELS`, in its order.
pub const SET_ACTIONS: [ActionType; 6] = [
    ActionType::ObsToggleMute,
    ActionType::ObsToggleSource,
    ActionType::ObsToggleFilter,
    ActionType::ObsStartStopStream,
    ActionType::ObsToggleRecord,
    ActionType::ObsToggleVirtualcam,
];

/// `SET_LABELS[type][mode]`: how an on/off action words one of its three
/// modes. None for an action that has no modes.
pub fn set_label(action: ActionType, mode: SetMode, t: &dyn Translate) -> Option<String> {
    SET_ACTIONS.contains(&action).then(|| {
        t.t(
            &format!("shared.setMode.{}.{}", action.as_str(), mode.as_str()),
            &[],
        )
    })
}

pub const SET_MODES: [SetMode; 3] = [SetMode::Toggle, SetMode::On, SetMode::Off];

/// The mode a stored value is, if it is one.
pub fn set_mode(value: &Value) -> Option<SetMode> {
    let text = value.as_str()?;
    SET_MODES.into_iter().find(|mode| mode.as_str() == text)
}

pub fn is_set_mode(value: &Value) -> bool {
    set_mode(value).is_some()
}

/// A step's mode, for the actions that have one; None for the rest.
pub fn set_mode_of(step: &Step) -> Option<SetMode> {
    if !SET_ACTIONS.contains(&step.action_type()) {
        return None;
    }
    Some(step.action.set().unwrap_or(SetMode::Toggle))
}

pub const MEDIA_KEYS: [MediaKey; 3] = [MediaKey::PlayPause, MediaKey::Next, MediaKey::Previous];

/// `MEDIA_KEYS[key]`: a music key's name.
pub fn media_key_label(key: MediaKey, t: &dyn Translate) -> String {
    t.t(&format!("shared.mediaKey.{}", key.as_str()), &[])
}

/// The music key a stored value is, if it is one.
pub fn media_key(value: &Value) -> Option<MediaKey> {
    let text = value.as_str()?;
    MEDIA_KEYS.into_iter().find(|key| key.as_str() == text)
}

pub fn is_media_key(value: &Value) -> bool {
    media_key(value).is_some()
}

/// Which list of names from OBS a field picks from (see ObsNames).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObsPick {
    Scene,
    SceneItem,
    AudioInput,
    FilterSource,
    Filter,
}

/// A field of an action's editor. Its label and placeholder are read in the
/// reader's language: `field_label` and `field_placeholder`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FieldSpec {
    pub key: StepTextField,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pick: Option<ObsPick>,
}

const fn field(key: StepTextField, pick: ObsPick) -> FieldSpec {
    FieldSpec {
        key,
        pick: Some(pick),
    }
}

const URL_FIELD: [FieldSpec; 1] = [FieldSpec {
    key: StepTextField::Url,
    pick: None,
}];

/// `ACTION_FIELDS[type]`: the text fields an action's editor shows. Empty for
/// an action the TypeScript table has no entry for.
pub fn action_fields(action: ActionType) -> &'static [FieldSpec] {
    const SCENE: [FieldSpec; 1] = [field(StepTextField::SceneName, ObsPick::Scene)];
    const SOURCE: [FieldSpec; 2] = [
        field(StepTextField::SceneName, ObsPick::Scene),
        field(StepTextField::SourceName, ObsPick::SceneItem),
    ];
    const MUTE: [FieldSpec; 1] = [field(StepTextField::SourceName, ObsPick::AudioInput)];
    const FILTER: [FieldSpec; 2] = [
        field(StepTextField::SourceName, ObsPick::FilterSource),
        field(StepTextField::FilterName, ObsPick::Filter),
    ];
    match action {
        ActionType::ObsScene => &SCENE,
        ActionType::ObsToggleSource => &SOURCE,
        ActionType::ObsToggleMute => &MUTE,
        ActionType::ObsToggleFilter => &FILTER,
        ActionType::OpenUrl | ActionType::BrowserTile => &URL_FIELD,
        _ => &[],
    }
}

pub fn field_label(action: ActionType, key: StepTextField, t: &dyn Translate) -> String {
    t.t(
        &format!("shared.field.{}.{}.label", action.as_str(), key.as_str()),
        &[],
    )
}

pub fn field_placeholder(action: ActionType, key: StepTextField, t: &dyn Translate) -> String {
    t.t(
        &format!(
            "shared.field.{}.{}.placeholder",
            action.as_str(),
            key.as_str()
        ),
        &[],
    )
}

/// Reads a text field from any step; None when that step type has none.
pub fn step_text(step: &Step, key: StepTextField) -> Option<&str> {
    let value = match (&step.action, key) {
        (Action::ObsScene { scene_name }, StepTextField::SceneName) => scene_name,
        (Action::ObsToggleSource { scene_name, .. }, StepTextField::SceneName) => scene_name,
        (Action::ObsToggleSource { source_name, .. }, StepTextField::SourceName) => source_name,
        (Action::ObsToggleMute { source_name, .. }, StepTextField::SourceName) => source_name,
        (Action::ObsToggleFilter { source_name, .. }, StepTextField::SourceName) => source_name,
        (Action::ObsToggleFilter { filter_name, .. }, StepTextField::FilterName) => filter_name,
        (Action::OpenUrl { url }, StepTextField::Url) => url,
        (Action::BrowserTile { url }, StepTextField::Url) => url,
        (Action::LaunchApp { app_path, .. }, StepTextField::AppPath) => app_path,
        _ => return None,
    };
    value.as_deref()
}

/// A text that is there and not empty, as `value || …` reads it.
fn filled(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|text| !text.is_empty())
}

// A step only stores a deck's id; whoever shows summaries knows the names.
// The TypeScript is told once (nameDecksWith); here the lookup is handed in.

fn step_detail(
    step: &Step,
    mac: bool,
    deck_name: &dyn Fn(&str) -> Option<String>,
    t: &dyn Translate,
) -> String {
    match &step.action {
        Action::LaunchApp { app_path, app_name } => filled(app_name)
            .or(filled(app_path))
            .unwrap_or("")
            .to_string(),
        Action::PlaySound { sound_id } => t.t(
            "shared.step.sound",
            &[("number", Var::from(f64::from(sound_id.unwrap_or(1))))],
        ),
        Action::Hotkey { keys } => format_combo(keys.as_deref(), mac, t),
        Action::MediaKey { media_key } => media_key
            .map(|key| media_key_label(key, t))
            .unwrap_or_default(),
        Action::GoToDeck { profile_id } => filled(profile_id)
            .and_then(deck_name)
            .filter(|name| !name.is_empty())
            .unwrap_or_default(),
        Action::ObsToggleSource {
            scene_name,
            source_name,
            ..
        } => filled(source_name)
            .or(filled(scene_name))
            .unwrap_or("")
            .to_string(),
        Action::ObsToggleFilter {
            source_name,
            filter_name,
            ..
        } => match (filled(filter_name), filled(source_name)) {
            (Some(filter), Some(source)) => t.t(
                "shared.step.filterOn",
                &[("filter", Var::from(filter)), ("source", Var::from(source))],
            ),
            (Some(filter), None) => filter.to_string(),
            (None, source) => source.unwrap_or("").to_string(),
        },
        _ => [
            StepTextField::SceneName,
            StepTextField::SourceName,
            StepTextField::Url,
        ]
        .into_iter()
        .find_map(|key| step_text(step, key).filter(|text| !text.is_empty()))
        .unwrap_or("")
        .to_string(),
    }
}

/// One-line description of a step, for collapsed step lists and screen
/// readers. `mac` picks ⌘-style key labels; `deck_name` names a deck by id.
pub fn step_summary(
    step: Option<&Step>,
    mac: bool,
    deck_name: &dyn Fn(&str) -> Option<String>,
    t: &dyn Translate,
) -> String {
    let Some(step) = step else {
        return t.t("shared.step.empty", &[]);
    };
    let detail = step_detail(step, mac, deck_name, t);
    // "Mute · Mic" says more than "Mute / unmute input · Mic" once the mode is fixed.
    let fixed = set_mode_of(step)
        .filter(|mode| *mode != SetMode::Toggle)
        .and_then(|mode| set_label(step.action_type(), mode, t));
    let label = fixed.unwrap_or_else(|| action_label(step.action_type(), t));
    if detail.is_empty() {
        label
    } else {
        format!("{label} · {detail}")
    }
}

pub const FADER_TARGETS: [FaderTarget; 4] = [
    FaderTarget::ObsInput,
    FaderTarget::Sounds,
    FaderTarget::System,
    FaderTarget::App,
];

/// `FADER_TARGETS[target].label`.
pub fn fader_target_label(target: FaderTarget, t: &dyn Translate) -> String {
    t.t(&format!("shared.fader.{}.label", target.as_str()), &[])
}

/// `FADER_TARGETS[target].hint`.
pub fn fader_target_hint(target: FaderTarget, t: &dyn Translate) -> String {
    t.t(&format!("shared.fader.{}.hint", target.as_str()), &[])
}

/// The fader target a stored value is, if it is one.
pub fn fader_target(value: &Value) -> Option<FaderTarget> {
    let text = value.as_str()?;
    FADER_TARGETS
        .into_iter()
        .find(|target| target.as_str() == text)
}

pub fn is_fader_target(value: &Value) -> bool {
    fader_target(value).is_some()
}

pub struct Range {
    pub min: u8,
    pub max: u8,
}

pub struct Limits {
    pub max_steps: usize,
    pub max_delay_ms: u32,
    pub sound_slots: u8,
    pub max_sound_bytes: usize,
    pub max_icon_bytes: usize,
    pub columns: Range,
    pub rows: Range,
}

/// Limits enforced on both sides.
pub const LIMITS: Limits = Limits {
    max_steps: 12,
    max_delay_ms: 60000,
    sound_slots: 8,
    max_sound_bytes: 8 * 1024 * 1024,
    max_icon_bytes: 750 * 1024,
    columns: Range { min: 2, max: 8 },
    rows: Range { min: 1, max: 6 },
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{cases, same, EchoVars, Locale};
    use serde_json::json;

    #[test]
    fn validators_match_the_typescript() {
        let all = cases("actions-validators.json");
        assert!(all.len() >= 80, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let output = &case["output"];
            same(
                &format!("isActionType({input})"),
                &is_action_type(input),
                &output["isActionType"],
            );
            same(
                &format!("isSetMode({input})"),
                &is_set_mode(input),
                &output["isSetMode"],
            );
            same(
                &format!("isMediaKey({input})"),
                &is_media_key(input),
                &output["isMediaKey"],
            );
            same(
                &format!("isFaderTarget({input})"),
                &is_fader_target(input),
                &output["isFaderTarget"],
            );
            // What is accepted is stored under the same name.
            if let Some(action) = input.as_str().and_then(action_type) {
                same("an action as stored", &action, input);
            }
            if let Some(mode) = set_mode(input) {
                same("a mode as stored", &mode, input);
            }
            if let Some(key) = media_key(input) {
                same("a music key as stored", &key, input);
            }
            if let Some(target) = fader_target(input) {
                same("a fader target as stored", &target, input);
            }
        }
    }

    #[test]
    fn tables_match_the_typescript() {
        let english = Locale::load("en");
        let tables = &cases("actions-tables.json")[0]["output"];
        same(
            "ACTION_TYPES",
            &action_types().collect::<Vec<_>>(),
            &tables["ACTION_TYPES"],
        );
        same("ACTION_GROUPS", &ACTION_GROUPS, &tables["ACTION_GROUPS"]);
        same(
            "STATEFUL_ACTIONS",
            &STATEFUL_ACTIONS,
            &tables["STATEFUL_ACTIONS"],
        );
        same("SET_MODES", &SET_MODES, &tables["SET_MODES"]);
        same(
            "the keys of SET_LABELS",
            &SET_ACTIONS,
            &tables["SET_ACTIONS"],
        );
        same("the keys of MEDIA_KEYS", &MEDIA_KEYS, &tables["MEDIA_KEYS"]);
        same(
            "the keys of FADER_TARGETS",
            &FADER_TARGETS,
            &tables["FADER_TARGETS"],
        );
        let limits = json!({
            "maxSteps": LIMITS.max_steps, "maxDelayMs": LIMITS.max_delay_ms, "soundSlots": LIMITS.sound_slots,
            "maxSoundBytes": LIMITS.max_sound_bytes, "maxIconBytes": LIMITS.max_icon_bytes,
            "columns": { "min": LIMITS.columns.min, "max": LIMITS.columns.max },
            "rows": { "min": LIMITS.rows.min, "max": LIMITS.rows.max }
        });
        assert_eq!(limits, tables["LIMITS"]);

        for (words, translator) in [("echo", &EchoVars as &dyn Translate), ("en", &english)] {
            for action in action_types() {
                let theirs = &tables["actions"][action.as_str()];
                same("group", &action_group(action), &theirs["group"]);
                same(
                    "label",
                    &action_label(action, translator),
                    &theirs[words]["label"],
                );
                same(
                    "hint",
                    &action_hint(action, translator),
                    &theirs[words]["hint"],
                );
                let fields: Vec<Value> = action_fields(action)
                    .iter()
                    .map(|spec| {
                        let mut field = serde_json::to_value(spec).expect("a field");
                        field["label"] = json!(field_label(action, spec.key, translator));
                        field["placeholder"] =
                            json!(field_placeholder(action, spec.key, translator));
                        field
                    })
                    .collect();
                let expected = if theirs[words]["fields"].is_null() {
                    json!([])
                } else {
                    theirs[words]["fields"].clone()
                };
                assert_eq!(json!(fields), expected, "ACTION_FIELDS.{}", action.as_str());
                for mode in SET_MODES {
                    same(
                        "SET_LABELS",
                        &set_label(action, mode, translator),
                        &theirs[words]["set"][mode.as_str()],
                    );
                }
            }
            for group in ACTION_GROUPS {
                let name = serde_json::to_value(group).expect("a group");
                same(
                    "actionGroupLabel",
                    &action_group_label(group, translator),
                    &tables["groups"][name.as_str().expect("a name")][words],
                );
            }
            for key in MEDIA_KEYS {
                same(
                    "MEDIA_KEYS",
                    &media_key_label(key, translator),
                    &tables["mediaKeys"][key.as_str()][words],
                );
            }
            for target in FADER_TARGETS {
                same(
                    "fader label",
                    &fader_target_label(target, translator),
                    &tables["faderTargets"][target.as_str()][words]["label"],
                );
                same(
                    "fader hint",
                    &fader_target_hint(target, translator),
                    &tables["faderTargets"][target.as_str()][words]["hint"],
                );
            }
        }
    }

    #[test]
    fn step_questions_match_the_typescript() {
        let english = Locale::load("en");
        let all = cases("actions-steps.json");
        assert!(all.len() >= 300, "{} cases", all.len());
        // The generator names decks the same way.
        let deck_name = |id: &str| match id {
            "music" => Some("Music".to_string()),
            "empty" => Some(String::new()),
            _ => None,
        };
        for case in &all {
            let input = &case["input"];
            let output = &case["output"];
            let step: Option<Step> = serde_json::from_value(input.clone()).expect("a step or null");
            let Some(step) = step.as_ref() else {
                same(
                    "stepSummary()",
                    &step_summary(None, false, &deck_name, &EchoVars),
                    &output["summary"]["echo"],
                );
                same(
                    "stepSummary() on a Mac",
                    &step_summary(None, true, &deck_name, &EchoVars),
                    &output["summaryMac"]["echo"],
                );
                same(
                    "stepSummary() in English",
                    &step_summary(None, false, &deck_name, &english),
                    &output["summary"]["en"],
                );
                continue;
            };
            same(
                &format!("setModeOf({input})"),
                &set_mode_of(step),
                &output["setModeOf"],
            );
            for key in [
                StepTextField::SceneName,
                StepTextField::SourceName,
                StepTextField::FilterName,
                StepTextField::Url,
                StepTextField::AppPath,
            ] {
                same(
                    &format!("stepText({input}, {})", key.as_str()),
                    &step_text(step, key),
                    &output["stepText"][key.as_str()],
                );
            }
            for (name, mac) in [("summary", false), ("summaryMac", true)] {
                same(
                    &format!("stepSummary({input}) {name}"),
                    &step_summary(Some(step), mac, &deck_name, &EchoVars),
                    &output[name]["echo"],
                );
                same(
                    &format!("stepSummary({input}) {name} in English"),
                    &step_summary(Some(step), mac, &deck_name, &english),
                    &output[name]["en"],
                );
            }
        }
    }
}
