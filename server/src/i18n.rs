//! Every word the interface says comes from a locale file, public/locales/
//! `<code>.json`: `{ "meta": { "name", "code" }, "messages": { key: text } }`.
//! Adding a language is adding one file; nothing here names a language but
//! English, which every other one falls back to, key by key.
//!
//! The first half is the part the pages share (matching languages, plurals,
//! placeholders, a translator for one language). The second half is the
//! companion's side: it lists the locale files (so a file dropped in there is
//! offered with no code change), and words what it sends people (errors,
//! notes, toasts) in the language of whoever asked. Lines for the terminal
//! and companion.log stay English.
//!
//! Code deep inside the companion does not know who asked, so it returns a
//! [`UserError`] naming a message key and its values; the reply is translated
//! where the request is known. Its message is the English text, so logs and
//! anything that only prints the error keep working.

use std::collections::{HashMap, HashSet};
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, RwLock};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use serde::Serialize;
use serde_json::Value;

use crate::store::{is_js_space, js_number, js_to_number, js_trim, shortest_digits};
use crate::translate::{Translate, Var};

/// The messages of one locale file: a text, or an object of plural forms
/// (the CLDR category, "one", "few"…, picks the text; "other" is required).
pub type Messages = serde_json::Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocaleMeta {
    /// The language's own name for itself ("Español"), as the picker lists it.
    pub name: String,
    /// The file's name without .json: "es", "pt-BR".
    pub code: String,
}

#[derive(Debug, Clone)]
pub struct LocaleFile {
    pub meta: LocaleMeta,
    pub messages: Arc<Messages>,
}

/// A language the companion has a file for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LanguageInfo {
    pub code: String,
    pub name: String,
}

pub const FALLBACK_LANGUAGE: &str = "en";
/// "auto" follows each device's own language; a code fixes one for all.
pub const AUTO_LANGUAGE: &str = "auto";

/// The plural categories CLDR knows; a locale file may use any of them.
pub const PLURAL_CATEGORIES: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

pub fn is_plural_message(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|forms| forms.get("other").is_some_and(Value::is_string))
}

/// Whether a parsed file has the shape of a locale file.
pub fn is_locale_file(value: &Value) -> bool {
    let Some(file) = value.as_object() else {
        return false;
    };
    let meta_ok = file.get("meta").is_some_and(|meta| {
        meta.get("name").is_some_and(Value::is_string)
            && meta.get("code").is_some_and(Value::is_string)
    });
    meta_ok && file.get("messages").is_some_and(Value::is_object)
}

/// Whether text is shaped like a language code ("es", "pt-BR"): two or three
/// letters, then any number of "-" and two to eight letters or digits.
pub fn is_code_shape(text: &str) -> bool {
    let mut parts = text.split('-');
    let language_ok = parts.next().is_some_and(|part| {
        (2..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphabetic())
    });
    language_ok
        && parts.all(|part| {
            (2..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
        })
}

/// Language codes compare without case, with "_" read as "-" (es_CO is es-CO).
fn tidy_code(code: &str) -> String {
    js_trim(code).replace('_', "-").to_lowercase()
}

fn base_of(code: &str) -> &str {
    code.split('-').next().unwrap_or("")
}

/// The best available file for the languages a person reads, in their order of
/// preference: an exact match ("pt-BR"), else the base language ("es-CO" is
/// served by "es"), else a regional file of the same language ("pt" by
/// "pt-BR"). None when none fits.
pub fn match_language<W: AsRef<str>, A: AsRef<str>>(
    wanted: &[W],
    available: &[A],
) -> Option<String> {
    let tidy: Vec<String> = available
        .iter()
        .map(|code| tidy_code(code.as_ref()))
        .collect();
    let found = |index: usize| Some(available[index].as_ref().to_string());
    for code in wanted {
        let code = tidy_code(code.as_ref());
        if code.is_empty() {
            continue;
        }
        if let Some(exact) = tidy.iter().position(|other| *other == code) {
            return found(exact);
        }
        let base = base_of(&code);
        if let Some(index) = tidy.iter().position(|other| other == base) {
            return found(index);
        }
        if let Some(index) = tidy.iter().position(|other| base_of(other) == base) {
            return found(index);
        }
    }
    None
}

/// The language to speak: a fixed setting if there is a file for it, else
/// the reader's own languages matched to the files, else English.
pub fn resolve_language<P: AsRef<str>, A: AsRef<str>>(
    setting: Option<&str>,
    preferred: &[P],
    available: &[A],
) -> String {
    if let Some(setting) =
        setting.filter(|setting| !setting.is_empty() && *setting != AUTO_LANGUAGE)
    {
        if let Some(fixed) = match_language(&[setting], available) {
            return fixed;
        }
    }
    match_language(preferred, available).unwrap_or_else(|| FALLBACK_LANGUAGE.to_string())
}

/// `^\s*q\s*=\s*([0-9.]+)\s*$`: the weight in one piece of an Accept-Language entry.
fn weight_of(piece: &str) -> Option<f64> {
    let rest = piece.trim_start_matches(is_js_space).strip_prefix('q')?;
    let rest = rest.trim_start_matches(is_js_space).strip_prefix('=')?;
    let digits = js_trim(rest);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    Some(js_to_number(digits))
}

/// The languages in an Accept-Language header, most wanted first.
pub fn parse_accept_language(header: Option<&str>) -> Vec<String> {
    let Some(header) = header.filter(|header| !header.is_empty()) else {
        return Vec::new();
    };
    let mut entries: Vec<(String, f64)> = Vec::new();
    for part in header.split(',') {
        let mut pieces = js_trim(part).split(';');
        let code = js_trim(pieces.next().unwrap_or(""));
        if code.is_empty() || code == "*" {
            continue;
        }
        let mut q = 1.0;
        for piece in pieces {
            if let Some(weight) = weight_of(piece) {
                q = weight;
            }
        }
        if q > 0.0 {
            entries.push((code.to_string(), q));
        }
    }
    // By weight, and as written among equals (the sort keeps their order).
    entries.sort_by(|a, b| {
        let difference = b.1 - a.1;
        if difference < 0.0 {
            std::cmp::Ordering::Less
        } else if difference > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    entries.into_iter().map(|entry| entry.0).collect()
}

// ------------------------------------------------------------------ plurals

/// The number as the plural rules see it: `Intl.PluralRules` formats it
/// first, with at most three decimals (halves away from zero) and no
/// trailing zeros, starting from the shortest digits that name the number.
fn plural_number(count: f64) -> String {
    // A whole number is read digit for digit, also past the point where
    // doubles stop holding every integer (ICU does the same up to 2^63).
    if count.fract() == 0.0 && count.abs() < 9.2e18 {
        return format!("{:.0}", count.abs());
    }
    let (digits, exponent) = shortest_digits(count.abs());
    // Digits before the point, then those after it.
    let point = exponent + 1;
    let (mut whole, mut fraction): (Vec<u8>, Vec<u8>) = if point <= 0 {
        (
            vec![b'0'],
            [vec![b'0'; (-point) as usize], digits.into_bytes()].concat(),
        )
    } else if point as usize >= digits.len() {
        let zeros = point as usize - digits.len();
        (
            [digits.into_bytes(), vec![b'0'; zeros]].concat(),
            Vec::new(),
        )
    } else {
        let (a, b) = digits.as_bytes().split_at(point as usize);
        (a.to_vec(), b.to_vec())
    };
    if fraction.len() > 3 {
        let up = fraction[3] >= b'5';
        fraction.truncate(3);
        if up {
            let mut carry = true;
            for digit in fraction.iter_mut().rev().chain(whole.iter_mut().rev()) {
                if *digit == b'9' {
                    *digit = b'0';
                } else {
                    *digit += 1;
                    carry = false;
                    break;
                }
            }
            if carry {
                whole.insert(0, b'1');
            }
        }
    }
    while fraction.last() == Some(&b'0') {
        fraction.pop();
    }
    let mut text = String::from_utf8_lossy(&whole).into_owned();
    if !fraction.is_empty() {
        text.push('.');
        text.push_str(&String::from_utf8_lossy(&fraction));
    }
    text
}

/// The rules for a language, or None for something that is not a language
/// code at all (where `new Intl.PluralRules` throws).
fn plural_rules(code: &str) -> Option<icu_plurals::PluralRules> {
    if code.contains('_') {
        return None;
    }
    let locale = icu_locale_core::Locale::try_from_str(code).ok()?;
    icu_plurals::PluralRules::try_new_cardinal((&locale).into()).ok()
}

/// The CLDR category for a count: "one", "few", "other"… Where the code is
/// not a language code, 1 is "one" and everything else "other", which is
/// right for English and Spanish.
pub fn plural_category(code: &str, count: f64) -> &'static str {
    let Some(rules) = plural_rules(code) else {
        return if count == 1.0 { "one" } else { "other" };
    };
    if !count.is_finite() {
        return "other";
    }
    let Ok(decimal) = fixed_decimal::Decimal::from_str(&plural_number(count)) else {
        return "other";
    };
    match rules.category_for(&decimal) {
        icu_plurals::PluralCategory::Zero => "zero",
        icu_plurals::PluralCategory::One => "one",
        icu_plurals::PluralCategory::Two => "two",
        icu_plurals::PluralCategory::Few => "few",
        icu_plurals::PluralCategory::Many => "many",
        icu_plurals::PluralCategory::Other => "other",
    }
}

// --------------------------------------------------------------- formatting

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Walks the `{name}` placeholders of a text (`/\{([A-Za-z0-9_]+)\}/g`),
/// handing the text between them to `plain` and each name to `placeholder`.
fn scan_placeholders<'a>(
    text: &'a str,
    mut plain: impl FnMut(&'a str),
    mut placeholder: impl FnMut(&'a str, &'a str),
) {
    let mut from = 0;
    let mut at = 0;
    while let Some(offset) = text[at..].find('{') {
        let open = at + offset;
        let name_end = text[open + 1..]
            .find(|c| !is_name_char(c))
            .map_or(text.len(), |i| open + 1 + i);
        if name_end > open + 1 && text[name_end..].starts_with('}') {
            plain(&text[from..open]);
            placeholder(&text[open + 1..name_end], &text[open..=name_end]);
            from = name_end + 1;
            at = from;
        } else {
            at = open + 1;
        }
    }
    plain(&text[from..]);
}

fn var_text(var: &Var) -> String {
    match var {
        Var::Text(text) => text.clone(),
        Var::Number(number) => js_number(*number),
    }
}

/// Fills `{name}` placeholders; one without a value is left as it is, so a
/// mistake shows rather than vanishing.
pub fn fill(text: &str, vars: &[(&str, Var)]) -> String {
    let out = std::cell::RefCell::new(String::with_capacity(text.len()));
    scan_placeholders(
        text,
        |plain| out.borrow_mut().push_str(plain),
        |name, whole| match vars.iter().rev().find(|(key, _)| *key == name) {
            Some((_, value)) => out.borrow_mut().push_str(&var_text(value)),
            None => out.borrow_mut().push_str(whole),
        },
    );
    out.into_inner()
}

/// The `{placeholders}` a message uses, sorted, across all its plural forms.
pub fn placeholders_of(message: &Value) -> Vec<String> {
    let texts: Vec<&str> = match message {
        Value::String(text) => vec![text.as_str()],
        Value::Object(forms) => forms.values().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let mut found: Vec<String> = Vec::new();
    for text in texts {
        scan_placeholders(
            text,
            |_| {},
            |name, _| {
                if !found.iter().any(|known| known == name) {
                    found.push(name.to_string());
                }
            },
        );
    }
    found.sort();
    found
}

/// Told about a key that is in no file at all (a typo, or a key not added yet).
pub type OnMissing = Arc<dyn Fn(&str) + Send + Sync>;

/// A `t()` for one language: its own messages, then English's, then the key itself.
#[derive(Clone)]
pub struct Translator {
    code: String,
    messages: Arc<Messages>,
    fallback: Arc<Messages>,
    on_missing: Option<OnMissing>,
}

pub fn create_translator(
    code: &str,
    messages: Arc<Messages>,
    fallback: Arc<Messages>,
    on_missing: Option<OnMissing>,
) -> Translator {
    Translator {
        code: code.to_string(),
        messages,
        fallback,
        on_missing,
    }
}

impl Translator {
    /// The language this translator speaks.
    pub fn code(&self) -> &str {
        &self.code
    }
}

impl Translate for Translator {
    fn t(&self, key: &str, vars: &[(&str, Var)]) -> String {
        let (message, code) = if let Some(message) = self.messages.get(key) {
            (message, self.code.as_str())
        } else if let Some(message) = self.fallback.get(key) {
            (message, FALLBACK_LANGUAGE)
        } else {
            if let Some(on_missing) = &self.on_missing {
                on_missing(key);
            }
            return key.to_string();
        };
        match message {
            Value::String(text) => fill(text, vars),
            Value::Object(forms) => {
                let count = match vars.iter().rev().find(|(name, _)| *name == "count") {
                    Some((_, Var::Number(count))) => *count,
                    Some((_, Var::Text(text))) => js_to_number(text),
                    None => f64::NAN,
                };
                let text = forms
                    .get(plural_category(code, count))
                    .or_else(|| forms.get("other"));
                match text {
                    Some(Value::String(text)) => fill(text, vars),
                    // A plural with no usable form: the TypeScript threw
                    // here; the key shows the mistake instead.
                    _ => key.to_string(),
                }
            }
            // Not a message at all (a number, a list): as above.
            _ => key.to_string(),
        }
    }
}

// ------------------------------------------------------- what is to be said

/// A message to be worded for whoever reads it: a key and its values. A
/// value may be another Text (a reason inside a sentence) or plain text
/// from elsewhere (OBS's own error, a file name), used as it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Text {
    pub key: String,
    pub vars: Vec<(String, TextVar)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TextVar {
    Str(String),
    Num(f64),
    Text(Text),
}

impl From<&str> for TextVar {
    fn from(value: &str) -> Self {
        TextVar::Str(value.to_string())
    }
}

impl From<String> for TextVar {
    fn from(value: String) -> Self {
        TextVar::Str(value)
    }
}

impl From<f64> for TextVar {
    fn from(value: f64) -> Self {
        TextVar::Num(value)
    }
}

impl From<Text> for TextVar {
    fn from(value: Text) -> Self {
        TextVar::Text(value)
    }
}

/// What [`text_of`] gives: a reason is used as it is inside a sentence.
impl From<Said> for TextVar {
    fn from(value: Said) -> Self {
        match value {
            Said::Text(text) => TextVar::Text(text),
            Said::Plain(text) => TextVar::Str(text),
        }
    }
}

impl Text {
    /// Adds a value: `say("server.press.ranSteps").with("count", 3.0)`.
    pub fn with(mut self, name: &str, value: impl Into<TextVar>) -> Text {
        self.vars.retain(|(known, _)| known != name);
        self.vars.push((name.to_string(), value.into()));
        self
    }
}

/// Either a message to translate, or text that has no translation (it came
/// from OBS, the system…).
#[derive(Debug, Clone, PartialEq)]
pub enum Said {
    Text(Text),
    Plain(String),
}

impl From<Text> for Said {
    fn from(value: Text) -> Self {
        Said::Text(value)
    }
}

impl From<String> for Said {
    fn from(value: String) -> Self {
        Said::Plain(value)
    }
}

impl From<&str> for Said {
    fn from(value: &str) -> Self {
        Said::Plain(value.to_string())
    }
}

/// A message by its key; values are added with [`Text::with`].
pub fn say(key: &str) -> Text {
    Text {
        key: key.to_string(),
        vars: Vec::new(),
    }
}

/// An error meant for a person. Its message is the English wording.
#[derive(Debug, Clone, PartialEq)]
pub struct UserError {
    pub text: Text,
    message: String,
}

impl UserError {
    pub fn new(text: Text) -> UserError {
        let message = english(&Said::Text(text.clone()));
        UserError { text, message }
    }

    /// The English wording, for logs.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for UserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UserError {}

/// What an error says, translatable when it came from Punchboard itself
/// (a [`UserError`] or a [`crate::http::HttpError`] made from a [`Text`]).
pub fn text_of(error: &(dyn std::error::Error + 'static)) -> Said {
    if let Some(error) = error.downcast_ref::<UserError>() {
        return Said::Text(error.text.clone());
    }
    if let Some(text) = error
        .downcast_ref::<crate::http::HttpError>()
        .and_then(|error| error.text.as_ref())
    {
        return Said::Text(text.clone());
    }
    Said::Plain(error.to_string())
}

// -------------------------------------------------------------- the files

/// `PUNCHBOARD_LOCALES_DIR` points at another folder (tests).
pub fn locales_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| match env::var_os("PUNCHBOARD_LOCALES_DIR") {
        Some(chosen) => crate::paths::resolve(chosen),
        None => crate::paths::resolve(crate::paths::paths().public.join("locales")),
    })
}

/// How long the folder is trusted before it is read again: long enough that
/// a burst of requests reads it once, short enough that a new file shows up
/// by the time anyone opens the picker.
const FRESH: Duration = Duration::from_millis(2000);

fn log(message: &str) {
    println!("[punchboard] {message}");
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

type Warned = Arc<Mutex<HashSet<String>>>;

/// Says something once.
fn warn_once(warned: &Warned, note: String, message: impl FnOnce() -> String) {
    if lock(warned).insert(note) {
        log(&message());
    }
}

#[derive(Default)]
struct Loaded {
    /// When the folder was read, and its files in the order of their names.
    files: Option<(Instant, Arc<Vec<LocaleFile>>)>,
    translators: HashMap<String, Translator>,
}

type Setting = Arc<dyn Fn() -> String + Send + Sync>;

/// The locale files of one folder and the saved language choice. The
/// companion has one ([`global`]); tests make their own.
pub struct Languages {
    dir: PathBuf,
    loaded: Mutex<Loaded>,
    warned: Warned,
    setting: RwLock<Setting>,
}

/// `name.localeCompare(other)`, near enough for a list of language names:
/// letters before their accents and case, as a person would file them.
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    use unicode_normalization::char::is_combining_mark;
    use unicode_normalization::UnicodeNormalization;
    let plain = |name: &str| {
        name.nfd()
            .filter(|c| !is_combining_mark(*c))
            .collect::<String>()
            .to_lowercase()
    };
    plain(a).cmp(&plain(b)).then_with(|| a.cmp(b))
}

impl Languages {
    pub fn new(dir: impl Into<PathBuf>) -> Languages {
        Languages {
            dir: dir.into(),
            loaded: Mutex::new(Loaded::default()),
            warned: Warned::default(),
            setting: RwLock::new(Arc::new(|| AUTO_LANGUAGE.to_string())),
        }
    }

    /// The folder the files are read from.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn read_folder(&self) -> Vec<LocaleFile> {
        let mut names: Vec<String> = Vec::new();
        match std::fs::read_dir(&self.dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.strip_suffix(".json").is_some_and(is_code_shape) {
                        names.push(name);
                    }
                }
            }
            Err(error) => {
                let dir = self.dir.display().to_string();
                warn_once(&self.warned, dir.clone(), || {
                    format!("Could not read the languages folder {dir}: {error}")
                });
            }
        }
        names.sort();
        let mut files: Vec<LocaleFile> = Vec::new();
        for name in names {
            let code = &name[..name.len() - ".json".len()];
            let parsed = std::fs::read(self.dir.join(&name))
                .map_err(|error| error.to_string())
                .and_then(|bytes| {
                    serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
                        .map_err(|error| error.to_string())
                })
                .and_then(|parsed| {
                    if is_locale_file(&parsed) {
                        Ok(parsed)
                    } else {
                        Err("it has no meta.name, meta.code or messages".to_string())
                    }
                });
            match parsed {
                Ok(parsed) => {
                    let meta_name = parsed["meta"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    let messages = match parsed {
                        Value::Object(mut file) => match file.remove("messages") {
                            Some(Value::Object(messages)) => messages,
                            _ => Messages::new(),
                        },
                        _ => Messages::new(),
                    };
                    // The file name is the code: that is what clients ask for.
                    files.push(LocaleFile {
                        meta: LocaleMeta {
                            name: meta_name,
                            code: code.to_string(),
                        },
                        messages: Arc::new(messages),
                    });
                }
                Err(reason) => {
                    warn_once(&self.warned, format!("{name}:{reason}"), || {
                        format!("Skipped the language file {name}: {reason}")
                    });
                }
            }
        }
        files
    }

    fn files(&self) -> Arc<Vec<LocaleFile>> {
        let mut loaded = lock(&self.loaded);
        match &loaded.files {
            Some((at, files)) if at.elapsed() <= FRESH => files.clone(),
            _ => {
                let files = Arc::new(self.read_folder());
                loaded.files = Some((Instant::now(), files.clone()));
                loaded.translators.clear();
                files
            }
        }
    }

    /// The languages there are files for, English first, then by name.
    pub fn languages(&self) -> Vec<LanguageInfo> {
        let mut list: Vec<LanguageInfo> = self
            .files()
            .iter()
            .map(|file| LanguageInfo {
                code: file.meta.code.clone(),
                name: file.meta.name.clone(),
            })
            .collect();
        list.sort_by(|a, b| {
            (a.code != FALLBACK_LANGUAGE)
                .cmp(&(b.code != FALLBACK_LANGUAGE))
                .then_with(|| {
                    if a.code == FALLBACK_LANGUAGE {
                        std::cmp::Ordering::Equal
                    } else {
                        compare_names(&a.name, &b.name)
                    }
                })
        });
        list
    }

    pub fn language_codes(&self) -> Vec<String> {
        self.files()
            .iter()
            .map(|file| file.meta.code.clone())
            .collect()
    }

    fn messages_of(&self, code: &str) -> Arc<Messages> {
        self.files()
            .iter()
            .find(|file| file.meta.code == code)
            .map(|file| file.messages.clone())
            .unwrap_or_default()
    }

    /// `t()` for one language, with English behind it.
    pub fn translator(&self, code: &str) -> Translator {
        if let Some(translator) = lock(&self.loaded).translators.get(code) {
            return translator.clone();
        }
        let warned = self.warned.clone();
        let on_missing: OnMissing = Arc::new(move |key| {
            warn_once(&warned, format!("key:{key}"), || {
                format!("No text for \"{key}\" in the language files.")
            });
        });
        let translator = create_translator(
            code,
            self.messages_of(code),
            self.messages_of(FALLBACK_LANGUAGE),
            Some(on_missing),
        );
        lock(&self.loaded)
            .translators
            .insert(code.to_string(), translator.clone());
        translator
    }

    /// Words a message in a language.
    pub fn render_text(&self, text: &Text, code: &str) -> String {
        let rendered: Vec<(&str, Var)> = text
            .vars
            .iter()
            .map(|(name, value)| {
                let var = match value {
                    TextVar::Str(text) => Var::Text(text.clone()),
                    TextVar::Num(number) => Var::Number(*number),
                    TextVar::Text(inner) => Var::Text(self.render_text(inner, code)),
                };
                (name.as_str(), var)
            })
            .collect();
        self.translator(code).t(&text.key, &rendered)
    }

    /// Words a message in a language; plain text stays as it is.
    pub fn render(&self, said: &Said, code: &str) -> String {
        match said {
            Said::Plain(text) => text.clone(),
            Said::Text(text) => self.render_text(text, code),
        }
    }

    pub fn english(&self, said: &Said) -> String {
        self.render(said, FALLBACK_LANGUAGE)
    }

    /// Where the saved choice lives (config.json's "language").
    pub fn use_language_setting(&self, read: impl Fn() -> String + Send + Sync + 'static) {
        *self
            .setting
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(read);
    }

    pub fn language_setting(&self) -> String {
        let read = self
            .setting
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        read()
    }

    /// The language for an Accept-Language header: the saved choice if it is
    /// not "auto", else the header matched to the files, else English.
    pub fn language_for_header(&self, accept_language: Option<&str>) -> String {
        resolve_language(
            Some(&self.language_setting()),
            &parse_accept_language(accept_language),
            &self.language_codes(),
        )
    }

    /// The language for a request, from its headers.
    pub fn language_for(&self, headers: &HeaderMap) -> String {
        self.language_for_header(accept_language(headers).as_deref())
    }

    /// [`Languages::system_language`] with the environment and the system's
    /// own answer passed in.
    fn system_language_from(
        &self,
        variable: impl Fn(&str) -> Option<String>,
        system: Option<String>,
    ) -> String {
        let mut named: Vec<String> = ["PUNCHBOARD_LOCALE", "LC_ALL", "LC_MESSAGES", "LANG"]
            .iter()
            .filter_map(|name| variable(name))
            .filter(|value| !value.is_empty() && value != "C" && value != "POSIX")
            .flat_map(|value| {
                value
                    .split(',')
                    .map(|part| base_before_dot(js_trim(part)).to_string())
                    .collect::<Vec<_>>()
            })
            .filter(|value| !value.is_empty())
            .collect();
        named.extend(system.filter(|locale| !locale.is_empty()));
        resolve_language(
            Some(&self.language_setting()),
            &named,
            &self.language_codes(),
        )
    }

    /// This computer's own language, for what the companion makes before anyone
    /// asks (the starter decks of a fresh install). The desktop app passes the
    /// system's in `PUNCHBOARD_LOCALE` (a comma-separated list, most wanted
    /// first); from a terminal, `LANG` and friends say it.
    pub fn system_language(&self) -> String {
        let variable = |name: &str| env::var(name).ok();
        self.system_language_from(variable, Some(default_locale(variable)))
    }

    /// Whether a setting names a language there is a file for, or "auto".
    pub fn is_language_setting(&self, value: &Value) -> bool {
        value.as_str().is_some_and(|value| {
            value == AUTO_LANGUAGE || self.files().iter().any(|file| file.meta.code == value)
        })
    }
}

fn base_before_dot(value: &str) -> &str {
    value.split('.').next().unwrap_or("")
}

/// The request's Accept-Language, several headers joined as Node joins them.
fn accept_language(headers: &HeaderMap) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(axum::http::header::ACCEPT_LANGUAGE)
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned())
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values.join(", "))
    }
}

/// What Node's `Intl.DateTimeFormat().resolvedOptions().locale` answered on
/// macOS and Linux: the first of LC_ALL, LC_MESSAGES and LANG that is set,
/// without its encoding ("fr_FR.UTF-8" is "fr-FR"), and "en-US" when that
/// names no language. (ICU reads the environment there, not the system
/// settings: a Mac set to Spanish with no LANG answered "en-US".)
#[cfg_attr(target_os = "windows", allow(dead_code))]
fn posix_locale(variable: impl Fn(&str) -> Option<String>) -> String {
    let raw = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| variable(name));
    let Some(raw) = raw else {
        return "en-US".to_string();
    };
    let name = raw.split(['.', '@']).next().unwrap_or("");
    match name {
        "C" | "POSIX" => "en-US".to_string(),
        // Set but empty: ICU's "undetermined", which matches no file.
        "" => "und".to_string(),
        name => name.replace('_', "-"),
    }
}

/// The locale of this user's regional settings, which is what Node's Intl
/// answered on Windows.
#[cfg(target_os = "windows")]
fn default_locale(_variable: impl Fn(&str) -> Option<String>) -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultLocaleName(name: *mut u16, length: i32) -> i32;
    }
    // LOCALE_NAME_MAX_LENGTH
    let mut name = [0u16; 85];
    // SAFETY: the buffer is as long as the length passed, and the function
    // writes at most that many UTF-16 units, the final zero included.
    let written = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
    if written <= 1 {
        return "en-US".to_string();
    }
    String::from_utf16_lossy(&name[..written as usize - 1])
}

#[cfg(not(target_os = "windows"))]
fn default_locale(variable: impl Fn(&str) -> Option<String>) -> String {
    posix_locale(variable)
}

// -------------------------------------------------- the companion's own

/// The companion's languages: the files in [`locales_dir`].
pub fn global() -> &'static Languages {
    static GLOBAL: OnceLock<Languages> = OnceLock::new();
    GLOBAL.get_or_init(|| Languages::new(locales_dir()))
}

/// The languages there are files for, English first, then by name.
pub fn languages() -> Vec<LanguageInfo> {
    global().languages()
}

pub fn language_codes() -> Vec<String> {
    global().language_codes()
}

/// `t()` for one language, with English behind it.
pub fn translator(code: &str) -> Translator {
    global().translator(code)
}

/// Words a message in a language; plain text stays as it is.
pub fn render(said: &Said, code: &str) -> String {
    global().render(said, code)
}

pub fn english(said: &Said) -> String {
    global().english(said)
}

/// Where the saved choice lives (config.json's "language").
pub fn use_language_setting(read: impl Fn() -> String + Send + Sync + 'static) {
    global().use_language_setting(read);
}

pub fn language_setting() -> String {
    global().language_setting()
}

/// The language for a request: the saved choice if it is not "auto", else
/// the browser's Accept-Language matched to the files, else English.
pub fn language_for(headers: &HeaderMap) -> String {
    global().language_for(headers)
}

/// This computer's own language (see [`Languages::system_language`]).
pub fn system_language() -> String {
    global().system_language()
}

/// Whether a setting names a language there is a file for, or "auto".
pub fn is_language_setting(value: &Value) -> bool {
    global().is_language_setting(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn repo() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn fixture(name: &str) -> Vec<Value> {
        let file = repo().join("tests/fixtures/base").join(name);
        let text =
            fs::read_to_string(&file).unwrap_or_else(|error| panic!("{}: {error}", file.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", file.display()))
    }

    fn strings(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_str().unwrap().to_string())
            .collect()
    }

    fn vars_of(value: &Value) -> Vec<(String, Var)> {
        let Some(map) = value.as_object() else {
            return Vec::new();
        };
        map.iter()
            .map(|(name, value)| {
                let var = match value {
                    Value::String(text) => Var::Text(text.clone()),
                    other => Var::Number(other.as_f64().unwrap()),
                };
                (name.clone(), var)
            })
            .collect()
    }

    fn borrowed(vars: &[(String, Var)]) -> Vec<(&str, Var)> {
        vars.iter()
            .map(|(name, var)| (name.as_str(), var.clone()))
            .collect()
    }

    fn messages(value: &Value) -> Arc<Messages> {
        Arc::new(value.as_object().unwrap().clone())
    }

    /// The repository's own locale files.
    fn real() -> Languages {
        Languages::new(repo().join("public/locales"))
    }

    // ------------------------------------------------------- the fixtures

    #[test]
    fn fixture_parse_accept_language() {
        let cases = fixture("parse-accept-language.json");
        assert!(cases.len() > 60);
        for case in cases {
            assert_eq!(
                parse_accept_language(case["input"].as_str()),
                strings(&case["output"]),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_match_language() {
        let cases = fixture("match-language.json");
        assert!(cases.len() > 100);
        for case in cases {
            let got = match_language(
                &strings(&case["input"]["wanted"]),
                &strings(&case["input"]["available"]),
            );
            assert_eq!(got.as_deref(), case["output"].as_str(), "{}", case["input"]);
        }
    }

    #[test]
    fn fixture_resolve_language() {
        let cases = fixture("resolve-language.json");
        assert!(cases.len() > 100);
        for case in cases {
            let input = &case["input"];
            let got = resolve_language(
                input["setting"].as_str(),
                &strings(&input["preferred"]),
                &strings(&input["available"]),
            );
            assert_eq!(got, case["output"].as_str().unwrap(), "{input}");
        }
    }

    #[test]
    fn fixture_plural_category() {
        let cases = fixture("plural-category.json");
        assert!(cases.len() > 1500);
        for case in cases {
            let code = case["input"]["code"].as_str().unwrap();
            let count = case["input"]["count"].as_f64().unwrap();
            assert_eq!(
                plural_category(code, count),
                case["output"].as_str().unwrap(),
                "{code} {count}"
            );
        }
    }

    #[test]
    fn fixture_fill() {
        let cases = fixture("fill.json");
        assert!(cases.len() > 50);
        for case in cases {
            let vars = vars_of(&case["input"]["vars"]);
            assert_eq!(
                fill(case["input"]["text"].as_str().unwrap(), &borrowed(&vars)),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_placeholders_of() {
        let cases = fixture("placeholders-of.json");
        assert!(cases.len() > 500);
        for case in cases {
            assert_eq!(
                placeholders_of(&case["input"]),
                strings(&case["output"]),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_create_translator_over_the_real_files() {
        let cases = fixture("translator-real.json");
        assert!(cases.len() > 1000);
        let real = real();
        for case in cases {
            let code = case["input"]["code"].as_str().unwrap();
            let translate =
                create_translator(code, real.messages_of(code), real.messages_of("en"), None);
            let vars = vars_of(&case["input"]["vars"]);
            assert_eq!(
                translate.t(case["input"]["key"].as_str().unwrap(), &borrowed(&vars)),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_create_translator_over_made_up_files() {
        let cases = fixture("translator-made-up.json");
        assert!(cases.len() > 100);
        for case in cases {
            let input = &case["input"];
            let missing: Arc<Mutex<Vec<String>>> = Arc::default();
            let seen = missing.clone();
            let on_missing: OnMissing = Arc::new(move |key| lock(&seen).push(key.to_string()));
            let translate = create_translator(
                input["code"].as_str().unwrap(),
                messages(&input["messages"]),
                messages(&input["fallback"]),
                Some(on_missing),
            );
            let vars = vars_of(&input["vars"]);
            assert_eq!(
                translate.t(input["key"].as_str().unwrap(), &borrowed(&vars)),
                case["output"]["text"].as_str().unwrap(),
                "{input}"
            );
            assert_eq!(
                *lock(&missing),
                strings(&case["output"]["missing"]),
                "{input}"
            );
        }
    }

    fn text_from(value: &Value) -> Text {
        let mut text = say(value["key"].as_str().unwrap());
        if let Some(vars) = value["vars"].as_object() {
            for (name, var) in vars {
                text = match var {
                    Value::String(plain) => text.with(name, plain.as_str()),
                    Value::Object(_) => text.with(name, text_from(var)),
                    other => text.with(name, other.as_f64().unwrap()),
                };
            }
        }
        text
    }

    #[test]
    fn fixture_render() {
        let cases = fixture("render.json");
        assert!(cases.len() > 100);
        let real = real();
        for case in cases {
            let code = case["input"]["code"].as_str().unwrap();
            let said = match &case["input"]["said"] {
                Value::String(plain) => Said::Plain(plain.clone()),
                text => Said::Text(text_from(text)),
            };
            assert_eq!(
                real.render(&said, code),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_is_language_setting() {
        let cases = fixture("is-language-setting.json");
        assert!(cases.len() > 20);
        let real = real();
        for case in cases {
            assert_eq!(
                real.is_language_setting(&case["input"]),
                case["output"].as_bool().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_languages() {
        let cases = fixture("languages.json");
        assert!(!cases.is_empty());
        for case in cases {
            let dir = tempfile::tempdir().unwrap();
            for (name, content) in case["input"].as_object().unwrap() {
                fs::write(dir.path().join(name), content.as_str().unwrap()).unwrap();
            }
            let languages = Languages::new(dir.path());
            assert_eq!(
                serde_json::to_value(languages.languages()).unwrap(),
                case["output"]["languages"],
                "{}",
                case["input"]
            );
            assert_eq!(
                languages.language_codes(),
                strings(&case["output"]["codes"]),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn fixture_language_for() {
        let cases = fixture("language-for.json");
        assert!(cases.len() > 50);
        let real = real();
        for case in cases {
            let setting = case["input"]["setting"].as_str().unwrap().to_string();
            real.use_language_setting(move || setting.clone());
            let mut headers = HeaderMap::new();
            if let Some(header) = case["input"]["header"].as_str() {
                headers.insert("accept-language", header.parse().unwrap());
            }
            assert_eq!(
                real.language_for(&headers),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    // ---------------------------------------------- tests/i18n.test.mjs

    fn en() -> Arc<Messages> {
        messages(
            &json!({ "a.hello": "Hello, {name}.", "a.items": { "one": "{count} item", "other": "{count} items" }, "a.only": "Only in English" }),
        )
    }

    fn es() -> Arc<Messages> {
        messages(
            &json!({ "a.hello": "Hola, {name}.", "a.items": { "one": "{count} elemento", "other": "{count} elementos" } }),
        )
    }

    #[test]
    fn t_fills_counts_falls_back_and_reports() {
        let warned: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = warned.clone();
        let t = create_translator(
            "es",
            es(),
            en(),
            Some(Arc::new(move |key| lock(&seen).push(key.to_string()))),
        );
        // t(): placeholders are filled
        assert_eq!(t.t("a.hello", &[("name", "Ana".into())]), "Hola, Ana.");
        // t(): one and other
        assert_eq!(t.t("a.items", &[("count", 1.0.into())]), "1 elemento");
        assert_eq!(t.t("a.items", &[("count", 3.0.into())]), "3 elementos");
        assert_eq!(t.t("a.items", &[("count", 0.0.into())]), "0 elementos");
        // t(): a key missing in the language falls back to English
        assert_eq!(t.t("a.only", &[]), "Only in English");
        // t(): a key in no file comes back as itself, and is reported
        assert_eq!(t.t("a.nowhere", &[]), "a.nowhere");
        assert!(lock(&warned).contains(&"a.nowhere".to_string()));
        // fill(): a placeholder without a value stays visible
        assert_eq!(fill("Hi {name}", &[]), "Hi {name}");
    }

    // "without Intl.PluralRules: 1 is one, the rest other": the path taken
    // here for a code that names no language.
    #[test]
    fn without_plural_rules_one_is_one_and_the_rest_other() {
        assert_eq!(plural_category("not a code", 1.0), "one");
        assert_eq!(plural_category("not a code", 2.0), "other");
        assert_eq!(plural_category("es_CO", 0.0), "other");
        let old = create_translator("?", es(), en(), None);
        assert_eq!(old.t("a.items", &[("count", 1.0.into())]), "1 elemento");
        assert_eq!(old.t("a.items", &[("count", 5.0.into())]), "5 elementos");
    }

    #[test]
    fn with_plural_rules_their_categories_are_used() {
        assert_eq!(plural_category("pl", 3.0), "few");
        assert_eq!(plural_category("en", f64::NAN), "other");
        assert_eq!(plural_category("en", f64::INFINITY), "other");
        assert_eq!(plural_category("en", -1.0), "one");
        assert_eq!(plural_category("ru", 1e21), "many");
    }

    #[test]
    fn languages_are_matched_and_resolved() {
        assert_eq!(
            match_language(&["es-CO"], &["en", "es"]).as_deref(),
            Some("es")
        );
        assert_eq!(
            match_language(&["pt"], &["en", "pt-BR"]).as_deref(),
            Some("pt-BR")
        );
        assert_eq!(
            match_language(&["fr-FR", "es-MX", "en"], &["en", "es"]).as_deref(),
            Some("es")
        );
        assert_eq!(resolve_language(Some("auto"), &["fr"], &["en", "es"]), "en");
        assert_eq!(
            resolve_language(Some("es"), &["en-US"], &["en", "es"]),
            "es"
        );
        assert_eq!(resolve_language(Some("de"), &["es"], &["en", "es"]), "es");
        assert_eq!(
            parse_accept_language(Some("en;q=0.5, es-CO, es;q=0.9")),
            ["es-CO", "es", "en"]
        );
    }

    // The locale-file checks of tests/i18n.test.mjs, on what this crate reads.
    #[test]
    fn every_locale_file_is_complete_and_shaped_like_english() {
        let real = real();
        let english = real.messages_of("en");
        assert!(english.len() > 500, "{} keys", english.len());
        let codes = real.language_codes();
        assert!(codes.contains(&"en".to_string()) && codes.contains(&"es".to_string()));
        for file in real.files().iter() {
            let code = &file.meta.code;
            assert!(!file.meta.name.is_empty());
            for (key, ours) in english.iter() {
                let theirs = file
                    .messages
                    .get(key)
                    .unwrap_or_else(|| panic!("{code}: {key} is missing"));
                assert_eq!(
                    placeholders_of(theirs),
                    placeholders_of(ours),
                    "{code}: {key}"
                );
                if ours.is_string() {
                    assert!(theirs.is_string(), "{code}: {key}");
                } else {
                    assert!(is_plural_message(theirs), "{code}: {key}");
                    for (category, text) in theirs.as_object().unwrap() {
                        assert!(
                            PLURAL_CATEGORIES.contains(&category.as_str()) && text.is_string(),
                            "{code}: {key}.{category}"
                        );
                    }
                }
            }
            for key in file.messages.keys() {
                assert!(english.contains_key(key), "{code}: {key} is not in en.json");
            }
        }
    }

    // ------------------------------------------------------ the companion

    fn folder_with_esperanto() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for name in ["en.json", "es.json"] {
            fs::copy(
                repo().join("public/locales").join(name),
                dir.path().join(name),
            )
            .unwrap();
        }
        let eo = json!({ "meta": { "name": "Esperanto (test)", "code": "eo" }, "messages": { "server.settings.badTheme": "Tiu etoso ne ekzistas." } });
        fs::write(dir.path().join("eo.json"), eo.to_string()).unwrap();
        dir
    }

    fn header(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("accept-language", value.parse().unwrap());
        headers
    }

    #[test]
    fn replies_are_worded_for_whoever_asked() {
        let dir = folder_with_esperanto();
        let languages = Languages::new(dir.path());
        let spanish = languages.messages_of("es")["server.settings.badTheme"]
            .as_str()
            .unwrap()
            .to_string();
        let english = languages.messages_of("en")["server.settings.badTheme"]
            .as_str()
            .unwrap()
            .to_string();
        let bad_theme = |headers: &HeaderMap| {
            languages.render(
                &say("server.settings.badTheme").into(),
                &languages.language_for(headers),
            )
        };

        languages.use_language_setting(|| "es".to_string());
        assert_eq!(languages.language_setting(), "es");
        // server: an error in Spanish when the setting is es
        assert_eq!(bad_theme(&HeaderMap::new()), spanish);
        // server: the setting beats Accept-Language
        assert_eq!(bad_theme(&header("en-US")), spanish);

        languages.use_language_setting(|| "auto".to_string());
        // server: under auto, Accept-Language es-CO gets Spanish
        assert_eq!(bad_theme(&header("es-CO,es;q=0.9,en;q=0.8")), spanish);
        // server: under auto, a language with no file gets English
        assert_eq!(bad_theme(&header("fr-FR")), english);
        // server: no Accept-Language gets English
        assert_eq!(bad_theme(&HeaderMap::new()), english);

        // server: /api/languages lists the files, a dropped-in one too
        let list = languages.languages();
        assert_eq!(list[0].code, "en");
        assert!(list
            .iter()
            .any(|language| language.code == "es" && language.name == "Español"));
        assert!(list.iter().any(|language| language.code == "eo"));
        assert_eq!(languages.language_codes(), ["en", "eo", "es"]);

        // server: the dropped-in language can be chosen
        assert!(languages.is_language_setting(&json!("eo")));
        assert!(languages.is_language_setting(&json!("auto")));
        // server: a language with no file is refused
        assert!(!languages.is_language_setting(&json!("xx")));
        assert!(!languages.is_language_setting(&json!(7)));
        languages.use_language_setting(|| "eo".to_string());
        // server: its own text is used
        assert_eq!(bad_theme(&HeaderMap::new()), "Tiu etoso ne ekzistas.");
        // server: a key it lacks falls back to English
        let bad_colour = languages.render(
            &say("server.settings.badColour").into(),
            &languages.language_for(&HeaderMap::new()),
        );
        assert_eq!(
            bad_colour,
            languages.messages_of("en")["server.settings.badColour"]
                .as_str()
                .unwrap()
        );
    }

    #[test]
    fn several_accept_language_headers_are_read_as_one() {
        let dir = folder_with_esperanto();
        let languages = Languages::new(dir.path());
        let mut headers = HeaderMap::new();
        headers.append("accept-language", "fr".parse().unwrap());
        headers.append("accept-language", "eo;q=0.5".parse().unwrap());
        assert_eq!(languages.language_for(&headers), "eo");
    }

    #[test]
    fn broken_files_are_skipped_and_odd_names_ignored() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("en.json"),
            json!({ "meta": { "name": "English", "code": "en" }, "messages": { "k": "v" } })
                .to_string(),
        )
        .unwrap();
        fs::write(dir.path().join("de.json"), "{ not json").unwrap();
        fs::write(
            dir.path().join("fr.json"),
            json!({ "meta": { "name": "Français" }, "messages": {} }).to_string(),
        )
        .unwrap();
        fs::write(
            dir.path().join("it.json"),
            json!({ "meta": { "name": "Italiano", "code": "it" }, "messages": [] }).to_string(),
        )
        .unwrap();
        fs::write(
            dir.path().join("english.json"),
            json!({ "meta": { "name": "Long", "code": "x" }, "messages": {} }).to_string(),
        )
        .unwrap();
        fs::write(
            dir.path().join("pt-BR.json"),
            json!({ "meta": { "name": "Português", "code": "wrong" }, "messages": {} }).to_string(),
        )
        .unwrap();
        fs::write(dir.path().join("notes.txt"), "hello").unwrap();
        let languages = Languages::new(dir.path());
        // The file name is the code, whatever meta.code says.
        assert_eq!(languages.language_codes(), ["en", "pt-BR"]);
        assert_eq!(languages.translator("pt-BR").t("k", &[]), "v");
        assert_eq!(languages.translator("pt-BR").code(), "pt-BR");
    }

    #[test]
    fn a_missing_folder_is_no_languages_and_keys_come_back_as_they_are() {
        let languages = Languages::new("/nowhere/at/all");
        assert!(languages.languages().is_empty());
        assert_eq!(
            languages.render(&say("server.request.notFound").into(), "es"),
            "server.request.notFound"
        );
        assert_eq!(languages.language_for(&header("es")), "en");
    }

    #[test]
    fn the_folder_is_read_again_only_once_it_is_stale() {
        let dir = tempfile::tempdir().unwrap();
        let write = |code: &str, text: &str| {
            fs::write(
                dir.path().join(format!("{code}.json")),
                json!({ "meta": { "name": code, "code": code }, "messages": { "k": text } })
                    .to_string(),
            )
            .unwrap();
        };
        write("en", "first");
        let languages = Languages::new(dir.path());
        assert_eq!(languages.translator("en").t("k", &[]), "first");
        write("en", "second");
        write("eo", "nova");
        // Within two seconds the folder is trusted as it was read.
        assert_eq!(languages.language_codes(), ["en"]);
        assert_eq!(languages.translator("en").t("k", &[]), "first");
        // Once stale it is read again, and the translators are made anew.
        if let Some((at, _)) = lock(&languages.loaded).files.as_mut() {
            *at = Instant::now()
                .checked_sub(FRESH + Duration::from_millis(50))
                .expect("the clock has run for a few seconds");
        }
        assert_eq!(languages.language_codes(), ["en", "eo"]);
        assert_eq!(languages.translator("en").t("k", &[]), "second");
    }

    #[test]
    fn a_text_carries_its_values_and_an_error_its_english() {
        let text = say("a.b")
            .with("count", 2.0)
            .with("name", "x")
            .with("count", 3.0);
        assert_eq!(
            text.vars,
            [
                ("name".to_string(), TextVar::Str("x".to_string())),
                ("count".to_string(), TextVar::Num(3.0))
            ]
        );
        let error = UserError::new(say("server.request.notFound"));
        // The global folder is the repository's own when run from the crate.
        let expected = global()
            .messages_of("en")
            .get("server.request.notFound")
            .and_then(Value::as_str)
            .unwrap_or("server.request.notFound")
            .to_string();
        assert_eq!(error.to_string(), expected);
        assert_eq!(error.message(), expected);
        assert_eq!(text_of(&error), Said::Text(say("server.request.notFound")));
        let http = crate::http::HttpError::new(404, say("server.pair.noDevice"));
        assert_eq!(text_of(&http), Said::Text(say("server.pair.noDevice")));
        let plain = crate::http::HttpError::new(502, "OBS said no");
        assert_eq!(text_of(&plain), Said::Plain("OBS said no".to_string()));
        let other = std::io::Error::other("disk on fire");
        assert_eq!(text_of(&other), Said::Plain("disk on fire".to_string()));
        // A reason goes inside a sentence as it is.
        let wrapped = say("server.obs.namesFailed").with("reason", text_of(&error));
        assert_eq!(
            wrapped.vars[0].1,
            TextVar::Text(say("server.request.notFound"))
        );
    }

    #[test]
    fn the_system_language() {
        let dir = folder_with_esperanto();
        let languages = Languages::new(dir.path());
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(known, _)| *known == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        let system = |pairs: &'static [(&'static str, &'static str)]| {
            languages.system_language_from(env(pairs), Some(posix_locale(env(pairs))))
        };
        // The desktop app's list comes first, most wanted first.
        assert_eq!(
            system(&[
                ("PUNCHBOARD_LOCALE", "fr-FR, es-CO,en"),
                ("LANG", "eo.UTF-8")
            ]),
            "es"
        );
        assert_eq!(
            system(&[("PUNCHBOARD_LOCALE", "fr-FR"), ("LANG", "eo.UTF-8")]),
            "eo"
        );
        // From a terminal: LC_ALL, then LC_MESSAGES, then LANG.
        assert_eq!(system(&[("LANG", "es_CO.UTF-8")]), "es");
        assert_eq!(
            system(&[
                ("LC_ALL", "eo"),
                ("LC_MESSAGES", "es_ES"),
                ("LANG", "en_US.UTF-8")
            ]),
            "eo"
        );
        assert_eq!(system(&[("LC_MESSAGES", "es_ES"), ("LANG", "eo")]), "es");
        // "C" and "POSIX" say nothing; neither does nothing at all.
        assert_eq!(system(&[("LC_ALL", "C"), ("LANG", "POSIX")]), "en");
        assert_eq!(system(&[("LANG", "C.UTF-8")]), "en");
        assert_eq!(system(&[]), "en");
        assert_eq!(system(&[("LANG", "fr_FR.UTF-8")]), "en");
        // The saved choice wins, as for a request.
        languages.use_language_setting(|| "eo".to_string());
        assert_eq!(system(&[("PUNCHBOARD_LOCALE", "es")]), "eo");
        languages.use_language_setting(|| "de".to_string());
        assert_eq!(system(&[("PUNCHBOARD_LOCALE", "es")]), "es");
        // What the system itself answers is asked last.
        languages.use_language_setting(|| "auto".to_string());
        assert_eq!(
            languages.system_language_from(env(&[]), Some("es-CO".to_string())),
            "es"
        );
        assert_eq!(
            languages.system_language_from(env(&[("LANG", "eo")]), Some("es-CO".to_string())),
            "eo"
        );
        assert_eq!(languages.system_language_from(env(&[]), None), "en");
    }

    #[test]
    fn what_node_called_the_default_locale() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(known, _)| *known == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        // Checked against node on macOS: no variables is en-US whatever the system speaks.
        assert_eq!(posix_locale(env(&[])), "en-US");
        assert_eq!(posix_locale(env(&[("LANG", "fr_FR.UTF-8")])), "fr-FR");
        assert_eq!(posix_locale(env(&[("LANG", "C")])), "en-US");
        assert_eq!(
            posix_locale(env(&[("LC_ALL", "de_DE"), ("LANG", "fr_FR.UTF-8")])),
            "de-DE"
        );
        assert_eq!(
            posix_locale(env(&[("LC_MESSAGES", "de_DE"), ("LANG", "fr_FR.UTF-8")])),
            "de-DE"
        );
        assert_eq!(
            posix_locale(env(&[("LC_CTYPE", "it_IT"), ("LANG", "")])),
            "und"
        );
        assert!(!default_locale(|name| env::var(name).ok()).is_empty());
    }

    #[test]
    fn code_shapes() {
        for code in ["es", "eng", "pt-BR", "zh-Hant-TW", "es-419"] {
            assert!(is_code_shape(code), "{code}");
        }
        for code in [
            "",
            "e",
            "engl",
            "es_CO",
            "es-",
            "es-C",
            "e1",
            "es-123456789",
            "es.json",
            " es",
        ] {
            assert!(!is_code_shape(code), "{code}");
        }
    }

    #[test]
    fn locale_file_shapes() {
        assert!(is_locale_file(
            &json!({ "meta": { "name": "x", "code": "y" }, "messages": {} })
        ));
        for bad in [
            json!(null),
            json!([]),
            json!({ "meta": null, "messages": {} }),
            json!({ "meta": { "name": 1, "code": "y" }, "messages": {} }),
            json!({ "meta": { "name": "x" }, "messages": {} }),
            json!({ "meta": { "name": "x", "code": "y" }, "messages": [] }),
            json!({ "meta": { "name": "x", "code": "y" }, "messages": null }),
            json!({ "meta": { "name": "x", "code": "y" } }),
        ] {
            assert!(!is_locale_file(&bad), "{bad}");
        }
        assert!(is_plural_message(&json!({ "other": "x" })));
        assert!(!is_plural_message(&json!({ "one": "x" })));
        assert!(!is_plural_message(&json!("x")));
        assert!(!is_plural_message(&json!(["other"])));
    }
}
