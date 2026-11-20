//! One application's volume, for "App volume" faders.
//!   Windows: the real per-app mixer, through Core Audio's audio sessions
//!            (system_windows.rs). Any app with an audio session can be set.
//!   Linux:   the same, through the sound server's streams (system_linux.rs).
//!   macOS:   there is no public per-app volume, so only apps with a volume of
//!            their own that scripts can set: Music and Spotify, through
//!            osascript. An app that is not running is never started: every
//!            script asks "is running" first and stops there if not.
//!   Other:   nothing to offer.
//! A level that cannot be read (the app is closed, or silent on Windows) is
//! `None`, which the decks show as "–". Writes go one at a time per app,
//! newest level first, like the computer's own volume.

use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use crate::i18n::{say, Text, UserError};
use crate::latest_wins::{latest_wins_per_key, LatestWinsPerKey};
use crate::model::js;
use crate::model::normalize::normalize_app_key;
use crate::store::stringify;

use super::{clamp01, Answer, SystemApp, SystemAudio, VolumeError};

/// An app a fader can be pointed at (`AudioApp` in src/shared/api.ts).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AudioApp {
    /// What the fader stores: the process name without .exe, lower-cased, on
    /// Windows ("chrome"); "music" or "spotify" on a Mac.
    pub key: String,
    /// The name people know it by ("Google Chrome").
    pub name: String,
    /// Whether it is running (a Mac) or has an audio session (Windows) now.
    pub running: bool,
    /// Its volume now, 0..1, or `None` while that cannot be read.
    pub level: Option<f64>,
}

/// The apps a fader can be pointed at, with a note for the picker that is
/// worded for whoever asks (the server renders it).
#[derive(Clone, Debug, PartialEq)]
pub struct AppList {
    pub platform: String,
    pub apps: Vec<AudioApp>,
    pub note: Option<Text>,
}

/// A Mac app whose volume a script can set.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MacApp {
    pub name: &'static str,
    pub id: &'static str,
}

/// The Mac apps whose volume a script can set, by key. Scripts find them by
/// bundle id: by name, AppleScript can settle on another app whose name is
/// close when the one asked for is not installed.
pub const MAC_APPS: [(&str, MacApp); 2] = [
    (
        "music",
        MacApp {
            name: "Music",
            id: "com.apple.Music",
        },
    ),
    (
        "spotify",
        MacApp {
            name: "Spotify",
            id: "com.spotify.client",
        },
    ),
];

pub const MAC_ONLY_NOTE: &str = "server.apps.macOnly";
const OTHER_NOTE: &str = "server.apps.otherUnsupported";

/// Volumes read back from the system can be a hair off what was set (0.5 as
/// 0.50000006); three places are all a fader shows, and keep a poll from
/// reporting a change that is not one.
pub fn round_level(level: f64) -> f64 {
    js::round(js::max(0.0, js::min(1.0, level)) * 1000.0) / 1000.0
}

/// The AppleScript that reads (level `None`) or sets (0..1) a Mac app's volume
/// and answers its volume 0..100, or "closed" when the app is not running.
/// Asking "is running" never starts an app, and nothing is sent to it unless
/// the answer is yes. The bundle id is held in a variable and the property
/// is named by its raw code («class pVol», "sound volume" in both Music's and
/// Spotify's dictionaries), so compiling the script never looks for the app:
/// one that is not installed fails the "is running" question at run time,
/// which counts as not running. "its" makes it the app's property; without a
/// dictionary a bare «class pVol» compiles as a constant that cannot be set.
pub fn mac_volume_script(bundle_id: &str, level: Option<f64>) -> String {
    let mut lines = vec![
        format!(
            "set appId to {}",
            stringify(&Value::String(bundle_id.to_string()))
        ),
        "try".to_string(),
        "  set isOpen to (application id appId is running)".to_string(),
        "on error".to_string(),
        "  return \"closed\"".to_string(),
        "end try".to_string(),
        "if not isOpen then return \"closed\"".to_string(),
    ];
    if let Some(level) = level {
        let percent = js::round(js::max(0.0, js::min(1.0, level)) * 100.0);
        lines.push(format!(
            "tell application id appId to set its «class pVol» to {}",
            js::number_to_string(percent)
        ));
    }
    lines.push("tell application id appId to return its «class pVol»".to_string());
    lines.join("\n")
}

/// Runs one AppleScript. The real one is `/usr/bin/osascript`
/// (system_mac.rs); tests answer from a table.
pub trait ScriptRunner: Send + Sync {
    /// What the script printed, trimmed; or what went wrong, in the
    /// system's words (what it wrote to stderr, else the failure itself).
    fn run(&self, script: &str) -> Answer<String, String>;
}

/// What osascript's failure means to a person.
fn mac_error(app_name: &str, text: &str) -> UserError {
    let lowered = text.to_lowercase();
    if lowered.contains("-1743")
        || lowered.contains("not authorized")
        || lowered.contains("not authorised")
    {
        return UserError::new(say("server.apps.macAutomation").with("app", app_name));
    }
    // Every run of white space is one space, then the first 200 characters.
    let mut reason = String::new();
    let mut in_space = false;
    for c in text.chars() {
        if js::is_space(c) {
            in_space = true;
            continue;
        }
        if in_space {
            reason.push(' ');
        }
        in_space = false;
        reason.push(c);
    }
    if in_space {
        reason.push(' ');
    }
    UserError::new(
        say("server.apps.unreachable")
            .with("app", app_name)
            .with("reason", js::slice_utf16(&reason, 200)),
    )
}

/// What a Mac app answered: its level 0..1, or `None` when it is not running.
pub fn mac_answer(app: MacApp, answer: &str) -> Result<Option<f64>, UserError> {
    if answer == "closed" {
        return Ok(None);
    }
    // An empty answer is not 0: Number("") would read it as silence.
    let value = if answer.is_empty() {
        f64::NAN
    } else {
        js::string_to_number(answer)
    };
    if !value.is_finite() {
        return Err(UserError::new(
            say("server.apps.notAVolume").with("app", app.name),
        ));
    }
    Ok(Some(round_level(value / 100.0)))
}

/// A Mac app's answer: its level 0..1, or `None` when it is not running.
pub async fn run_mac_script(
    runner: &dyn ScriptRunner,
    app: MacApp,
    level: Option<f64>,
) -> Result<Option<f64>, UserError> {
    let answer = runner
        .run(&mac_volume_script(app.id, level))
        .await
        .map_err(|error| mac_error(app.name, &error))?;
    mac_answer(app, &answer)
}

/// The level a write answers with: the one asked for. A write that arrives
/// while another is in flight shares that one's answer, which is the older
/// level; the newest is set right after it, and the decks should show it
/// rather than jump back. A refusal (the app closed) still comes through.
fn answered(level: f64) -> f64 {
    round_level(level)
}

/// The app volumes of one system.
pub trait AppVolume: Send + Sync {
    /// Whether app volumes can change on their own here, so polling them is worth it.
    fn live(&self) -> bool;
    /// The apps a fader can be pointed at right now.
    fn list(&self) -> Answer<AppList>;
    /// An app's level, or `None` while it cannot be read.
    fn read(&self, key: &str) -> Answer<Option<f64>, VolumeError>;
    /// Sets an app's level and answers the level it now has. `name` is how the
    /// error names it ("Google Chrome").
    fn write(&self, key: &str, name: &str, level: f64) -> Answer<f64, VolumeError>;
}

// ------------------------------------------- a real mixer: Windows and Linux

/// `name.localeCompare(other)`: the order a person files names in, letters
/// before their accents and case. (Node used the computer's own language
/// for it; this is the order all languages share.)
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    match icu_collator::Collator::try_new(Default::default(), Default::default()) {
        Ok(collator) => collator.compare(a, b),
        Err(_) => a.cmp(b),
    }
}

/// One entry of the system's list, checked: an entry without a key is left
/// out, and one without a name is called by its key.
fn shape_app(key: &str, name: Option<&str>, level: f64) -> Option<SystemApp> {
    if key.is_empty() {
        return None;
    }
    let name = name.map(js::trim).filter(|name| !name.is_empty());
    Some(SystemApp {
        key: key.to_string(),
        name: name.unwrap_or(key).to_string(),
        level: clamp01(level),
    })
}

/// The system's list, checked entry by entry: anything malformed is left out.
pub fn shape_apps(raw: Vec<SystemApp>) -> Vec<SystemApp> {
    raw.iter()
        .filter_map(|app| shape_app(&app.key, Some(&app.name), app.level))
        .collect()
}

/// The list as the Windows bridge used to send it, as JSON:
/// `[{"key","name","level"}]`. Kept so the shaping of [`shape_apps`] stays
/// what the TypeScript's `parseAppList` did, case by case.
pub fn parse_app_list(text: &str) -> Result<Vec<SystemApp>, UserError> {
    let bad_list = || UserError::new(say("server.winVolume.badList"));
    let raw: Value = serde_json::from_str(text).map_err(|_| bad_list())?;
    let Value::Array(items) = raw else {
        return Err(bad_list());
    };
    let mut apps = Vec::new();
    for item in &items {
        let Some(fields) = item.as_object() else {
            continue;
        };
        let Some(key) = fields.get("key").and_then(Value::as_str) else {
            continue;
        };
        // `Number(String(fields.level)) || 0`: a missing level is "undefined".
        let level = fields.get("level").map_or(f64::NAN, |level| {
            js::string_to_number(&js::to_string(level))
        });
        let name = fields.get("name").and_then(Value::as_str);
        apps.extend(shape_app(key, name, level));
    }
    Ok(apps)
}

// What the system side decides before it asks: which process is which app.

/// A Windows process's name as .NET's `Process.ProcessName` had it: the
/// program's file name without ".exe".
pub fn process_name(exe_file: &str) -> &str {
    let cut = exe_file.len().saturating_sub(4);
    match exe_file.get(cut..) {
        Some(end) if cut > 0 && end.eq_ignore_ascii_case(".exe") => &exe_file[..cut],
        _ => exe_file,
    }
}

/// The app key of a Windows process: its name without .exe, lower-cased
/// ("chrome"), so a fader keeps working across restarts, and one key covers
/// all of an app's processes: Chrome plays from several.
pub fn process_key(exe_file: &str) -> String {
    process_name(exe_file).to_lowercase()
}

/// The companion and everything it started are Punchboard itself, not apps
/// to offer: `own` and every process that descends from it. `processes` is
/// each running process with its parent.
pub fn own_processes(own: u32, processes: &[(u32, u32)]) -> HashSet<u32> {
    let mut ours = HashSet::from([own]);
    let mut grew = true;
    while grew {
        grew = false;
        for (process, parent) in processes {
            if ours.contains(parent) && *process != 0 && ours.insert(*process) {
                grew = true;
            }
        }
    }
    ours
}

/// The name an app is listed by: its program's own description ("Google
/// Chrome"), or the process's name when it has none.
pub fn friendly_name(description: Option<&str>, process_name: &str) -> String {
    match description.map(str::trim).filter(|text| !text.is_empty()) {
        Some(description) => description.to_string(),
        None => process_name.to_string(),
    }
}

/// The app key of a stream on a Linux sound server: the program that plays
/// it ("firefox", from application.process.binary), else the name it gave
/// itself, as a fader would store either. `None` when neither can be a key.
pub fn stream_key(binary: Option<&str>, name: Option<&str>) -> Option<String> {
    let program = binary.map(|path| path.rsplit('/').next().unwrap_or(path));
    [program, name]
        .into_iter()
        .flatten()
        .find_map(|text| normalize_app_key(&Value::String(text.to_string())))
}

/// PulseAudio's "100%".
pub const PULSE_NORM: u32 = 0x10000;

/// A stream's or a device's level from its channels' volumes: the loudest
/// one, as desktop mixers show it, 100% being 1.
pub fn pulse_level(channels: &[u32]) -> f64 {
    let loudest = channels.iter().copied().max().unwrap_or(0);
    clamp01(f64::from(loudest) / f64::from(PULSE_NORM))
}

/// The channels' volumes for a level: the loudest becomes the level and the
/// others keep their share of it, so a balance set elsewhere stays.
pub fn pulse_channels(channels: &[u32], level: f64) -> Vec<u32> {
    let wanted = js::round(clamp01(level) * f64::from(PULSE_NORM));
    let loudest = channels.iter().copied().max().unwrap_or(0);
    channels
        .iter()
        .map(|channel| {
            if loudest == 0 {
                wanted as u32
            } else {
                js::round(wanted * f64::from(*channel) / f64::from(loudest)) as u32
            }
        })
        .collect()
}

/// The app volumes of a system with a real per-app mixer.
pub struct MixerAppVolume {
    platform: &'static str,
    audio: Arc<dyn SystemAudio>,
    write: LatestWinsPerKey<Result<Option<f64>, UserError>>,
}

impl MixerAppVolume {
    /// `platform` is what Node called the system: "win32", "linux".
    pub fn new(platform: &'static str, audio: Arc<dyn SystemAudio>) -> MixerAppVolume {
        let system = audio.clone();
        MixerAppVolume {
            platform,
            audio,
            write: latest_wins_per_key(move |key, level| system.set_app_volume(key, level)),
        }
    }
}

impl AppVolume for MixerAppVolume {
    fn live(&self) -> bool {
        true
    }

    fn list(&self) -> Answer<AppList> {
        let (listed, platform) = (self.audio.list_apps(), self.platform);
        Box::pin(async move {
            let mut apps: Vec<AudioApp> = listed
                .await?
                .into_iter()
                .map(|app| AudioApp {
                    key: app.key,
                    name: app.name,
                    running: true,
                    level: Some(round_level(app.level)),
                })
                .collect();
            apps.sort_by(|a, b| compare_names(&a.name, &b.name));
            let note = apps.is_empty().then(|| say("server.apps.nonePlaying"));
            Ok(AppList {
                platform: platform.to_string(),
                apps,
                note,
            })
        })
    }

    fn read(&self, key: &str) -> Answer<Option<f64>, VolumeError> {
        let asked = self.audio.app_volume(key);
        Box::pin(async move { Ok(asked.await?.map(round_level)) })
    }

    fn write(&self, key: &str, name: &str, level: f64) -> Answer<f64, VolumeError> {
        let (written, name) = (self.write.run(key, level), name.to_string());
        Box::pin(async move {
            if written.await?.is_none() {
                return Err(VolumeError::AppNotPlaying(UserError::new(
                    say("server.apps.silent").with("app", name),
                )));
            }
            Ok(answered(level))
        })
    }
}

// ----------------------------------------------------------------- macOS

pub(crate) fn mac_app_of(key: &str) -> Result<MacApp, UserError> {
    MAC_APPS
        .iter()
        .find(|(known, _)| *known == key)
        .map(|(_, app)| *app)
        .ok_or_else(|| UserError::new(say(MAC_ONLY_NOTE)))
}

/// Music and Spotify, through their own scripted volume.
pub struct MacAppVolume {
    runner: Arc<dyn ScriptRunner>,
    write: LatestWinsPerKey<Result<Option<f64>, UserError>>,
}

impl MacAppVolume {
    pub fn new(runner: Arc<dyn ScriptRunner>) -> MacAppVolume {
        let scripts = runner.clone();
        MacAppVolume {
            runner,
            write: latest_wins_per_key(move |key, level| {
                let (app, scripts) = (mac_app_of(key), scripts.clone());
                async move { run_mac_script(scripts.as_ref(), app?, Some(level)).await }
            }),
        }
    }
}

impl AppVolume for MacAppVolume {
    fn live(&self) -> bool {
        true
    }

    fn list(&self) -> Answer<AppList> {
        let runner = self.runner.clone();
        Box::pin(async move {
            let asked = MAC_APPS.iter().map(|(key, app)| {
                let runner = runner.clone();
                async move {
                    match run_mac_script(runner.as_ref(), *app, None).await {
                        Ok(level) => AudioApp {
                            key: key.to_string(),
                            name: app.name.to_string(),
                            running: level.is_some(),
                            level,
                        },
                        // Only a running app gets as far as being asked (and refusing,
                        // without the Automation permission): it is open, its level unknown.
                        Err(_) => AudioApp {
                            key: key.to_string(),
                            name: app.name.to_string(),
                            running: true,
                            level: None,
                        },
                    }
                }
            });
            Ok(AppList {
                platform: "darwin".to_string(),
                apps: futures_util::future::join_all(asked).await,
                note: Some(say(MAC_ONLY_NOTE)),
            })
        })
    }

    fn read(&self, key: &str) -> Answer<Option<f64>, VolumeError> {
        let (app, runner) = (mac_app_of(key), self.runner.clone());
        Box::pin(async move { Ok(run_mac_script(runner.as_ref(), app?, None).await?) })
    }

    fn write(&self, key: &str, name: &str, level: f64) -> Answer<f64, VolumeError> {
        let (written, name) = (self.write.run(key, level), name.to_string());
        Box::pin(async move {
            if written.await?.is_none() {
                return Err(VolumeError::AppNotPlaying(UserError::new(
                    say("server.apps.closed").with("app", name),
                )));
            }
            Ok(answered(level))
        })
    }
}

// ----------------------------------------------------------------- elsewhere

/// A system with no app volume to offer.
pub struct OtherAppVolume {
    platform: String,
}

impl OtherAppVolume {
    pub fn new(platform: &str) -> OtherAppVolume {
        OtherAppVolume {
            platform: platform.to_string(),
        }
    }
}

impl AppVolume for OtherAppVolume {
    fn live(&self) -> bool {
        false
    }

    fn list(&self) -> Answer<AppList> {
        let platform = self.platform.clone();
        Box::pin(async move {
            Ok(AppList {
                platform,
                apps: Vec::new(),
                note: Some(say(OTHER_NOTE)),
            })
        })
    }

    fn read(&self, _key: &str) -> Answer<Option<f64>, VolumeError> {
        Box::pin(async { Ok(None) })
    }

    fn write(&self, _key: &str, _name: &str, _level: f64) -> Answer<f64, VolumeError> {
        Box::pin(async { Err(UserError::new(say(OTHER_NOTE)).into()) })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::audio::testing::cases;
    use crate::i18n::{english, Said};
    use std::collections::BTreeMap;
    use std::sync::{Mutex, MutexGuard};
    use std::time::Duration;
    use tokio::time::sleep;

    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn number(bits: &Value) -> f64 {
        f64::from_bits(u64::from_str_radix(bits.as_str().unwrap(), 16).unwrap())
    }

    fn bits(value: f64) -> String {
        format!("{:016x}", value.to_bits())
    }

    /// A list's note in English (the companion words it for each request).
    fn note_of(list: &AppList) -> String {
        list.note
            .clone()
            .map(|note| english(&Said::Text(note)))
            .unwrap_or_default()
    }

    fn as_json(apps: &[AudioApp]) -> String {
        stringify(&serde_json::to_value(apps).unwrap())
    }

    // ------------------------------------------------ against the TypeScript

    #[test]
    fn round_level_matches_the_typescript() {
        let all = cases("round-level.json");
        assert!(all.len() >= 2000);
        for case in all {
            let input = number(&case["input"]["bits"]);
            assert_eq!(
                bits(round_level(input)),
                case["output"],
                "roundLevel({})",
                case["input"]["text"]
            );
        }
    }

    #[test]
    fn the_mac_scripts_are_the_typescripts_byte_for_byte() {
        let all = cases("mac-volume-script.json");
        assert!(all.len() >= 400);
        let mut ids = std::collections::BTreeSet::new();
        for case in all {
            let id = case["input"]["bundleId"].as_str().unwrap();
            ids.insert(id.to_string());
            let level = match &case["input"]["level"] {
                Value::Null => None,
                bits => Some(number(bits)),
            };
            assert_eq!(
                mac_volume_script(id, level).as_bytes(),
                case["output"].as_str().unwrap().as_bytes(),
                "{}",
                case["input"]
            );
        }
        for (_, app) in MAC_APPS {
            assert!(ids.contains(app.id), "{} has no case", app.id);
        }
    }

    #[test]
    fn mac_apps_are_the_typescripts() {
        let all = cases("mac-apps.json");
        let ours: Vec<Value> = MAC_APPS
            .iter()
            .map(|(key, app)| serde_json::json!({ "key": key, "name": app.name, "id": app.id }))
            .collect();
        assert_eq!(Value::Array(ours), all[0]["output"]);
    }

    #[test]
    fn mac_answers_match_the_typescript() {
        let all = cases("mac-answer.json");
        assert!(all.len() >= 30);
        for case in all {
            let input = &case["input"];
            let output = &case["output"];
            let app = MAC_APPS[1].1;
            let ours = match input["kind"].as_str().unwrap() {
                "answer" => mac_answer(app, input["text"].as_str().unwrap()),
                _ => Err(mac_error(app.name, input["text"].as_str().unwrap())),
            };
            match ours {
                Ok(level) => {
                    let level = level.map_or(Value::Null, |level| Value::String(bits(level)));
                    assert_eq!(level, output["level"], "{input}");
                }
                Err(error) => {
                    assert_eq!(error.text.key, output["key"], "{input}");
                    assert_eq!(error.message(), output["message"], "{input}");
                }
            }
        }
    }

    #[test]
    fn parse_app_list_matches_the_typescript() {
        let all = cases("parse-app-list.json");
        assert!(all.len() >= 40);
        for case in all {
            let text = case["input"].as_str().unwrap();
            let output = &case["output"];
            match parse_app_list(text) {
                Ok(apps) => {
                    let ours: Vec<Value> = apps
                        .iter()
                        .map(|app| {
                            serde_json::json!({ "key": app.key, "name": app.name, "level": bits(app.level) })
                        })
                        .collect();
                    assert_eq!(Value::Array(ours), output["apps"], "{text}");
                }
                Err(error) => {
                    assert_eq!(error.text.key, output["error"], "{text}");
                }
            }
        }
    }

    #[tokio::test]
    async fn the_mixers_list_is_the_typescripts() {
        let all = cases("mixer-list.json");
        assert!(all.len() >= 8);
        for case in all {
            let raw = parse_app_list(case["input"].as_str().unwrap()).unwrap();
            let system = Arc::new(FakeMixer::default());
            *lock(&system.listed) = Some(raw);
            let list = MixerAppVolume::new("win32", system).list().await.unwrap();
            let output = &case["output"];
            assert_eq!(list.platform, output["platform"]);
            assert_eq!(as_json(&list.apps), stringify(&output["apps"]));
            assert_eq!(
                list.note.map(|note| Value::String(note.key)),
                output.get("note").cloned()
            );
        }
    }

    // ------------------------------------------------------------- stand-ins

    /// A stand-in mixer: app levels in a table, sets that take 80 ms (so
    /// writes pile up behind one in flight), every call remembered. What the
    /// fake "powershell" of tests/app-volume.test.mjs was.
    #[derive(Default)]
    pub struct FakeMixer {
        pub apps: Arc<Mutex<BTreeMap<String, (String, f64)>>>,
        pub calls: Arc<Mutex<Vec<String>>>,
        /// When set, the list answered as it is.
        pub listed: Mutex<Option<Vec<SystemApp>>>,
    }

    impl FakeMixer {
        pub fn with(apps: &[(&str, &str, f64)]) -> FakeMixer {
            let mixer = FakeMixer::default();
            mixer.set(apps);
            mixer
        }
        pub fn set(&self, apps: &[(&str, &str, f64)]) {
            *lock(&self.apps) = apps
                .iter()
                .map(|(key, name, level)| (key.to_string(), (name.to_string(), *level)))
                .collect();
        }
        fn level(&self, key: &str) -> Option<f64> {
            lock(&self.apps).get(key).map(|app| app.1)
        }
    }

    impl SystemAudio for FakeMixer {
        fn main_volume(&self) -> Answer<f64> {
            Box::pin(async { Err(UserError::new(say("server.winVolume.noChange"))) })
        }
        fn set_main_volume(&self, _level: f64) -> Answer<f64> {
            Box::pin(async { Err(UserError::new(say("server.winVolume.noChange"))) })
        }
        fn app_volume(&self, key: &str) -> Answer<Option<f64>> {
            lock(&self.calls).push(format!("app_volume {key}"));
            let level = self.level(key);
            Box::pin(async move { Ok(level) })
        }
        fn set_app_volume(&self, key: &str, level: f64) -> Answer<Option<f64>> {
            lock(&self.calls).push(format!("set_app_volume {key} {level}"));
            let (apps, key) = (self.apps.clone(), key.to_string());
            Box::pin(async move {
                sleep(Duration::from_millis(80)).await;
                Ok(lock(&apps).get_mut(&key).map(|app| {
                    app.1 = level;
                    level
                }))
            })
        }
        fn list_apps(&self) -> Answer<Vec<SystemApp>> {
            lock(&self.calls).push("list_apps".to_string());
            let listed = lock(&self.listed).clone().unwrap_or_else(|| {
                lock(&self.apps)
                    .iter()
                    // The system leaves Punchboard itself out.
                    .filter(|(key, _)| *key != "punchboard")
                    .map(|(key, (name, level))| SystemApp {
                        key: key.clone(),
                        name: name.clone(),
                        level: *level,
                    })
                    .collect()
            });
            Box::pin(async move { Ok(listed) })
        }
    }

    #[derive(Clone, Copy, Default)]
    pub struct FakeMacApp {
        pub running: bool,
        pub volume: f64,
        pub refuse: bool,
    }

    /// A stand-in "osascript" that runs nothing: it reads which app the script
    /// names and what it sets, and answers from a table of apps, honouring the
    /// script's own "is running" guard. Sets take 60 ms.
    #[derive(Default)]
    pub struct FakeOsascript {
        pub apps: Arc<Mutex<BTreeMap<String, FakeMacApp>>>,
        pub scripts: Arc<Mutex<Vec<String>>>,
    }

    impl FakeOsascript {
        pub fn set(&self, apps: &[(&str, FakeMacApp)]) {
            *lock(&self.apps) = apps
                .iter()
                .map(|(id, app)| (id.to_string(), *app))
                .collect();
        }
        fn volume(&self, id: &str) -> f64 {
            lock(&self.apps)[id].volume
        }
        /// The levels the scripts sent set, in order.
        fn sets(&self) -> Vec<String> {
            lock(&self.scripts)
                .iter()
                .filter_map(|script| {
                    let (_, rest) = script.split_once("set its «class pVol» to ")?;
                    Some(rest.split('\n').next().unwrap_or("").to_string())
                })
                .collect()
        }
    }

    impl ScriptRunner for FakeOsascript {
        fn run(&self, script: &str) -> Answer<String, String> {
            lock(&self.scripts).push(script.to_string());
            let (apps, script) = (self.apps.clone(), script.to_string());
            Box::pin(async move {
                let id = script
                    .split_once("set appId to \"")
                    .and_then(|(_, rest)| rest.split_once('"'))
                    .map(|(id, _)| id.to_string())
                    .unwrap_or_default();
                if !script.contains("application id appId is running") {
                    return Err("no guard".to_string());
                }
                let app = lock(&apps).get(&id).copied();
                let Some(app) = app.filter(|app| app.running) else {
                    return Ok("closed".to_string());
                };
                if app.refuse {
                    return Err(format!(
                        "execution error: Not authorized to send Apple events to {id}. (-1743)"
                    ));
                }
                let set = script
                    .split_once("set its «class pVol» to ")
                    .and_then(|(_, rest)| rest.split('\n').next()?.parse::<f64>().ok());
                if let Some(volume) = set {
                    sleep(Duration::from_millis(60)).await;
                    if let Some(app) = lock(&apps).get_mut(&id) {
                        app.volume = volume;
                    }
                    return Ok(js::number_to_string(volume));
                }
                Ok(js::number_to_string(app.volume))
            })
        }
    }

    const SPOTIFY: &str = "com.spotify.client";
    const MUSIC: &str = "com.apple.Music";

    fn mac(apps: &[(&str, FakeMacApp)]) -> (MacAppVolume, Arc<FakeOsascript>) {
        let runner = Arc::new(FakeOsascript::default());
        runner.set(apps);
        (MacAppVolume::new(runner.clone()), runner)
    }

    fn open(volume: f64) -> FakeMacApp {
        FakeMacApp {
            running: true,
            volume,
            refuse: false,
        }
    }

    fn closed(volume: f64) -> FakeMacApp {
        FakeMacApp {
            running: false,
            volume,
            refuse: false,
        }
    }

    // --------------------------------------- tests/app-volume.test.mjs, Windows

    #[tokio::test(start_paused = true)]
    async fn windows_list_read_and_write() {
        let system = Arc::new(FakeMixer::with(&[
            ("chrome", "Google Chrome", 0.25),
            ("spotify", "Spotify Ä", 1.0),
            ("punchboard", "Punchboard", 1.0),
        ]));
        let windows = MixerAppVolume::new("win32", system.clone());
        assert!(windows.live());
        // "Windows: the list has every app with a session, by name, with its level"
        let list = windows.list().await.unwrap();
        assert_eq!(
            as_json(&list.apps),
            r#"[{"key":"chrome","name":"Google Chrome","running":true,"level":0.25},{"key":"spotify","name":"Spotify Ä","running":true,"level":1}]"#
        );
        assert_eq!(list.platform, "win32");
        assert_eq!(list.note, None);
        // "Windows: the list leaves out the companion's own processes": the
        // bridge was sent "list <pid>"; now the system is asked for its list
        // once, and leaving Punchboard out is the system side's business.
        assert_eq!(lock(&system.calls).join("|"), "list_apps");
        // "Windows: a level set reads back"
        assert_eq!(windows.write("chrome", "Google Chrome", 0.6).await, Ok(0.6));
        assert_eq!(windows.read("chrome").await, Ok(Some(0.6)));
        // "Windows: a write to an app with no audio session says so, kindly"
        let missing = windows.write("discord", "Discord", 0.5).await.unwrap_err();
        assert!(missing.is_app_not_playing());
        assert_eq!(
            missing.message(),
            "Discord is not making any sound on this computer right now. Open it and play something first."
        );
        // "Windows: an app with no audio session reads as unknown"
        assert_eq!(windows.read("discord").await, Ok(None));
    }

    // "Windows: a drag's levels are coalesced, newest last"
    #[tokio::test(start_paused = true)]
    async fn windows_a_drags_levels_are_coalesced_newest_last() {
        let system = Arc::new(FakeMixer::with(&[("chrome", "Google Chrome", 0.25)]));
        let windows = MixerAppVolume::new("win32", system.clone());
        let writes = futures_util::future::join_all(
            [0.1, 0.2, 0.3, 0.4].map(|level| windows.write("chrome", "Google Chrome", level)),
        )
        .await;
        sleep(Duration::from_millis(250)).await;
        // The bridge saw "app-set 0.100 chrome|app-set 0.400 chrome".
        assert_eq!(
            lock(&system.calls).join("|"),
            "set_app_volume chrome 0.1|set_app_volume chrome 0.4"
        );
        assert_eq!(system.level("chrome"), Some(0.4));
        // Each caller is answered with the level it asked for.
        assert_eq!(writes, [Ok(0.1), Ok(0.2), Ok(0.3), Ok(0.4)]);
    }

    // "Windows: no app playing gives an empty list with a hint"
    #[tokio::test]
    async fn windows_no_app_playing_gives_an_empty_list_with_a_hint() {
        let windows = MixerAppVolume::new("win32", Arc::new(FakeMixer::default()));
        let empty = windows.list().await.unwrap();
        assert!(empty.apps.is_empty());
        assert!(note_of(&empty).contains("No app is playing"));
    }

    #[tokio::test(start_paused = true)]
    async fn windows_levels_are_rounded_to_three_places() {
        let system = Arc::new(FakeMixer::with(&[("chrome", "Chrome", 0.500_000_06)]));
        let windows = MixerAppVolume::new("win32", system.clone());
        assert_eq!(windows.read("chrome").await, Ok(Some(0.5)));
        assert_eq!(windows.list().await.unwrap().apps[0].level, Some(0.5));
        assert_eq!(windows.write("chrome", "Chrome", 0.12345).await, Ok(0.123));
        // A failure of the system comes through as it is, not as "not playing".
        struct Broken;
        impl SystemAudio for Broken {
            fn main_volume(&self) -> Answer<f64> {
                unreachable!()
            }
            fn set_main_volume(&self, _level: f64) -> Answer<f64> {
                unreachable!()
            }
            fn app_volume(&self, _key: &str) -> Answer<Option<f64>> {
                Box::pin(async { Err(UserError::new(say("server.winVolume.slowAnswer"))) })
            }
            fn set_app_volume(&self, _key: &str, _level: f64) -> Answer<Option<f64>> {
                Box::pin(async { Err(UserError::new(say("server.winVolume.helperStopped"))) })
            }
            fn list_apps(&self) -> Answer<Vec<SystemApp>> {
                Box::pin(async { Err(UserError::new(say("server.winVolume.stopped"))) })
            }
        }
        let broken = MixerAppVolume::new("win32", Arc::new(Broken));
        let error = broken.write("chrome", "Chrome", 0.5).await.unwrap_err();
        assert!(!error.is_app_not_playing());
        assert_eq!(error.message(), "The volume helper stopped; try again.");
        assert!(broken.read("chrome").await.is_err());
        assert_eq!(
            broken.list().await.unwrap_err().text.key,
            "server.winVolume.stopped"
        );
    }

    #[tokio::test]
    async fn linux_is_a_mixer_too() {
        let system = Arc::new(FakeMixer::with(&[("firefox", "Firefox", 0.4)]));
        let linux = MixerAppVolume::new("linux", system);
        let list = linux.list().await.unwrap();
        assert_eq!(list.platform, "linux");
        assert_eq!(list.apps[0].key, "firefox");
        assert_eq!(linux.read("firefox").await, Ok(Some(0.4)));
    }

    // ----------------------------------------- tests/app-volume.test.mjs, macOS

    // "The <app> read/write script asks "is running" before sending anything"
    #[test]
    fn every_script_asks_is_running_before_sending_anything() {
        for (_, app) in MAC_APPS {
            for level in [None, Some(0.42)] {
                let script = mac_volume_script(app.id, level);
                let lines: Vec<&str> = script.split('\n').collect();
                let guard = lines
                    .iter()
                    .position(|line| line.contains("application id appId is running"))
                    .unwrap();
                let first_tell = lines
                    .iter()
                    .position(|line| line.starts_with("tell "))
                    .unwrap();
                assert!(first_tell > guard, "{script}");
                assert!(lines.contains(&"if not isOpen then return \"closed\""));
                // /\b(activate|launch|run|open)\b/: no word that starts an app.
                let words: Vec<&str> = script
                    .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .collect();
                for word in ["activate", "launch", "run", "open"] {
                    assert!(!words.contains(&word), "{word} in {script}");
                }
            }
        }
        // "A write script sets the app's volume 0..100"
        let write = mac_volume_script(SPOTIFY, Some(0.42));
        assert!(write
            .split('\n')
            .any(|line| line.ends_with("set its «class pVol» to 42")));
        // "A read script sets nothing"
        assert!(!mac_volume_script(SPOTIFY, None).contains("set its"));
        // "Mac apps are found by bundle id"
        assert_eq!(mac_app_of("music").unwrap().id, MUSIC);
        assert_eq!(mac_app_of("spotify").unwrap().id, SPOTIFY);
    }

    #[tokio::test(start_paused = true)]
    async fn mac_list_read_and_write() {
        let (mac, runner) = mac(&[(SPOTIFY, open(30.0)), (MUSIC, closed(70.0))]);
        assert!(mac.live());
        // "Mac: the list offers Music and Spotify, and which is running"
        let list = mac.list().await.unwrap();
        assert_eq!(
            as_json(&list.apps),
            r#"[{"key":"music","name":"Music","running":false,"level":null},{"key":"spotify","name":"Spotify","running":true,"level":0.3}]"#
        );
        assert_eq!(list.platform, "darwin");
        assert!(note_of(&list).contains("only Music and Spotify"));
        // "Mac: a level set reads back"
        assert_eq!(mac.write("spotify", "Spotify", 0.55).await, Ok(0.55));
        assert_eq!(mac.read("spotify").await, Ok(Some(0.55)));
        assert_eq!(runner.volume(SPOTIFY), 55.0);
        // "Mac: a write to a closed app says so, kindly"
        let closed = mac.write("music", "Music", 0.5).await.unwrap_err();
        assert!(closed.is_app_not_playing());
        assert_eq!(
            closed.message(),
            "Music is not open on this computer right now. Open it first, then try again."
        );
        // "Mac: a closed app's volume is left alone"
        assert_eq!(runner.volume(MUSIC), 70.0);
        // "Mac: a closed app reads as unknown"
        assert_eq!(mac.read("music").await, Ok(None));
        // "Mac: any other app is refused with the reason"
        let before = lock(&runner.scripts).len();
        let other = mac.write("chrome", "Chrome", 0.5).await.unwrap_err();
        assert!(other.message().contains("only Music and Spotify"));
        assert!(!other.is_app_not_playing());
        let other = mac.read("chrome").await.unwrap_err();
        assert_eq!(other.said(), say(MAC_ONLY_NOTE).into());
        assert_eq!(
            lock(&runner.scripts).len(),
            before,
            "nothing was run for it"
        );
    }

    // "Mac: a missing Automation permission is explained"
    #[tokio::test(start_paused = true)]
    async fn mac_a_missing_automation_permission_is_explained() {
        let refusing = FakeMacApp {
            running: true,
            volume: 30.0,
            refuse: true,
        };
        let (mac, _runner) = mac(&[(SPOTIFY, refusing)]);
        let refused = mac.write("spotify", "Spotify", 0.5).await.unwrap_err();
        assert!(refused
            .message()
            .contains("Privacy & Security › Automation"));
        assert_eq!(
            refused.said(),
            say("server.apps.macAutomation")
                .with("app", "Spotify")
                .into()
        );
        // In the list it is open, its level unknown; Music, not there at all, is closed.
        let list = mac.list().await.unwrap();
        assert_eq!(
            as_json(&list.apps),
            r#"[{"key":"music","name":"Music","running":false,"level":null},{"key":"spotify","name":"Spotify","running":true,"level":null}]"#
        );
    }

    // "Mac: a drag's levels are coalesced, newest last" and
    // "Mac: every script sent asks "is running" first"
    #[tokio::test(start_paused = true)]
    async fn mac_a_drags_levels_are_coalesced_newest_last() {
        let (mac, runner) = mac(&[(SPOTIFY, open(30.0))]);
        let writes = futures_util::future::join_all(
            [0.1, 0.2, 0.3, 0.9].map(|level| mac.write("spotify", "Spotify", level)),
        )
        .await;
        sleep(Duration::from_millis(400)).await;
        assert_eq!(runner.sets().join(","), "10,90");
        assert_eq!(runner.volume(SPOTIFY), 90.0);
        assert_eq!(writes, [Ok(0.1), Ok(0.2), Ok(0.3), Ok(0.9)]);
        let scripts = lock(&runner.scripts);
        assert!(!scripts.is_empty());
        for script in scripts.iter() {
            assert!(script.find("is running") < script.find("tell "), "{script}");
        }
    }

    #[tokio::test]
    async fn mac_what_osascript_says_is_put_in_words() {
        struct Says(Result<String, String>);
        impl ScriptRunner for Says {
            fn run(&self, _script: &str) -> Answer<String, String> {
                let answer = self.0.clone();
                Box::pin(async move { answer })
            }
        }
        let ask = |answer: Result<&str, &str>| {
            let runner = Arc::new(Says(answer.map(str::to_string).map_err(str::to_string)));
            async move { MacAppVolume::new(runner).read("spotify").await }
        };
        assert_eq!(ask(Ok("42")).await, Ok(Some(0.42)));
        assert_eq!(ask(Ok("250")).await, Ok(Some(1.0)));
        assert_eq!(ask(Ok("closed")).await, Ok(None));
        let error = ask(Ok("")).await.unwrap_err();
        assert_eq!(
            error.message(),
            "Spotify answered with something that is not a volume."
        );
        let error = ask(Ok("missing value")).await.unwrap_err();
        assert_eq!(
            error.said(),
            say("server.apps.notAVolume").with("app", "Spotify").into()
        );
        let error = ask(Err("syntax error:\n  Expected end of line. (-2741)"))
            .await
            .unwrap_err();
        assert_eq!(
            error.message(),
            "Could not reach Spotify. (syntax error: Expected end of line. (-2741))"
        );
        let error = ask(Err("Not authorised to send Apple events."))
            .await
            .unwrap_err();
        assert_eq!(error.said().clone(), {
            let text: Said = say("server.apps.macAutomation")
                .with("app", "Spotify")
                .into();
            text
        });
    }

    // --------------------------------------------- what the system side decides

    // The bridge named an app by `Process.ProcessName.ToLowerInvariant()`,
    // left out the companion's own process tree, and listed an app by its
    // file description.
    #[test]
    fn windows_processes_are_named_and_owned_as_the_bridge_did() {
        assert_eq!(process_name("chrome.exe"), "chrome");
        assert_eq!(process_name("Spotify.EXE"), "Spotify");
        assert_eq!(process_name("Battle.net.exe"), "Battle.net");
        assert_eq!(process_name("System"), "System");
        assert_eq!(process_name(".exe"), ".exe");
        assert_eq!(process_name("ñandú.exe"), "ñandú");
        assert_eq!(process_key("Spotify.EXE"), "spotify");
        assert_eq!(
            process_key("Battle.net Launcher.exe"),
            "battle.net launcher"
        );
        // 10 is the companion; 11 and 12 its children, 13 a grandchild
        // listed before its parent; 20 is someone else's, 0 is nobody's.
        let processes = [
            (13, 12),
            (11, 10),
            (12, 10),
            (20, 4),
            (4, 0),
            (0, 0),
            (21, 20),
        ];
        let ours = own_processes(10, &processes);
        assert_eq!(ours, HashSet::from([10, 11, 12, 13]));
        assert_eq!(own_processes(0, &processes), HashSet::from([0, 4, 20, 21]));
        assert_eq!(own_processes(99, &[]), HashSet::from([99]));
        assert_eq!(
            friendly_name(Some(" Google Chrome "), "chrome"),
            "Google Chrome"
        );
        assert_eq!(friendly_name(Some("   "), "foobar2000"), "foobar2000");
        assert_eq!(friendly_name(None, "Game"), "Game");
    }

    #[test]
    fn linux_streams_are_keyed_by_their_program() {
        assert_eq!(
            stream_key(Some("firefox"), Some("Firefox")).as_deref(),
            Some("firefox")
        );
        assert_eq!(
            stream_key(Some("/usr/bin/Spotify"), None).as_deref(),
            Some("spotify")
        );
        assert_eq!(
            stream_key(None, Some("Chromium")).as_deref(),
            Some("chromium")
        );
        assert_eq!(
            stream_key(Some("?"), Some("VLC media player")).as_deref(),
            Some("vlc media player")
        );
        assert_eq!(stream_key(Some(""), Some("")), None);
        assert_eq!(stream_key(None, None), None);
        assert_eq!(pulse_level(&[0x10000, 0x8000]), 1.0);
        assert_eq!(pulse_level(&[0x8000, 0x4000]), 0.5);
        assert_eq!(pulse_level(&[0x20000]), 1.0);
        assert_eq!(pulse_level(&[]), 0.0);
        assert_eq!(pulse_channels(&[0x8000, 0x4000], 1.0), [0x10000, 0x8000]);
        assert_eq!(pulse_channels(&[0, 0], 0.5), [0x8000, 0x8000]);
        assert_eq!(pulse_channels(&[0x10000], 0.25), [0x4000]);
        assert_eq!(pulse_channels(&[0x10000, 0x10000], 7.0), [0x10000, 0x10000]);
        assert_eq!(pulse_channels(&[0x3000, 0x3000], 0.0), [0, 0]);
        // What was set reads back as the level a fader shows.
        for step in 0..=1000 {
            let level = f64::from(step) / 1000.0;
            let set = pulse_channels(&[0x7777, 0x7777], level);
            assert_eq!(round_level(pulse_level(&set)), level);
        }
    }

    // ------------------------------------------------------------ elsewhere

    // "Linux: an empty list with a note" and "Linux: a write is refused in
    // words", now for a system that is none of the three.
    #[tokio::test]
    async fn elsewhere_there_is_nothing_to_offer() {
        let other = OtherAppVolume::new("freebsd");
        assert!(!other.live());
        let list = other.list().await.unwrap();
        assert!(list.apps.is_empty());
        assert_eq!(list.platform, "freebsd");
        assert!(note_of(&list).contains("Windows and macOS only"));
        let refused = other.write("x", "X", 0.5).await.unwrap_err();
        assert!(refused.message().contains("Windows and macOS only"));
        assert_eq!(other.read("x").await, Ok(None));
    }
}
