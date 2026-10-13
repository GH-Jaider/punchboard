// The menu-bar menu, the starting screen and the problem page speak the
// language the pages speak, from the same locale files (public/locales,
// bundled as a resource), so a new language needs no change here either.
//
// Which language: the companion says, with a "PUNCHBOARD_LANGUAGE <code>"
// line at start-up and whenever the setting changes. Until it has, this reads
// "language" from the companion's config.json itself, "auto" meaning this
// computer's own. A text missing from that file comes from English, and
// without any file at all, from the English written in main.rs.
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

pub const ENGLISH: &str = "en";

#[derive(Default)]
pub struct Language {
    loaded: Mutex<Loaded>,
}

#[derive(Default)]
struct Loaded {
    code: String,
    own: Map<String, Value>,
    english: Map<String, Value>,
}

fn locales_dir(app: &AppHandle) -> Option<PathBuf> {
    let resources = app.path().resource_dir().ok()?;
    Some(dunce::simplified(&resources).join("public").join("locales"))
}

fn read_messages(dir: &std::path::Path, code: &str) -> Map<String, Value> {
    std::fs::read_to_string(dir.join(format!("{code}.json")))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|file| file.get("messages").and_then(Value::as_object).cloned())
        .unwrap_or_default()
}

/// The codes there are files for: the file names without ".json".
fn available(dir: &std::path::Path) -> Vec<String> {
    let mut codes: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter_map(|entry| entry.file_name().to_str().and_then(|name| name.strip_suffix(".json")).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    codes.sort();
    codes
}

/// This computer's languages, most wanted first ("es-CO", "en-US").
pub fn system_locales() -> Vec<String> {
    sys_locale::get_locales().collect()
}

/// The best file for a list of languages: the same code, else the base
/// language ("es-CO" is served by "es"), else a regional file of that
/// language. The same rule as matchLanguage() in src/shared/i18n.ts.
fn match_language(wanted: &[String], available: &[String]) -> Option<String> {
    let tidy = |code: &str| code.trim().replace('_', "-").to_lowercase();
    let codes: Vec<String> = available.iter().map(|code| tidy(code)).collect();
    for wish in wanted {
        let wish = tidy(wish);
        if wish.is_empty() {
            continue;
        }
        let base = wish.split('-').next().unwrap_or_default().to_string();
        if let Some(at) = codes.iter().position(|code| *code == wish) {
            return Some(available[at].clone());
        }
        if let Some(at) = codes.iter().position(|code| *code == base) {
            return Some(available[at].clone());
        }
        if let Some(at) = codes.iter().position(|code| code.split('-').next() == Some(base.as_str())) {
            return Some(available[at].clone());
        }
    }
    None
}

/// The companion's data folder, found the way src/server/paths.ts finds it.
fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PUNCHBOARD_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = app.path().home_dir().ok()?;
    if cfg!(target_os = "macos") {
        return Some(home.join("Library").join("Application Support").join("Punchboard"));
    }
    if cfg!(windows) {
        let roaming = std::env::var("APPDATA").map(PathBuf::from).unwrap_or_else(|_| home.join("AppData").join("Roaming"));
        return Some(roaming.join("Punchboard"));
    }
    let config = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home.join(".config"));
    Some(config.join("punchboard"))
}

/// config.json's "language", or "auto" when there is none yet.
fn setting(app: &AppHandle) -> String {
    data_dir(app)
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|config| config.get("language").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "auto".to_string())
}

fn resolve(app: &AppHandle, setting: &str) -> String {
    let codes = locales_dir(app).map(|dir| available(&dir)).unwrap_or_default();
    if setting != "auto" {
        if let Some(code) = match_language(&[setting.to_string()], &codes) {
            return code;
        }
    }
    match_language(&system_locales(), &codes).unwrap_or_else(|| ENGLISH.to_string())
}

/// Speaks `code` from now on. Returns whether that changed anything.
pub fn load(app: &AppHandle, code: &str) -> bool {
    let state = app.state::<Language>();
    let mut loaded = state.loaded.lock().unwrap();
    if loaded.code == code {
        return false;
    }
    let dir = locales_dir(app);
    loaded.english = dir.as_ref().map(|dir| read_messages(dir, ENGLISH)).unwrap_or_default();
    loaded.own = if code == ENGLISH { Map::new() } else { dir.as_ref().map(|dir| read_messages(dir, code)).unwrap_or_default() };
    loaded.code = code.to_string();
    true
}

/// Picks the language before the companion has said anything.
pub fn init(app: &AppHandle) {
    let code = resolve(app, &setting(app));
    load(app, &code);
}

/// The language the window and menu speak now.
pub fn current(app: &AppHandle) -> String {
    app.state::<Language>().loaded.lock().unwrap().code.clone()
}

/// The text for a key, with {placeholders} filled: this language's, else
/// English's, else `english` as written in the code.
pub fn tr(app: &AppHandle, key: &str, english: &str, vars: &[(&str, &str)]) -> String {
    let state = app.state::<Language>();
    let loaded = state.loaded.lock().unwrap();
    let text = |messages: &Map<String, Value>| match messages.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        // The menu has no counts: a plural's "other" will do.
        Some(Value::Object(forms)) => forms.get("other").and_then(Value::as_str).map(str::to_string),
        _ => None,
    };
    let mut out = text(&loaded.own).or_else(|| text(&loaded.english)).unwrap_or_else(|| english.to_string());
    for (name, value) in vars {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::match_language;

    fn codes(list: &[&str]) -> Vec<String> {
        list.iter().map(|code| code.to_string()).collect()
    }

    #[test]
    fn matches_like_the_pages() {
        assert_eq!(match_language(&codes(&["es-CO"]), &codes(&["en", "es"])), Some("es".into()));
        assert_eq!(match_language(&codes(&["pt"]), &codes(&["en", "pt-BR"])), Some("pt-BR".into()));
        assert_eq!(match_language(&codes(&["fr-FR", "es_MX"]), &codes(&["en", "es"])), Some("es".into()));
        assert_eq!(match_language(&codes(&["fr"]), &codes(&["en", "es"])), None);
    }
}
