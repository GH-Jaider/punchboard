//! Runs a button's macro on this computer.
//!
//! Every stateful action reports the state OBS actually ended up in, rather
//! than the companion guessing, so a lit tile always matches reality.
//! (src/server/actions.ts)

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::{json, Value};

use crate::apps::Failure;
use crate::audio::player::Slot;
use crate::http::HttpError;
use crate::i18n::{say, text_of, UserError};
use crate::model::actions::LIMITS;
use crate::model::js;
use crate::model::links::web_address;
use crate::model::types::{Action, MediaKey, SetMode, Step};
use crate::obs::client::ObsClient;
use crate::obs::link::obs_call;

/// What a call into the computer answers, later.
pub type Done<T = ()> = Pin<Box<dyn Future<Output = Result<T, Failure>> + Send>>;

/// The computer and the rest of the companion, as far as a macro needs
/// them (`ActionContext`, and the modules actions.ts imported: keys, launch,
/// "open"). The server's is the real one; tests write down what was asked.
pub trait ActionContext: Send + Sync {
    /// Presses a combination ("ctrl+shift+k").
    fn send_keys(&self, keys: Option<String>) -> Done;
    /// Taps one of the keyboard's music keys.
    fn send_media_key(&self, key: MediaKey) -> Done;
    /// Starts an application, or brings it forward.
    fn launch_app(&self, target: String) -> Done;
    /// Opens a web address in this computer's browser.
    fn open_url(&self, address: String) -> Done;
    /// The connected OBS, connecting first if needed.
    fn obs(&self) -> Done<ObsClient>;
    /// Toggles a sound slot on this computer's speakers.
    fn on_sound(&self, slot: Slot) -> Result<(), Failure>;
    fn stop_sounds(&self);
}

/// Where an on/off step leaves its state: flipped, or set whatever it was.
fn wanted(set: Option<SetMode>, current: bool) -> bool {
    match set {
        Some(SetMode::On) => true,
        Some(SetMode::Off) => false,
        _ => !current,
    }
}

/// A step's wait, held to 0..LIMITS.max_delay_ms.
async fn sleep(ms: f64) {
    let held = js::max(0.0, js::min(f64::from(LIMITS.max_delay_ms), ms));
    if held.is_finite() {
        tokio::time::sleep(Duration::from_secs_f64(held / 1000.0)).await;
    }
}

/// `if (step.delayMs)`: zero and what is not a number are no wait at all.
fn waits(step: &Step) -> bool {
    step.delay_ms != 0.0 && !step.delay_ms.is_nan()
}

/// Checks a saved list of steps before any of it runs: the button's, or a
/// two-state macro's second list.
pub fn prepare_steps(list: &[Step]) -> Result<Vec<Step>, HttpError> {
    let steps: Vec<Step> = if list.is_empty() {
        vec![Step {
            id: "step".to_string(),
            delay_ms: 0.0,
            action: Action::None,
        }]
    } else {
        list.to_vec()
    };
    if steps.len() > LIMITS.max_steps {
        return Err(HttpError::new(
            400,
            say("server.press.tooManySteps").with("count", LIMITS.max_steps as f64),
        ));
    }
    for step in &steps {
        if let Action::BrowserTile { url } = &step.action {
            if web_address(url.as_deref()).is_none() {
                return Err(HttpError::new(400, say("server.press.noDeviceLink")));
            }
        }
    }
    Ok(steps)
}

fn user(key: &str) -> Failure {
    Box::new(UserError::new(say(key)))
}

/// A name a step must carry: missing and empty are both "not there".
fn filled<'a>(value: &'a Option<String>, missing: &str) -> Result<&'a str, Failure> {
    match value.as_deref() {
        Some(text) if !text.is_empty() => Ok(text),
        _ => Err(user(missing)),
    }
}

/// An on/off field of OBS's answer, as JavaScript read it: whether it is
/// truthy, and whether it is the boolean `flag` (`!==` on anything else is
/// always true).
fn state_of(answer: &Value, field: &str) -> (bool, impl Fn(bool) -> bool) {
    let value = answer.get(field).cloned().unwrap_or(Value::Null);
    let current = js::truthy(&value);
    (current, move |flag: bool| value == Value::Bool(flag))
}

/// The on/off state an action left behind, for actions that have one.
type ActionResult = Option<bool>;

async fn run_action(step: &Step, context: &dyn ActionContext) -> Result<ActionResult, Failure> {
    if waits(step) {
        sleep(step.delay_ms).await;
    }

    match &step.action {
        Action::Hotkey { keys } => {
            context.send_keys(keys.clone()).await?;
            Ok(None)
        }

        Action::LaunchApp { app_path, .. } => {
            let target = filled(app_path, "server.press.noApp")?;
            context.launch_app(target.to_string()).await?;
            Ok(None)
        }

        Action::OpenUrl { url } => {
            let Some(address) = web_address(url.as_deref()) else {
                return Err(user("server.press.noLink"));
            };
            context.open_url(address).await?;
            Ok(None)
        }

        Action::ObsScene { scene_name } => {
            let scene_name = filled(scene_name, "server.press.noScene")?;
            let obs = context.obs().await?;
            let data = json!({ "sceneName": scene_name });
            obs_call(&obs, "SetCurrentProgramScene", Some(data)).await?;
            Ok(Some(true))
        }

        Action::ObsToggleMute { source_name, set } => {
            let source_name = filled(source_name, "server.press.noAudioInput")?;
            let obs = context.obs().await?;
            let data = json!({ "inputName": source_name });
            let answer = obs_call(&obs, "GetInputMute", Some(data)).await?;
            let (input_muted, is) = state_of(&answer, "inputMuted");
            let muted = wanted(*set, input_muted);
            if !is(muted) {
                let data = json!({ "inputName": source_name, "inputMuted": muted });
                obs_call(&obs, "SetInputMute", Some(data)).await?;
            }
            // Lit means muted: that is the state worth spotting from across a room.
            Ok(Some(muted))
        }

        Action::ObsToggleSource {
            scene_name,
            source_name,
            set,
        } => {
            let (Ok(scene_name), Ok(source_name)) =
                (filled(scene_name, ""), filled(source_name, ""))
            else {
                return Err(user("server.press.noSceneSource"));
            };
            let obs = context.obs().await?;
            let data = json!({ "sceneName": scene_name, "sourceName": source_name });
            let answer = obs_call(&obs, "GetSceneItemId", Some(data)).await?;
            let scene_item_id = answer.get("sceneItemId").cloned().unwrap_or(Value::Null);
            let data = json!({ "sceneName": scene_name, "sceneItemId": scene_item_id });
            let answer = obs_call(&obs, "GetSceneItemEnabled", Some(data)).await?;
            let (enabled, is) = state_of(&answer, "sceneItemEnabled");
            let visible = wanted(*set, enabled);
            if !is(visible) {
                let data = json!({ "sceneName": scene_name, "sceneItemId": scene_item_id, "sceneItemEnabled": visible });
                obs_call(&obs, "SetSceneItemEnabled", Some(data)).await?;
            }
            Ok(Some(visible))
        }

        Action::ObsStartStopStream { set } => {
            let obs = context.obs().await?;
            let answer = obs_call(&obs, "GetStreamStatus", None).await?;
            let (active, is) = state_of(&answer, "outputActive");
            let live = wanted(*set, active);
            if !is(live) {
                let request = if live { "StartStream" } else { "StopStream" };
                obs_call(&obs, request, None).await?;
            }
            Ok(Some(live))
        }

        Action::ObsToggleRecord { set } => {
            let obs = context.obs().await?;
            let answer = obs_call(&obs, "GetRecordStatus", None).await?;
            let (active, is) = state_of(&answer, "outputActive");
            let recording = wanted(*set, active);
            if !is(recording) {
                let request = if recording {
                    "StartRecord"
                } else {
                    "StopRecord"
                };
                obs_call(&obs, request, None).await?;
            }
            Ok(Some(recording))
        }

        Action::ObsToggleFilter {
            source_name,
            filter_name,
            set,
        } => {
            let (Ok(source_name), Ok(filter_name)) =
                (filled(source_name, ""), filled(filter_name, ""))
            else {
                return Err(user("server.press.noSourceFilter"));
            };
            let obs = context.obs().await?;
            let data = json!({ "sourceName": source_name, "filterName": filter_name });
            let answer = obs_call(&obs, "GetSourceFilter", Some(data)).await?;
            let (filter_enabled, is) = state_of(&answer, "filterEnabled");
            let enabled = wanted(*set, filter_enabled);
            if !is(enabled) {
                let data = json!({ "sourceName": source_name, "filterName": filter_name, "filterEnabled": enabled });
                obs_call(&obs, "SetSourceFilterEnabled", Some(data)).await?;
            }
            Ok(Some(enabled))
        }

        Action::ObsToggleVirtualcam { set } => {
            let obs = context.obs().await?;
            let answer = obs_call(&obs, "GetVirtualCamStatus", None).await?;
            let (active, is) = state_of(&answer, "outputActive");
            let running = wanted(*set, active);
            if !is(running) {
                let request = if running {
                    "StartVirtualCam"
                } else {
                    "StopVirtualCam"
                };
                obs_call(&obs, request, None).await?;
            }
            Ok(Some(running))
        }

        Action::ObsSaveReplay => {
            let obs = context.obs().await?;
            let answer = obs_call(&obs, "GetReplayBufferStatus", None).await?;
            if !state_of(&answer, "outputActive").0 {
                return Err(user("server.press.replayOff"));
            }
            obs_call(&obs, "SaveReplayBuffer", None).await?;
            Ok(Some(true))
        }

        Action::ObsStudioTransition => {
            let obs = context.obs().await?;
            let answer = obs_call(&obs, "GetStudioModeEnabled", None).await?;
            if !state_of(&answer, "studioModeEnabled").0 {
                return Err(user("server.press.studioModeOff"));
            }
            obs_call(&obs, "TriggerStudioModeTransition", None).await?;
            Ok(None)
        }

        Action::MediaKey { media_key } => {
            context
                .send_media_key(media_key.unwrap_or(MediaKey::PlayPause))
                .await?;
            Ok(None)
        }

        Action::StopSounds => {
            context.stop_sounds();
            Ok(None)
        }

        // The companion plays it through this computer's output; the tablet
        // never loads the audio. Pressing again stops it.
        Action::PlaySound { sound_id } => {
            // Math.max(1, Math.min(LIMITS.soundSlots, Number(step.soundId) || 1))
            let slot = sound_id
                .filter(|slot| *slot != 0)
                .unwrap_or(1)
                .clamp(1, LIMITS.sound_slots);
            context.on_sound(slot)?;
            Ok(None)
        }

        // Only the device can open its own browser or change its own deck; the caller handles those.
        Action::BrowserTile { .. } | Action::GoToDeck { .. } | Action::None => Ok(None),
    }
}

/// What the deck needs to know after a macro (`MacroResult`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MacroResult {
    /// The on/off state the last stateful step left behind.
    pub active: Option<bool>,
    pub tablet_url: Option<String>,
    pub deck_id: Option<String>,
}

/// Runs a macro in order and reports what the deck needs to know afterwards.
/// A failing step stops the rest, and the message says which one it was.
pub async fn run_steps(
    steps: &[Step],
    context: &dyn ActionContext,
) -> Result<MacroResult, Failure> {
    let mut result = MacroResult::default();

    for (index, step) in steps.iter().enumerate() {
        // Every step's wait applies, in order, including the steps that do nothing
        // here: "Do nothing" with a wait is a pause, and a link or deck change
        // waits like any other step. The device opens the link or changes deck
        // when the whole macro is done, so their wait delays the steps after them.
        match &step.action {
            Action::None => {
                if waits(step) {
                    sleep(step.delay_ms).await;
                }
                continue;
            }
            // Only the first link and deck count: a device can open one page or show one deck per press.
            Action::BrowserTile { url } => {
                if waits(step) {
                    sleep(step.delay_ms).await;
                }
                if result.tablet_url.is_none() {
                    result.tablet_url = web_address(url.as_deref());
                }
                continue;
            }
            Action::GoToDeck { profile_id } => {
                if waits(step) {
                    sleep(step.delay_ms).await;
                }
                if result.deck_id.is_none() {
                    result.deck_id = profile_id.clone();
                }
                continue;
            }
            _ => {}
        }
        match run_action(step, context).await {
            Ok(Some(active)) => result.active = Some(active),
            Ok(None) => {}
            Err(error) => {
                if steps.len() < 2 {
                    return Err(error);
                }
                let label = format!("shared.action.{}.label", step.action_type().as_str());
                return Err(Box::new(UserError::new(
                    say("server.press.stepFailed")
                        .with("step", (index + 1) as f64)
                        .with("count", steps.len() as f64)
                        .with("action", say(&label))
                        .with("reason", text_of(error.as_ref())),
                )));
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::SystemFailure;
    use crate::i18n::{english, render};
    use crate::model::ids::Ids;
    use crate::model::normalize::normalize_step;
    use crate::obs::fake::{FakeObs, FakeOptions, Rig};
    use std::path::Path;
    use std::sync::Mutex;

    /// Writes down what a macro asked of the computer.
    #[derive(Default)]
    struct Desk {
        asked: Mutex<Vec<String>>,
        rig: Option<Rig>,
        /// What every key, app and link fails with, when set.
        failing: Option<String>,
    }

    impl Desk {
        fn note(&self, what: String) -> Done {
            self.asked.lock().unwrap().push(what);
            let failing = self.failing.clone();
            Box::pin(async move {
                match failing {
                    Some(reason) => Err(Box::new(SystemFailure(reason)) as Failure),
                    None => Ok(()),
                }
            })
        }

        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl ActionContext for Desk {
        fn send_keys(&self, keys: Option<String>) -> Done {
            self.note(format!("keys {}", keys.unwrap_or_default()))
        }
        fn send_media_key(&self, key: MediaKey) -> Done {
            self.note(format!("media {}", key.as_str()))
        }
        fn launch_app(&self, target: String) -> Done {
            self.note(format!("launch {target}"))
        }
        fn open_url(&self, address: String) -> Done {
            self.note(format!("open {address}"))
        }
        fn obs(&self) -> Done<ObsClient> {
            let link = self.rig.as_ref().map(|rig| rig.link.clone());
            Box::pin(async move {
                match link {
                    Some(link) => Ok(link.connect().await?),
                    None => Err(Box::new(SystemFailure("no OBS here".to_string())) as Failure),
                }
            })
        }
        fn on_sound(&self, slot: Slot) -> Result<(), Failure> {
            self.asked.lock().unwrap().push(format!("sound {slot}"));
            Ok(())
        }
        fn stop_sounds(&self) {
            self.asked.lock().unwrap().push("stop sounds".to_string());
        }
    }

    fn steps_of(raw: &Value) -> Vec<Step> {
        let ids = Ids::new(|| 0);
        raw.as_array()
            .unwrap()
            .iter()
            .map(|step| normalize_step(step, &ids))
            .collect()
    }

    fn step(raw: Value) -> Step {
        normalize_step(&raw, &Ids::new(|| 0))
    }

    fn fixture(name: &str) -> Vec<Value> {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/server")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap()
    }

    /// The failure as a press replies with it: `textOf(error)` in English.
    fn words(failure: &Failure) -> String {
        english(&text_of(failure.as_ref()))
    }

    #[test]
    fn prepare_steps_answers_as_the_typescript_does() {
        let cases = fixture("prepare-steps.json");
        assert!(cases.len() >= 8);
        for case in cases {
            let list = steps_of(&case["input"]);
            let output = match prepare_steps(&list) {
                Ok(steps) => json!({ "steps": steps }),
                Err(error) => {
                    json!({ "status": error.status, "error": error.body("en")["error"], "es": error.body("es")["error"] })
                }
            };
            assert_eq!(output, case["output"], "{}", case["input"]);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn run_steps_answers_as_the_typescript_does() {
        let cases = fixture("run-steps.json");
        assert!(cases.len() >= 20);
        for case in cases {
            let list = steps_of(&case["input"]);
            let desk = Desk::default();
            let started = tokio::time::Instant::now();
            let outcome = run_steps(&list, &desk).await;
            let waited = started.elapsed().as_millis() as u64;
            let output = match outcome {
                Ok(result) => json!({
                    "result": { "active": result.active, "tabletUrl": result.tablet_url, "deckId": result.deck_id },
                    "asked": desk.asked(),
                    "waited": waited,
                }),
                Err(failure) => {
                    let said = text_of(failure.as_ref());
                    json!({
                        "error": render(&said, "en"),
                        "es": render(&said, "es"),
                        "asked": desk.asked(),
                        "waited": waited,
                    })
                }
            };
            assert_eq!(output, case["output"], "{}", case["input"]);
        }
    }

    #[tokio::test]
    async fn keys_apps_and_links_go_to_the_computer() {
        let desk = Desk::default();
        let list = vec![
            step(json!({ "type": "hotkey", "keys": "ctrl+shift+k" })),
            step(json!({ "type": "media_key" })),
            step(json!({ "type": "media_key", "mediaKey": "next" })),
            step(json!({ "type": "launch_app", "appPath": "/Applications/Notes.app" })),
            step(json!({ "type": "open_url", "url": "twitch.tv/x" })),
        ];
        assert_eq!(
            run_steps(&list, &desk).await.unwrap(),
            MacroResult::default()
        );
        assert_eq!(
            desk.asked(),
            vec![
                "keys ctrl+shift+k",
                "media play_pause",
                "media next",
                "launch /Applications/Notes.app",
                "open https://twitch.tv/x",
            ]
        );
    }

    #[tokio::test]
    async fn the_computer_s_own_reason_is_passed_on() {
        let desk = Desk {
            failing: Some("The keyboard is on fire.".to_string()),
            ..Desk::default()
        };
        let alone = [step(json!({ "type": "hotkey", "keys": "a" }))];
        let failure = run_steps(&alone, &desk).await.unwrap_err();
        assert_eq!(words(&failure), "The keyboard is on fire.");
        let two = [
            step(json!({ "type": "stop_sounds" })),
            step(json!({ "type": "open_url", "url": "example.com" })),
        ];
        let failure = run_steps(&two, &desk).await.unwrap_err();
        assert_eq!(
            words(&failure),
            "Step 2 of 2 (Open link on computer) failed, so the rest did not run: The keyboard is on fire."
        );
        assert_eq!(
            desk.asked(),
            vec!["keys a", "stop sounds", "open https://example.com/"]
        );
    }

    fn with_obs(fake: &FakeObs) -> Desk {
        Desk {
            rig: Some(Rig::new(&[("ws://obs", fake)], "ws://obs")),
            ..Desk::default()
        }
    }

    async fn press(desk: &Desk, raw: Value) -> Result<MacroResult, Failure> {
        run_steps(&[step(raw)], desk).await
    }

    #[tokio::test]
    async fn obs_steps_flip_or_set_and_report_where_obs_ended_up() {
        let fake = FakeObs::start(FakeOptions::default());
        let desk = with_obs(&fake);
        let active = |result: Result<MacroResult, Failure>| result.unwrap().active;

        assert_eq!(
            active(press(&desk, json!({ "type": "obs_scene", "sceneName": "Intro" })).await),
            Some(true)
        );
        assert_eq!(fake.world().current_scene, "Intro");

        // Flipped, then set: setting it to what it already is asks nothing of OBS.
        let mute = |set: Option<&str>| {
            let mut raw = json!({ "type": "obs_toggle_mute", "sourceName": "Mic" });
            if let Some(set) = set {
                raw["set"] = json!(set);
            }
            raw
        };
        assert_eq!(active(press(&desk, mute(None)).await), Some(true));
        assert_eq!(active(press(&desk, mute(None)).await), Some(false));
        assert_eq!(active(press(&desk, mute(Some("on"))).await), Some(true));
        fake.world().calls.clear();
        assert_eq!(active(press(&desk, mute(Some("on"))).await), Some(true));
        assert_eq!(fake.world().calls, vec!["GetInputMute"]);
        assert_eq!(active(press(&desk, mute(Some("off"))).await), Some(false));
        assert_eq!(active(press(&desk, mute(Some("toggle"))).await), Some(true));

        for (kind, read) in [
            (
                "obs_start_stop_stream",
                (|world| world.stream) as fn(&crate::obs::fake::World) -> bool,
            ),
            ("obs_toggle_record", |world| world.record),
            ("obs_toggle_virtualcam", |world| world.virtualcam),
        ] {
            let before = read(&fake.world());
            assert_eq!(
                active(press(&desk, json!({ "type": kind })).await),
                Some(!before),
                "{kind}"
            );
            assert_eq!(read(&fake.world()), !before, "{kind}");
            assert_eq!(
                active(press(&desk, json!({ "type": kind, "set": "off" })).await),
                Some(false),
                "{kind}"
            );
            assert!(!read(&fake.world()), "{kind}");
        }
    }

    #[tokio::test]
    async fn obs_refusals_and_missing_names_are_said_in_words() {
        let fake = FakeObs::start(FakeOptions::default());
        let desk = with_obs(&fake);
        for (raw, wanted) in [
            (
                json!({ "type": "obs_scene" }),
                "Choose the OBS scene first.",
            ),
            (
                json!({ "type": "obs_toggle_mute" }),
                "Choose the OBS audio input first.",
            ),
            (
                json!({ "type": "obs_toggle_source", "sceneName": "Main" }),
                "Choose the scene and the source first.",
            ),
            (
                json!({ "type": "obs_toggle_filter", "sourceName": "Camera" }),
                "Choose the source and the filter first.",
            ),
        ] {
            let failure = press(&desk, raw.clone()).await.unwrap_err();
            assert_eq!(words(&failure), wanted, "{raw}");
        }
        // Nothing was asked of OBS for a step that names nothing.
        assert!(fake.world().calls.is_empty());

        fake.world().replay = false;
        let failure = press(&desk, json!({ "type": "obs_save_replay" }))
            .await
            .unwrap_err();
        assert!(failure.downcast_ref::<UserError>().is_some());
        assert_eq!(
            failure.downcast_ref::<UserError>().unwrap().text.key,
            "server.press.replayOff"
        );
        fake.world().studio_mode = false;
        let failure = press(&desk, json!({ "type": "obs_studio_transition" }))
            .await
            .unwrap_err();
        assert_eq!(
            failure.downcast_ref::<UserError>().unwrap().text.key,
            "server.press.studioModeOff"
        );
        // OBS's own refusal comes through as it is, with the step named.
        let two = [
            step(json!({ "type": "stop_sounds" })),
            step(json!({ "type": "obs_scene", "sceneName": "Nope" })),
            step(json!({ "type": "obs_toggle_virtualcam" })),
        ];
        fake.world().calls.clear();
        let failure = run_steps(&two, &desk).await.unwrap_err();
        let said = words(&failure);
        assert!(
            said.starts_with("Step 2 of 3 (Switch scene) failed, so the rest did not run: "),
            "{said}"
        );
        // The step after the one that failed did not run.
        assert_eq!(fake.world().calls, vec!["SetCurrentProgramScene"]);
    }
}
