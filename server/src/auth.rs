//! Paired devices and request signatures.
//!
//! A deck pairs once with a short-lived, single-use code (shown as a QR on
//! this computer) and receives its own secret. After that the secret never crosses the
//! network: each request is signed with HMAC-SHA256 over the method, path,
//! time, a one-off nonce and the body hash (see `sign.rs`). Stale
//! times and reused nonces are refused, so a request captured on the wifi
//! cannot be replayed. Removing a device revokes it at once.
//!
//! `devices.json` is the file the Node companion wrote: a device is kept as
//! the JSON object it was read as, so a field this version does not know
//! about survives, and the keys stay in the order they had.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::i18n::{english, say, Said, Text, UserError};
use crate::model::js;
use crate::sign::{canonical, hmac_hex, same_text, time_text};
use crate::store::{js_to_number, read_json_safe, write_json_atomic, ReadError, ReadResult};

const CODE_TTL_MS: u64 = 10 * 60 * 1000;
const CLOCK_WINDOW_MS: f64 = 2.0 * 60.0 * 1000.0;
/// Wrong codes one address may send before it has to wait.
const MAX_FAILED_CLAIMS: u32 = 8;
const CLAIM_LOCK_MS: u64 = 60 * 1000;
/// Wrong codes, from every address together, before a code is replaced.
const MAX_GUESSES_PER_CODE: u32 = 24;
/// lastSeen changes on every request; the file only needs it now and then.
const SAVE_DELAY: Duration = Duration::from_millis(30_000);

// ------------------------------------------------------------------ errors

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthErrorCode {
    Unpaired,
    Clock,
    Replay,
    BadSignature,
    BadCode,
    Locked,
}

impl AuthErrorCode {
    /// The code as replies carry it: "unpaired", "bad_signature"…
    pub fn as_str(self) -> &'static str {
        match self {
            AuthErrorCode::Unpaired => "unpaired",
            AuthErrorCode::Clock => "clock",
            AuthErrorCode::Replay => "replay",
            AuthErrorCode::BadSignature => "bad_signature",
            AuthErrorCode::BadCode => "bad_code",
            AuthErrorCode::Locked => "locked",
        }
    }
}

/// A refused pairing or signature; its text names the message (see UserError).
#[derive(Clone, Debug, PartialEq)]
pub struct AuthError {
    code: AuthErrorCode,
    text: Text,
}

impl AuthError {
    fn new(code: AuthErrorCode, key: &str) -> AuthError {
        AuthError {
            code,
            text: say(key),
        }
    }

    pub fn code(&self) -> AuthErrorCode {
        self.code
    }

    /// The message, to be worded for whoever asked.
    pub fn text(&self) -> &Text {
        &self.text
    }
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&english(&Said::Text(self.text.clone())))
    }
}

impl std::error::Error for AuthError {}

impl From<AuthError> for UserError {
    fn from(error: AuthError) -> UserError {
        UserError::new(error.text)
    }
}

/// Why a pairing did not happen: the code was refused, or the device could
/// not be made or written down (the TypeScript let that one escape as a
/// plain Error).
#[derive(Debug)]
pub enum ClaimError {
    Refused(AuthError),
    Failed(io::Error),
}

impl fmt::Display for ClaimError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClaimError::Refused(error) => error.fmt(f),
            ClaimError::Failed(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for ClaimError {}

impl From<AuthError> for ClaimError {
    fn from(error: AuthError) -> ClaimError {
        ClaimError::Refused(error)
    }
}

impl From<io::Error> for ClaimError {
    fn from(error: io::Error) -> ClaimError {
        ClaimError::Failed(error)
    }
}

// ------------------------------------------------------------------- types

/// A paired device as the Control Center lists it (`DeviceInfo` in src/shared/api.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastSeen")]
    pub last_seen: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
}

/// A paired device with its secret: what a claim answers, once.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Device {
    pub id: String,
    pub secret: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastSeen")]
    pub last_seen: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairingCode {
    pub code: String,
    /// Milliseconds since 1970.
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

/// The signature fields a request came with: any of them may be missing
/// (`Partial<SignedFields>`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Signed {
    pub device: Option<String>,
    pub time: Option<String>,
    pub nonce: Option<String>,
    pub signature: Option<String>,
}

// --------------------------------------------------------------- the world

/// What pairing asks of the system: the time, random numbers, and a way to
/// do something a little later. Tests hand in one they control.
pub trait World: Send + Sync {
    /// Milliseconds since 1970, as `Date.now()` gives them.
    fn now(&self) -> u64;
    /// A random whole number from 0 up to, not including, `below` (`crypto.randomInt`).
    fn random_int(&self, below: u32) -> io::Result<u32>;
    /// Random bytes fit for a secret (`crypto.randomBytes`).
    fn random_bytes(&self, bytes: &mut [u8]) -> io::Result<()>;
    /// Runs `work` once, after `delay` (`setTimeout`).
    fn later(&self, delay: Duration, work: Box<dyn FnOnce() + Send>);
}

/// The real clock and the system's random source.
pub struct System;

impl World for System {
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0)
    }

    fn random_int(&self, below: u32) -> io::Result<u32> {
        if below == 0 {
            return Ok(0);
        }
        // Numbers past the last whole multiple of `below` are thrown away,
        // so every answer is as likely as any other.
        let limit = (u32::MAX / below) * below;
        loop {
            let mut bytes = [0u8; 4];
            self.random_bytes(&mut bytes)?;
            let number = u32::from_le_bytes(bytes);
            if number < limit {
                return Ok(number % below);
            }
        }
    }

    fn random_bytes(&self, bytes: &mut [u8]) -> io::Result<()> {
        getrandom::getrandom(bytes).map_err(|error| io::Error::other(error.to_string()))
    }

    fn later(&self, delay: Duration, work: Box<dyn FnOnce() + Send>) {
        // A thread that sleeps costs nothing, and does not keep the companion
        // from quitting. The work travels in a shared slot so that, should
        // the thread not start, it is done now rather than never.
        let slot = Arc::new(Mutex::new(Some(work)));
        let theirs = Arc::clone(&slot);
        let started = std::thread::Builder::new()
            .name("devices-save".to_string())
            .spawn(move || {
                std::thread::sleep(delay);
                if let Some(work) = lock(&theirs).take() {
                    work();
                }
            });
        if started.is_err() {
            if let Some(work) = lock(&slot).take() {
                work();
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ------------------------------------------------------------ pure helpers

/// `/^\d{6}$/`.
fn is_six_digits(text: &str) -> bool {
    text.len() == 6 && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// `/^[0-9a-f]{16,64}$/`.
fn is_nonce(text: &str) -> bool {
    (16..=64).contains(&text.len())
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// `group.replace(/^0+(?=.)/, "")`: leading zeros go, but not the last
/// character (and `.` is not a line break).
fn strip_leading_zeros(group: &str) -> &str {
    let zeros = group.bytes().take_while(|byte| *byte == b'0').count();
    if zeros == 0 {
        return group;
    }
    let follows = |at: usize| matches!(group[at..].chars().next(), Some(c) if !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'));
    if follows(zeros) {
        &group[zeros..]
    } else if zeros >= 2 {
        &group[zeros - 1..]
    } else {
        group
    }
}

/// `/^::ffff:/i` taken off the front.
fn without_mapped_prefix(ip: &str) -> &str {
    match ip.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("::ffff:") => &ip[7..],
        _ => ip,
    }
}

/// The address a lockout applies to. An IPv6 machine can pick any address
/// in its /64, so the whole /64 counts as one.
pub fn claimant(ip: Option<&str>) -> String {
    let address = without_mapped_prefix(ip.unwrap_or(""));
    if !address.contains(':') {
        return address.to_string();
    }
    let groups: Vec<&str> = address.split("::").collect();
    let parts = |text: &str| -> Vec<String> {
        text.split(':')
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect()
    };
    let head = parts(groups.first().copied().unwrap_or(""));
    let tail = if groups.len() > 1 {
        parts(groups[1])
    } else {
        Vec::new()
    };
    let missing = 8usize.saturating_sub(head.len() + tail.len());
    let full: Vec<String> = head
        .into_iter()
        .chain(std::iter::repeat_n("0".to_string(), missing))
        .chain(tail)
        .collect();
    let network: Vec<String> = full
        .iter()
        .take(4)
        .map(|group| strip_leading_zeros(&group.to_lowercase()).to_string())
        .collect();
    format!("{}::/64", network.join(":"))
}

/// The name a device is kept under. Letters in any alphabet: a default name
/// may be "Teléfono Android".
pub fn device_name(name: &str) -> String {
    let kept: String = name
        .chars()
        .filter(|c| {
            matches!(c, '_' | ' ' | '.' | '\'' | '(' | ')' | '-')
                || matches!(
                    c.general_category_group(),
                    GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
                )
        })
        .collect();
    let cut = js::slice_utf16(&kept, 40);
    if cut.is_empty() {
        "Deck".to_string()
    } else {
        cut.to_string()
    }
}

// ----------------------------------------------------------------- devices

type Record = Map<String, Value>;

/// `isDevice`: the five fields a device cannot do without, all text.
fn is_device(value: &Value) -> bool {
    value.as_object().is_some_and(|fields| {
        ["id", "secret", "name", "createdAt", "lastSeen"]
            .iter()
            .all(|name| fields.get(*name).is_some_and(Value::is_string))
    })
}

fn is_devices_file(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|fields| fields.get("devices").is_some_and(Value::is_array))
}

fn field(record: &Record, name: &str) -> String {
    record
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// The address a device was last seen at, when the file has one.
fn ip_of(record: &Record) -> Option<String> {
    record
        .get("ip")
        .and_then(Value::as_str)
        .filter(|ip| !ip.is_empty())
        .map(str::to_string)
}

fn device_of(record: &Record) -> Device {
    Device {
        id: field(record, "id"),
        secret: field(record, "secret"),
        name: field(record, "name"),
        created_at: field(record, "createdAt"),
        last_seen: field(record, "lastSeen"),
        ip: ip_of(record),
    }
}

struct Failure {
    count: u32,
    locked_until: u64,
}

struct State {
    /// By id, in the order they were paired (a JavaScript Map).
    devices: Record,
    pairing: Option<PairingCode>,
    // Wrong codes are counted per address, so one machine on the wifi guessing
    // (or just pestering) cannot lock out the tablet someone is pairing. Each
    // code also takes only so many wrong guesses in all before it is replaced,
    // which keeps six digits out of reach however many addresses guess.
    failures: HashMap<String, Failure>,
    code_guesses: u32,
    /// "device:nonce" to the time it can be forgotten.
    nonces: HashMap<String, f64>,
    /// The save that is waiting, by its number.
    save_timer: Option<u64>,
    timers_made: u64,
}

struct Shared {
    file: PathBuf,
    log: Box<dyn Fn(&str) + Send + Sync>,
    world: Arc<dyn World>,
    state: Mutex<State>,
}

impl Shared {
    fn save(&self, state: &State) -> io::Result<()> {
        let devices: Vec<Value> = state.devices.values().cloned().collect();
        write_json_atomic(
            &self.file,
            &json!({ "version": 1, "devices": devices }),
            true,
        )
    }

    fn new_code(&self, state: &mut State) -> io::Result<PairingCode> {
        let pairing = PairingCode {
            code: format!("{:06}", self.world.random_int(1_000_000)?),
            expires_at: self.world.now() + CODE_TTL_MS,
        };
        state.pairing = Some(pairing.clone());
        state.code_guesses = 0;
        Ok(pairing)
    }

    fn current_code(&self, state: &mut State) -> io::Result<PairingCode> {
        match &state.pairing {
            Some(pairing) if self.world.now() <= pairing.expires_at => Ok(pairing.clone()),
            _ => self.new_code(state),
        }
    }
}

/// The paired devices and the pairing code (`createAuth`). Cheap to clone:
/// every clone is the same registry.
#[derive(Clone)]
pub struct Auth {
    shared: Arc<Shared>,
}

impl Auth {
    /// Reads `devices.json`. Fails only when the file and its backup are both
    /// unreadable (the damaged file has then been set aside), as the
    /// TypeScript threw.
    pub fn open(
        file: impl Into<PathBuf>,
        log: impl Fn(&str) + Send + Sync + 'static,
    ) -> Result<Auth, ReadError> {
        Auth::open_in(file, log, Arc::new(System))
    }

    /// As `open`, with the clock and the random source given.
    pub fn open_in(
        file: impl Into<PathBuf>,
        log: impl Fn(&str) + Send + Sync + 'static,
        world: Arc<dyn World>,
    ) -> Result<Auth, ReadError> {
        let file: PathBuf = file.into();
        let loaded = read_json_safe(&file, is_devices_file)?;
        if let ReadResult::Backup { aside, .. } = &loaded {
            log(&format!(
                "devices file was damaged; restored the backup (damaged copy kept as {}).",
                aside.display()
            ));
        }
        let mut devices = Record::new();
        let listed = loaded
            .data()
            .and_then(|data| data.get("devices").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        for device in listed {
            if !is_device(&device) {
                continue;
            }
            let id = device.get("id").and_then(Value::as_str).unwrap_or_default();
            // Two with one id: the later one, where the first one stood.
            devices.insert(id.to_string(), device);
        }
        Ok(Auth {
            shared: Arc::new(Shared {
                file,
                log: Box::new(log),
                world,
                state: Mutex::new(State {
                    devices,
                    pairing: None,
                    failures: HashMap::new(),
                    code_guesses: 0,
                    nonces: HashMap::new(),
                    save_timer: None,
                    timers_made: 0,
                }),
            }),
        })
    }

    /// The file the devices are kept in.
    pub fn file(&self) -> &Path {
        &self.shared.file
    }

    /// A new pairing code; the one before it stops working.
    pub fn new_code(&self) -> io::Result<PairingCode> {
        self.shared.new_code(&mut lock(&self.shared.state))
    }

    /// The pairing code to show: the current one, or a new one once it expired.
    pub fn current_code(&self) -> io::Result<PairingCode> {
        self.shared.current_code(&mut lock(&self.shared.state))
    }

    /// Pairs a device that sent `code` (whatever the request held under
    /// "code"), or says why not.
    pub fn claim(&self, code: &Value, name: &str, ip: Option<&str>) -> Result<Device, ClaimError> {
        let shared = &self.shared;
        let mut guard = lock(&shared.state);
        let state = &mut *guard;
        let at = shared.world.now();
        let who = claimant(ip);
        let record = state.failures.get(&who);
        if record.is_some_and(|record| at < record.locked_until) {
            return Err(AuthError::new(AuthErrorCode::Locked, "server.auth.locked").into());
        }
        // A lock that ran out starts the count again.
        let earlier = match record {
            Some(record) if record.locked_until == 0 => record.count,
            _ => 0,
        };
        let active = shared.current_code(state)?;
        let given = js::to_string(code);
        if !is_six_digits(&given) || !same_text(&given, &active.code) {
            let mut failed = Failure {
                count: earlier + 1,
                locked_until: 0,
            };
            if failed.count >= MAX_FAILED_CLAIMS {
                failed.locked_until = at + CLAIM_LOCK_MS;
                (shared.log)(&format!(
                    "Pairing locked for a minute for {} after repeated wrong codes.",
                    if who.is_empty() {
                        "an unknown address"
                    } else {
                        &who
                    }
                ));
            }
            state.failures.insert(who, failed);
            if state.failures.len() > 1000 {
                state.failures.retain(|_, value| value.locked_until >= at);
            }
            state.code_guesses += 1;
            if state.code_guesses >= MAX_GUESSES_PER_CODE {
                shared.new_code(state)?;
                (shared.log)("The pairing code was replaced after repeated wrong codes.");
            }
            return Err(AuthError::new(AuthErrorCode::BadCode, "server.auth.badCode").into());
        }
        // A code pairs one device: the next one needs the code shown after it.
        shared.new_code(state)?;
        state.failures.remove(&who);
        let now = crate::store::iso_from_millis(shared.world.now() as i64);
        let mut id = [0u8; 6];
        shared.world.random_bytes(&mut id)?;
        let mut secret = [0u8; 32];
        shared.world.random_bytes(&mut secret)?;
        // An address that is there but empty is no address to keep (`if (ip)`),
        // yet is what the log line shows (`ip ?? "unknown address"`).
        let given_ip = ip;
        let ip = ip.filter(|ip| !ip.is_empty());
        let device = Device {
            id: format!("dev_{}", hex::encode(id)),
            secret: hex::encode(secret),
            name: device_name(name),
            created_at: now.clone(),
            last_seen: now,
            ip: ip.map(str::to_string),
        };
        let mut record = Record::new();
        record.insert("id".to_string(), json!(device.id));
        record.insert("secret".to_string(), json!(device.secret));
        record.insert("name".to_string(), json!(device.name));
        record.insert("createdAt".to_string(), json!(device.created_at));
        record.insert("lastSeen".to_string(), json!(device.last_seen));
        if let Some(ip) = ip {
            record.insert("ip".to_string(), json!(ip));
        }
        state
            .devices
            .insert(device.id.clone(), Value::Object(record));
        shared.save(state)?;
        (shared.log)(&format!(
            "Paired a new device: {} ({}).",
            device.name,
            given_ip.unwrap_or("unknown address")
        ));
        Ok(device)
    }

    /// Returns the device that signed the request, or the reason it is refused.
    pub fn verify(
        &self,
        signed: &Signed,
        method: &str,
        path: &str,
        body: &str,
        ip: Option<&str>,
    ) -> Result<Device, AuthError> {
        let shared = &self.shared;
        let device;
        let timer;
        {
            let mut guard = lock(&shared.state);
            let state = &mut *guard;
            let id = signed.device.as_deref().unwrap_or("");
            let secret = match state.devices.get(id).and_then(Value::as_object) {
                Some(record) => field(record, "secret"),
                None => {
                    return Err(AuthError::new(
                        AuthErrorCode::Unpaired,
                        "server.auth.unpaired",
                    ))
                }
            };
            // Number(undefined) is not a number; Number("") is 0, a time long gone.
            let time = signed.time.as_deref().map_or(f64::NAN, js_to_number);
            if !time.is_finite() || (shared.world.now() as f64 - time).abs() > CLOCK_WINDOW_MS {
                return Err(AuthError::new(AuthErrorCode::Clock, "server.auth.clock"));
            }
            let nonce = signed.nonce.as_deref().unwrap_or("");
            if !is_nonce(nonce) {
                return Err(AuthError::new(
                    AuthErrorCode::BadSignature,
                    "server.auth.unsigned",
                ));
            }
            let expected = hmac_hex(
                &secret,
                &canonical(method, path, &time_text(time), nonce, body),
            );
            if !same_text(&expected, signed.signature.as_deref().unwrap_or("")) {
                return Err(AuthError::new(
                    AuthErrorCode::BadSignature,
                    "server.auth.badSignature",
                ));
            }
            let key = format!("{id}:{nonce}");
            if state.nonces.contains_key(&key) {
                return Err(AuthError::new(AuthErrorCode::Replay, "server.auth.replay"));
            }
            state.nonces.insert(key, time + CLOCK_WINDOW_MS * 2.0);
            if state.nonces.len() > 5000 {
                let now = shared.world.now() as f64;
                state.nonces.retain(|_, expiry| *expiry >= now);
            }
            let seen = crate::store::iso_from_millis(shared.world.now() as i64);
            let Some(Value::Object(record)) = state.devices.get_mut(id) else {
                return Err(AuthError::new(
                    AuthErrorCode::Unpaired,
                    "server.auth.unpaired",
                ));
            };
            record.insert("lastSeen".to_string(), json!(seen));
            if let Some(ip) = ip.filter(|ip| !ip.is_empty()) {
                record.insert("ip".to_string(), json!(ip));
            }
            device = device_of(record);
            // saveSoon: one save is enough for all the requests of half a minute.
            timer = if state.save_timer.is_none() {
                state.timers_made += 1;
                state.save_timer = Some(state.timers_made);
                state.save_timer
            } else {
                None
            };
        }
        if let Some(timer) = timer {
            let weak: Weak<Shared> = Arc::downgrade(shared);
            shared.world.later(
                SAVE_DELAY,
                Box::new(move || {
                    let Some(shared) = weak.upgrade() else { return };
                    let mut state = lock(&shared.state);
                    // flush() got there first, and this may be a later timer's turn.
                    if state.save_timer != Some(timer) {
                        return;
                    }
                    state.save_timer = None;
                    if let Err(error) = shared.save(&state) {
                        (shared.log)(&format!("Could not save the devices file: {error}"));
                    }
                }),
            );
        }
        Ok(device)
    }

    pub fn list(&self) -> Vec<DeviceInfo> {
        lock(&self.shared.state)
            .devices
            .values()
            .filter_map(Value::as_object)
            .map(|record| DeviceInfo {
                id: field(record, "id"),
                name: field(record, "name"),
                created_at: field(record, "createdAt"),
                last_seen: field(record, "lastSeen"),
                ip: ip_of(record),
            })
            .collect()
    }

    /// Forgets a device; whether there was one. It is revoked at once.
    pub fn remove(&self, id: &str) -> io::Result<bool> {
        let mut state = lock(&self.shared.state);
        let existed = state.devices.shift_remove(id).is_some();
        if existed {
            self.shared.save(&state)?;
        }
        Ok(existed)
    }

    /// Writes down what a waiting save would have, now (before quitting).
    pub fn flush(&self) -> io::Result<()> {
        let mut state = lock(&self.shared.state);
        if state.save_timer.take().is_some() {
            self.shared.save(&state)?;
        }
        Ok(())
    }

    /// Whether a device id is paired, checked before a signed body is read.
    pub fn has(&self, id: &str) -> bool {
        lock(&self.shared.state).devices.contains_key(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sign::{sign_request, SigningKey};
    use std::fs;

    // ------------------------------------------------------ a fixed world

    #[derive(Default)]
    struct Fixed {
        now: u64,
        /// How many random numbers have been asked for.
        asked: u64,
        timers: Vec<(u64, Box<dyn FnOnce() + Send>)>,
    }

    /// The world tests/fixtures/make-auth.ts gives the TypeScript: a clock
    /// that moves when told, and "random" numbers that follow a formula.
    #[derive(Default)]
    struct TestWorld(Mutex<Fixed>);

    impl TestWorld {
        fn at(now: u64) -> Arc<TestWorld> {
            let world = TestWorld::default();
            lock(&world.0).now = now;
            Arc::new(world)
        }

        /// Moves the clock on and runs what was due by then.
        fn advance(&self, ms: u64) {
            let due: Vec<Box<dyn FnOnce() + Send>> = {
                let mut fixed = lock(&self.0);
                fixed.now += ms;
                let now = fixed.now;
                let (due, waiting): (Vec<_>, Vec<_>) =
                    fixed.timers.drain(..).partition(|(at, _)| *at <= now);
                fixed.timers = waiting;
                due.into_iter().map(|(_, work)| work).collect()
            };
            for work in due {
                work();
            }
        }
    }

    impl World for TestWorld {
        fn now(&self) -> u64 {
            lock(&self.0).now
        }

        fn random_int(&self, below: u32) -> io::Result<u32> {
            let mut fixed = lock(&self.0);
            fixed.asked += 1;
            Ok(((fixed.asked * 2_654_435_761) % u64::from(below)) as u32)
        }

        fn random_bytes(&self, bytes: &mut [u8]) -> io::Result<()> {
            let mut fixed = lock(&self.0);
            fixed.asked += 1;
            for (at, byte) in bytes.iter_mut().enumerate() {
                *byte = ((fixed.asked * 131 + at as u64 * 29 + 7) & 255) as u8;
            }
            Ok(())
        }

        fn later(&self, delay: Duration, work: Box<dyn FnOnce() + Send>) {
            let mut fixed = lock(&self.0);
            let due = fixed.now + delay.as_millis() as u64;
            fixed.timers.push((due, work));
        }
    }

    type Logs = Arc<Mutex<Vec<String>>>;

    fn open(file: &Path, world: &Arc<TestWorld>, logs: &Logs) -> Result<Auth, ReadError> {
        let logs = Arc::clone(logs);
        Auth::open_in(
            file,
            move |line: &str| lock(&logs).push(line.to_string()),
            Arc::clone(world) as Arc<dyn World>,
        )
    }

    fn outcome<T: Serialize>(result: Result<T, AuthError>) -> Value {
        match result {
            Ok(device) => json!({ "device": device }),
            Err(error) => json!({ "error": error.code(), "key": error.text().key }),
        }
    }

    fn claim_outcome(result: Result<Device, ClaimError>) -> Value {
        match result {
            Ok(device) => json!({ "device": device }),
            Err(ClaimError::Refused(error)) => outcome::<Device>(Err(error)),
            Err(ClaimError::Failed(error)) => panic!("the claim failed: {error}"),
        }
    }

    // ------------------------------------------------------- the fixtures

    fn cases(file: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/auth")
            .join(file);
        let text =
            fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    fn optional(value: &Value) -> Option<String> {
        value.as_str().map(str::to_string)
    }

    fn read(file: &Path) -> Value {
        match fs::read_to_string(file) {
            Ok(text) => Value::String(text),
            Err(_) => Value::Null,
        }
    }

    /// Runs one case of a scenario file: the same steps the TypeScript took,
    /// in the same world, answering the same.
    fn replay(case: &Value) -> usize {
        let name = case["name"].as_str().expect("a name");
        let input = &case["input"];
        let dir = tempfile::tempdir().expect("a folder");
        let file = dir.path().join("devices.json");
        if let Some(text) = input["file"].as_str() {
            fs::write(&file, text).expect("devices.json");
        }
        if let Some(text) = input["bak"].as_str() {
            fs::write(dir.path().join("devices.json.bak"), text).expect("devices.json.bak");
        }
        let world = TestWorld::at(input["now"].as_u64().expect("a time"));
        let logs = Logs::default();
        let opened = open(&file, &world, &logs);
        assert_eq!(
            case["output"]["opened"],
            json!(opened.is_ok()),
            "{name}: whether it opens"
        );
        let Ok(mut auth) = opened else { return 0 };
        // The first line names the damaged copy by its full path and the time.
        let said: Vec<String> = lock(&logs)
            .iter()
            .map(|line| {
                line.split(" (damaged copy")
                    .next()
                    .unwrap_or("")
                    .to_string()
            })
            .collect();
        assert_eq!(
            case["output"]["startLog"],
            json!(said),
            "{name}: the log at the start"
        );
        lock(&logs).clear();

        let steps = input["steps"].as_array().expect("steps");
        let expected = case["output"]["steps"].as_array().expect("answers");
        assert_eq!(steps.len(), expected.len(), "{name}");
        for (at, (step, theirs)) in steps.iter().zip(expected).enumerate() {
            let ip = optional(&step["ip"]);
            let ours = match step["op"].as_str().expect("an op") {
                "advance" => {
                    world.advance(step["ms"].as_u64().expect("ms"));
                    Value::Null
                }
                "currentCode" => json!(auth.current_code().expect("a code")),
                "newCode" => json!(auth.new_code().expect("a code")),
                "claim" => claim_outcome(auth.claim(
                    &step["code"],
                    step["name"].as_str().expect("a name"),
                    ip.as_deref(),
                )),
                "verify" => {
                    let signed = Signed {
                        device: optional(&step["signed"]["device"]),
                        time: optional(&step["signed"]["time"]),
                        nonce: optional(&step["signed"]["nonce"]),
                        signature: optional(&step["signed"]["signature"]),
                    };
                    outcome(auth.verify(
                        &signed,
                        step["method"].as_str().expect("a method"),
                        step["path"].as_str().expect("a path"),
                        step["body"].as_str().expect("a body"),
                        ip.as_deref(),
                    ))
                }
                "has" => json!(auth.has(step["id"].as_str().expect("an id"))),
                "list" => json!(auth.list()),
                "remove" => json!(auth
                    .remove(step["id"].as_str().expect("an id"))
                    .expect("saved")),
                "flush" => {
                    auth.flush().expect("saved");
                    Value::Null
                }
                "file" => read(&file),
                "bak" => read(&dir.path().join("devices.json.bak")),
                "logs" => json!(std::mem::take(&mut *lock(&logs))),
                "reopen" => {
                    auth = open(&file, &world, &logs).expect("it opens again");
                    Value::Null
                }
                other => panic!("{name}: no such step: {other}"),
            };
            assert_eq!(*theirs, ours, "{name}: step {at} {step}");
        }
        steps.len()
    }

    fn replay_all(file: &str, at_least: usize) {
        let all = cases(file);
        let steps: usize = all.iter().map(replay).sum();
        assert!(steps >= at_least, "{file}: only {steps} steps");
    }

    #[test]
    fn claims_match_the_typescript() {
        replay_all("auth-claim.json", 300);
    }

    #[test]
    fn verifying_matches_the_typescript() {
        replay_all("auth-verify.json", 60);
    }

    #[test]
    fn the_devices_file_matches_the_typescript() {
        replay_all("auth-devices.json", 60);
    }

    #[test]
    fn claimants_match_the_typescript() {
        let all = cases("auth-claimant.json");
        assert!(all.len() >= 30, "{} cases", all.len());
        for case in &all {
            let ip = optional(&case["input"]);
            assert_eq!(
                case["output"],
                json!(claimant(ip.as_deref())),
                "claimant({})",
                case["input"]
            );
        }
    }

    #[test]
    fn names_match_the_typescript() {
        let all = cases("auth-name.json");
        assert!(all.len() >= 25, "{} cases", all.len());
        for case in &all {
            let name = case["input"].as_str().expect("a name");
            assert_eq!(
                case["output"],
                json!(device_name(name)),
                "the name {name:?}"
            );
        }
    }

    // ------------------------------------- tests/security.test.mjs, ported

    const NOW: u64 = 1_750_000_000_000;

    struct Bench {
        _dir: tempfile::TempDir,
        file: PathBuf,
        world: Arc<TestWorld>,
        logs: Logs,
        auth: Auth,
    }

    fn bench() -> Bench {
        let dir = tempfile::tempdir().expect("a folder");
        let file = dir.path().join("devices.json");
        let world = TestWorld::at(NOW);
        let logs = Logs::default();
        let auth = open(&file, &world, &logs).expect("it opens");
        Bench {
            _dir: dir,
            file,
            world,
            logs,
            auth,
        }
    }

    impl Bench {
        fn code(&self) -> String {
            self.auth.current_code().expect("a code").code
        }

        /// "paired", or the code of the refusal.
        fn try_claim(&self, code: &str, ip: &str) -> &'static str {
            match self.auth.claim(&json!(code), "Unit", Some(ip)) {
                Ok(_) => "paired",
                Err(ClaimError::Refused(error)) => error.code().as_str(),
                Err(ClaimError::Failed(error)) => panic!("{error}"),
            }
        }

        fn pair(&self, name: &str, ip: &str) -> Device {
            self.auth
                .claim(&json!(self.code()), name, Some(ip))
                .expect("paired")
        }

        fn signed(
            &self,
            device: &Device,
            method: &str,
            path: &str,
            body: &str,
            nonce: &str,
        ) -> Signed {
            self.signed_at(device, method, path, body, nonce, self.world.now() as f64)
        }

        fn signed_at(
            &self,
            device: &Device,
            method: &str,
            path: &str,
            body: &str,
            nonce: &str,
            time: f64,
        ) -> Signed {
            let key = SigningKey {
                id: device.id.clone(),
                secret: device.secret.clone(),
            };
            let fields = sign_request(&key, method, path, body, time, nonce);
            Signed {
                device: Some(fields.device),
                time: Some(fields.time),
                nonce: Some(fields.nonce),
                signature: Some(fields.signature),
            }
        }
    }

    fn wrong(code: &str) -> String {
        format!(
            "{:06}",
            (code.parse::<u32>().expect("digits") + 1) % 1_000_000
        )
    }

    fn refusal(result: Result<Device, AuthError>) -> &'static str {
        match result {
            Ok(_) => "accepted",
            Err(error) => error.code().as_str(),
        }
    }

    const NONCE: &str = "00112233445566778899aabbccddeeff";

    #[test]
    fn a_code_pairs_once() {
        let bench = bench();
        let code = bench.code();
        assert_eq!(bench.try_claim(&code, "10.0.0.2"), "paired");
        assert_eq!(bench.try_claim(&code, "10.0.0.3"), "bad_code");
        // "The pairing window gets a new code once one is used".
        let next = bench.code();
        assert!(is_six_digits(&next) && next != code, "{next}");
    }

    #[test]
    fn eight_wrong_codes_lock_that_address_only() {
        let bench = bench();
        let code = bench.code();
        let results: Vec<&str> = (0..9)
            .map(|_| bench.try_claim(&wrong(&code), "10.0.0.66"))
            .collect();
        assert!(
            results[..8].iter().all(|result| *result == "bad_code"),
            "{results:?}"
        );
        assert_eq!(results[8], "locked");
        // The code is not replaced by one address's guesses.
        assert_eq!(bench.code(), code);
        // "The guessing address stays locked, even with the right code".
        assert_eq!(bench.try_claim(&code, "10.0.0.66"), "locked");
        // Other addresses still pair while one is locked.
        assert_eq!(bench.try_claim(&code, "10.0.0.7"), "paired");
        assert_eq!(
            lock(&bench.logs)[0],
            "Pairing locked for a minute for 10.0.0.66 after repeated wrong codes."
        );
    }

    #[test]
    fn a_lock_lasts_a_minute() {
        let bench = bench();
        let code = bench.code();
        for _ in 0..8 {
            bench.try_claim(&wrong(&code), "10.0.0.66");
        }
        bench.world.advance(CLAIM_LOCK_MS - 1);
        assert_eq!(bench.try_claim(&code, "10.0.0.66"), "locked");
        bench.world.advance(1);
        assert_eq!(bench.try_claim(&code, "10.0.0.66"), "paired");
    }

    #[test]
    fn a_whole_ipv6_64_counts_as_one_address() {
        let bench = bench();
        let code = bench.code();
        let v6: Vec<&str> = (0..9)
            .map(|i| bench.try_claim(&wrong(&code), &format!("fd00:1:2:3::{:x}", i + 1)))
            .collect();
        assert_eq!(v6[8], "locked", "{v6:?}");
        assert_eq!(bench.try_claim(&code, "fd00:1:2:3:ffff::9"), "locked");
        // Another /64 is not locked by it.
        assert_eq!(bench.try_claim(&code, "fd00:1:2:4::1"), "paired");
    }

    #[test]
    fn many_addresses_guessing_together_get_the_code_replaced() {
        let bench = bench();
        let code = bench.code();
        let mut addresses = 0;
        while bench.code() == code && addresses < 10 {
            addresses += 1;
            for _ in 0..7 {
                bench.try_claim(&wrong(&code), &format!("10.1.0.{addresses}"));
            }
        }
        assert!(
            bench.code() != code && addresses <= 4,
            "{addresses} addresses"
        );
        // The replaced code no longer pairs.
        assert_eq!(bench.try_claim(&code, "10.2.0.1"), "bad_code");
        assert!(lock(&bench.logs)
            .iter()
            .any(|line| line == "The pairing code was replaced after repeated wrong codes."));
    }

    #[test]
    fn a_code_expires_after_ten_minutes() {
        let bench = bench();
        let first = bench.auth.current_code().expect("a code");
        assert_eq!(first.expires_at, NOW + CODE_TTL_MS);
        bench.world.advance(CODE_TTL_MS);
        assert_eq!(bench.auth.current_code().expect("a code"), first);
        bench.world.advance(1);
        let second = bench.auth.current_code().expect("a code");
        assert_ne!(second.code, first.code);
        assert_eq!(bench.try_claim(&first.code, "10.0.0.2"), "bad_code");
    }

    #[test]
    fn the_right_code_gives_a_device_secret() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        assert_eq!(device.secret.len(), 64);
        assert!(device
            .secret
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert!(
            device.id.starts_with("dev_") && device.id.len() == 16,
            "{}",
            device.id
        );
        assert_eq!(device.name, "Test iPad");
        assert_eq!(device.created_at, "2025-06-15T15:06:40.000Z");
        assert!(bench.auth.has(&device.id));
        assert_eq!(
            lock(&bench.logs)[0],
            "Paired a new device: Test iPad (192.168.1.20)."
        );
        // The secret is in the file and nowhere in the list.
        let listed = json!(bench.auth.list());
        assert_eq!(listed[0]["id"], json!(device.id));
        assert!(listed[0].get("secret").is_none());
        let stored = fs::read_to_string(&bench.file).expect("devices.json");
        assert!(stored.contains(&device.secret));
    }

    #[test]
    fn wrong_codes_of_every_shape_are_refused() {
        let bench = bench();
        let code = bench.code();
        for (at, given) in [
            json!("000001x"),
            json!(null),
            json!(""),
            json!({ "code": code }),
            json!(format!("{code}\n")),
            json!(format!(" {code}")),
            json!(true),
        ]
        .iter()
        .enumerate()
        {
            let ip = format!("10.3.0.{at}");
            match bench.auth.claim(given, "Unit", Some(&ip)) {
                Err(ClaimError::Refused(error)) => assert_eq!(error.code(), AuthErrorCode::BadCode),
                other => panic!("{given}: {other:?}"),
            }
        }
        // String(code) reads a number, or a list of one, as its digits.
        assert!(bench
            .auth
            .claim(&json!([bench.code()]), "Unit", Some("10.3.1.1"))
            .is_ok());
        let digits: u32 = bench.code().parse().expect("digits");
        if digits >= 100_000 {
            assert!(bench
                .auth
                .claim(&json!(digits), "Unit", Some("10.3.1.2"))
                .is_ok());
        }
    }

    #[test]
    fn a_signed_request_from_a_paired_device_works() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        let signed = bench.signed(&device, "GET", "/api/library", "", NONCE);
        let seen = bench
            .auth
            .verify(&signed, "GET", "/api/library", "", Some("192.168.1.21"))
            .expect("verified");
        assert_eq!(seen.id, device.id);
        assert_eq!(seen.ip.as_deref(), Some("192.168.1.21"));
    }

    #[test]
    fn a_replayed_request_is_refused() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        let signed = bench.signed(&device, "GET", "/api/status", "", NONCE);
        assert_eq!(
            refusal(bench.auth.verify(&signed, "GET", "/api/status", "", None)),
            "accepted"
        );
        assert_eq!(
            refusal(bench.auth.verify(&signed, "GET", "/api/status", "", None)),
            "replay"
        );
    }

    #[test]
    fn a_tampered_body_is_refused() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        let body = r#"{"profileId":"profile_default","buttonId":"nope"}"#;
        let signed = bench.signed(&device, "POST", "/api/press", body, NONCE);
        let sent = body.replace("nope", "btn_1");
        let result = bench
            .auth
            .verify(&signed, "POST", "/api/press", &sent, None);
        assert_eq!(refusal(result), "bad_signature");
        // Refused, so the nonce is still good for the request that was signed.
        assert_eq!(
            refusal(bench.auth.verify(&signed, "POST", "/api/press", body, None)),
            "accepted"
        );
    }

    #[test]
    fn stale_and_future_times_are_refused() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        let now = NOW as f64;
        for (time, expected) in [
            (now - 10.0 * 60.0 * 1000.0, "clock"),
            (now - CLOCK_WINDOW_MS - 1.0, "clock"),
            (now - CLOCK_WINDOW_MS, "accepted"),
            (now + CLOCK_WINDOW_MS, "accepted"),
            (now + CLOCK_WINDOW_MS + 1.0, "clock"),
        ] {
            let nonce = format!("{:032x}", time as u64);
            let signed = bench.signed_at(&device, "GET", "/api/status", "", &nonce, time);
            assert_eq!(
                refusal(bench.auth.verify(&signed, "GET", "/api/status", "", None)),
                expected,
                "{}",
                time - now
            );
        }
    }

    #[test]
    fn a_wrong_secret_is_refused() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        let other = Device {
            secret: "0".repeat(64),
            ..device
        };
        let signed = bench.signed(&other, "GET", "/api/status", "", NONCE);
        assert_eq!(
            refusal(bench.auth.verify(&signed, "GET", "/api/status", "", None)),
            "bad_signature"
        );
    }

    #[test]
    fn malformed_signature_fields_are_refused() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        // An unknown device first, whatever else is wrong.
        assert_eq!(
            refusal(bench.auth.verify(&Signed::default(), "GET", "/", "", None)),
            "unpaired"
        );
        let fields = |time: &str, nonce: &str, signature: &str| Signed {
            device: Some(device.id.clone()),
            time: Some(time.to_string()),
            nonce: Some(nonce.to_string()),
            signature: Some(signature.to_string()),
        };
        // X-Punchboard-Time: soon, as the black-box test sends it. The server
        // answers "bad_signature" for it before verify() is asked; verify()
        // itself calls a time that is not a number a clock problem.
        let error = bench
            .auth
            .verify(&fields("soon", "n", "s"), "POST", "/api/press", "{}", None)
            .expect_err("refused");
        assert_eq!(
            (error.code(), error.text().key.as_str()),
            (AuthErrorCode::Clock, "server.auth.clock")
        );
        let now = NOW.to_string();
        let error = bench
            .auth
            .verify(&fields(&now, "n", "s"), "POST", "/api/press", "{}", None)
            .expect_err("refused");
        assert_eq!(
            (error.code(), error.text().key.as_str()),
            (AuthErrorCode::BadSignature, "server.auth.unsigned")
        );
        let error = bench
            .auth
            .verify(&fields(&now, NONCE, "s"), "POST", "/api/press", "{}", None)
            .expect_err("refused");
        assert_eq!(
            (error.code(), error.text().key.as_str()),
            (AuthErrorCode::BadSignature, "server.auth.badSignature")
        );
    }

    #[test]
    fn a_removed_device_is_refused_afterwards() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        assert!(bench.auth.remove(&device.id).expect("saved"));
        assert!(!bench.auth.remove(&device.id).expect("saved"));
        assert!(!bench.auth.has(&device.id));
        let signed = bench.signed(&device, "GET", "/api/library", "", NONCE);
        assert_eq!(
            refusal(bench.auth.verify(&signed, "GET", "/api/library", "", None)),
            "unpaired"
        );
        let stored = fs::read_to_string(&bench.file).expect("devices.json");
        assert_eq!(stored, "{\n  \"version\": 1,\n  \"devices\": []\n}\n");
    }

    #[test]
    fn last_seen_is_written_half_a_minute_later_or_on_flush() {
        let bench = bench();
        let device = bench.pair("Test iPad", "192.168.1.20");
        let before = fs::read_to_string(&bench.file).expect("devices.json");
        bench.world.advance(5000);
        let signed = bench.signed(&device, "GET", "/api/status", "", NONCE);
        bench
            .auth
            .verify(&signed, "GET", "/api/status", "", None)
            .expect("verified");
        bench.world.advance(29_999);
        assert_eq!(
            fs::read_to_string(&bench.file).expect("devices.json"),
            before
        );
        bench.world.advance(1);
        let after = fs::read_to_string(&bench.file).expect("devices.json");
        assert!(
            after.contains("\"lastSeen\": \"2025-06-15T15:06:45.000Z\""),
            "{after}"
        );

        // flush() writes at once, and the timer it overtook does nothing.
        bench.world.advance(1000);
        let again = bench.signed(
            &device,
            "GET",
            "/api/status",
            "",
            "ffeeddccbbaa99887766554433221100",
        );
        bench
            .auth
            .verify(&again, "GET", "/api/status", "", None)
            .expect("verified");
        bench.auth.flush().expect("saved");
        let flushed = fs::read_to_string(&bench.file).expect("devices.json");
        assert!(
            flushed.contains("\"lastSeen\": \"2025-06-15T15:07:16.000Z\""),
            "{flushed}"
        );
        fs::remove_file(&bench.file).expect("removed");
        bench.world.advance(60_000);
        assert!(
            !bench.file.exists(),
            "the overtaken timer wrote the file again"
        );
    }

    #[test]
    fn an_auth_error_becomes_a_user_error() {
        let error = AuthError::new(AuthErrorCode::Locked, "server.auth.locked");
        assert_eq!(error.code().as_str(), "locked");
        let user: UserError = error.clone().into();
        assert_eq!(user.text.key, "server.auth.locked");
        assert_eq!(
            error.to_string(),
            "Too many wrong codes. Wait a minute, then try the code on the computer again."
        );
        assert_eq!(user.message(), error.to_string());
    }

    #[test]
    fn the_system_world_gives_usable_numbers() {
        let world = System;
        assert!(world.now() > 1_700_000_000_000);
        for _ in 0..200 {
            assert!(world.random_int(1_000_000).expect("a number") < 1_000_000);
        }
        let (mut a, mut b) = ([0u8; 32], [0u8; 32]);
        world.random_bytes(&mut a).expect("bytes");
        world.random_bytes(&mut b).expect("bytes");
        assert_ne!(a, b);
        // The real timer runs its work, a little later.
        let (sent, received) = std::sync::mpsc::channel();
        world.later(
            Duration::from_millis(10),
            Box::new(move || {
                let _ = sent.send(());
            }),
        );
        assert!(received.recv_timeout(Duration::from_secs(5)).is_ok());
    }
}
