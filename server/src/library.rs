//! The deck library, kept in memory and written through to disk atomically.
//! A file that will not parse is set aside and never overwritten, and each
//! save carries a revision so two Control Center windows cannot clobber
//! each other.
//!
//! A file written by a newer Punchboard (a higher "version") is not damaged,
//! just not understood: it is left exactly as it is and this Punchboard runs
//! read-only with an empty deck, saying so, until it is updated. Replacing it
//! would lose decks the moment someone downgrades.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::http::HttpError;
use crate::i18n::{english, say, Said, Text};
use crate::model::starter_decks::starter_library;
use crate::model::{is_library_shape, normalize_library, Button, Ids, Library};
use crate::store::{
    backup_of, read_json_safe, snapshot_daily, write_json_atomic, ReadError, ReadResult,
    SNAPSHOTS_KEPT,
};
use crate::translate::Translate;

type Log = Box<dyn Fn(&str) + Send + Sync>;

/// What a store is opened with, beside its file.
pub struct Setup<'a> {
    /// Words for what the companion makes on its own (the starter decks, a
    /// deck's default name): this computer's language.
    pub t: &'a dyn Translate,
    pub ids: &'a Ids,
    /// Whether the starter decks are a Mac's (`process.platform === "darwin"`).
    pub mac: bool,
    /// Milliseconds since 1970: where the revision starts.
    pub now: u64,
}

struct State {
    library: Arc<Library>,
    /// Bumped on every write. Decks refetch when it changes. It starts from the
    /// clock so a window left open across a restart can never match it by chance.
    revision: u64,
    /// Why saving is refused, when the file on disk must not be replaced.
    read_only: Option<Text>,
    /// A problem found with the file at start-up, for the Control Center to
    /// show (worded for whoever loads the deck). The next successful save clears it.
    notice: Option<Text>,
}

/// The decks (`createLibraryStore`).
pub struct LibraryStore {
    file: PathBuf,
    log: Log,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A path as the person finds it in the data folder, e.g. "decks/library.json.corrupt-…".
fn shown(target: &Path) -> String {
    let folder = target
        .parent()
        .and_then(Path::file_name)
        .map(PathBuf::from)
        .unwrap_or_default();
    match target.file_name() {
        Some(name) => folder.join(name),
        None => folder,
    }
    .to_string_lossy()
    .into_owned()
}

fn write(file: &Path, log: &Log, next: &Library) -> io::Result<()> {
    if let Err(error) = snapshot_daily(file, SNAPSHOTS_KEPT) {
        // A missed snapshot is no reason to lose the save itself.
        log(&format!("Could not take today's deck snapshot: {error}"));
    }
    write_json_atomic(file, next, true)
}

/// The format version of a deck file from a newer Punchboard, or None.
fn newer_version(file: &Path) -> Option<f64> {
    // Missing or damaged: read_json_safe deals with it.
    let bytes = fs::read(file).ok()?;
    let data: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let version = data.as_object()?.get("version")?.as_f64()?;
    (version > 1.0).then_some(version)
}

fn empty_library(setup: &Setup) -> Library {
    normalize_library(
        &json!({ "version": 1, "activeProfileId": "", "profiles": [] }),
        setup.t,
        setup.ids,
    )
}

fn starters(setup: &Setup) -> Library {
    let starter = starter_library(setup.mac, setup.t, setup.ids);
    // normalizeLibrary({ version: 1, ...starterLibrary(mac) })
    let raw = json!({
        "version": 1,
        "activeProfileId": starter.active_profile_id,
        "profiles": starter.profiles,
    });
    normalize_library(&raw, setup.t, setup.ids)
}

fn load(file: &Path, log: &Log, setup: &Setup) -> (Library, Option<Text>, Option<Text>) {
    // Decided before reading: a damaged file is moved aside while it is read,
    // after which it would look like a first start.
    let first_start = !file.exists() && !backup_of(file).exists();
    if let Some(newer) = newer_version(file) {
        let read_only = say("server.library.newerVersion")
            .with("file", shown(file))
            .with("format", newer);
        log(&english(&Said::Text(read_only.clone())));
        return (
            empty_library(setup),
            Some(read_only.clone()),
            Some(read_only),
        );
    }
    let mut notice = None;
    match read_json_safe(file, is_library_shape) {
        Ok(result) => {
            if let ReadResult::Backup { data, aside } = &result {
                let restored = if aside.exists() {
                    say("server.library.restoredDamaged").with("file", shown(aside))
                } else {
                    say("server.library.restoredMissing")
                };
                log(&english(&Said::Text(restored.clone())));
                notice = Some(restored);
                // Put the recovered deck back on disk now, not at the next edit.
                if let Err(error) = write_json_atomic(file, data, false) {
                    log(&format!("Could not write the recovered deck back: {error}"));
                }
            }
            if let Some(data) = result.data() {
                return (normalize_library(&data, setup.t, setup.ids), None, notice);
            }
        }
        Err(error) => {
            let aside = match &error {
                ReadError::Unreadable(unreadable) if unreadable.aside.exists() => {
                    Some(shown(&unreadable.aside))
                }
                _ => None,
            };
            let problem = match aside {
                Some(aside) => say("server.library.damaged").with("file", aside),
                None => say("server.library.unreadable"),
            };
            log(&format!(
                "{error} {}",
                english(&Said::Text(problem.clone()))
            ));
            notice = Some(problem);
        }
    }
    // A first start gets the starter decks, so a device does something the
    // moment it pairs. A file that was there but could not be read gets an
    // empty deck instead: its owner had decks of their own.
    let fresh = if first_start {
        starters(setup)
    } else {
        empty_library(setup)
    };
    if let Err(error) = write(file, log, &fresh) {
        log(&format!("Could not write the deck file: {error}"));
    }
    (fresh, None, notice)
}

impl LibraryStore {
    /// Reads the deck file, or starts one. `t` words what a first start is
    /// given, in this computer's language; `ids` names what is made.
    pub fn open(
        file: impl Into<PathBuf>,
        log: impl Fn(&str) + Send + Sync + 'static,
        t: &dyn Translate,
        ids: &Ids,
    ) -> LibraryStore {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0);
        let setup = Setup {
            t,
            ids,
            mac: cfg!(target_os = "macos"),
            now,
        };
        LibraryStore::open_with(file, log, &setup)
    }

    /// As `open`, with the platform and the clock given.
    pub fn open_with(
        file: impl Into<PathBuf>,
        log: impl Fn(&str) + Send + Sync + 'static,
        setup: &Setup,
    ) -> LibraryStore {
        let file: PathBuf = file.into();
        let log: Log = Box::new(log);
        let (library, read_only, notice) = load(&file, &log, setup);
        LibraryStore {
            file,
            log,
            state: Mutex::new(State {
                library: Arc::new(library),
                revision: setup.now,
                read_only,
                notice,
            }),
        }
    }

    pub fn get(&self) -> Arc<Library> {
        Arc::clone(&lock(&self.state).library)
    }

    pub fn revision(&self) -> u64 {
        lock(&self.state).revision
    }

    /// A start-up problem with the deck file worth telling the person about, or None.
    pub fn notice(&self) -> Option<Text> {
        lock(&self.state).notice.clone()
    }

    /// Replaces the library. Returns the new revision. The file is written
    /// first, so a failed write leaves both memory and disk as they were.
    pub fn save(&self, next: Library) -> Result<u64, HttpError> {
        let mut state = lock(&self.state);
        if let Some(read_only) = &state.read_only {
            return Err(HttpError::new(423, read_only.clone()));
        }
        if let Err(error) = write(&self.file, &self.log, &next) {
            return Err(HttpError::new(
                500,
                say("server.library.saveFailed").with("reason", Said::Plain(error.to_string())),
            ));
        }
        state.library = Arc::new(next);
        state.revision += 1;
        state.notice = None;
        Ok(state.revision)
    }

    pub fn find_button(&self, profile_id: &str, button_id: &str) -> Option<Button> {
        let library = self.get();
        let profile = library.profiles.iter().find(|item| item.id == profile_id)?;
        profile
            .buttons
            .iter()
            .find(|item| item.id == button_id)
            .cloned()
    }

    /// The faders of a deck (buttons whose `control` is "fader").
    pub fn faders(&self, profile_id: &str) -> Vec<Button> {
        let library = self.get();
        match library.profiles.iter().find(|item| item.id == profile_id) {
            Some(profile) => profile
                .buttons
                .iter()
                .filter(|button| button.is_fader())
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{render, translator, TextVar};
    use std::collections::BTreeMap;

    type Logs = Arc<Mutex<Vec<String>>>;

    const NOW: u64 = 1_750_000_000_000;

    fn cases(file: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/auth")
            .join(file);
        let text =
            fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    /// Text without the moment a file was made at: the damaged copy and the
    /// day's snapshot are named by the real clock here. The generator does
    /// the same to what the TypeScript said.
    fn timeless(text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = rest.find(".corrupt-") {
            out.push_str(&rest[..at]);
            out.push_str(".corrupt-*");
            rest = rest[at + 9..]
                .trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, 'T' | 'Z' | '-'));
        }
        out.push_str(rest);
        let out = out.replace('\\', "/");
        match out.strip_prefix("backups/library-") {
            Some(rest) if rest.len() == "2025-06-15.json".len() => {
                "backups/library-DATE.json".to_string()
            }
            _ => out,
        }
    }

    /// Every file under the deck folder, by its timeless name.
    fn files_in(dir: &Path) -> Value {
        let mut found = BTreeMap::new();
        let mut folders = vec![dir.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).expect("a folder") {
                let path = entry.expect("an entry").path();
                if path.is_dir() {
                    folders.push(path);
                    continue;
                }
                let name = path
                    .strip_prefix(dir)
                    .expect("inside")
                    .to_string_lossy()
                    .into_owned();
                let text = fs::read_to_string(&path).expect("text");
                found.insert(timeless(&name), text);
            }
        }
        json!(found)
    }

    fn notice_json(notice: Option<Text>, language: &str) -> Value {
        let Some(notice) = notice else {
            return Value::Null;
        };
        let mut vars = serde_json::Map::new();
        for (name, value) in &notice.vars {
            let value = match value {
                TextVar::Str(text) => json!(timeless(text)),
                // 2 and not 2.0, as the fixture has it.
                TextVar::Num(number) => {
                    serde_json::from_str(&crate::store::js_number(*number)).unwrap_or(Value::Null)
                }
                TextVar::Text(text) => json!(text.key),
            };
            vars.insert(name.clone(), value);
        }
        let worded = timeless(&render(&Said::Text(notice.clone()), language));
        json!({ "key": notice.key, "vars": vars, "worded": worded })
    }

    fn deck_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("a folder");
        let decks = dir.path().join("decks");
        fs::create_dir_all(&decks).expect("decks");
        (dir, decks)
    }

    fn logging(logs: &Logs) -> impl Fn(&str) + Send + Sync + 'static {
        let logs = Arc::clone(logs);
        move |line: &str| lock(&logs).push(line.to_string())
    }

    #[test]
    fn the_store_matches_the_typescript() {
        let all = cases("library.json");
        assert!(all.len() >= 14, "{} cases", all.len());
        let mut saves = 0;
        for case in &all {
            let name = case["name"].as_str().expect("a name");
            let input = &case["input"];
            let (_dir, decks) = deck_dir();
            for (file, text) in input["files"].as_object().expect("files") {
                fs::write(decks.join(file), text.as_str().expect("text")).expect("a file");
            }
            let words = input["words"].as_str().expect("words");
            let t = translator(words);
            let clock = case["ids"]["now"].as_u64().expect("a clock");
            let made = case["ids"]["counter"].as_u64().expect("a counter");
            let ids = Ids::starting_after(made, move || clock);
            let logs = Logs::default();
            let file = decks.join("library.json");
            let setup = Setup {
                t: &t,
                ids: &ids,
                mac: input["mac"] == true,
                now: input["now"].as_u64().expect("a time"),
            };
            let store = LibraryStore::open_with(&file, logging(&logs), &setup);
            let output = &case["output"];
            assert_eq!(
                output["library"],
                json!(*store.get()),
                "{name}: the library"
            );
            assert_eq!(
                output["revision"],
                json!(store.revision()),
                "{name}: the revision"
            );
            assert_eq!(
                output["notice"],
                notice_json(store.notice(), "en"),
                "{name}: the notice"
            );
            assert_eq!(output["files"], files_in(&decks), "{name}: the files");
            assert_eq!(
                output["logLines"],
                json!(lock(&logs).len()),
                "{name}: the log {:?}",
                lock(&logs)
            );

            let steps = input["steps"].as_array().expect("steps");
            let answers = output["steps"].as_array().expect("answers");
            assert_eq!(steps.len(), answers.len(), "{name}");
            // Node's copy of a folder onto library.json.bak fails and takes
            // the old .bak with it; here the copy fails and the .bak stays
            // (store.rs). Until the next save that works, it is not compared.
            let mut bak_differs = false;
            for (at, (step, theirs)) in steps.iter().zip(answers).enumerate() {
                let mut theirs = theirs.clone();
                let mut ours = match step["op"].as_str().expect("an op") {
                    "save" => {
                        saves += 1;
                        let next = normalize_library(&step["library"], &t, &ids);
                        match store.save(next) {
                            Ok(revision) => {
                                bak_differs = false;
                                json!({ "revision": revision })
                            }
                            Err(error) => json!({
                                "status": error.status,
                                "key": error.text.as_ref().map(|text| text.key.clone()),
                            }),
                        }
                    }
                    // A folder where library.json goes makes the write fail on every system.
                    "block" => {
                        fs::rename(&file, decks.join("library.json.keep")).expect("moved");
                        fs::create_dir(&file).expect("a folder in its place");
                        bak_differs = true;
                        Value::Null
                    }
                    "unblock" => {
                        fs::remove_dir(&file).expect("the folder gone");
                        fs::rename(decks.join("library.json.keep"), &file).expect("moved back");
                        Value::Null
                    }
                    "state" => json!({
                        "library": *store.get(),
                        "revision": store.revision(),
                        "notice": notice_json(store.notice(), "en"),
                        "files": files_in(&decks),
                    }),
                    other => panic!("{name}: no such step: {other}"),
                };
                if bak_differs {
                    for state in [&mut theirs, &mut ours] {
                        if let Some(files) = state.get_mut("files").and_then(Value::as_object_mut) {
                            files.remove("library.json.bak");
                        }
                    }
                }
                assert_eq!(theirs, ours, "{name}: step {at}");
            }
        }
        assert!(saves >= 10, "only {saves} saves");
    }

    // -------------------------------------- tests/library.test.mjs, ported

    fn deck(name: &str, buttons: Value) -> Value {
        json!({ "id": name.to_lowercase(), "name": name, "columns": 4, "rows": 3, "buttons": buttons })
    }

    fn press(id: &str, slot: u32) -> Value {
        json!({
            "id": id, "slot": slot, "label": id, "icon": "zap", "color": "accent", "control": "press",
            "steps": [{ "id": format!("s_{id}"), "type": "none", "delayMs": 0 }]
        })
    }

    fn mine() -> Value {
        json!({ "version": 1, "activeProfileId": "mine", "profiles": [deck("Mine", json!([press("a", 0)]))] })
    }

    struct Started {
        _dir: tempfile::TempDir,
        decks: PathBuf,
        file: PathBuf,
        logs: Logs,
        ids: Ids,
        store: LibraryStore,
    }

    impl Started {
        fn names(&self) -> String {
            let library = self.store.get();
            let names: Vec<&str> = library.profiles.iter().map(|p| p.name.as_str()).collect();
            names.join(",")
        }

        fn notice(&self) -> String {
            self.store
                .notice()
                .map(|notice| english(&Said::Text(notice)))
                .unwrap_or_default()
        }

        fn save(&self, raw: &Value) -> Result<u64, HttpError> {
            self.store
                .save(normalize_library(raw, &translator("en"), &self.ids))
        }

        fn listing(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.decks)
                .expect("decks")
                .map(|entry| {
                    entry
                        .expect("an entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            names.sort();
            names
        }
    }

    fn start(files: &[(&str, &str)]) -> Started {
        let (dir, decks) = deck_dir();
        for (name, text) in files {
            fs::write(decks.join(name), text).expect("a file");
        }
        let file = decks.join("library.json");
        let logs = Logs::default();
        let ids = Ids::new(|| NOW);
        let store = LibraryStore::open_with(
            &file,
            logging(&logs),
            &Setup {
                t: &translator("en"),
                ids: &ids,
                mac: true,
                now: NOW,
            },
        );
        Started {
            _dir: dir,
            decks,
            file,
            logs,
            ids,
            store,
        }
    }

    #[test]
    fn a_damaged_file_starts_an_empty_deck_and_is_kept_aside() {
        let started = start(&[("library.json", "{ this is not json")]);
        let library = started.store.get();
        assert_eq!(started.names(), "My deck");
        assert!(library.profiles[0].buttons.is_empty());
        let aside = started
            .listing()
            .into_iter()
            .find(|name| name.starts_with("library.json.corrupt-"))
            .expect("the damaged file, kept aside");
        assert_eq!(
            fs::read_to_string(started.decks.join(&aside)).expect("the damaged file"),
            "{ this is not json"
        );
        // The Control Center is told where it went.
        let notice = started.notice();
        let shown = format!("set aside as decks{}{aside}", std::path::MAIN_SEPARATOR);
        assert!(
            notice.contains(&shown) && notice.contains("decks/backups"),
            "{notice}"
        );
        // The log says where it went too.
        let log = lock(&started.logs).join("\n");
        assert!(
            log.contains(&aside) && !log.contains("profiles/backups"),
            "{log}"
        );
        // Saving clears the notice.
        started.save(&mine()).expect("saved");
        assert_eq!(started.store.notice(), None);
        assert_eq!(started.names(), "Mine");
    }

    #[test]
    fn an_empty_file_is_not_mistaken_for_a_first_start() {
        let started = start(&[("library.json", "")]);
        assert_eq!(started.names(), "My deck");
        assert!(
            started.notice().contains("set aside"),
            "{}",
            started.notice()
        );
    }

    #[test]
    fn a_damaged_file_with_a_good_previous_save_restores_that_save() {
        let saved = crate::store::stringify(&mine());
        let started = start(&[("library.json", "garbage"), ("library.json.bak", &saved)]);
        assert_eq!(started.names(), "Mine");
        assert!(
            started.notice().contains("previous save was restored"),
            "{}",
            started.notice()
        );
        assert!(
            started.notice().contains("set aside as decks"),
            "{}",
            started.notice()
        );
        // Put back on disk at once, as the backup had it.
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(&started.file).expect("library.json"))
                .expect("JSON");
        assert_eq!(stored, mine());
    }

    #[test]
    fn a_missing_file_with_a_previous_save_restores_that_save() {
        let saved = crate::store::stringify(&mine());
        let started = start(&[("library.json.bak", &saved)]);
        assert_eq!(started.names(), "Mine");
        assert_eq!(
            started.store.notice().map(|notice| notice.key),
            Some("server.library.restoredMissing".to_string())
        );
        assert!(started.file.exists());
    }

    #[test]
    fn a_newer_file_is_never_replaced() {
        let newer =
            r#"{"version":2,"activeProfileId":"x","decks":[{"id":"x","stuff":"from the future"}]}"#;
        let started = start(&[("library.json", newer)]);
        // Explained, not called damaged.
        let notice = started.notice();
        assert!(
            notice.contains("newer version of Punchboard") && !notice.contains("damaged"),
            "{notice}"
        );
        assert!(notice.contains("(format 2)"), "{notice}");
        assert_eq!(*lock(&started.logs), vec![notice.clone()]);
        // Saving over it is refused.
        let refused = started.save(&mine()).expect_err("refused");
        assert_eq!(refused.status, 423);
        assert!(
            refused.message().contains("newer version"),
            "{}",
            refused.message()
        );
        // And it is left exactly as it was.
        assert_eq!(
            fs::read_to_string(&started.file).expect("library.json"),
            newer
        );
        assert_eq!(started.listing(), vec!["library.json"]);
        assert_eq!(started.names(), "My deck");
        // Still read-only, and still saying so.
        assert_eq!(started.notice(), notice);
    }

    #[test]
    fn a_first_start_gets_the_starter_decks() {
        let started = start(&[]);
        assert_eq!(started.names(), "Streaming,Music,Shortcuts,Trackpad");
        assert_eq!(started.store.notice(), None);
        // The revision starts from the clock, so it differs after a restart.
        assert_eq!(started.store.revision(), NOW);
        assert!(lock(&started.logs).is_empty());
        let stored: Value =
            serde_json::from_str(&fs::read_to_string(&started.file).expect("library.json"))
                .expect("JSON");
        assert_eq!(stored, json!(*started.store.get()));
        // A second start reads them back, and makes nothing new.
        let again = LibraryStore::open_with(
            &started.file,
            |_: &str| {},
            &Setup {
                t: &translator("en"),
                ids: &Ids::new(|| NOW + 5),
                mac: true,
                now: NOW + 5,
            },
        );
        assert_eq!(*again.get(), *started.store.get());
        assert_eq!(again.revision(), NOW + 5);
    }

    #[test]
    fn a_failed_write_changes_nothing() {
        let started = start(&[]);
        let before = started.store.get();
        let revision = started.store.revision();
        // A folder where library.json goes makes the write fail on every
        // system (Windows ignores a read-only folder).
        let keep = started.decks.join("library.json.keep");
        fs::rename(&started.file, &keep).expect("moved");
        fs::create_dir(&started.file).expect("a folder in its place");
        let failed = started.save(&mine()).expect_err("it cannot be written");
        fs::remove_dir(&started.file).expect("the folder gone");
        fs::rename(&keep, &started.file).expect("moved back");
        assert_eq!(failed.status, 500);
        assert!(
            failed.message().contains("could not be saved"),
            "{}",
            failed.message()
        );
        // It keeps the decks devices see, and the revision.
        assert_eq!(*started.store.get(), *before);
        assert_eq!(started.store.revision(), revision);
        assert!(
            !started.listing().iter().any(|name| name.contains("tmp")),
            "{:?}",
            started.listing()
        );
        // Once the folder is writable again, the same save goes through.
        assert_eq!(started.save(&mine()).expect("saved"), revision + 1);
        assert_eq!(started.names(), "Mine");
    }

    #[test]
    fn saves_keep_the_previous_file_and_a_daily_snapshot() {
        let started = start(&[]);
        let first = fs::read_to_string(&started.file).expect("library.json");
        started.save(&mine()).expect("saved");
        let second = fs::read_to_string(&started.file).expect("library.json");
        assert_eq!(
            fs::read_to_string(backup_of(&started.file)).expect("the backup"),
            first
        );
        let snapshots: Vec<PathBuf> = fs::read_dir(started.decks.join("backups"))
            .expect("backups")
            .map(|entry| entry.expect("an entry").path())
            .collect();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            fs::read_to_string(&snapshots[0]).expect("the snapshot"),
            first
        );
        // The same day: no second snapshot, and the backup moves on.
        let mut other = mine();
        other["profiles"][0]["name"] = json!("Other");
        started.save(&other).expect("saved");
        assert_eq!(
            fs::read_to_string(backup_of(&started.file)).expect("the backup"),
            second
        );
        assert_eq!(
            fs::read_dir(started.decks.join("backups"))
                .expect("backups")
                .count(),
            1
        );
        assert_eq!(
            fs::read_to_string(&snapshots[0]).expect("the snapshot"),
            first
        );
    }

    #[test]
    fn buttons_and_faders_are_found_by_id() {
        let started = start(&[]);
        let fader = json!({
            "id": "f", "slot": 1, "label": "Volume", "icon": "zap", "color": "accent", "control": "fader",
            "fader": { "target": "system" }, "steps": []
        });
        let raw = json!({
            "version": 1, "activeProfileId": "mine",
            "profiles": [deck("Mine", json!([press("a", 0), fader])), deck("Other", json!([press("b", 0)]))]
        });
        started.save(&raw).expect("saved");
        assert_eq!(
            started.store.find_button("mine", "a").map(|b| b.label),
            Some("a".to_string())
        );
        assert_eq!(
            started.store.find_button("other", "b").map(|b| b.id),
            Some("b".to_string())
        );
        assert!(started.store.find_button("mine", "b").is_none());
        assert!(started.store.find_button("nope", "a").is_none());
        let faders = started.store.faders("mine");
        assert_eq!(faders.len(), 1);
        assert_eq!(faders[0].id, "f");
        assert!(started.store.faders("other").is_empty());
        assert!(started.store.faders("nope").is_empty());
    }

    #[test]
    fn paths_are_shown_from_the_data_folder() {
        let file = Path::new("/home/someone/data/decks/library.json");
        let sep = std::path::MAIN_SEPARATOR;
        assert_eq!(shown(file), format!("decks{sep}library.json"));
        assert_eq!(shown(Path::new("library.json")), "library.json");
    }
}
