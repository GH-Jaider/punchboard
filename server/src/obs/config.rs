//! Reads OBS's own WebSocket settings from its config folder, so Punchboard
//! can connect to an OBS on this computer without anyone copying a password.
//! OBS 28+ keeps them in plugin_config/obs-websocket/config.json.

use std::env;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::model::js;
use crate::paths::Platform;

/// What Punchboard found in OBS's own settings on this computer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ObsDetected {
    pub found: bool,
    /// Whether OBS's WebSocket server is switched on.
    pub enabled: bool,
    /// A number as JavaScript read it: `Number(server_port) || 4455`.
    #[serde(serialize_with = "js::serialize_number")]
    pub port: f64,
}

/// [`ObsDetected`] and the password, which never leaves the companion.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalObs {
    pub found: bool,
    pub enabled: bool,
    pub port: f64,
    /// Empty when OBS does not ask for one.
    pub password: String,
}

impl LocalObs {
    /// The part that may be sent to a page.
    pub fn detected(&self) -> ObsDetected {
        ObsDetected {
            found: self.found,
            enabled: self.enabled,
            port: self.port,
        }
    }

    fn missing() -> LocalObs {
        LocalObs {
            found: false,
            enabled: false,
            port: DEFAULT_PORT,
            password: String::new(),
        }
    }
}

const DEFAULT_PORT: f64 = 4455.0;

/// Where this computer keeps things: the home folder and the variables that
/// move the settings folder. Read from the system by [`Places::current`];
/// tests point them at folders of their own.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Places {
    pub home: PathBuf,
    /// `%APPDATA%` (Windows).
    pub appdata: Option<String>,
    /// `$XDG_CONFIG_HOME` (Linux).
    pub xdg_config_home: Option<String>,
}

impl Places {
    pub fn current() -> Places {
        let variable =
            |name: &str| env::var_os(name).map(|value| value.to_string_lossy().into_owned());
        Places {
            home: env::home_dir().unwrap_or_default(),
            appdata: variable("APPDATA"),
            xdg_config_home: variable("XDG_CONFIG_HOME"),
        }
    }
}

fn tail(folder: PathBuf) -> PathBuf {
    folder
        .join("obs-studio")
        .join("plugin_config")
        .join("obs-websocket")
        .join("config.json")
}

/// The files OBS's settings may be in on a platform, the first that exists
/// being the one. Linux has two: OBS installed the usual way, then OBS from
/// Flathub, which keeps its settings in its own sandbox.
pub fn config_files(platform: Platform, places: &Places) -> Vec<PathBuf> {
    let home = &places.home;
    match platform {
        Platform::Mac => vec![tail(home.join("Library").join("Application Support"))],
        Platform::Windows => vec![tail(match &places.appdata {
            Some(appdata) => PathBuf::from(appdata),
            None => home.join("AppData").join("Roaming"),
        })],
        Platform::Linux => vec![
            tail(match &places.xdg_config_home {
                Some(config) => PathBuf::from(config),
                None => home.join(".config"),
            }),
            tail(
                home.join(".var")
                    .join("app")
                    .join("com.obsproject.Studio")
                    .join("config"),
            ),
        ],
    }
}

/// What a settings file says. None where the TypeScript's `JSON.parse` or
/// its reading of the result threw: text that is not JSON, or `null`.
pub fn parse_local_obs(text: &str) -> Option<LocalObs> {
    let raw: Value = serde_json::from_str(text).ok()?;
    if raw.is_null() {
        return None;
    }
    let field = |name: &str| raw.as_object().and_then(|fields| fields.get(name));
    // `Number(raw.server_port) || 4455`: a missing port is NaN, and NaN and 0 give way.
    let port = field("server_port").map_or(f64::NAN, js::to_number);
    let port = if port.is_nan() || port == 0.0 {
        DEFAULT_PORT
    } else {
        port
    };
    let auth = field("auth_required") != Some(&Value::Bool(false));
    let password = match field("server_password") {
        Some(Value::String(password)) if auth => password.clone(),
        _ => String::new(),
    };
    Some(LocalObs {
        found: true,
        enabled: field("server_enabled") == Some(&Value::Bool(true)),
        port,
        password,
    })
}

fn read_file(file: &Path) -> Option<LocalObs> {
    let bytes = std::fs::read(file).ok()?;
    // As Node's "utf8" reads: bytes that are not text become U+FFFD.
    parse_local_obs(&String::from_utf8_lossy(&bytes))
}

/// [`read_local_obs`] for a given platform and places.
pub fn read_local_obs_in(platform: Platform, places: &Places) -> LocalObs {
    let files = config_files(platform, places);
    let file = files
        .iter()
        .find(|file| file.exists())
        .or_else(|| files.first());
    file.and_then(|file| read_file(file))
        .unwrap_or_else(LocalObs::missing)
}

/// OBS's settings on this computer, or found: false when OBS was never set up here.
pub fn read_local_obs() -> LocalObs {
    read_local_obs_in(Platform::current(), &Places::current())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obs::fake::{bits, fixture};

    fn expected(output: &Value) -> LocalObs {
        LocalObs {
            found: output["found"].as_bool().expect("found"),
            enabled: output["enabled"].as_bool().expect("enabled"),
            port: bits(&output["port"]),
            password: output["password"].as_str().expect("password").to_string(),
        }
    }

    /// The bytes of a case's file: its text, or hexadecimal for what is not text.
    fn bytes_of(input: &Value) -> Option<Vec<u8>> {
        if let Some(hex) = input["hex"].as_str() {
            return Some(hex::decode(hex).expect("hexadecimal"));
        }
        input["text"].as_str().map(|text| text.as_bytes().to_vec())
    }

    #[test]
    fn settings_files_read_as_the_typescript_read_them() {
        let cases = fixture("local-obs.json");
        assert!(cases.len() >= 60);
        // The TypeScript ran on a Mac; the same files, wherever each platform keeps them.
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            for (at, case) in cases.iter().enumerate() {
                let home = tempfile::tempdir().expect("a folder");
                let places = Places {
                    home: home.path().to_path_buf(),
                    appdata: None,
                    xdg_config_home: None,
                };
                if let Some(bytes) = bytes_of(&case["input"]) {
                    let file = &config_files(platform, &places)[0];
                    std::fs::create_dir_all(file.parent().expect("a folder")).expect("folders");
                    std::fs::write(file, bytes).expect("writes");
                }
                let ours = read_local_obs_in(platform, &places);
                assert_eq!(
                    ours,
                    expected(&case["output"]),
                    "case {at}: {}",
                    case["input"]
                );
            }
        }
    }

    #[test]
    fn what_a_page_is_sent_has_no_password() {
        let local = parse_local_obs(
            r#"{"server_enabled":true,"server_port":4460,"server_password":"hunter2"}"#,
        )
        .expect("reads");
        assert_eq!(local.password, "hunter2");
        let sent = serde_json::to_value(local.detected()).expect("serializes");
        assert_eq!(
            crate::store::stringify(&sent),
            r#"{"found":true,"enabled":true,"port":4460}"#
        );
        let missing = serde_json::to_value(LocalObs::missing().detected()).expect("serializes");
        assert_eq!(
            crate::store::stringify(&missing),
            r#"{"found":false,"enabled":false,"port":4455}"#
        );
    }

    #[test]
    fn where_each_platform_keeps_the_file() {
        let places = Places {
            home: PathBuf::from("/home/ana"),
            appdata: None,
            xdg_config_home: None,
        };
        let tail = Path::new("obs-studio/plugin_config/obs-websocket/config.json");
        assert_eq!(
            config_files(Platform::Mac, &places),
            [Path::new("/home/ana/Library/Application Support").join(tail)]
        );
        assert_eq!(
            config_files(Platform::Windows, &places),
            [Path::new("/home/ana/AppData/Roaming").join(tail)]
        );
        assert_eq!(
            config_files(Platform::Linux, &places),
            [
                Path::new("/home/ana/.config").join(tail),
                Path::new("/home/ana/.var/app/com.obsproject.Studio/config").join(tail)
            ]
        );
        let moved = Places {
            appdata: Some("/roaming".to_string()),
            xdg_config_home: Some("/xdg".to_string()),
            ..places
        };
        assert_eq!(
            config_files(Platform::Windows, &moved),
            [Path::new("/roaming").join(tail)]
        );
        assert_eq!(
            config_files(Platform::Linux, &moved)[0],
            Path::new("/xdg").join(tail)
        );
        assert_eq!(config_files(Platform::Mac, &moved).len(), 1);
    }

    #[test]
    fn linux_falls_back_to_the_flatpak_only_when_the_usual_file_is_not_there() {
        let home = tempfile::tempdir().expect("a folder");
        let places = Places {
            home: home.path().to_path_buf(),
            appdata: None,
            xdg_config_home: None,
        };
        let files = config_files(Platform::Linux, &places);
        let write = |file: &Path, text: &str| {
            std::fs::create_dir_all(file.parent().expect("a folder")).expect("folders");
            std::fs::write(file, text).expect("writes");
        };
        assert!(!read_local_obs_in(Platform::Linux, &places).found);
        write(
            &files[1],
            r#"{"server_enabled":true,"server_port":4466,"server_password":"flat"}"#,
        );
        let flatpak = read_local_obs_in(Platform::Linux, &places);
        assert_eq!(
            (flatpak.found, flatpak.port, flatpak.password.as_str()),
            (true, 4466.0, "flat")
        );
        // The usual file wins once it exists, even one that cannot be read.
        write(&files[0], r#"{"server_enabled":false,"server_port":4455}"#);
        let usual = read_local_obs_in(Platform::Linux, &places);
        assert_eq!(
            (usual.found, usual.enabled, usual.port),
            (true, false, 4455.0)
        );
        write(&files[0], "not json");
        assert!(!read_local_obs_in(Platform::Linux, &places).found);
        // Other platforms never look there.
        std::fs::remove_file(&files[0]).expect("removes");
        assert!(!read_local_obs_in(Platform::Mac, &places).found);
    }
}
