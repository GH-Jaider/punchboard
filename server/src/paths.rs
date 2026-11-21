//! Where things live. The app's own files (pages) are read-only and get
//! replaced by every update; everything the user makes lives in a data
//! folder of its own, so an update can never take a deck, a sound or a
//! pairing with it.
//!
//! ```text
//!   macOS    ~/Library/Application Support/Punchboard
//!   Windows  %APPDATA%\Punchboard
//!   Linux    $XDG_CONFIG_HOME/punchboard (or ~/.config/punchboard)
//! ```

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

/// `path.resolve`: an absolute path with "." and ".." worked out by name
/// alone (links are not followed), relative ones starting from the current
/// folder.
pub fn resolve(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir().unwrap_or_default().join(path)
    };
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                // The root has no parent: "/.." is "/".
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// An environment variable that is set, even to nothing (TypeScript's `??`).
fn env_set(name: &str) -> Option<OsString> {
    env::var_os(name)
}

/// The folder holding `public/`, looking from the program's own folder
/// upwards: beside the binary in a release, the repository when run from
/// `server/target/…`.
fn app_dir_near(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .skip(1)
        .find(|dir| dir.join("public").is_dir())
        .map(Path::to_path_buf)
}

fn find_app_dir() -> PathBuf {
    // Resolved, so a relative folder (".") still matches the public-folder check.
    if let Some(chosen) = env_set("PUNCHBOARD_APP_DIR") {
        return resolve(chosen);
    }
    env::current_exe()
        .ok()
        .and_then(|executable| app_dir_near(&resolve(executable)))
        .unwrap_or_else(|| resolve(""))
}

/// The app's files: `public/`. The desktop app points this at its resources
/// with `PUNCHBOARD_APP_DIR`.
pub fn app_dir() -> &'static Path {
    static APP_DIR: OnceLock<PathBuf> = OnceLock::new();
    APP_DIR.get_or_init(find_app_dir)
}

/// The home folder, as Node's `os.homedir()` finds it.
fn home_dir() -> PathBuf {
    env::home_dir().unwrap_or_default()
}

/// What decides the data folder, so that every platform's answer can be
/// tested on any of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Mac
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// The data folder for a platform, given the home folder and the one
/// variable that platform reads (`APPDATA` on Windows, `XDG_CONFIG_HOME`
/// elsewhere; set but empty counts as set, as it did in TypeScript).
pub fn data_dir_for(platform: Platform, home: &Path, variable: Option<&Path>) -> PathBuf {
    match platform {
        Platform::Mac => home
            .join("Library")
            .join("Application Support")
            .join("Punchboard"),
        Platform::Windows => variable
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Punchboard"),
        Platform::Linux => variable
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".config"))
            .join("punchboard"),
    }
}

pub fn default_data_dir() -> PathBuf {
    let platform = Platform::current();
    let variable = match platform {
        Platform::Mac => None,
        Platform::Windows => env_set("APPDATA"),
        Platform::Linux => env_set("XDG_CONFIG_HOME"),
    };
    data_dir_for(platform, &home_dir(), variable.as_deref().map(Path::new))
}

/// This Punchboard's version: `chosen` (the desktop app passes its own in
/// `PUNCHBOARD_VERSION`); run from the source, package.json's.
pub fn app_version_in(app_dir: &Path, chosen: Option<&str>) -> String {
    if let Some(version) = chosen.filter(|version| !version.is_empty()) {
        return version.to_string();
    }
    // Not beside the source: no file, or no version in it.
    fs::read(app_dir.join("package.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|package| {
            package
                .get("version")
                .and_then(|version| version.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "dev".to_string())
}

pub fn app_version() -> String {
    app_version_in(app_dir(), env::var("PUNCHBOARD_VERSION").ok().as_deref())
}

/// `PUNCHBOARD_DATA_DIR` overrides it (tests, a portable copy).
pub fn data_dir() -> &'static Path {
    static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
    DATA_DIR.get_or_init(|| {
        env_set("PUNCHBOARD_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir)
    })
}

/// Every file and folder the companion uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub public: PathBuf,
    /// Where the Node companion kept its helper scripts. Nothing in this
    /// crate runs them; the name is kept so the list matches the TypeScript.
    pub helpers: PathBuf,
    pub config: PathBuf,
    pub library: PathBuf,
    pub sounds: PathBuf,
    pub devices: PathBuf,
    pub cache: PathBuf,
    /// Recordings from trackpad decks in debug mode, for the touchpad tests.
    pub traces: PathBuf,
}

impl Paths {
    pub fn new(app_dir: &Path, data_dir: &Path) -> Paths {
        Paths {
            public: app_dir.join("public"),
            helpers: app_dir.join("src").join("server").join("helpers"),
            config: data_dir.join("config.json"),
            library: data_dir.join("decks").join("library.json"),
            sounds: data_dir.join("sounds"),
            devices: data_dir.join("devices.json"),
            cache: data_dir.join("cache"),
            traces: data_dir.join("trackpad-traces"),
        }
    }
}

/// The paths of this run: [`app_dir`] and [`data_dir`].
pub fn paths() -> &'static Paths {
    static PATHS: OnceLock<Paths> = OnceLock::new();
    PATHS.get_or_init(|| Paths::new(app_dir(), data_dir()))
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    if fs::metadata(from)?.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

fn copy_into(from: &Path, to: &Path) -> io::Result<bool> {
    if !from.exists() || to.exists() {
        return Ok(false);
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    copy_tree(from, to)?;
    Ok(true)
}

/// `^sound-[1-8]\.(wav|mp3)$|^sounds\.json$`: the user's own sounds and their list.
fn is_user_sound(name: &str) -> bool {
    if name == "sounds.json" {
        return true;
    }
    let Some(rest) = name.strip_prefix("sound-") else {
        return false;
    };
    let mut chars = rest.chars();
    matches!(chars.next(), Some('1'..='8')) && matches!(chars.as_str(), ".wav" | ".mp3")
}

/// [`migrate_legacy_data`] for any pair of folders. `chosen` says the data
/// folder was picked on purpose (`PUNCHBOARD_DATA_DIR`).
pub fn migrate_legacy_data_in(
    app_dir: &Path,
    data_dir: &Path,
    chosen: bool,
    log: &mut dyn FnMut(&str),
) -> io::Result<()> {
    if resolve(data_dir) == resolve(app_dir) {
        return Ok(());
    }
    // A data folder chosen on purpose (tests, a portable copy) starts as it is.
    if chosen {
        return Ok(());
    }
    let paths = Paths::new(app_dir, data_dir);
    // Where earlier versions kept the same things, inside the app folder.
    let legacy_config = app_dir.join("config.json");
    let legacy_library = app_dir.join("profiles").join("current-profile.json");
    let legacy_sounds = app_dir.join("sounds");
    let legacy_devices = app_dir.join("data").join("devices.json");

    fs::create_dir_all(data_dir)?;
    let mut moved: Vec<&str> = Vec::new();
    if copy_into(&legacy_config, &paths.config)? {
        moved.push("settings");
    }
    if copy_into(&legacy_library, &paths.library)? {
        moved.push("decks");
    }
    if copy_into(&legacy_devices, &paths.devices)? {
        moved.push("paired devices");
    }
    // Only the user's own sounds need to travel; built-in tones are regenerated.
    if !paths.sounds.exists() && legacy_sounds.join("sounds.json").exists() {
        fs::create_dir_all(&paths.sounds)?;
        for entry in fs::read_dir(&legacy_sounds)? {
            let name = entry?.file_name();
            if name.to_str().is_some_and(is_user_sound) {
                fs::copy(legacy_sounds.join(&name), paths.sounds.join(&name))?;
            }
        }
        moved.push("sounds");
    }
    if !moved.is_empty() {
        log(&format!(
            "Moved your {} to {}. The copies in the app folder are no longer used.",
            moved.join(", "),
            data_dir.display()
        ));
    }
    Ok(())
}

/// Copies data from the app folder into the data folder, once, before
/// anything reads it. The old copies stay where they were, so nothing is lost
/// if something goes wrong; the data folder wins from then on.
pub fn migrate_legacy_data(log: &mut dyn FnMut(&str)) -> io::Result<()> {
    migrate_legacy_data_in(
        app_dir(),
        data_dir(),
        env_set("PUNCHBOARD_DATA_DIR").is_some(),
        log,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_works_out_dots_by_name() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        let base = PathBuf::from(root).join("a").join("b");
        assert_eq!(
            resolve(base.join("..").join("c").join(".").join("d")),
            PathBuf::from(root).join("a").join("c").join("d")
        );
        assert_eq!(
            resolve(PathBuf::from(root).join("..").join("..").join("x")),
            PathBuf::from(root).join("x")
        );
        assert_eq!(resolve(""), env::current_dir().unwrap());
        assert_eq!(resolve("."), env::current_dir().unwrap());
        assert_eq!(
            resolve("some/../thing"),
            env::current_dir().unwrap().join("thing")
        );
    }

    #[test]
    fn the_data_folder_of_each_platform() {
        let home = Path::new("/home/ana");
        assert_eq!(
            data_dir_for(Platform::Mac, home, None),
            home.join("Library")
                .join("Application Support")
                .join("Punchboard")
        );
        assert_eq!(
            data_dir_for(Platform::Windows, home, None),
            home.join("AppData").join("Roaming").join("Punchboard")
        );
        assert_eq!(
            data_dir_for(Platform::Windows, home, Some(Path::new("/roaming"))),
            Path::new("/roaming").join("Punchboard")
        );
        assert_eq!(
            data_dir_for(Platform::Linux, home, None),
            home.join(".config").join("punchboard")
        );
        assert_eq!(
            data_dir_for(Platform::Linux, home, Some(Path::new("/xdg"))),
            Path::new("/xdg").join("punchboard")
        );
        // Set but empty counts as set (`??` in the TypeScript): a relative folder.
        assert_eq!(
            data_dir_for(Platform::Linux, home, Some(Path::new(""))),
            Path::new("punchboard")
        );
        assert!(default_data_dir().ends_with(
            if cfg!(any(target_os = "macos", target_os = "windows")) {
                "Punchboard"
            } else {
                "punchboard"
            }
        ));
    }

    #[test]
    fn the_same_files_as_the_typescript() {
        let app = Path::new("/app");
        let data = Path::new("/data");
        let paths = Paths::new(app, data);
        assert_eq!(paths.public, app.join("public"));
        assert_eq!(
            paths.helpers,
            app.join("src").join("server").join("helpers")
        );
        assert_eq!(paths.config, data.join("config.json"));
        assert_eq!(paths.library, data.join("decks").join("library.json"));
        assert_eq!(paths.sounds, data.join("sounds"));
        assert_eq!(paths.devices, data.join("devices.json"));
        assert_eq!(paths.cache, data.join("cache"));
        assert_eq!(paths.traces, data.join("trackpad-traces"));
    }

    #[test]
    fn the_version_is_the_one_passed_or_package_json() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(app_version_in(dir.path(), None), "dev");
        assert_eq!(app_version_in(dir.path(), Some("")), "dev");
        assert_eq!(app_version_in(dir.path(), Some("9.9.9")), "9.9.9");
        fs::write(dir.path().join("package.json"), "{\"version\": 7}").unwrap();
        assert_eq!(app_version_in(dir.path(), None), "dev");
        fs::write(dir.path().join("package.json"), "not json").unwrap();
        assert_eq!(app_version_in(dir.path(), None), "dev");
        fs::write(dir.path().join("package.json"), "{\"version\": \"1.7.0\"}").unwrap();
        assert_eq!(app_version_in(dir.path(), None), "1.7.0");
        assert_eq!(app_version_in(dir.path(), Some("2.0.0")), "2.0.0");
    }

    #[test]
    fn the_app_folder_is_the_one_holding_public() {
        let dir = tempfile::tempdir().unwrap();
        let root = resolve(dir.path());
        fs::create_dir_all(root.join("public")).unwrap();
        fs::create_dir_all(root.join("server/target/debug")).unwrap();
        assert_eq!(
            app_dir_near(&root.join("server/target/debug/punchboard-server")),
            Some(root.clone())
        );
        assert_eq!(app_dir_near(&root.join("punchboard-server")), Some(root));
        // This crate's own tests run from server/target/…, inside the repository.
        assert!(app_dir().join("public").is_dir() || env::var_os("PUNCHBOARD_APP_DIR").is_some());
    }

    #[test]
    fn which_legacy_sounds_travel() {
        for name in ["sound-1.wav", "sound-8.mp3", "sounds.json"] {
            assert!(is_user_sound(name), "{name}");
        }
        for name in [
            "sound-0.wav",
            "sound-9.wav",
            "sound-1.ogg",
            "sound-12.wav",
            "xsound-1.wav",
            "sound-1.wav.bak",
            "sounds.json.bak",
            "tone-1.wav",
            "sound-.wav",
        ] {
            assert!(!is_user_sound(name), "{name}");
        }
    }

    fn legacy_app(dir: &Path) -> PathBuf {
        let app = dir.join("app");
        fs::create_dir_all(app.join("profiles")).unwrap();
        fs::create_dir_all(app.join("data")).unwrap();
        fs::create_dir_all(app.join("sounds")).unwrap();
        fs::write(app.join("config.json"), "{\"port\":9000}").unwrap();
        fs::write(
            app.join("profiles/current-profile.json"),
            "{\"profiles\":[]}",
        )
        .unwrap();
        fs::write(app.join("data/devices.json"), "{\"version\":1}").unwrap();
        for name in [
            "sounds.json",
            "sound-1.wav",
            "sound-8.mp3",
            "sound-9.wav",
            "tone-1.wav",
        ] {
            fs::write(app.join("sounds").join(name), name).unwrap();
        }
        app
    }

    #[test]
    fn legacy_data_moves_once_and_the_data_folder_wins_after() {
        let dir = tempfile::tempdir().unwrap();
        let app = legacy_app(dir.path());
        let data = dir.path().join("data-folder");
        let mut lines: Vec<String> = Vec::new();
        migrate_legacy_data_in(&app, &data, false, &mut |line| lines.push(line.to_string()))
            .unwrap();
        assert_eq!(
            lines,
            [format!(
                "Moved your settings, decks, paired devices, sounds to {}. The copies in the app folder are no longer used.",
                data.display()
            )]
        );
        assert_eq!(
            fs::read_to_string(data.join("config.json")).unwrap(),
            "{\"port\":9000}"
        );
        assert_eq!(
            fs::read_to_string(data.join("decks/library.json")).unwrap(),
            "{\"profiles\":[]}"
        );
        assert_eq!(
            fs::read_to_string(data.join("devices.json")).unwrap(),
            "{\"version\":1}"
        );
        let mut sounds: Vec<String> = fs::read_dir(data.join("sounds"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        sounds.sort();
        assert_eq!(sounds, ["sound-1.wav", "sound-8.mp3", "sounds.json"]);
        // The old copies stay where they were.
        assert!(app.join("config.json").exists() && app.join("sounds/sound-1.wav").exists());

        // A second start moves nothing and says nothing, whatever the app folder holds now.
        fs::write(app.join("config.json"), "{\"port\":1}").unwrap();
        lines.clear();
        migrate_legacy_data_in(&app, &data, false, &mut |line| lines.push(line.to_string()))
            .unwrap();
        assert!(lines.is_empty());
        assert_eq!(
            fs::read_to_string(data.join("config.json")).unwrap(),
            "{\"port\":9000}"
        );
    }

    #[test]
    fn only_what_is_missing_moves() {
        let dir = tempfile::tempdir().unwrap();
        let app = legacy_app(dir.path());
        fs::remove_file(app.join("sounds/sounds.json")).unwrap();
        let data = dir.path().join("data-folder");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("config.json"), "{}").unwrap();
        let mut lines: Vec<String> = Vec::new();
        migrate_legacy_data_in(&app, &data, false, &mut |line| lines.push(line.to_string()))
            .unwrap();
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].starts_with("Moved your decks, paired devices to "),
            "{}",
            lines[0]
        );
        assert_eq!(fs::read_to_string(data.join("config.json")).unwrap(), "{}");
        // Without a sounds.json the built-in tones are simply regenerated.
        assert!(!data.join("sounds").exists());
    }

    #[test]
    fn a_chosen_data_folder_or_the_app_folder_itself_starts_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let app = legacy_app(dir.path());
        let data = dir.path().join("portable");
        let mut lines: Vec<String> = Vec::new();
        migrate_legacy_data_in(&app, &data, true, &mut |line| lines.push(line.to_string()))
            .unwrap();
        assert!(!data.exists() && lines.is_empty());
        migrate_legacy_data_in(&app, &app.join("."), false, &mut |line| {
            lines.push(line.to_string())
        })
        .unwrap();
        assert!(!app.join("decks").exists() && lines.is_empty());
    }

    #[test]
    fn nothing_to_move_only_makes_the_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("app");
        fs::create_dir_all(&app).unwrap();
        let data = dir.path().join("fresh");
        let mut lines: Vec<String> = Vec::new();
        migrate_legacy_data_in(&app, &data, false, &mut |line| lines.push(line.to_string()))
            .unwrap();
        assert!(data.is_dir() && lines.is_empty());
        assert_eq!(fs::read_dir(&data).unwrap().count(), 0);
    }
}
