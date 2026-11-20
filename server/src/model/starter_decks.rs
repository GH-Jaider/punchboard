//! Ready-made decks, so Punchboard does something the moment a device pairs:
//! a fresh install starts with them, and the Control Center's + offers them
//! again. They only use what exists on any computer: OBS's default inputs
//! (Mic/Aux and Desktop Audio), the built-in sounds, music keys and everyday
//! shortcuts, with Cmd on a Mac and Ctrl elsewhere.
//! (src/shared/starter-decks.ts)
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::ids::Ids;
use super::normalize::{make_step, DEFAULT_TRACKPAD};
use super::starter_glyphs::starter_glyph;
use super::types::{
    ActionType, Button, ButtonColor, ButtonColorId, Control, Fader, FaderTarget, Profile, Step,
};
use crate::translate::Translate;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StarterId {
    Streaming,
    Music,
    Shortcuts,
    Trackpad,
}

impl StarterId {
    pub fn as_str(self) -> &'static str {
        match self {
            StarterId::Streaming => "streaming",
            StarterId::Music => "music",
            StarterId::Shortcuts => "shortcuts",
            StarterId::Trackpad => "trackpad",
        }
    }
}

pub const STARTER_IDS: [StarterId; 4] = [
    StarterId::Streaming,
    StarterId::Music,
    StarterId::Shortcuts,
    StarterId::Trackpad,
];

/// `STARTERS[id].label`: a starter's entry in the + menu.
pub fn starter_label(id: StarterId, t: &dyn Translate) -> String {
    t.t(&format!("shared.starter.{}.label", id.as_str()), &[])
}

/// `STARTERS[id].hint`.
pub fn starter_hint(id: StarterId, t: &dyn Translate) -> String {
    t.t(&format!("shared.starter.{}.hint", id.as_str()), &[])
}

/// OBS names its default audio inputs these on every new install.
const MIC: &str = "Mic/Aux";
const DESKTOP: &str = "Desktop Audio";

/// Makes one deck's buttons: the words, the ids, and the next free slot.
struct Maker<'a> {
    /// "shared.starter.<deck>.button."
    prefix: String,
    t: &'a dyn Translate,
    ids: &'a Ids,
    buttons: Vec<Button>,
}

impl Maker<'_> {
    fn new<'a>(id: StarterId, t: &'a dyn Translate, ids: &'a Ids) -> Maker<'a> {
        Maker {
            prefix: format!("shared.starter.{}.button.", id.as_str()),
            t,
            ids,
            buttons: Vec::new(),
        }
    }

    fn button(
        &mut self,
        label: &str,
        icon: &str,
        color: ButtonColorId,
        control: Control,
        steps: &[(ActionType, Value)],
    ) {
        // The button's id is made before its steps', as in the TypeScript.
        let id = self.ids.next_id("btn");
        let none = Map::new();
        let steps: Vec<Step> = steps
            .iter()
            .map(|(action, fields)| {
                make_step(*action, fields.as_object().unwrap_or(&none), self.ids)
            })
            .collect();
        self.buttons.push(Button {
            id,
            slot: self.buttons.len() as f64,
            label: self.t.t(&format!("{}{label}", self.prefix), &[]),
            icon: "zap".to_string(),
            color: ButtonColor::Preset(color),
            steps,
            off_steps: None,
            icon_data: None,
            glyph: starter_glyph(icon),
            on_glyph: None,
            control,
        });
    }

    fn press(
        &mut self,
        label: &str,
        icon: &str,
        color: ButtonColorId,
        action: ActionType,
        fields: Value,
    ) {
        self.button(label, icon, color, Control::Press, &[(action, fields)]);
    }

    /// A press button with another icon while it is on.
    fn lit(
        &mut self,
        label: &str,
        icon: &str,
        on_icon: &str,
        color: ButtonColorId,
        action: ActionType,
        fields: Value,
    ) {
        self.press(label, icon, color, action, fields);
        if let Some(button) = self.buttons.last_mut() {
            button.on_glyph = starter_glyph(on_icon);
        }
    }

    fn keys(&mut self, label: &str, icon: &str, color: ButtonColorId, combo: &str) {
        self.press(
            label,
            icon,
            color,
            ActionType::Hotkey,
            json!({ "keys": combo }),
        );
    }

    fn fader(
        &mut self,
        label: &str,
        icon: &str,
        color: ButtonColorId,
        target: FaderTarget,
        input_name: &str,
    ) {
        let fader = Fader {
            target,
            input_name: input_name.to_string(),
            app: None,
            app_name: None,
        };
        self.button(
            label,
            icon,
            color,
            Control::Fader { fader },
            &[(ActionType::None, Value::Null)],
        );
    }

    /// The deck, once its buttons are made: its id comes after theirs.
    fn deck(self, id: StarterId, columns: u8, rows: u8) -> Profile {
        Profile {
            id: self.ids.next_id("profile"),
            name: self
                .t
                .t(&format!("shared.starter.{}.name", id.as_str()), &[]),
            columns,
            rows,
            buttons: self.buttons,
            updated_at: Some(self.ids.now_iso()),
            trackpad: None,
            hidden: None,
        }
    }
}

/// One starter deck. `mac` picks Cmd or Ctrl for the shortcuts.
pub fn starter_deck(id: StarterId, mac: bool, t: &dyn Translate, ids: &Ids) -> Profile {
    use ActionType as A;
    use ButtonColorId as C;
    let mut make = Maker::new(id, t, ids);
    let none = || Value::Null;
    match id {
        StarterId::Streaming => {
            make.press("goLive", "sensors", C::Red, A::ObsStartStopStream, none());
            make.lit(
                "record",
                "fiber_manual_record",
                "stop_circle",
                C::Rose,
                A::ObsToggleRecord,
                none(),
            );
            make.press("clipIt", "replay", C::Pink, A::ObsSaveReplay, none());
            make.press(
                "cameraOut",
                "video_camera_front",
                C::Violet,
                A::ObsToggleVirtualcam,
                none(),
            );
            // Lit while muted: the crossed-out icon says so too.
            make.lit(
                "muteMic",
                "mic",
                "mic_off",
                C::Orange,
                A::ObsToggleMute,
                json!({ "sourceName": MIC }),
            );
            make.lit(
                "muteDesktop",
                "volume_up",
                "volume_off",
                C::Amber,
                A::ObsToggleMute,
                json!({ "sourceName": DESKTOP }),
            );
            make.fader("mic", "mic", C::Green, FaderTarget::ObsInput, MIC);
            make.fader(
                "desktop",
                "speaker",
                C::Cyan,
                FaderTarget::ObsInput,
                DESKTOP,
            );
            make.press(
                "airhorn",
                "campaign",
                C::Yellow,
                A::PlaySound,
                json!({ "soundId": 1 }),
            );
            make.press(
                "cheer",
                "celebration",
                C::Lime,
                A::PlaySound,
                json!({ "soundId": 2 }),
            );
            make.press("stopSounds", "stop_circle", C::Slate, A::StopSounds, none());
            make.press(
                "studioGo",
                "switch_video",
                C::Blue,
                A::ObsStudioTransition,
                none(),
            );
            make.deck(id, 4, 3)
        }
        StarterId::Music => {
            make.press(
                "previous",
                "skip_previous",
                C::Mint,
                A::MediaKey,
                json!({ "mediaKey": "previous" }),
            );
            make.press(
                "play",
                "play_pause",
                C::Green,
                A::MediaKey,
                json!({ "mediaKey": "play_pause" }),
            );
            make.press(
                "next",
                "skip_next",
                C::Mint,
                A::MediaKey,
                json!({ "mediaKey": "next" }),
            );
            make.fader("volume", "volume_up", C::Cyan, FaderTarget::System, "");
            make.fader("sounds", "graphic_eq", C::Lime, FaderTarget::Sounds, "");
            make.press("stopSounds", "stop_circle", C::Slate, A::StopSounds, none());
            make.deck(id, 3, 2)
        }
        StarterId::Shortcuts => {
            let cmd = if mac { "meta" } else { "ctrl" };
            let either = |on_mac: &'static str, elsewhere: &'static str| {
                if mac {
                    on_mac
                } else {
                    elsewhere
                }
            };
            make.keys("copy", "content_copy", C::Blue, &format!("{cmd}+c"));
            make.keys("paste", "content_paste", C::Blue, &format!("{cmd}+v"));
            make.keys("cut", "content_cut", C::Blue, &format!("{cmd}+x"));
            make.keys("selectAll", "select_all", C::Indigo, &format!("{cmd}+a"));
            make.keys("undo", "undo", C::Orange, &format!("{cmd}+z"));
            make.keys("redo", "redo", C::Orange, either("shift+meta+z", "ctrl+y"));
            make.keys("save", "save", C::Green, &format!("{cmd}+s"));
            make.keys("find", "search", C::Violet, &format!("{cmd}+f"));
            make.keys("newTab", "tab", C::Cyan, &format!("{cmd}+t"));
            make.keys("closeTab", "tab_close", C::Rose, &format!("{cmd}+w"));
            make.keys(
                "reopenTab",
                "history",
                C::Cyan,
                either("shift+meta+t", "ctrl+shift+t"),
            );
            if mac {
                make.keys("screenshot", "screenshot_region", C::Slate, "shift+meta+4");
            } else {
                make.keys("print", "print", C::Slate, "ctrl+p");
            }
            make.deck(id, 4, 3)
        }
        StarterId::Trackpad => Profile {
            trackpad: Some(DEFAULT_TRACKPAD),
            ..make.deck(id, 4, 3)
        },
    }
}

/// What a fresh install starts with: `normalize_library` takes it as it is
/// written, with `"version": 1` beside it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StarterLibrary {
    #[serde(rename = "activeProfileId")]
    pub active_profile_id: String,
    pub profiles: Vec<Profile>,
}

pub fn starter_library(mac: bool, t: &dyn Translate, ids: &Ids) -> StarterLibrary {
    let profiles: Vec<Profile> = STARTER_IDS
        .into_iter()
        .map(|id| starter_deck(id, mac, t, ids))
        .collect();
    StarterLibrary {
        active_profile_id: profiles[0].id.clone(),
        profiles,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::normalize::normalize_library;
    use crate::model::starter_glyphs::starter_glyph_names;
    use crate::model::testing::{cases, ids_of, same, same_text, EchoVars, Locale};

    fn translator(words: &str) -> Box<dyn Translate> {
        match words {
            "echo" => Box::new(EchoVars),
            code => Box::new(Locale::load(code)),
        }
    }

    #[test]
    fn starter_decks_match_the_typescript() {
        let all = cases("starter-starterDeck.json");
        // Four decks, with and without a Mac, in the echo, English and Spanish.
        assert_eq!(all.len(), 24);
        for case in &all {
            let input = &case["input"];
            let t = translator(input["words"].as_str().expect("words"));
            let id: StarterId = serde_json::from_value(input["id"].clone()).expect("a starter");
            let deck = starter_deck(id, input["mac"] == true, t.as_ref(), &ids_of(case));
            same(&format!("starterDeck({input})"), &deck, &case["output"]);
        }
    }

    #[test]
    fn starter_libraries_match_the_typescript() {
        let all = cases("starter-starterLibrary.json");
        assert_eq!(all.len(), 6);
        for case in &all {
            let input = &case["input"];
            let t = translator(input["words"].as_str().expect("words"));
            let ids = ids_of(case);
            let library = starter_library(input["mac"] == true, t.as_ref(), &ids);
            same(
                &format!("starterLibrary({input})"),
                &library,
                &case["output"]["library"],
            );
            // What a first start saves: library.ts normalizes { version: 1, ...starterLibrary }.
            let mut raw = serde_json::to_value(&library).expect("a library");
            raw["version"] = json!(1);
            same_text(
                &format!("the first start's library {input}"),
                &normalize_library(&raw, t.as_ref(), &ids),
                &case["output"]["normalized"],
            );
        }
    }

    #[test]
    fn the_first_start_has_the_four_decks_in_english() {
        // tests/library.test.mjs: "A first start gets the starter decks".
        let library = starter_library(true, &Locale::load("en"), &Ids::new(|| 1_750_000_000_000));
        let names: Vec<&str> = library
            .profiles
            .iter()
            .map(|profile| profile.name.as_str())
            .collect();
        assert_eq!(names.join(","), "Streaming,Music,Shortcuts,Trackpad");
        assert_eq!(library.active_profile_id, library.profiles[0].id);
    }

    #[test]
    fn tables_match_the_typescript() {
        let english = Locale::load("en");
        let tables = &cases("starter-tables.json")[0]["output"];
        same("STARTER_IDS", &STARTER_IDS, &tables["STARTER_IDS"]);
        for id in STARTER_IDS {
            let theirs = &tables["starters"][id.as_str()];
            same(
                "label",
                &starter_label(id, &EchoVars),
                &theirs["echo"]["label"],
            );
            same(
                "hint",
                &starter_hint(id, &EchoVars),
                &theirs["echo"]["hint"],
            );
            same(
                "label in English",
                &starter_label(id, &english),
                &theirs["en"]["label"],
            );
            same(
                "hint in English",
                &starter_hint(id, &english),
                &theirs["en"]["hint"],
            );
        }
        let glyphs = tables["STARTER_GLYPHS"].as_object().expect("glyphs");
        assert_eq!(
            glyphs.keys().map(String::as_str).collect::<Vec<_>>(),
            starter_glyph_names().collect::<Vec<_>>()
        );
        for (name, glyph) in glyphs {
            same(
                &format!("STARTER_GLYPHS.{name}"),
                &starter_glyph(name),
                glyph,
            );
        }
        assert_eq!(starter_glyph("nope"), None);
    }
}
