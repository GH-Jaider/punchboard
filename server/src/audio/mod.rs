//! Faders: the computer's volume and each application's own.
//!
//! * [`volume`]: fader targets (`read_level` / `write_level`), each on its own
//!   scale, and the computer's main volume.
//! * [`app_volume`]: one application's volume, for "App volume" faders.
//! * [`app_levels`]: the poll that notices app volumes changed elsewhere.
//! * `system_windows`, `system_mac`, `system_linux`: the calls into each
//!   system, behind [`SystemAudio`].
//!
//! This file holds what those share: the [`SystemAudio`] trait, and
//! [`AudioThread`], the thread that owns a system's audio objects (COM on
//! Windows, the PulseAudio connection on Linux) and answers one request at
//! a time. It is what the long-lived PowerShell bridge of win-volume.ts
//! became: each request still has an id its answer repeats, so an answer
//! that comes late (or never) cannot reach the wrong request.

pub mod app_levels;
pub mod app_volume;
pub mod player;
pub mod volume;

#[cfg(target_os = "linux")]
pub mod system_linux;
#[cfg(target_os = "macos")]
pub mod system_mac;
#[cfg(windows)]
pub mod system_windows;

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::oneshot;

use crate::i18n::{say, Said, UserError};
use crate::model::js;

use app_volume::AppVolume;
use volume::SystemVolume;

/// What a call into the system answers, later.
pub type Answer<T, E = UserError> = Pin<Box<dyn Future<Output = Result<T, E>> + Send>>;

/// An app with an audio session, as the system lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct SystemApp {
    /// What a fader stores: the process name without .exe, lower-cased.
    pub key: String,
    /// The name people know it by ("Google Chrome").
    pub name: String,
    /// 0..1.
    pub level: f64,
}

/// One system's volumes. Levels are 0..1.
pub trait SystemAudio: Send + Sync {
    /// The main output's volume.
    fn main_volume(&self) -> Answer<f64>;
    /// Sets the main output's volume and answers the level it now has.
    fn set_main_volume(&self, level: f64) -> Answer<f64>;
    /// One app's volume, or `None` when it is not playing through the system
    /// right now (it has no audio session; on a Mac, it is closed).
    fn app_volume(&self, key: &str) -> Answer<Option<f64>>;
    /// Sets every session of the app; `None` when it has none.
    fn set_app_volume(&self, key: &str, level: f64) -> Answer<Option<f64>>;
    /// Every app with an audio session, without Punchboard's own processes.
    fn list_apps(&self) -> Answer<Vec<SystemApp>>;
    /// Lets go of the system. Anything still waiting fails at once.
    fn stop(&self) {}
}

/// An error a fader can end in.
#[derive(Debug, Clone, PartialEq)]
pub enum VolumeError {
    /// Something to tell the person, in their language.
    User(UserError),
    /// A write to an app that cannot take one right now: closed, or
    /// (Windows, Linux) not playing through the mixer. Its level is unknown
    /// from then on. (`AppNotPlayingError` in the TypeScript.)
    AppNotPlaying(UserError),
    /// Words from elsewhere (OBS's own error), used as they are.
    Plain(String),
}

impl VolumeError {
    /// What it says, translatable when it came from Punchboard itself.
    pub fn said(&self) -> Said {
        match self {
            VolumeError::User(error) | VolumeError::AppNotPlaying(error) => {
                Said::Text(error.text.clone())
            }
            VolumeError::Plain(text) => Said::Plain(text.clone()),
        }
    }

    pub fn is_app_not_playing(&self) -> bool {
        matches!(self, VolumeError::AppNotPlaying(_))
    }

    /// The English wording, for logs.
    pub fn message(&self) -> &str {
        match self {
            VolumeError::User(error) | VolumeError::AppNotPlaying(error) => error.message(),
            VolumeError::Plain(text) => text,
        }
    }
}

impl From<UserError> for VolumeError {
    fn from(error: UserError) -> Self {
        VolumeError::User(error)
    }
}

impl std::fmt::Display for VolumeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for VolumeError {}

// ------------------------------------------------------- numbers, both ways

/// `Math.max(0, Math.min(1, Number(value) || 0))` for a number: what is not
/// a number is 0.
pub fn clamp01(value: f64) -> f64 {
    if value.is_nan() {
        return 0.0;
    }
    js::max(0.0, js::min(1.0, value))
}

/// `Number(level.toFixed(3))`: the three decimals a level is sent to the
/// system with. JavaScript rounds the number's exact value, and a tie goes
/// up; so the exact digits are written out and rounded here.
pub fn fixed3(level: f64) -> f64 {
    if !level.is_finite() {
        return level;
    }
    let negative = level < 0.0;
    // Every f64 is a decimal of at most 1074 places; a level in 0..1 that
    // was a JSON number is far shorter, and a longer one only loses digits
    // past where a tie could be decided.
    let exact = format!("{:.1100}", level.abs());
    let (whole, fraction) = exact.split_once('.').unwrap_or((&exact, ""));
    let (kept, rest) = fraction.split_at(3.min(fraction.len()));
    let mut thousandths: u128 = match format!("{whole}{kept}").parse() {
        Ok(digits) => digits,
        // Too large to be a level: nothing to round.
        Err(_) => return level,
    };
    if rest.as_bytes().first().is_some_and(|digit| *digit >= b'5') {
        thousandths += 1;
    }
    let text = format!("{}.{:03}", thousandths / 1000, thousandths % 1000);
    let value: f64 = text.parse().unwrap_or(level);
    if negative {
        -value
    } else {
        value
    }
}

/// A Windows level as the bridge printed it: .NET Framework wrote a `float`
/// with seven significant digits ("0.4", not 0.4000000059604645), and that
/// text was the number the decks got.
pub fn float_as_printed(level: f32) -> f64 {
    if !level.is_finite() {
        return 0.0;
    }
    format!("{:.6e}", f64::from(level)).parse().unwrap_or(0.0)
}

// ------------------------------------------------------ the system's thread

/// The calls one system answers, made on the thread that owns its objects.
/// A failure is the system's own words, shown after what did not happen.
pub trait AudioBackend {
    fn main_volume(&mut self) -> Result<f64, String>;
    fn set_main_volume(&mut self, level: f64) -> Result<f64, String>;
    fn app_volume(&mut self, key: &str) -> Result<Option<f64>, String>;
    fn set_app_volume(&mut self, key: &str, level: f64) -> Result<Option<f64>, String>;
    fn list_apps(&mut self) -> Result<Vec<SystemApp>, String>;
}

/// Makes the backend, on its thread. Called again for the next request when
/// it failed (no audio service yet).
pub type MakeBackend = Arc<dyn Fn() -> Result<Box<dyn AudioBackend>, String> + Send + Sync>;

/// The message keys one system's thread fails with.
#[derive(Clone, Copy, Debug)]
pub struct ThreadMessages {
    /// "{what}: {reason}".
    pub failed: &'static str,
    /// What did not happen, by request.
    pub no_read: &'static str,
    pub no_change: &'static str,
    pub no_app_read: &'static str,
    pub no_app_change: &'static str,
    pub no_list: &'static str,
    pub slow_answer: &'static str,
    pub helper_stopped: &'static str,
    pub stopped: &'static str,
}

/// How long one answer may take.
pub const ANSWER_MS: u64 = 8000;

enum Command {
    Get,
    Set(f64),
    AppGet(String),
    AppSet(String, f64),
    List,
}

enum Reply {
    Level(f64),
    AppLevel(Option<f64>),
    Apps(Vec<SystemApp>),
}

struct Request {
    id: u64,
    command: Command,
}

struct Waiting {
    /// Which thread was asked.
    generation: u64,
    /// The message key that says what did not happen.
    failure: &'static str,
    reply: oneshot::Sender<Result<Reply, UserError>>,
}

#[derive(Default)]
struct State {
    /// The way to the thread; None until the first request and after a stop.
    sender: Option<mpsc::Sender<Request>>,
    /// Counts threads: a stop, or a thread that died, ends a generation.
    generation: u64,
    last_id: u64,
    waiting: HashMap<u64, Waiting>,
}

struct Shared {
    messages: ThreadMessages,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shared {
    /// Takes a request out of the waiting list: whoever settles it answers it.
    fn settle(&self, id: u64) -> Option<Waiting> {
        lock(&self.state).waiting.remove(&id)
    }

    /// Fails whatever waits on one thread.
    fn fail_all(&self, generation: u64, key: &'static str) {
        let failed: Vec<Waiting> = {
            let mut state = lock(&self.state);
            let ids: Vec<u64> = state
                .waiting
                .iter()
                .filter(|(_, entry)| entry.generation == generation)
                .map(|(id, _)| *id)
                .collect();
            ids.iter()
                .filter_map(|id| state.waiting.remove(id))
                .collect()
        };
        for entry in failed {
            let _ = entry.reply.send(Err(UserError::new(say(key))));
        }
    }
}

/// Fails what waited on a thread that ended on its own (it panicked): the
/// requests are let go, and the next one starts a new thread.
struct Gone {
    shared: Arc<Shared>,
    generation: u64,
}

impl Drop for Gone {
    fn drop(&mut self) {
        {
            let mut state = lock(&self.shared.state);
            if state.generation == self.generation {
                state.sender = None;
                state.generation += 1;
            }
        }
        self.shared
            .fail_all(self.generation, self.shared.messages.helper_stopped);
    }
}

fn answer(backend: &mut dyn AudioBackend, command: Command) -> Result<Reply, String> {
    Ok(match command {
        Command::Get => Reply::Level(clamp01(backend.main_volume()?)),
        Command::Set(level) => Reply::Level(clamp01(backend.set_main_volume(level)?)),
        Command::AppGet(key) => Reply::AppLevel(backend.app_volume(&key)?.map(clamp01)),
        Command::AppSet(key, level) => {
            Reply::AppLevel(backend.set_app_volume(&key, level)?.map(clamp01))
        }
        Command::List => Reply::Apps(app_volume::shape_apps(backend.list_apps()?)),
    })
}

fn serve(
    shared: Arc<Shared>,
    generation: u64,
    requests: mpsc::Receiver<Request>,
    make: MakeBackend,
) {
    let _gone = Gone {
        shared: shared.clone(),
        generation,
    };
    let mut backend: Option<Box<dyn AudioBackend>> = None;
    for request in requests {
        // Stopped meanwhile: what was still queued is not done.
        if lock(&shared.state).generation != generation {
            break;
        }
        if backend.is_none() {
            match make() {
                Ok(made) => backend = Some(made),
                Err(reason) => {
                    reply(&shared, request.id, Err(reason));
                    continue;
                }
            }
        }
        let Some(backend) = backend.as_mut() else {
            continue;
        };
        let result = answer(backend.as_mut(), request.command);
        reply(&shared, request.id, result);
    }
}

fn reply(shared: &Shared, id: u64, result: Result<Reply, String>) {
    // An answer nobody waits for any more (it timed out) is dropped.
    let Some(entry) = shared.settle(id) else {
        return;
    };
    let result = result.map_err(|reason| {
        UserError::new(
            say(shared.messages.failed)
                .with("what", say(entry.failure))
                .with("reason", one_line(&reason)),
        )
    });
    let _ = entry.reply.send(result);
}

/// The system's message on one line.
fn one_line(text: &str) -> String {
    text.split(['\r', '\n'])
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A system's audio, answered from the one thread that owns its objects.
/// The thread starts with the first request, and again after a [`stop`]
/// (`SystemAudio::stop`) if something still asks.
pub struct AudioThread {
    name: &'static str,
    shared: Arc<Shared>,
    make: MakeBackend,
    answer_timeout: Duration,
}

impl AudioThread {
    pub fn new(name: &'static str, messages: ThreadMessages, make: MakeBackend) -> AudioThread {
        AudioThread {
            name,
            shared: Arc::new(Shared {
                messages,
                state: Mutex::new(State::default()),
            }),
            make,
            answer_timeout: Duration::from_millis(ANSWER_MS),
        }
    }

    /// Another patience than [`ANSWER_MS`], for tests.
    pub fn with_answer_timeout(mut self, timeout: Duration) -> AudioThread {
        self.answer_timeout = timeout;
        self
    }

    /// The way to the thread, starting it if there is none.
    fn sender(&self, state: &mut State) -> Option<mpsc::Sender<Request>> {
        if let Some(sender) = &state.sender {
            return Some(sender.clone());
        }
        let (sender, requests) = mpsc::channel();
        let (shared, make, generation) = (self.shared.clone(), self.make.clone(), state.generation);
        std::thread::Builder::new()
            .name(self.name.to_string())
            .spawn(move || serve(shared, generation, requests, make))
            .ok()?;
        state.sender = Some(sender.clone());
        Some(sender)
    }

    /// Sends one request; answers with its reply. `failure` is the message
    /// key that says what did not happen.
    fn ask(&self, command: Command, failure: &'static str) -> Answer<Reply> {
        let messages = self.shared.messages;
        let stopped = || UserError::new(say(messages.helper_stopped));
        let (id, answer) = {
            let mut state = lock(&self.shared.state);
            let Some(sender) = self.sender(&mut state) else {
                return Box::pin(async move { Err(stopped()) });
            };
            state.last_id += 1;
            let id = state.last_id;
            let (reply, answer) = oneshot::channel();
            let generation = state.generation;
            state.waiting.insert(
                id,
                Waiting {
                    generation,
                    failure,
                    reply,
                },
            );
            if sender.send(Request { id, command }).is_err() {
                // The thread is gone; its `Gone` clears the way for the next.
                state.waiting.remove(&id);
                state.sender = None;
                return Box::pin(async move { Err(stopped()) });
            }
            (id, answer)
        };
        let (shared, patience) = (self.shared.clone(), self.answer_timeout);
        Box::pin(async move {
            match tokio::time::timeout(patience, answer).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(stopped()),
                Err(_) => {
                    // Its answer, if it ever comes, is for nobody.
                    shared.settle(id);
                    Err(UserError::new(say(messages.slow_answer)))
                }
            }
        })
    }

    fn ask_level(&self, command: Command, failure: &'static str) -> Answer<f64> {
        let (asked, messages) = (self.ask(command, failure), self.shared.messages);
        Box::pin(async move {
            match asked.await? {
                Reply::Level(level) => Ok(level),
                _ => Err(UserError::new(say(messages.helper_stopped))),
            }
        })
    }

    fn ask_app_level(&self, command: Command, failure: &'static str) -> Answer<Option<f64>> {
        let (asked, messages) = (self.ask(command, failure), self.shared.messages);
        Box::pin(async move {
            match asked.await? {
                Reply::AppLevel(level) => Ok(level),
                _ => Err(UserError::new(say(messages.helper_stopped))),
            }
        })
    }
}

impl SystemAudio for AudioThread {
    fn main_volume(&self) -> Answer<f64> {
        self.ask_level(Command::Get, self.shared.messages.no_read)
    }

    fn set_main_volume(&self, level: f64) -> Answer<f64> {
        self.ask_level(Command::Set(fixed3(level)), self.shared.messages.no_change)
    }

    fn app_volume(&self, key: &str) -> Answer<Option<f64>> {
        self.ask_app_level(
            Command::AppGet(key.to_string()),
            self.shared.messages.no_app_read,
        )
    }

    fn set_app_volume(&self, key: &str, level: f64) -> Answer<Option<f64>> {
        self.ask_app_level(
            Command::AppSet(key.to_string(), fixed3(level)),
            self.shared.messages.no_app_change,
        )
    }

    fn list_apps(&self) -> Answer<Vec<SystemApp>> {
        let (asked, messages) = (
            self.ask(Command::List, self.shared.messages.no_list),
            self.shared.messages,
        );
        Box::pin(async move {
            match asked.await? {
                Reply::Apps(apps) => Ok(apps),
                _ => Err(UserError::new(say(messages.helper_stopped))),
            }
        })
    }

    /// Closes the thread's queue. Anything still waiting fails at once, and
    /// what was queued behind the request in hand is not done.
    fn stop(&self) {
        let generation = {
            let mut state = lock(&self.shared.state);
            if state.sender.take().is_none() {
                return;
            }
            state.generation += 1;
            state.generation - 1
        };
        self.shared
            .fail_all(generation, self.shared.messages.stopped);
    }
}

// --------------------------------------------------------- this computer's

/// The volumes of one computer: what the server makes once and hands to the
/// fader routes and the app-level poll.
pub struct Audio {
    /// The main output, for "This computer's volume" faders.
    pub system: SystemVolume,
    /// Per-app volume, for "App volume" faders and the picker's list.
    pub apps: Arc<dyn AppVolume>,
    audio: Option<Arc<dyn SystemAudio>>,
}

impl Audio {
    /// This computer's volumes. Nothing is opened until the first request.
    pub fn for_this_computer() -> Audio {
        #[cfg(windows)]
        {
            let audio: Arc<dyn SystemAudio> = Arc::new(system_windows::audio_thread());
            Audio::with_mixer("win32", audio)
        }
        #[cfg(target_os = "linux")]
        {
            let audio: Arc<dyn SystemAudio> = Arc::new(system_linux::audio_thread());
            Audio::with_mixer("linux", audio)
        }
        #[cfg(target_os = "macos")]
        {
            let scripts: Arc<dyn app_volume::ScriptRunner> = Arc::new(system_mac::Osascript);
            let audio: Arc<dyn SystemAudio> = Arc::new(system_mac::MacAudio::new(scripts.clone()));
            Audio {
                system: SystemVolume::new(Some(audio.clone())),
                apps: Arc::new(app_volume::MacAppVolume::new(scripts)),
                audio: Some(audio),
            }
        }
        #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
        {
            Audio {
                system: SystemVolume::new(None),
                apps: Arc::new(app_volume::OtherAppVolume::new(std::env::consts::OS)),
                audio: None,
            }
        }
    }

    /// A system with a real per-app mixer (Windows, Linux), or a stand-in
    /// for one in tests. `platform` is what Node called it: "win32", "linux".
    pub fn with_mixer(platform: &'static str, audio: Arc<dyn SystemAudio>) -> Audio {
        Audio {
            system: SystemVolume::new(Some(audio.clone())),
            apps: Arc::new(app_volume::MixerAppVolume::new(platform, audio.clone())),
            audio: Some(audio),
        }
    }

    /// Volumes made elsewhere: a main output and the app volumes that go
    /// with it (the stand-ins of `test_system`).
    pub fn from_parts(audio: Arc<dyn SystemAudio>, apps: Arc<dyn AppVolume>) -> Audio {
        Audio {
            system: SystemVolume::new(Some(audio.clone())),
            apps,
            audio: Some(audio),
        }
    }

    /// For when the companion closes (`stopWindowsVolume` in the
    /// TypeScript): whatever waits fails at once, and a main-volume write
    /// still queued is dropped rather than opening the system again.
    pub fn stop(&self) {
        self.system.stop();
        if let Some(audio) = &self.audio {
            audio.stop();
        }
    }
}

/// The fixtures tests/fixtures/make-volume.ts wrote from the TypeScript.
#[cfg(test)]
pub(crate) mod testing {
    use serde_json::Value;
    use std::path::Path;

    /// The cases of one fixture file: `{ input, output }` each.
    pub fn cases(file: &str) -> Vec<Value> {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/volume")
            .join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::english;
    use std::sync::atomic::{AtomicU32, Ordering};

    const WINDOWS: ThreadMessages = ThreadMessages {
        failed: "server.winVolume.failed",
        no_read: "server.winVolume.noChange",
        no_change: "server.winVolume.noChange",
        no_app_read: "server.winVolume.noAppRead",
        no_app_change: "server.winVolume.noAppChange",
        no_list: "server.winVolume.noList",
        slow_answer: "server.winVolume.slowAnswer",
        helper_stopped: "server.winVolume.helperStopped",
        stopped: "server.winVolume.stopped",
    };

    type Calls = Arc<Mutex<Vec<String>>>;

    /// A stand-in system: the first reads answer 0.1, 0.2…; later ones hang
    /// as long as it is told; sets answer what was set.
    struct Fake {
        calls: Calls,
        gets: u32,
        hang_after: u32,
        hang: Duration,
    }

    impl AudioBackend for Fake {
        fn main_volume(&mut self) -> Result<f64, String> {
            self.gets += 1;
            lock(&self.calls).push("get".to_string());
            if self.gets > self.hang_after {
                std::thread::sleep(self.hang);
            }
            Ok(f64::from(self.gets) / 10.0)
        }
        fn set_main_volume(&mut self, level: f64) -> Result<f64, String> {
            lock(&self.calls).push(format!("set {level}"));
            Ok(level)
        }
        fn app_volume(&mut self, key: &str) -> Result<Option<f64>, String> {
            lock(&self.calls).push(format!("app-get {key}"));
            match key {
                "broken" => Err("No such\r\ninterface\nsupported".to_string()),
                "loud" => Ok(Some(7.0)),
                "chrome" => Ok(Some(0.25)),
                _ => Ok(None),
            }
        }
        fn set_app_volume(&mut self, key: &str, level: f64) -> Result<Option<f64>, String> {
            lock(&self.calls).push(format!("app-set {level} {key}"));
            Ok((key == "chrome").then_some(level))
        }
        fn list_apps(&mut self) -> Result<Vec<SystemApp>, String> {
            lock(&self.calls).push("list".to_string());
            Ok(vec![
                SystemApp {
                    key: "chrome".to_string(),
                    name: "  Google Chrome ".to_string(),
                    level: 0.5,
                },
                SystemApp {
                    key: String::new(),
                    name: "no key".to_string(),
                    level: 0.5,
                },
                SystemApp {
                    key: "x".to_string(),
                    name: " ".to_string(),
                    level: 2.0,
                },
            ])
        }
    }

    fn thread(hang_after: u32, hang: Duration) -> (AudioThread, Calls) {
        let calls: Calls = Arc::default();
        let seen = calls.clone();
        let make: MakeBackend = Arc::new(move || {
            Ok(Box::new(Fake {
                calls: seen.clone(),
                gets: 0,
                hang_after,
                hang,
            }) as Box<dyn AudioBackend>)
        });
        (AudioThread::new("test-audio", WINDOWS, make), calls)
    }

    // tests/sounds.test.mjs: "Windows volume: answers that come back out of
    // order reach the right request" and "an answer for nobody is not handed
    // to the next request". The bridge's ids became one channel per request.
    #[tokio::test]
    async fn each_request_gets_its_own_answer() {
        let (audio, calls) = thread(u32::MAX, Duration::ZERO);
        assert_eq!(audio.main_volume().await.unwrap(), 0.1);
        let answers = futures_util::future::join_all([
            audio.main_volume(),
            audio.main_volume(),
            audio.main_volume(),
        ])
        .await;
        let answers: Vec<f64> = answers.into_iter().map(Result::unwrap).collect();
        assert_eq!(answers, [0.2, 0.3, 0.4]);
        assert_eq!(audio.set_main_volume(0.5).await.unwrap(), 0.5);
        assert_eq!(lock(&calls).join("|"), "get|get|get|get|set 0.5");
    }

    #[tokio::test]
    async fn a_late_answer_is_for_nobody() {
        let (audio, _calls) = thread(1, Duration::from_millis(300));
        let audio = audio.with_answer_timeout(Duration::from_millis(100));
        assert_eq!(audio.main_volume().await.unwrap(), 0.1);
        // The second read hangs past the patience: it fails in words…
        let slow = audio.main_volume().await.unwrap_err();
        assert_eq!(slow.text.key, "server.winVolume.slowAnswer");
        assert_eq!(
            slow.message(),
            "Windows took too long to answer about the volume."
        );
        // …and its answer (0.2), when it comes, is not handed to the next request.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(audio.set_main_volume(0.75).await.unwrap(), 0.75);
    }

    // tests/sounds.test.mjs: "Windows volume: stopping fails a waiting request at once"
    #[tokio::test]
    async fn stopping_fails_a_waiting_request_at_once() {
        let (audio, calls) = thread(0, Duration::from_millis(1500));
        let asked = std::time::Instant::now();
        let hung = audio.main_volume();
        let queued = audio.set_main_volume(0.9);
        tokio::time::sleep(Duration::from_millis(50)).await;
        audio.stop();
        let outcome = hung.await.unwrap_err();
        assert!(outcome.message().contains("stopped"), "{outcome}");
        assert_eq!(outcome.text.key, "server.winVolume.stopped");
        assert_eq!(
            queued.await.unwrap_err().text.key,
            "server.winVolume.stopped"
        );
        assert!(asked.elapsed() < Duration::from_millis(1000));
        // What was queued behind the hung request is never done.
        tokio::time::sleep(Duration::from_millis(1600)).await;
        assert_eq!(lock(&calls).join("|"), "get");
        // Stopping twice is nothing; a later request starts again.
        audio.stop();
        assert_eq!(audio.set_main_volume(0.2).await.unwrap(), 0.2);
        audio.stop();
    }

    #[tokio::test]
    async fn levels_are_sent_with_three_decimals_and_answers_are_clamped() {
        let (audio, calls) = thread(u32::MAX, Duration::ZERO);
        // "app-set 0.100 chrome": the level goes out as toFixed(3) made it.
        assert_eq!(
            audio.set_app_volume("chrome", 0.12345).await.unwrap(),
            Some(0.123)
        );
        assert_eq!(audio.set_app_volume("discord", 0.5).await.unwrap(), None);
        assert_eq!(audio.set_main_volume(0.0625).await.unwrap(), 0.063);
        assert_eq!(audio.app_volume("chrome").await.unwrap(), Some(0.25));
        assert_eq!(audio.app_volume("discord").await.unwrap(), None);
        assert_eq!(audio.app_volume("loud").await.unwrap(), Some(1.0));
        assert_eq!(
            lock(&calls).join("|"),
            "app-set 0.123 chrome|app-set 0.5 discord|set 0.063|app-get chrome|app-get discord|app-get loud"
        );
    }

    #[tokio::test]
    async fn a_failure_says_what_did_not_happen_and_why() {
        let (audio, _calls) = thread(u32::MAX, Duration::ZERO);
        let error = audio.app_volume("broken").await.unwrap_err();
        assert_eq!(error.text.key, "server.winVolume.failed");
        assert_eq!(
            error.message(),
            "Windows could not read the app's volume: No such interface supported"
        );
        // The list is shaped entry by entry, like the bridge's.
        let apps = audio.list_apps().await.unwrap();
        assert_eq!(
            apps,
            [
                SystemApp {
                    key: "chrome".to_string(),
                    name: "Google Chrome".to_string(),
                    level: 0.5
                },
                SystemApp {
                    key: "x".to_string(),
                    name: "x".to_string(),
                    level: 1.0
                },
            ]
        );
    }

    #[tokio::test]
    async fn a_system_that_cannot_be_opened_is_tried_again() {
        let tries = Arc::new(AtomicU32::new(0));
        let counted = tries.clone();
        let make: MakeBackend = Arc::new(move || {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err("The audio service is not running.".to_string());
            }
            Ok(Box::new(Fake {
                calls: Arc::default(),
                gets: 0,
                hang_after: u32::MAX,
                hang: Duration::ZERO,
            }) as Box<dyn AudioBackend>)
        });
        let audio = AudioThread::new("test-audio", WINDOWS, make);
        let error = audio.list_apps().await.unwrap_err();
        assert_eq!(
            english(&Said::Text(error.text.clone())),
            "Windows could not list the apps playing sound: The audio service is not running."
        );
        assert_eq!(audio.main_volume().await.unwrap(), 0.1);
        assert_eq!(tries.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_thread_that_dies_fails_its_requests_and_the_next_starts_another() {
        struct Dies;
        impl AudioBackend for Dies {
            fn main_volume(&mut self) -> Result<f64, String> {
                panic!("the audio thread died (a test)");
            }
            fn set_main_volume(&mut self, level: f64) -> Result<f64, String> {
                Ok(level)
            }
            fn app_volume(&mut self, _key: &str) -> Result<Option<f64>, String> {
                Ok(None)
            }
            fn set_app_volume(&mut self, _key: &str, _level: f64) -> Result<Option<f64>, String> {
                Ok(None)
            }
            fn list_apps(&mut self) -> Result<Vec<SystemApp>, String> {
                Ok(Vec::new())
            }
        }
        let make: MakeBackend = Arc::new(|| Ok(Box::new(Dies) as Box<dyn AudioBackend>));
        let audio = AudioThread::new("test-audio", WINDOWS, make);
        let error = audio.main_volume().await.unwrap_err();
        assert_eq!(error.text.key, "server.winVolume.helperStopped");
        assert_eq!(audio.set_main_volume(0.3).await.unwrap(), 0.3);
    }

    #[test]
    fn numbers() {
        assert_eq!(clamp01(f64::NAN), 0.0);
        assert_eq!(clamp01(-0.5), 0.0);
        assert_eq!(clamp01(7.0), 1.0);
        assert_eq!(fixed3(0.0005), 0.001);
        assert_eq!(fixed3(0.0625), 0.063);
        assert_eq!(fixed3(1.0), 1.0);
        assert_eq!(float_as_printed(0.4_f32), 0.4);
        assert_eq!(float_as_printed(1.0_f32), 1.0);
        assert_eq!(float_as_printed(0.123_456_79_f32), 0.123_456_8);
        assert_eq!(float_as_printed(f32::NAN), 0.0);
    }
}
