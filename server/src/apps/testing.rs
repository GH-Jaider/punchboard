//! What the tests of this module share: the fixtures written by
//! tests/fixtures/make-apps.ts and the folders they describe.
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};

use super::list::AppEntry;

/// The cases of one fixture file: `{ input, output }` each.
pub fn cases(file: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/apps")
        .join(file);
    let text =
        fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    match serde_json::from_str(&text) {
        Ok(Value::Array(cases)) => cases,
        other => panic!("{file} is not a list: {other:?}"),
    }
}

/// The folders and files of a case (`folders`, and `files` with their
/// content as base64), in a new folder.
pub fn make_tree(input: &Value) -> tempfile::TempDir {
    let base = tempfile::tempdir().expect("a temporary folder");
    for folder in input["folders"].as_array().into_iter().flatten() {
        fs::create_dir_all(base.path().join(folder.as_str().expect("a folder")))
            .expect("the folder is made");
    }
    for file in input["files"].as_array().into_iter().flatten() {
        let full = base.path().join(file["path"].as_str().expect("a path"));
        let content = base64::engine::general_purpose::STANDARD
            .decode(file["base64"].as_str().expect("base64"))
            .expect("base64");
        fs::create_dir_all(full.parent().expect("a parent")).expect("the folder is made");
        fs::write(full, content).expect("the file is written");
    }
    base
}

/// Entries as the fixtures write them: paths relative to `base`, with "/".
pub fn relative(apps: &[AppEntry], base: &Path) -> Vec<Value> {
    apps.iter()
        .map(|app| {
            let inside = Path::new(&app.path)
                .strip_prefix(base)
                .unwrap_or_else(|_| panic!("{} is outside {}", app.path, base.display()));
            let parts: Vec<_> = inside
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect();
            json!({ "name": app.name, "path": parts.join("/") })
        })
        .collect()
}
