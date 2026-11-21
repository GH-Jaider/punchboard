//! Settings stored in config.json in the data folder.

use std::io;
use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::i18n::{is_code_shape, AUTO_LANGUAGE};
use crate::model::colors::is_hex_color_value;
use crate::model::themes::{is_theme_id, DEFAULT_THEME, THEMES};
use crate::store::{is_object, js_trim, js_value_to_number, read_json_safe, write_json_atomic};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// A theme id: "studio", "hardware", "broadcast", "hardware-dark".
    pub name: String,
    /// "#rrggbb".
    pub accent: String,
    pub accent_preset: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ObsSource {
    /// Follows OBS's own settings on this computer.
    Auto,
    /// Was typed in.
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Obs {
    pub address: String,
    pub password: String,
    pub source: ObsSource,
}

/// The fields are written to config.json in this order, as the Node
/// companion wrote them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// A number as JavaScript read it from the file: `Number(raw.port)`, so
    /// "9000" and 9000.5 are both kept as they are. [`Config::port_number`]
    /// is the port to listen on.
    pub port: f64,
    pub theme: Theme,
    pub sound_volume: f64,
    pub obs: Obs,
    /// The one-time Ko-fi note has been shown in the Control Center.
    pub support_shown: bool,
    /// The first-run tour of the Control Center has been started once.
    pub tour_shown: bool,
    /// "auto" speaks each device's own language; a code ("es") one for all.
    /// Only the shape is checked here: a code with no file speaks as auto does.
    pub language: String,
}

pub const DEFAULT_PORT: u16 = 8787;
const DEFAULT_ACCENT: &str = "#5fd0d6";
const DEFAULT_OBS_ADDRESS: &str = "ws://127.0.0.1:4455";

/// `DEFAULT_THEME` as config.json names it.
fn default_theme() -> &'static str {
    THEMES
        .iter()
        .find(|theme| theme.id == DEFAULT_THEME)
        .map_or("studio", |theme| theme.name)
}

impl Default for Config {
    fn default() -> Config {
        Config {
            port: f64::from(DEFAULT_PORT),
            theme: Theme {
                name: default_theme().to_string(),
                accent: DEFAULT_ACCENT.to_string(),
                accent_preset: "custom".to_string(),
            },
            sound_volume: 1.0,
            obs: Obs {
                address: DEFAULT_OBS_ADDRESS.to_string(),
                password: String::new(),
                source: ObsSource::Auto,
            },
            support_shown: false,
            tour_shown: false,
            language: AUTO_LANGUAGE.to_string(),
        }
    }
}

impl Config {
    /// The saved port as one that can be listened on, if it is one.
    pub fn port_number(&self) -> Option<u16> {
        (self.port.fract() == 0.0 && (1.0..=65535.0).contains(&self.port))
            .then_some(self.port as u16)
    }
}

fn text_or<'a>(value: Option<&'a Value>, fallback: &'a str) -> &'a str {
    value.and_then(Value::as_str).unwrap_or(fallback)
}

/// "auto", or something shaped like a language code ("es", "pt-BR").
pub fn is_language_code(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| text == AUTO_LANGUAGE || is_code_shape(text))
}

/// The settings in a parsed config.json, each one checked and replaced by
/// its default when it is missing or not what it should be.
pub fn config_from(raw: &Map<String, Value>) -> Config {
    let defaults = Config::default();
    let empty = Map::new();
    let theme = raw
        .get("theme")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let obs = raw.get("obs").and_then(Value::as_object).unwrap_or(&empty);
    // Number(raw.port) || 8787: nothing, zero and what is not a number are the default.
    let port = raw.get("port").map_or(f64::NAN, js_value_to_number);
    // Only a real number counts: Number(null) would be 0, a muted fader.
    let sound_volume = match raw.get("soundVolume") {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    let address = js_trim(text_or(obs.get("address"), ""));
    let password = text_or(obs.get("password"), "");
    let source = obs.get("source").and_then(Value::as_str);
    Config {
        port: if port.is_nan() || port == 0.0 {
            defaults.port
        } else {
            port
        },
        theme: Theme {
            name: theme
                .get("name")
                .filter(|name| is_theme_id(name))
                .and_then(Value::as_str)
                .unwrap_or(&defaults.theme.name)
                .to_string(),
            accent: theme
                .get("accent")
                .filter(|accent| is_hex_color_value(accent))
                .and_then(Value::as_str)
                .unwrap_or(&defaults.theme.accent)
                .to_string(),
            accent_preset: text_or(theme.get("accentPreset"), &defaults.theme.accent_preset)
                .to_string(),
        },
        sound_volume: if sound_volume.is_finite() {
            if sound_volume <= 0.0 {
                0.0
            } else {
                sound_volume.min(1.0)
            }
        } else {
            defaults.sound_volume
        },
        obs: Obs {
            address: if address.is_empty() {
                defaults.obs.address.clone()
            } else {
                address.to_string()
            },
            password: password.to_string(),
            // A password typed before this setting existed counts as manual.
            source: if source == Some("manual") || (source != Some("auto") && !password.is_empty())
            {
                ObsSource::Manual
            } else {
                ObsSource::Auto
            },
        },
        support_shown: raw.get("supportShown") == Some(&Value::Bool(true)),
        // Missing from an older config.json, so someone who updates gets the
        // tour once too, as with the Ko-fi note.
        tour_shown: raw.get("tourShown") == Some(&Value::Bool(true)),
        language: raw
            .get("language")
            .filter(|language| is_language_code(language))
            .and_then(Value::as_str)
            .unwrap_or(&defaults.language)
            .to_string(),
    }
}

pub fn load_config(file: &Path, log: &mut dyn FnMut(&str)) -> Config {
    let raw = match read_json_safe(file, is_object) {
        Ok(read) => read.data(),
        Err(error) => {
            log(&format!("{error} Starting with default settings."));
            None
        }
    };
    match raw {
        Some(Value::Object(raw)) => config_from(&raw),
        _ => config_from(&Map::new()),
    }
}

pub fn save_config(file: &Path, config: &Config) -> io::Result<()> {
    write_json_atomic(file, config, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{backup_of, stringify};
    use serde_json::json;
    use std::fs;

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

    /// Each case is the text of a config.json (or null for no file), what
    /// loadConfig made of it, and the text saveConfig then wrote.
    #[test]
    fn fixture_config() {
        let cases = fixture("config.json");
        assert!(cases.len() > 150);
        let dir = tempfile::tempdir().unwrap();
        for (i, case) in cases.iter().enumerate() {
            let file = dir.path().join(format!("{i}/config.json"));
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            if let Some(text) = case["input"].as_str() {
                fs::write(&file, text).unwrap();
            }
            let mut lines: Vec<String> = Vec::new();
            let config = load_config(&file, &mut |line| lines.push(line.to_string()));
            assert_eq!(
                stringify(&serde_json::to_value(&config).unwrap()),
                stringify(&case["output"]["config"]),
                "{}",
                case["input"]
            );
            assert_eq!(
                lines.len(),
                case["output"]["logged"].as_u64().unwrap() as usize,
                "{} {lines:?}",
                case["input"]
            );
            for line in &lines {
                assert!(
                    line.starts_with("config.json could not be read (")
                        && line.ends_with(" Starting with default settings."),
                    "{line}"
                );
            }
            let saved = dir.path().join(format!("{i}/saved.json"));
            save_config(&saved, &config).unwrap();
            assert_eq!(
                fs::read_to_string(&saved).unwrap(),
                case["output"]["saved"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    #[test]
    fn the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        let config = load_config(&file, &mut |line| panic!("nothing to say: {line}"));
        assert_eq!(config, Config::default());
        assert_eq!(
            serde_json::to_value(&config).unwrap(),
            json!({
                "port": 8787.0,
                "theme": { "name": "studio", "accent": "#5fd0d6", "accentPreset": "custom" },
                "soundVolume": 1.0,
                "obs": { "address": "ws://127.0.0.1:4455", "password": "", "source": "auto" },
                "supportShown": false,
                "tourShown": false,
                "language": "auto"
            })
        );
        assert_eq!(config.port_number(), Some(8787));
        assert!(!file.exists(), "loading writes nothing");
    }

    #[test]
    fn saving_keeps_the_previous_file_as_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        let mut config = Config::default();
        save_config(&file, &config).unwrap();
        let first = fs::read_to_string(&file).unwrap();
        assert!(
            first.starts_with("{\n  \"port\": 8787,\n  \"theme\": {\n    \"name\": \"studio\",")
                && first.ends_with("\"language\": \"auto\"\n}\n"),
            "{first}"
        );
        config.language = "es".to_string();
        config.sound_volume = 0.35;
        config.obs.source = ObsSource::Manual;
        save_config(&file, &config).unwrap();
        assert_eq!(fs::read_to_string(backup_of(&file)).unwrap(), first);
        assert_eq!(load_config(&file, &mut |line| panic!("{line}")), config);
    }

    #[test]
    fn a_damaged_file_starts_with_the_defaults_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        fs::write(&file, "{ nope").unwrap();
        let mut lines: Vec<String> = Vec::new();
        let config = load_config(&file, &mut |line| lines.push(line.to_string()));
        assert_eq!(config, Config::default());
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("It was kept as config.json.corrupt-")
                && lines[0].ends_with(". Starting with default settings."),
            "{}",
            lines[0]
        );
        assert!(!file.exists());
    }

    #[test]
    fn a_damaged_file_falls_back_to_its_backup() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        fs::write(&file, "").unwrap();
        fs::write(backup_of(&file), "{\"port\": 9001, \"language\": \"es\"}").unwrap();
        let config = load_config(&file, &mut |line| panic!("{line}"));
        assert_eq!((config.port, config.language.as_str()), (9001.0, "es"));
    }

    #[test]
    fn the_port_to_listen_on() {
        let port =
            |value: Value| config_from(json!({ "port": value }).as_object().unwrap()).port_number();
        assert_eq!(port(json!(9000)), Some(9000));
        assert_eq!(port(json!("9000")), Some(9000));
        assert_eq!(port(json!(0)), Some(8787));
        assert_eq!(port(json!(70000)), None);
        assert_eq!(port(json!(80.5)), None);
        assert_eq!(port(json!(-1)), None);
    }

    #[test]
    fn language_codes() {
        for ok in ["auto", "es", "pt-BR", "zh-Hant-TW"] {
            assert!(is_language_code(&json!(ok)), "{ok}");
        }
        for bad in [
            json!("automatic"),
            json!("e"),
            json!("es_CO"),
            json!(""),
            json!(null),
            json!(5),
            json!(["es"]),
        ] {
            assert!(!is_language_code(&bad), "{bad}");
        }
    }
}
