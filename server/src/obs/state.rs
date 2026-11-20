//! What OBS is doing right now, as the decks show it: the live scene, what is
//! muted, streaming, recording, visible or filtered, and every OBS fader's
//! volume. Read in full when the link comes up or the decks change, then kept
//! current from OBS's own events, so a change made in OBS itself (a click in
//! its mixer, a stream that drops) shows on every deck at once. Only what the
//! decks use is followed.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{join_all, BoxFuture};
use futures_util::FutureExt;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use super::client::{lock, ObsClient, ObsError};
use super::jsmath;
use super::link::{assign, obs_call, Levels, ObsFailure};
use crate::model::{js, state_key_of, Action, Library};

/// On/off states by key ("scene:Main", "mute:Mic", "stream"…), in the order
/// JavaScript's object kept them.
pub type Toggles = Vec<(String, bool)>;

pub struct ObsStateOptions {
    /// The library as it is now. The same `Arc` for as long as the library
    /// has not been replaced: what it uses in OBS is worked out once per `Arc`.
    pub library: Box<dyn Fn() -> Arc<Library> + Send + Sync>,
    pub set_toggles: Box<dyn Fn(Toggles) + Send + Sync>,
    pub set_levels: Box<dyn Fn(Levels) + Send + Sync>,
    /// Forgets fader levels OBS can no longer vouch for (a renamed input).
    pub drop_levels: Box<dyn Fn(Vec<String>) + Send + Sync>,
}

/// OBS faders are cubic; decks show the position, not the gain.
pub fn fader_position(mul: f64) -> f64 {
    js::max(0.0, js::min(1.0, jsmath::cbrt(js::max(0.0, mul))))
}

/// A request whose failure reads as "no answer" (null).
async fn quietly(obs: &ObsClient, request_type: &str, request_data: Option<Value>) -> Value {
    obs_call(obs, request_type, request_data)
        .await
        .unwrap_or(Value::Null)
}

/// `Boolean(answer?.field)`.
fn flag(answer: &Value, field: &str) -> bool {
    answer.get(field).is_some_and(js::truthy)
}

/// A field as JavaScript puts it in a string.
fn text(data: &Value, field: &str) -> String {
    data.get(field)
        .map_or_else(|| "undefined".to_string(), js::to_string)
}

/// `Number(data.field)`; NaN when it is not there.
fn number(data: &Value, field: &str) -> f64 {
    data.get(field).map_or(f64::NAN, js::to_number)
}

// OBS's outputs are four fixed states, read and followed whether or not a
// button shows them yet: they change rarely and cost nothing to keep.
const OUTPUT_KEYS: [&str; 4] = ["stream", "record", "virtualcam", "replaybuffer"];

// Rebuilding a scene in OBS sends one event per item; one read covers them all.
const REFRESH_DEBOUNCE_MS: u64 = 150;

/// One state a button shows that has to be asked for.
enum Read {
    Mute {
        key: String,
        input: String,
    },
    Filter {
        key: String,
        source: String,
        filter: String,
    },
    Source {
        key: String,
        scene: String,
        source: String,
    },
}

/// What the library looks at in OBS. Every other input, filter and source is
/// somebody else's business: OBS reports all of them, and following them
/// would broadcast to every deck for each drag in OBS's mixer.
struct Used {
    /// One per state key that needs a request, in the library's order.
    reads: Vec<Read>,
    /// Every state key a button shows, plus OBS's outputs.
    keys: HashSet<String>,
    /// The scene keys among them, so a scene no button shows can turn them off.
    scenes: Vec<String>,
    fader_inputs: Vec<String>,
}

fn used_by(library: &Library) -> Used {
    let mut reads = Vec::new();
    let mut keys: HashSet<String> = OUTPUT_KEYS.iter().map(|key| (*key).to_string()).collect();
    let mut scenes = Vec::new();
    let mut fader_inputs: Vec<String> = Vec::new();
    for profile in &library.profiles {
        for button in &profile.buttons {
            if let Some(fader) = button.fader() {
                if fader.target == crate::model::FaderTarget::ObsInput
                    && !fader.input_name.is_empty()
                    && !fader_inputs.contains(&fader.input_name)
                {
                    fader_inputs.push(fader.input_name.clone());
                }
                continue;
            }
            let off_steps = button.off_steps.as_deref().unwrap_or(&[]);
            for step in button.steps.iter().chain(off_steps) {
                let Some(key) = state_key_of(step) else {
                    continue;
                };
                if !keys.insert(key.clone()) {
                    continue;
                }
                // A state key is only given to a step whose names are filled in.
                let filled = |name: &Option<String>| name.clone().unwrap_or_default();
                match &step.action {
                    Action::ObsScene { .. } => scenes.push(key),
                    Action::ObsToggleMute { source_name, .. } => reads.push(Read::Mute {
                        key,
                        input: filled(source_name),
                    }),
                    Action::ObsToggleFilter {
                        source_name,
                        filter_name,
                        ..
                    } => reads.push(Read::Filter {
                        key,
                        source: filled(source_name),
                        filter: filled(filter_name),
                    }),
                    Action::ObsToggleSource {
                        scene_name,
                        source_name,
                        ..
                    } => reads.push(Read::Source {
                        key,
                        scene: filled(scene_name),
                        source: filled(source_name),
                    }),
                    _ => {}
                }
            }
        }
    }
    Used {
        reads,
        keys,
        scenes,
        fader_inputs,
    }
}

#[derive(Default)]
struct Following {
    socket: Option<ObsClient>,
    /// OBS names scene items by number in its events; the key each belongs to.
    scene_items: HashMap<String, String>,
    used: Option<(Arc<Library>, Arc<Used>)>,
    // A refresh reads for a while; an event that lands meanwhile is newer than
    // what it read. Each event stamps its key, and a refresh skips any key
    // stamped after it started.
    tick: u64,
    changed_at: HashMap<String, u64>,
    scene_changed_at: u64,
    refreshes: u64,
    refresh_timer: Option<JoinHandle<()>>,
}

struct Inner {
    options: ObsStateOptions,
    state: Mutex<Following>,
    /// Held from deciding what to tell the owner until it has been told, so
    /// an event and the end of a refresh cannot overtake each other (in
    /// JavaScript nothing could come between the two).
    telling: Mutex<()>,
}

/// The reader. Cheap to clone; every clone is the same reader. Its reads run
/// on tokio tasks. The owner's callbacks are called one at a time.
#[derive(Clone)]
pub struct ObsState {
    inner: Arc<Inner>,
}

fn item_key(scene_name: &str, item_id: &str) -> String {
    format!("{scene_name}\n{item_id}")
}

impl ObsState {
    pub fn new(options: ObsStateOptions) -> ObsState {
        ObsState {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(Following::default()),
                telling: Mutex::new(()),
            }),
        }
    }

    /// Starts following a freshly connected OBS.
    pub fn attach(&self, obs: &ObsClient) {
        self.detach();
        lock(&self.inner.state).socket = Some(obs.clone());
        let inner = Arc::downgrade(&self.inner);
        let id = obs.id();
        obs.on_event(move |event, data| {
            if let Some(inner) = inner.upgrade() {
                inner.on_event(id, event, data);
            }
        });
        self.refresh();
    }

    /// Stops following: the link is down, or another OBS is coming.
    pub fn detach(&self) {
        let mut state = lock(&self.inner.state);
        state.socket = None;
        state.scene_items.clear();
        state.changed_at.clear();
        if let Some(timer) = state.refresh_timer.take() {
            timer.abort();
        }
    }

    /// Reads everything again: new buttons may point at OBS states nobody
    /// was reading yet. Returns at once; the read goes on by itself.
    pub fn refresh(&self) {
        tokio::spawn(Inner::refresh(Arc::clone(&self.inner)));
    }
}

impl Inner {
    /// The library's view of OBS, worked out again whenever the library is replaced.
    fn library_parts(&self) -> Arc<Used> {
        let library = (self.options.library)();
        let mut state = lock(&self.state);
        if let Some((known, used)) = &state.used {
            if Arc::ptr_eq(known, &library) {
                return Arc::clone(used);
            }
        }
        let used = Arc::new(used_by(&library));
        state.used = Some((library, Arc::clone(&used)));
        used
    }

    /// The scene buttons as OBS's program scene leaves them: that one lit, the
    /// rest off, all off when it is a scene no button shows (or unknown).
    fn scene_toggles(parts: &Used, scene_name: Option<&str>) -> Toggles {
        let mut toggles: Toggles = parts
            .scenes
            .iter()
            .map(|key| (key.clone(), false))
            .collect();
        if let Some(scene_name) = scene_name {
            let key = format!("scene:{scene_name}");
            if parts.keys.contains(&key) {
                assign(&mut toggles, key, true);
            }
        }
        toggles
    }

    /// Reads every state a deck could show. Anything OBS cannot answer (a
    /// renamed source, a replay buffer that is not set up) shows as off.
    async fn refresh(self: Arc<Inner>) {
        let parts = self.library_parts();
        let (obs, mine, started_at) = {
            let mut state = lock(&self.state);
            let Some(obs) = state.socket.clone() else {
                return;
            };
            state.refreshes += 1;
            (obs, state.refreshes, state.tick)
        };
        let obs = &obs;
        // Filled in as the answers come, in the order they come.
        let toggles: Mutex<Toggles> = Mutex::new(Vec::new());
        let levels: Mutex<Levels> = Mutex::new(Vec::new());
        let missing: Mutex<Vec<String>> = Mutex::new(Vec::new());
        let items: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        let program_scene: Mutex<Option<String>> = Mutex::new(None);
        let toggle = |key: &str, value: bool| assign(&mut lock(&toggles), key.to_string(), value);

        let mut reads: Vec<BoxFuture<'_, ()>> = Vec::new();
        reads.push(
            async {
                let answer = quietly(obs, "GetCurrentProgramScene", None).await;
                if let Some(name) = answer
                    .get("currentProgramSceneName")
                    .and_then(Value::as_str)
                {
                    *lock(&program_scene) = Some(name.to_string());
                }
            }
            .boxed(),
        );
        for (key, request) in [
            ("stream", "GetStreamStatus"),
            ("record", "GetRecordStatus"),
            ("virtualcam", "GetVirtualCamStatus"),
            ("replaybuffer", "GetReplayBufferStatus"),
        ] {
            let toggle = &toggle;
            reads.push(
                async move {
                    let answer = quietly(obs, request, None).await;
                    toggle(key, flag(&answer, "outputActive"));
                }
                .boxed(),
            );
        }
        for read in &parts.reads {
            let (toggle, items) = (&toggle, &items);
            reads.push(match read {
                Read::Mute { key, input } => async move {
                    let data = json!({ "inputName": input });
                    let answer = quietly(obs, "GetInputMute", Some(data)).await;
                    toggle(key, flag(&answer, "inputMuted"));
                }
                .boxed(),
                Read::Filter {
                    key,
                    source,
                    filter,
                } => async move {
                    let data = json!({ "sourceName": source, "filterName": filter });
                    let answer = quietly(obs, "GetSourceFilter", Some(data)).await;
                    toggle(key, flag(&answer, "filterEnabled"));
                }
                .boxed(),
                Read::Source { key, scene, source } => async move {
                    // Off unless OBS confirms it: a renamed scene or source must not stay lit.
                    toggle(key, false);
                    let data = json!({ "sceneName": scene, "sourceName": source });
                    let found = quietly(obs, "GetSceneItemId", Some(data)).await;
                    let Some(id) = found.get("sceneItemId") else {
                        return;
                    };
                    lock(items).push((item_key(scene, &js::to_string(id)), key.clone()));
                    let data = json!({ "sceneName": scene, "sceneItemId": id });
                    let enabled = quietly(obs, "GetSceneItemEnabled", Some(data)).await;
                    toggle(key, flag(&enabled, "sceneItemEnabled"));
                }
                .boxed(),
            });
        }
        for input_name in &parts.fader_inputs {
            let (levels, missing) = (&levels, &missing);
            reads.push(
                async move {
                    let key = format!("obs:{input_name}");
                    let data = json!({ "inputName": input_name });
                    let answer = quietly(obs, "GetInputVolume", Some(data)).await;
                    if answer.is_null() {
                        lock(missing).push(key);
                    } else {
                        let level = fader_position(number(&answer, "inputVolumeMul"));
                        assign(&mut lock(levels), key, level);
                    }
                }
                .boxed(),
            );
        }
        join_all(reads).await;

        let mut toggles = std::mem::take(&mut *lock(&toggles));
        let mut levels = std::mem::take(&mut *lock(&levels));
        let mut missing = std::mem::take(&mut *lock(&missing));
        let items = std::mem::take(&mut *lock(&items));
        let program_scene = lock(&program_scene).take();

        let _telling = lock(&self.telling);
        {
            let mut state = lock(&self.state);
            // A newer refresh (or another OBS) has the better answer.
            if state.socket.as_ref() != Some(obs) || mine != state.refreshes {
                return;
            }
            let changed_at = &state.changed_at;
            let newer = |key: &str| changed_at.get(key).copied().unwrap_or(0) > started_at;
            toggles.retain(|(key, _)| !newer(key));
            levels.retain(|(key, _)| !newer(key));
            missing.retain(|key| !newer(key));
            if state.scene_changed_at <= started_at {
                for (key, value) in Inner::scene_toggles(&parts, program_scene.as_deref()) {
                    assign(&mut toggles, key, value);
                }
            }
            state.scene_items = items.into_iter().collect();
        }
        (self.options.set_toggles)(toggles);
        (self.options.set_levels)(levels);
        if !missing.is_empty() {
            (self.options.drop_levels)(missing);
        }
    }

    fn refresh_soon(self: &Arc<Inner>) {
        let mut state = lock(&self.state);
        if state.refresh_timer.is_some() {
            return;
        }
        let inner = Arc::downgrade(self);
        state.refresh_timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(REFRESH_DEBOUNCE_MS)).await;
            let Some(inner) = inner.upgrade() else {
                return;
            };
            lock(&inner.state).refresh_timer = None;
            // On its own task: this one may be stopped by a detach.
            tokio::spawn(Inner::refresh(inner));
        }));
    }

    /// A toggle OBS reported, kept only when a button shows it.
    fn set(&self, socket: u64, key: String, value: bool) {
        let parts = self.library_parts();
        let _telling = lock(&self.telling);
        {
            let mut state = lock(&self.state);
            if state.socket.as_ref().map(ObsClient::id) != Some(socket)
                || !parts.keys.contains(&key)
            {
                return;
            }
            state.tick += 1;
            let tick = state.tick;
            state.changed_at.insert(key.clone(), tick);
        }
        (self.options.set_toggles)(vec![(key, value)]);
    }

    fn on_event(self: &Arc<Inner>, socket: u64, event: &str, data: &Value) {
        let current = |state: &Following| state.socket.as_ref().map(ObsClient::id) == Some(socket);
        match event {
            "CurrentProgramSceneChanged" => {
                let parts = self.library_parts();
                let _telling = lock(&self.telling);
                {
                    let mut state = lock(&self.state);
                    if !current(&state) {
                        return;
                    }
                    state.tick += 1;
                    state.scene_changed_at = state.tick;
                }
                let scene = data.get("sceneName").and_then(Value::as_str);
                (self.options.set_toggles)(Inner::scene_toggles(&parts, scene));
            }
            "InputMuteStateChanged" => self.set(
                socket,
                format!("mute:{}", text(data, "inputName")),
                flag(data, "inputMuted"),
            ),
            "StreamStateChanged" => self.set(socket, "stream".into(), flag(data, "outputActive")),
            "RecordStateChanged" => self.set(socket, "record".into(), flag(data, "outputActive")),
            "VirtualcamStateChanged" => {
                self.set(socket, "virtualcam".into(), flag(data, "outputActive"));
            }
            "ReplayBufferStateChanged" => {
                self.set(socket, "replaybuffer".into(), flag(data, "outputActive"));
            }
            "SourceFilterEnableStateChanged" => self.set(
                socket,
                format!(
                    "filter:{}\n{}",
                    text(data, "sourceName"),
                    text(data, "filterName")
                ),
                flag(data, "filterEnabled"),
            ),
            "SceneItemEnableStateChanged" => {
                let item = item_key(&text(data, "sceneName"), &text(data, "sceneItemId"));
                let key = lock(&self.state).scene_items.get(&item).cloned();
                if let Some(key) = key {
                    self.set(socket, key, flag(data, "sceneItemEnabled"));
                }
            }
            "InputVolumeChanged" => {
                let input_name = text(data, "inputName");
                let parts = self.library_parts();
                let _telling = lock(&self.telling);
                let key = format!("obs:{input_name}");
                {
                    let mut state = lock(&self.state);
                    if !current(&state) || !parts.fader_inputs.contains(&input_name) {
                        return;
                    }
                    state.tick += 1;
                    let tick = state.tick;
                    state.changed_at.insert(key.clone(), tick);
                }
                let level = fader_position(number(data, "inputVolumeMul"));
                (self.options.set_levels)(vec![(key, level)]);
            }
            // Renaming or rebuilding things in OBS can change what the decks point at.
            "InputNameChanged" | "SceneNameChanged" | "SceneItemCreated" | "SceneItemRemoved" => {
                self.refresh_soon();
            }
            _ => {}
        }
    }
}

// ------------------------------------------------------------- the names

/// Lists by name, written as a JSON object in the order they were added.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct NameLists(pub Vec<(String, Vec<String>)>);

impl Serialize for NameLists {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (name, list) in &self.0 {
            map.serialize_entry(name, list)?;
        }
        map.end()
    }
}

/// Names read from OBS for the Control Center's pickers, in OBS's own order.
/// Empty lists and connected: false when OBS is not connected.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsNames {
    pub connected: bool,
    pub scenes: Vec<String>,
    /// Source names in each scene, by scene name.
    pub scene_items: NameLists,
    /// Inputs that carry audio: the ones mute and faders can act on.
    pub audio_inputs: Vec<String>,
    /// Filter names by source or scene name; sources without filters are left out.
    pub filters: NameLists,
}

impl ObsNames {
    /// What the pickers get while OBS is not connected.
    pub fn disconnected() -> ObsNames {
        ObsNames::default()
    }
}

/// A list OBS must have sent, or the failure JavaScript would have thrown.
fn list_of<'a>(answer: &'a Value, field: &str) -> Result<&'a Vec<Value>, ObsFailure> {
    answer.get(field).and_then(Value::as_array).ok_or_else(|| {
        ObsFailure::Obs(ObsError {
            code: None,
            message: format!("OBS sent no {field}"),
        })
    })
}

/// Every name the Control Center's pickers offer, read from OBS in one go.
pub async fn read_obs_names(obs: &ObsClient) -> Result<ObsNames, ObsFailure> {
    let (scene_list, input_list) = tokio::join!(
        obs_call(obs, "GetSceneList", None),
        obs_call(obs, "GetInputList", None)
    );
    let (scene_list, input_list) = (scene_list?, input_list?);
    // OBS lists scenes bottom-up; its own window shows the highest index first.
    let mut listed: Vec<&Value> = list_of(&scene_list, "scenes")?.iter().collect();
    listed.sort_by(|a, b| {
        let order = number(b, "sceneIndex") - number(a, "sceneIndex");
        order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    let scenes: Vec<String> = listed
        .iter()
        .map(|scene| text(scene, "sceneName"))
        .collect();
    let inputs: Vec<String> = list_of(&input_list, "inputs")?
        .iter()
        .map(|input| text(input, "inputName"))
        .collect();

    // Each filled in as its answer comes.
    let scene_items: Mutex<Vec<(String, Vec<String>)>> = Mutex::new(Vec::new());
    let found: Mutex<HashMap<String, Vec<String>>> = Mutex::new(HashMap::new());
    let audio_inputs: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut reads: Vec<BoxFuture<'_, ()>> = Vec::new();
    for scene_name in &scenes {
        let scene_items = &scene_items;
        reads.push(
            async move {
                let data = json!({ "sceneName": scene_name });
                let answer = quietly(obs, "GetSceneItemList", Some(data)).await;
                let mut sources: Vec<String> = match answer.get("sceneItems") {
                    Some(Value::Array(items)) => {
                        items.iter().map(|item| text(item, "sourceName")).collect()
                    }
                    _ => Vec::new(),
                };
                sources.reverse();
                assign(&mut lock(scene_items), scene_name.clone(), sources);
            }
            .boxed(),
        );
    }
    // Only inputs with audio answer a mute question.
    for input_name in &inputs {
        let audio_inputs = &audio_inputs;
        reads.push(
            async move {
                let data = json!({ "inputName": input_name });
                if !quietly(obs, "GetInputMute", Some(data)).await.is_null() {
                    lock(audio_inputs).push(input_name.clone());
                }
            }
            .boxed(),
        );
    }
    for source_name in scenes.iter().chain(&inputs) {
        let found = &found;
        reads.push(
            async move {
                let data = json!({ "sourceName": source_name });
                let answer = quietly(obs, "GetSourceFilterList", Some(data)).await;
                if let Some(Value::Array(filters)) = answer.get("filters") {
                    if !filters.is_empty() {
                        let names = filters.iter().map(|filter| text(filter, "filterName"));
                        lock(found).insert(source_name.clone(), names.collect());
                    }
                }
            }
            .boxed(),
        );
    }
    join_all(reads).await;

    let mut audio_inputs = std::mem::take(&mut *lock(&audio_inputs));
    let place = |name: &String| inputs.iter().position(|input| input == name);
    audio_inputs.sort_by_key(place);
    // Scenes first, then inputs, each in OBS's order, whatever order OBS answered in.
    let mut found = std::mem::take(&mut *lock(&found));
    let mut filters = Vec::new();
    for source_name in scenes.iter().chain(&inputs) {
        if let Some(list) = found.remove(source_name) {
            filters.push((source_name.clone(), list));
        }
    }
    let scene_items = std::mem::take(&mut *lock(&scene_items));
    Ok(ObsNames {
        connected: true,
        scenes,
        scene_items: NameLists(scene_items),
        audio_inputs,
        filters: NameLists(filters),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obs::fake::{bits, fixture, library_of, settle, wait, FakeObs, FakeOptions, Rig};
    use crate::obs::link::LinkStatus;

    #[test]
    fn fader_positions_match_the_typescript() {
        let cases = fixture("fader-position.json");
        assert!(cases.len() >= 300);
        for case in &cases {
            let input = bits(&case["input"]);
            let ours = fader_position(input);
            let theirs = bits(&case["output"]);
            assert!(
                ours.to_bits() == theirs.to_bits() || (ours.is_nan() && theirs.is_nan()),
                "faderPosition({input:e}) gave {ours:e}, not {theirs:e}"
            );
        }
    }

    #[test]
    fn disconnected_names_are_what_the_pickers_expect() {
        let sent = serde_json::to_value(ObsNames::disconnected()).expect("serializes");
        assert_eq!(
            crate::store::stringify(&sent),
            r#"{"connected":false,"scenes":[],"sceneItems":{},"audioInputs":[],"filters":{}}"#
        );
    }

    async fn connected() -> (FakeObs, Rig) {
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        rig.link.start();
        settle().await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        (good, rig)
    }

    #[tokio::test(start_paused = true)]
    async fn the_state_obs_is_in_is_read_at_connection() {
        // actions.test.mjs: "the state OBS is in, read at connection".
        let (good, rig) = connected().await;
        // Live scene lit from the start; visible source lit from the start.
        assert_eq!(rig.toggle("scene:Main"), Some(true));
        assert_eq!(rig.toggle("scene:Intro"), Some(false));
        assert_eq!(rig.toggle("source:Main\nCamera"), Some(true));
        // Mute, filter, stream read as off.
        assert_eq!(rig.toggle("mute:Mic"), Some(false));
        assert_eq!(rig.toggle("filter:Camera\nBlur"), Some(false));
        for output in OUTPUT_KEYS {
            assert_eq!(rig.toggle(output), Some(false), "{output}");
        }
        // Fader starts at OBS's volume.
        assert_eq!(rig.levels(), vec![("obs:Mic".to_string(), 1.0)]);
        // Only what the decks show was asked for, each thing once, in order.
        assert_eq!(
            good.world().calls,
            [
                "GetCurrentProgramScene",
                "GetStreamStatus",
                "GetRecordStatus",
                "GetVirtualCamStatus",
                "GetReplayBufferStatus",
                "GetInputMute",
                "GetSceneItemId",
                "GetSourceFilter",
                "GetInputVolume",
                "GetSceneItemEnabled",
            ]
        );
        // The keys, in the order JavaScript's object had them.
        let keys: Vec<String> = rig.toggles().into_iter().map(|(key, _)| key).collect();
        assert_eq!(
            keys,
            [
                "source:Main\nCamera",
                "stream",
                "record",
                "virtualcam",
                "replaybuffer",
                "mute:Mic",
                "filter:Camera\nBlur",
                "scene:Intro",
                "scene:Main",
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn changes_made_in_obs_itself_reach_the_decks() {
        // actions.test.mjs: "changes made in OBS itself".
        let (good, rig) = connected().await;
        good.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": true }),
        );
        settle().await;
        // Muting in OBS lights the mic button.
        assert_eq!(rig.toggle("mute:Mic"), Some(true));
        // Changing scene in OBS moves the light.
        good.emit(
            "CurrentProgramSceneChanged",
            json!({ "sceneName": "Intro" }),
        );
        settle().await;
        assert_eq!(
            (rig.toggle("scene:Intro"), rig.toggle("scene:Main")),
            (Some(true), Some(false))
        );
        // Moving OBS's mixer fader moves the deck fader.
        good.emit(
            "InputVolumeChanged",
            json!({ "inputName": "Mic", "inputVolumeMul": 0.125, "inputVolumeDb": -18 }),
        );
        settle().await;
        assert_eq!(rig.level("obs:Mic"), Some(0.5));
        // Going live from OBS lights stream buttons; so with the other outputs.
        for (event, key) in [
            ("StreamStateChanged", "stream"),
            ("RecordStateChanged", "record"),
            ("VirtualcamStateChanged", "virtualcam"),
            ("ReplayBufferStateChanged", "replaybuffer"),
        ] {
            good.emit(event, json!({ "outputActive": true, "outputState": "" }));
            settle().await;
            assert_eq!(rig.toggle(key), Some(true), "{key}");
        }
        // A filter and a scene item a button shows.
        good.emit(
            "SourceFilterEnableStateChanged",
            json!({ "sourceName": "Camera", "filterName": "Blur", "filterEnabled": true }),
        );
        good.emit(
            "SceneItemEnableStateChanged",
            json!({ "sceneName": "Main", "sceneItemId": 1, "sceneItemEnabled": false }),
        );
        // An item no button shows (the mic, item 2) changes nothing.
        good.emit(
            "SceneItemEnableStateChanged",
            json!({ "sceneName": "Main", "sceneItemId": 2, "sceneItemEnabled": false }),
        );
        settle().await;
        assert_eq!(rig.toggle("filter:Camera\nBlur"), Some(true));
        assert_eq!(rig.toggle("source:Main\nCamera"), Some(false));
        assert_eq!(rig.toggles().len(), 9);
    }

    #[tokio::test(start_paused = true)]
    async fn only_what_the_decks_show_is_kept_or_sent() {
        // obs.test.mjs: "only what the decks show".
        let (good, rig) = connected().await;
        wait(300).await;
        let before = rig.snapshots();
        for i in 0..20 {
            good.emit(
                "InputVolumeChanged",
                json!({ "inputName": "Desktop Audio", "inputVolumeMul": f64::from(i) / 20.0, "inputVolumeDb": 0 }),
            );
            good.emit(
                "InputMuteStateChanged",
                json!({ "inputName": "Desktop Audio", "inputMuted": i % 2 == 0 }),
            );
            good.emit(
                "SourceFilterEnableStateChanged",
                json!({ "sourceName": "Mic", "filterName": "Voice Changer", "filterEnabled": i % 2 == 0 }),
            );
        }
        wait(300).await;
        // Events for inputs and filters no deck shows are not kept…
        assert_eq!(rig.toggle("mute:Desktop Audio"), None);
        assert_eq!(rig.toggle("filter:Mic\nVoice Changer"), None);
        assert_eq!(rig.level("obs:Desktop Audio"), None);
        // …nor sent to the decks.
        assert_eq!(rig.snapshots(), before);
        good.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": true }),
        );
        settle().await;
        assert_eq!(rig.toggle("mute:Mic"), Some(true));
        // Events for what a deck shows still arrive.
        assert_eq!(rig.snapshots(), before + 1);
        good.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": false }),
        );

        good.world().current_scene = "BRB".to_string();
        good.emit("CurrentProgramSceneChanged", json!({ "sceneName": "BRB" }));
        settle().await;
        // Going to a scene no button shows turns the scene buttons off.
        assert_eq!(rig.toggle("scene:Main"), Some(false));
        assert_eq!(rig.toggle("scene:BRB"), None);
        assert_eq!(rig.toggle("scene:Intro"), Some(false));
        good.world().current_scene = "Main".to_string();
        good.emit("CurrentProgramSceneChanged", json!({ "sceneName": "Main" }));
        settle().await;
        assert_eq!(rig.toggle("scene:Main"), Some(true));
    }

    fn reads(fake: &FakeObs) -> usize {
        let world = fake.world();
        world
            .calls
            .iter()
            .filter(|call| *call == "GetCurrentProgramScene")
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_scene_edits_is_read_back_once() {
        // obs.test.mjs: "scene edits: one read for a burst…".
        let (good, rig) = connected().await;
        wait(300).await;
        let before = reads(&good);
        for i in 0..12 {
            good.emit(
                "SceneItemCreated",
                json!({ "sceneName": "Main", "sourceName": format!("x{i}"), "sceneItemId": 100 + i, "sceneItemIndex": i }),
            );
        }
        wait(REFRESH_DEBOUNCE_MS - 10).await;
        assert_eq!(reads(&good), before);
        wait(500).await;
        assert_eq!(reads(&good) - before, 1);
        // Each of the other things that can move what a deck points at.
        for event in ["InputNameChanged", "SceneNameChanged", "SceneItemRemoved"] {
            let before = reads(&good);
            good.emit(event, json!({}));
            wait(500).await;
            assert_eq!(reads(&good) - before, 1, "{event}");
        }
        drop(rig);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_read_does_not_undo_a_newer_change_from_obs() {
        // obs.test.mjs: "…and events win over a slow read".
        let (good, rig) = connected().await;
        good.world().delays.insert("GetInputMute".to_string(), 500);
        good.emit(
            "SceneItemRemoved",
            json!({ "sceneName": "Main", "sourceName": "x0", "sceneItemId": 100 }),
        );
        wait(250).await; // the read is out, its answer (not muted) on the way
        good.world().set_muted("Mic", true);
        good.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": true }),
        );
        good.emit(
            "CurrentProgramSceneChanged",
            json!({ "sceneName": "Intro" }),
        );
        wait(700).await;
        assert_eq!(rig.toggle("mute:Mic"), Some(true));
        // The same for the scene: the read saw Main, the event said Intro.
        assert_eq!(
            (rig.toggle("scene:Intro"), rig.toggle("scene:Main")),
            (Some(true), Some(false))
        );
        // The next read, started after the change, is believed again.
        good.world().delays.clear();
        good.world().set_muted("Mic", false);
        rig.state.refresh();
        settle().await;
        assert_eq!(rig.toggle("mute:Mic"), Some(false));
        assert_eq!(
            (rig.toggle("scene:Intro"), rig.toggle("scene:Main")),
            (Some(false), Some(true))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn of_two_reads_only_the_newer_is_believed() {
        let (good, rig) = connected().await;
        good.world().delays.insert("GetInputMute".to_string(), 500);
        let before = rig.snapshots();
        rig.state.refresh();
        wait(100).await;
        good.world().delays.insert("GetInputMute".to_string(), 100);
        good.world().set_muted("Mic", true);
        rig.state.refresh();
        wait(1000).await;
        assert_eq!(rig.toggle("mute:Mic"), Some(true));
        // One read told the owner (toggles, then levels); the stale one kept quiet.
        assert_eq!(rig.snapshots() - before, 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_renamed_source_does_not_stay_lit() {
        // obs.test.mjs: "a renamed source does not stay lit".
        let (good, rig) = connected().await;
        assert_eq!(rig.toggle("source:Main\nCamera"), Some(true));
        good.world().rename_item("Main", "Camera", "Webcam");
        good.emit(
            "InputNameChanged",
            json!({ "oldInputName": "Camera", "inputName": "Webcam" }),
        );
        wait(500).await;
        // A source OBS no longer has shows as off,
        assert_eq!(rig.toggle("source:Main\nCamera"), Some(false));
        // and its item's events are no longer the button's.
        good.emit(
            "SceneItemEnableStateChanged",
            json!({ "sceneName": "Main", "sceneItemId": 1, "sceneItemEnabled": true }),
        );
        settle().await;
        assert_eq!(rig.toggle("source:Main\nCamera"), Some(false));
    }

    #[tokio::test(start_paused = true)]
    async fn a_fader_whose_input_is_gone_has_its_level_dropped() {
        let (good, rig) = connected().await;
        assert_eq!(rig.level("obs:Mic"), Some(1.0));
        good.world().rename_input("Mic", "Microphone");
        good.emit(
            "InputNameChanged",
            json!({ "oldInputName": "Mic", "inputName": "Microphone" }),
        );
        wait(500).await;
        assert_eq!(rig.level("obs:Mic"), None);
        assert_eq!(rig.dropped(), vec![vec!["obs:Mic".to_string()]]);
        // What cannot be read shows as off.
        assert_eq!(rig.toggle("mute:Mic"), Some(false));
    }

    #[tokio::test(start_paused = true)]
    async fn new_buttons_are_read_when_the_library_changes() {
        let (good, rig) = connected().await;
        assert_eq!(rig.toggle("mute:Desktop Audio"), None);
        good.world().set_muted("Desktop Audio", true);
        rig.set_library(library_of(json!([
            { "id": "desk", "control": "press", "steps": [{ "type": "obs_toggle_mute", "sourceName": "Desktop Audio" }],
              "offSteps": [{ "type": "obs_scene", "sceneName": "BRB" }] },
            { "id": "f", "control": "fader", "fader": { "target": "obs_input", "inputName": "Desktop Audio" } },
            { "id": "g", "control": "fader", "fader": { "target": "system", "inputName": "Mic" } },
        ])));
        rig.state.refresh();
        settle().await;
        assert_eq!(rig.toggle("mute:Desktop Audio"), Some(true));
        // Second lists count too.
        assert_eq!(rig.toggle("scene:BRB"), Some(false));
        // 0.5 in OBS's gain is 0.79 of the way up its fader.
        assert_eq!(rig.level("obs:Desktop Audio"), Some(fader_position(0.5)));
        // Events follow the new library at once.
        good.emit("CurrentProgramSceneChanged", json!({ "sceneName": "BRB" }));
        good.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": true }),
        );
        settle().await;
        assert_eq!(rig.toggle("scene:BRB"), Some(true));
        // The mic's button is gone, so its events are nobody's.
        assert_eq!(rig.toggle("mute:Mic"), Some(false));
    }

    #[tokio::test(start_paused = true)]
    async fn after_detaching_nothing_from_that_obs_is_believed() {
        let (good, rig) = connected().await;
        good.world().delays.insert("GetInputMute".to_string(), 500);
        good.world().set_muted("Mic", true);
        rig.state.refresh();
        wait(100).await;
        rig.state.detach();
        let before = rig.snapshots();
        good.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": true }),
        );
        good.emit(
            "CurrentProgramSceneChanged",
            json!({ "sceneName": "Intro" }),
        );
        good.emit("SceneItemCreated", json!({}));
        wait(1000).await;
        assert_eq!(rig.snapshots(), before);
        assert_eq!(rig.toggle("mute:Mic"), Some(false));
        // Refreshing with no OBS is nothing.
        rig.state.refresh();
        settle().await;
        assert_eq!(rig.snapshots(), before);
    }

    #[tokio::test(start_paused = true)]
    async fn a_reconnection_reads_everything_again() {
        let (good, rig) = connected().await;
        good.disconnect();
        settle().await;
        assert!(rig.toggles().is_empty());
        good.world().set_muted("Mic", true);
        good.world().current_scene = "Intro".to_string();
        wait(2100).await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        assert_eq!(rig.toggle("mute:Mic"), Some(true));
        assert_eq!(rig.toggle("scene:Intro"), Some(true));
        assert_eq!(rig.level("obs:Mic"), Some(1.0));
    }
}
