//! A small client for OBS Studio's WebSocket server (obs-websocket, protocol
//! v5, in JSON), in place of the npm package obs-websocket-js the Node
//! companion used. It does what that package did for the link, no more:
//!
//! - **Connecting**: the server greets (Hello, op 0), the client answers
//!   (Identify, op 1) with the events it wants and, when OBS asks for a
//!   password and one is known, the authentication string; OBS confirms
//!   (Identified, op 2) or closes the socket (4009: it refused the password).
//! - **Requests** (op 6) are matched to their answers (op 7) by id, so any
//!   number can be out at once.
//! - **Events** (op 5) go to whoever asked for them, in the order they came,
//!   on the task that reads the socket: a handler sees an event before any
//!   request answered after it is resumed, as with the package's emitter.
//! - **Closing**: handlers are told once, with the close code and reason.
//!
//! As in the package, a request that is out when the socket closes is never
//! answered: the link's own timeout ([`super::link::obs_call`]) ends it.

use std::collections::HashMap;
use std::fmt;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use base64::Engine;
use futures_util::future::BoxFuture;
use futures_util::{FutureExt, Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{self, Message};

/// The subprotocol that makes OBS speak JSON.
pub const PROTOCOL: &str = "obswebsocket.json";

/// obs-websocket's event groups (its `EventSubscription`), for Identify.
pub mod subscription {
    /// Every group that is not high-volume.
    pub const ALL: u32 = 4095;
    /// Audio meters, many times a second: only sent when asked for by name.
    pub const INPUT_VOLUME_METERS: u32 = 1 << 16;
}

/// OBS closes with this code when it refuses the password.
pub const CLOSE_AUTHENTICATION_FAILED: i64 = 4009;
/// The socket went away without a closing handshake.
pub const CLOSE_ABNORMAL: i64 = 1006;
/// A closing handshake that named no code.
const CLOSE_NO_STATUS: i64 = 1005;

/// What went wrong talking to OBS, as obs-websocket-js reported it: a
/// request OBS refused (its status code and comment), a socket that closed
/// (the close code and reason), or one that could not be opened (-1 and the
/// system's words). `code` is None where the package threw a plain error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObsError {
    pub code: Option<i64>,
    pub message: String,
}

impl ObsError {
    pub fn new(code: i64, message: impl Into<String>) -> ObsError {
        ObsError {
            code: Some(code),
            message: message.into(),
        }
    }

    fn plain(message: &str) -> ObsError {
        ObsError {
            code: None,
            message: message.to_string(),
        }
    }

    fn not_connected() -> ObsError {
        ObsError::plain("Not connected")
    }
}

impl fmt::Display for ObsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ObsError {}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The string OBS checks a password with:
/// base64(sha256(base64(sha256(password + salt)) + challenge)).
pub fn authentication(password: &str, salt: &str, challenge: &str) -> String {
    let base64 = base64::engine::general_purpose::STANDARD;
    let secret = base64.encode(Sha256::digest(format!("{password}{salt}")));
    base64.encode(Sha256::digest(format!("{secret}{challenge}")))
}

// ------------------------------------------------------------ the socket

type WireSink = Pin<Box<dyn Sink<Message, Error = tungstenite::Error> + Send>>;
type WireStream = Pin<Box<dyn Stream<Item = Result<Message, tungstenite::Error>> + Send>>;

/// An open WebSocket to something that should be OBS, before any greeting.
pub struct Wire {
    sink: WireSink,
    stream: WireStream,
}

/// Opens the WebSocket for an address ("ws://127.0.0.1:4455"). The link uses
/// [`network`]; tests hand it fake OBSes that live in memory.
pub type Dialer = Arc<dyn Fn(String) -> BoxFuture<'static, Result<Wire, ObsError>> + Send + Sync>;

fn request_for(url: &str) -> Result<tungstenite::handshake::client::Request, ObsError> {
    let mut request = url
        .into_client_request()
        .map_err(|error| ObsError::new(-1, error.to_string()))?;
    request
        .headers_mut()
        .insert("Sec-WebSocket-Protocol", HeaderValue::from_static(PROTOCOL));
    Ok(request)
}

/// A failure to open the socket: -1 and what the system said, as the
/// package reported an "error" event.
fn open_failure(error: &tungstenite::Error) -> ObsError {
    use tungstenite::error::ProtocolError;
    let message = match error {
        tungstenite::Error::Io(error) => error.to_string(),
        tungstenite::Error::Protocol(ProtocolError::SecWebSocketSubProtocolError(error)) => {
            error.to_string()
        }
        other => other.to_string(),
    };
    ObsError::new(-1, message)
}

fn wire_of<S>(socket: tokio_tungstenite::WebSocketStream<S>) -> Wire
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (sink, stream) = socket.split();
    Wire {
        sink: Box::pin(sink),
        stream: Box::pin(stream),
    }
}

/// The real thing: TCP (and TLS for wss://) to the address.
pub fn network() -> Dialer {
    Arc::new(|url: String| {
        async move {
            let request = request_for(&url)?;
            // No waiting to batch small writes: a press is one small frame.
            let (socket, _) = tokio_tungstenite::connect_async_with_config(request, None, true)
                .await
                .map_err(|error| open_failure(&error))?;
            Ok(wire_of(socket))
        }
        .boxed()
    })
}

/// The WebSocket handshake over a stream that is already open.
pub async fn open_over<S>(url: &str, stream: S) -> Result<Wire, ObsError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (socket, _) = tokio_tungstenite::client_async(request_for(url)?, stream)
        .await
        .map_err(|error| open_failure(&error))?;
    Ok(wire_of(socket))
}

/// How a socket that stopped is reported: the code and reason of a closing
/// handshake, 1006 when it just went away.
fn close_of(frame: Option<tungstenite::protocol::CloseFrame>) -> ObsError {
    match frame {
        Some(frame) => ObsError::new(i64::from(u16::from(frame.code)), frame.reason.to_string()),
        None => ObsError::new(CLOSE_NO_STATUS, ""),
    }
}

fn read_failure(error: &tungstenite::Error) -> ObsError {
    match error {
        tungstenite::Error::Io(error) => ObsError::new(-1, error.to_string()),
        _ => ObsError::new(CLOSE_ABNORMAL, ""),
    }
}

/// `{ op, d }` of a message, when it has both.
fn parse(text: &str) -> Option<(i64, Value)> {
    let mut message: Value = serde_json::from_str(text).ok()?;
    let op = message.get("op")?.as_i64()?;
    let d = message.get_mut("d")?.take();
    Some((op, d))
}

impl Wire {
    /// Waits for the message with this op code; anything else is skipped.
    async fn expect(&mut self, wanted: i64) -> Result<Value, ObsError> {
        loop {
            match self.stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    if let Some((op, d)) = parse(text.as_str()) {
                        if op == wanted {
                            return Ok(d);
                        }
                    }
                }
                Some(Ok(Message::Close(frame))) => return Err(close_of(frame)),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(read_failure(&error)),
                None => return Err(ObsError::new(CLOSE_ABNORMAL, "")),
            }
        }
    }

    async fn send(&mut self, op: i64, d: &Value) -> Result<(), ObsError> {
        let text = json!({ "op": op, "d": d }).to_string();
        self.sink
            .send(Message::text(text))
            .await
            .map_err(|error| read_failure(&error))
    }
}

// ------------------------------------------------------------ the client

type EventHandler = Arc<dyn Fn(&str, &Value) + Send + Sync>;
type CloseHandler = Box<dyn FnOnce(&ObsError) + Send>;
type StuckHandler = Arc<dyn Fn(&ObsClient, &str) + Send + Sync>;

enum Command {
    Send(String),
    Close,
}

#[derive(Default)]
struct Handlers {
    events: Vec<EventHandler>,
    close: Vec<CloseHandler>,
    /// Set once the socket is gone, so a handler added late still hears.
    closed: Option<ObsError>,
}

struct Inner {
    id: u64,
    outgoing: mpsc::UnboundedSender<Command>,
    open: AtomicBool,
    next_request: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    handlers: Mutex<Handlers>,
    stuck: Mutex<Option<StuckHandler>>,
    /// True once the socket itself has been let go of.
    gone: watch::Sender<bool>,
}

/// One identified connection to OBS. Cheap to clone; every clone is the
/// same connection, and [`ObsClient::id`] tells connections apart.
#[derive(Clone)]
pub struct ObsClient {
    inner: Arc<Inner>,
}

impl fmt::Debug for ObsClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ObsClient({})", self.inner.id)
    }
}

impl PartialEq for ObsClient {
    fn eq(&self, other: &ObsClient) -> bool {
        self.inner.id == other.inner.id
    }
}

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

/// Forgets a request nobody waits for any more (it timed out).
struct Waiting<'a> {
    inner: &'a Inner,
    id: String,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        lock(&self.inner.pending).remove(&self.id);
    }
}

impl ObsClient {
    /// Opens the socket and identifies: resolves once OBS has accepted the
    /// client. Fails as obs-websocket-js's `connect` did: with the close
    /// code and reason when OBS closes instead (4009 for a refused
    /// password), with -1 and the system's reason when nothing is there.
    /// Dropping the future abandons the attempt and closes the socket.
    pub async fn connect(
        dial: &Dialer,
        url: &str,
        password: Option<&str>,
        event_subscriptions: u32,
    ) -> Result<ObsClient, ObsError> {
        let mut wire = dial(url.to_string()).await?;
        let hello = wire.expect(0).await?;
        // Identify carries the greeting's rpcVersion back, the events wanted
        // and, only when OBS asks for a password and there is one, the proof.
        let mut identify = serde_json::Map::new();
        if let Some(version) = hello.get("rpcVersion") {
            identify.insert("rpcVersion".to_string(), version.clone());
        }
        identify.insert("eventSubscriptions".to_string(), json!(event_subscriptions));
        let asked = hello.get("authentication").filter(|asked| !asked.is_null());
        if let (Some(asked), Some(password)) = (asked, password.filter(|text| !text.is_empty())) {
            let part = |name: &str| asked.get(name).and_then(Value::as_str).unwrap_or("");
            let proof = authentication(password, part("salt"), part("challenge"));
            identify.insert("authentication".to_string(), json!(proof));
        }
        wire.send(1, &Value::Object(identify)).await?;
        wire.expect(2).await?;

        let (outgoing, commands) = mpsc::unbounded_channel();
        let inner = Arc::new(Inner {
            id: NEXT_CLIENT.fetch_add(1, Ordering::Relaxed),
            outgoing,
            open: AtomicBool::new(true),
            next_request: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            handlers: Mutex::new(Handlers::default()),
            stuck: Mutex::new(None),
            gone: watch::Sender::new(false),
        });
        tokio::spawn(run(Arc::clone(&inner), wire, commands));
        Ok(ObsClient { inner })
    }

    /// A number no other connection of this process has.
    pub fn id(&self) -> u64 {
        self.inner.id
    }

    /// Sends a request and waits for OBS's answer: its `responseData`
    /// (null when the request has none), or OBS's refusal (status code and
    /// comment). Does not time out by itself; see [`super::link::obs_call`].
    pub async fn call(
        &self,
        request_type: &str,
        request_data: Option<Value>,
    ) -> Result<Value, ObsError> {
        let inner = &*self.inner;
        if !inner.open.load(Ordering::SeqCst) {
            return Err(ObsError::not_connected());
        }
        let id = inner
            .next_request
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        let (answer, answered) = oneshot::channel();
        lock(&inner.pending).insert(id.clone(), answer);
        let _waiting = Waiting {
            inner,
            id: id.clone(),
        };
        let mut d = json!({ "requestId": id, "requestType": request_type });
        if let Some(data) = request_data {
            d["requestData"] = data;
        }
        let text = json!({ "op": 6, "d": d }).to_string();
        if inner.outgoing.send(Command::Send(text)).is_err() {
            return Err(ObsError::not_connected());
        }
        let Ok(d) = answered.await else {
            // The socket closed first. obs-websocket-js never settles such a
            // request, and neither does this: the caller's timeout ends it.
            return std::future::pending().await;
        };
        let Some(status) = d.get("requestStatus").filter(|status| status.is_object()) else {
            return Err(ObsError::plain("OBS answered without a request status"));
        };
        if !crate::model::js::truthy(status.get("result").unwrap_or(&Value::Null)) {
            let code = status.get("code").and_then(Value::as_i64).unwrap_or(-1);
            let comment = status.get("comment").and_then(Value::as_str).unwrap_or("");
            return Err(ObsError::new(code, comment));
        }
        Ok(d.get("responseData").cloned().unwrap_or(Value::Null))
    }

    /// Hears every event: its type and data, in the order OBS sent them.
    pub fn on_event(&self, handler: impl Fn(&str, &Value) + Send + Sync + 'static) {
        let mut handlers = lock(&self.inner.handlers);
        if handlers.closed.is_none() {
            handlers.events.push(Arc::new(handler));
        }
    }

    /// Hears the socket close, once, with the close code and reason (1006
    /// when it just went away, or when this side closed it). A handler
    /// added after the fact is called at once.
    pub fn on_close(&self, handler: impl FnOnce(&ObsError) + Send + 'static) {
        let already = {
            let mut handlers = lock(&self.inner.handlers);
            match &handlers.closed {
                Some(error) => error.clone(),
                None => {
                    handlers.close.push(Box::new(handler));
                    return;
                }
            }
        };
        handler(&already);
    }

    /// Whom to tell when a request is given up on (see [`ObsClient::stuck`]).
    pub fn on_stuck(&self, handler: impl Fn(&ObsClient, &str) + Send + Sync + 'static) {
        *lock(&self.inner.stuck) = Some(Arc::new(handler));
    }

    /// Reports that OBS never answered a request of this type.
    pub fn stuck(&self, request_type: &str) {
        let handler = lock(&self.inner.stuck).clone();
        if let Some(handler) = handler {
            handler(self, request_type);
        }
    }

    /// Closes the socket without waiting for the peer: a socket that is
    /// being dropped has nothing left to say. Safe to call again.
    pub fn close(&self) {
        self.inner.open.store(false, Ordering::SeqCst);
        let _ = self.inner.outgoing.send(Command::Close);
    }

    /// Waits until the socket has really been let go of. `close` only asks
    /// for it; whoever must not answer before OBS can see the link is gone
    /// (a press that gave up on a request) waits here.
    pub async fn gone(&self) {
        let mut gone = self.inner.gone.subscribe();
        let _ = gone.wait_for(|gone| *gone).await;
    }

    /// Whether the socket is still up.
    pub fn is_open(&self) -> bool {
        self.inner.open.load(Ordering::SeqCst)
    }
}

/// Reads and writes the socket until it ends, then tells the close handlers.
async fn run(inner: Arc<Inner>, mut wire: Wire, mut commands: mpsc::UnboundedReceiver<Command>) {
    let ended = loop {
        tokio::select! {
            biased;
            command = commands.recv() => match command {
                Some(Command::Send(text)) => {
                    if let Err(error) = wire.sink.send(Message::text(text)).await {
                        break read_failure(&error);
                    }
                }
                Some(Command::Close) | None => {
                    // One try at a goodbye, without waiting for it to leave.
                    let _ = wire.sink.send(Message::Close(None)).now_or_never();
                    break ObsError::new(CLOSE_ABNORMAL, "");
                }
            },
            message = wire.stream.next() => match message {
                Some(Ok(Message::Text(text))) => dispatch(&inner, text.as_str()),
                Some(Ok(Message::Close(frame))) => {
                    let _ = wire.sink.flush().now_or_never();
                    break close_of(frame);
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => break read_failure(&error),
                None => break ObsError::new(CLOSE_ABNORMAL, ""),
            },
        }
    };
    drop(wire);
    inner.open.store(false, Ordering::SeqCst);
    inner.gone.send_replace(true);
    let hearers = {
        let mut handlers = lock(&inner.handlers);
        handlers.closed = Some(ended.clone());
        handlers.events.clear();
        std::mem::take(&mut handlers.close)
    };
    for hear in hearers {
        hear(&ended);
    }
    *lock(&inner.stuck) = None;
}

fn dispatch(inner: &Inner, text: &str) {
    let Some((op, d)) = parse(text) else {
        return;
    };
    match op {
        5 => {
            let Some(event_type) = d.get("eventType").and_then(Value::as_str) else {
                return;
            };
            let handlers = lock(&inner.handlers).events.clone();
            let data = d.get("eventData").unwrap_or(&Value::Null);
            for handler in handlers {
                handler(event_type, data);
            }
        }
        7 => {
            let Some(id) = d.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let waiting = lock(&inner.pending).remove(id);
            if let Some(answer) = waiting {
                let _ = answer.send(d);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    use super::*;
    use crate::obs::fake::{fixture, settle, FakeObs, FakeOptions, Hello};

    const EVERYTHING: u32 = subscription::ALL | subscription::INPUT_VOLUME_METERS;

    #[test]
    fn authentication_strings_match_obs_websocket_js() {
        let cases = fixture("authentication.json");
        assert!(cases.len() >= 40);
        for case in &cases {
            let input = &case["input"];
            let text = |name: &str| input[name].as_str().expect("text");
            assert_eq!(
                authentication(text("password"), text("salt"), text("challenge")),
                case["output"].as_str().expect("text"),
                "{input}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn identify_says_what_obs_websocket_js_said() {
        // What the package sent for `{ eventSubscriptions: All | InputVolumeMeters }`,
        // with and without a password, as the generator recorded it.
        for case in fixture("identify.json") {
            let input = &case["input"];
            let asks = input["authentication"].is_object();
            let fake = FakeObs::start(FakeOptions {
                password: asks.then(|| "the one OBS wants".to_string()),
                salt: input["authentication"]["salt"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                challenge: input["authentication"]["challenge"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                accept_any_password: asks,
                ..FakeOptions::default()
            });
            let password = input["password"].as_str();
            let _client = ObsClient::connect(&fake.dialer(), "ws://obs", password, EVERYTHING)
                .await
                .expect("connects");
            assert_eq!(
                fake.world().identified.last(),
                Some(&case["output"]),
                "{input}"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn requests_answers_and_refusals() {
        let fake = FakeObs::start(FakeOptions::default());
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", None, EVERYTHING)
            .await
            .expect("connects");
        assert!(obs.is_open());
        let scene = obs
            .call("GetCurrentProgramScene", None)
            .await
            .expect("answers");
        assert_eq!(scene["currentProgramSceneName"], "Main");
        // A request with data, and one whose answer carries none.
        let done = obs
            .call(
                "SetCurrentProgramScene",
                Some(json!({ "sceneName": "Intro" })),
            )
            .await
            .expect("answers");
        assert_eq!(done, Value::Null);
        assert_eq!(fake.world().current_scene, "Intro");
        // A refusal carries OBS's code and comment.
        let refused = obs
            .call(
                "SetCurrentProgramScene",
                Some(json!({ "sceneName": "Nope" })),
            )
            .await
            .expect_err("refused");
        assert_eq!(
            refused,
            ObsError::new(600, "No source was found by the name of `Nope`.")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn answers_are_matched_by_id_whatever_order_they_come_in() {
        let fake = FakeObs::start(FakeOptions::default());
        fake.world().delays.insert("GetInputMute".to_string(), 300);
        fake.world()
            .delays
            .insert("GetStreamStatus".to_string(), 100);
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", None, EVERYTHING)
            .await
            .expect("connects");
        let started = tokio::time::Instant::now();
        let (mute, stream, scene) = tokio::join!(
            obs.call("GetInputMute", Some(json!({ "inputName": "Mic" }))),
            obs.call("GetStreamStatus", None),
            obs.call("GetCurrentProgramScene", None),
        );
        assert_eq!(mute.expect("mute")["inputMuted"], false);
        assert_eq!(stream.expect("stream")["outputActive"], false);
        assert_eq!(scene.expect("scene")["currentProgramSceneName"], "Main");
        // Together, not one after the other.
        assert_eq!(started.elapsed(), Duration::from_millis(300));
    }

    #[tokio::test(start_paused = true)]
    async fn events_reach_every_handler_in_order() {
        let fake = FakeObs::start(FakeOptions::default());
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", None, EVERYTHING)
            .await
            .expect("connects");
        let heard = Arc::new(Mutex::new(Vec::new()));
        let again = Arc::new(AtomicUsize::new(0));
        let list = Arc::clone(&heard);
        obs.on_event(move |event, data| lock(&list).push((event.to_string(), data.clone())));
        let count = Arc::clone(&again);
        obs.on_event(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
        });
        settle().await;
        fake.emit("StreamStateChanged", json!({ "outputActive": true }));
        fake.emit(
            "InputMuteStateChanged",
            json!({ "inputName": "Mic", "inputMuted": true }),
        );
        settle().await;
        assert_eq!(
            *lock(&heard),
            vec![
                (
                    "StreamStateChanged".to_string(),
                    json!({ "outputActive": true })
                ),
                (
                    "InputMuteStateChanged".to_string(),
                    json!({ "inputName": "Mic", "inputMuted": true })
                ),
            ]
        );
        assert_eq!(again.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_password_opens_an_obs_that_asks_for_one() {
        let fake = FakeObs::start(FakeOptions::with_password("s3cret"));
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", Some("s3cret"), EVERYTHING)
            .await
            .expect("connects");
        assert!(obs.call("GetStreamStatus", None).await.is_ok());
        // A password OBS does not ask for is simply not used.
        let open = FakeObs::start(FakeOptions::default());
        ObsClient::connect(&open.dialer(), "ws://obs", Some("unused"), EVERYTHING)
            .await
            .expect("connects");
        assert!(open.world().identified[0].get("authentication").is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn a_wrong_or_missing_password_fails_with_4009() {
        let fake = FakeObs::start(FakeOptions::with_password("s3cret"));
        for password in [Some("nope"), None, Some("")] {
            let error = ObsClient::connect(&fake.dialer(), "ws://obs", password, EVERYTHING)
                .await
                .expect_err("refused");
            assert_eq!(
                error.code,
                Some(CLOSE_AUTHENTICATION_FAILED),
                "{password:?}"
            );
            assert_eq!(error.message, "Authentication failed.");
        }
        settle().await;
        assert_eq!(fake.clients(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_there_fails_with_minus_one_and_a_reason() {
        let fake = FakeObs::start(FakeOptions::default());
        let error = ObsClient::connect(&fake.dialer(), "ws://elsewhere", None, EVERYTHING)
            .await
            .expect_err("nothing there");
        assert_eq!(error.code, Some(-1));
        assert!(!error.message.is_empty());
        // Not an address at all.
        let error = ObsClient::connect(&network(), "not an address", None, EVERYTHING)
            .await
            .expect_err("no address");
        assert_eq!(error.code, Some(-1));
    }

    #[tokio::test(start_paused = true)]
    async fn an_obs_that_goes_away_while_greeting_fails_with_1006() {
        let fake = FakeObs::start(FakeOptions {
            hello: Hello::Never,
            ..FakeOptions::default()
        });
        let dialer = fake.dialer();
        let attempt =
            tokio::spawn(
                async move { ObsClient::connect(&dialer, "ws://obs", None, EVERYTHING).await },
            );
        settle().await;
        assert_eq!(fake.clients(), 1);
        fake.disconnect();
        let error = attempt.await.expect("ran").expect_err("dropped");
        assert_eq!(error, ObsError::new(CLOSE_ABNORMAL, ""));
    }

    #[tokio::test(start_paused = true)]
    async fn closing_tells_the_handlers_once_and_ends_the_socket() {
        let fake = FakeObs::start(FakeOptions::default());
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", None, EVERYTHING)
            .await
            .expect("connects");
        let heard = Arc::new(Mutex::new(Vec::new()));
        let list = Arc::clone(&heard);
        obs.on_close(move |error| lock(&list).push(error.clone()));
        settle().await;
        assert_eq!(fake.clients(), 1);
        obs.close();
        obs.close();
        assert!(!obs.is_open());
        settle().await;
        assert_eq!(fake.clients(), 0);
        assert_eq!(*lock(&heard), vec![ObsError::new(CLOSE_ABNORMAL, "")]);
        // A handler that comes late still hears, and requests say why they cannot go.
        let list = Arc::clone(&heard);
        obs.on_close(move |error| lock(&list).push(error.clone()));
        assert_eq!(lock(&heard).len(), 2);
        let error = obs.call("GetStreamStatus", None).await.expect_err("closed");
        assert_eq!(
            (error.code, error.message.as_str()),
            (None, "Not connected")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn obs_closing_reports_its_code_and_reason() {
        let fake = FakeObs::start(FakeOptions::default());
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", None, EVERYTHING)
            .await
            .expect("connects");
        let heard = Arc::new(Mutex::new(Vec::new()));
        let list = Arc::clone(&heard);
        obs.on_close(move |error| lock(&list).push(error.clone()));
        settle().await;
        fake.close_with(4011, "Session invalidated.");
        settle().await;
        assert_eq!(
            *lock(&heard),
            vec![ObsError::new(4011, "Session invalidated.")]
        );
        assert!(!obs.is_open());
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_out_when_obs_drops_is_never_answered() {
        // As in obs-websocket-js: the request is left hanging, and it is the
        // caller's timeout that ends it.
        let fake = FakeObs::start(FakeOptions::default());
        fake.world().stalled.insert("GetStreamStatus".to_string());
        let obs = ObsClient::connect(&fake.dialer(), "ws://obs", None, EVERYTHING)
            .await
            .expect("connects");
        let asking = obs.clone();
        let request = tokio::spawn(async move { asking.call("GetStreamStatus", None).await });
        settle().await;
        fake.disconnect();
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert!(!obs.is_open());
        assert!(!request.is_finished());
        request.abort();
    }

    #[tokio::test]
    async fn over_a_real_socket_with_and_without_a_password() {
        let open = FakeObs::start(FakeOptions::default());
        let address = format!("ws://{}", open.listen().await);
        let obs = ObsClient::connect(&network(), &address, None, EVERYTHING)
            .await
            .expect("connects");
        let scene = obs
            .call("GetCurrentProgramScene", None)
            .await
            .expect("answers");
        assert_eq!(scene["currentProgramSceneName"], "Main");
        obs.close();

        let locked = FakeObs::start(FakeOptions::with_password("pässword ✓"));
        let address = format!("ws://{}", locked.listen().await);
        let obs = ObsClient::connect(&network(), &address, Some("pässword ✓"), EVERYTHING)
            .await
            .expect("connects");
        assert!(obs.call("GetStreamStatus", None).await.is_ok());
        let error = ObsClient::connect(&network(), &address, Some("wrong"), EVERYTHING)
            .await
            .expect_err("refused");
        assert_eq!(error.code, Some(CLOSE_AUTHENTICATION_FAILED));
    }

    #[tokio::test]
    async fn a_closed_port_fails_with_minus_one() {
        // Bound and released: nothing listens there now.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binds");
        let address = format!("ws://{}", listener.local_addr().expect("address"));
        drop(listener);
        let error = ObsClient::connect(&network(), &address, None, EVERYTHING)
            .await
            .expect_err("nothing listens");
        assert_eq!(error.code, Some(-1));
        assert!(!error.message.is_empty());
    }

    /// The one check against a real OBS, if one runs on this computer:
    /// read-only (GetVersion), with OBS's own settings.
    ///   cargo test real_obs -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "needs OBS Studio running on this computer"]
    async fn real_obs_answers_get_version() {
        let local = crate::obs::config::read_local_obs();
        assert!(
            local.found,
            "OBS has no WebSocket settings on this computer"
        );
        let address = format!(
            "ws://127.0.0.1:{}",
            crate::model::js::number_to_string(local.port)
        );
        let password = Some(local.password.as_str()).filter(|text| !text.is_empty());
        let obs = ObsClient::connect(&network(), &address, password, subscription::ALL)
            .await
            .expect("connects to OBS");
        let version = obs.call("GetVersion", None).await.expect("GetVersion");
        println!(
            "OBS {} with obs-websocket {} (rpc {})",
            version["obsVersion"], version["obsWebSocketVersion"], version["rpcVersion"]
        );
        assert!(version["obsWebSocketVersion"].is_string());
        obs.close();
    }
}
