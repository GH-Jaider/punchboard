//! App volumes change outside Punchboard (Spotify's own slider, the Windows
//! mixer, an app that closes) and nothing reports it, so while a device shows
//! decks and the library has app faders, their levels are read every few
//! seconds. Only changes go out: the server's `set_levels` and `drop_levels`
//! broadcast only when a level really moved. With no device connected, or no
//! app fader, nothing is read at all.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::task::AbortHandle;

use crate::model::types::{Control, FaderTarget, Library};

use super::{Answer, VolumeError};

pub const APP_POLL_MS: u64 = 2500;

/// Reads one app's level.
pub type ReadAppLevel = Box<dyn Fn(&str) -> Answer<Option<f64>, VolumeError> + Send + Sync>;
/// Takes level keys and their levels, in the order they were read.
pub type SetLevels = Box<dyn Fn(Vec<(String, f64)>) + Send + Sync>;

pub struct AppLevelsOptions {
    /// The library now. The same `Arc` while it has not been replaced.
    pub library: Box<dyn Fn() -> Arc<Library> + Send + Sync>,
    /// Whether anyone is looking: a device is connected.
    pub watched: Box<dyn Fn() -> bool + Send + Sync>,
    /// An app's level, `None` while it cannot be read (closed, silent).
    pub read: ReadAppLevel,
    pub set_levels: SetLevels,
    pub drop_levels: Box<dyn Fn(Vec<String>) + Send + Sync>,
    /// [`APP_POLL_MS`] unless a test is in a hurry.
    pub interval: Option<Duration>,
}

#[derive(Default)]
struct State {
    /// The round that is waiting to start: its number, and the way to call it off.
    timer: Option<(u64, AbortHandle)>,
    timers: u64,
    polling: bool,
    stopped: bool,
    // A read takes a moment; a deck write that lands meanwhile is newer than
    // what it read, and must not be undone by it. Writes stamp their key, and a
    // poll skips any key stamped after it started (as the OBS state does).
    tick: u64,
    written_at: HashMap<String, u64>,
    keys_for: Option<Arc<Library>>,
    keys: Vec<String>,
}

struct Inner {
    options: AppLevelsOptions,
    interval: Duration,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The poll. Cloning it gives another handle on the same one.
#[derive(Clone)]
pub struct AppLevels {
    inner: Arc<Inner>,
}

pub fn create_app_levels(options: AppLevelsOptions) -> AppLevels {
    let interval = options
        .interval
        .unwrap_or(Duration::from_millis(APP_POLL_MS));
    AppLevels {
        inner: Arc::new(Inner {
            options,
            interval,
            state: Mutex::new(State::default()),
        }),
    }
}

/// Every app an app fader points at, in the order the decks have them.
pub fn app_keys_of(library: &Library) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for profile in &library.profiles {
        for button in &profile.buttons {
            let Control::Fader { fader } = &button.control else {
                continue;
            };
            let Some(app) = fader.app.as_deref().filter(|app| !app.is_empty()) else {
                continue;
            };
            if fader.target == FaderTarget::App && !found.iter().any(|known| known == app) {
                found.push(app.to_string());
            }
        }
    }
    found
}

impl Inner {
    /// Every app an app fader points at, worked out again when the library is replaced.
    fn app_keys(&self) -> Vec<String> {
        let library = (self.options.library)();
        let mut state = lock(&self.state);
        if let Some(known) = &state.keys_for {
            if Arc::ptr_eq(known, &library) {
                return state.keys.clone();
            }
        }
        state.keys = app_keys_of(&library);
        state.keys_for = Some(library);
        state.keys.clone()
    }

    fn needed(&self) -> bool {
        !lock(&self.state).stopped && (self.options.watched)() && !self.app_keys().is_empty()
    }

    async fn poll(&self) {
        let started_at = lock(&self.state).tick;
        let mut levels: Vec<(String, f64)> = Vec::new();
        let mut gone: Vec<String> = Vec::new();
        // One app after another: on Windows they share one thread anyway.
        for key in self.app_keys() {
            // The system failed: what the decks show stays until it answers again.
            let Ok(level) = (self.options.read)(&key).await else {
                continue;
            };
            let level_key = format!("app:{key}");
            let written = lock(&self.state).written_at.get(&level_key).copied();
            if written.unwrap_or(0) > started_at {
                continue;
            }
            match level {
                None => gone.push(level_key),
                Some(level) => levels.push((level_key, level)),
            }
        }
        if lock(&self.state).stopped {
            return;
        }
        (self.options.set_levels)(levels);
        if !gone.is_empty() {
            (self.options.drop_levels)(gone);
        }
    }

    fn clear_timer(&self) {
        if let Some((_, waiting)) = lock(&self.state).timer.take() {
            waiting.abort();
        }
    }
}

fn schedule(inner: &Arc<Inner>, delay: Duration) {
    // Outside the runtime (the companion is closing) there is nothing to poll for.
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let mut state = lock(&inner.state);
    state.timers += 1;
    let (mine, round) = (state.timers, inner.clone());
    let task = runtime.spawn(async move {
        tokio::time::sleep(delay).await;
        {
            let mut state = lock(&round.state);
            // Called off, or replaced, while it waited.
            if state.timer.as_ref().map(|(number, _)| *number) != Some(mine) {
                return;
            }
            state.timer = None;
            state.polling = true;
        }
        round.poll().await;
        lock(&round.state).polling = false;
        if round.needed() {
            schedule(&round, round.interval);
        }
    });
    state.timer = Some((mine, task.abort_handle()));
}

impl AppLevels {
    /// Starts or stops polling as devices come and go and the library changes.
    pub fn update(&self) {
        if !self.inner.needed() {
            self.inner.clear_timer();
            return;
        }
        // A round in progress schedules the next itself.
        let idle = {
            let state = lock(&self.inner.state);
            state.timer.is_none() && !state.polling
        };
        if idle {
            schedule(&self.inner, Duration::ZERO);
        }
    }

    /// A deck just set this level: a poll already reading has an older one.
    pub fn note_write(&self, level_key: &str) {
        let mut state = lock(&self.inner.state);
        state.tick += 1;
        let tick = state.tick;
        state.written_at.insert(level_key.to_string(), tick);
    }

    pub fn stop(&self) {
        lock(&self.inner.state).stopped = true;
        self.inner.clear_timer();
    }

    /// Whether a round is waiting or running, for tests.
    pub fn active(&self) -> bool {
        let state = lock(&self.inner.state);
        state.timer.is_some() || state.polling
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::testing::cases;
    use crate::i18n::{say, UserError};
    use crate::model::{normalize_library, Ids};
    use crate::store::stringify;
    use crate::translate::Keys;
    use serde_json::{json, Map, Value};
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    /// What the scenario's stand-ins share: the clock, the system's table of
    /// app levels, the levels the decks show, and everything that happened.
    #[derive(Default)]
    struct World {
        now: AtomicU64,
        watched: AtomicBool,
        read_ms: AtomicU64,
        library: Mutex<Option<Arc<Library>>>,
        system: Mutex<BTreeMap<String, f64>>,
        failing: Mutex<BTreeSet<String>>,
        /// The live levels, as the server's `set_levels` / `drop_levels` keep them.
        shown: Mutex<Vec<(String, f64)>>,
        log: Mutex<Vec<Value>>,
    }

    impl World {
        fn note(&self, mut entry: Value) {
            let at = self.now.load(Ordering::SeqCst);
            let mut stamped = Map::new();
            stamped.insert("at".to_string(), json!(at));
            if let Some(fields) = entry.as_object_mut() {
                stamped.append(fields);
            }
            lock(&self.log).push(Value::Object(stamped));
        }

        fn broadcast(&self) {
            let levels: Map<String, Value> = lock(&self.shown)
                .iter()
                .map(|(key, level)| (key.clone(), json!(level)))
                .collect();
            self.note(json!({ "what": "broadcast", "levels": levels }));
        }

        /// The server's own `setLevels`: only a level that moved goes out.
        fn set_levels(&self, changes: &[(String, f64)]) {
            let mut changed = false;
            {
                let mut shown = lock(&self.shown);
                for (key, value) in changes {
                    match shown.iter_mut().find(|(known, _)| known == key) {
                        Some((_, level)) if level == value => continue,
                        Some((_, level)) => *level = *value,
                        None => shown.push((key.clone(), *value)),
                    }
                    changed = true;
                }
            }
            if changed {
                self.broadcast();
            }
        }

        fn drop_levels(&self, keys: &[String]) {
            let changed = {
                let mut shown = lock(&self.shown);
                let before = shown.len();
                shown.retain(|(known, _)| !keys.contains(known));
                shown.len() != before
            };
            if changed {
                self.broadcast();
            }
        }
    }

    fn library_of(raw: &Value) -> Arc<Library> {
        Arc::new(normalize_library(raw, &Keys, &Ids::new(|| 0)))
    }

    /// Lets every task that can run, run.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    fn poll_of(world: &Arc<World>, interval_ms: u64) -> AppLevels {
        let (library, watched, read, set, dropped) = (
            world.clone(),
            world.clone(),
            world.clone(),
            world.clone(),
            world.clone(),
        );
        create_app_levels(AppLevelsOptions {
            library: Box::new(move || lock(&library.library).clone().expect("a library")),
            watched: Box::new(move || watched.watched.load(Ordering::SeqCst)),
            read: Box::new(move |key| {
                read.note(json!({ "what": "read", "key": key }));
                // The level is taken now; a slow read answers it late, as a busy system would.
                let level = lock(&read.system).get(key).copied();
                let fails = lock(&read.failing).contains(key);
                let wait = read.read_ms.load(Ordering::SeqCst);
                Box::pin(async move {
                    if wait > 0 {
                        tokio::time::sleep(Duration::from_millis(wait)).await;
                    }
                    if fails {
                        return Err(UserError::new(say("server.winVolume.helperStopped")).into());
                    }
                    Ok(level)
                })
            }),
            set_levels: Box::new(move |levels| {
                let listed: Vec<Value> = levels
                    .iter()
                    .map(|(key, level)| json!([key, level]))
                    .collect();
                set.note(json!({ "what": "setLevels", "levels": listed }));
                set.set_levels(&levels);
            }),
            drop_levels: Box::new(move |keys| {
                dropped.note(json!({ "what": "dropLevels", "keys": keys }));
                dropped.drop_levels(&keys);
            }),
            interval: Some(Duration::from_millis(interval_ms)),
        })
    }

    /// The scenarios the TypeScript poll was run through with its timers
    /// faked: what the system reports when, and everything that results.
    #[tokio::test(start_paused = true)]
    async fn the_poll_does_what_the_typescript_did() {
        let all = cases("app-levels.json");
        assert!(all.len() >= 12);
        for case in all {
            let input = &case["input"];
            let name = input["name"].as_str().unwrap();
            let world = Arc::new(World::default());
            *lock(&world.library) = Some(library_of(&input["library"]));
            let poll = poll_of(&world, input["intervalMs"].as_u64().unwrap());
            let events = input["events"].as_array().unwrap();
            for now in 0..=input["runFor"].as_u64().unwrap() {
                world.now.store(now, Ordering::SeqCst);
                for event in events.iter().filter(|event| event["at"] == json!(now)) {
                    let key = event["key"].as_str().unwrap_or("");
                    match event["do"].as_str().unwrap() {
                        "devices" => {
                            let connected = event["connected"].as_bool().unwrap();
                            world.watched.store(connected, Ordering::SeqCst);
                            poll.update();
                        }
                        "level" => {
                            match event["level"].as_f64() {
                                Some(level) => lock(&world.system).insert(key.to_string(), level),
                                None => lock(&world.system).remove(key),
                            };
                        }
                        "fail" => {
                            if event["failing"].as_bool().unwrap() {
                                lock(&world.failing).insert(key.to_string());
                            } else {
                                lock(&world.failing).remove(key);
                            }
                        }
                        "readMs" => world
                            .read_ms
                            .store(event["ms"].as_u64().unwrap(), Ordering::SeqCst),
                        // What /api/volume does: stamp the key, set the app, record the level.
                        "write" => {
                            let level = event["level"].as_f64().unwrap();
                            poll.note_write(&format!("app:{key}"));
                            lock(&world.system).insert(key.to_string(), level);
                            world.set_levels(&[(format!("app:{key}"), level)]);
                        }
                        "library" => {
                            *lock(&world.library) = Some(library_of(&event["library"]));
                            poll.update();
                        }
                        "update" => poll.update(),
                        "stop" => poll.stop(),
                        other => panic!("{name}: {other}"),
                    }
                    world.note(json!({ "what": "active", "value": poll.active() }));
                }
                settle().await;
                tokio::time::advance(Duration::from_millis(1)).await;
                world.now.store(now + 1, Ordering::SeqCst);
                settle().await;
            }
            poll.stop();
            let ours: Vec<String> = lock(&world.log).iter().map(stringify).collect();
            let theirs: Vec<String> = case["output"]["log"]
                .as_array()
                .unwrap()
                .iter()
                .map(stringify)
                .collect();
            for (index, (ours, theirs)) in ours.iter().zip(&theirs).enumerate() {
                assert_eq!(ours, theirs, "{name}: entry {index}");
            }
            assert_eq!(ours.len(), theirs.len(), "{name}");
            assert_eq!(
                Value::Bool(lock(&world.log).iter().any(|entry| entry["what"] == "read")),
                case["output"]["anyRead"],
                "{name}"
            );
        }
    }

    #[test]
    fn app_keys_are_each_app_once_in_deck_order() {
        let library = library_of(&json!({ "version": 1, "activeProfileId": "p", "profiles": [
            { "id": "p", "name": "P", "buttons": [
                { "id": "a", "slot": 0, "control": "fader", "fader": { "target": "app", "app": "spotify" }, "steps": [] },
                { "id": "b", "slot": 1, "control": "fader", "fader": { "target": "app", "app": "chrome" }, "steps": [] },
                { "id": "c", "slot": 2, "control": "fader", "fader": { "target": "app", "app": "chrome" }, "steps": [] },
                { "id": "d", "slot": 3, "control": "fader", "fader": { "target": "app" }, "steps": [] },
                { "id": "e", "slot": 4, "control": "fader", "fader": { "target": "system", "app": "discord" }, "steps": [] },
                { "id": "f", "slot": 5, "steps": [] }
            ] },
            { "id": "q", "name": "Q", "buttons": [
                { "id": "g", "slot": 0, "control": "fader", "fader": { "target": "app", "app": "music" }, "steps": [] }
            ] }
        ] }));
        assert_eq!(app_keys_of(&library), ["spotify", "chrome", "music"]);
        assert_eq!(APP_POLL_MS, 2500);
    }

    #[test]
    fn outside_the_runtime_nothing_is_scheduled() {
        let world = Arc::new(World::default());
        *lock(&world.library) = Some(library_of(
            &json!({ "version": 1, "activeProfileId": "p", "profiles": [
            { "id": "p", "name": "P", "buttons": [
                { "id": "a", "slot": 0, "control": "fader", "fader": { "target": "app", "app": "spotify" }, "steps": [] }
            ] }
        ] }),
        ));
        world.watched.store(true, Ordering::SeqCst);
        let poll = poll_of(&world, 60);
        poll.update();
        assert!(!poll.active());
        poll.stop();
    }
}
