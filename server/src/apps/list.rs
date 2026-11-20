//! The applications installed on this computer, for the "Launch an app" picker.
//! macOS: .app bundles in the usual folders, one level of subfolders included
//! (suites such as DaVinci Resolve keep theirs in one). Windows: the Start
//! Menu's shortcuts, which is what the Start Menu itself lists, and the
//! .url ones that start an app (games from Steam or Epic) rather than open a
//! web page. Linux: the desktop entries of the XDG data folders, Flatpak's and
//! Snap's included, which is what the desktop's own launcher lists.
//! (src/server/apps.ts)
//!
//! Everything here decides; reading the environment and asking the system for
//! its language is in list_mac.rs, list_windows.rs and list_linux.rs.
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{Collator, CollatorBorrowed};
use icu_locale_core::Locale;
use serde::{Deserialize, Serialize};

use super::desktop_entry::{desktop_file_id, DesktopEntry};
use crate::model::js;

/// An application the companion can launch, as the picker lists it.
/// (`AppEntry` of src/shared/api.ts)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppEntry {
    pub name: String,
    /// What "Launch an app" is given: the bundle on macOS, the shortcut on
    /// Windows, the .desktop file on Linux.
    pub path: String,
}

// ------------------------------------------------------------------ macOS

/// The folders a Mac keeps its applications in.
pub fn mac_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        home.join("Applications"),
    ]
}

/// The .app bundles under `roots`, one level of subfolders included, each
/// once, in the order they are found.
pub fn mac_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    fn visit(dir: &Path, depth: u32, seen: &mut HashSet<String>, found: &mut Vec<AppEntry>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let full = dir.join(entry.file_name());
            if let Some(app) = name.strip_suffix(".app") {
                let path = full.to_string_lossy().into_owned();
                if seen.insert(path.clone()) {
                    found.push(AppEntry {
                        name: app.to_string(),
                        path,
                    });
                }
            // The entry's own type, as Node's Dirent: a link to a folder is
            // not a folder.
            } else if depth < 1 && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                visit(&full, depth + 1, seen, found);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for root in roots {
        visit(root, 0, &mut seen, &mut found);
    }
    found
}

// ---------------------------------------------------------------- Windows

/// One piece of a name pattern; see [`NOT_APPS`].
enum Piece {
    /// These characters, in either case.
    Text(&'static str),
    /// These characters, or nothing.
    Maybe(&'static str),
    /// One of these.
    Either(&'static [&'static str]),
}
use Piece::{Either, Maybe, Text};

// Uninstallers, readmes and links to the maker's site live beside the real
// shortcuts. Whole words only, so "Helpdesk", "Hotspot Helper" or "Manual
// Focus" stay; "help" only as the last word ("VLC Help"), since a name that
// starts with it ("Help Desk Pro") is as likely an app as not.
//
// Each of these is a whole-word pattern (the TypeScript's /\b…\b/i); the
// eighth, /(^|\s)help$/i, is `ends_with_help`.
const NOT_APPS: [&[Piece]; 7] = [
    &[Text("uninstall"), Maybe("er")],
    &[Text("read"), Maybe(" "), Text("me")],
    &[Text("release notes")],
    &[Text("web"), Maybe(" "), Text("site")],
    &[Text("on the web")],
    &[Text("documentation")],
    &[
        Text("user"),
        Maybe("'"),
        Maybe("s"),
        Text(" "),
        Either(&["guide", "manual"]),
    ],
];

/// A letter, a digit or "_" of ASCII: what JavaScript's `\b` calls a word.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Whether a word starts or ends between `at - 1` and `at`.
fn boundary(chars: &[char], at: usize) -> bool {
    let before = at > 0 && is_word(chars[at - 1]);
    let after = chars.get(at).copied().is_some_and(is_word);
    before != after
}

/// Where `text` ends if `chars` has it at `at`. Case is ignored for ASCII
/// letters only, as a JavaScript /i without /u does for these patterns: no
/// other letter folds to one of theirs ("ſ" and "K" are left alone).
fn text_at(chars: &[char], at: usize, text: &str) -> Option<usize> {
    let mut end = at;
    for wanted in text.chars() {
        if !chars.get(end)?.eq_ignore_ascii_case(&wanted) {
            return None;
        }
        end += 1;
    }
    Some(end)
}

/// Whether `pieces` match at `at` and a word ends where they do.
fn pieces_at(chars: &[char], at: usize, pieces: &[Piece]) -> bool {
    let Some((piece, rest)) = pieces.split_first() else {
        return boundary(chars, at);
    };
    let then = |text: &str| text_at(chars, at, text).is_some_and(|end| pieces_at(chars, end, rest));
    match piece {
        Text(text) => then(text),
        Maybe(text) => then(text) || pieces_at(chars, at, rest),
        Either(texts) => texts.iter().any(|text| then(text)),
    }
}

/// /(^|\s)help$/i
fn ends_with_help(chars: &[char]) -> bool {
    let Some(start) = chars.len().checked_sub(4) else {
        return false;
    };
    text_at(chars, start, "help").is_some() && (start == 0 || js::is_space(chars[start - 1]))
}

/// Whether a Start Menu entry's name looks like an app.
pub fn is_app_name(name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    let listed = NOT_APPS.iter().any(|pieces| {
        (0..=chars.len()).any(|at| boundary(&chars, at) && pieces_at(&chars, at, pieces))
    });
    !listed && !ends_with_help(&chars)
}

/// Schemes that make an Internet Shortcut a link, not an app.
const LINK_SCHEMES: [&str; 8] = [
    "http",
    "https",
    "ftp",
    "file",
    "mailto",
    "about",
    "javascript",
    "data",
];

/// The scheme of a "URL = scheme:" line starting at `start`, read as
/// /^\s*URL\s*=\s*([a-z][a-z0-9+.-]*):/i reads it (the spaces may run over
/// line ends, as `\s` does).
fn url_scheme_at(chars: &[char], start: usize) -> Option<String> {
    let skip = |mut at: usize| {
        while chars.get(at).copied().is_some_and(js::is_space) {
            at += 1;
        }
        at
    };
    let at = text_at(chars, skip(start), "url")?;
    let at = text_at(chars, skip(at), "=")?;
    let first = skip(at);
    if !chars.get(first)?.is_ascii_alphabetic() {
        return None;
    }
    let mut end = first + 1;
    while chars
        .get(end)
        .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        end += 1;
    }
    (chars.get(end) == Some(&':')).then(|| chars[first..end].iter().collect())
}

/// For an Internet Shortcut (.url), whether it starts an app: a game
/// library's steam://rungameid/... does, a web page or a file does not
/// (those are links, and "Open a link" is the step for them).
pub fn url_shortcut_starts_app(content: &str) -> bool {
    let chars: Vec<char> = content.chars().collect();
    // The first line that says URL decides, as the first match of a regular
    // expression does. Lines end where JavaScript's /m says they do.
    let line_starts = std::iter::once(0).chain(
        chars
            .iter()
            .enumerate()
            .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
            .map(|(at, _)| at + 1),
    );
    for start in line_starts {
        if let Some(scheme) = url_scheme_at(&chars, start) {
            return !LINK_SCHEMES
                .iter()
                .any(|link| scheme.eq_ignore_ascii_case(link));
        }
    }
    false
}

/// ".lnk" or ".url" at the end of a name, in any case; true for ".url".
fn shortcut_kind(name: &str) -> Option<bool> {
    let at = name.len().checked_sub(4)?;
    let extension = name.get(at..)?;
    if extension.eq_ignore_ascii_case(".lnk") {
        Some(false)
    } else if extension.eq_ignore_ascii_case(".url") {
        Some(true)
    } else {
        None
    }
}

/// The Start Menu's shortcuts under `roots`. One entry per name: the same
/// app is often in both the machine's and the user's Start Menu, and a .lnk
/// wins over a .url of the same name.
pub fn windows_apps(roots: &[PathBuf]) -> Vec<AppEntry> {
    /// As a JavaScript Map: a name keeps the place it first took.
    #[derive(Default)]
    struct Found {
        place: HashMap<String, usize>,
        apps: Vec<AppEntry>,
        from_url: HashSet<String>,
    }
    fn visit(dir: &Path, depth: u32, found: &mut Found) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let full = dir.join(entry.file_name());
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if depth < 3 {
                    visit(&full, depth + 1, found);
                }
                continue;
            }
            let file = entry.file_name().to_string_lossy().into_owned();
            let Some(is_url) = shortcut_kind(&file) else {
                continue;
            };
            let name = js::trim(&file[..file.len() - 4]);
            if name.is_empty() || !is_app_name(name) {
                continue;
            }
            let key = name.to_lowercase();
            if found.place.contains_key(&key) && (is_url || !found.from_url.contains(&key)) {
                continue;
            }
            if is_url {
                // Read as Node reads "utf8": bytes that are not text become
                // U+FFFD, and a byte order mark stays (it counts as a space).
                let Ok(bytes) = fs::read(&full) else {
                    continue;
                };
                if !url_shortcut_starts_app(&String::from_utf8_lossy(&bytes)) {
                    continue;
                }
                found.from_url.insert(key.clone());
            } else {
                found.from_url.remove(&key);
            }
            let app = AppEntry {
                name: name.to_string(),
                path: full.to_string_lossy().into_owned(),
            };
            match found.place.get(&key) {
                Some(&place) => found.apps[place] = app,
                None => {
                    found.place.insert(key, found.apps.len());
                    found.apps.push(app);
                }
            }
        }
    }
    let mut found = Found::default();
    for root in roots {
        visit(root, 0, &mut found);
    }
    found.apps
}

/// The Start Menu of the machine, then the user's. `variable` reads the
/// environment (ProgramData, APPDATA).
pub fn windows_start_menus(variable: impl Fn(&str) -> Option<String>, home: &Path) -> Vec<PathBuf> {
    let programs = |base: PathBuf| {
        ["Microsoft", "Windows", "Start Menu", "Programs"]
            .iter()
            .fold(base, |path, part| path.join(part))
    };
    vec![
        programs(
            variable("ProgramData")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("C:\\ProgramData")),
        ),
        programs(
            variable("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Roaming")),
        ),
    ]
}

// ------------------------------------------------------------------ Linux

/// What the listing of desktop entries depends on, read from the
/// environment by list_linux.rs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinuxSession {
    /// The locales to look names up in, best first: "es_CO", then "es".
    pub locales: Vec<String>,
    /// The desktops this session is ($XDG_CURRENT_DESKTOP): "GNOME", "KDE".
    pub desktops: Vec<String>,
    /// The folders programs are looked up in ($PATH).
    pub path: Vec<PathBuf>,
}

/// The folders desktop entries are in, the one that wins first: the user's,
/// the system's, then what Flatpak and Snap export (they are usually among
/// the system's already; listed here they are found on a session that was
/// started without them).
pub fn linux_application_dirs(
    variable: impl Fn(&str) -> Option<String>,
    home: &Path,
) -> Vec<PathBuf> {
    // The specification: a variable that is empty or not an absolute path
    // counts as not set.
    let absolute = |text: &str| Some(PathBuf::from(text)).filter(|path| path.is_absolute());
    let data_home = variable("XDG_DATA_HOME")
        .and_then(|text| absolute(&text))
        .unwrap_or_else(|| home.join(".local").join("share"));
    let mut data_dirs: Vec<PathBuf> = variable("XDG_DATA_DIRS")
        .unwrap_or_default()
        .split(':')
        .filter_map(absolute)
        .collect();
    if data_dirs.is_empty() {
        data_dirs = vec![
            PathBuf::from("/usr/local/share"),
            PathBuf::from("/usr/share"),
        ];
    }
    let mut dirs = vec![data_home.join("applications")];
    dirs.extend(data_dirs.iter().map(|dir| dir.join("applications")));
    dirs.push(data_home.join("flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    let mut seen = HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));
    dirs
}

/// The applications the desktop entries under `dirs` describe: one per
/// desktop-file id, the first folder's winning (so an entry a person hid in
/// their own folder hides the system's), and only those a launcher shows.
pub fn linux_apps(
    dirs: &[PathBuf],
    session: &LinuxSession,
    is_program: &dyn Fn(&Path) -> bool,
) -> Vec<AppEntry> {
    /// Every .desktop file under `dir`, in a fixed order.
    fn files(dir: &Path, depth: u32, found: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        paths.sort();
        for path in paths {
            // Followed through links: Flatpak's exports are links.
            let Ok(kind) = fs::metadata(&path) else {
                continue;
            };
            if kind.is_dir() {
                if depth < 4 {
                    files(&path, depth + 1, found);
                }
            } else if path.extension().is_some_and(|ext| ext == "desktop") {
                found.push(path);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut apps = Vec::new();
    for dir in dirs {
        let mut found = Vec::new();
        files(dir, 0, &mut found);
        for file in found {
            if !seen.insert(desktop_file_id(dir, &file)) {
                continue;
            }
            let Ok(bytes) = fs::read(&file) else {
                continue;
            };
            let entry = DesktopEntry::parse(&String::from_utf8_lossy(&bytes));
            if !entry.is_shown(&session.desktops, &session.path, is_program) {
                continue;
            }
            if let Some(name) = entry.localized("Name", &session.locales) {
                apps.push(AppEntry {
                    name,
                    path: file.to_string_lossy().into_owned(),
                });
            }
        }
    }
    apps
}

// -------------------------------------------------------------- the order

/// The language Node's Intl started in on macOS and Linux, which is what
/// `localeCompare(…, undefined, …)` sorted by: the first of LC_ALL,
/// LC_MESSAGES and LANG that is set, without its encoding ("fr_FR.UTF-8" is
/// "fr-FR"), and "en-US" when that names no language. (The same reading as
/// i18n.rs's own, which is private to it.)
pub fn posix_locale(variable: impl Fn(&str) -> Option<String>) -> String {
    let raw = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|name| variable(name));
    let Some(raw) = raw else {
        return "en-US".to_string();
    };
    match raw.split(['.', '@']).next().unwrap_or("") {
        "C" | "POSIX" => "en-US".to_string(),
        "" => "und".to_string(),
        name => name.replace('_', "-"),
    }
}

/// Compares names as `a.localeCompare(b, locale, { sensitivity: "base" })`:
/// letters only, so neither case nor accents count (unless the language
/// says an accented letter is a letter of its own, as Spanish does of ñ).
pub struct NameOrder {
    collator: Option<CollatorBorrowed<'static>>,
}

impl NameOrder {
    pub fn new(locale: &str) -> NameOrder {
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        // A locale that cannot be read, or has no rules of its own, sorts by
        // the rules all languages share.
        let locale = Locale::try_from_str(locale).unwrap_or(Locale::UNKNOWN);
        let collator = Collator::try_new((&locale).into(), options)
            .or_else(|_| Collator::try_new(Default::default(), options))
            .ok();
        NameOrder { collator }
    }

    pub fn compare(&self, a: &str, b: &str) -> Ordering {
        match &self.collator {
            Some(collator) => collator.compare(a, b),
            // Never, with the rules compiled in; still an order if so.
            None => a.to_lowercase().cmp(&b.to_lowercase()),
        }
    }
}

/// Sorts a list by name for `locale`; equal names keep their order.
pub fn sort_apps(apps: &mut [AppEntry], locale: &str) {
    let order = NameOrder::new(locale);
    apps.sort_by(|a, b| order.compare(&a.name, &b.name));
}

// -------------------------------------------------------------- the list

const TTL: Duration = Duration::from_millis(60000);

/// The list, kept for a minute: the picker asks on every keystroke.
pub struct AppList {
    held: Mutex<Option<(Instant, Vec<AppEntry>)>>,
}

impl Default for AppList {
    fn default() -> Self {
        AppList::new()
    }
}

impl AppList {
    pub const fn new() -> AppList {
        AppList {
            held: Mutex::new(None),
        }
    }

    /// The list as of `now`: what was read less than a minute ago, or what
    /// `read` finds.
    pub fn get(&self, now: Instant, read: impl FnOnce() -> Vec<AppEntry>) -> Vec<AppEntry> {
        let mut held = self.held.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((at, apps)) = held.as_ref() {
            if now.saturating_duration_since(*at) < TTL {
                return apps.clone();
            }
        }
        let apps = read();
        *held = Some((now, apps.clone()));
        apps
    }
}

/// This computer's applications, read now, in the picker's order.
pub fn installed_apps() -> Vec<AppEntry> {
    #[cfg(target_os = "linux")]
    use super::list_linux as system;
    #[cfg(target_os = "macos")]
    use super::list_mac as system;
    #[cfg(target_os = "windows")]
    use super::list_windows as system;

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let mut apps = system::apps();
        sort_apps(&mut apps, &system::locale());
        apps
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    Vec::new()
}

/// This computer's applications, for GET /api/apps.
pub fn list_apps() -> Vec<AppEntry> {
    static LIST: OnceLock<AppList> = OnceLock::new();
    LIST.get_or_init(AppList::new)
        .get(Instant::now(), installed_apps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::testing::{cases, make_tree, relative};
    use serde_json::{json, Value};

    #[test]
    fn is_app_name_matches_the_typescript() {
        let all = cases("isAppName.json");
        assert!(all.len() >= 2000, "{} cases", all.len());
        let different: Vec<String> = all
            .iter()
            .filter(|case| json!(is_app_name(case["input"].as_str().unwrap())) != case["output"])
            .map(|case| format!("isAppName({}) is {}", case["input"], case["output"]))
            .collect();
        assert!(different.is_empty(), "{}", different.join("\n"));
    }

    /// tests/scripts.test.mjs: "Real apps are kept and uninstallers, readmes
    /// and help pages dropped".
    #[test]
    fn real_apps_are_kept_and_the_rest_dropped() {
        let names = [
            "Helpdesk",
            "Hotspot Helper",
            "Manual Focus",
            "Uninstall Foo",
            "Foo Uninstaller",
            "Readme",
            "Read Me",
            "VLC Help",
            "Foo Website",
            "Foo on the Web",
            "Foo Documentation",
            "Help Desk Pro",
            "Release Notes",
            "Web Site",
            "User Manual",
            "GIMP",
            "Unhelpful Tool",
        ];
        let kept: Vec<&str> = names.into_iter().filter(|name| is_app_name(name)).collect();
        assert_eq!(
            kept.join("|"),
            "Helpdesk|Hotspot Helper|Manual Focus|Help Desk Pro|GIMP|Unhelpful Tool"
        );
    }

    #[test]
    fn url_shortcut_starts_app_matches_the_typescript() {
        let all = cases("urlShortcutStartsApp.json");
        assert!(all.len() >= 1500, "{} cases", all.len());
        let different: Vec<String> = all
            .iter()
            .filter(|case| {
                json!(url_shortcut_starts_app(case["input"].as_str().unwrap())) != case["output"]
            })
            .map(|case| {
                format!(
                    "urlShortcutStartsApp({}) is {}",
                    case["input"], case["output"]
                )
            })
            .collect();
        assert!(different.is_empty(), "{}", different.join("\n"));
    }

    /// tests/scripts.test.mjs: the two ".url shortcuts" checks.
    #[test]
    fn game_shortcuts_are_apps_and_web_pages_are_not() {
        assert!(url_shortcut_starts_app(
            "[InternetShortcut]\r\nURL=steam://rungameid/570\r\nIconIndex=0\r\n"
        ));
        assert!(url_shortcut_starts_app("[{000214A0-0000-0000-C000-000000000046}]\nProp3=19,0\n[InternetShortcut]\nURL=com.epicgames.launcher://apps/Fortnite?action=launch\n"));
        assert!(!url_shortcut_starts_app(
            "[InternetShortcut]\nURL=https://example.com/\n"
        ));
        assert!(!url_shortcut_starts_app(
            "[InternetShortcut]\nURL=file:///C:/x.txt\n"
        ));
        assert!(!url_shortcut_starts_app("garbage"));
    }

    fn by_path(mut apps: Vec<Value>) -> Vec<Value> {
        apps.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        apps
    }

    #[test]
    fn windows_apps_matches_the_typescript() {
        let all = cases("windowsApps.json");
        assert!(all.len() >= 15, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let base = make_tree(input);
            let roots: Vec<PathBuf> = input["roots"]
                .as_array()
                .unwrap()
                .iter()
                .map(|root| base.path().join(root.as_str().unwrap()))
                .collect();
            // In a fixed order on both sides: the order folders are read in
            // is the file system's.
            let ours = by_path(relative(&windows_apps(&roots), base.path()));
            let theirs = by_path(case["output"].as_array().unwrap().clone());
            assert_eq!(ours, theirs, "{}", input["name"]);
        }
    }

    /// tests/scripts.test.mjs: "The Start Menu lists each app once, game
    /// shortcuts included and web links not".
    #[test]
    fn the_start_menu_lists_each_app_once() {
        let root = tempfile::tempdir().unwrap();
        let touch = |file: &str, content: &str| {
            let full = root.path().join(file);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, content).unwrap();
        };
        touch("machine/Discord Inc/Discord.lnk", "");
        touch("machine/Helpdesk.lnk", "");
        touch("machine/Foo/Uninstall Foo.lnk", "");
        touch(
            "machine/Foo/Foo Website.url",
            "[InternetShortcut]\nURL=https://foo.example/\n",
        );
        touch("user/Discord.lnk", "");
        touch(
            "user/Steam/Dota 2.url",
            "[InternetShortcut]\nURL=steam://rungameid/570\n",
        );
        touch(
            "user/Steam/Portal.url",
            "[InternetShortcut]\nURL=steam://rungameid/400\n",
        );
        touch("user/Portal.lnk", "");
        touch("user/notes.txt", "");
        let apps = windows_apps(&[root.path().join("machine"), root.path().join("user")]);
        let mut listed: Vec<String> = relative(&apps, root.path())
            .iter()
            .map(|app| {
                format!(
                    "{}={}",
                    app["name"].as_str().unwrap(),
                    app["path"].as_str().unwrap()
                )
            })
            .collect();
        listed.sort();
        assert_eq!(
            listed,
            [
                "Discord=machine/Discord Inc/Discord.lnk",
                "Dota 2=user/Steam/Dota 2.url",
                "Helpdesk=machine/Helpdesk.lnk",
                "Portal=user/Portal.lnk"
            ]
        );
    }

    #[test]
    fn a_shortcut_takes_the_place_its_name_first_had() {
        // A link, another app, then the shortcut that replaces the link: the
        // name stays first, as in a JavaScript Map.
        let root = tempfile::tempdir().unwrap();
        for (file, content) in [
            ("a/Game.url", "URL=steam://x"),
            ("b/Other.lnk", ""),
            ("c/Game.lnk", ""),
        ] {
            let full = root.path().join(file);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, content).unwrap();
        }
        let roots = ["a", "b", "c"].map(|dir| root.path().join(dir));
        let apps = relative(&windows_apps(&roots), root.path());
        assert_eq!(
            apps,
            [
                json!({ "name": "Game", "path": "c/Game.lnk" }),
                json!({ "name": "Other", "path": "b/Other.lnk" })
            ]
        );
    }

    #[test]
    fn the_start_menus_are_the_machines_then_the_users() {
        let none = |_: &str| None;
        let menus = windows_start_menus(none, Path::new("home"));
        assert_eq!(
            menus,
            [
                Path::new("C:\\ProgramData").join("Microsoft/Windows/Start Menu/Programs"),
                Path::new("home").join("AppData/Roaming/Microsoft/Windows/Start Menu/Programs")
            ]
        );
        let set = |name: &str| match name {
            "ProgramData" => Some("pd".to_string()),
            "APPDATA" => Some("ad".to_string()),
            _ => None,
        };
        let menus = windows_start_menus(set, Path::new("home"));
        assert_eq!(
            menus,
            [
                Path::new("pd").join("Microsoft/Windows/Start Menu/Programs"),
                Path::new("ad").join("Microsoft/Windows/Start Menu/Programs")
            ]
        );
    }

    #[test]
    fn mac_apps_matches_the_typescript() {
        let all = cases("macApps.json");
        assert!(all.len() >= 6, "{} cases", all.len());
        for case in &all {
            let input = &case["input"];
            let home = tempfile::tempdir().unwrap();
            let applications = home.path().join("Applications");
            for entry in input["entries"].as_array().unwrap() {
                let entry = entry.as_str().unwrap();
                let full = applications.join(entry.trim_end_matches('/'));
                if entry.ends_with('/') {
                    fs::create_dir_all(&full).unwrap();
                } else {
                    fs::create_dir_all(full.parent().unwrap()).unwrap();
                    fs::write(&full, "").unwrap();
                }
            }
            let mut apps = mac_apps(std::slice::from_ref(&applications));
            let language = input["locale"].as_str().unwrap().to_string();
            let locale = posix_locale(|name| (name == "LC_ALL").then(|| language.clone()));
            sort_apps(&mut apps, &locale);
            assert_eq!(
                Value::Array(relative(&apps, &applications)),
                case["output"],
                "{}",
                input["name"]
            );
        }
    }

    #[test]
    fn mac_apps_are_listed_once_and_links_are_not_followed() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("System/Utilities/Terminal.app")).unwrap();
        fs::create_dir_all(root.path().join("System/Safari.app")).unwrap();
        #[cfg(unix)]
        {
            fs::create_dir_all(root.path().join("Elsewhere/Linked.app")).unwrap();
            std::os::unix::fs::symlink(
                root.path().join("Elsewhere"),
                root.path().join("System/Link"),
            )
            .unwrap();
        }
        // The Utilities folder is a root of its own and one level under another.
        let roots = [
            root.path().join("System"),
            root.path().join("System/Utilities"),
            root.path().join("missing"),
        ];
        let mut names: Vec<String> = mac_apps(&roots).into_iter().map(|app| app.name).collect();
        names.sort();
        assert_eq!(names, ["Safari", "Terminal"]);
        assert_eq!(
            mac_roots(Path::new("/Users/ann")),
            [
                "/Applications",
                "/System/Applications",
                "/System/Applications/Utilities",
                "/Users/ann/Applications"
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    fn the_order_matches_the_typescript() {
        let all = cases("order.json");
        assert!(all.len() >= 16, "{} cases", all.len());
        for case in &all {
            let locale = case["input"]["locale"].as_str().unwrap();
            let mut apps: Vec<AppEntry> = case["input"]["names"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| AppEntry {
                    name: name.as_str().unwrap().to_string(),
                    path: String::new(),
                })
                .collect();
            sort_apps(&mut apps, locale);
            let ours: Vec<Value> = apps.into_iter().map(|app| json!(app.name)).collect();
            let theirs = case["output"].as_array().unwrap();
            let first = ours.iter().zip(theirs).position(|(a, b)| a != b);
            assert!(
                first.is_none(),
                "{locale}: differs from place {}\n   rust: {}\n   node: {}",
                first.unwrap_or(0),
                Value::Array(ours.clone()),
                Value::Array(theirs.clone())
            );
        }
    }

    #[test]
    fn the_language_of_the_order_is_the_environments() {
        let with = |name: &'static str, value: &'static str| {
            move |asked: &str| (asked == name).then(|| value.to_string())
        };
        assert_eq!(posix_locale(|_| None), "en-US");
        assert_eq!(posix_locale(with("LANG", "es_CO.UTF-8")), "es-CO");
        assert_eq!(posix_locale(with("LC_ALL", "C")), "en-US");
        assert_eq!(posix_locale(with("LANG", "C.UTF-8")), "en-US");
        assert_eq!(posix_locale(with("LC_MESSAGES", "sr_RS@latin")), "sr-RS");
        assert_eq!(posix_locale(with("LANG", "")), "und");
        // Nonsense still sorts.
        let mut apps = vec![
            AppEntry {
                name: "b".into(),
                path: String::new(),
            },
            AppEntry {
                name: "A".into(),
                path: String::new(),
            },
        ];
        sort_apps(&mut apps, "not a locale!");
        assert_eq!(apps[0].name, "A");
    }

    #[test]
    fn the_list_is_kept_for_a_minute() {
        let list = AppList::new();
        let app = |name: &str| {
            vec![AppEntry {
                name: name.into(),
                path: String::new(),
            }]
        };
        let start = Instant::now();
        assert_eq!(list.get(start, || app("first")), app("first"));
        let soon = start + Duration::from_millis(59999);
        assert_eq!(list.get(soon, || app("second")), app("first"));
        let later = start + Duration::from_millis(60000);
        assert_eq!(list.get(later, || app("third")), app("third"));
        assert_eq!(list.get(later + TTL / 2, || app("fourth")), app("third"));
    }

    #[test]
    fn an_entry_is_written_as_the_pages_read_it() {
        let app = AppEntry {
            name: "Café".into(),
            path: "/Applications/Café.app".into(),
        };
        assert_eq!(
            crate::store::stringify(&serde_json::to_value(&app).unwrap()),
            r#"{"name":"Café","path":"/Applications/Café.app"}"#
        );
    }

    // ------------------------------------------------------------ Linux

    fn write(root: &Path, file: &str, content: &str) {
        let full = root.join(file);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }

    fn entry(name: &str, more: &str) -> String {
        format!("[Desktop Entry]\nType=Application\nName={name}\nExec=run\n{more}")
    }

    #[test]
    fn linux_lists_what_a_launcher_shows() {
        let root = tempfile::tempdir().unwrap();
        let user = root.path().join("user/applications");
        let system = root.path().join("system/applications");
        write(
            &user,
            "editor.desktop",
            &entry("My editor", "Name[es]=Mi editor\n"),
        );
        // The user's entry hides the system's of the same id, shown or not.
        write(&system, "editor.desktop", &entry("System editor", ""));
        write(&user, "gone.desktop", &entry("Gone", "Hidden=true\n"));
        write(&system, "gone.desktop", &entry("Still here", ""));
        write(
            &system,
            "quiet.desktop",
            &entry("Quiet", "NoDisplay=true\n"),
        );
        write(
            &system,
            "link.desktop",
            "[Desktop Entry]\nType=Link\nName=A link\nURL=https://example.com\n",
        );
        write(
            &system,
            "kde/tool.desktop",
            &entry("KDE tool", "OnlyShowIn=KDE;\n"),
        );
        write(
            &system,
            "gnome/tool.desktop",
            &entry("GNOME tool", "OnlyShowIn=GNOME;Unity;\n"),
        );
        write(
            &system,
            "not-gnome.desktop",
            &entry("Not for GNOME", "NotShowIn=GNOME;\n"),
        );
        write(
            &system,
            "there.desktop",
            &entry("Installed", "TryExec=there\n"),
        );
        write(
            &system,
            "missing.desktop",
            &entry("Not installed", "TryExec=missing\n"),
        );
        write(
            &system,
            "no-exec.desktop",
            "[Desktop Entry]\nType=Application\nName=No command\n",
        );
        write(
            &system,
            "no-name.desktop",
            "[Desktop Entry]\nType=Application\nExec=run\n",
        );
        write(&system, "notes.txt", "Name=Not an entry");
        // The same id, spelled with a folder and with a dash: the first read
        // wins, and folders sort before the files that start like them.
        write(&system, "vendor-app.desktop", &entry("Vendor app", ""));
        write(
            &system,
            "vendor/app.desktop",
            &entry("Vendor app again", ""),
        );
        let session = LinuxSession {
            locales: vec!["es_CO".into(), "es".into()],
            desktops: vec!["ubuntu".into(), "GNOME".into()],
            path: vec![root.path().join("bin")],
        };
        let there = root.path().join("bin/there");
        let is_program = move |path: &Path| path == there;
        let apps = linux_apps(
            &[user.clone(), system.clone(), root.path().join("none")],
            &session,
            &is_program,
        );
        let listed: Vec<String> = relative(&apps, root.path())
            .iter()
            .map(|app| {
                format!(
                    "{}={}",
                    app["name"].as_str().unwrap(),
                    app["path"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                "Mi editor=user/applications/editor.desktop",
                "GNOME tool=system/applications/gnome/tool.desktop",
                "Installed=system/applications/there.desktop",
                "Vendor app again=system/applications/vendor/app.desktop",
            ]
        );
    }

    #[test]
    fn linux_looks_in_the_xdg_folders() {
        let home = Path::new("/home/ann");
        let dirs = |pairs: &'static [(&'static str, &'static str)]| {
            linux_application_dirs(
                |name| {
                    pairs
                        .iter()
                        .find(|(known, _)| *known == name)
                        .map(|(_, value)| value.to_string())
                },
                home,
            )
        };
        assert_eq!(
            dirs(&[]),
            [
                "/home/ann/.local/share/applications",
                "/usr/local/share/applications",
                "/usr/share/applications",
                "/home/ann/.local/share/flatpak/exports/share/applications",
                "/var/lib/flatpak/exports/share/applications",
                "/var/lib/snapd/desktop/applications",
            ]
            .map(PathBuf::from)
        );
        assert_eq!(
            dirs(&[
                ("XDG_DATA_HOME", "/data"),
                ("XDG_DATA_DIRS", "/var/lib/flatpak/exports/share::relative:/usr/share:/var/lib/snapd/desktop:/usr/share")
            ]),
            [
                "/data/applications",
                "/var/lib/flatpak/exports/share/applications",
                "/usr/share/applications",
                "/var/lib/snapd/desktop/applications",
                "/data/flatpak/exports/share/applications",
            ]
            .map(PathBuf::from)
        );
        // Not absolute: as if not set.
        assert_eq!(
            dirs(&[("XDG_DATA_HOME", "data"), ("XDG_DATA_DIRS", "")])[0],
            home.join(".local/share/applications")
        );
    }

    /// The list here is the list the TypeScript gives, entry by entry. Reads
    /// this computer's real folders and runs Node, so it is run by hand:
    ///   cargo test -- --ignored the_real_list
    #[test]
    #[ignore = "runs Node on this computer's real applications"]
    fn the_real_list_is_the_typescripts() {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let module = repo.join("src/server/apps.ts");
        let script = format!(
            "import {{ listApps }} from {}; console.log(JSON.stringify(listApps()))",
            json!(format!(
                "file://{}",
                module.canonicalize().unwrap().display()
            ))
        );
        let output = std::process::Command::new("node")
            .args(["--input-type=module", "-e", &script])
            .current_dir(&repo)
            .output()
            .expect("node runs");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let theirs: Vec<AppEntry> = serde_json::from_slice(&output.stdout).expect("a list of apps");
        let ours = installed_apps();
        println!(
            "rust lists {} applications, node {}",
            ours.len(),
            theirs.len()
        );
        for (place, (a, b)) in ours.iter().zip(&theirs).enumerate() {
            assert_eq!(a, b, "place {place}");
        }
        assert_eq!(ours.len(), theirs.len());
    }
}
