//! Google's Material Symbols (fonts.google.com/icons).
//!
//! The Control Center browses the catalog through the companion, and a picked
//! icon is stored in the deck as its vector path, so tablets never need to
//! reach Google. The catalog is cached on disk and refreshed monthly; if Google
//! is unreachable the last copy is used.
//!
//! Reading what Google answered (the catalog, an icon's SVG) is done by pure
//! functions; asking is behind [`Fetch`], so tests never touch the network.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::i18n::{say, Said, UserError};
use crate::model::icons::safe_glyph;
use crate::model::{js, Glyph};
use crate::store::stringify;

const CATALOG_URL: &str =
    "https://fonts.google.com/metadata/icons?incomplete=1&key=material_symbols";
const SVG_URL: &str = "https://fonts.gstatic.com/s/i/short-term/release/materialsymbols{style}/{name}/{variant}/24px.svg";
const STYLES: [&str; 3] = ["outlined", "rounded", "sharp"];
const MAX_AGE_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// The most that is read of one answer. The TypeScript read whatever came;
/// the catalog is a few megabytes, an icon a few hundred bytes.
const MAX_BODY: u64 = 64 * 1024 * 1024;

pub fn is_glyph_style(value: &str) -> bool {
    STYLES.contains(&value)
}

// ------------------------------------------------------------------ asking

/// What a server answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetched {
    pub status: u16,
    pub body: String,
}

impl Fetched {
    /// `response.ok`.
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// A GET over the network. An answer with any status is `Ok`; `Err` says why
/// there was no answer at all.
pub trait Fetch: Send + Sync {
    fn get(&self, url: &str) -> Result<Fetched, String>;
}

/// The real network, through `ureq` and the system's TLS. It blocks: it is
/// called inside `spawn_blocking`.
pub struct Web;

impl Fetch for Web {
    fn get(&self, url: &str) -> Result<Fetched, String> {
        let tls = native_tls::TlsConnector::new().map_err(|error| error.to_string())?;
        let agent = ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .timeout_connect(Duration::from_secs(30))
            .timeout(Duration::from_secs(300))
            .build();
        let response = match agent.get(url).call() {
            Ok(response) => response,
            // An answer all the same: the caller reads its status.
            Err(ureq::Error::Status(_, response)) => response,
            Err(error) => return Err(error.to_string()),
        };
        let status = response.status();
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(MAX_BODY)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(Fetched {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        })
    }
}

// ------------------------------------------------------------- the catalog

/// The text without `/^\)\]\}'\s*/`: the body starts with an
/// anti-JSON-hijacking prefix.
fn without_prefix(text: &str) -> &str {
    match text.strip_prefix(")]}'") {
        Some(rest) => rest.trim_start_matches(js::is_space),
        None => text,
    }
}

/// `(icon.tags ?? []).slice(0, 16).join(" ").toLowerCase()`.
fn tags_of(icon: &serde_json::Map<String, Value>) -> Result<String, String> {
    match icon.get("tags") {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::Array(tags)) => {
            let words: Vec<String> = tags
                .iter()
                .take(16)
                .map(|tag| {
                    if tag.is_null() {
                        String::new()
                    } else {
                        js::to_string(tag)
                    }
                })
                .collect();
            Ok(words.join(" ").to_lowercase())
        }
        // Anything else has no slice() or no join(): the TypeScript threw
        // here, and the whole catalog was refused.
        Some(Value::String(_)) => {
            Err("(icon.tags ?? []).slice(...).join is not a function".to_string())
        }
        Some(_) => Err("(icon.tags ?? []).slice is not a function".to_string()),
    }
}

/// `icon.categories?.[0] ?? ""`: whatever comes first, as it is.
fn category_of(icon: &serde_json::Map<String, Value>) -> Value {
    let first = match icon.get("categories") {
        Some(Value::Array(categories)) => categories.first().cloned(),
        Some(Value::Object(categories)) => categories.get("0").cloned(),
        // The first character of a text (JavaScript takes half of one that
        // needs two units; that half cannot be kept here).
        Some(Value::String(text)) => text.chars().next().map(|c| {
            if c.len_utf16() == 1 {
                json!(c.to_string())
            } else {
                json!("\u{FFFD}")
            }
        }),
        _ => None,
    };
    match first {
        None | Some(Value::Null) => json!(""),
        Some(value) => value,
    }
}

/// `icon.popularity ?? 0`, as the subtraction in the sort reads it. Something
/// that is not a number at all counts as 0 (JavaScript's order is then
/// whatever its sort makes of it).
fn popularity_of(icon: &serde_json::Map<String, Value>) -> f64 {
    match icon.get("popularity") {
        None | Some(Value::Null) => 0.0,
        Some(value) => {
            let number = js::to_number(value);
            if number.is_nan() {
                0.0
            } else {
                number
            }
        }
    }
}

/// Google's catalog as the picker wants it: `{ n, t, c }` for each icon
/// (name, tags, first category), the most popular first.
pub fn parse_catalog(text: &str) -> Result<Vec<Value>, String> {
    let raw: Value =
        serde_json::from_str(without_prefix(text)).map_err(|error| error.to_string())?;
    let mut list: Vec<&serde_json::Map<String, Value>> =
        match raw.get("icons").and_then(Value::as_array) {
            Some(icons) if raw.is_object() => icons
                .iter()
                .filter_map(Value::as_object)
                .filter(|icon| icon.get("name").is_some_and(Value::is_string))
                .collect(),
            _ => Vec::new(),
        };
    // A stable sort, like JavaScript's: equals stay in Google's order.
    list.sort_by(|a, b| popularity_of(b).total_cmp(&popularity_of(a)));
    list.into_iter()
        .map(|icon| {
            Ok(json!({
                "n": icon.get("name").cloned().unwrap_or_default(),
                "t": tags_of(icon)?,
                "c": category_of(icon),
            }))
        })
        .collect()
}

// ------------------------------------------------------------------ an SVG

/// `svg.match(/viewBox="([^"]+)"/)?.[1]`.
fn view_box_of(svg: &str) -> Option<&str> {
    const OPENING: &str = "viewBox=\"";
    let mut from = 0;
    while let Some(found) = svg[from..].find(OPENING) {
        let start = from + found + OPENING.len();
        if let Some(length) = svg[start..].find('"') {
            if length > 0 {
                return Some(&svg[start..start + length]);
            }
        }
        from += found + 1;
    }
    None
}

/// `[...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)]`: the `d` of every path.
/// As that expression reads it: within a tag, the last ` d="…"` that has
/// something in it.
fn paths_of(svg: &str) -> Vec<&str> {
    const TAG: &str = "<path";
    const OPENING: &str = "d=\"";
    let mut paths = Vec::new();
    let mut from = 0;
    while let Some(found) = svg[from..].find(TAG) {
        let after = from + found + TAG.len();
        // [^>]* runs to the tag's end at most; the white space before d= is in it.
        let end = svg[after..].find('>').map_or(svg.len(), |at| after + at);
        let matched = svg[after..end]
            .char_indices()
            .rev()
            .filter(|(_, c)| js::is_space(*c))
            .find_map(|(at, c)| {
                let start = after + at + c.len_utf8();
                let value = svg[start..].strip_prefix(OPENING)?;
                let length = value.find('"').filter(|length| *length > 0)?;
                let start = start + OPENING.len();
                Some((start, start + length))
            });
        match matched {
            Some((start, close)) => {
                paths.push(&svg[start..close]);
                from = close + 1;
            }
            None => from += found + 1,
        }
    }
    paths
}

/// The glyph in an SVG Google sent, or None when it is not one this deck can draw.
pub fn glyph_from_svg(name: &str, style: &str, fill: bool, svg: &str) -> Option<Glyph> {
    let mut glyph = json!({
        "source": "google", "name": name, "style": style, "fill": fill, "paths": paths_of(svg),
    });
    if let Some(view_box) = view_box_of(svg) {
        glyph["viewBox"] = json!(view_box);
    }
    safe_glyph(&glyph)
}

/// `/^[a-z0-9_]{1,64}$/`.
fn is_icon_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Where an icon's SVG is, once its name and style are known to be sound.
fn glyph_url(name: &str, style: &str, fill: bool) -> String {
    SVG_URL
        .replace("{style}", style)
        .replace("{name}", name)
        .replace("{variant}", if fill { "fill1" } else { "default" })
}

/// Why an icon could not be had.
#[derive(Clone, Debug, PartialEq)]
pub enum GlyphError {
    /// A reason for a person: a bad name, no such icon, an odd answer.
    User(UserError),
    /// Google could not be reached (the TypeScript's `fetch` threw).
    Unreachable(String),
}

impl GlyphError {
    /// What to tell whoever asked (`textOf(error)`).
    pub fn said(&self) -> Said {
        match self {
            GlyphError::User(error) => Said::Text(error.text.clone()),
            GlyphError::Unreachable(reason) => Said::Plain(reason.clone()),
        }
    }
}

impl fmt::Display for GlyphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GlyphError::User(error) => error.fmt(f),
            GlyphError::Unreachable(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for GlyphError {}

impl From<UserError> for GlyphError {
    fn from(error: UserError) -> GlyphError {
        GlyphError::User(error)
    }
}

// --------------------------------------------------------------- the icons

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

#[derive(Default)]
struct Memory {
    catalog: Option<Arc<Vec<Value>>>,
    glyphs: HashMap<String, Glyph>,
}

/// The catalog and the icons picked from it (`createGoogleIcons`).
pub struct GoogleIcons {
    cache_dir: PathBuf,
    catalog_file: PathBuf,
    fetch: Arc<dyn Fetch>,
    now: Clock,
    memory: Mutex<Memory>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The cached catalog: when it was fetched, and its icons as they were written.
fn read_cache(file: &Path) -> Option<(f64, Vec<Value>)> {
    let bytes = fs::read(file).ok()?;
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let fields = data.as_object()?;
    let fetched_at = fields.get("fetchedAt")?.as_f64()?;
    Some((fetched_at, fields.get("icons")?.as_array()?.clone()))
}

impl GoogleIcons {
    pub fn new(cache_dir: impl Into<PathBuf>) -> GoogleIcons {
        GoogleIcons::with(
            cache_dir,
            Arc::new(Web),
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|since| since.as_millis() as u64)
                    .unwrap_or(0)
            }),
        )
    }

    /// As `new`, with the network and the clock given.
    pub fn with(cache_dir: impl Into<PathBuf>, fetch: Arc<dyn Fetch>, now: Clock) -> GoogleIcons {
        let cache_dir: PathBuf = cache_dir.into();
        GoogleIcons {
            catalog_file: cache_dir.join("material-symbols.json"),
            cache_dir,
            fetch,
            now,
            memory: Mutex::new(Memory::default()),
        }
    }

    async fn get(&self, url: String) -> Result<Fetched, String> {
        let fetch = Arc::clone(&self.fetch);
        match tokio::task::spawn_blocking(move || fetch.get(&url)).await {
            Ok(answer) => answer,
            Err(error) => Err(error.to_string()),
        }
    }

    async fn fresh_catalog(&self) -> Result<Vec<Value>, String> {
        let response = self.get(CATALOG_URL.to_string()).await?;
        if !response.ok() {
            return Err(format!("HTTP {}", response.status));
        }
        let icons = parse_catalog(&response.body)?;
        fs::create_dir_all(&self.cache_dir).map_err(|error| error.to_string())?;
        let file = json!({ "fetchedAt": (self.now)(), "icons": icons });
        fs::write(&self.catalog_file, stringify(&file)).map_err(|error| error.to_string())?;
        Ok(icons)
    }

    /// Every icon there is, the most popular first.
    pub async fn load_catalog(&self) -> Result<Arc<Vec<Value>>, UserError> {
        if let Some(catalog) = &lock(&self.memory).catalog {
            return Ok(Arc::clone(catalog));
        }
        let keep = |icons: Vec<Value>| {
            let catalog = Arc::new(icons);
            lock(&self.memory).catalog = Some(Arc::clone(&catalog));
            catalog
        };
        let mut cached = read_cache(&self.catalog_file);
        if let Some((fetched_at, icons)) = &mut cached {
            if (self.now)() as f64 - *fetched_at < MAX_AGE_MS {
                return Ok(keep(std::mem::take(icons)));
            }
        }
        match self.fresh_catalog().await {
            Ok(icons) => Ok(keep(icons)),
            Err(reason) => match cached {
                Some((_, icons)) => Ok(keep(icons)),
                None => Err(UserError::new(
                    say("server.icons.catalogFailed").with("reason", Said::Plain(reason)),
                )),
            },
        }
    }

    /// One icon as vector paths, for the deck to keep.
    pub async fn load_glyph(
        &self,
        name: &str,
        style: &str,
        fill: bool,
    ) -> Result<Glyph, GlyphError> {
        if !is_icon_name(name) {
            return Err(UserError::new(say("server.icons.badName")).into());
        }
        if !is_glyph_style(style) {
            return Err(UserError::new(say("server.icons.badStyle")).into());
        }
        let key = format!("{style}/{name}/{}", u8::from(fill));
        if let Some(known) = lock(&self.memory).glyphs.get(&key) {
            return Ok(known.clone());
        }

        let response = self
            .get(glyph_url(name, style, fill))
            .await
            .map_err(GlyphError::Unreachable)?;
        if !response.ok() {
            return Err(UserError::new(if response.status == 404 {
                say("server.icons.noSuchIcon").with("name", name)
            } else {
                say("server.icons.badAnswer").with("status", f64::from(response.status))
            })
            .into());
        }
        let glyph = glyph_from_svg(name, style, fill, &response.body)
            .ok_or_else(|| UserError::new(say("server.icons.badShape")))?;
        lock(&self.memory).glyphs.insert(key, glyph.clone());
        Ok(glyph)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::TextVar;

    /// A network that answers what it was told to, and remembers what was asked.
    struct Fake {
        answer: Result<Fetched, String>,
        asked: Mutex<Vec<String>>,
    }

    impl Fake {
        fn answering(status: u16, body: &str) -> Arc<Fake> {
            Arc::new(Fake {
                answer: Ok(Fetched {
                    status,
                    body: body.to_string(),
                }),
                asked: Mutex::default(),
            })
        }

        fn unreachable() -> Arc<Fake> {
            Arc::new(Fake {
                answer: Err("fetch failed".to_string()),
                asked: Mutex::default(),
            })
        }

        /// From a fixture: `{ status, body }`, or null when there is no network.
        fn from(value: &Value) -> Arc<Fake> {
            match value["status"].as_u64() {
                Some(status) => {
                    Fake::answering(status as u16, value["body"].as_str().expect("a body"))
                }
                None => Fake::unreachable(),
            }
        }

        fn asked(&self) -> Vec<String> {
            lock(&self.asked).clone()
        }
    }

    impl Fetch for Fake {
        fn get(&self, url: &str) -> Result<Fetched, String> {
            lock(&self.asked).push(url.to_string());
            self.answer.clone()
        }
    }

    fn cases(file: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/auth")
            .join(file);
        let text =
            fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    fn icons_at(dir: &Path, fake: &Arc<Fake>, now: u64) -> GoogleIcons {
        GoogleIcons::with(
            dir,
            Arc::clone(fake) as Arc<dyn Fetch>,
            Arc::new(move || now),
        )
    }

    /// An error as the fixtures write it: the message's key and its values.
    /// A reason is compared only when it is an HTTP status: the rest is
    /// JavaScript's own wording of what went wrong.
    fn error_json(error: &UserError) -> Value {
        let mut vars = serde_json::Map::new();
        for (name, value) in &error.text.vars {
            let value = match value {
                TextVar::Str(text) if name == "reason" && !text.starts_with("HTTP ") => json!("*"),
                TextVar::Str(text) => json!(text),
                // 404 and not 404.0, as the fixture has it.
                TextVar::Num(number) => {
                    serde_json::from_str(&crate::store::js_number(*number)).unwrap_or(Value::Null)
                }
                TextVar::Text(text) => json!(text.key),
            };
            vars.insert(name.clone(), value);
        }
        json!({ "error": error.text.key, "vars": vars })
    }

    #[tokio::test]
    async fn catalogs_match_the_typescript() {
        let all = cases("google-catalog.json");
        assert!(all.len() >= 30, "{} cases", all.len());
        for case in &all {
            let name = case["name"].as_str().expect("a name");
            let input = &case["input"];
            let dir = tempfile::tempdir().expect("a folder");
            let cache_dir = dir.path().join("cache");
            let file = cache_dir.join("material-symbols.json");
            if let Some(cache) = input["cache"].as_str() {
                fs::create_dir_all(&cache_dir).expect("cache");
                fs::write(&file, cache).expect("the cache");
            }
            if input["blocked"] == true {
                // A file where the cache folder goes: nothing can be written.
                fs::write(&cache_dir, "in the way").expect("a file");
            }
            let fake = Fake::from(&input["fetch"]);
            let icons = icons_at(&cache_dir, &fake, input["now"].as_u64().expect("a time"));
            let ours = match icons.load_catalog().await {
                Ok(catalog) => json!({ "icons": *catalog }),
                Err(error) => error_json(&error),
            };
            let output = &case["output"];
            assert_eq!(output["result"], ours, "{name}: the catalog");
            assert_eq!(
                output["asked"],
                json!(fake.asked()),
                "{name}: what was asked"
            );
            let stored = fs::read_to_string(&file).map_or(Value::Null, Value::String);
            assert_eq!(output["file"], stored, "{name}: the cache file");
            // Asked again, it answers from memory.
            let again = match icons.load_catalog().await {
                Ok(catalog) => json!({ "icons": *catalog }),
                Err(error) => error_json(&error),
            };
            assert_eq!(output["again"], again, "{name}: the second time");
            assert_eq!(
                output["askedAgain"],
                json!(fake.asked().len()),
                "{name}: asked again"
            );
        }
    }

    #[tokio::test]
    async fn glyphs_match_the_typescript() {
        let all = cases("google-glyph.json");
        assert!(all.len() >= 40, "{} cases", all.len());
        for case in &all {
            let name = case["name"].as_str().expect("a name");
            let input = &case["input"];
            let dir = tempfile::tempdir().expect("a folder");
            let fake = Fake::from(&input["fetch"]);
            let icons = icons_at(dir.path(), &fake, 1_750_000_000_000);
            let load = || {
                icons.load_glyph(
                    input["name"].as_str().expect("a name"),
                    input["style"].as_str().expect("a style"),
                    input["fill"] == true,
                )
            };
            let shown = |result: Result<Glyph, GlyphError>| match result {
                Ok(glyph) => json!({ "glyph": glyph }),
                Err(GlyphError::User(error)) => error_json(&error),
                Err(GlyphError::Unreachable(_)) => json!({ "thrown": true }),
            };
            let output = &case["output"];
            assert_eq!(output["result"], shown(load().await), "{name}: the glyph");
            assert_eq!(
                output["asked"],
                json!(fake.asked()),
                "{name}: what was asked"
            );
            assert_eq!(
                output["again"],
                shown(load().await),
                "{name}: the second time"
            );
            assert_eq!(
                output["askedAgain"],
                json!(fake.asked().len()),
                "{name}: asked again"
            );
        }
    }

    const SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"><path d="M480-120v-80h280v-560H480v-80h280q33 0 56.500 23.500T840-760v560q0 33-23.500 56.500T760-120H480Z"/></svg>"##;

    #[test]
    fn an_svg_gives_its_view_box_and_paths() {
        assert_eq!(view_box_of(SVG), Some("0 -960 960 960"));
        assert_eq!(paths_of(SVG).len(), 1);
        let glyph = glyph_from_svg("login", "rounded", true, SVG).expect("a glyph");
        assert_eq!(glyph.name, "login");
        assert_eq!(glyph.view_box, "0 -960 960 960");
        assert!(glyph.fill && glyph.paths[0].starts_with("M480-120"));
        // Two paths, attributes before d, and an id that only ends in d.
        let two = r#"<svg viewBox="0 0 24 24"><path fill="none" d="M0 0h24v24H0z"/><path id="d" d="M1 1L2 2"/></svg>"#;
        assert_eq!(paths_of(two), vec!["M0 0h24v24H0z", "M1 1L2 2"]);
        // No white space before d=, an empty d, no viewBox.
        assert!(paths_of(r#"<path id="d="M1 1"/>"#).is_empty());
        assert!(paths_of(r#"<path d=""/>"#).is_empty());
        assert_eq!(view_box_of(r#"<svg viewBox="" x="1">"#), None);
        assert!(glyph_from_svg("x", "outlined", false, r#"<svg><path d="M1 1"/></svg>"#).is_none());
    }

    #[test]
    fn names_styles_and_addresses() {
        assert!(is_glyph_style("outlined") && is_glyph_style("rounded") && is_glyph_style("sharp"));
        assert!(!is_glyph_style("Outlined") && !is_glyph_style(""));
        assert!(is_icon_name("mic_off") && is_icon_name("10k") && is_icon_name(&"a".repeat(64)));
        assert!(!is_icon_name("") && !is_icon_name("Mic") && !is_icon_name("a/b"));
        assert!(!is_icon_name(&"a".repeat(65)) && !is_icon_name("mic\n"));
        assert_eq!(
            glyph_url("mic_off", "sharp", true),
            "https://fonts.gstatic.com/s/i/short-term/release/materialsymbolssharp/mic_off/fill1/24px.svg"
        );
        assert_eq!(
            glyph_url("home", "outlined", false),
            "https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/home/default/24px.svg"
        );
    }

    #[tokio::test]
    async fn the_catalog_is_refreshed_after_thirty_days() {
        let dir = tempfile::tempdir().expect("a folder");
        let body = r#")]}'
{"icons":[{"name":"home","popularity":5,"tags":["House"],"categories":["maps"]}]}"#;
        let now = 1_750_000_000_000u64;
        let fake = Fake::answering(200, body);
        let first = icons_at(dir.path(), &fake, now)
            .load_catalog()
            .await
            .expect("a catalog");
        assert_eq!(
            json!(*first),
            json!([{ "n": "home", "t": "house", "c": "maps" }])
        );
        let file = dir.path().join("material-symbols.json");
        assert_eq!(
            fs::read_to_string(&file).expect("the cache"),
            r#"{"fetchedAt":1750000000000,"icons":[{"n":"home","t":"house","c":"maps"}]}"#
        );
        // A day short of the month: the file answers, Google is not asked.
        let month = MAX_AGE_MS as u64;
        let quiet = Fake::unreachable();
        let cached = icons_at(dir.path(), &quiet, now + month - 1)
            .load_catalog()
            .await;
        assert_eq!(*cached.expect("the cached catalog"), *first);
        assert!(quiet.asked().is_empty());
        // The month over and Google unreachable: the last copy is used.
        let late = icons_at(dir.path(), &quiet, now + month)
            .load_catalog()
            .await;
        assert_eq!(*late.expect("the last copy"), *first);
        assert_eq!(quiet.asked(), vec![CATALOG_URL]);
        // No copy and no Google: an error that says so.
        let empty = tempfile::tempdir().expect("a folder");
        let error = icons_at(empty.path(), &quiet, now)
            .load_catalog()
            .await
            .expect_err("no catalog");
        assert_eq!(
            error.message(),
            "Could not reach Google Fonts to list icons. (fetch failed)"
        );
    }

    /// Asks Google itself: `cargo test -- --ignored the_real_network`.
    #[tokio::test]
    #[ignore = "needs the internet"]
    async fn the_real_network_answers() {
        let dir = tempfile::tempdir().expect("a folder");
        let icons = GoogleIcons::new(dir.path());
        let catalog = icons.load_catalog().await.expect("the catalog");
        assert!(catalog.len() > 1000, "{} icons", catalog.len());
        assert!(dir.path().join("material-symbols.json").exists());
        let glyph = icons
            .load_glyph("home", "rounded", true)
            .await
            .expect("an icon");
        assert_eq!(glyph.view_box, "0 -960 960 960");
        let missing = icons
            .load_glyph("no_such_icon_at_all", "sharp", false)
            .await;
        match missing {
            Err(GlyphError::User(error)) => assert_eq!(error.text.key, "server.icons.noSuchIcon"),
            other => panic!("{other:?}"),
        }
    }
}
