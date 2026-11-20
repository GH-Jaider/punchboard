//! The link to OBS Studio: one connection, brought up as soon as OBS is
//! configured, re-tried when it drops, and carrying live audio meters for the
//! inputs that decks are showing.

use std::collections::HashSet;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::{BoxFuture, Shared};
use futures_util::FutureExt;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use super::client::{
    self, lock, subscription, Dialer, ObsClient, ObsError, CLOSE_AUTHENTICATION_FAILED,
};
use super::jsmath;
use crate::i18n::{say, Said, UserError};
use crate::model::js;

/// `"unset" | "disconnected" | "connected"`, as /api/status says it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkStatus {
    /// No address to try.
    Unset,
    Disconnected,
    Connected,
}

/// Why the link is down, when it is: nothing answered, OBS's WebSocket
/// server is switched off (the server works that one out, from OBS's
/// settings on this computer), or OBS refused the password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ObsIssue {
    Unreachable,
    ServerOff,
    WrongPassword,
}

/// Levels by key ("obs:<input>"), in the order JavaScript's object kept them.
pub type Levels = Vec<(String, f64)>;

/// `Object.assign` for one key: a known key keeps its place.
pub(crate) fn assign<T>(list: &mut Vec<(String, T)>, key: String, value: T) {
    match list.iter_mut().find(|(known, _)| *known == key) {
        Some(entry) => entry.1 = value,
        None => list.push((key, value)),
    }
}

/// Where OBS is and what it asks for, read from the settings each time.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObsSettings {
    /// "ws://127.0.0.1:4455"; empty when OBS was never set up.
    pub address: String,
    /// Empty when OBS does not ask for one.
    pub password: String,
}

pub struct ObsLinkOptions {
    /// The address and password as they are right now.
    pub settings: Box<dyn Fn() -> ObsSettings + Send + Sync>,
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    /// Called whenever the link comes up or goes down.
    pub on_status: Box<dyn Fn(&ObsLink) + Send + Sync>,
    /// Called with meter positions (0..1) keyed "obs:<input>", at most ~15 Hz.
    pub on_meters: Box<dyn Fn(Levels) + Send + Sync>,
    /// Input names whose meters anyone is looking at right now.
    pub wanted_inputs: Box<dyn Fn() -> HashSet<String> + Send + Sync>,
    /// Each fresh connection, for following OBS's events.
    pub on_connected: Box<dyn Fn(&ObsClient) + Send + Sync>,
    /// How a socket is opened: [`client::network`], except in tests.
    pub dial: Dialer,
}

// Retries stay quick (OBS is usually on this computer, and trying is cheap),
// so the link comes up a few seconds after OBS or its server does.
const RETRY_MS: [u64; 3] = [2000, 3000, 5000];
const METER_INTERVAL_MS: u64 = 66;
// Every press, fader and picker waits on the link, so nothing may wait on it
// for long: a host that accepts the connection but never speaks (or a remote
// OBS asleep) fails the attempt, and a request OBS never answers is a link
// that is no longer worth trusting. OBS answers in milliseconds when well.
pub const CONNECT_TIMEOUT_MS: u64 = 6000;
pub const REQUEST_TIMEOUT_MS: u64 = 5000;

/// Everything but the high-volume groups, and the audio meters.
const EVENT_SUBSCRIPTIONS: u32 = subscription::ALL | subscription::INPUT_VOLUME_METERS;

/// Why a request to OBS failed: Punchboard's own reason (the request timed
/// out), in the reader's language, or OBS's (its comment, as it is).
#[derive(Debug, Clone, PartialEq)]
pub enum ObsFailure {
    User(UserError),
    Obs(ObsError),
}

impl ObsFailure {
    /// What to tell a person: what `textOf(error)` gave the TypeScript.
    pub fn said(&self) -> Said {
        match self {
            ObsFailure::User(error) => Said::Text(error.text.clone()),
            ObsFailure::Obs(error) => Said::Plain(error.message.clone()),
        }
    }
}

impl fmt::Display for ObsFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ObsFailure::User(error) => error.fmt(f),
            ObsFailure::Obs(error) => error.fmt(f),
        }
    }
}

impl From<UserError> for ObsFailure {
    fn from(error: UserError) -> ObsFailure {
        ObsFailure::User(error)
    }
}

impl From<ObsError> for ObsFailure {
    fn from(error: ObsError) -> ObsFailure {
        ObsFailure::Obs(error)
    }
}

/// As the error it wraps, so `i18n::text_of` still finds a [`UserError`].
impl From<ObsFailure> for Box<dyn std::error::Error + Send + Sync> {
    fn from(failure: ObsFailure) -> Self {
        match failure {
            ObsFailure::User(error) => Box::new(error),
            ObsFailure::Obs(error) => Box::new(error),
        }
    }
}

/// Every OBS request goes through here, so none can hang a press, a fader or
/// a macro: past REQUEST_TIMEOUT_MS the link is dropped and re-tried.
pub async fn obs_call(
    obs: &ObsClient,
    request_type: &str,
    request_data: Option<Value>,
) -> Result<Value, ObsFailure> {
    let timeout = Duration::from_millis(REQUEST_TIMEOUT_MS);
    match tokio::time::timeout(timeout, obs.call(request_type, request_data)).await {
        Ok(answer) => Ok(answer?),
        Err(_) => {
            // The link forgets the socket first, so the close is not reported as OBS's.
            obs.stuck(request_type);
            obs.close();
            Err(ObsFailure::User(UserError::new(
                say("server.obs.requestTimeout")
                    .with("request", request_type)
                    .with("seconds", (REQUEST_TIMEOUT_MS / 1000) as f64),
            )))
        }
    }
}

/// OBS's mixer runs -60 dB at the bottom to 0 dB at the top.
pub fn meter_position(mul: f64) -> f64 {
    if mul.is_nan() || mul <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * jsmath::log10(mul);
    js::max(0.0, js::min(1.0, (db + 60.0) / 60.0))
}

/// Reads one meter event into positions, keeping only the inputs wanted.
pub fn read_meters(inputs: &Value, wanted: &HashSet<String>) -> Levels {
    try_read_meters(inputs, wanted).unwrap_or_default()
}

/// [`read_meters`], or None where the TypeScript threw (a null among the
/// inputs) and so lost the whole event.
pub(crate) fn try_read_meters(inputs: &Value, wanted: &HashSet<String>) -> Option<Levels> {
    let mut levels = Levels::new();
    let Some(inputs) = inputs.as_array() else {
        return Some(levels);
    };
    for raw in inputs {
        if raw.is_null() {
            return None;
        }
        let Some(name) = raw.get("inputName").and_then(Value::as_str) else {
            continue;
        };
        if name.is_empty() || !wanted.contains(name) {
            continue;
        }
        // Per channel: [magnitude, peak, input peak]; the loudest channel's peak is what a meter shows.
        let mut peak = 0.0;
        if let Some(channels) = raw.get("inputLevelsMul").and_then(Value::as_array) {
            for channel in channels {
                let value = match channel.as_array() {
                    Some(channel) => channel.get(1).map_or(f64::NAN, js::to_number),
                    None => 0.0,
                };
                if value > peak {
                    peak = value;
                }
            }
        }
        assign(&mut levels, format!("obs:{name}"), meter_position(peak));
    }
    Some(levels)
}

type Attempt = Shared<BoxFuture<'static, Result<ObsClient, UserError>>>;

#[derive(Default)]
struct State {
    client: Option<ObsClient>,
    connecting: Option<Attempt>,
    /// Wakes the attempt in flight, so a reset can abandon it.
    pending: Option<Arc<Notify>>,
    /// Bumped by every attempt, reset and stop: an attempt that finds it moved
    /// on is stale (other settings, or Punchboard closing) and must not touch
    /// the link when it settles.
    generation: u64,
    attempt: usize,
    retry_timer: Option<JoinHandle<()>>,
    stopped: bool,
    announced_outage: bool,
    last_meter_at: Option<Instant>,
    pending_levels: Levels,
    meter_timer: Option<JoinHandle<()>>,
    issue: Option<ObsIssue>,
}

impl State {
    fn clear_retry(&mut self) {
        if let Some(timer) = self.retry_timer.take() {
            timer.abort();
        }
    }

    fn clear_meters(&mut self) {
        if let Some(timer) = self.meter_timer.take() {
            timer.abort();
        }
        self.pending_levels.clear();
    }

    /// Abandons the attempt in flight, if any: its socket closes and, being
    /// stale, it leaves the link alone when it settles.
    fn abandon_attempt(&mut self) {
        self.generation += 1;
        self.connecting = None;
        if let Some(pending) = self.pending.take() {
            pending.notify_one();
        }
    }
}

struct Inner {
    options: ObsLinkOptions,
    state: Mutex<State>,
}

/// The link. Cheap to clone; every clone is the same link. Its work runs on
/// tokio tasks, so it is made and used inside the runtime; [`ObsLink::stop`]
/// ends them and closes the socket.
#[derive(Clone)]
pub struct ObsLink {
    inner: Arc<Inner>,
}

/// How an attempt ended, before the link looks at it.
enum Outcome {
    Connected(ObsClient),
    Failed(ObsError),
    TimedOut,
    Abandoned,
}

enum Begun {
    Ready(ObsClient),
    Wait(Attempt),
}

impl ObsLink {
    pub fn new(options: ObsLinkOptions) -> ObsLink {
        ObsLink {
            inner: Arc::new(Inner {
                options,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// The connected client, connecting first if needed. Fails with a message meant for the deck.
    pub async fn connect(&self) -> Result<ObsClient, UserError> {
        Inner::connect(&self.inner).await
    }

    pub fn status(&self) -> LinkStatus {
        self.inner.status()
    }

    /// Why the link is down; None while it is up.
    pub fn issue(&self) -> Option<ObsIssue> {
        let state = lock(&self.inner.state);
        if state.client.is_some() {
            None
        } else {
            state.issue
        }
    }

    /// Connects if OBS is configured; failures retry in the background.
    pub fn start(&self) {
        Inner::start(&self.inner);
    }

    /// After the address or password changes: drop the old link, start a new one.
    pub fn reset(&self) {
        let old = {
            let mut state = lock(&self.inner.state);
            state.clear_retry();
            state.attempt = 0;
            state.announced_outage = false;
            state.issue = None;
            state.abandon_attempt();
            state.clear_meters();
            state.client.take()
        };
        if let Some(old) = old {
            old.close();
        }
        (self.inner.options.on_status)(self);
        self.start();
    }

    /// Punchboard is closing: no more attempts, and the socket closes.
    pub fn stop(&self) {
        let old = {
            let mut state = lock(&self.inner.state);
            state.stopped = true;
            state.clear_retry();
            if let Some(timer) = state.meter_timer.take() {
                timer.abort();
            }
            state.abandon_attempt();
            state.client.take()
        };
        if let Some(old) = old {
            old.close();
        }
    }
}

impl Inner {
    fn configured(&self) -> bool {
        !(self.options.settings)().address.is_empty()
    }

    fn status(&self) -> LinkStatus {
        if lock(&self.state).client.is_some() {
            LinkStatus::Connected
        } else if self.configured() {
            LinkStatus::Disconnected
        } else {
            LinkStatus::Unset
        }
    }

    fn told(self: &Arc<Inner>) {
        (self.options.on_status)(&ObsLink {
            inner: Arc::clone(self),
        });
    }

    fn start(self: &Arc<Inner>) {
        lock(&self.state).stopped = false;
        if self.configured() {
            // Failures are retried.
            let _ = self.begin();
        }
    }

    fn connect(self: &Arc<Inner>) -> BoxFuture<'static, Result<ObsClient, UserError>> {
        let begun = self.begin();
        async move {
            match begun? {
                Begun::Ready(client) => Ok(client),
                Begun::Wait(attempt) => attempt.await,
            }
        }
        .boxed()
    }

    /// The part of connecting that happens at once: the client if there is
    /// one, the attempt in flight if there is one, or a new attempt, started.
    fn begin(self: &Arc<Inner>) -> Result<Begun, UserError> {
        let settings = (self.options.settings)();
        let mut state = lock(&self.state);
        if let Some(client) = &state.client {
            return Ok(Begun::Ready(client.clone()));
        }
        if let Some(attempt) = &state.connecting {
            return Ok(Begun::Wait(attempt.clone()));
        }
        if state.stopped {
            return Err(UserError::new(say("server.obs.closing")));
        }
        if settings.address.is_empty() {
            return Err(UserError::new(say("server.obs.noAddress")));
        }
        state.generation += 1;
        let mine = state.generation;
        let abandoned = Arc::new(Notify::new());
        state.pending = Some(Arc::clone(&abandoned));
        let (settle, settled) = oneshot::channel();
        let attempt: Attempt = async move {
            match settled.await {
                Ok(result) => result,
                // Only when the runtime itself is going away.
                Err(_) => Err(UserError::new(say("server.obs.closing"))),
            }
        }
        .boxed()
        .shared();
        state.connecting = Some(attempt.clone());
        drop(state);

        let link = Arc::clone(self);
        tokio::spawn(async move {
            let password = Some(settings.password.as_str()).filter(|text| !text.is_empty());
            let handshake = ObsClient::connect(
                &link.options.dial,
                &settings.address,
                password,
                EVENT_SUBSCRIPTIONS,
            );
            let limit = Duration::from_millis(CONNECT_TIMEOUT_MS);
            // Leaving this block drops the handshake, and with it the socket:
            // a timed-out or abandoned handshake must not finish later.
            let outcome = tokio::select! {
                biased;
                () = abandoned.notified() => Outcome::Abandoned,
                ended = tokio::time::timeout(limit, handshake) => match ended {
                    Ok(Ok(client)) => Outcome::Connected(client),
                    Ok(Err(error)) => Outcome::Failed(error),
                    Err(_) => Outcome::TimedOut,
                },
            };
            let _ = settle.send(link.settle(mine, &settings.address, outcome).await);
        });
        Ok(Begun::Wait(attempt))
    }

    async fn settle(
        self: &Arc<Inner>,
        mine: u64,
        address: &str,
        outcome: Outcome,
    ) -> Result<ObsClient, UserError> {
        let failure = match outcome {
            Outcome::Connected(client) => {
                let stale = {
                    let mut state = lock(&self.state);
                    let stale = state.generation != mine;
                    if !stale {
                        state.pending = None;
                        state.client = Some(client.clone());
                        state.connecting = None;
                        state.attempt = 0;
                        state.announced_outage = false;
                        state.issue = None;
                    }
                    stale
                };
                // Settings changed (or Punchboard is closing) while this attempt was
                // out: it connected to the old OBS, so it closes, and whoever was
                // waiting on it gets the current attempt instead.
                if stale {
                    client.close();
                    return self.connect().await;
                }
                let link = Arc::downgrade(self);
                client.on_stuck(move |socket, request_type| {
                    if let Some(link) = link.upgrade() {
                        link.drop_client(
                            socket,
                            &format!("OBS did not answer {request_type} in time; reconnecting."),
                        );
                    }
                });
                let link = Arc::downgrade(self);
                client.on_event(move |event, data| {
                    if event == "InputVolumeMeters" {
                        if let Some(link) = link.upgrade() {
                            link.on_meter_event(data.get("inputs").unwrap_or(&Value::Null));
                        }
                    }
                });
                let link = Arc::downgrade(self);
                let socket = client.clone();
                client.on_close(move |_| {
                    if let Some(link) = link.upgrade() {
                        link.drop_client(
                            &socket,
                            "OBS closed the connection; will reconnect when it is back.",
                        );
                    }
                });
                (self.options.log)(&format!("Connected to OBS at {address}."));
                (self.options.on_connected)(&client);
                self.told();
                return Ok(client);
            }
            Outcome::Failed(error) => Some(error),
            Outcome::TimedOut | Outcome::Abandoned => None,
        };

        let settled = 'current: {
            let mut state = lock(&self.state);
            if state.generation != mine {
                break 'current None;
            }
            state.pending = None;
            state.connecting = None;
            // 4009 is OBS refusing the password; anything else means nothing answered.
            let refused = failure
                .as_ref()
                .is_some_and(|error| error.code == Some(CLOSE_AUTHENTICATION_FAILED));
            let next = if refused {
                ObsIssue::WrongPassword
            } else {
                ObsIssue::Unreachable
            };
            let changed = state.issue != Some(next);
            state.issue = Some(next);
            let announce = !state.announced_outage;
            state.announced_outage = true;
            Some((next, changed, announce))
        };
        let Some((issue, changed, announce)) = settled else {
            return self.connect().await;
        };
        if changed {
            self.told();
        }
        if announce {
            (self.options.log)(&format!(
                "OBS is not reachable at {address}; will keep trying quietly."
            ));
        }
        self.schedule_retry();
        Err(UserError::new(if issue == ObsIssue::WrongPassword {
            say("server.obs.wrongPassword")
        } else {
            let unreachable = say("server.obs.unreachable").with("address", address);
            match failure {
                Some(error) => unreachable.with("reason", error.message),
                None => unreachable.with(
                    "reason",
                    say("server.obs.connectTimeout")
                        .with("seconds", (CONNECT_TIMEOUT_MS / 1000) as f64),
                ),
            }
        }))
    }

    fn schedule_retry(self: &Arc<Inner>) {
        let configured = self.configured();
        let mut state = lock(&self.state);
        if state.stopped || !configured {
            return;
        }
        state.clear_retry();
        let delay = RETRY_MS[state.attempt.min(RETRY_MS.len() - 1)];
        state.attempt += 1;
        let link = Arc::downgrade(self);
        state.retry_timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            if let Some(link) = link.upgrade() {
                // Logged once per outage.
                let _ = link.connect().await;
            }
        }));
    }

    /// The live link stopped answering or closed: forget it and try again.
    fn drop_client(self: &Arc<Inner>, socket: &ObsClient, message: &str) {
        {
            let mut state = lock(&self.state);
            if state.client.as_ref() != Some(socket) {
                return;
            }
            state.client = None;
            state.clear_meters();
        }
        (self.options.log)(message);
        self.told();
        self.schedule_retry();
    }

    /// Sends what is pending. `from_timer`: the timer's own task is asking,
    /// so there is no timer left to stop.
    fn flush_meters(&self, from_timer: bool) {
        let levels = {
            let mut state = lock(&self.state);
            let timer = state.meter_timer.take();
            if let (Some(timer), false) = (timer, from_timer) {
                timer.abort();
            }
            state.last_meter_at = Some(Instant::now());
            std::mem::take(&mut state.pending_levels)
        };
        if !levels.is_empty() {
            (self.options.on_meters)(levels);
        }
    }

    fn on_meter_event(self: &Arc<Inner>, inputs: &Value) {
        let wanted = (self.options.wanted_inputs)();
        if wanted.is_empty() {
            return;
        }
        let Some(read) = try_read_meters(inputs, &wanted) else {
            return;
        };
        let interval = Duration::from_millis(METER_INTERVAL_MS);
        {
            let mut state = lock(&self.state);
            for (key, level) in read {
                assign(&mut state.pending_levels, key, level);
            }
            let since = state.last_meter_at.map(|at| at.elapsed());
            if let Some(since) = since.filter(|since| *since < interval) {
                // Inside the window: send what is pending when it ends, so the last
                // values of a burst (a voice stopping) still reach the decks.
                if state.meter_timer.is_none() {
                    let link = Arc::downgrade(self);
                    state.meter_timer = Some(tokio::spawn(async move {
                        tokio::time::sleep(interval - since).await;
                        if let Some(link) = link.upgrade() {
                            link.flush_meters(true);
                        }
                    }));
                }
                return;
            }
        }
        self.flush_meters(false);
    }
}

/// So a link nobody holds any more does not keep its socket.
impl Drop for Inner {
    fn drop(&mut self) {
        let state = self
            .state
            .get_mut()
            .unwrap_or_else(|error| error.into_inner());
        state.clear_retry();
        state.clear_meters();
        if let Some(client) = state.client.take() {
            client.close();
        }
    }
}

/// The dialer every real link uses.
pub fn network() -> Dialer {
    client::network()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::i18n::render;
    use crate::obs::fake::{bits, fixture, settle, wait, FakeObs, FakeOptions, Hello, Rig};
    use crate::obs::state::read_obs_names;

    fn english(error: &UserError) -> String {
        render(&Said::Text(error.text.clone()), "en")
    }

    // ------------------------------------------------- the pure functions

    #[test]
    fn meter_positions_match_the_typescript() {
        let cases = fixture("meter-position.json");
        assert!(cases.len() >= 300);
        for case in &cases {
            let input = bits(&case["input"]);
            let ours = meter_position(input);
            assert_eq!(
                ours.to_bits(),
                bits(&case["output"]).to_bits(),
                "meterPosition({input:e}) gave {ours:e}"
            );
        }
    }

    #[test]
    fn meter_readings_match_the_typescript() {
        let cases = fixture("read-meters.json");
        assert!(cases.len() >= 40);
        for case in &cases {
            let input = &case["input"];
            let wanted: HashSet<String> = input["wanted"]
                .as_array()
                .expect("a list")
                .iter()
                .map(|name| name.as_str().expect("a name").to_string())
                .collect();
            let ours = try_read_meters(&input["inputs"], &wanted);
            if case["output"].is_null() {
                assert_eq!(ours, None, "{input}");
                assert!(read_meters(&input["inputs"], &wanted).is_empty());
                continue;
            }
            let theirs: Levels = case["output"]
                .as_array()
                .expect("a list")
                .iter()
                .map(|entry| {
                    (
                        entry[0].as_str().expect("a key").to_string(),
                        bits(&entry[1]),
                    )
                })
                .collect();
            let ours = ours.unwrap_or_else(|| panic!("the TypeScript read {input}"));
            assert_eq!(ours.len(), theirs.len(), "{input}");
            for (ours, theirs) in ours.iter().zip(&theirs) {
                assert_eq!(ours.0, theirs.0, "{input}");
                assert_eq!(ours.1.to_bits(), theirs.1.to_bits(), "{input}");
            }
        }
    }

    #[test]
    fn the_words_the_api_uses() {
        let said = |value: &dyn erased::Json| value.json();
        assert_eq!(said(&LinkStatus::Unset), "\"unset\"");
        assert_eq!(said(&LinkStatus::Disconnected), "\"disconnected\"");
        assert_eq!(said(&LinkStatus::Connected), "\"connected\"");
        assert_eq!(said(&Some(ObsIssue::Unreachable)), "\"unreachable\"");
        assert_eq!(said(&Some(ObsIssue::ServerOff)), "\"server-off\"");
        assert_eq!(said(&Some(ObsIssue::WrongPassword)), "\"wrong-password\"");
        assert_eq!(said(&None::<ObsIssue>), "null");
        assert_eq!((CONNECT_TIMEOUT_MS, REQUEST_TIMEOUT_MS), (6000, 5000));
    }

    mod erased {
        pub trait Json {
            fn json(&self) -> String;
        }
        impl<T: serde::Serialize> Json for T {
            fn json(&self) -> String {
                crate::store::stringify(&serde_json::to_value(self).expect("serializes"))
            }
        }
    }

    // ------------------------------------------- the link, against fake OBSes

    #[tokio::test(start_paused = true)]
    async fn an_unset_link_says_so_and_does_not_try() {
        let rig = Rig::new(&[], "");
        rig.link.start();
        settle().await;
        assert_eq!(rig.link.status(), LinkStatus::Unset);
        assert_eq!(rig.link.issue(), None);
        let error = rig.link.connect().await.expect_err("no address");
        assert_eq!(error.text.key, "server.obs.noAddress");
        wait(60_000).await;
        assert!(rig.log().is_empty(), "{:?}", rig.log());
    }

    #[tokio::test(start_paused = true)]
    async fn it_connects_reads_the_decks_states_and_tells_its_owner() {
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        assert_eq!(rig.link.status(), LinkStatus::Disconnected);
        rig.link.start();
        settle().await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        assert_eq!(rig.link.issue(), None);
        assert_eq!(
            rig.log(),
            vec!["Connected to OBS at ws://good.".to_string()]
        );
        assert_eq!(good.clients(), 1);
        // What obs-websocket-js was asked to subscribe to: All | InputVolumeMeters.
        assert_eq!(
            good.world().identified[0]["eventSubscriptions"],
            4095 | 65536
        );
        // The owner heard the link come up, and the state reader was attached.
        assert!(rig.statuses() >= 1);
        assert_eq!(rig.toggle("scene:Main"), Some(true));
        // Whoever asks again gets the same connection, without a new socket.
        let first = rig.link.connect().await.expect("connected");
        let second = rig.link.connect().await.expect("connected");
        assert_eq!(first, second);
        assert_eq!(good.clients(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn callers_during_an_attempt_share_it() {
        let slow = FakeObs::start(FakeOptions {
            hello: Hello::After(1500),
            ..FakeOptions::default()
        });
        let rig = Rig::new(&[("ws://slow", &slow)], "ws://slow");
        let (first, second, third) =
            tokio::join!(rig.link.connect(), rig.link.connect(), rig.link.connect());
        let first = first.expect("connected");
        assert_eq!(Ok(&first), second.as_ref());
        assert_eq!(Ok(&first), third.as_ref());
        settle().await;
        assert_eq!(slow.clients(), 1);
        assert_eq!(rig.log().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn new_settings_while_the_old_attempt_is_still_out() {
        // obs.test.mjs: "new settings while the old attempt is still out".
        let slow = FakeObs::start(FakeOptions {
            hello: Hello::After(1500),
            ..FakeOptions::default()
        });
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://slow", &slow), ("ws://good", &good)], "ws://slow");
        rig.link.start();
        // Someone pressing meanwhile waits on that first attempt.
        let link = rig.link.clone();
        let waiting = tokio::spawn(async move { link.connect().await });
        wait(200).await;
        // The first attempt is waiting on the slow OBS.
        assert_eq!(slow.clients(), 1);
        assert_ne!(rig.link.status(), LinkStatus::Connected);

        rig.set_address("ws://good");
        rig.link.reset();
        settle().await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        // Whoever was waiting on the old attempt got the current one instead.
        let handed = waiting.await.expect("ran").expect("connected");
        assert_eq!(handed, rig.link.connect().await.expect("connected"));

        wait(1800).await; // past the slow OBS's greeting
                          // The old attempt does not take over when it finishes.
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        assert_eq!((slow.clients(), good.clients()), (0, 1));
        // Presses go to the new OBS.
        rig.set_scene("Intro").await.expect("pressed");
        assert_eq!(good.world().current_scene, "Intro");
        assert!(!slow
            .world()
            .calls
            .iter()
            .any(|call| call == "SetCurrentProgramScene"));
        // The link says it connected only to the new OBS.
        assert!(
            !rig.log()
                .iter()
                .any(|line| line.contains("Connected to OBS at ws://slow")),
            "{:?}",
            rig.log()
        );
        assert!(rig
            .log()
            .iter()
            .any(|line| line == "Connected to OBS at ws://good."));
    }

    #[tokio::test(start_paused = true)]
    async fn an_attempt_that_connects_after_a_reset_is_closed_not_used() {
        // The stale attempt gets as far as connecting: it must hang up.
        let old = FakeObs::start(FakeOptions::default());
        let new = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://old", &old), ("ws://new", &new)], "ws://old");
        rig.link.start();
        // No time to run in between: the attempt to the old OBS is under way.
        rig.set_address("ws://new");
        rig.link.reset();
        wait(100).await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        assert_eq!((old.clients(), new.clients()), (0, 1));
        assert_eq!(rig.log(), vec!["Connected to OBS at ws://new.".to_string()]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_obs_never_answers() {
        // obs.test.mjs: "a request OBS never answers".
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        rig.link.start();
        settle().await;
        good.world()
            .stalled
            .insert("SetCurrentProgramScene".to_string());
        let started = Instant::now();
        let failure = rig.set_scene("Intro").await.expect_err("never answered");
        // A press OBS never answers fails in seconds, with a reason.
        assert_eq!(started.elapsed(), Duration::from_millis(REQUEST_TIMEOUT_MS));
        let ObsFailure::User(error) = &failure else {
            panic!("{failure:?}");
        };
        assert_eq!(error.text.key, "server.obs.requestTimeout");
        assert_eq!(
            english(error),
            "OBS did not answer (SetCurrentProgramScene) within 5 seconds, so Punchboard is reconnecting to it. If OBS is frozen, restart it."
        );
        assert_eq!(failure.to_string(), english(error));
        // …and the link is dropped,
        settle().await;
        assert_ne!(rig.link.status(), LinkStatus::Connected);
        assert_eq!(rig.link.issue(), None);
        assert_eq!(good.clients(), 0);
        // said once, as the link's own doing and not as OBS closing:
        let log = rig.log();
        assert_eq!(
            log.last().map(String::as_str),
            Some("OBS did not answer SetCurrentProgramScene in time; reconnecting.")
        );
        assert!(
            !log.iter()
                .any(|line| line.contains("closed the connection")),
            "{log:?}"
        );
        // what OBS reported stops being true the moment it goes away.
        assert!(rig.toggles().is_empty() && rig.levels().is_empty());

        // The link comes back and presses work again.
        good.world().stalled.clear();
        wait(RETRY_MS[0] + 50).await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        rig.set_scene("Intro").await.expect("pressed");
        assert_eq!(good.world().current_scene, "Intro");
    }

    #[tokio::test(start_paused = true)]
    async fn an_obs_that_never_greets() {
        // obs.test.mjs: "an OBS that never greets".
        let good = FakeObs::start(FakeOptions::default());
        let mute = FakeObs::start(FakeOptions {
            hello: Hello::Never,
            ..FakeOptions::default()
        });
        let rig = Rig::new(&[("ws://good", &good), ("ws://mute", &mute)], "ws://good");
        rig.link.start();
        settle().await;
        assert_eq!(rig.level("obs:Mic"), Some(1.0));

        rig.set_address("ws://mute");
        rig.link.reset();
        settle().await;
        assert_ne!(rig.link.status(), LinkStatus::Connected);
        // OBS fader levels clear when OBS goes away.
        assert!(rig.levels().is_empty(), "{:?}", rig.levels());
        assert_eq!(good.clients(), 0);

        // A press against an OBS that never answers fails within the connect timeout.
        let started = Instant::now();
        let error = rig.link.connect().await.expect_err("never greeted");
        assert!(started.elapsed() <= Duration::from_millis(CONNECT_TIMEOUT_MS));
        assert_eq!(error.text.key, "server.obs.unreachable");
        assert_eq!(
            english(&error),
            "Could not reach OBS at ws://mute. Start OBS and switch on its WebSocket server (Tools › WebSocket Server Settings). (OBS did not answer within 6 seconds)"
        );
        // The link reports OBS unreachable.
        assert_eq!(rig.link.status(), LinkStatus::Disconnected);
        assert_eq!(rig.link.issue(), Some(ObsIssue::Unreachable));
        // The silent connection is closed, not left open.
        settle().await;
        assert_eq!(mute.clients(), 0);
        // Through the retries there is never more than the one attempt's socket.
        for _ in 0..40 {
            wait(500).await;
            assert!(mute.clients() <= 1);
        }
        let log = rig.log();
        let outages = log
            .iter()
            .filter(|line| line.contains("not reachable"))
            .count();
        assert_eq!(outages, 1, "{log:?}");
        assert!(log
            .contains(&"OBS is not reachable at ws://mute; will keep trying quietly.".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_password_is_its_own_issue() {
        let locked = FakeObs::start(FakeOptions::with_password("right"));
        let rig = Rig::new(&[("ws://locked", &locked)], "ws://locked");
        rig.set_password("wrong");
        let before = rig.statuses();
        let error = rig.link.connect().await.expect_err("refused");
        assert_eq!(error.text.key, "server.obs.wrongPassword");
        assert_eq!(rig.link.status(), LinkStatus::Disconnected);
        assert_eq!(rig.link.issue(), Some(ObsIssue::WrongPassword));
        assert_eq!(rig.statuses(), before + 1);
        // Retries that fail the same way do not tell the owner again.
        wait(30_000).await;
        assert_eq!(rig.statuses(), before + 1);
        assert_eq!(rig.link.issue(), Some(ObsIssue::WrongPassword));

        // The right password, and the link is reset: the issue goes at once.
        rig.set_password("right");
        rig.link.reset();
        assert_eq!(rig.link.issue(), None);
        settle().await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        assert_eq!(rig.link.issue(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn nothing_listening_is_unreachable_with_the_systems_reason() {
        let rig = Rig::new(&[], "ws://nowhere");
        let error = rig.link.connect().await.expect_err("nothing there");
        assert_eq!(error.text.key, "server.obs.unreachable");
        assert_eq!(
            english(&error),
            "Could not reach OBS at ws://nowhere. Start OBS and switch on its WebSocket server (Tools › WebSocket Server Settings). (connect ECONNREFUSED)"
        );
        assert_eq!(rig.link.issue(), Some(ObsIssue::Unreachable));
        assert_eq!(
            rig.log(),
            vec!["OBS is not reachable at ws://nowhere; will keep trying quietly.".to_string()]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn retries_come_after_two_three_then_every_five_seconds() {
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        let dials = rig.fail_dials(true);
        rig.link.start();
        settle().await;
        let started = Instant::now();
        let mut seen = vec![0];
        let mut count = 1;
        // Looked at between the moments a retry can fall on.
        wait(50).await;
        while seen.len() < 6 {
            wait(100).await;
            let now = dials.load(std::sync::atomic::Ordering::SeqCst);
            if now != count {
                count = now;
                seen.push((started.elapsed().as_millis() as u64) / 100 * 100);
            }
        }
        assert_eq!(seen, vec![0, 2000, 5000, 10000, 15000, 20000]);
        // OBS comes back: the next retry finds it, and the schedule starts over.
        rig.fail_dials(false);
        wait(5000).await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        good.disconnect();
        settle().await;
        assert_eq!(rig.link.status(), LinkStatus::Disconnected);
        assert_eq!(
            rig.log().last().map(String::as_str),
            Some("OBS closed the connection; will reconnect when it is back.")
        );
        wait(1900).await;
        assert_eq!(rig.link.status(), LinkStatus::Disconnected);
        wait(200).await;
        assert_eq!(rig.link.status(), LinkStatus::Connected);
    }

    #[tokio::test(start_paused = true)]
    async fn obs_going_away_clears_what_it_reported_and_the_link_returns() {
        // actions.test.mjs: "OBS going away".
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        rig.link.start();
        settle().await;
        assert!(!rig.toggles().is_empty());
        let statuses = rig.statuses();
        good.disconnect();
        settle().await;
        assert_ne!(rig.link.status(), LinkStatus::Connected);
        // OBS states clear when OBS closes, so nothing stays falsely lit.
        assert!(rig.toggles().is_empty(), "{:?}", rig.toggles());
        assert!(rig.levels().is_empty());
        assert_eq!(rig.statuses(), statuses + 1);
        // A closed link is no issue: OBS was there a moment ago.
        assert_eq!(rig.link.issue(), None);
    }

    #[tokio::test(start_paused = true)]
    async fn stopping_closes_the_socket_and_ends_the_attempts() {
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        rig.link.start();
        settle().await;
        assert_eq!(good.clients(), 1);
        let statuses = rig.statuses();
        rig.link.stop();
        settle().await;
        assert_eq!(good.clients(), 0);
        // Closing says nothing: nobody is left to hear.
        assert_eq!(rig.statuses(), statuses);
        let error = rig.link.connect().await.expect_err("closing");
        assert_eq!(error.text.key, "server.obs.closing");
        assert_eq!(english(&error), "Punchboard is closing.");
        wait(60_000).await;
        assert_eq!(good.clients(), 0);
        // Started again (it is not, in practice), it connects again.
        rig.link.start();
        settle().await;
        assert_eq!(good.clients(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn stopping_abandons_the_attempt_in_flight() {
        let mute = FakeObs::start(FakeOptions {
            hello: Hello::Never,
            ..FakeOptions::default()
        });
        let rig = Rig::new(&[("ws://mute", &mute)], "ws://mute");
        let link = rig.link.clone();
        let waiting = tokio::spawn(async move { link.connect().await });
        wait(100).await;
        assert_eq!(mute.clients(), 1);
        rig.link.stop();
        let error = waiting.await.expect("ran").expect_err("closing");
        assert_eq!(error.text.key, "server.obs.closing");
        settle().await;
        assert_eq!(mute.clients(), 0);
        wait(60_000).await;
        assert_eq!(mute.clients(), 0);
        assert!(rig.log().is_empty(), "{:?}", rig.log());
    }

    #[tokio::test(start_paused = true)]
    async fn a_refusal_from_obs_is_obs_own_words_and_keeps_the_link() {
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        let failure = rig.set_scene("Nope").await.expect_err("no such scene");
        assert_eq!(
            failure,
            ObsFailure::Obs(ObsError::new(
                600,
                "No source was found by the name of `Nope`."
            ))
        );
        assert_eq!(
            failure.said(),
            Said::Plain("No source was found by the name of `Nope`.".to_string())
        );
        assert_eq!(rig.link.status(), LinkStatus::Connected);
        // Boxed, it is still the error `text_of` knows how to word.
        let boxed: Box<dyn std::error::Error + Send + Sync> = failure.into();
        assert!(boxed.downcast_ref::<ObsError>().is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn the_names_for_the_pickers() {
        // actions.test.mjs: "names for the pickers".
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        let obs = rig.link.connect().await.expect("connected");
        let names = read_obs_names(&obs).await.expect("names");
        let sent = serde_json::to_value(&names).expect("serializes");
        // Scenes listed in OBS's own order.
        assert_eq!(sent["scenes"], json!(["Intro", "Main", "BRB"]));
        // Sources listed per scene, top first.
        assert_eq!(sent["sceneItems"]["Main"], json!(["Mic", "Camera"]));
        // Only inputs with audio offered for mute and faders.
        assert_eq!(sent["audioInputs"], json!(["Mic", "Desktop Audio"]));
        // Filters listed per source.
        assert_eq!(
            crate::store::stringify(&sent["filters"]),
            r#"{"Mic":["Voice Changer"],"Camera":["Blur"]}"#
        );
        assert_eq!(
            crate::store::stringify(&sent),
            r#"{"connected":true,"scenes":["Intro","Main","BRB"],"sceneItems":{"Intro":[],"Main":["Mic","Camera"],"BRB":[]},"audioInputs":["Mic","Desktop Audio"],"filters":{"Mic":["Voice Changer"],"Camera":["Blur"]}}"#
        );
    }

    // ------------------------------------------------------------ meters

    fn meter(fake: &FakeObs, mul: f64) {
        fake.emit(
            "InputVolumeMeters",
            json!({ "inputs": [
                { "inputName": "Mic", "inputLevelsMul": [[mul, mul, mul]] },
                { "inputName": "Desktop Audio", "inputLevelsMul": [[1, 1, 1]] },
            ] }),
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_end_of_a_burst_of_meters_is_sent_too() {
        // obs.test.mjs: "meters: the end of a burst is sent too".
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        rig.link.start();
        wait(150).await;
        meter(&good, 1.0);
        wait(10).await;
        assert_eq!(rig.meters(), vec![vec![("obs:Mic".to_string(), 1.0)]]);
        meter(&good, 0.0);
        wait(10).await;
        // Inside the window nothing more is sent yet…
        assert_eq!(rig.meters().len(), 1);
        wait(250).await;
        // …but the last meter values of a burst reach the decks,
        let meters = rig.meters();
        assert_eq!(meters.len(), 2);
        assert_eq!(meters[1], vec![("obs:Mic".to_string(), 0.0)]);
        // and meters only carry inputs a fader shows.
        assert!(meters
            .iter()
            .flatten()
            .all(|(key, _)| key != "obs:Desktop Audio"));
    }

    #[tokio::test(start_paused = true)]
    async fn meters_are_paced_and_only_read_when_someone_looks() {
        let good = FakeObs::start(FakeOptions::default());
        let rig = Rig::new(&[("ws://good", &good)], "ws://good");
        rig.link.start();
        settle().await;
        // OBS sends meters every 50 ms; the decks get them every 66 at most.
        let started = Instant::now();
        for step in 0..40 {
            meter(&good, f64::from(step % 10) / 10.0);
            wait(50).await;
        }
        wait(100).await;
        let sent = rig.meters().len();
        let most = (started.elapsed().as_millis() / u128::from(METER_INTERVAL_MS)) as usize + 1;
        assert!(sent > 20 && sent <= most, "{sent} sent, {most} at most");
        // Nobody looking: nothing is read or sent.
        rig.watch_meters(false);
        meter(&good, 0.5);
        wait(200).await;
        assert_eq!(rig.meters().len(), sent);
        // The link going away drops what was pending.
        rig.watch_meters(true);
        meter(&good, 0.5);
        wait(70).await;
        meter(&good, 0.25);
        meter(&good, 0.125);
        settle().await;
        let before = rig.meters().len();
        good.disconnect();
        wait(500).await;
        assert_eq!(rig.meters().len(), before);
    }
}
