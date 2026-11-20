//! Live state pushed to every connected page over server-sent events: button
//! states from OBS, fader levels, revisions, sound playback, meters.
//! (src/server/events.ts)

use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Bytes;
use futures_util::Stream;
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;

use crate::audio::player::{Player, Slot};
use crate::i18n::UserError;
use crate::obs::link::{LinkStatus, ObsIssue};
use crate::store::stringify;

/// What the live state reads from the rest of the companion, each time it
/// is asked (`LiveSettings`). None of them may call back into [`Live`].
pub struct LiveSettings {
    pub accent: Box<dyn Fn() -> String + Send + Sync>,
    /// A theme id.
    pub theme: Box<dyn Fn() -> String + Send + Sync>,
    pub language: Box<dyn Fn() -> String + Send + Sync>,
    pub library_rev: Box<dyn Fn() -> u64 + Send + Sync>,
    pub build: Box<dyn Fn() -> String + Send + Sync>,
    pub obs: Box<dyn Fn() -> LinkStatus + Send + Sync>,
    pub obs_issue: Box<dyn Fn() -> Option<ObsIssue> + Send + Sync>,
    /// A sound's length, so decks can draw its progress; None while unknown.
    pub sound_duration: Box<dyn Fn(Slot) -> Option<f64> + Send + Sync>,
    /// The file behind a slot, for the player.
    pub sound_file: Box<dyn Fn(Slot) -> PathBuf + Send + Sync>,
    /// A device's stream opened or closed (see [`Live::has_devices`]).
    pub devices_changed: Box<dyn Fn() + Send + Sync>,
}

/// How often a stream is sent a ping.
const BEAT: Duration = Duration::from_millis(15000);

/// One open stream.
struct Listener {
    id: u64,
    /// The device it belongs to ("" for this computer).
    device: String,
    frames: mpsc::UnboundedSender<Bytes>,
}

#[derive(Default)]
struct State {
    /// Live on/off states, in the order they were first reported.
    toggles: Vec<(String, bool)>,
    /// When each playing sound started and how long it runs, for progress.
    playback: Vec<(Slot, u64, Option<f64>)>,
    sounds_rev: u64,
    /// Fader levels by target key, 0..1, so every deck agrees. In the order
    /// a JavaScript object kept them: a level set again after it was dropped
    /// goes to the end.
    levels: Vec<(String, f64)>,
    listeners: Vec<Listener>,
    streams_made: u64,
}

struct Inner {
    settings: LiveSettings,
    player: Player,
    state: Mutex<State>,
    /// Held while a snapshot is made and sent, so two changes at once reach
    /// every page in the order they happened.
    sending: Mutex<()>,
}

/// The live state (`createLive`). Cheap to clone; every clone is the same one.
#[derive(Clone)]
pub struct Live {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `Object.assign` for one key: a known key keeps its place.
fn assign<T>(list: &mut Vec<(String, T)>, key: &str, value: T) {
    match list.iter_mut().find(|(known, _)| known == key) {
        Some(entry) => entry.1 = value,
        None => list.push((key.to_string(), value)),
    }
}

/// How many paired devices have a stream open: each counts once.
fn tablets(listeners: &[Listener]) -> usize {
    let mut devices: Vec<&str> = listeners
        .iter()
        .map(|listener| listener.device.as_str())
        .filter(|device| !device.is_empty())
        .collect();
    devices.sort_unstable();
    devices.dedup();
    devices.len()
}

/// A frame of the stream carrying a snapshot.
fn data_frame(snapshot: &Value) -> Bytes {
    Bytes::from(format!("data: {}\n\n", stringify(snapshot)))
}

impl State {
    fn levels_json(&self) -> Value {
        let mut levels = Map::new();
        for (key, level) in &self.levels {
            levels.insert(key.clone(), json!(level));
        }
        Value::Object(levels)
    }

    /// Sends a frame to every stream; one that has gone away is forgotten.
    fn send(&mut self, frame: &Bytes) {
        self.listeners
            .retain(|listener| listener.frames.send(frame.clone()).is_ok());
    }
}

impl Live {
    pub fn new(settings: LiveSettings, player: Player, sound_volume: f64) -> Live {
        Live {
            inner: Arc::new(Inner {
                settings,
                player,
                state: Mutex::new(State {
                    sounds_rev: 1,
                    levels: vec![("sounds".to_string(), sound_volume)],
                    ..State::default()
                }),
                sending: Mutex::new(()),
            }),
        }
    }

    /// What every connected page receives on /api/events and /api/status
    /// (`Snapshot` in src/shared/api.ts), its fields in the order the
    /// TypeScript wrote them.
    pub fn snapshot(&self) -> Value {
        let settings = &self.inner.settings;
        // Asked before the state is looked at: none of these is held under
        // the state's lock, so they may take whatever locks they need.
        let library_rev = (settings.library_rev)();
        let playing = self.inner.player.playing();
        let obs = (settings.obs)();
        let obs_issue = (settings.obs_issue)();
        let (build, accent, theme, language) = (
            (settings.build)(),
            (settings.accent)(),
            (settings.theme)(),
            (settings.language)(),
        );
        let state = lock(&self.inner.state);
        let mut toggles = Map::new();
        for (key, value) in &state.toggles {
            toggles.insert(key.clone(), json!(value));
        }
        let mut playback = Map::new();
        for (slot, started_at, duration_ms) in &state.playback {
            playback.insert(
                slot.to_string(),
                json!({ "startedAt": started_at, "durationMs": duration_ms }),
            );
        }
        json!({
            "libraryRev": library_rev,
            "soundsRev": state.sounds_rev,
            "toggles": toggles,
            "playing": playing,
            "playback": playback,
            "levels": state.levels_json(),
            "obs": obs,
            "obsIssue": obs_issue,
            "tablets": tablets(&state.listeners),
            "build": build,
            "accent": accent,
            "theme": theme,
            "language": language,
        })
    }

    /// Sends the state as it is now to every stream.
    pub fn broadcast(&self) {
        let _order = lock(&self.inner.sending);
        let frame = data_frame(&self.snapshot());
        lock(&self.inner.state).send(&frame);
    }

    /// Meter levels go out as their own event, so 15 updates a second never
    /// carry the whole snapshot with them.
    pub fn broadcast_meters(&self, levels_now: &[(String, f64)]) {
        let mut levels = Map::new();
        for (key, level) in levels_now {
            levels.insert(key.clone(), json!(level));
        }
        let frame = Bytes::from(format!(
            "event: meters\ndata: {}\n\n",
            stringify(&json!({ "levels": levels }))
        ));
        lock(&self.inner.state).send(&frame);
    }

    pub fn has_listeners(&self) -> bool {
        !lock(&self.inner.state).listeners.is_empty()
    }

    /// Whether a paired device has a stream open (the Control Center does not count).
    pub fn has_devices(&self) -> bool {
        lock(&self.inner.state)
            .listeners
            .iter()
            .any(|listener| !listener.device.is_empty())
    }

    /// Opens a stream for a device ("" for this computer): what the reply to
    /// /api/events carries from then on. Dropping it closes the stream.
    pub fn open_stream(&self, device_id: &str) -> EventStream {
        let (frames, received) = mpsc::unbounded_channel();
        let _ = frames.send(Bytes::from_static(b"retry: 2000\n\n"));
        let id = {
            let mut state = lock(&self.inner.state);
            state.streams_made += 1;
            let id = state.streams_made;
            state.listeners.push(Listener {
                id,
                device: device_id.to_string(),
                frames: frames.clone(),
            });
            id
        };
        // A tablet arriving changes the count the Control Center shows.
        if device_id.is_empty() {
            let _ = frames.send(data_frame(&self.snapshot()));
        } else {
            self.broadcast();
            (self.inner.settings.devices_changed)();
        }
        // A ping keeps intermediaries and sleeping wifi from dropping the stream,
        // and lets a deck notice a line that died silently: a comment frame would
        // do the first, but a page never sees comments. Pages without a "ping"
        // listener ignore it.
        let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + BEAT, BEAT);
        beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        EventStream {
            live: self.clone(),
            id,
            device: device_id.to_string(),
            received,
            beat,
        }
    }

    /// A stream went away: its page closed, or the line dropped.
    fn closed(&self, id: u64, device: &str) {
        lock(&self.inner.state)
            .listeners
            .retain(|listener| listener.id != id);
        if !device.is_empty() {
            self.broadcast();
            (self.inner.settings.devices_changed)();
        }
    }

    /// Ends a revoked device's live streams, so it notices straight away.
    pub fn disconnect_device(&self, device_id: &str) {
        // Letting go of a stream's sender ends it.
        lock(&self.inner.state)
            .listeners
            .retain(|listener| listener.device != device_id);
    }

    pub fn close_all(&self) {
        lock(&self.inner.state).listeners.clear();
    }

    // ---------------------------------------------------------------- sounds

    /// A second press on a playing sound stops it instead of stacking a copy.
    pub fn toggle_sound(&self, slot: Slot) -> Result<(), UserError> {
        let inner = &self.inner;
        if inner.player.stop(slot) {
            return Ok(());
        }
        inner
            .player
            .play(slot, &(inner.settings.sound_file)(slot))?;
        let duration_ms = (inner.settings.sound_duration)(slot);
        {
            let mut state = lock(&inner.state);
            // A sound that could not start has been announced as ended
            // already (from the player's thread, which waits for this lock
            // to say so of any other): it has no progress to show.
            if let Some(started_at) = inner.player.started_at(slot) {
                state.playback.retain(|(known, _, _)| *known != slot);
                state.playback.push((slot, started_at, duration_ms));
                // Number-like keys of a JavaScript object come out in order.
                state.playback.sort_by_key(|(slot, _, _)| *slot);
            }
        }
        self.broadcast();
        Ok(())
    }

    /// The player reports every end, requested or natural.
    pub fn sound_ended(&self, slot: Slot) {
        lock(&self.inner.state)
            .playback
            .retain(|(known, _, _)| *known != slot);
        self.broadcast();
    }

    pub fn stop_all_sounds(&self) {
        self.inner.player.stop_all();
    }

    // ---------------------------------------------------- toggles and levels

    /// Records live states reported by OBS or a press. Only one scene is live
    /// at a time, so a scene turning on turns every other scene off.
    pub fn set_toggles(&self, changes: &[(String, bool)]) {
        let mut changed = false;
        {
            let mut state = lock(&self.inner.state);
            for (key, value) in changes {
                if *value && key.starts_with("scene:") {
                    for (other, on) in state.toggles.iter_mut() {
                        if other != key && other.starts_with("scene:") && *on {
                            *on = false;
                            changed = true;
                        }
                    }
                }
                // Written when it turns off too, so a tile can never latch on for good.
                let known = state
                    .toggles
                    .iter()
                    .find(|(known, _)| known == key)
                    .map(|(_, on)| *on);
                if known != Some(*value) {
                    assign(&mut state.toggles, key, *value);
                    changed = true;
                }
            }
        }
        if changed {
            self.broadcast();
        }
    }

    /// OBS went away: nothing it reported can be trusted to still be true.
    /// Two-state macros keep theirs; that state is Punchboard's own.
    pub fn clear_toggles(&self) {
        let changed = {
            let mut state = lock(&self.inner.state);
            let before = state.toggles.len();
            state.toggles.retain(|(key, _)| key.starts_with("switch:"));
            state.toggles.len() != before
        };
        if changed {
            self.broadcast();
        }
    }

    pub fn toggle_value(&self, key: &str) -> bool {
        lock(&self.inner.state)
            .toggles
            .iter()
            .any(|(known, on)| known == key && *on)
    }

    /// Fader levels changed outside Punchboard (in OBS's mixer, say).
    pub fn set_levels(&self, changes: &[(String, f64)]) {
        let mut changed = false;
        {
            let mut state = lock(&self.inner.state);
            for (key, value) in changes {
                let known = state.levels.iter().find(|(known, _)| known == key);
                // `===`: a level that is not a number never equals itself.
                if known.is_some_and(|(_, level)| level == value) {
                    continue;
                }
                assign(&mut state.levels, key, *value);
                changed = true;
            }
        }
        if changed {
            self.broadcast();
        }
    }

    /// Levels nobody can vouch for any more read as unknown on the decks
    /// (the fader shows "–"), not as wherever they last were.
    pub fn drop_levels(&self, keys: &[String]) {
        let changed = {
            let mut state = lock(&self.inner.state);
            let before = state.levels.len();
            state.levels.retain(|(key, _)| !keys.contains(key));
            state.levels.len() != before
        };
        if changed {
            self.broadcast();
        }
    }

    /// OBS went away: its faders' levels are as unknown as its toggles.
    pub fn clear_obs_levels(&self) {
        let keys: Vec<String> = lock(&self.inner.state)
            .levels
            .iter()
            .filter(|(key, _)| key.starts_with("obs:"))
            .map(|(key, _)| key.clone())
            .collect();
        self.drop_levels(&keys);
    }

    /// `live.levels[key] = level`: a fader was set from a deck. Nobody is
    /// told until the next broadcast.
    pub fn put_level(&self, key: &str, level: f64) {
        assign(&mut lock(&self.inner.state).levels, key, level);
    }

    /// `delete live.levels[key]`, without telling anybody yet.
    pub fn forget_level(&self, key: &str) {
        lock(&self.inner.state)
            .levels
            .retain(|(known, _)| known != key);
    }

    /// `live.levels`, as replies carry it.
    pub fn levels(&self) -> Value {
        lock(&self.inner.state).levels_json()
    }

    pub fn sounds_changed(&self) {
        lock(&self.inner.state).sounds_rev += 1;
        self.broadcast();
    }
}

/// The body of a reply to /api/events: frames as they are sent, a ping every
/// 15 s, and the end when the device is removed or Punchboard closes.
pub struct EventStream {
    live: Live,
    id: u64,
    device: String,
    received: mpsc::UnboundedReceiver<Bytes>,
    beat: tokio::time::Interval,
}

impl Stream for EventStream {
    type Item = Result<Bytes, std::convert::Infallible>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match self.received.poll_recv(cx) {
            Poll::Ready(Some(frame)) => return Poll::Ready(Some(Ok(frame))),
            Poll::Ready(None) => return Poll::Ready(None),
            Poll::Pending => {}
        }
        match self.beat.poll_tick(cx) {
            Poll::Ready(_) => {
                Poll::Ready(Some(Ok(Bytes::from_static(b"event: ping\ndata: 1\n\n"))))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        self.live.closed(self.id, &self.device);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::player::{Ended, Lost, Output, PlayFailure, PlayerOptions};
    use futures_util::StreamExt;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    /// An output that plays nothing and never ends a sound by itself.
    struct Silent;

    impl Output for Silent {
        fn play(&mut self, _: u64, file: &Path, _: f32, _: Ended) -> Result<(), PlayFailure> {
            if file.ends_with("missing.wav") {
                Err(PlayFailure::Missing)
            } else {
                Ok(())
            }
        }
        fn set_gain(&mut self, _: f32) {}
        fn stop(&mut self, _: u64) {}
        fn close(&mut self) {}
    }

    struct Desk {
        live: Live,
        devices_changed: Arc<AtomicUsize>,
        library_rev: Arc<AtomicU64>,
    }

    fn desk() -> Desk {
        let devices_changed = Arc::new(AtomicUsize::new(0));
        let library_rev = Arc::new(AtomicU64::new(7));
        // The player tells the live state of every end, as the server wires it.
        let slot: Arc<Mutex<Option<Live>>> = Arc::new(Mutex::new(None));
        let told = slot.clone();
        let player = Player::with_output(
            PlayerOptions {
                volume: Box::new(|| 1.0),
                on_ended: Box::new(move |slot, _| {
                    let live = lock(&told).clone();
                    if let Some(live) = live {
                        live.sound_ended(slot);
                    }
                }),
                log: Box::new(|_| {}),
                idle_close: Duration::from_secs(5),
            },
            Arc::new(|_: Lost| Box::new(Silent) as Box<dyn Output>),
        );
        let (changed, rev) = (devices_changed.clone(), library_rev.clone());
        let live = Live::new(
            LiveSettings {
                accent: Box::new(|| "#5fd0d6".to_string()),
                theme: Box::new(|| "studio".to_string()),
                language: Box::new(|| "auto".to_string()),
                library_rev: Box::new(move || rev.load(Ordering::SeqCst)),
                build: Box::new(|| "a.b.c.d".to_string()),
                obs: Box::new(|| LinkStatus::Disconnected),
                obs_issue: Box::new(|| Some(ObsIssue::ServerOff)),
                sound_duration: Box::new(|slot| (slot == 2).then_some(1500.0)),
                sound_file: Box::new(|slot| {
                    PathBuf::from(if slot == 8 {
                        "missing.wav"
                    } else {
                        "sound.wav"
                    })
                }),
                devices_changed: Box::new(move || {
                    changed.fetch_add(1, Ordering::SeqCst);
                }),
            },
            player,
            0.4,
        );
        *lock(&slot) = Some(live.clone());
        Desk {
            live,
            devices_changed,
            library_rev,
        }
    }

    /// The frames a stream has waiting, as text.
    fn waiting(stream: &mut EventStream) -> Vec<String> {
        let mut frames = Vec::new();
        while let Ok(frame) = stream.received.try_recv() {
            frames.push(String::from_utf8(frame.to_vec()).unwrap());
        }
        frames
    }

    fn snapshot_of(frame: &str) -> Value {
        let json = frame
            .strip_prefix("data: ")
            .and_then(|rest| rest.strip_suffix("\n\n"))
            .unwrap_or_else(|| panic!("not a data frame: {frame:?}"));
        serde_json::from_str(json).unwrap()
    }

    async fn until(what: &str, test: impl Fn() -> bool) {
        for _ in 0..500 {
            if test() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("Timed out waiting for {what}");
    }

    /// tests/fixtures/make-server.ts ran the TypeScript's createLive over
    /// lists of things that happen; every stream must be sent the same frames.
    #[tokio::test]
    async fn streams_are_sent_what_the_typescript_sent() {
        let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/server/live.json");
        let cases: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        assert!(cases.len() >= 5);
        let pairs = |object: &Value| -> Vec<(String, Value)> {
            object
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        };
        for case in cases {
            let input = &case["input"];
            let library_rev = Arc::new(AtomicU64::new(7));
            let rev = library_rev.clone();
            let player = Player::with_output(
                PlayerOptions {
                    volume: Box::new(|| 1.0),
                    on_ended: Box::new(|_, _| {}),
                    log: Box::new(|_| {}),
                    idle_close: Duration::from_secs(5),
                },
                Arc::new(|_: Lost| Box::new(Silent) as Box<dyn Output>),
            );
            let live = Live::new(
                LiveSettings {
                    accent: Box::new(|| "#5fd0d6".to_string()),
                    theme: Box::new(|| "studio".to_string()),
                    language: Box::new(|| "auto".to_string()),
                    library_rev: Box::new(move || rev.load(Ordering::SeqCst)),
                    build: Box::new(|| "a.b.c.d".to_string()),
                    obs: Box::new(|| LinkStatus::Disconnected),
                    obs_issue: Box::new(|| Some(ObsIssue::Unreachable)),
                    sound_duration: Box::new(|_| None),
                    sound_file: Box::new(|_| PathBuf::new()),
                    devices_changed: Box::new(|| {}),
                },
                player,
                input["soundVolume"].as_f64().unwrap(),
            );
            // Each stream by name: what it was sent, whether the companion
            // ended it, and the stream itself until its page closes it.
            let mut order: Vec<String> = Vec::new();
            let mut seen: std::collections::HashMap<
                String,
                (Vec<String>, bool, Option<EventStream>),
            > = std::collections::HashMap::new();
            fn drain(entry: &mut (Vec<String>, bool, Option<EventStream>)) {
                let Some(stream) = entry.2.as_mut() else {
                    return;
                };
                loop {
                    match stream.received.try_recv() {
                        Ok(frame) => entry.0.push(String::from_utf8(frame.to_vec()).unwrap()),
                        Err(mpsc::error::TryRecvError::Disconnected) => {
                            entry.1 = true;
                            break;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                    }
                }
            }
            for op in input["ops"].as_array().unwrap() {
                let text = |at: usize| op[at].as_str().unwrap().to_string();
                match op[0].as_str().unwrap() {
                    "open" => {
                        order.push(text(1));
                        let stream = live.open_stream(&text(2));
                        seen.insert(text(1), (Vec::new(), false, Some(stream)));
                    }
                    "close" => {
                        let entry = seen.get_mut(&text(1)).unwrap();
                        drain(entry);
                        entry.2 = None;
                    }
                    "toggles" => {
                        let changes: Vec<(String, bool)> = pairs(&op[1])
                            .into_iter()
                            .map(|(key, value)| (key, value.as_bool().unwrap()))
                            .collect();
                        live.set_toggles(&changes);
                    }
                    "clearToggles" => live.clear_toggles(),
                    "levels" => {
                        let changes: Vec<(String, f64)> = pairs(&op[1])
                            .into_iter()
                            .map(|(key, value)| (key, value.as_f64().unwrap()))
                            .collect();
                        live.set_levels(&changes);
                    }
                    "dropLevels" => {
                        let keys: Vec<String> = op[1]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|key| key.as_str().unwrap().to_string())
                            .collect();
                        live.drop_levels(&keys);
                    }
                    "clearObsLevels" => live.clear_obs_levels(),
                    "put" => live.put_level(&text(1), op[2].as_f64().unwrap()),
                    "forget" => live.forget_level(&text(1)),
                    "soundsChanged" => live.sounds_changed(),
                    "broadcast" => live.broadcast(),
                    "meters" => {
                        let levels: Vec<(String, f64)> = pairs(&op[1])
                            .into_iter()
                            .map(|(key, value)| (key, value.as_f64().unwrap()))
                            .collect();
                        live.broadcast_meters(&levels);
                    }
                    "disconnect" => live.disconnect_device(&text(1)),
                    "closeAll" => live.close_all(),
                    "rev" => library_rev.store(op[1].as_u64().unwrap(), Ordering::SeqCst),
                    other => panic!("unknown op {other}"),
                }
            }
            let mut streams = Map::new();
            for name in order {
                let entry = seen.get_mut(&name).unwrap();
                drain(entry);
                streams.insert(name, json!({ "frames": entry.0, "ended": entry.1 }));
            }
            let output = json!({
                "streams": streams,
                "snapshot": stringify(&live.snapshot()),
                "hasListeners": live.has_listeners(),
                "hasDevices": live.has_devices(),
            });
            assert_eq!(output, case["output"], "{}", input["ops"]);
        }
    }

    #[tokio::test]
    async fn the_snapshot_is_written_as_the_typescript_wrote_it() {
        let desk = desk();
        assert_eq!(
            stringify(&desk.live.snapshot()),
            r##"{"libraryRev":7,"soundsRev":1,"toggles":{},"playing":[],"playback":{},"levels":{"sounds":0.4},"obs":"disconnected","obsIssue":"server-off","tablets":0,"build":"a.b.c.d","accent":"#5fd0d6","theme":"studio","language":"auto"}"##
        );
    }

    #[tokio::test]
    async fn a_stream_starts_with_retry_and_a_snapshot() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        let frames = waiting(&mut stream);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], "retry: 2000\n\n");
        assert_eq!(snapshot_of(&frames[1])["tablets"], json!(0));
        assert!(desk.live.has_listeners());
        assert!(!desk.live.has_devices());
        assert_eq!(desk.devices_changed.load(Ordering::SeqCst), 0);
        drop(stream);
        assert!(!desk.live.has_listeners());
        assert_eq!(desk.devices_changed.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_device_arriving_and_leaving_is_told_to_everyone() {
        let desk = desk();
        let mut control = desk.live.open_stream("");
        waiting(&mut control);
        let mut tablet = desk.live.open_stream("dev_1");
        let mut again = desk.live.open_stream("dev_1");
        let mut other = desk.live.open_stream("dev_2");
        let told = waiting(&mut control);
        // One broadcast per arrival; a device with two streams counts once.
        let counts: Vec<Value> = told
            .iter()
            .map(|frame| snapshot_of(frame)["tablets"].clone())
            .collect();
        assert_eq!(counts, vec![json!(1), json!(1), json!(2)]);
        assert_eq!(waiting(&mut tablet).len(), 4);
        assert_eq!(waiting(&mut again).len(), 3);
        assert_eq!(waiting(&mut other).len(), 2);
        assert!(desk.live.has_devices());
        assert_eq!(desk.devices_changed.load(Ordering::SeqCst), 3);

        drop(other);
        let told = waiting(&mut control);
        assert_eq!(told.len(), 1);
        assert_eq!(snapshot_of(&told[0])["tablets"], json!(1));
        assert_eq!(desk.devices_changed.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn removing_a_device_ends_its_streams_only() {
        let desk = desk();
        let mut control = desk.live.open_stream("");
        let mut tablet = desk.live.open_stream("dev_1");
        let mut other = desk.live.open_stream("dev_2");
        waiting(&mut control);
        waiting(&mut tablet);
        waiting(&mut other);
        desk.live.disconnect_device("dev_1");
        assert!(tablet.next().await.is_none());
        desk.live.broadcast();
        assert_eq!(waiting(&mut other).len(), 1);
        assert_eq!(waiting(&mut control).len(), 1);
        desk.live.close_all();
        assert!(other.next().await.is_none());
        assert!(control.next().await.is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_stream_is_sent_a_ping_every_fifteen_seconds() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        assert_eq!(stream.next().await.unwrap().unwrap(), "retry: 2000\n\n");
        assert!(stream.next().await.unwrap().unwrap().starts_with(b"data: "));
        let started = tokio::time::Instant::now();
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            "event: ping\ndata: 1\n\n"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(15));
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            "event: ping\ndata: 1\n\n"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(30));
    }

    #[tokio::test]
    async fn meters_are_their_own_event() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        waiting(&mut stream);
        desk.live
            .broadcast_meters(&[("obs:Mic".to_string(), 0.5), ("obs:Desk".to_string(), 1.0)]);
        assert_eq!(
            waiting(&mut stream),
            vec!["event: meters\ndata: {\"levels\":{\"obs:Mic\":0.5,\"obs:Desk\":1}}\n\n"]
        );
    }

    #[tokio::test]
    async fn one_scene_is_live_at_a_time_and_only_changes_are_told() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        waiting(&mut stream);
        let on = |key: &str, value: bool| vec![(key.to_string(), value)];
        desk.live.set_toggles(&on("scene:Intro", true));
        desk.live.set_toggles(&on("mute:Mic", false));
        desk.live.set_toggles(&on("scene:Main", true));
        // Nothing new: nobody is told.
        desk.live.set_toggles(&on("scene:Main", true));
        desk.live.set_toggles(&on("mute:Mic", false));
        let frames = waiting(&mut stream);
        assert_eq!(frames.len(), 3);
        assert_eq!(
            stringify(&snapshot_of(&frames[2])["toggles"]),
            r#"{"scene:Intro":false,"mute:Mic":false,"scene:Main":true}"#
        );
        assert!(desk.live.toggle_value("scene:Main"));
        assert!(!desk.live.toggle_value("scene:Intro"));
        assert!(!desk.live.toggle_value("never"));
        // A scene turning off turns no other scene off.
        desk.live.set_toggles(&on("scene:Main", false));
        assert!(!desk.live.toggle_value("scene:Main"));
        assert_eq!(waiting(&mut stream).len(), 1);
    }

    #[tokio::test]
    async fn obs_going_away_clears_what_it_reported_and_keeps_switches() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        desk.live.set_toggles(&[
            ("switch:btn".to_string(), true),
            ("stream".to_string(), true),
            ("scene:Main".to_string(), true),
        ]);
        desk.live.set_levels(&[
            ("obs:Mic".to_string(), 0.5),
            ("app:spotify".to_string(), 0.3),
        ]);
        waiting(&mut stream);
        desk.live.clear_toggles();
        desk.live.clear_obs_levels();
        let frames = waiting(&mut stream);
        assert_eq!(frames.len(), 2);
        let last = snapshot_of(&frames[1]);
        assert_eq!(stringify(&last["toggles"]), r#"{"switch:btn":true}"#);
        assert_eq!(
            stringify(&last["levels"]),
            r#"{"sounds":0.4,"app:spotify":0.3}"#
        );
        // Nothing left to clear: nobody is told.
        desk.live.clear_toggles();
        desk.live.clear_obs_levels();
        assert!(waiting(&mut stream).is_empty());
    }

    #[tokio::test]
    async fn levels_keep_the_order_a_javascript_object_gave_them() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        waiting(&mut stream);
        desk.live.set_levels(&[("obs:Mic".to_string(), 0.5)]);
        desk.live.set_levels(&[("obs:Mic".to_string(), 0.5)]);
        assert_eq!(waiting(&mut stream).len(), 1);
        desk.live.put_level("system", 0.25);
        desk.live.put_level("sounds", 1.0);
        assert!(waiting(&mut stream).is_empty());
        assert_eq!(
            stringify(&desk.live.levels()),
            r#"{"sounds":1,"obs:Mic":0.5,"system":0.25}"#
        );
        desk.live
            .drop_levels(&["obs:Mic".to_string(), "never".to_string()]);
        assert_eq!(waiting(&mut stream).len(), 1);
        desk.live.drop_levels(&["obs:Mic".to_string()]);
        assert!(waiting(&mut stream).is_empty());
        desk.live.forget_level("sounds");
        desk.live.put_level("sounds", 0.5);
        assert_eq!(
            stringify(&desk.live.levels()),
            r#"{"system":0.25,"sounds":0.5}"#
        );
    }

    #[tokio::test]
    async fn a_sound_is_toggled_and_its_progress_told() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        waiting(&mut stream);
        desk.live.toggle_sound(2).unwrap();
        desk.live.toggle_sound(1).unwrap();
        let frames = waiting(&mut stream);
        let last = snapshot_of(frames.last().unwrap());
        assert_eq!(last["playing"], json!([2, 1]));
        // Slots are written in order, as a JavaScript object's number keys are.
        let playback = last["playback"].as_object().unwrap();
        assert_eq!(playback.keys().collect::<Vec<_>>(), vec!["1", "2"]);
        assert_eq!(playback["2"]["durationMs"], json!(1500));
        assert_eq!(playback["1"]["durationMs"], Value::Null);
        assert!(playback["2"]["startedAt"].as_u64().unwrap() > 1_600_000_000_000);

        // A second press stops it; the player says when it has ended.
        desk.live.toggle_sound(2).unwrap();
        let live = desk.live.clone();
        until("the sound to end", move || {
            live.snapshot()["playing"] == json!([1])
        })
        .await;
        let now = desk.live.snapshot();
        assert_eq!(now["playback"].as_object().unwrap().len(), 1);
        desk.live.stop_all_sounds();
        let live = desk.live.clone();
        until("every sound to end", move || {
            live.snapshot()["playback"] == json!({})
        })
        .await;
        assert!(waiting(&mut stream).len() >= 2);
    }

    #[tokio::test]
    async fn a_sound_that_cannot_start_leaves_no_progress_behind() {
        let desk = desk();
        desk.live.toggle_sound(8).unwrap();
        let live = desk.live.clone();
        until("the failed sound to be over", move || {
            live.snapshot()["playing"] == json!([])
        })
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(desk.live.snapshot()["playback"], json!({}));
    }

    #[tokio::test]
    async fn new_sounds_and_a_new_library_are_told() {
        let desk = desk();
        let mut stream = desk.live.open_stream("");
        waiting(&mut stream);
        desk.live.sounds_changed();
        desk.library_rev.store(8, Ordering::SeqCst);
        desk.live.broadcast();
        let frames = waiting(&mut stream);
        assert_eq!(snapshot_of(&frames[0])["soundsRev"], json!(2));
        assert_eq!(snapshot_of(&frames[1])["libraryRev"], json!(8));
    }
}
