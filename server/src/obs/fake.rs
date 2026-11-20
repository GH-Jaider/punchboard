//! For tests: a stand-in for OBS Studio's WebSocket server (protocol v5, in
//! JSON), with the small scene collection of tests/fake-obs.mjs, so the
//! client, the link and the state reader are tested without anyone's real
//! OBS. Like that one it can misbehave: hold back its greeting or never
//! greet, ask for a password, never answer some requests, answer others
//! late, close, or vanish.
//!
//! It lives in memory (a link is handed [`FakeObs::dialer`] instead of the
//! network), so tests run on tokio's paused clock: six seconds of waiting
//! for a greeting take no time, and nothing depends on the machine's speed.
//! [`FakeObs::listen`] puts it on a real port for the few tests of the real
//! dialer. [`Rig`] is a link and a state reader wired as the server wires them.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::{FutureExt, SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

use super::client::{authentication, lock, open_over, Dialer, ObsClient, ObsError, PROTOCOL};
use super::link::{
    assign, obs_call, Levels, LinkStatus, ObsFailure, ObsLink, ObsLinkOptions, ObsSettings,
};
use super::state::{ObsState, ObsStateOptions, Toggles};
use crate::model::{normalize_library, Ids, Library};
use crate::translate::{Translate, Var};

// ------------------------------------------------------------- fixtures

/// The cases of tests/fixtures/obs/<file>, written by tests/fixtures/make-obs.ts.
pub fn fixture(file: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/obs")
        .join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    match serde_json::from_str(&text) {
        Ok(Value::Array(cases)) => cases,
        other => panic!("{} is not a list of cases: {other:?}", path.display()),
    }
}

/// A number the generator wrote as its 64 bits, so NaN and every last digit arrive.
pub fn bits(value: &Value) -> f64 {
    let text = value.as_str().expect("a number's bits");
    f64::from_bits(u64::from_str_radix(text, 16).expect("hexadecimal"))
}

// ----------------------------------------------------------------- time

/// Lets everything that can run, run.
pub async fn settle() {
    tokio::time::sleep(Duration::from_millis(1)).await;
}

pub async fn wait(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

// ------------------------------------------------------------- the world

pub struct Input {
    pub audio: bool,
    pub muted: bool,
    pub volume_mul: f64,
    pub filters: Vec<(String, bool)>,
}

pub struct Item {
    pub id: i64,
    pub source: String,
    pub enabled: bool,
}

/// What the fake OBS holds, and how it is told to misbehave.
pub struct World {
    pub current_scene: String,
    pub studio_mode: bool,
    pub stream: bool,
    pub record: bool,
    pub virtualcam: bool,
    pub replay: bool,
    pub inputs: Vec<(String, Input)>,
    /// Scene names with their items; each list is in OBS's bottom-up order.
    pub scenes: Vec<(String, Vec<Item>)>,
    /// Every request type received, in order.
    pub calls: Vec<String>,
    /// Every Identify received.
    pub identified: Vec<Value>,
    /// Request types that are never answered.
    pub stalled: HashSet<String>,
    /// Request type -> ms before its answer is sent.
    pub delays: HashMap<String, u64>,
}

impl World {
    fn new() -> World {
        let input = |audio: bool, volume_mul: f64, filters: &[&str]| Input {
            audio,
            muted: false,
            volume_mul,
            filters: filters
                .iter()
                .map(|name| ((*name).to_string(), false))
                .collect(),
        };
        let item = |id: i64, source: &str| Item {
            id,
            source: source.to_string(),
            enabled: true,
        };
        World {
            current_scene: "Main".to_string(),
            studio_mode: false,
            stream: false,
            record: false,
            virtualcam: false,
            replay: false,
            inputs: vec![
                ("Mic".to_string(), input(true, 1.0, &["Voice Changer"])),
                ("Desktop Audio".to_string(), input(true, 0.5, &[])),
                ("Camera".to_string(), input(false, 0.0, &["Blur"])),
            ],
            scenes: vec![
                ("BRB".to_string(), Vec::new()),
                ("Main".to_string(), vec![item(1, "Camera"), item(2, "Mic")]),
                ("Intro".to_string(), Vec::new()),
            ],
            calls: Vec::new(),
            identified: Vec::new(),
            stalled: HashSet::new(),
            delays: HashMap::new(),
        }
    }

    fn input(&mut self, name: &str) -> Result<&mut Input, String> {
        self.inputs
            .iter_mut()
            .find(|(known, _)| known == name)
            .map(|(_, input)| input)
            .ok_or_else(|| format!("No source was found by the name of `{name}`."))
    }

    fn audio_input(&mut self, name: &str) -> Result<&mut Input, String> {
        let input = self.input(name)?;
        if input.audio {
            Ok(input)
        } else {
            Err("The specified input does not support audio.".to_string())
        }
    }

    fn scene(&mut self, name: &str) -> Result<&mut Vec<Item>, String> {
        self.scenes
            .iter_mut()
            .find(|(known, _)| known == name)
            .map(|(_, items)| items)
            .ok_or_else(|| "No scene".to_string())
    }

    fn item(&mut self, scene: &str, id: i64) -> Result<&mut Item, String> {
        self.scene(scene)?
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "No scene item".to_string())
    }

    fn filter(&mut self, source: &str, filter: &str) -> Result<&mut bool, String> {
        let input = self
            .input(source)
            .map_err(|_| format!("No source `{source}`"))?;
        input
            .filters
            .iter_mut()
            .find(|(known, _)| known == filter)
            .map(|(_, enabled)| enabled)
            .ok_or_else(|| format!("No filter `{filter}`"))
    }

    pub fn set_muted(&mut self, input: &str, muted: bool) {
        self.input(input).expect("the input").muted = muted;
    }

    pub fn rename_input(&mut self, from: &str, to: &str) {
        for (name, _) in &mut self.inputs {
            if name == from {
                *name = to.to_string();
            }
        }
    }

    pub fn rename_item(&mut self, scene: &str, from: &str, to: &str) {
        for item in self.scene(scene).expect("the scene") {
            if item.source == from {
                item.source = to.to_string();
            }
        }
    }

    /// Answers one request: its response data (or none), and the events it causes.
    fn handle(
        &mut self,
        request: &str,
        data: &Value,
        events: &mut Vec<(String, Value)>,
    ) -> Result<Value, String> {
        let text = |name: &str| {
            data.get(name)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let flag = |name: &str| data.get(name).and_then(Value::as_bool).unwrap_or(false);
        let mut emit = |event: &str, data: Value| events.push((event.to_string(), data));
        let none = Ok(Value::Null);
        match request {
            "GetVersion" => Ok(
                json!({ "obsVersion": "31.0.0", "obsWebSocketVersion": "5.5.0", "rpcVersion": 1 }),
            ),
            "GetCurrentProgramScene" => Ok(
                json!({ "currentProgramSceneName": self.current_scene, "sceneName": self.current_scene }),
            ),
            "SetCurrentProgramScene" => {
                let scene_name = text("sceneName");
                if self.scene(&scene_name).is_err() {
                    return Err(format!(
                        "No source was found by the name of `{scene_name}`."
                    ));
                }
                self.current_scene.clone_from(&scene_name);
                emit(
                    "CurrentProgramSceneChanged",
                    json!({ "sceneName": scene_name }),
                );
                none
            }
            "GetSceneList" => {
                let scenes: Vec<Value> = self
                    .scenes
                    .iter()
                    .enumerate()
                    .map(|(index, (name, _))| json!({ "sceneName": name, "sceneIndex": index }))
                    .collect();
                Ok(json!({ "currentProgramSceneName": self.current_scene, "scenes": scenes }))
            }
            "GetInputList" => {
                let inputs: Vec<Value> = self
                    .inputs
                    .iter()
                    .map(|(name, _)| json!({ "inputName": name }))
                    .collect();
                Ok(json!({ "inputs": inputs }))
            }
            "GetSceneItemList" => {
                // Bottom-up, index 0 first, like OBS.
                let items: Vec<Value> = self
                    .scene(&text("sceneName"))?
                    .iter()
                    .map(|item| json!({ "sourceName": item.source, "sceneItemId": item.id }))
                    .collect();
                Ok(json!({ "sceneItems": items }))
            }
            "GetSourceFilterList" => {
                let source = text("sourceName");
                let filters: Vec<Value> = match self.input(&source) {
                    Ok(input) => input
                        .filters
                        .iter()
                        .map(|(name, _)| json!({ "filterName": name }))
                        .collect(),
                    Err(_) => {
                        self.scene(&source).map_err(|_| "No source".to_string())?;
                        Vec::new()
                    }
                };
                Ok(json!({ "filters": filters }))
            }
            "GetInputMute" => {
                Ok(json!({ "inputMuted": self.audio_input(&text("inputName"))?.muted }))
            }
            "ToggleInputMute" => {
                let input = self.audio_input(&text("inputName"))?;
                input.muted = !input.muted;
                let muted = input.muted;
                emit(
                    "InputMuteStateChanged",
                    json!({ "inputName": text("inputName"), "inputMuted": muted }),
                );
                Ok(json!({ "inputMuted": muted }))
            }
            "SetInputMute" => {
                self.audio_input(&text("inputName"))?.muted = flag("inputMuted");
                emit(
                    "InputMuteStateChanged",
                    json!({ "inputName": text("inputName"), "inputMuted": flag("inputMuted") }),
                );
                none
            }
            "GetInputVolume" => Ok(
                json!({ "inputVolumeMul": self.audio_input(&text("inputName"))?.volume_mul, "inputVolumeDb": 0 }),
            ),
            "SetInputVolume" => {
                let mul = data
                    .get("inputVolumeMul")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                self.audio_input(&text("inputName"))?.volume_mul = mul;
                emit(
                    "InputVolumeChanged",
                    json!({ "inputName": text("inputName"), "inputVolumeMul": mul, "inputVolumeDb": 0 }),
                );
                none
            }
            "GetSceneItemId" => {
                let source = text("sourceName");
                let item = self
                    .scene(&text("sceneName"))?
                    .iter()
                    .find(|item| item.source == source)
                    .ok_or_else(|| "No item".to_string())?;
                Ok(json!({ "sceneItemId": item.id }))
            }
            "GetSceneItemEnabled" => {
                let id = data
                    .get("sceneItemId")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1);
                Ok(json!({ "sceneItemEnabled": self.item(&text("sceneName"), id)?.enabled }))
            }
            "SetSceneItemEnabled" => {
                let id = data
                    .get("sceneItemId")
                    .and_then(Value::as_i64)
                    .unwrap_or(-1);
                self.item(&text("sceneName"), id)?.enabled = flag("sceneItemEnabled");
                emit(
                    "SceneItemEnableStateChanged",
                    json!({ "sceneName": text("sceneName"), "sceneItemId": id, "sceneItemEnabled": flag("sceneItemEnabled") }),
                );
                none
            }
            "GetSourceFilter" => Ok(
                json!({ "filterEnabled": *self.filter(&text("sourceName"), &text("filterName"))? }),
            ),
            "SetSourceFilterEnabled" => {
                *self.filter(&text("sourceName"), &text("filterName"))? = flag("filterEnabled");
                emit(
                    "SourceFilterEnableStateChanged",
                    json!({ "sourceName": text("sourceName"), "filterName": text("filterName"), "filterEnabled": flag("filterEnabled") }),
                );
                none
            }
            "GetStreamStatus" => Ok(json!({ "outputActive": self.stream })),
            "GetRecordStatus" => Ok(json!({ "outputActive": self.record })),
            "GetVirtualCamStatus" => Ok(json!({ "outputActive": self.virtualcam })),
            "GetReplayBufferStatus" => Ok(json!({ "outputActive": self.replay })),
            "StartStream" | "StopStream" => {
                self.stream = request == "StartStream";
                emit(
                    "StreamStateChanged",
                    json!({ "outputActive": self.stream, "outputState": "" }),
                );
                none
            }
            "StartRecord" | "StopRecord" => {
                self.record = request == "StartRecord";
                emit(
                    "RecordStateChanged",
                    json!({ "outputActive": self.record, "outputState": "" }),
                );
                none
            }
            "StartVirtualCam" | "StopVirtualCam" => {
                self.virtualcam = request == "StartVirtualCam";
                emit(
                    "VirtualcamStateChanged",
                    json!({ "outputActive": self.virtualcam, "outputState": "" }),
                );
                none
            }
            "SaveReplayBuffer" => {
                if self.replay {
                    none
                } else {
                    Err("Replay buffer is not active.".to_string())
                }
            }
            "GetStudioModeEnabled" => Ok(json!({ "studioModeEnabled": self.studio_mode })),
            other => Err(format!("Fake OBS has no {other}")),
        }
    }
}

// -------------------------------------------------------------- the fake

/// When the fake greets a new connection.
#[derive(Clone, Copy)]
pub enum Hello {
    /// After this many milliseconds (0: at once).
    After(u64),
    /// Accepts the connection and never says a word.
    Never,
}

pub struct FakeOptions {
    pub hello: Hello,
    /// Asks for this password when set.
    pub password: Option<String>,
    pub salt: String,
    pub challenge: String,
    /// Asks for a password and lets anyone in (to see what a client sends).
    pub accept_any_password: bool,
}

impl Default for FakeOptions {
    fn default() -> FakeOptions {
        FakeOptions {
            hello: Hello::After(0),
            password: None,
            salt: "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=".to_string(),
            challenge: "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=".to_string(),
            accept_any_password: false,
        }
    }
}

impl FakeOptions {
    pub fn with_password(password: &str) -> FakeOptions {
        FakeOptions {
            password: Some(password.to_string()),
            ..FakeOptions::default()
        }
    }
}

enum Out {
    Text(String),
    Close(u16, String),
    /// Vanish, as a crashed OBS would.
    Drop,
}

struct Shared {
    options: FakeOptions,
    world: Mutex<World>,
    clients: Mutex<Vec<(u64, mpsc::UnboundedSender<Out>)>>,
    next_client: AtomicU64,
}

#[derive(Clone)]
pub struct FakeObs {
    shared: Arc<Shared>,
}

fn message(op: i64, d: &Value) -> Out {
    Out::Text(json!({ "op": op, "d": d }).to_string())
}

impl FakeObs {
    pub fn start(options: FakeOptions) -> FakeObs {
        FakeObs {
            shared: Arc::new(Shared {
                options,
                world: Mutex::new(World::new()),
                clients: Mutex::new(Vec::new()),
                next_client: AtomicU64::new(1),
            }),
        }
    }

    pub fn world(&self) -> MutexGuard<'_, World> {
        lock(&self.shared.world)
    }

    /// How many clients are connected right now.
    pub fn clients(&self) -> usize {
        lock(&self.shared.clients).len()
    }

    fn to_all(&self, out: impl Fn() -> Out) {
        for (_, client) in lock(&self.shared.clients).iter() {
            let _ = client.send(out());
        }
    }

    pub fn emit(&self, event_type: &str, event_data: Value) {
        let d = json!({ "eventType": event_type, "eventIntent": 1, "eventData": event_data });
        self.to_all(|| message(5, &d));
    }

    /// Drops every connection, as OBS closing would.
    pub fn disconnect(&self) {
        self.to_all(|| Out::Drop);
    }

    /// Closes every connection properly, with a code and a reason.
    pub fn close_with(&self, code: u16, reason: &str) {
        self.to_all(|| Out::Close(code, reason.to_string()));
    }

    /// A dialer that reaches this fake whatever the address.
    pub fn dialer(&self) -> Dialer {
        dialer_for(&[("ws://obs", self)])
    }

    /// Puts the fake on a real port of this computer.
    pub async fn listen(&self) -> SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binds");
        let address = listener.local_addr().expect("an address");
        let fake = self.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                fake.serve(stream);
            }
        });
        address
    }

    /// Takes one connection.
    pub fn serve<S>(&self, stream: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        tokio::spawn(self.clone().connection(stream));
    }

    fn asks(&self) -> bool {
        self.shared.options.password.is_some() || self.shared.options.accept_any_password
    }

    async fn connection<S>(self, stream: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        #[allow(clippy::result_large_err)]
        let subprotocol = |_: &Request, mut response: Response| {
            response
                .headers_mut()
                .insert("Sec-WebSocket-Protocol", HeaderValue::from_static(PROTOCOL));
            Ok(response)
        };
        let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, subprotocol).await else {
            return;
        };
        let (mut sink, mut stream) = socket.split();
        let (out, mut outgoing) = mpsc::unbounded_channel();
        let id = self.shared.next_client.fetch_add(1, Ordering::Relaxed);
        lock(&self.shared.clients).push((id, out.clone()));

        let options = &self.shared.options;
        let mut hello = json!({ "obsWebSocketVersion": "5.5.0", "rpcVersion": 1 });
        if self.asks() {
            hello["authentication"] =
                json!({ "challenge": options.challenge, "salt": options.salt });
        }
        match options.hello {
            Hello::After(0) => {
                let _ = out.send(message(0, &hello));
            }
            Hello::After(ms) => {
                let out = out.clone();
                tokio::spawn(async move {
                    wait(ms).await;
                    let _ = out.send(message(0, &hello));
                });
            }
            Hello::Never => {}
        }

        loop {
            tokio::select! {
                biased;
                next = outgoing.recv() => match next {
                    Some(Out::Text(text)) => {
                        if sink.send(Message::text(text)).await.is_err() {
                            break;
                        }
                    }
                    Some(Out::Close(code, reason)) => {
                        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
                        let _ = sink.send(Message::Close(Some(frame))).await;
                        break;
                    }
                    Some(Out::Drop) | None => break,
                },
                received = stream.next() => match received {
                    Some(Ok(Message::Text(text))) => self.received(text.as_str(), &out),
                    Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
        lock(&self.shared.clients).retain(|(known, _)| *known != id);
    }

    fn received(&self, text: &str, out: &mpsc::UnboundedSender<Out>) {
        let Ok(received) = serde_json::from_str::<Value>(text) else {
            return;
        };
        let d = &received["d"];
        match received["op"].as_i64() {
            Some(1) => {
                self.world().identified.push(d.clone());
                let options = &self.shared.options;
                if let (Some(password), false) = (&options.password, options.accept_any_password) {
                    let wanted = authentication(password, &options.salt, &options.challenge);
                    if d["authentication"].as_str() != Some(wanted.as_str()) {
                        let _ = out.send(Out::Close(4009, "Authentication failed.".to_string()));
                        return;
                    }
                }
                let _ = out.send(message(2, &json!({ "negotiatedRpcVersion": 1 })));
            }
            Some(6) => {
                let request_type = d["requestType"].as_str().unwrap_or("").to_string();
                let mut events = Vec::new();
                let (handled, delay) = {
                    let mut world = self.world();
                    world.calls.push(request_type.clone());
                    if world.stalled.contains(&request_type) {
                        return;
                    }
                    let handled = world.handle(&request_type, &d["requestData"], &mut events);
                    (handled, world.delays.get(&request_type).copied())
                };
                for (event, data) in events {
                    self.emit(&event, data);
                }
                let mut answer =
                    json!({ "requestType": request_type, "requestId": d["requestId"] });
                match handled {
                    Ok(data) => {
                        answer["requestStatus"] = json!({ "result": true, "code": 100 });
                        if !data.is_null() {
                            answer["responseData"] = data;
                        }
                    }
                    Err(comment) => {
                        answer["requestStatus"] =
                            json!({ "result": false, "code": 600, "comment": comment });
                    }
                }
                // A delayed answer is read now and arrives later, like a slow OBS's.
                match delay {
                    Some(ms) if ms > 0 => {
                        let out = out.clone();
                        tokio::spawn(async move {
                            wait(ms).await;
                            let _ = out.send(message(7, &answer));
                        });
                    }
                    _ => {
                        let _ = out.send(message(7, &answer));
                    }
                }
            }
            _ => {}
        }
    }
}

/// A network in memory: each address reaches its fake; nothing listens anywhere else.
pub fn dialer_for(fakes: &[(&str, &FakeObs)]) -> Dialer {
    let fakes: Vec<(String, FakeObs)> = fakes
        .iter()
        .map(|(address, fake)| ((*address).to_string(), (*fake).clone()))
        .collect();
    Arc::new(move |url: String| {
        let fake = fakes
            .iter()
            .find(|(address, _)| *address == url)
            .map(|(_, fake)| fake.clone());
        async move {
            let Some(fake) = fake else {
                return Err(ObsError::new(-1, "connect ECONNREFUSED"));
            };
            let (ours, theirs) = tokio::io::duplex(1 << 16);
            fake.serve(theirs);
            open_over(&url, ours).await
        }
        .boxed()
    })
}

// ------------------------------------------------------------ the decks

struct Keys;

impl Translate for Keys {
    fn t(&self, key: &str, _: &[(&str, Var)]) -> String {
        key.to_string()
    }
}

/// A library of one deck with these buttons, each given what a saved button has.
pub fn library_of(buttons: Value) -> Arc<Library> {
    let buttons: Vec<Value> = buttons
        .as_array()
        .expect("a list of buttons")
        .iter()
        .enumerate()
        .map(|(slot, button)| {
            let mut full = json!({ "slot": slot, "label": button["id"], "icon": "bolt", "color": "accent", "steps": [] });
            for (name, value) in button.as_object().expect("a button") {
                full[name] = value.clone();
            }
            for list in ["steps", "offSteps"] {
                let Some(steps) = full.get_mut(list).and_then(Value::as_array_mut) else {
                    continue;
                };
                for (at, step) in steps.iter_mut().enumerate() {
                    step["id"] = json!(format!("s_{slot}_{list}_{at}"));
                    step["delayMs"] = json!(0);
                }
            }
            full
        })
        .collect();
    let raw = json!({
        "version": 1,
        "activeProfileId": "main",
        "profiles": [{ "id": "main", "name": "Main", "columns": 4, "rows": 3, "buttons": buttons }],
    });
    Arc::new(normalize_library(&raw, &Keys, &Ids::new(|| 0)))
}

/// The deck of tests/obs.test.mjs, with the filter button of tests/actions.test.mjs.
pub fn deck() -> Arc<Library> {
    library_of(json!([
        { "id": "intro", "control": "press", "steps": [{ "type": "obs_scene", "sceneName": "Intro" }] },
        { "id": "mainScene", "control": "press", "steps": [{ "type": "obs_scene", "sceneName": "Main" }] },
        { "id": "mic", "control": "press", "steps": [{ "type": "obs_toggle_mute", "sourceName": "Mic" }] },
        { "id": "cam", "control": "press", "steps": [{ "type": "obs_toggle_source", "sceneName": "Main", "sourceName": "Camera" }] },
        { "id": "blur", "control": "press", "steps": [{ "type": "obs_toggle_filter", "sourceName": "Camera", "filterName": "Blur" }] },
        { "id": "micFader", "control": "fader", "fader": { "target": "obs_input", "inputName": "Mic" } },
    ]))
}

// --------------------------------------------------------------- the rig

#[derive(Default)]
struct Seen {
    toggles: Toggles,
    levels: Levels,
    /// Times the reader told its owner anything.
    snapshots: usize,
    meters: Vec<Levels>,
    dropped: Vec<Vec<String>>,
    log: Vec<String>,
    statuses: usize,
}

struct Desk {
    seen: Mutex<Seen>,
    settings: Mutex<ObsSettings>,
    library: Mutex<Arc<Library>>,
    watching: AtomicBool,
    failing: AtomicBool,
    dials: Arc<AtomicUsize>,
}

/// A link and a state reader, wired to each other and to an owner that keeps
/// what they report, the way the server does (src/server/main.ts).
pub struct Rig {
    pub link: ObsLink,
    pub state: ObsState,
    desk: Arc<Desk>,
}

impl Rig {
    pub fn new(fakes: &[(&str, &FakeObs)], address: &str) -> Rig {
        let desk = Arc::new(Desk {
            seen: Mutex::new(Seen::default()),
            settings: Mutex::new(ObsSettings {
                address: address.to_string(),
                password: String::new(),
            }),
            library: Mutex::new(deck()),
            watching: AtomicBool::new(true),
            failing: AtomicBool::new(false),
            dials: Arc::new(AtomicUsize::new(0)),
        });
        let (library, toggles, levels, dropped) =
            (desk.clone(), desk.clone(), desk.clone(), desk.clone());
        let state = ObsState::new(ObsStateOptions {
            library: Box::new(move || lock(&library.library).clone()),
            set_toggles: Box::new(move |changes| {
                let mut seen = lock(&toggles.seen);
                seen.snapshots += 1;
                for (key, value) in changes {
                    assign(&mut seen.toggles, key, value);
                }
            }),
            set_levels: Box::new(move |changes| {
                let mut seen = lock(&levels.seen);
                seen.snapshots += 1;
                for (key, value) in changes {
                    assign(&mut seen.levels, key, value);
                }
            }),
            drop_levels: Box::new(move |keys| {
                let mut seen = lock(&dropped.seen);
                seen.snapshots += 1;
                seen.levels.retain(|(key, _)| !keys.contains(key));
                seen.dropped.push(keys);
            }),
        });
        let network = dialer_for(fakes);
        let (settings, log, status, meters, wanted, dialing) = (
            desk.clone(),
            desk.clone(),
            desk.clone(),
            desk.clone(),
            desk.clone(),
            desk.clone(),
        );
        let (attached, detached) = (state.clone(), state.clone());
        let link = ObsLink::new(ObsLinkOptions {
            settings: Box::new(move || lock(&settings.settings).clone()),
            log: Box::new(move |line| lock(&log.seen).log.push(line.to_string())),
            on_connected: Box::new(move |socket| attached.attach(socket)),
            on_status: Box::new(move |link| {
                // Whatever OBS reported stops being true the moment it goes away.
                let down = link.status() != LinkStatus::Connected;
                if down {
                    detached.detach();
                }
                let mut seen = lock(&status.seen);
                if down {
                    seen.toggles.clear();
                    seen.levels.clear();
                }
                seen.statuses += 1;
            }),
            on_meters: Box::new(move |levels| lock(&meters.seen).meters.push(levels)),
            wanted_inputs: Box::new(move || {
                let mut inputs = HashSet::new();
                if wanted.watching.load(Ordering::SeqCst) {
                    inputs.insert("Mic".to_string());
                }
                inputs
            }),
            dial: Arc::new(move |url: String| {
                dialing.dials.fetch_add(1, Ordering::SeqCst);
                if dialing.failing.load(Ordering::SeqCst) {
                    return async { Err(ObsError::new(-1, "connect ECONNREFUSED")) }.boxed();
                }
                network(url)
            }),
        });
        Rig { link, state, desk }
    }

    pub fn set_address(&self, address: &str) {
        lock(&self.desk.settings).address = address.to_string();
    }

    pub fn set_password(&self, password: &str) {
        lock(&self.desk.settings).password = password.to_string();
    }

    pub fn set_library(&self, library: Arc<Library>) {
        *lock(&self.desk.library) = library;
    }

    /// Whether anyone is looking at the mic's meter.
    pub fn watch_meters(&self, watching: bool) {
        self.desk.watching.store(watching, Ordering::SeqCst);
    }

    /// Makes every dial fail (nothing listening) or work again; the count of dials so far.
    pub fn fail_dials(&self, failing: bool) -> Arc<AtomicUsize> {
        self.desk.failing.store(failing, Ordering::SeqCst);
        Arc::clone(&self.desk.dials)
    }

    /// What a scene button does: the link's client, then the request.
    pub async fn set_scene(&self, scene_name: &str) -> Result<Value, ObsFailure> {
        let obs: ObsClient = self.link.connect().await?;
        obs_call(
            &obs,
            "SetCurrentProgramScene",
            Some(json!({ "sceneName": scene_name })),
        )
        .await
    }

    pub fn toggles(&self) -> Toggles {
        lock(&self.desk.seen).toggles.clone()
    }

    pub fn toggle(&self, key: &str) -> Option<bool> {
        self.toggles()
            .into_iter()
            .find(|(known, _)| known == key)
            .map(|(_, value)| value)
    }

    pub fn levels(&self) -> Levels {
        lock(&self.desk.seen).levels.clone()
    }

    pub fn level(&self, key: &str) -> Option<f64> {
        self.levels()
            .into_iter()
            .find(|(known, _)| known == key)
            .map(|(_, value)| value)
    }

    pub fn snapshots(&self) -> usize {
        lock(&self.desk.seen).snapshots
    }

    pub fn meters(&self) -> Vec<Levels> {
        lock(&self.desk.seen).meters.clone()
    }

    pub fn dropped(&self) -> Vec<Vec<String>> {
        lock(&self.desk.seen).dropped.clone()
    }

    pub fn log(&self) -> Vec<String> {
        lock(&self.desk.seen).log.clone()
    }

    pub fn statuses(&self) -> usize {
        lock(&self.desk.seen).statuses
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.link.stop();
    }
}
