//! Punchboard companion: serves the Control Center to this computer and the
//! deck to paired tablets, and runs their button presses.
//! (src/server/main.ts)
//!
//! Who may call what:
//!   public  pages, and claiming a pairing code
//!   deck    a paired device with a signed request (auth.rs), or this computer
//!   local   this computer only: editing decks, settings, sounds, pairing
//! Every request must also name this server in its Host header and, when it
//! changes something, come from this server's own origin. That stops other
//! web pages and DNS rebinding from driving the companion through a browser.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::{Body, BodyDataStream, Bytes, HttpBody};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, Stream, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use url::Url;

use crate::actions::{prepare_steps, run_steps, ActionContext, Done};
use crate::apps::{self, Failure as Wrong, SystemFailure};
use crate::audio::app_levels::{create_app_levels, AppLevels, AppLevelsOptions};
use crate::audio::app_volume::AppVolume;
use crate::audio::player::{Player, PlayerOptions, Slot, IDLE_CLOSE};
use crate::audio::volume::{is_level, read_level, write_level, SystemVolume, VolumeContext};
use crate::audio::{Answer, Audio, VolumeError};
use crate::auth::{Auth, AuthErrorCode, ClaimError, Device, Signed};
use crate::config::{load_config, save_config, Config, ObsSource};
use crate::events::{Live, LiveSettings};
use crate::google_icons::GoogleIcons;
use crate::http::{
    error_response, is_json_type, locale_file, parse_json_object, public_file, raw_body, send_json,
    static_file, HttpError, JSON_LIMIT, SECURITY_HEADERS,
};
use crate::i18n::{
    is_language_setting, language_codes, language_for, languages, locales_dir, render, say,
    system_language, text_of, translator, use_language_setting, Said, Text, UserError,
};
use crate::library::LibraryStore;
use crate::model::actions::LIMITS;
use crate::model::colors::is_hex_color_value;
use crate::model::ids::Ids;
use crate::model::js;
use crate::model::links::SUPPORT_URL;
use crate::model::normalize::{
    button_state_key, fader_level_key, is_library_shape, is_switch, normalize_library,
    normalize_trackpad,
};
use crate::model::themes::is_theme_id;
use crate::model::types::{Action, FaderTarget, MediaKey};
use crate::net::{get_local_ipv4, own_hostnames};
use crate::obs::client::{network, ObsClient};
use crate::obs::config::{read_local_obs, LocalObs};
use crate::obs::link::{
    obs_call, LinkStatus, ObsFailure, ObsIssue, ObsLink, ObsLinkOptions, ObsSettings,
};
use crate::obs::state::{read_obs_names, ObsState, ObsStateOptions};
use crate::paths::{app_version, data_dir, migrate_legacy_data, paths, resolve};
use crate::pointer::{next_owner, Pointer, PointerOptions, PointerOwner};
use crate::port::{claim_port, PortOutcome, PORT_RANGE};
use crate::sounds::{is_audio, AudioType, SoundStore};
use crate::store::{iso_now, js_to_number, stringify};
use crate::test_system;
use crate::touch_trace::{
    is_touch_frame, is_touchpad_event, summarize, TouchpadTrace, TRACE_LIMITS,
};

// Libraries carry custom icons as data URIs, so they can be large.
const LIBRARY_LIMIT: usize = 24 * 1024 * 1024;
// Thirty seconds of fingers at 120 Hz, with what the engine made of them.
const TRACE_LIMIT: usize = 1024 * 1024;
/// Traces kept on disk; older ones go, so a device left recording cannot fill it.
const TRACES_KEPT: usize = 50;

fn log(message: &str) {
    println!("[punchboard] {message}");
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `Date.now()`.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_millis() as u64)
}

/// What Node called this system (`process.platform`).
const PLATFORM: &str = if cfg!(target_os = "macos") {
    "darwin"
} else if cfg!(windows) {
    "win32"
} else {
    "linux"
};

// ---------------------------------------------------------------- failures

/// How a request went wrong: with a reply of its own, or with anything else
/// (which is logged and answered with a 500).
pub enum Failure {
    Http(HttpError),
    Other(Wrong),
}

impl From<HttpError> for Failure {
    fn from(error: HttpError) -> Failure {
        Failure::Http(error)
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Failure {
        Failure::Other(Box::new(error))
    }
}

impl From<UserError> for Failure {
    fn from(error: UserError) -> Failure {
        Failure::Other(Box::new(error))
    }
}

impl From<Wrong> for Failure {
    fn from(error: Wrong) -> Failure {
        Failure::Other(error)
    }
}

fn refused(status: u16, key: &str) -> HttpError {
    HttpError::new(status, say(key))
}

// ---------------------------------------------------------------- requests

/// A request's body as it arrives. It knows whether it was read to its end
/// (`req.complete`), and a body nobody finished reading is read and dropped
/// while the reply goes out, so the client reads the reply rather than a reset.
struct Arriving {
    inner: Option<BodyDataStream>,
    complete: Arc<AtomicBool>,
}

impl Stream for Arriving {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = &mut *self;
        let Some(inner) = this.inner.as_mut() else {
            return Poll::Ready(None);
        };
        let next = Pin::new(inner).poll_next(cx);
        if let Poll::Ready(None) = next {
            this.complete.store(true, Ordering::SeqCst);
            this.inner = None;
        }
        next
    }
}

impl Drop for Arriving {
    fn drop(&mut self) {
        let Some(mut rest) = self.inner.take() else {
            return;
        };
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let drain = async { while let Some(Ok(_)) = rest.next().await {} };
                let _ = tokio::time::timeout(Duration::from_secs(5), drain).await;
            });
        }
    }
}

/// One request, as the routes see it.
struct Ask {
    method: Method,
    url: Url,
    headers: HeaderMap,
    /// `req.socket.remoteAddress`.
    remote: String,
    body: Option<Body>,
    /// The body once it was read: a signature covers the exact bytes sent,
    /// and the route reads them again.
    raw: Option<Bytes>,
    complete: Arc<AtomicBool>,
}

impl Ask {
    fn language(&self) -> String {
        language_for(&self.headers)
    }

    /// A header as Node handed it over: several of one name joined by ", ".
    fn header(&self, name: &str) -> Option<String> {
        let values: Vec<String> = self
            .headers
            .get_all(name)
            .iter()
            // Node reads header bytes as Latin-1.
            .map(|value| value.as_bytes().iter().map(|byte| *byte as char).collect())
            .collect();
        if values.is_empty() {
            None
        } else {
            Some(values.join(", "))
        }
    }

    fn query(&self, name: &str) -> Option<String> {
        self.url
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    async fn raw_body(&mut self, limit: usize) -> Result<Bytes, HttpError> {
        if let Some(raw) = &self.raw {
            return Ok(raw.clone());
        }
        let body = self.body.take().unwrap_or_else(Body::empty);
        let raw = raw_body(&self.headers, body, limit).await?;
        self.raw = Some(raw.clone());
        Ok(raw)
    }

    async fn json_body(&mut self, limit: usize) -> Result<Map<String, Value>, HttpError> {
        if !is_json_type(&self.headers) {
            return Err(refused(415, "server.request.notJsonType"));
        }
        parse_json_object(&self.raw_body(limit).await?)
    }
}

/// `encodeURIComponent`.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

// ------------------------------------------------------------------ access

/// The parts of a Host header: `/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/`.
fn host_parts(host: &str) -> Option<(&str, Option<&str>)> {
    fn port_of(rest: &str) -> Option<Option<&str>> {
        if rest.is_empty() {
            return Some(None);
        }
        let digits = rest.strip_prefix(':')?;
        (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
            .then_some(Some(digits))
    }
    // An IPv6 address in brackets, colons and all.
    if host.starts_with('[') {
        if let Some(end) = host.find(']').filter(|end| *end >= 2) {
            if let Some(port) = port_of(&host[end + 1..]) {
                return Some((&host[..=end], port));
            }
        }
    }
    let end = host.find(':').unwrap_or(host.len());
    if end == 0 {
        return None;
    }
    Some((&host[..end], port_of(&host[end..])?))
}

/// Whether a Host header names this server: one of `names`, on `port`.
fn host_allowed(host: Option<&str>, names: &HashSet<String>, port: u16) -> bool {
    let host = host.unwrap_or("").to_lowercase();
    let Some((name, given)) = host_parts(&host) else {
        return false;
    };
    // Number(match[2] ?? 80) === PORT
    let asked = given.map_or(80.0, js_to_number);
    names.contains(name) && asked == f64::from(port)
}

/// Whether a request's Origin, when it has one, is this server's own.
fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin.filter(|origin| !origin.is_empty()) else {
        return true;
    };
    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    // `new URL(origin).host`: the name, and the port when it is not the scheme's own.
    let mut from = url.host_str().unwrap_or("").to_string();
    if let Some(port) = url.port() {
        from.push_str(&format!(":{port}"));
    }
    from.to_lowercase() == host.unwrap_or("").to_lowercase()
}

// Only loopback is trusted as "this computer". Anything reaching the server by
// its network address, even from this machine, has to pair like a tablet.
fn is_loopback(remote: &str) -> bool {
    matches!(remote, "127.0.0.1" | "::1" | "::ffff:127.0.0.1")
}

/// Which message names a device that did not give a name, from its browser.
fn device_kind(agent: &str) -> &'static str {
    let mobile_mac = agent.find("Macintosh").is_some_and(|at| {
        agent[at..]
            .split(['\n', '\r'])
            .next()
            .is_some_and(|line| line.contains("Mobile"))
    });
    if agent.contains("iPad") || mobile_mac {
        "ipad"
    } else if agent.contains("iPhone") {
        "iphone"
    } else if agent.contains("Android") {
        if agent.contains("Mobile") {
            "androidPhone"
        } else {
            "androidTablet"
        }
    } else if agent.contains("Windows") {
        "windows"
    } else {
        "browser"
    }
}

fn audio_type(value: &str) -> Option<AudioType> {
    match value {
        "audio/wav" => Some(AudioType::Wav),
        "audio/mpeg" | "audio/mp3" => Some(AudioType::Mpeg),
        _ => None,
    }
}

/// `/^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i`
fn is_local_obs_address(address: &str) -> bool {
    let lowered = address.to_ascii_lowercase();
    let Some(rest) = lowered
        .strip_prefix("wss://")
        .or_else(|| lowered.strip_prefix("ws://"))
    else {
        return false;
    };
    let Some(rest) = rest
        .strip_prefix("127.0.0.1")
        .or_else(|| rest.strip_prefix("localhost"))
    else {
        return false;
    };
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    match rest.strip_prefix(':') {
        Some(digits) => !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()),
        None => rest.is_empty(),
    }
}

/// `/^wss?:\/\/[^\s/]+/i`
fn looks_like_obs_address(address: &str) -> bool {
    let lowered = address.to_ascii_lowercase();
    let Some(at) = ["wss://", "ws://"]
        .iter()
        .find(|scheme| lowered.starts_with(**scheme))
        .map(|scheme| scheme.len())
    else {
        return false;
    };
    address[at..]
        .chars()
        .next()
        .is_some_and(|first| first != '/' && !js::is_space(first))
}

/// How long text is to JavaScript (`.length`).
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

// ------------------------------------------------------------------ routes

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Access {
    Public,
    Deck,
    Local,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Route {
    Hello,
    Languages,
    Claim,
    Pair,
    NewCode,
    PairQr,
    RemoveDevice,
    Events,
    Status,
    GetLibrary,
    PutLibrary,
    GetSettings,
    PutSettings,
    Press,
    Volume,
    VolumeSync,
    Sounds,
    PutSound,
    DeleteSound,
    SoundFile,
    SoundPreview,
    SoundsStop,
    Apps,
    AudioApps,
    OpenDeck,
    OpenSupport,
    ObsNames,
    ObsDetect,
    GoogleIcons,
    GoogleGlyph,
    Traces,
    Shutdown,
}

struct Found {
    route: Route,
    access: Access,
    /// How large a signed body may be, when more than JSON_LIMIT.
    body_limit: usize,
    /// What the address named: a device id, a sound slot.
    param: String,
}

/// The slot in "/api/sounds/<1-8><suffix>".
fn sound_slot<'a>(pathname: &'a str, suffix: &str) -> Option<&'a str> {
    let slot = pathname
        .strip_prefix("/api/sounds/")?
        .strip_suffix(suffix)?;
    matches!(slot, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8").then_some(slot)
}

/// The id in "/api/devices/dev_<hex>".
fn device_id(pathname: &str) -> Option<&str> {
    let id = pathname.strip_prefix("/api/devices/")?;
    let hex = id.strip_prefix("dev_")?;
    (!hex.is_empty()
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
    .then_some(id)
}

fn match_route(method: &str, pathname: &str) -> Option<Found> {
    use Access::{Deck, Local, Public};
    let found = |route, access| Found {
        route,
        access,
        body_limit: JSON_LIMIT,
        param: String::new(),
    };
    let with = |route, access, param: &str| Found {
        route,
        access,
        body_limit: JSON_LIMIT,
        param: param.to_string(),
    };
    Some(match (method, pathname) {
        // --- pairing
        // Public on purpose: the clock for signatures, and colours for the pairing screen.
        ("GET", "/api/hello") => found(Route::Hello, Public),
        // The picker's list: whatever files public/locales holds right now.
        ("GET", "/api/languages") => found(Route::Languages, Deck),
        ("POST", "/api/pair/claim") => found(Route::Claim, Public),
        ("GET", "/api/pair") => found(Route::Pair, Local),
        ("POST", "/api/pair/new-code") => found(Route::NewCode, Local),
        ("GET", "/api/pair-qr.svg") => found(Route::PairQr, Local),
        // --- live state
        ("GET", "/api/events") => found(Route::Events, Deck),
        ("GET", "/api/status") => found(Route::Status, Deck),
        // --- the deck library
        ("GET", "/api/library") => found(Route::GetLibrary, Deck),
        ("PUT", "/api/library") => found(Route::PutLibrary, Local),
        // --- settings
        ("GET", "/api/settings") => found(Route::GetSettings, Deck),
        ("PUT", "/api/settings") => found(Route::PutSettings, Local),
        // --- pressing: the server runs the saved button, never steps from the request
        ("POST", "/api/press") => found(Route::Press, Deck),
        // --- faders, also looked up from the saved deck
        ("POST", "/api/volume") => found(Route::Volume, Deck),
        // Reads the real levels (OBS, the computer, apps) for every fader in a profile.
        ("POST", "/api/volume/sync") => found(Route::VolumeSync, Deck),
        // --- sounds
        ("GET", "/api/sounds") => found(Route::Sounds, Local),
        ("POST", "/api/sounds/stop") => found(Route::SoundsStop, Deck),
        ("GET", "/api/apps") => found(Route::Apps, Local),
        // The apps an App volume fader can control, for the Control Center's picker.
        ("GET", "/api/apps/audio") => found(Route::AudioApps, Local),
        // The desktop app's window opens no new tabs: Open deck asks for the deck in
        // this computer's own browser instead.
        ("POST", "/api/open-deck") => found(Route::OpenDeck, Local),
        // Ko-fi, in the computer's browser: the desktop app's window opens no tabs.
        // Only this one address, so the route cannot be used to open anything else.
        ("POST", "/api/open-support") => found(Route::OpenSupport, Local),
        // Scene, source, input and filter names for the Control Center's pickers.
        ("GET", "/api/obs/names") => found(Route::ObsNames, Local),
        // Takes over OBS's own settings from this computer; nothing to copy.
        ("POST", "/api/obs/detect") => found(Route::ObsDetect, Local),
        // --- Google icons, browsed from the Control Center only
        ("GET", "/api/icons/google") => found(Route::GoogleIcons, Local),
        ("GET", "/api/icons/google/glyph") => found(Route::GoogleGlyph, Local),
        // --- trackpad traces: a deck in debug mode keeps its last 30 s for the touchpad tests
        ("POST", "/api/trackpad/traces") => Found {
            body_limit: TRACE_LIMIT,
            ..found(Route::Traces, Deck)
        },
        ("POST", "/api/shutdown") => found(Route::Shutdown, Local),
        ("DELETE", _) if device_id(pathname).is_some() => {
            with(Route::RemoveDevice, Local, device_id(pathname)?)
        }
        ("PUT", _) if sound_slot(pathname, "").is_some() => {
            with(Route::PutSound, Local, sound_slot(pathname, "")?)
        }
        // Puts a slot back to the generated tone it shipped with.
        ("DELETE", _) if sound_slot(pathname, "").is_some() => {
            with(Route::DeleteSound, Local, sound_slot(pathname, "")?)
        }
        ("GET", _) if sound_slot(pathname, "/file").is_some() => {
            with(Route::SoundFile, Local, sound_slot(pathname, "/file")?)
        }
        // Previews play the same way a deck press does, through this computer's speakers.
        ("POST", _) if sound_slot(pathname, "/preview").is_some() => with(
            Route::SoundPreview,
            Local,
            sound_slot(pathname, "/preview")?,
        ),
        _ => return None,
    })
}

/// The pages by their address (`PAGES`).
fn page_of(pathname: &str) -> Option<&'static str> {
    match pathname {
        "/" | "/deck" => Some("deck.html"),
        "/designer" => Some("designer.html"),
        "/pair" => Some("pair.html"),
        _ => None,
    }
}

/// The file in "/locales/<name>.json": `/^\/locales\/([^/]+\.json)$/`.
fn locale_name(pathname: &str) -> Option<&str> {
    let name = pathname.strip_prefix("/locales/")?;
    (!name.contains('/') && name.len() > ".json".len() && name.ends_with(".json")).then_some(name)
}

// ------------------------------------------------------------------- QR codes

/// How bad a masked code looks, as qrcode-terminal's encoder (Kazuhiko
/// Arase's) scores it. Its rules are not quite the standard's, so the mask it
/// picks is not always the one another encoder would.
fn arase_lost_point(dark: &[bool], size: usize) -> f64 {
    let at = |row: usize, column: usize| dark[row * size + column];
    let mut lost = 0.0;
    // Modules among same-coloured neighbours.
    for row in 0..size {
        for column in 0..size {
            let mut same = 0;
            for near_row in row.saturating_sub(1)..=(row + 1).min(size - 1) {
                for near_column in column.saturating_sub(1)..=(column + 1).min(size - 1) {
                    if (near_row, near_column) != (row, column)
                        && at(near_row, near_column) == at(row, column)
                    {
                        same += 1;
                    }
                }
            }
            if same > 5 {
                lost += f64::from(3 + same - 5);
            }
        }
    }
    // Blocks of one colour.
    for row in 0..size - 1 {
        for column in 0..size - 1 {
            let count = [
                at(row, column),
                at(row + 1, column),
                at(row, column + 1),
                at(row + 1, column + 1),
            ]
            .iter()
            .filter(|dark| **dark)
            .count();
            if count == 0 || count == 4 {
                lost += 3.0;
            }
        }
    }
    // What looks like a finder pattern, along rows and columns.
    const FINDER: [bool; 7] = [true, false, true, true, true, false, true];
    for line in 0..size {
        for start in 0..size - 6 {
            if (0..7).all(|step| at(line, start + step) == FINDER[step]) {
                lost += 40.0;
            }
            if (0..7).all(|step| at(start + step, line) == FINDER[step]) {
                lost += 40.0;
            }
        }
    }
    // Far from half dark.
    let dark_count = dark.iter().filter(|dark| **dark).count() as f64;
    let ratio = (100.0 * dark_count / size as f64 / size as f64 - 50.0).abs() / 5.0;
    lost + ratio * 10.0
}

/// The modules of a code holding `text` as bytes at the lowest error
/// correction, in the smallest size it fits, under the mask qrcode-terminal's
/// own encoder picked: row by row, true where dark.
fn terminal_code(text: &str) -> Option<(usize, Vec<bool>)> {
    use qrcode::bits::Bits;
    use qrcode::canvas::{Canvas, MaskPattern};
    use qrcode::{EcLevel, Version};
    let (version, data) = (1..=40i16).find_map(|number| {
        let version = Version::Normal(number);
        let mut bits = Bits::new(version);
        bits.push_byte_data(text.as_bytes()).ok()?;
        bits.push_terminator(EcLevel::L).ok()?;
        Some((version, bits.into_bytes()))
    })?;
    let (encoded, correction) = qrcode::ec::construct_codewords(&data, version, EcLevel::L).ok()?;
    let mut canvas = Canvas::new(version, EcLevel::L);
    canvas.draw_all_functional_patterns();
    canvas.draw_data(&encoded, &correction);
    let size = version.width() as usize;
    // That encoder scores each mask with the format and version modules
    // left light, and the module that is always dark too.
    let mut blank: Vec<(usize, usize)> = vec![(size - 8, 8)];
    for bit in 0..15 {
        blank.push(match bit {
            0..=5 => (bit, 8),
            6 | 7 => (bit + 1, 8),
            _ => (size - 15 + bit, 8),
        });
        blank.push(match bit {
            0..=7 => (8, size - bit - 1),
            8 => (8, 7),
            _ => (8, 14 - bit),
        });
    }
    if size >= 45 {
        for bit in 0..18 {
            blank.push((bit / 3, bit % 3 + size - 11));
            blank.push((bit % 3 + size - 11, bit / 3));
        }
    }
    let patterns = [
        MaskPattern::Checkerboard,
        MaskPattern::HorizontalLines,
        MaskPattern::VerticalLines,
        MaskPattern::DiagonalLines,
        MaskPattern::LargeCheckerboard,
        MaskPattern::Fields,
        MaskPattern::Diamonds,
        MaskPattern::Meadow,
    ];
    let mut best: Option<(f64, Vec<bool>)> = None;
    for pattern in patterns {
        let mut masked = canvas.clone();
        masked.apply_mask(pattern);
        let dark: Vec<bool> = masked
            .into_colors()
            .into_iter()
            .map(|color| color == qrcode::Color::Dark)
            .collect();
        let mut scored = dark.clone();
        for (row, column) in &blank {
            scored[row * size + column] = false;
        }
        let lost = arase_lost_point(&scored, size);
        if best.as_ref().is_none_or(|(least, _)| *least > lost) {
            best = Some((lost, dark));
        }
    }
    best.map(|(_, dark)| (size, dark))
}

/// A QR code for a terminal, two rows of modules to a line, as
/// `qrcodeTerminal.generate(text, { small: true })` drew it.
pub fn terminal_qr(text: &str) -> Option<String> {
    let (size, dark) = terminal_code(text)?;
    let is_dark = |row: usize, column: usize| row < size && dark[row * size + column];
    let mut out = "\u{2584}".repeat(size + 2);
    out.push('\n');
    for row in (0..size).step_by(2) {
        out.push('\u{2588}');
        for column in 0..size {
            out.push(match (is_dark(row, column), is_dark(row + 1, column)) {
                (false, false) => '\u{2588}',
                (false, true) => '\u{2580}',
                (true, false) => '\u{2584}',
                (true, true) => ' ',
            });
        }
        out.push_str("\u{2588}\n");
    }
    // A code has an odd number of rows, so its last line is half white
    // already; an even one would get a border of its own.
    if size % 2 == 0 {
        out.push_str(&"\u{2580}".repeat(size + 2));
    }
    Some(out)
}

/// How a stretch of text is written into a QR code.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum QrMode {
    Numeric,
    Alphanumeric,
    Byte,
}

impl QrMode {
    fn holds(self, byte: u8) -> bool {
        match self {
            QrMode::Numeric => byte.is_ascii_digit(),
            QrMode::Alphanumeric => {
                byte.is_ascii_digit() || byte.is_ascii_uppercase() || b" $%*+-./:".contains(&byte)
            }
            QrMode::Byte => true,
        }
    }

    /// The bits a stretch of `length` characters takes, with its header, in
    /// a code of the given size class (0: versions 1 to 9, 1: 10 to 26, 2: 27 to 40).
    fn bits(self, length: usize, class: usize) -> usize {
        match self {
            QrMode::Numeric => 4 + [10, 12, 14][class] + 10 * (length / 3) + [0, 4, 7][length % 3],
            QrMode::Alphanumeric => 4 + [9, 11, 13][class] + 11 * (length / 2) + 6 * (length % 2),
            QrMode::Byte => 4 + [8, 16, 16][class] + 8 * length,
        }
    }
}

/// The shortest way to write `text` into a code of a size class: stretches of
/// digits, of capital letters and digits, and of anything, and the bits they
/// take together. (The "qrcode" package looked for the shortest too, which
/// is what keeps the pairing code as small as it drew it.)
fn qr_segments(text: &[u8], class: usize) -> (usize, Vec<(QrMode, usize, usize)>) {
    // best[end]: the fewest bits for the text up to `end`, and the stretch it ends with.
    let mut best: Vec<(usize, Option<(QrMode, usize)>)> = vec![(0, None)];
    for end in 1..=text.len() {
        let mut least: (usize, Option<(QrMode, usize)>) = (usize::MAX, None);
        for mode in [QrMode::Numeric, QrMode::Alphanumeric, QrMode::Byte] {
            let mut start = end;
            while start > 0 && mode.holds(text[start - 1]) {
                start -= 1;
                let bits = best[start].0 + mode.bits(end - start, class);
                if bits < least.0 {
                    least = (bits, Some((mode, start)));
                }
            }
        }
        best.push(least);
    }
    let mut segments = Vec::new();
    let mut end = text.len();
    while let Some((mode, start)) = best[end].1 {
        segments.push((mode, start, end));
        end = start;
    }
    segments.reverse();
    (best[text.len()].0, segments)
}

/// A code at error correction M in the smallest size the text fits.
fn pair_code(text: &str) -> Option<qrcode::QrCode> {
    use qrcode::bits::Bits;
    use qrcode::{EcLevel, Version};
    let text = text.as_bytes();
    for (class, versions) in [(0, 1..=9i16), (1, 10..=26), (2, 27..=40)] {
        let (_, segments) = qr_segments(text, class);
        for number in versions {
            let mut bits = Bits::new(Version::Normal(number));
            let pushed = segments.iter().try_for_each(|(mode, start, end)| {
                let part = &text[*start..*end];
                match mode {
                    QrMode::Numeric => bits.push_numeric_data(part),
                    QrMode::Alphanumeric => bits.push_alphanumeric_data(part),
                    QrMode::Byte => bits.push_byte_data(part),
                }
            });
            if pushed.is_err() || bits.push_terminator(EcLevel::M).is_err() {
                continue;
            }
            return qrcode::QrCode::with_bits(bits, EcLevel::M).ok();
        }
    }
    None
}

/// The pairing window's QR code as an SVG: error correction M, a margin of
/// one module, in the shape the "qrcode" package drew it.
pub fn pair_qr_svg(text: &str) -> Option<String> {
    let code = pair_code(text)?;
    let size = code.width();
    let dark = code.to_colors();
    let whole = size + 2;
    let mut path = String::new();
    for row in 0..size {
        let mut column = 0;
        while column < size {
            if dark[row * size + column] != qrcode::Color::Dark {
                column += 1;
                continue;
            }
            let start = column;
            while column < size && dark[row * size + column] == qrcode::Color::Dark {
                column += 1;
            }
            path.push_str(&format!("M{} {}.5h{}", start + 1, row + 1, column - start));
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {whole} {whole}\" shape-rendering=\"crispEdges\"><path fill=\"#ffffff\" d=\"M0 0h{whole}v{whole}H0z\"/><path stroke=\"#000000\" d=\"{path}\"/></svg>\n"
    ))
}

// ---------------------------------------------------------------- the build

fn base36(mut number: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(number % 36) as usize] as char);
        number /= 36;
        if number == 0 {
            break;
        }
    }
    out.iter().rev().collect()
}

// The page bundles' modification times name the build. When they change
// (an update, or a rebuild while developing) every open page finds out.
fn current_build(public_dir: &Path) -> String {
    ["deck.js", "designer.js", "pair.js", "tour.js"]
        .iter()
        .map(|name| {
            let modified = std::fs::metadata(public_dir.join("js").join(name))
                .and_then(|stats| stats.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok());
            match modified {
                // Math.round(mtimeMs).toString(36)
                Some(since) => {
                    let ms = since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6;
                    base36((ms + 0.5).floor() as u64)
                }
                None => "0".to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

// ------------------------------------------------------------------- state

/// What goes out on a trackpad's socket.
enum ToPointer {
    Notice(String),
    Close,
}

/// An open trackpad.
struct PointerSocket {
    /// Its device id ("" for this computer).
    device: String,
    /// The language it asked in when it connected, for its notices.
    language: String,
    out: mpsc::UnboundedSender<ToPointer>,
}

type PointerSockets = Arc<Mutex<HashMap<PointerOwner, PointerSocket>>>;

/// Everything the companion holds while it runs.
pub struct App {
    public_dir: PathBuf,
    version: String,
    /// Run by the desktop app (Tauri) rather than from a terminal.
    desktop: bool,
    config: Arc<Mutex<Config>>,
    /// PUNCHBOARD_PORT overrides the saved port for this run only (used by tests).
    port_override: u16,
    /// The port actually listened on, settled at start-up (see claim_port).
    port: AtomicU16,
    // A fader drag sends several levels a second; the file only needs the last.
    config_timer: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    library: Arc<LibraryStore>,
    ids: Ids,
    /// Two-state macros running right now ("<profile id>\n<button id>"); see /api/press.
    busy_switches: Mutex<HashSet<String>>,
    auth: Auth,
    sounds: Arc<SoundStore>,
    build: Arc<Mutex<String>>,
    player: Player,
    live: Live,
    app_levels: AppLevels,
    obs_state: ObsState,
    obs: ObsLink,
    audio: Arc<Audio>,
    google_icons: GoogleIcons,
    // Host names change when the wifi does, so they are refreshed every few
    // seconds rather than fixed at start-up.
    host_cache: Mutex<Option<(Instant, Arc<HashSet<String>>)>>,
    pointer: Pointer,
    pointer_sockets: PointerSockets,
    /// What stands in for the computer when a test asked (see test_system.rs).
    recorded: Option<Arc<test_system::RecordedComputer>>,
    stopping: AtomicBool,
    stopped: tokio::sync::Notify,
}

/// Why the companion could not start.
#[derive(Debug)]
pub struct StartError(pub String);

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn obs_issue_of(config: &Mutex<Config>, obs: &ObsLink) -> Option<ObsIssue> {
    let issue = obs.issue();
    let address = lock(config).obs.address.clone();
    if obs.status() == LinkStatus::Connected
        || issue == Some(ObsIssue::WrongPassword)
        || !is_local_obs_address(&address)
    {
        return issue;
    }
    let local = read_local_obs();
    if local.found && !local.enabled {
        Some(ObsIssue::ServerOff)
    } else {
        issue
    }
}

fn local_address(local: &LocalObs) -> String {
    format!("ws://127.0.0.1:{}", js::number_to_string(local.port))
}

impl App {
    /// Reads everything from the data folder and wires the parts together
    /// (the top of main.ts). Must be called inside the runtime.
    pub fn open() -> Result<Arc<App>, StartError> {
        let paths = paths();
        let failed = |error: &dyn std::fmt::Display| StartError(error.to_string());
        migrate_legacy_data(&mut |line| log(line)).map_err(|error| failed(&error))?;
        let config = Arc::new(Mutex::new(load_config(&paths.config, &mut |line| {
            log(line)
        })));
        // Replies are worded in this language, or each asker's own under "auto".
        {
            let config = config.clone();
            use_language_setting(move || lock(&config).language.clone());
        }
        let port_override = std::env::var("PUNCHBOARD_PORT")
            .ok()
            .map(|port| js_to_number(&port))
            .filter(|port| port.fract() == 0.0 && (1.0..=65535.0).contains(port))
            .map_or(0, |port| port as u16);

        let ids = Ids::new(now_ms);
        let library = Arc::new(LibraryStore::open(
            &paths.library,
            log,
            &translator(&system_language()),
            &ids,
        ));
        let auth = Auth::open(&paths.devices, log).map_err(|error| failed(&error))?;
        let sounds = Arc::new(SoundStore::new(&paths.sounds));
        if let Err(error) = sounds.ensure_defaults() {
            log(&format!(
                "The built-in sounds could not be written: {error}"
            ));
        }
        let public_dir = resolve(&paths.public);
        let build = Arc::new(Mutex::new(current_build(&public_dir)));
        let test_folder = test_system::folder();

        // The parts know each other: the player tells the live state when a
        // sound ends, the live state reads OBS's status, OBS tells the live
        // state. Each is handed a place the other is put in once it is made.
        let live_slot: Arc<OnceLock<Live>> = Arc::new(OnceLock::new());
        let obs_slot: Arc<OnceLock<ObsLink>> = Arc::new(OnceLock::new());
        let levels_slot: Arc<OnceLock<AppLevels>> = Arc::new(OnceLock::new());

        // Sounds play from this process. A sound whose length could not be
        // read from its file learns it from a full play.
        let player_options = {
            let (config, sounds, live) = (config.clone(), sounds.clone(), live_slot.clone());
            PlayerOptions {
                volume: Box::new(move || lock(&config).sound_volume),
                on_ended: Box::new(move |slot, ran_ms| {
                    let Some(live) = live.get() else {
                        return;
                    };
                    if let Some(ran_ms) = ran_ms {
                        if sounds.duration_ms(slot).is_none()
                            && sounds.set_duration(slot, ran_ms as f64).unwrap_or(false)
                        {
                            live.sounds_changed();
                        }
                    }
                    live.sound_ended(slot);
                }),
                log: Box::new(log),
                idle_close: IDLE_CLOSE,
            }
        };
        let player = match &test_folder {
            Some(folder) => Player::with_output(player_options, test_system::sound_output(folder)),
            None => Player::new(player_options),
        };

        let live = {
            let (accent, theme, language) = (config.clone(), config.clone(), config.clone());
            let (library_rev, build_now) = (library.clone(), build.clone());
            let (obs, issue_obs, issue_config) =
                (obs_slot.clone(), obs_slot.clone(), config.clone());
            let (durations, files) = (sounds.clone(), sounds.clone());
            let levels = levels_slot.clone();
            Live::new(
                LiveSettings {
                    accent: Box::new(move || lock(&accent).theme.accent.clone()),
                    theme: Box::new(move || lock(&theme).theme.name.clone()),
                    language: Box::new(move || lock(&language).language.clone()),
                    library_rev: Box::new(move || library_rev.revision()),
                    build: Box::new(move || lock(&build_now).clone()),
                    obs: Box::new(move || obs.get().map_or(LinkStatus::Unset, ObsLink::status)),
                    obs_issue: Box::new(move || {
                        issue_obs
                            .get()
                            .and_then(|obs| obs_issue_of(&issue_config, obs))
                    }),
                    sound_duration: Box::new(move |slot| durations.duration_ms(slot)),
                    sound_file: Box::new(move |slot| files.file(slot).file),
                    devices_changed: Box::new(move || {
                        if let Some(levels) = levels.get() {
                            levels.update();
                        }
                    }),
                },
                player.clone(),
                lock(&config).sound_volume,
            )
        };
        let _ = live_slot.set(live.clone());

        let audio = Arc::new(match &test_folder {
            Some(folder) => test_system::audio(folder),
            None => Audio::for_this_computer(),
        });
        // App volumes (Spotify's own slider, the Windows mixer) change without telling
        // anyone, so they are read every few seconds while a device is connected.
        let app_levels = {
            let (decks, watched_audio, watched_live) =
                (library.clone(), audio.clone(), live.clone());
            let (read_audio, set, dropped) = (audio.clone(), live.clone(), live.clone());
            create_app_levels(AppLevelsOptions {
                library: Box::new(move || decks.get()),
                watched: Box::new(move || watched_audio.apps.live() && watched_live.has_devices()),
                read: Box::new(move |key| read_audio.apps.read(key)),
                set_levels: Box::new(move |levels| set.set_levels(&levels)),
                drop_levels: Box::new(move |keys| dropped.drop_levels(&keys)),
                interval: None,
            })
        };
        let _ = levels_slot.set(app_levels.clone());

        // What OBS is doing (live scene, mutes, stream…), followed from its events.
        let obs_state = {
            let (decks, toggles, levels, dropped) =
                (library.clone(), live.clone(), live.clone(), live.clone());
            ObsState::new(ObsStateOptions {
                library: Box::new(move || decks.get()),
                set_toggles: Box::new(move |changes| toggles.set_toggles(&changes)),
                set_levels: Box::new(move |changes| levels.set_levels(&changes)),
                drop_levels: Box::new(move |keys| dropped.drop_levels(&keys)),
            })
        };
        // Meters are only read for OBS inputs that a fader on a connected page shows.
        let obs = {
            let settings = config.clone();
            let (attached, detached) = (obs_state.clone(), obs_state.clone());
            let (status_live, meters_live, wanted_live) =
                (live.clone(), live.clone(), live.clone());
            let decks = library.clone();
            ObsLink::new(ObsLinkOptions {
                settings: Box::new(move || {
                    let config = lock(&settings);
                    ObsSettings {
                        address: config.obs.address.clone(),
                        password: config.obs.password.clone(),
                    }
                }),
                log: Box::new(log),
                on_connected: Box::new(move |socket| attached.attach(socket)),
                on_status: Box::new(move |link| {
                    // Whatever OBS reported stops being true the moment it goes away.
                    if link.status() != LinkStatus::Connected {
                        detached.detach();
                        status_live.clear_toggles();
                        status_live.clear_obs_levels();
                    }
                    status_live.broadcast();
                }),
                on_meters: Box::new(move |levels| meters_live.broadcast_meters(&levels)),
                wanted_inputs: Box::new(move || {
                    let mut wanted = HashSet::new();
                    if !wanted_live.has_listeners() {
                        return wanted;
                    }
                    for profile in &decks.get().profiles {
                        for button in &profile.buttons {
                            if let Some(fader) = button.fader() {
                                if fader.target == FaderTarget::ObsInput
                                    && !fader.input_name.is_empty()
                                {
                                    wanted.insert(fader.input_name.clone());
                                }
                            }
                        }
                    }
                    wanted
                }),
                dial: network(),
            })
        };
        let _ = obs_slot.set(obs.clone());

        {
            let mut settings = lock(&config);
            // Settings typed in by hand that match this computer's OBS are really OBS's
            // own, so they follow OBS from now on.
            if settings.obs.source == ObsSource::Manual
                && is_local_obs_address(&settings.obs.address)
            {
                let local = read_local_obs();
                if local.found && settings.obs.password == local.password {
                    settings.obs.source = ObsSource::Auto;
                }
            }
            // Unless someone typed their own settings, follow OBS's: a new password or
            // port in OBS is picked up on the next start without anyone noticing.
            if settings.obs.source == ObsSource::Auto {
                let local = read_local_obs();
                let address = local_address(&local);
                if local.found
                    && (settings.obs.password != local.password || settings.obs.address != address)
                {
                    settings.obs.address = address;
                    settings.obs.password = local.password;
                    if let Err(error) = save_config(&paths.config, &settings) {
                        log(&format!("The settings could not be saved: {error}"));
                    }
                    log("Using OBS's WebSocket settings from this computer.");
                }
            }
        }

        // --- trackpad decks: finger movement over a WebSocket, dozens of messages a
        // second, each too small to be worth its own signed request. The connection
        // is signed once, like the live stream, and held to the same Host and Origin
        // rules as every request.
        let pointer_sockets: PointerSockets = Arc::new(Mutex::new(HashMap::new()));
        let pointer = {
            let sockets = pointer_sockets.clone();
            Pointer::new(PointerOptions {
                log: Box::new(log),
                on_problem: Box::new(move |message: Text| {
                    for socket in lock(&sockets).values() {
                        let notice = json!({ "error": render(&Said::Text(message.clone()), &socket.language) });
                        let _ = socket.out.send(ToPointer::Notice(stringify(&notice)));
                    }
                }),
            })
        };

        Ok(Arc::new(App {
            public_dir,
            version: app_version(),
            desktop: std::env::var("PUNCHBOARD_DESKTOP").is_ok_and(|value| value == "1"),
            port_override,
            port: AtomicU16::new(0),
            config,
            config_timer: Arc::new(Mutex::new(None)),
            library,
            ids,
            busy_switches: Mutex::new(HashSet::new()),
            auth,
            sounds,
            build,
            player,
            live,
            app_levels,
            obs_state,
            obs,
            audio,
            google_icons: GoogleIcons::new(&paths.cache),
            host_cache: Mutex::new(None),
            pointer,
            pointer_sockets,
            recorded: test_folder
                .as_deref()
                .map(|folder| Arc::new(test_system::RecordedComputer::new(folder))),
            stopping: AtomicBool::new(false),
            stopped: tokio::sync::Notify::new(),
        }))
    }

    fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    fn write_config(&self) -> std::io::Result<()> {
        let config = lock(&self.config).clone();
        save_config(&paths().config, &config)
    }

    fn write_config_soon(&self) {
        let (config, waiting) = (self.config.clone(), self.config_timer.clone());
        let mut timer = lock(&self.config_timer);
        if let Some(earlier) = timer.take() {
            earlier.abort();
        }
        *timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            lock(&waiting).take();
            let config = lock(&config).clone();
            if let Err(error) = save_config(&paths().config, &config) {
                log(&format!("The settings could not be saved: {error}"));
            }
        }));
    }

    /// Writes a pending debounced save now, so quitting never loses it.
    fn flush_config(&self) {
        let Some(waiting) = lock(&self.config_timer).take() else {
            return;
        };
        waiting.abort();
        if let Err(error) = self.write_config() {
            log(&format!("The settings could not be saved: {error}"));
        }
    }

    fn hostnames(&self) -> Arc<HashSet<String>> {
        let mut cache = lock(&self.host_cache);
        match &*cache {
            Some((at, names)) if at.elapsed() <= Duration::from_millis(5000) => names.clone(),
            _ => {
                let names = Arc::new(own_hostnames());
                *cache = Some((Instant::now(), names.clone()));
                names
            }
        }
    }

    fn host_allowed(&self, headers: &HeaderMap) -> bool {
        let host = headers.get("host").and_then(|host| host.to_str().ok());
        host_allowed(host, &self.hostnames(), self.port())
    }

    /// Points the OBS link at an OBS on this computer, from its own settings.
    fn apply_local_obs(&self, local: &LocalObs) -> std::io::Result<bool> {
        {
            let mut config = lock(&self.config);
            config.obs.address = local_address(local);
            config.obs.password = local.password.clone();
            config.obs.source = ObsSource::Auto;
        }
        self.write_config()?;
        self.obs.reset();
        Ok(true)
    }

    fn deck_url(&self) -> String {
        format!("http://{}:{}", get_local_ipv4(), self.port())
    }

    // The code travels in the hash, which browsers never send to a server or put
    // in a Referer.
    fn pair_url(&self) -> std::io::Result<String> {
        Ok(format!(
            "{}/deck#pair={}",
            self.deck_url(),
            self.auth.current_code()?.code
        ))
    }

    /// Opens an address in this computer's browser (the "open" package).
    async fn open_address(&self, address: &str) -> Result<(), Wrong> {
        match &self.recorded {
            Some(recorded) => apps::open_url_with(recorded.as_ref(), address),
            None => apps::open_url(address).await,
        }
    }

    /// The paired device a request is signed by, or None for this computer.
    async fn require_deck(
        &self,
        ask: &mut Ask,
        body_limit: usize,
    ) -> Result<Option<Device>, HttpError> {
        if is_loopback(&ask.remote) {
            return Ok(None);
        }
        let pathname = ask.url.path().to_string();
        // EventSource and WebSocket cannot send headers, so streams are signed in their address.
        let signed = if pathname == "/api/events" || pathname == "/api/pointer" {
            Signed {
                device: ask.query("d"),
                time: ask.query("t"),
                nonce: ask.query("n"),
                signature: ask.query("s"),
            }
        } else {
            Signed {
                device: ask.header("x-punchboard-device"),
                time: ask.header("x-punchboard-time"),
                nonce: ask.header("x-punchboard-nonce"),
                signature: ask.header("x-punchboard-signature"),
            }
        };
        let refuse = |text: Text, code: &str| {
            HttpError::new(401, text)
                .with("code", code)
                .with("serverTime", now_ms())
        };
        // A request that is not signed by a paired device is refused before its
        // body is read: nobody unpaired gets to make the companion take in a megabyte.
        let paired = signed
            .device
            .as_deref()
            .is_some_and(|device| !device.is_empty() && self.auth.has(device));
        if !paired {
            return Err(refuse(say("server.auth.unpaired"), "unpaired"));
        }
        let shaped = |value: &Option<String>, least: usize, most: usize, hex: bool| {
            let text = value.as_deref().unwrap_or("");
            (least..=most).contains(&text.len())
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (hex && (b'a'..=b'f').contains(&byte)))
        };
        if !shaped(&signed.time, 1, 16, false)
            || !shaped(&signed.nonce, 16, 64, true)
            || !shaped(&signed.signature, 64, 64, true)
        {
            return Err(refuse(say("server.auth.unsigned"), "bad_signature"));
        }
        let method = ask.method.as_str().to_string();
        let body = if method == "GET" || method == "HEAD" {
            String::new()
        } else {
            String::from_utf8_lossy(&ask.raw_body(body_limit).await?).into_owned()
        };
        self.auth
            .verify(&signed, &method, &pathname, &body, Some(&ask.remote))
            .map(Some)
            .map_err(|error| refuse(error.text().clone(), error.code().as_str()))
    }

    // ---------------------------------------------------------------- routes

    async fn respond(self: &Arc<Self>, ask: &mut Ask) -> Result<Response, Failure> {
        let method = ask.method.as_str().to_string();
        if !self.host_allowed(&ask.headers) {
            return Err(refused(403, "server.request.wrongHost").into());
        }
        let host = ask.header("host");
        if method != "GET"
            && method != "HEAD"
            && !origin_allowed(ask.header("origin").as_deref(), host.as_deref())
        {
            return Err(refused(403, "server.request.otherSite").into());
        }
        let pathname = ask.url.path().to_string();

        if pathname.starts_with("/api/") {
            let Some(found) = match_route(&method, &pathname) else {
                return Err(refused(404, "server.request.notFound").into());
            };
            if found.access == Access::Local && !is_loopback(&ask.remote) {
                let address = format!("http://localhost:{}", self.port());
                return Err(HttpError::new(
                    403,
                    say("server.request.localOnly").with("address", address),
                )
                .into());
            }
            let device = if found.access == Access::Deck {
                self.require_deck(ask, found.body_limit).await?
            } else {
                None
            };
            return self.route(found, ask, device).await;
        }

        // The locale files come from the locales folder, the same one
        // /api/languages lists (public/locales, unless a test points it elsewhere).
        if let Some(name) = locale_name(&pathname) {
            let file = locale_file(locales_dir(), name)?;
            return Ok(static_file(&file, Some(&ask.headers)).await);
        }
        let relative = match page_of(&pathname) {
            Some(page) => page,
            None => pathname.trim_start_matches('/'),
        };
        let file = public_file(&self.public_dir, relative)?;
        Ok(static_file(&file, Some(&ask.headers)).await)
    }

    async fn route(
        self: &Arc<Self>,
        found: Found,
        ask: &mut Ask,
        device: Option<Device>,
    ) -> Result<Response, Failure> {
        let ok = |body: Value| Ok(send_json(200, &body, &[]));
        let slot: Slot = found.param.parse().unwrap_or(1);
        match found.route {
            Route::Hello => {
                let config = lock(&self.config).clone();
                ok(json!({
                    "serverTime": now_ms(),
                    "accent": config.theme.accent,
                    "theme": config.theme.name,
                    "language": config.language,
                    "languages": language_codes(),
                }))
            }
            Route::Languages => ok(json!({ "languages": languages() })),
            Route::Claim => {
                let data = ask.json_body(JSON_LIMIT).await?;
                let name = match data.get("name").and_then(Value::as_str) {
                    Some(name) if !name.is_empty() => name.to_string(),
                    // A name for a device that did not give one, in the language of the
                    // pairing request: it is stored as it is, like any name typed in.
                    _ => {
                        let agent = ask.header("user-agent").unwrap_or_default();
                        let key = format!("server.device.{}", device_kind(&agent));
                        render(&say(&key).into(), &ask.language())
                    }
                };
                let code = data.get("code").cloned().unwrap_or(Value::Null);
                let device = match self.auth.claim(&code, &name, Some(&ask.remote)) {
                    Ok(device) => device,
                    Err(ClaimError::Refused(error)) => {
                        let status = if error.code() == AuthErrorCode::Locked {
                            429
                        } else {
                            400
                        };
                        return Err(HttpError::new(status, error.text().clone())
                            .with("code", error.code().as_str())
                            .into());
                    }
                    Err(ClaimError::Failed(error)) => return Err(error.into()),
                };
                // The code printed at start-up is used up; the pairing window shows the next one by itself.
                if !self.desktop {
                    log(&format!(
                        "The next device pairs with code {}, or the QR at http://localhost:{}/pair.",
                        self.auth.current_code()?.code,
                        self.port()
                    ));
                }
                ok(json!({
                    "device": { "id": device.id, "secret": device.secret, "name": device.name },
                    "serverTime": now_ms(),
                }))
            }
            Route::Pair => {
                let code = self.auth.current_code()?;
                ok(json!({
                    "deckUrl": self.deck_url(),
                    "pairUrl": self.pair_url()?,
                    "code": code.code,
                    "expiresAt": code.expires_at,
                    "devices": self.auth.list(),
                }))
            }
            Route::NewCode => {
                let code = self.auth.new_code()?;
                ok(
                    json!({ "code": code.code, "expiresAt": code.expires_at, "pairUrl": self.pair_url()? }),
                )
            }
            Route::PairQr => {
                let svg = pair_qr_svg(&self.pair_url()?).ok_or_else(|| {
                    Failure::Other(Box::new(SystemFailure(
                        "The pairing address does not fit a QR code.".to_string(),
                    )))
                })?;
                let mut response = Response::new(Body::from(svg));
                for (name, value) in SECURITY_HEADERS.into_iter().chain([
                    ("Content-Type", "image/svg+xml"),
                    ("Cache-Control", "no-store"),
                ]) {
                    set_header(&mut response, name, value);
                }
                Ok(response)
            }
            Route::RemoveDevice => {
                let id = found.param.as_str();
                if !self.auth.remove(id)? {
                    return Err(refused(404, "server.pair.noDevice").into());
                }
                self.live.disconnect_device(id);
                for socket in lock(&self.pointer_sockets).values() {
                    if socket.device == id {
                        let _ = socket.out.send(ToPointer::Close);
                    }
                }
                ok(json!({ "ok": true, "devices": self.auth.list() }))
            }

            // --- live state
            Route::Events => {
                let stream = self
                    .live
                    .open_stream(device.as_ref().map_or("", |device| device.id.as_str()));
                let mut response = Response::new(Body::from_stream(stream));
                for (name, value) in [
                    ("Content-Type", "text/event-stream; charset=utf-8"),
                    ("Cache-Control", "no-store, no-transform"),
                    ("Connection", "keep-alive"),
                    ("X-Accel-Buffering", "no"),
                ] {
                    set_header(&mut response, name, value);
                }
                Ok(response)
            }
            Route::Status => {
                let mut status = Map::new();
                status.insert("ok".to_string(), json!(true));
                if let Value::Object(snapshot) = self.live.snapshot() {
                    status.extend(snapshot);
                }
                ok(Value::Object(status))
            }

            // --- the deck library
            Route::GetLibrary => {
                let revision = self.library.revision().to_string();
                let mut headers = vec![("X-Library-Rev", revision.as_str())];
                // A damaged or too-new deck file, for the Control Center to explain once.
                let notice = self
                    .library
                    .notice()
                    .map(|notice| encode_uri_component(&render(&notice.into(), &ask.language())));
                if let Some(notice) = &notice {
                    headers.push(("X-Library-Notice", notice.as_str()));
                }
                Ok(send_json(200, &*self.library.get(), &headers))
            }
            Route::PutLibrary => {
                let data = Value::Object(ask.json_body(LIBRARY_LIMIT).await?);
                if !is_library_shape(&data) {
                    return Err(refused(400, "server.library.invalid").into());
                }
                // Every save names the revision it was edited from; one without it could
                // silently overwrite another window's work.
                let Some(base_rev) = ask.query("rev").filter(|rev| !rev.is_empty()) else {
                    return Err(refused(428, "server.library.noRev").into());
                };
                if js_to_number(&base_rev) != self.library.revision() as f64 {
                    return Err(HttpError::new(409, say("server.library.conflict"))
                        .with("libraryRev", self.library.revision())
                        .into());
                }
                let next = normalize_library(&data, &translator(&system_language()), &self.ids);
                let library_rev = self.library.save(next)?;
                self.live.broadcast();
                // New buttons may point at OBS states nobody was reading yet.
                self.obs_state.refresh();
                self.app_levels.update();
                ok(json!({ "ok": true, "libraryRev": library_rev }))
            }

            // --- settings
            Route::GetSettings => {
                let config = lock(&self.config).clone();
                ok(json!({
                    "accent": config.theme.accent,
                    "theme": config.theme.name,
                    "obsAddress": config.obs.address,
                    "obsConfigured": !config.obs.password.is_empty(),
                    "obsSource": config.obs.source,
                    "platform": PLATFORM,
                    "version": self.version,
                    "desktop": self.desktop,
                    "supportNote": !config.support_shown,
                    "tourNote": !config.tour_shown,
                    "language": config.language,
                }))
            }
            Route::PutSettings => {
                let data = ask.json_body(JSON_LIMIT).await?;
                let given = |name: &str| data.get(name);
                if given("accent")
                    .is_some_and(|accent| js::truthy(accent) && !is_hex_color_value(accent))
                {
                    return Err(refused(400, "server.settings.badColour").into());
                }
                if given("theme").is_some_and(|theme| !is_theme_id(theme)) {
                    return Err(refused(400, "server.settings.badTheme").into());
                }
                if given("language").is_some_and(|language| !is_language_setting(language)) {
                    return Err(refused(400, "server.settings.badLanguage").into());
                }
                // Checked before anything is saved, so a rejected address changes nothing
                // (and does not stop Punchboard following OBS's own settings).
                let obs_address = given("obsAddress")
                    .and_then(Value::as_str)
                    .map(|address| js::trim(address).to_string());
                if let Some(address) = obs_address.as_deref().filter(|address| !address.is_empty())
                {
                    if js_length(address) >= 160 || !looks_like_obs_address(address) {
                        return Err(refused(400, "server.settings.badObsAddress").into());
                    }
                }
                let obs_password = given("obsPassword").and_then(Value::as_str);
                let (obs_changed, language_changed, saved) = {
                    let mut config = lock(&self.config);
                    if let Some(accent) =
                        given("accent").filter(|accent| is_hex_color_value(accent))
                    {
                        config.theme.accent = accent.as_str().unwrap_or_default().to_string();
                    }
                    if let Some(theme) = given("theme").filter(|theme| is_theme_id(theme)) {
                        config.theme.name = theme.as_str().unwrap_or_default().to_string();
                    }
                    let obs_before = (config.obs.address.clone(), config.obs.password.clone());
                    if obs_address.is_some() || obs_password.is_some() {
                        config.obs.source = ObsSource::Manual;
                    }
                    if let Some(address) = &obs_address {
                        config.obs.address = address.clone();
                    }
                    if let Some(password) =
                        obs_password.filter(|password| js_length(password) < 500)
                    {
                        config.obs.password = password.to_string();
                    }
                    let obs_changed =
                        obs_before != (config.obs.address.clone(), config.obs.password.clone());
                    if given("supportShown") == Some(&Value::Bool(true)) {
                        config.support_shown = true;
                    }
                    if given("tourShown") == Some(&Value::Bool(true)) {
                        config.tour_shown = true;
                    }
                    let language = given("language")
                        .and_then(Value::as_str)
                        .filter(|language| *language != config.language)
                        .map(str::to_string);
                    let language_changed = language.is_some();
                    if let Some(language) = language {
                        config.language = language;
                    }
                    (obs_changed, language_changed, config.clone())
                };
                if obs_changed {
                    self.obs.reset();
                }
                if language_changed {
                    self.desktop_language();
                }
                self.write_config()?;
                self.live.broadcast();
                ok(json!({
                    "ok": true,
                    "accent": saved.theme.accent,
                    "theme": saved.theme.name,
                    "language": saved.language,
                }))
            }

            // --- pressing: the server runs the saved button, never steps from the request
            Route::Press => {
                let data = ask.json_body(JSON_LIMIT).await?;
                let text = |name: &str| data.get(name).and_then(Value::as_str);
                let button = match (text("profileId"), text("buttonId")) {
                    (Some(profile_id), Some(button_id)) => {
                        self.library.find_button(profile_id, button_id)
                    }
                    _ => None,
                };
                let Some(button) = button else {
                    return Err(refused(404, "server.press.noButton").into());
                };
                if button.is_fader() {
                    return Err(refused(400, "server.press.isFader").into());
                }
                // A two-state macro runs its first list when off and its second when on.
                let state_key = button_state_key(&button);
                let switch = is_switch(&button);
                // Its state is read now and flipped only when the list has run, so a
                // second press while the first runs (another device, another tab) would
                // read the same state and run the same list again. It is refused instead.
                let busy_key = switch
                    .then(|| format!("{}\n{}", text("profileId").unwrap_or_default(), button.id));
                if let Some(key) = &busy_key {
                    if lock(&self.busy_switches).contains(key) {
                        return Err(refused(409, "server.press.busy").into());
                    }
                }
                let switched_on = switch
                    && state_key
                        .as_deref()
                        .is_some_and(|key| self.live.toggle_value(key));
                let list = if switched_on {
                    button.off_steps.as_deref().unwrap_or(&[])
                } else {
                    &button.steps
                };
                let steps = prepare_steps(list)?;
                let outcome = {
                    let _busy = busy_key.map(|key| Busy::mark(self.clone(), key));
                    run_steps(&steps, self.as_ref()).await
                };
                let mut result =
                    outcome.map_err(|error| HttpError::new(400, text_of(error.as_ref())))?;
                match &state_key {
                    // Only a list that ran to the end flips the switch.
                    Some(key) if switch => {
                        result.active = Some(!switched_on);
                        self.live.set_toggles(&[(key.clone(), !switched_on)]);
                    }
                    // OBS reports the change as an event too; this just gets there first.
                    Some(key) => {
                        if let Some(active) = result.active {
                            self.live.set_toggles(&[(key.clone(), active)]);
                        }
                    }
                    None => {}
                }
                let mut response = Map::new();
                response.insert("ok".to_string(), json!(true));
                response.insert("tabletUrl".to_string(), json!(result.tablet_url));
                response.insert("deckId".to_string(), json!(result.deck_id));
                if let Some(active) = result.active {
                    response.insert("active".to_string(), json!(active));
                }
                // "Do nothing" steps (pauses) are not worth counting.
                let ran = steps
                    .iter()
                    .filter(|step| step.action != Action::None)
                    .count();
                if ran > 1 {
                    let message = say("server.press.ranSteps").with("count", ran as f64);
                    response.insert(
                        "message".to_string(),
                        json!(render(&message.into(), &ask.language())),
                    );
                }
                ok(Value::Object(response))
            }

            // --- faders, also looked up from the saved deck
            Route::Volume => {
                let data = ask.json_body(JSON_LIMIT).await?;
                // Checked first: a missing or non-numeric level must never reach a fader as 0.
                let level = data.get("level").cloned().unwrap_or(Value::Null);
                if !is_level(&level) {
                    return Err(refused(400, "server.volume.badLevel").into());
                }
                let text = |name: &str| data.get(name).and_then(Value::as_str);
                let button = match (text("profileId"), text("buttonId")) {
                    (Some(profile_id), Some(button_id)) => {
                        self.library.find_button(profile_id, button_id)
                    }
                    _ => None,
                };
                let Some(fader) = button.as_ref().and_then(|button| button.fader()) else {
                    return Err(refused(404, "server.volume.noFader").into());
                };
                let key = fader_level_key(fader);
                if fader.target == FaderTarget::App {
                    self.app_levels.note_write(&key);
                }
                match write_level(fader, &level, self.as_ref()).await {
                    Ok(level) => self.live.put_level(&key, level),
                    Err(error) => {
                        // A closed (or, on Windows, silent) app has no level any deck can show.
                        if error.is_app_not_playing() {
                            self.live.drop_levels(&[key]);
                        }
                        return Err(HttpError::new(400, error.said()).into());
                    }
                }
                self.live.broadcast();
                ok(json!({ "ok": true, "levels": self.live.levels() }))
            }
            Route::VolumeSync => {
                let data = ask.json_body(JSON_LIMIT).await?;
                let faders = match data.get("profileId").and_then(Value::as_str) {
                    Some(profile_id) => self.library.faders(profile_id),
                    None => Vec::new(),
                };
                let mut reads: FuturesUnordered<_> = faders
                    .iter()
                    .filter_map(|button| button.fader())
                    .map(|fader| async move {
                        (
                            fader_level_key(fader),
                            read_level(fader, self.as_ref()).await,
                        )
                    })
                    .collect();
                while let Some((key, read)) = reads.next().await {
                    match read {
                        Ok(Some(level)) => self.live.put_level(&key, level),
                        // Unknown (a closed app): the decks show "–" rather than its last level.
                        Ok(None) => self.live.forget_level(&key),
                        // An unreachable source keeps its last known level.
                        Err(_) => {}
                    }
                }
                drop(reads);
                self.live.broadcast();
                ok(json!({ "ok": true, "levels": self.live.levels() }))
            }

            // --- sounds
            Route::Sounds => ok(json!({ "slots": self.sounds.slots() })),
            Route::PutSound => {
                let content_type = ask.header("content-type").unwrap_or_default();
                let kind = audio_type(content_type.split(';').next().unwrap_or(""));
                let data = ask.raw_body(LIMITS.max_sound_bytes).await?;
                let Some(kind) = kind.filter(|kind| is_audio(&data, *kind)) else {
                    return Err(refused(400, "server.sounds.unreadable").into());
                };
                // The old sound stops first: it would play on, let go of its file late
                // (Windows), and teach the new file its run time.
                self.player.stop_and_wait(slot).await;
                let name = ask.header("x-sound-name").unwrap_or_default();
                self.sounds.save_upload(slot, kind, &data, &name)?;
                self.live.sounds_changed();
                ok(json!({ "ok": true, "slots": self.sounds.slots() }))
            }
            Route::DeleteSound => {
                if !self.sounds.is_custom(slot) {
                    return Err(refused(400, "server.sounds.alreadyBuiltIn").into());
                }
                self.player.stop_and_wait(slot).await;
                if !self.sounds.revert(slot)? {
                    return Err(refused(400, "server.sounds.alreadyBuiltIn").into());
                }
                self.live.sounds_changed();
                ok(json!({ "ok": true, "slots": self.sounds.slots() }))
            }
            Route::SoundFile => {
                Ok(static_file(&self.sounds.file(slot).file, Some(&ask.headers)).await)
            }
            Route::SoundPreview => {
                self.live.toggle_sound(slot)?;
                ok(json!({ "ok": true }))
            }
            Route::SoundsStop => {
                self.live.stop_all_sounds();
                ok(json!({ "ok": true }))
            }

            Route::Apps => {
                let listed = tokio::task::spawn_blocking(apps::list_apps)
                    .await
                    .map_err(|error| Failure::Other(Box::new(SystemFailure(error.to_string()))))?;
                ok(json!({ "apps": listed }))
            }
            Route::AudioApps => {
                let found = self.audio.apps.list().await.map_err(|error| {
                    HttpError::new(
                        502,
                        say("server.apps.audioListFailed").with("reason", error.text),
                    )
                })?;
                let language = ask.language();
                // Apple's Music is called what the Mac calls it in that language (Música).
                let mac = found.platform == "darwin";
                let listed: Vec<Value> = found
                    .apps
                    .iter()
                    .map(|app| {
                        let mut entry = serde_json::to_value(app).unwrap_or(Value::Null);
                        if mac && app.key == "music" {
                            entry["name"] =
                                json!(render(&say("server.apps.macMusic").into(), &language));
                        }
                        entry
                    })
                    .collect();
                let mut response = Map::new();
                response.insert("platform".to_string(), json!(found.platform));
                response.insert("apps".to_string(), json!(listed));
                if let Some(note) = found.note {
                    response.insert("note".to_string(), json!(render(&note.into(), &language)));
                }
                ok(Value::Object(response))
            }

            Route::OpenDeck | Route::OpenSupport => {
                let address = if found.route == Route::OpenDeck {
                    format!("http://localhost:{}/deck", self.port())
                } else {
                    SUPPORT_URL.to_string()
                };
                self.open_address(&address).await.map_err(|error| {
                    HttpError::new(
                        500,
                        say("server.open.browserFailed").with("reason", text_of(error.as_ref())),
                    )
                })?;
                ok(json!({ "ok": true }))
            }

            Route::ObsNames => {
                if self.obs.status() != LinkStatus::Connected {
                    return ok(
                        json!({ "connected": false, "scenes": [], "sceneItems": {}, "audioInputs": [], "filters": {} }),
                    );
                }
                let names = async {
                    let obs = self.obs.connect().await.map_err(ObsFailure::User)?;
                    read_obs_names(&obs).await
                }
                .await
                .map_err(|error| {
                    HttpError::new(
                        502,
                        say("server.obs.namesFailed").with("reason", error.said()),
                    )
                })?;
                Ok(send_json(200, &names, &[]))
            }
            Route::ObsDetect => {
                let local = read_local_obs();
                let applied = local.found && self.apply_local_obs(&local)?;
                let mut response = serde_json::to_value(local.detected()).unwrap_or(Value::Null);
                response["applied"] = json!(applied);
                ok(response)
            }

            // --- Google icons, browsed from the Control Center only
            Route::GoogleIcons => {
                let icons = self
                    .google_icons
                    .load_catalog()
                    .await
                    .map_err(|error| HttpError::new(502, error.text))?;
                ok(json!({ "icons": *icons }))
            }
            Route::GoogleGlyph => {
                let name = ask.query("name").unwrap_or_default();
                let style = ask.query("style").unwrap_or_else(|| "outlined".to_string());
                let fill = ask.query("fill").as_deref() == Some("1");
                let glyph = self
                    .google_icons
                    .load_glyph(&name, &style, fill)
                    .await
                    .map_err(|error| HttpError::new(400, error.said()))?;
                Ok(send_json(200, &glyph, &[]))
            }

            Route::Traces => {
                let data = ask.json_body(TRACE_LIMIT).await?;
                let list = |name: &str| -> Vec<Value> {
                    data.get(name)
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                };
                let (frames, events) = (list("frames"), list("events"));
                let well_formed = !frames.is_empty()
                    && frames.len() <= TRACE_LIMITS.frames
                    && events.len() <= TRACE_LIMITS.events
                    && frames.iter().all(is_touch_frame)
                    && events.iter().all(is_touchpad_event);
                if !well_formed {
                    return Err(refused(400, "server.trackpad.badTrace").into());
                }
                let trace = TouchpadTrace {
                    version: 1,
                    recorded_at: iso_now(),
                    settings: normalize_trackpad(data.get("settings").unwrap_or(&Value::Null)),
                    expected: summarize(&events),
                    frames,
                    events,
                    user_agent: data
                        .get("userAgent")
                        .and_then(Value::as_str)
                        .filter(|agent| !agent.is_empty())
                        .map(|agent| js::slice_utf16(agent, 300).to_string()),
                };
                let folder = &paths().traces;
                std::fs::create_dir_all(folder)?;
                let file = format!("trace-{}.json", trace.recorded_at.replace([':', '.'], "-"));
                let written = stringify(&serde_json::to_value(&trace).unwrap_or(Value::Null));
                std::fs::write(folder.join(&file), written)?;
                let mut kept: Vec<String> = std::fs::read_dir(folder)?
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| {
                        name.len() > "trace-.json".len()
                            && name.starts_with("trace-")
                            && name.ends_with(".json")
                    })
                    .collect();
                kept.sort();
                for old in kept.iter().take(kept.len().saturating_sub(TRACES_KEPT)) {
                    let _ = std::fs::remove_file(folder.join(old));
                }
                log(&format!(
                    "Saved a trackpad trace from {}: {}",
                    device
                        .as_ref()
                        .map_or("this computer", |device| device.name.as_str()),
                    folder.join(&file).display()
                ));
                ok(json!({ "ok": true, "file": file }))
            }

            Route::Shutdown => {
                // Once the reply has gone out.
                let app = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                    app.shutdown();
                });
                ok(json!({ "ok": true }))
            }
        }
    }

    /// One request, from its arrival to its reply.
    async fn handle(self: Arc<Self>, remote: SocketAddr, request: Request) -> Response {
        let (parts, body) = request.into_parts();
        let complete = Arc::new(AtomicBool::new(body.is_end_stream()));
        let arriving = Arriving {
            inner: (!body.is_end_stream()).then(|| body.into_data_stream()),
            complete: complete.clone(),
        };
        let language = language_for(&parts.headers);
        let mut ask = match Url::parse("http://localhost")
            .and_then(|base| base.join(&parts.uri.to_string()))
        {
            Ok(url) => Ask {
                method: parts.method,
                url,
                headers: parts.headers,
                remote: remote.ip().to_string(),
                body: Some(Body::from_stream(arriving)),
                raw: None,
                complete,
            },
            Err(error) => {
                log(&format!("Request failed: {error}"));
                return send_json(500, &json!({ "error": error.to_string() }), &[]);
            }
        };
        let outcome = self.respond(&mut ask).await;
        let failure = match outcome {
            Ok(response) => return response,
            Err(failure) => failure,
        };
        // Refused before its body was read (too large, unsigned): the reply goes
        // out first, then the connection closes rather than waiting for the rest.
        let headers: &[(&str, &str)] = if ask.complete.load(Ordering::SeqCst) {
            &[]
        } else {
            &[("Connection", "close")]
        };
        // Worded for whoever asked; the English stays in the error's message for logs.
        match failure {
            Failure::Http(error) => error_response(&error, &language, headers),
            Failure::Other(error) => {
                log(&format!("Request failed: {error}"));
                let mut message = render(&text_of(error.as_ref()), &language);
                if message.is_empty() {
                    message = render(&say("server.request.failed").into(), &language);
                }
                send_json(500, &json!({ "error": message }), headers)
            }
        }
    }

    // ---------------------------------------------------------- the trackpad

    /// A request to open a trackpad's socket.
    async fn upgrade(self: Arc<Self>, remote: SocketAddr, request: Request) -> Response {
        let refuse = |status: StatusCode| {
            let mut response = Response::new(Body::empty());
            *response.status_mut() = status;
            set_header(&mut response, "Connection", "close");
            response
        };
        let (mut parts, _) = request.into_parts();
        let Ok(url) =
            Url::parse("http://localhost").and_then(|base| base.join(&parts.uri.to_string()))
        else {
            return refuse(StatusCode::FORBIDDEN);
        };
        let mut ask = Ask {
            method: parts.method.clone(),
            url,
            headers: parts.headers.clone(),
            remote: remote.ip().to_string(),
            body: None,
            raw: None,
            complete: Arc::new(AtomicBool::new(true)),
        };
        // Browsers always send Origin on a WebSocket; it must be this server.
        let origin = ask.header("origin").filter(|origin| !origin.is_empty());
        if ask.url.path() != "/api/pointer"
            || !self.host_allowed(&ask.headers)
            || origin.is_none()
            || !origin_allowed(origin.as_deref(), ask.header("host").as_deref())
        {
            return refuse(StatusCode::FORBIDDEN);
        }
        let Ok(device) = self.require_deck(&mut ask, JSON_LIMIT).await else {
            return refuse(StatusCode::UNAUTHORIZED);
        };
        let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(upgrade) => upgrade,
            Err(rejection) => return rejection.into_response(),
        };
        let device = device.map(|device| device.id).unwrap_or_default();
        let language = ask.language();
        upgrade
            .max_message_size(1024)
            .max_frame_size(1024)
            .on_upgrade(move |socket| self.trackpad(socket, device, language))
    }

    /// One open trackpad, until it closes.
    async fn trackpad(self: Arc<Self>, socket: WebSocket, device: String, language: String) {
        let owner = next_owner();
        let (out, mut outgoing) = mpsc::unbounded_channel();
        lock(&self.pointer_sockets).insert(
            owner,
            PointerSocket {
                device,
                language,
                out,
            },
        );
        let (mut sink, mut stream) = socket.split();
        loop {
            tokio::select! {
                told = outgoing.recv() => match told {
                    Some(ToPointer::Notice(text)) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(ToPointer::Close) | None => {
                        let _ = sink.send(Message::Close(None)).await;
                        break;
                    }
                },
                message = stream.next() => {
                    let data: Vec<u8> = match message {
                        Some(Ok(Message::Text(text))) => text.as_bytes().to_vec(),
                        Some(Ok(Message::Binary(data))) => data.to_vec(),
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Ok(_)) => continue,
                        // A frame over the size limit, or a broken frame: the
                        // connection has failed, and is closed.
                        Some(Err(error)) => {
                            let said = error.to_string();
                            let too_large = said.contains("Space limit exceeded") || said.contains("too long");
                            log(&format!(
                                "A trackpad connection failed: {}",
                                if too_large { "Max payload size exceeded" } else { said.as_str() }
                            ));
                            if too_large {
                                let _ = sink
                                    .send(Message::Close(Some(CloseFrame { code: 1009, reason: "".into() })))
                                    .await;
                            }
                            break;
                        }
                    };
                    if let Ok(message) = serde_json::from_slice::<Value>(&data) {
                        self.pointer.send(&message, Some(owner));
                    }
                }
            }
        }
        lock(&self.pointer_sockets).remove(&owner);
        // Only what this trackpad holds: another deck may be mid-drag.
        self.pointer.release(Some(owner));
    }

    // ----------------------------------------------------------- start, stop

    fn announce(&self) {
        let port = self.port();
        let control = format!("http://localhost:{port}/designer");
        let pair = format!("http://localhost:{port}/pair");
        let link = |url: &str| format!("\u{1B}]8;;{url}\u{7}{url}\u{1B}]8;;\u{7}");
        println!("\n  Punchboard is ready\n");
        println!("  Control Center:  {}", link(&control));
        println!("  Pair a device:   {}", link(&pair));
        println!("  Your data:       {}\n", data_dir().display());
        let code = self
            .auth
            .current_code()
            .map(|code| code.code)
            .unwrap_or_default();
        if let Some(qr) = terminal_qr(&format!("{}/deck#pair={code}", self.deck_url())) {
            println!("{qr}");
        }
        println!(
            "  Scan with a tablet on the same wifi, or open {} on it and enter code {code}.\n",
            self.deck_url()
        );
    }

    /// Brings the Control Center up in the default browser, so starting Punchboard
    /// is one double-click. PUNCHBOARD_NO_OPEN=1 turns it off (tests, servers).
    async fn open_control_center(&self, port: u16) {
        if std::env::var("PUNCHBOARD_NO_OPEN").is_ok_and(|value| value == "1") {
            return;
        }
        // The printed link still works.
        let _ = self
            .open_address(&format!("http://localhost:{port}/designer"))
            .await;
    }

    // The desktop app runs the companion as a child process: it reads the port
    // from this line and asks for a clean exit by writing "quit" to stdin.
    fn desktop_ready(&self, port: u16) {
        self.desktop_language();
        if self.desktop {
            println!("PUNCHBOARD_READY {port}");
        }
    }

    // The app's menu speaks what the Control Center on this computer speaks:
    // the setting, or under "auto" this computer's own language.
    fn desktop_language(&self) {
        if self.desktop {
            println!("PUNCHBOARD_LANGUAGE {}", system_language());
        }
    }

    /// Stops sounds and OBS, saves what is pending, closes streams, exits.
    pub fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        self.player.dispose();
        self.app_levels.stop();
        self.audio.stop();
        crate::keys::stop_keys();
        self.pointer.dispose();
        self.obs.stop();
        if let Err(error) = self.auth.flush() {
            log(&format!("The paired devices could not be saved: {error}"));
        }
        self.flush_config();
        self.live.close_all();
        self.stopped.notify_waiters();
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(200));
            std::process::exit(0);
        });
    }

    /// Takes a port and serves until the companion is asked to stop
    /// (`start()` and what follows it in main.ts).
    pub async fn run(self: Arc<Self>) -> Result<(), StartError> {
        let failed = |error: &dyn std::fmt::Display| StartError(error.to_string());
        let saved = lock(&self.config).port;
        let preferred = if self.port_override != 0 {
            self.port_override
        } else {
            lock(&self.config).port_number().ok_or_else(|| {
                StartError(format!(
                    "Port {} is not a port (0 to 65535).",
                    js::number_to_string(saved)
                ))
            })?
        };
        self.port.store(preferred, Ordering::SeqCst);

        if self.desktop {
            // Follows the app: "quit" on stdin, or stdin closing because the app went away.
            let (app, runtime) = (self.clone(), tokio::runtime::Handle::current());
            std::thread::spawn(move || {
                use std::io::Read;
                let mut input = Vec::new();
                let mut chunk = [0u8; 256];
                let mut stdin = std::io::stdin();
                loop {
                    match stdin.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            input.extend_from_slice(&chunk[..read]);
                            if String::from_utf8_lossy(&input).contains("quit") {
                                break;
                            }
                        }
                    }
                }
                let _inside = runtime.enter();
                app.shutdown();
            });
        }

        let outcome = claim_port(preferred, PORT_RANGE)
            .await
            .map_err(|error| failed(&error))?;
        let listener = match outcome {
            PortOutcome::AlreadyRunning { port } => {
                self.desktop_ready(port);
                println!("\n  Punchboard is already running at http://localhost:{port}/designer");
                println!("  Opening it instead of starting a second copy.\n");
                self.open_control_center(port).await;
                std::process::exit(0);
            }
            PortOutcome::NoFreePort => {
                eprintln!(
                    "\n  Ports {preferred} to {} are all taken by other programs, so Punchboard cannot start.",
                    u32::from(preferred) + 20
                );
                eprintln!("  Close one of them, or set a different \"port\" in config.json.\n");
                std::process::exit(1);
            }
            PortOutcome::Listening {
                listener,
                port,
                moved,
            } => {
                if moved {
                    println!("\n  Port {preferred} is taken by another program, so Punchboard is using {port} instead.");
                    // Remembered, so the address (and every tablet's pairing) stays put from now on.
                    if self.port_override == 0 {
                        lock(&self.config).port = f64::from(port);
                        self.write_config().map_err(|error| failed(&error))?;
                        println!("  Paired tablets need to open the new address and pair once more; after that it stays fixed.");
                    }
                }
                self.port.store(port, Ordering::SeqCst);
                listener
            }
        };

        // The bundles are looked at again every few seconds: when they change,
        // open decks reload themselves.
        {
            let app = self.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_millis(5000));
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let next = current_build(&app.public_dir);
                    {
                        let mut build = lock(&app.build);
                        if *build == next {
                            continue;
                        }
                        *build = next;
                    }
                    log("The pages were updated; open decks reload themselves.");
                    app.live.broadcast();
                }
            });
        }

        let router = axum::Router::new()
            .fallback(serve)
            .with_state(self.clone())
            .into_make_service_with_connect_info::<SocketAddr>();
        let stopping = self.clone();
        let serving = tokio::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move { stopping.stopped.notified().await })
                .await;
            if let Err(error) = served {
                log(&format!("The server stopped: {error}"));
            }
        });

        self.announce();
        self.obs.start();
        self.desktop_ready(self.port());
        self.open_control_center(self.port()).await;

        let app = self.clone();
        tokio::spawn(async move {
            asked_to_stop().await;
            app.shutdown();
        });
        let _ = serving.await;
        // The exit follows shutdown() by itself.
        std::future::pending::<()>().await;
        Ok(())
    }
}

/// SIGINT or SIGTERM (Ctrl+C on Windows).
async fn asked_to_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match (
            signal(SignalKind::interrupt()),
            signal(SignalKind::terminate()),
        ) {
            (Ok(mut interrupt), Ok(mut terminate)) => {
                tokio::select! {
                    _ = interrupt.recv() => {}
                    _ = terminate.recv() => {}
                }
            }
            _ => std::future::pending::<()>().await,
        }
    }
    #[cfg(not(unix))]
    {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn set_header(response: &mut Response, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        response.headers_mut().insert(name, value);
    }
}

/// Whether a request asks to become another protocol, which Node hands to
/// the "upgrade" listener instead of the request handler.
fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key("upgrade")
        && headers.get_all("connection").iter().any(|value| {
            value.to_str().is_ok_and(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
        })
}

async fn serve(
    State(app): State<Arc<App>>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    request: Request,
) -> Response {
    // On a task of its own: a page that goes away mid-request must not stop
    // a macro halfway, or a save between the file and the broadcast.
    let work = if wants_upgrade(request.headers()) {
        tokio::spawn(app.upgrade(remote, request))
    } else {
        tokio::spawn(app.handle(remote, request))
    };
    match work.await {
        Ok(response) => response,
        Err(error) => {
            log(&format!("Request failed: {error}"));
            send_json(500, &json!({ "error": "Something went wrong." }), &[])
        }
    }
}

/// A two-state macro that is running: marked busy until it is done, however it ends.
struct Busy {
    app: Arc<App>,
    key: String,
}

impl Busy {
    fn mark(app: Arc<App>, key: String) -> Busy {
        lock(&app.busy_switches).insert(key.clone());
        Busy { app, key }
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        lock(&self.app.busy_switches).remove(&self.key);
    }
}

// ------------------------------------------------- what macros and faders ask

fn off_thread<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, UserError> + Send + 'static,
) -> Done<T> {
    Box::pin(async move {
        match tokio::task::spawn_blocking(work).await {
            Ok(Ok(done)) => Ok(done),
            Ok(Err(error)) => Err(Box::new(error) as Wrong),
            Err(stopped) => Err(Box::new(SystemFailure(stopped.to_string())) as Wrong),
        }
    })
}

impl ActionContext for App {
    fn send_keys(&self, keys: Option<String>) -> Done {
        // The keys are held for a moment: off the threads that serve requests.
        off_thread(move || crate::keys::send_keys(keys.as_deref()))
    }

    fn send_media_key(&self, key: MediaKey) -> Done {
        off_thread(move || crate::keys::send_media_key(key))
    }

    fn launch_app(&self, target: String) -> Done {
        let recorded = self.recorded.clone();
        Box::pin(async move {
            match recorded {
                Some(recorded) => apps::launch_with(recorded.as_ref(), &target),
                None => apps::launch_app(&target).await,
            }
        })
    }

    fn open_url(&self, address: String) -> Done {
        let recorded = self.recorded.clone();
        Box::pin(async move {
            match recorded {
                Some(recorded) => apps::open_url_with(recorded.as_ref(), &address),
                None => apps::open_url(&address).await,
            }
        })
    }

    fn obs(&self) -> Done<ObsClient> {
        let obs = self.obs.clone();
        Box::pin(async move { Ok(obs.connect().await?) })
    }

    fn on_sound(&self, slot: Slot) -> Result<(), Wrong> {
        Ok(self.live.toggle_sound(slot)?)
    }

    fn stop_sounds(&self) {
        self.live.stop_all_sounds();
    }
}

fn obs_failed(failure: ObsFailure) -> VolumeError {
    match failure {
        ObsFailure::User(error) => VolumeError::User(error),
        ObsFailure::Obs(error) => VolumeError::Plain(error.message),
    }
}

impl VolumeContext for App {
    fn obs_connect(&self) -> Answer<(), VolumeError> {
        let obs = self.obs.clone();
        Box::pin(async move {
            obs.connect().await?;
            Ok(())
        })
    }

    fn obs_input_volume(&self, input_name: &str) -> Answer<f64, VolumeError> {
        let (obs, data) = (self.obs.clone(), json!({ "inputName": input_name }));
        Box::pin(async move {
            let client = obs.connect().await?;
            let answer = obs_call(&client, "GetInputVolume", Some(data))
                .await
                .map_err(obs_failed)?;
            Ok(answer.get("inputVolumeMul").map_or(f64::NAN, js::to_number))
        })
    }

    fn set_obs_input_volume(&self, input_name: &str, mul: f64) -> Answer<(), VolumeError> {
        let obs = self.obs.clone();
        let data = json!({ "inputName": input_name, "inputVolumeMul": mul });
        Box::pin(async move {
            let client = obs.connect().await?;
            obs_call(&client, "SetInputVolume", Some(data))
                .await
                .map_err(obs_failed)?;
            Ok(())
        })
    }

    fn sound_volume(&self) -> f64 {
        lock(&self.config).sound_volume
    }

    fn store_sound_volume(&self, level: f64) {
        lock(&self.config).sound_volume = level;
    }

    fn save_config(&self) {
        self.write_config_soon();
    }

    fn set_sound_volume(&self, level: f64) {
        self.player.set_volume(level);
    }

    fn apps(&self) -> &dyn AppVolume {
        self.audio.apps.as_ref()
    }

    fn system(&self) -> &SystemVolume {
        &self.audio.system
    }
}

/// Starts the companion and serves until it is asked to stop. Only comes
/// back when it could not start.
pub async fn run() -> StartError {
    let app = match App::open() {
        Ok(app) => app,
        Err(error) => return error,
    };
    match app.run().await {
        Ok(()) => StartError("The server stopped.".to_string()),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<Value> {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/server")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap()
    }

    #[test]
    fn the_terminal_s_qr_code_is_the_one_qrcode_terminal_drew() {
        let cases = fixture("qr-terminal.json");
        assert!(cases.len() >= 8);
        for case in cases {
            let text = case["input"].as_str().unwrap();
            assert_eq!(
                terminal_qr(text).as_deref(),
                case["output"].as_str(),
                "{text}"
            );
        }
    }

    #[test]
    fn the_pairing_qr_code_is_the_size_the_qrcode_package_drew() {
        let cases = fixture("qr-modules.json");
        assert!(cases.len() >= 8);
        for case in cases {
            let text = case["input"].as_str().unwrap();
            let rows: Vec<&str> = case["output"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row.as_str().unwrap())
                .collect();
            let code = pair_code(text).unwrap();
            assert_eq!(code.width(), rows.len(), "{text}");
            assert_eq!(code.error_correction_level(), qrcode::EcLevel::M);
            let svg = pair_qr_svg(text).unwrap();
            // A margin of one module around it.
            let whole = rows.len() + 2;
            assert!(
                svg.starts_with(&format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {whole} {whole}\""
                )),
                "{text}: {}",
                &svg[..80]
            );
            assert!(svg.ends_with("</svg>\n"));
            // Every dark module is drawn once.
            let dark = code
                .to_colors()
                .iter()
                .filter(|color| **color == qrcode::Color::Dark)
                .count();
            let path = svg
                .split("stroke=\"#000000\" d=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .unwrap();
            let drawn: usize = path
                .split('h')
                .skip(1)
                .map(|run| {
                    run.chars()
                        .take_while(char::is_ascii_digit)
                        .collect::<String>()
                        .parse::<usize>()
                        .unwrap()
                })
                .sum();
            assert_eq!(drawn, dark, "{text}");
            let same = rows.iter().enumerate().all(|(row, line)| {
                line.bytes().enumerate().all(|(column, module)| {
                    (module == b'1') == (code[(column, row)] == qrcode::Color::Dark)
                })
            });
            println!(
                "{text}: {}",
                if same {
                    "the same modules"
                } else {
                    "other modules"
                }
            );
        }
    }

    #[test]
    fn text_is_written_into_a_qr_code_the_shortest_way() {
        let split = |text: &str| -> Vec<(QrMode, String)> {
            qr_segments(text.as_bytes(), 0)
                .1
                .into_iter()
                .map(|(mode, start, end)| (mode, text[start..end].to_string()))
                .collect()
        };
        assert_eq!(split("x"), vec![(QrMode::Byte, "x".to_string())]);
        assert_eq!(
            split("12345678"),
            vec![(QrMode::Numeric, "12345678".to_string())]
        );
        assert_eq!(
            split("HELLO WORLD"),
            vec![(QrMode::Alphanumeric, "HELLO WORLD".to_string())]
        );
        let parts = split("http://192.168.1.5:8787/deck#pair=123456");
        assert_eq!(
            parts.last().unwrap(),
            &(QrMode::Numeric, "123456".to_string())
        );
        assert_eq!(
            parts
                .iter()
                .map(|(_, part)| part.as_str())
                .collect::<String>(),
            "http://192.168.1.5:8787/deck#pair=123456"
        );
        assert_eq!(qr_segments(b"", 0).0, 0);
        // 8 digits: 4 + 10 + 10 + 10 + 7 bits.
        assert_eq!(qr_segments(b"12345678", 0).0, 41);
    }

    #[test]
    fn a_host_header_must_name_this_server_and_its_port() {
        let names: HashSet<String> = [
            "localhost",
            "127.0.0.1",
            "[::1]",
            "192.168.1.5",
            "studio.local",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let allowed = |host: &str, port: u16| host_allowed(Some(host), &names, port);
        assert!(allowed("localhost:8787", 8787));
        assert!(allowed("LOCALHOST:8787", 8787));
        assert!(allowed("127.0.0.1:8787", 8787));
        assert!(allowed("[::1]:8787", 8787));
        assert!(allowed("192.168.1.5:8787", 8787));
        assert!(allowed("Studio.local:8787", 8787));
        assert!(allowed("localhost:08787", 8787));
        // No port is port 80.
        assert!(allowed("localhost", 80));
        assert!(allowed("[::1]", 80));
        assert!(!allowed("localhost", 8787));
        assert!(!allowed("localhost:8788", 8787));
        assert!(!allowed("evil.example:8787", 8787));
        assert!(!allowed("localhost.evil.example:8787", 8787));
        assert!(!allowed("localhost:8787:1", 8787));
        assert!(!allowed("localhost:", 8787));
        assert!(!allowed("localhost:87x7", 8787));
        assert!(!allowed(":8787", 8787));
        assert!(!allowed("", 8787));
        assert!(!allowed("[::1", 80));
        assert!(!allowed("[]:8787", 8787));
        assert!(!host_allowed(None, &names, 8787));
    }

    #[test]
    fn an_origin_must_be_this_server_s_own() {
        let host = Some("192.168.1.5:8787");
        assert!(origin_allowed(None, host));
        assert!(origin_allowed(Some(""), host));
        assert!(origin_allowed(Some("http://192.168.1.5:8787"), host));
        assert!(origin_allowed(Some("HTTP://192.168.1.5:8787/"), host));
        assert!(origin_allowed(Some("https://192.168.1.5:8787"), host));
        assert!(!origin_allowed(Some("http://192.168.1.5"), host));
        assert!(!origin_allowed(Some("http://192.168.1.5:8788"), host));
        assert!(!origin_allowed(Some("https://evil.example"), host));
        assert!(!origin_allowed(Some("null"), host));
        assert!(!origin_allowed(Some("not an address"), host));
        // The scheme's own port is not part of the host.
        assert!(origin_allowed(
            Some("http://localhost:80"),
            Some("localhost")
        ));
        assert!(origin_allowed(Some("http://LocalHost"), Some("localhost")));
        assert!(origin_allowed(
            Some("http://[::1]:8787"),
            Some("[::1]:8787")
        ));
        assert!(!origin_allowed(Some("http://localhost"), None));
    }

    #[test]
    fn only_loopback_is_this_computer() {
        for remote in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback(remote), "{remote}");
        }
        for remote in [
            "192.168.1.5",
            "::ffff:192.168.1.5",
            "127.0.0.2",
            "",
            "localhost",
        ] {
            assert!(!is_loopback(remote), "{remote}");
        }
        // What a socket's address reads as, for a tablet and for this computer.
        let v4_on_v6: std::net::IpAddr = "::ffff:127.0.0.1".parse().unwrap();
        assert!(is_loopback(&v4_on_v6.to_string()));
    }

    #[test]
    fn a_device_is_named_after_its_browser() {
        for (agent, kind) in [
            ("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "ipad"),
            ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Mobile/15E148 Safari/604.1", "ipad"),
            ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", "browser"),
            ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148", "iphone"),
            ("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari/537.36", "androidPhone"),
            ("Mozilla/5.0 (Linux; Android 14; SM-X900) Chrome/120 Safari/537.36", "androidTablet"),
            ("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "windows"),
            ("", "browser"),
            ("curl/8.0", "browser"),
        ] {
            assert_eq!(device_kind(agent), kind, "{agent}");
        }
    }

    #[test]
    fn routes_are_found_by_method_and_address() {
        let found = |method: &str, pathname: &str| {
            match_route(method, pathname).map(|found| (found.route, found.access, found.param))
        };
        assert_eq!(
            found("GET", "/api/hello"),
            Some((Route::Hello, Access::Public, String::new()))
        );
        assert_eq!(found("POST", "/api/hello"), None);
        assert_eq!(found("GET", "/api/hello/"), None);
        assert_eq!(
            found("GET", "/api/library"),
            Some((Route::GetLibrary, Access::Deck, String::new()))
        );
        assert_eq!(
            found("PUT", "/api/library"),
            Some((Route::PutLibrary, Access::Local, String::new()))
        );
        assert_eq!(
            found("DELETE", "/api/devices/dev_0a1b2c"),
            Some((Route::RemoveDevice, Access::Local, "dev_0a1b2c".to_string()))
        );
        assert_eq!(found("DELETE", "/api/devices/dev_"), None);
        assert_eq!(found("DELETE", "/api/devices/dev_XYZ"), None);
        assert_eq!(found("DELETE", "/api/devices/other"), None);
        assert_eq!(
            found("PUT", "/api/sounds/3"),
            Some((Route::PutSound, Access::Local, "3".to_string()))
        );
        assert_eq!(found("PUT", "/api/sounds/9"), None);
        assert_eq!(found("PUT", "/api/sounds/0"), None);
        assert_eq!(found("PUT", "/api/sounds/12"), None);
        assert_eq!(
            found("DELETE", "/api/sounds/8"),
            Some((Route::DeleteSound, Access::Local, "8".to_string()))
        );
        assert_eq!(
            found("GET", "/api/sounds/1/file"),
            Some((Route::SoundFile, Access::Local, "1".to_string()))
        );
        assert_eq!(
            found("POST", "/api/sounds/2/preview"),
            Some((Route::SoundPreview, Access::Local, "2".to_string()))
        );
        assert_eq!(
            found("POST", "/api/sounds/stop"),
            Some((Route::SoundsStop, Access::Deck, String::new()))
        );
        assert_eq!(
            match_route("POST", "/api/trackpad/traces")
                .unwrap()
                .body_limit,
            TRACE_LIMIT
        );
        assert_eq!(
            match_route("POST", "/api/press").unwrap().body_limit,
            JSON_LIMIT
        );
        assert_eq!(found("HEAD", "/api/hello"), None);
    }

    #[test]
    fn pages_and_locale_files_are_found_by_their_address() {
        assert_eq!(page_of("/"), Some("deck.html"));
        assert_eq!(page_of("/deck"), Some("deck.html"));
        assert_eq!(page_of("/designer"), Some("designer.html"));
        assert_eq!(page_of("/pair"), Some("pair.html"));
        assert_eq!(page_of("/deck.html"), None);
        assert_eq!(locale_name("/locales/es.json"), Some("es.json"));
        assert_eq!(locale_name("/locales/.json"), None);
        assert_eq!(locale_name("/locales/a/b.json"), None);
        assert_eq!(locale_name("/locales/es.txt"), None);
        assert_eq!(locale_name("/locale/es.json"), None);
    }

    #[test]
    fn obs_addresses_are_told_apart() {
        for address in [
            "ws://127.0.0.1:4455",
            "WS://LOCALHOST",
            "wss://localhost:1/",
            "ws://127.0.0.1/",
        ] {
            assert!(is_local_obs_address(address), "{address}");
        }
        for address in [
            "ws://192.168.1.5:4455",
            "ws://127.0.0.1:4455/x",
            "http://localhost",
            "ws://localhost:",
            "ws://localhost.evil",
        ] {
            assert!(!is_local_obs_address(address), "{address}");
        }
        for address in ["ws://obs", "wss://192.168.1.5:4455/x", "WS://x"] {
            assert!(looks_like_obs_address(address), "{address}");
        }
        for address in ["ws://", "ws:///x", "ws:// x", "http://obs", "obs"] {
            assert!(!looks_like_obs_address(address), "{address}");
        }
    }

    #[test]
    fn text_is_encoded_for_a_header_as_javascript_did() {
        assert_eq!(
            encode_uri_component("Café ñandú: 100% (ok) a/b?c=d&e ~*'!"),
            "Caf%C3%A9%20%C3%B1and%C3%BA%3A%20100%25%20(ok)%20a%2Fb%3Fc%3Dd%26e%20~*'!"
        );
    }

    #[test]
    fn the_build_is_named_by_when_its_bundles_changed() {
        let folder = tempfile::tempdir().unwrap();
        assert_eq!(current_build(folder.path()), "0.0.0.0");
        std::fs::create_dir_all(folder.path().join("js")).unwrap();
        std::fs::write(folder.path().join("js/pair.js"), "x").unwrap();
        let build = current_build(folder.path());
        let parts: Vec<&str> = build.split('.').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!((parts[0], parts[1], parts[3]), ("0", "0", "0"));
        assert!(parts[2].len() >= 8 && parts[2].bytes().all(|byte| byte.is_ascii_alphanumeric()));
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(0), "0");
    }
}
