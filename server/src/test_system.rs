//! A stand-in for the computer, for tests.
//!
//! Tests must never touch the real computer: no sound through its speakers,
//! no change to its volume, no application started, no browser opened. With
//! `PUNCHBOARD_TEST_SYSTEM=<folder>` set, the companion writes down what it
//! would have done instead, in that folder:
//!
//! ```text
//! sounds.jsonl     what the sound output was asked, one JSON object a line:
//!                    {"play":{"id":3,"file":"/…/sound-4.wav","gain":0.25}}
//!                    {"gain":0.5}   {"stop":3}   {"close":true}
//!                  A sound "plays" until it is stopped (a file that is not
//!                  there fails as it would on the real output).
//! opened.jsonl     what would have been opened, one JSON object a line:
//!                    {"launch":"/Applications/Notes.app"}
//!                    {"url":"https://twitch.tv/x"}   {"path":"/some/file"}
//! volume.json      the volumes the companion sees, read at every request
//!                  and written when a fader sets one:
//!                    {"main":0.5,"apps":{"chrome":{"name":"Google Chrome","level":0.4}}}
//!                  A missing file is a main volume of 0.5 and no apps. An
//!                  app that is not listed is not playing. (Windows and
//!                  Linux faders; on macOS only "main" is used.)
//! volume.jsonl     every change asked of it, one JSON object a line:
//!                    {"main":0.3}   {"app":"chrome","level":0.2}
//! mac-apps.json    macOS only. Music and Spotify, by bundle id, as the
//!                  AppleScript would find them:
//!                    {"com.spotify.client":{"running":true,"volume":30}}
//!                  ("refuse": true makes the app refuse, as without the
//!                  Automation permission). A missing file or app is "closed".
//! osascript.jsonl  macOS only. Every script that would have run, one JSON
//!                  string a line. No script is ever run.
//! keys.log         key events (see `keys::LogSink`), unless
//!                  PUNCHBOARD_KEYS_LOG names another file.
//! pointer.log      pointer commands, unless PUNCHBOARD_POINTER_LOG names
//!                  another file.
//! ```
//!
//! tests/companion.mjs sets it for every companion it starts.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Map, Value};

use crate::apps::{Computer, Failure};
use crate::audio::app_volume::AppVolume;
use crate::audio::player::{Ended, Lost, Output, OutputFactory, PlayFailure};
use crate::audio::{Answer, Audio, SystemApp, SystemAudio};
use crate::i18n::UserError;
use crate::store::stringify;

/// The folder named by `PUNCHBOARD_TEST_SYSTEM`, when a test set it.
pub fn folder() -> Option<PathBuf> {
    std::env::var_os("PUNCHBOARD_TEST_SYSTEM")
        .filter(|folder| !folder.is_empty())
        .map(PathBuf::from)
}

/// Keys and the pointer go to files in the folder too, unless their own
/// variables already say where. Called once, before anything else runs.
pub fn redirect_input(folder: &Path) {
    for (variable, file) in [
        ("PUNCHBOARD_KEYS_LOG", "keys.log"),
        ("PUNCHBOARD_POINTER_LOG", "pointer.log"),
    ] {
        if std::env::var_os(variable).is_none_or(|value| value.is_empty()) {
            std::env::set_var(variable, folder.join(file));
        }
    }
}

/// Appends one line to a file of the folder. A folder that cannot be
/// written loses the line: the test reading it fails, which says so.
fn append(file: &Path, line: &Value) {
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .and_then(|mut file| file.write_all((stringify(line) + "\n").as_bytes()));
}

fn read_object(file: &Path) -> Map<String, Value> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| match value {
            Value::Object(object) => Some(object),
            _ => None,
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------------ sounds

/// The sound output: writes down what it is asked and plays nothing.
struct RecordedOutput {
    log: PathBuf,
}

impl Output for RecordedOutput {
    fn play(&mut self, id: u64, file: &Path, gain: f32, _ended: Ended) -> Result<(), PlayFailure> {
        if !file.is_file() {
            return Err(PlayFailure::Missing);
        }
        let gain = crate::audio::float_as_printed(gain);
        append(
            &self.log,
            &json!({ "play": { "id": id, "file": file.to_string_lossy(), "gain": gain } }),
        );
        Ok(())
    }

    fn set_gain(&mut self, gain: f32) {
        append(
            &self.log,
            &json!({ "gain": crate::audio::float_as_printed(gain) }),
        );
    }

    fn stop(&mut self, id: u64) {
        append(&self.log, &json!({ "stop": id }));
    }

    fn close(&mut self) {
        append(&self.log, &json!({ "close": true }));
    }
}

/// What the player plays through, in a test.
pub fn sound_output(folder: &Path) -> OutputFactory {
    let log = folder.join("sounds.jsonl");
    Arc::new(move |_lost: Lost| Box::new(RecordedOutput { log: log.clone() }) as Box<dyn Output>)
}

// ----------------------------------------------------- apps, links, files

/// The computer, as far as opening things goes: nothing is opened.
pub struct RecordedComputer {
    log: PathBuf,
}

impl RecordedComputer {
    pub fn new(folder: &Path) -> RecordedComputer {
        RecordedComputer {
            log: folder.join("opened.jsonl"),
        }
    }
}

impl Computer for RecordedComputer {
    fn launch(&self, target: &str) -> Result<(), Failure> {
        append(&self.log, &json!({ "launch": target }));
        Ok(())
    }

    fn open_url(&self, address: &str) -> Result<(), String> {
        append(&self.log, &json!({ "url": address }));
        Ok(())
    }

    fn open_path(&self, path: &str) -> Result<(), String> {
        append(&self.log, &json!({ "path": path }));
        Ok(())
    }
}

// ----------------------------------------------------------------- volumes

/// The volumes of volume.json.
struct RecordedAudio {
    state: PathBuf,
    log: PathBuf,
}

impl RecordedAudio {
    fn main(&self) -> f64 {
        read_object(&self.state)
            .get("main")
            .and_then(Value::as_f64)
            .unwrap_or(0.5)
    }

    fn apps(&self) -> Map<String, Value> {
        match read_object(&self.state).remove("apps") {
            Some(Value::Object(apps)) => apps,
            _ => Map::new(),
        }
    }

    fn level_of(app: &Value) -> f64 {
        app.get("level").and_then(Value::as_f64).unwrap_or(0.0)
    }

    fn write(&self, change: impl FnOnce(&mut Map<String, Value>)) {
        let mut state = read_object(&self.state);
        change(&mut state);
        if let Some(folder) = self.state.parent() {
            let _ = std::fs::create_dir_all(folder);
        }
        let _ = std::fs::write(&self.state, stringify(&Value::Object(state)));
    }
}

fn answer<T: Send + 'static>(value: T) -> Answer<T> {
    Box::pin(async move { Ok::<T, UserError>(value) })
}

impl SystemAudio for RecordedAudio {
    fn main_volume(&self) -> Answer<f64> {
        answer(self.main())
    }

    fn set_main_volume(&self, level: f64) -> Answer<f64> {
        append(&self.log, &json!({ "main": level }));
        self.write(|state| {
            state.insert("main".to_string(), json!(level));
        });
        answer(level)
    }

    fn app_volume(&self, key: &str) -> Answer<Option<f64>> {
        answer(self.apps().get(key).map(RecordedAudio::level_of))
    }

    fn set_app_volume(&self, key: &str, level: f64) -> Answer<Option<f64>> {
        append(&self.log, &json!({ "app": key, "level": level }));
        if !self.apps().contains_key(key) {
            return answer(None);
        }
        self.write(|state| {
            if let Some(app) = state
                .get_mut("apps")
                .and_then(|apps| apps.get_mut(key))
                .and_then(Value::as_object_mut)
            {
                app.insert("level".to_string(), json!(level));
            }
        });
        answer(Some(level))
    }

    fn list_apps(&self) -> Answer<Vec<SystemApp>> {
        let apps = self
            .apps()
            .iter()
            .map(|(key, app)| SystemApp {
                key: key.clone(),
                name: app
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(key)
                    .to_string(),
                level: RecordedAudio::level_of(app),
            })
            .collect();
        answer(apps)
    }
}

/// Music and Spotify as mac-apps.json has them: what `osascript` would have
/// answered each script, which is never run.
#[cfg(target_os = "macos")]
struct RecordedScripts {
    state: PathBuf,
    log: PathBuf,
}

#[cfg(target_os = "macos")]
impl RecordedScripts {
    /// What follows `before` in the script, up to `until` (or its end).
    fn after<'a>(script: &'a str, before: &str, until: char) -> Option<&'a str> {
        let rest = &script[script.find(before)? + before.len()..];
        Some(rest.split(until).next().unwrap_or(rest))
    }

    fn answer(&self, script: &str) -> Result<String, String> {
        append(&self.log, &Value::String(script.to_string()));
        if !script.contains("application id appId is running") {
            return Err("no guard".to_string());
        }
        let id = RecordedScripts::after(script, "set appId to \"", '"').unwrap_or("");
        let mut apps = read_object(&self.state);
        let running = |app: &Value| app.get("running") == Some(&Value::Bool(true));
        let Some(app) = apps.get_mut(id).filter(|app| running(app)) else {
            return Ok("closed".to_string());
        };
        if app.get("refuse") == Some(&Value::Bool(true)) {
            return Err(format!(
                "execution error: Not authorized to send Apple events to {id}. (-1743)"
            ));
        }
        let set = RecordedScripts::after(script, "set its «class pVol» to ", '\n')
            .and_then(|digits| digits.trim().parse::<u32>().ok());
        if let (Some(volume), Some(app)) = (set, app.as_object_mut()) {
            app.insert("volume".to_string(), json!(volume));
        }
        let volume = app
            .get("volume")
            .map(crate::model::js::to_string)
            .unwrap_or_default();
        if set.is_some() {
            let _ = std::fs::write(&self.state, stringify(&Value::Object(apps)));
        }
        Ok(volume)
    }
}

#[cfg(target_os = "macos")]
impl crate::audio::app_volume::ScriptRunner for RecordedScripts {
    fn run(&self, script: &str) -> Answer<String, String> {
        let answered = self.answer(script);
        Box::pin(async move { answered })
    }
}

/// The volumes a test's companion sees and sets: the files of the folder.
pub fn audio(folder: &Path) -> Audio {
    let system: Arc<dyn SystemAudio> = Arc::new(RecordedAudio {
        state: folder.join("volume.json"),
        log: folder.join("volume.jsonl"),
    });
    #[cfg(target_os = "macos")]
    {
        // A Mac's app faders are Music and Spotify, whatever the mixer holds.
        let scripts = Arc::new(RecordedScripts {
            state: folder.join("mac-apps.json"),
            log: folder.join("osascript.jsonl"),
        });
        let apps: Arc<dyn AppVolume> =
            Arc::new(crate::audio::app_volume::MacAppVolume::new(scripts));
        Audio::from_parts(system, apps)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let platform = if cfg!(windows) { "win32" } else { "linux" };
        let apps: Arc<dyn AppVolume> = Arc::new(crate::audio::app_volume::MixerAppVolume::new(
            platform,
            system.clone(),
        ));
        Audio::from_parts(system, apps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::player::{Player, PlayerOptions};
    use std::time::Duration;

    fn lines(file: &Path) -> Vec<Value> {
        std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn what_would_be_opened_is_written_down() {
        let folder = tempfile::tempdir().unwrap();
        let computer = RecordedComputer::new(folder.path());
        crate::apps::launch_with(&computer, "/Applications/Notes.app").unwrap();
        crate::apps::open_url_with(&computer, "twitch.tv/x").unwrap();
        crate::apps::open_path_with(&computer, "/tmp/file").unwrap();
        assert_eq!(
            lines(&folder.path().join("opened.jsonl")),
            vec![
                json!({ "launch": "/Applications/Notes.app" }),
                json!({ "url": "https://twitch.tv/x" }),
                json!({ "path": "/tmp/file" }),
            ]
        );
    }

    #[tokio::test]
    async fn volumes_are_read_from_the_file_and_written_to_it() {
        let folder = tempfile::tempdir().unwrap();
        let audio = audio(folder.path());
        assert_eq!(audio.system.read().await.unwrap(), 0.5);
        assert_eq!(audio.system.write(0.25).await.unwrap(), 0.25);
        assert_eq!(audio.system.read().await.unwrap(), 0.25);
        assert_eq!(
            lines(&folder.path().join("volume.jsonl")),
            vec![json!({ "main": 0.25 })]
        );
        let state: Value =
            serde_json::from_slice(&std::fs::read(folder.path().join("volume.json")).unwrap())
                .unwrap();
        assert_eq!(state, json!({ "main": 0.25 }));
    }

    #[cfg(not(target_os = "macos"))]
    #[tokio::test]
    async fn app_volumes_are_the_files_too() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(
            folder.path().join("volume.json"),
            r#"{"apps":{"chrome":{"name":"Google Chrome","level":0.4}}}"#,
        )
        .unwrap();
        let audio = audio(folder.path());
        assert_eq!(audio.apps.read("chrome").await.unwrap(), Some(0.4));
        assert_eq!(audio.apps.read("nothing").await.unwrap(), None);
        assert_eq!(
            audio.apps.write("chrome", "Chrome", 0.2).await.unwrap(),
            0.2
        );
        assert_eq!(audio.apps.read("chrome").await.unwrap(), Some(0.2));
        assert!(audio
            .apps
            .write("nothing", "Nothing", 0.2)
            .await
            .unwrap_err()
            .is_app_not_playing());
        let list = audio.apps.list().await.unwrap();
        assert_eq!(list.apps.len(), 1);
        assert_eq!(list.apps[0].name, "Google Chrome");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn mac_apps_answer_from_their_file_and_no_script_runs() {
        let folder = tempfile::tempdir().unwrap();
        std::fs::write(
            folder.path().join("mac-apps.json"),
            r#"{"com.spotify.client":{"running":true,"volume":30},"com.apple.Music":{"running":false,"volume":70}}"#,
        )
        .unwrap();
        let audio = audio(folder.path());
        assert_eq!(audio.apps.read("spotify").await.unwrap(), Some(0.3));
        assert_eq!(audio.apps.read("music").await.unwrap(), None);
        assert_eq!(
            audio.apps.write("spotify", "Spotify", 0.5).await.unwrap(),
            0.5
        );
        assert_eq!(audio.apps.read("spotify").await.unwrap(), Some(0.5));
        assert!(audio
            .apps
            .write("music", "Music", 0.5)
            .await
            .unwrap_err()
            .is_app_not_playing());
        let state: Value =
            serde_json::from_slice(&std::fs::read(folder.path().join("mac-apps.json")).unwrap())
                .unwrap();
        assert_eq!(state["com.spotify.client"]["volume"], json!(50));
        assert_eq!(state["com.apple.Music"]["volume"], json!(70));
        let scripts = lines(&folder.path().join("osascript.jsonl"));
        assert_eq!(scripts.len(), 5);
        assert!(scripts
            .iter()
            .all(|script| script.as_str().unwrap().contains("is running")));
    }

    #[test]
    fn sounds_are_written_down_and_not_played() {
        let folder = tempfile::tempdir().unwrap();
        let sound = folder.path().join("sound.wav");
        std::fs::write(&sound, b"RIFF").unwrap();
        let (ended_tx, ended) = std::sync::mpsc::channel();
        let player = Player::with_output(
            PlayerOptions {
                volume: Box::new(|| 0.5),
                on_ended: Box::new(move |slot, ran| {
                    let _ = ended_tx.send((slot, ran));
                }),
                log: Box::new(|_| {}),
                idle_close: Duration::from_secs(5),
            },
            sound_output(folder.path()),
        );
        // The output is asked on the player's own thread.
        let log = folder.path().join("sounds.jsonl");
        let wait_for = |count: usize| {
            for _ in 0..500 {
                if lines(&log).len() >= count {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        player.play(3, &sound).unwrap();
        assert_eq!(player.playing(), vec![3]);
        wait_for(1);
        assert!(player.stop(3));
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(5)).unwrap(),
            (3, None)
        );
        // A file that is not there fails as it would on the real output.
        player.play(4, &folder.path().join("missing.wav")).unwrap();
        assert_eq!(
            ended.recv_timeout(Duration::from_secs(5)).unwrap(),
            (4, None)
        );
        player.dispose();
        wait_for(2);
        let written = lines(&log);
        assert_eq!(written[0]["play"]["gain"], json!(0.25));
        assert_eq!(written[0]["play"]["file"], json!(sound.to_string_lossy()));
        assert_eq!(written[1], json!({ "stop": written[0]["play"]["id"] }));
    }
}
