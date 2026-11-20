//! Low-level HTTP helpers: errors, JSON replies, bodies and static files.
//!
//! These are the pieces the routes are built from. Nothing here knows about
//! a router: a handler reads its body with [`json_body`] or [`raw_body`],
//! answers with [`send_json`] or [`static_file`], and fails with an
//! [`HttpError`], which whoever owns the request turns into a reply in the
//! asker's language with [`error_response`].

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::{Body, Bytes};
use axum::http::header::{HeaderName, HeaderValue, CONTENT_LENGTH, CONTENT_TYPE, IF_NONE_MATCH};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::i18n::{english, language_for, render, say, Said, Text};
use crate::store::{js_to_number, stringify};

/// An error reply. Given a Text, it is worded in the asker's language when
/// it is sent ([`error_response`]); its message is the English, for logs.
#[derive(Debug, Clone, PartialEq)]
pub struct HttpError {
    pub status: u16,
    pub text: Option<Text>,
    // Boxed so that a `Result<_, HttpError>` stays small to pass around.
    extra: Box<Map<String, Value>>,
    message: String,
}

impl HttpError {
    pub fn new(status: u16, message: impl Into<Said>) -> HttpError {
        let said = message.into();
        let message = english(&said);
        let text = match said {
            Said::Text(text) => Some(text),
            Said::Plain(_) => None,
        };
        HttpError {
            status,
            extra: Box::default(),
            text,
            message,
        }
    }

    /// Adds a field to the reply: `.with("code", "unpaired")`.
    pub fn with(mut self, name: &str, value: impl Into<Value>) -> HttpError {
        self.extra.insert(name.to_string(), value.into());
        self
    }

    /// The other fields of the reply: "code", "serverTime", "libraryRev".
    pub fn extra(&self) -> &Map<String, Value> {
        &self.extra
    }

    /// The English wording, for logs.
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The reply's JSON in a language: `{ "error": …, …extra }`.
    pub fn body(&self, language: &str) -> Value {
        let message = match &self.text {
            Some(text) => render(&Said::Text(text.clone()), language),
            None => self.message.clone(),
        };
        let mut body = Map::new();
        body.insert("error".to_string(), Value::String(message));
        for (name, value) in self.extra.iter() {
            body.insert(name.clone(), value.clone());
        }
        Value::Object(body)
    }
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}

/// The reply for an error, worded for whoever asked. `headers` are added to
/// it (`Connection: close` when the request's body was not read to the end).
pub fn error_response(error: &HttpError, language: &str, headers: &[(&str, &str)]) -> Response {
    send_json(error.status, &error.body(language), headers)
}

pub const SECURITY_HEADERS: [(&str, &str); 3] = [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "no-referrer"),
];

fn status_of(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// Sets a header, replacing one of the same name; a name or value that
/// cannot go in a header is left out.
fn set_header(headers: &mut HeaderMap, name: &str, value: &str) {
    if let (Ok(name), Ok(value)) = (
        HeaderName::from_bytes(name.as_bytes()),
        HeaderValue::from_str(value),
    ) {
        headers.insert(name, value);
    }
}

fn response(status: u16, headers: &[(&str, &str)], body: Body) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status_of(status);
    for (name, value) in headers {
        set_header(response.headers_mut(), name, value);
    }
    response
}

/// A JSON reply, written as `JSON.stringify` wrote it. `headers` come last
/// and replace the standard ones of the same name.
pub fn send_json<T: Serialize + ?Sized>(
    status: u16,
    body: &T,
    headers: &[(&str, &str)],
) -> Response {
    let data = stringify(&serde_json::to_value(body).unwrap_or(Value::Null));
    let length = data.len().to_string();
    let mut all: Vec<(&str, &str)> = SECURITY_HEADERS.to_vec();
    all.extend([
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", length.as_str()),
        ("Cache-Control", "no-store"),
    ]);
    all.extend_from_slice(headers);
    response(status, &all, Body::from(data))
}

const STATIC_TYPES: [(&str, &str); 11] = [
    ("html", "text/html; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("map", "application/json"),
    ("svg", "image/svg+xml"),
    ("wav", "audio/wav"),
    ("mp3", "audio/mpeg"),
    ("woff2", "font/woff2"),
    ("webmanifest", "application/manifest+json"),
    ("png", "image/png"),
    ("json", "application/json; charset=utf-8"),
];

/// The Content-Type for a file, by its ending (case does not matter).
pub fn content_type(file: &Path) -> &'static str {
    let extension = file
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    STATIC_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map_or("application/octet-stream", |(_, kind)| kind)
}

fn base36(mut number: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(number % 36) as usize]);
        number /= 36;
        if number == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8_lossy(&out).into_owned()
}

/// A file's ETag: its size and the millisecond it was last changed, both in
/// base 36, as the Node companion made it (so a browser's copy stays good
/// across the update).
pub fn etag(size: u64, modified_ms: f64) -> String {
    // Math.round: halves go up.
    let rounded = (modified_ms + 0.5).floor();
    let stamp = if rounded < 0.0 {
        format!("-{}", base36((-rounded) as u64))
    } else {
        base36(rounded as u64)
    };
    format!("\"{}-{stamp}\"", base36(size))
}

/// A header as Node hands it over: several of the same name joined by ", ".
fn joined(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// Serves a file. Browsers check back every time (no-cache) but, given the
/// request's headers, a file they already hold is answered with a bodyless
/// 304: every page load asks for its locale file, and it rarely changes.
pub async fn static_file(file: &Path, request: Option<&HeaderMap>) -> Response {
    let not_found = || {
        let language = request.map_or_else(|| "en".to_string(), language_for);
        send_json(
            404,
            &serde_json::json!({ "error": render(&say("server.request.notFound").into(), &language) }),
            &[],
        )
    };
    let Ok(stats) = tokio::fs::metadata(file).await else {
        return not_found();
    };
    if !stats.is_file() {
        return not_found();
    }
    // Node's mtimeMs: milliseconds with a fraction.
    let modified_ms = match stats.modified().map(|time| time.duration_since(UNIX_EPOCH)) {
        Ok(Ok(since)) => since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6,
        Ok(Err(before)) => {
            let since = before.duration();
            -(since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6)
        }
        Err(_) => 0.0,
    };
    let etag = etag(stats.len(), modified_ms);
    let mut headers: Vec<(&str, &str)> = SECURITY_HEADERS.to_vec();
    headers.extend([
        ("Content-Type", content_type(file)),
        ("Cache-Control", "no-cache"),
        ("ETag", etag.as_str()),
    ]);
    if request
        .and_then(|headers| joined(headers, IF_NONE_MATCH))
        .as_deref()
        == Some(etag.as_str())
    {
        return response(304, &headers, Body::empty());
    }
    let Ok(data) = tokio::fs::read(file).await else {
        return not_found();
    };
    let length = data.len().to_string();
    headers.push(("Content-Length", length.as_str()));
    response(200, &headers, Body::from(data))
}

/// The file a page address names inside the public folder (`relative` is the
/// path without its leading slashes), or a 403 for one that would land
/// outside it. Both folders are expected resolved ([`crate::paths::resolve`]).
pub fn public_file(public_dir: &Path, relative: &str) -> Result<PathBuf, HttpError> {
    let file = crate::paths::resolve(public_dir.join(relative));
    // Inside the folder, and not the folder itself.
    if file != public_dir && file.starts_with(public_dir) {
        Ok(file)
    } else {
        Err(HttpError::new(403, say("server.request.forbidden")))
    }
}

/// The locale file `/locales/<name>` names: it must sit right in the locales
/// folder, or it is a 403.
pub fn locale_file(locales_dir: &Path, name: &str) -> Result<PathBuf, HttpError> {
    let file = crate::paths::resolve(locales_dir.join(name));
    if file.parent() == Some(locales_dir) {
        Ok(file)
    } else {
        Err(HttpError::new(403, say("server.request.forbidden")))
    }
}

fn too_large() -> HttpError {
    HttpError::new(413, say("server.request.tooLarge"))
}

/// Reads the whole body, because a signature covers the exact bytes sent;
/// the caller keeps the bytes if it needs them twice. A body over the limit
/// is refused without being kept: the 413 goes out first (with
/// `Connection: close`, see [`error_response`]) while the rest is read and
/// dropped, so the client reads why rather than a reset. A Content-Length
/// over the limit is refused before a byte of the body is read.
pub async fn raw_body(headers: &HeaderMap, body: Body, limit: usize) -> Result<Bytes, HttpError> {
    let declared = joined(headers, CONTENT_LENGTH).map_or(f64::NAN, |length| js_to_number(&length));
    if declared.is_finite() && declared > limit as f64 {
        return Err(too_large());
    }
    let mut stream = body.into_data_stream();
    let mut kept: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        // A connection that broke mid-body: the TypeScript let this reach
        // the general 500 reply, with the error's own words.
        let chunk = chunk.map_err(|error| HttpError::new(500, error.to_string()))?;
        if kept.len() + chunk.len() > limit {
            // Nothing more is kept; the rest is read and dropped while the reply goes out.
            drop(kept);
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move { while let Some(Ok(_)) = stream.next().await {} });
            }
            return Err(too_large());
        }
        kept.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(kept))
}

pub const JSON_LIMIT: usize = 256 * 1024;

/// `/^application\/json\b/i` on the Content-Type.
pub fn is_json_type(headers: &HeaderMap) -> bool {
    let kind = joined(headers, CONTENT_TYPE).unwrap_or_default();
    let bytes = kind.as_bytes();
    const WANTED: &[u8] = b"application/json";
    bytes.len() >= WANTED.len()
        && bytes[..WANTED.len()].eq_ignore_ascii_case(WANTED)
        && !bytes
            .get(WANTED.len())
            .is_some_and(|next| next.is_ascii_alphanumeric() || *next == b'_')
}

/// Reads a body already in hand as a JSON object; an empty one is `{}`.
pub fn parse_json_object(raw: &[u8]) -> Result<Map<String, Value>, HttpError> {
    if raw.is_empty() {
        return Ok(Map::new());
    }
    let parsed: Value = serde_json::from_str(&String::from_utf8_lossy(raw))
        .map_err(|_| HttpError::new(400, say("server.request.badJson")))?;
    match parsed {
        Value::Object(object) => Ok(object),
        _ => Err(HttpError::new(400, say("server.request.notObject"))),
    }
}

/// JSON bodies must say so: a cross-site form can only send text/plain or form
/// encodings, so this alone refuses forged form posts. The result is unknown
/// and has to be validated by the caller. The usual `limit` is [`JSON_LIMIT`].
pub async fn json_body(
    headers: &HeaderMap,
    body: Body,
    limit: usize,
) -> Result<Map<String, Value>, HttpError> {
    if !is_json_type(headers) {
        return Err(HttpError::new(415, say("server.request.notJsonType")));
    }
    parse_json_object(&raw_body(headers, body, limit).await?)
}

/// What an error says, for a log line.
pub fn error_text(error: &dyn std::error::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn english_of(key: &str) -> String {
        render(&say(key).into(), "en")
    }

    async fn text_of(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    fn header<'a>(response: &'a Response, name: &str) -> Option<&'a str> {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap())
    }

    fn fixture(name: &str) -> Vec<Value> {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/base")
            .join(name);
        serde_json::from_str(
            &fs::read_to_string(&file)
                .unwrap_or_else(|error| panic!("{}: {error}", file.display())),
        )
        .unwrap()
    }

    fn assert_security_headers(response: &Response) {
        assert_eq!(header(response, "x-content-type-options"), Some("nosniff"));
        assert_eq!(header(response, "x-frame-options"), Some("DENY"));
        assert_eq!(header(response, "referrer-policy"), Some("no-referrer"));
    }

    #[test]
    fn the_security_headers_are_the_same_three() {
        assert_eq!(
            SECURITY_HEADERS,
            [
                ("X-Content-Type-Options", "nosniff"),
                ("X-Frame-Options", "DENY"),
                ("Referrer-Policy", "no-referrer")
            ]
        );
    }

    #[tokio::test]
    async fn send_json_writes_the_body_and_its_headers() {
        let reply = send_json(
            200,
            &json!({ "ok": true, "soundVolume": 1.0, "serverTime": 1_700_000_000_000_u64, "name": "Añ" }),
            &[],
        );
        assert_eq!(reply.status(), 200);
        assert_security_headers(&reply);
        assert_eq!(
            header(&reply, "content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(header(&reply, "cache-control"), Some("no-store"));
        let length = header(&reply, "content-length").unwrap().to_string();
        let text = text_of(reply).await;
        // 1 and not 1.0: the pages compare and print these numbers.
        assert_eq!(
            text,
            "{\"ok\":true,\"soundVolume\":1,\"serverTime\":1700000000000,\"name\":\"Añ\"}"
        );
        assert_eq!(length, text.len().to_string(), "bytes, not characters");
    }

    #[tokio::test]
    async fn send_json_headers_come_last_and_win() {
        let reply = send_json(
            201,
            &json!([]),
            &[
                ("X-Library-Rev", "7"),
                ("Cache-Control", "max-age=5"),
                ("Connection", "close"),
            ],
        );
        assert_eq!(reply.status(), 201);
        assert_eq!(header(&reply, "x-library-rev"), Some("7"));
        assert_eq!(header(&reply, "cache-control"), Some("max-age=5"));
        assert_eq!(header(&reply, "connection"), Some("close"));
        assert_eq!(reply.headers().get_all("cache-control").iter().count(), 1);
        assert_eq!(text_of(reply).await, "[]");
    }

    #[tokio::test]
    async fn an_error_becomes_its_status_and_json() {
        let error = HttpError::new(401, say("server.auth.unpaired"))
            .with("code", "unpaired")
            .with("serverTime", 1_700_000_000_000_u64);
        assert_eq!(error.status, 401);
        assert_eq!(error.message(), english_of("server.auth.unpaired"));
        assert_eq!(error.to_string(), english_of("server.auth.unpaired"));
        assert_eq!(error.text, Some(say("server.auth.unpaired")));
        let reply = error_response(&error, "es", &[("Connection", "close")]);
        assert_eq!(reply.status(), 401);
        assert_security_headers(&reply);
        assert_eq!(header(&reply, "connection"), Some("close"));
        let expected = format!(
            "{{\"error\":{},\"code\":\"unpaired\",\"serverTime\":1700000000000}}",
            Value::String(render(&say("server.auth.unpaired").into(), "es"))
        );
        assert_eq!(text_of(reply).await, expected);
        // The Spanish is not the English (the repository's files are in use).
        assert_ne!(
            render(&say("server.auth.unpaired").into(), "es"),
            english_of("server.auth.unpaired")
        );

        // Text from elsewhere is sent as it is, in any language.
        let plain = HttpError::new(502, "OBS said no");
        assert_eq!(plain.text, None);
        assert_eq!(plain.body("es"), json!({ "error": "OBS said no" }));
        assert_eq!(error_text(&plain), "OBS said no");
        // A conflict carries the revision.
        let conflict = HttpError::new(409, say("server.library.conflict")).with("libraryRev", 12);
        assert_eq!(
            stringify(&conflict.body("en")),
            format!(
                "{{\"error\":{},\"libraryRev\":12}}",
                Value::String(english_of("server.library.conflict"))
            )
        );
    }

    #[test]
    fn content_types_by_ending() {
        let cases = [
            ("a.html", "text/html; charset=utf-8"),
            ("a.js", "text/javascript; charset=utf-8"),
            ("a.css", "text/css; charset=utf-8"),
            ("a.js.map", "application/json"),
            ("a.svg", "image/svg+xml"),
            ("a.wav", "audio/wav"),
            ("a.mp3", "audio/mpeg"),
            ("a.woff2", "font/woff2"),
            ("a.webmanifest", "application/manifest+json"),
            ("a.png", "image/png"),
            ("a.json", "application/json; charset=utf-8"),
            ("A.HTML", "text/html; charset=utf-8"),
            ("a.txt", "application/octet-stream"),
            ("a", "application/octet-stream"),
            (".html", "application/octet-stream"),
            ("a.", "application/octet-stream"),
        ];
        for (name, kind) in cases {
            assert_eq!(
                content_type(Path::new("/x").join(name).as_path()),
                kind,
                "{name}"
            );
        }
    }

    #[test]
    fn fixture_etag() {
        let cases = fixture("etag.json");
        assert!(cases.len() > 50);
        for case in cases {
            let size = case["input"]["size"].as_u64().unwrap();
            let modified = case["input"]["mtimeMs"].as_f64().unwrap();
            assert_eq!(
                etag(size, modified),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[tokio::test]
    async fn a_file_is_served_with_its_type_and_an_etag() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("eo.json");
        fs::write(&file, "{\"meta\":{\"code\":\"eo\"}}").unwrap();
        let reply = static_file(&file, Some(&HeaderMap::new())).await;
        assert_eq!(reply.status(), 200);
        assert_security_headers(&reply);
        assert_eq!(
            header(&reply, "content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(header(&reply, "cache-control"), Some("no-cache"));
        assert_eq!(header(&reply, "content-length"), Some("22"));
        let tag = header(&reply, "etag").unwrap().to_string();
        assert!(tag.starts_with("\"m-") && tag.ends_with('"'), "{tag}");
        assert_eq!(text_of(reply).await, "{\"meta\":{\"code\":\"eo\"}}");

        // "server: a locale file the browser holds is a 304"
        let mut held = HeaderMap::new();
        held.insert("if-none-match", tag.parse().unwrap());
        let reply = static_file(&file, Some(&held)).await;
        assert_eq!(reply.status(), 304);
        assert_security_headers(&reply);
        assert_eq!(header(&reply, "etag"), Some(tag.as_str()));
        assert_eq!(
            header(&reply, "content-type"),
            Some("application/json; charset=utf-8")
        );
        assert_eq!(header(&reply, "cache-control"), Some("no-cache"));
        assert_eq!(header(&reply, "content-length"), None);
        assert_eq!(text_of(reply).await, "");

        // Another tag, or no request at all, gets the file.
        held.insert("if-none-match", "\"other\"".parse().unwrap());
        assert_eq!(static_file(&file, Some(&held)).await.status(), 200);
        assert_eq!(static_file(&file, None).await.status(), 200);
    }

    #[tokio::test]
    async fn a_missing_file_or_a_folder_is_a_404_in_json() {
        let dir = tempfile::tempdir().unwrap();
        for file in [dir.path().join("nothing.html"), dir.path().to_path_buf()] {
            let reply = static_file(&file, None).await;
            assert_eq!(reply.status(), 404);
            assert_security_headers(&reply);
            assert_eq!(
                header(&reply, "content-type"),
                Some("application/json; charset=utf-8")
            );
            assert_eq!(header(&reply, "cache-control"), Some("no-store"));
            assert_eq!(
                text_of(reply).await,
                json!({ "error": english_of("server.request.notFound") }).to_string()
            );
        }
    }

    #[test]
    fn nothing_outside_the_public_folder_is_served() {
        let public = crate::paths::resolve("/app/public");
        assert_eq!(
            public_file(&public, "deck.html").unwrap(),
            public.join("deck.html")
        );
        assert_eq!(
            public_file(&public, "js/deck.js").unwrap(),
            public.join("js").join("deck.js")
        );
        assert_eq!(
            public_file(&public, "js/../deck.html").unwrap(),
            public.join("deck.html")
        );
        for outside in [
            "../config.json",
            "..",
            "",
            ".",
            "js/../../secret",
            "../public-other/x",
            "../publicx",
        ] {
            let error = public_file(&public, outside).unwrap_err();
            assert_eq!(error.status, 403, "{outside}");
            assert_eq!(error.text, Some(say("server.request.forbidden")));
        }
        // "/locales/..%2Fdeck.html": the address is not decoded, so this is
        // just an odd name inside the folder, and a 404 when it is read.
        let locales = public.join("locales");
        assert_eq!(
            locale_file(&locales, "es.json").unwrap(),
            locales.join("es.json")
        );
        assert_eq!(
            locale_file(&locales, "..%2Fdeck.html").unwrap(),
            locales.join("..%2Fdeck.html")
        );
        for outside in ["../deck.html", "..", ".", "a/b.json"] {
            assert_eq!(
                locale_file(&locales, outside).unwrap_err().status,
                403,
                "{outside}"
            );
        }
    }

    fn json_type() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        headers
    }

    #[test]
    fn which_content_types_count_as_json() {
        for kind in [
            "application/json",
            "Application/JSON",
            "application/json; charset=utf-8",
            "application/json;x",
            "application/json+x",
            "application/json ",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", kind.parse().unwrap());
            assert!(is_json_type(&headers), "{kind}");
        }
        for kind in [
            "text/plain",
            "application/jsonp",
            "application/json5",
            "application/json_x",
            " application/json",
            "application/x-www-form-urlencoded",
            "multipart/form-data",
            "",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", kind.parse().unwrap());
            assert!(!is_json_type(&headers), "{kind}");
        }
        assert!(!is_json_type(&HeaderMap::new()));
    }

    // tests/security.test.mjs: "CSRF: text/plain form-style POST refused"
    #[tokio::test]
    async fn a_body_that_does_not_say_json_is_a_415() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "text/plain".parse().unwrap());
        let error = json_body(
            &headers,
            Body::from("{\"profileId\":\"x\",\"buttonId\":\"y\"}"),
            JSON_LIMIT,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 415);
        assert_eq!(error.text, Some(say("server.request.notJsonType")));
        // Asked before the size: an oversized form post is still a 415.
        let error = json_body(&headers, Body::from(vec![b'x'; JSON_LIMIT + 1]), JSON_LIMIT)
            .await
            .unwrap_err();
        assert_eq!(error.status, 415);
    }

    #[tokio::test]
    async fn json_bodies_are_objects() {
        let read = |text: &'static str| async move {
            json_body(&json_type(), Body::from(text), JSON_LIMIT).await
        };
        assert_eq!(
            read("{\"a\":1,\"b\":[true,null]}").await.unwrap(),
            json!({ "a": 1, "b": [true, null] })
                .as_object()
                .unwrap()
                .clone()
        );
        assert_eq!(read("").await.unwrap(), Map::new());
        assert_eq!(read(" {} ").await.unwrap(), Map::new());
        for bad in [
            "{ this is not json",
            "{'a':1}",
            "{\"a\":1,}",
            "\u{feff}{}",
            "undefined",
        ] {
            let error = read(bad).await.unwrap_err();
            assert_eq!(
                (error.status, error.text.clone()),
                (400, Some(say("server.request.badJson"))),
                "{bad}"
            );
        }
        for not_object in ["[]", "null", "1", "\"x\"", "true", "[{}]"] {
            let error = read(not_object).await.unwrap_err();
            assert_eq!(
                (error.status, error.text.clone()),
                (400, Some(say("server.request.notObject"))),
                "{not_object}"
            );
        }
    }

    #[test]
    fn the_json_limit_is_256_kib() {
        assert_eq!(JSON_LIMIT, 262_144);
    }

    // tests/security.test.mjs: "An oversized body gets a 413 reply, not a reset"
    #[tokio::test]
    async fn a_declared_length_over_the_limit_is_refused_before_reading() {
        let big = json!({ "accent": "#123456", "padding": "x".repeat(300 * 1024) }).to_string();
        let mut headers = json_type();
        headers.insert("content-length", big.len().to_string().parse().unwrap());
        // The body is a stream that would fail if it were read.
        let unread = Body::from_stream(futures_util::stream::once(async {
            Err::<Bytes, std::io::Error>(std::io::Error::other("read"))
        }));
        let error = json_body(&headers, unread, JSON_LIMIT).await.unwrap_err();
        assert_eq!(error.status, 413);
        assert_eq!(error.text, Some(say("server.request.tooLarge")));
        assert!(error.message().contains("too large"), "{}", error.message());
        assert_eq!(
            error_response(&error, "en", &[("Connection", "close")]).status(),
            413
        );
    }

    // "An oversized body without a length gets a 413 reply too"
    #[tokio::test]
    async fn a_stream_over_the_limit_is_refused_as_it_passes_it() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = (0..10)
            .map(|_| Ok(Bytes::from(vec![b'x'; 40 * 1024])))
            .collect();
        let error = raw_body(
            &HeaderMap::new(),
            Body::from_stream(futures_util::stream::iter(chunks)),
            JSON_LIMIT,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 413);
        assert_eq!(error.text, Some(say("server.request.tooLarge")));
    }

    #[tokio::test]
    async fn a_body_up_to_the_limit_is_kept_whole() {
        let exact = vec![b'a'; 1000];
        let mut headers = HeaderMap::new();
        headers.insert("content-length", "1000".parse().unwrap());
        assert_eq!(
            raw_body(&headers, Body::from(exact.clone()), 1000)
                .await
                .unwrap(),
            Bytes::from(exact.clone())
        );
        assert_eq!(
            raw_body(&headers, Body::from(exact), 999)
                .await
                .unwrap_err()
                .status,
            413
        );
        async fn streamed(limit: usize) -> Result<Bytes, HttpError> {
            let chunks: Vec<Result<Bytes, std::io::Error>> =
                vec![Ok(Bytes::from_static(b"ab")), Ok(Bytes::from_static(b"cd"))];
            raw_body(
                &HeaderMap::new(),
                Body::from_stream(futures_util::stream::iter(chunks)),
                limit,
            )
            .await
        }
        assert_eq!(streamed(4).await.unwrap(), Bytes::from_static(b"abcd"));
        assert_eq!(streamed(3).await.unwrap_err().status, 413);
        // A length that is not a number says nothing.
        let mut odd = HeaderMap::new();
        odd.insert("content-length", "soon".parse().unwrap());
        assert_eq!(
            raw_body(&odd, Body::from("abc"), 10).await.unwrap(),
            Bytes::from_static(b"abc")
        );
    }

    #[tokio::test]
    async fn a_broken_stream_is_an_error_in_its_own_words() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from_static(b"ab")),
            Err(std::io::Error::other("the line dropped")),
        ];
        let error = raw_body(
            &HeaderMap::new(),
            Body::from_stream(futures_util::stream::iter(chunks)),
            100,
        )
        .await
        .unwrap_err();
        assert_eq!(error.status, 500);
        assert!(
            error.message().contains("the line dropped"),
            "{}",
            error.message()
        );
        assert_eq!(error.text, None);
    }
}
