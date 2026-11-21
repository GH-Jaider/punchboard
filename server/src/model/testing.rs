//! What the tests of this module share: the fixtures written by
//! tests/fixtures/make-model.ts, and translators that word things the way
//! that generator's did.
use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

use super::ids::Ids;
use super::js;
use crate::translate::{Translate, Var};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn read_json(path: PathBuf) -> Value {
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The cases of one fixture file: `{ input, output }` each.
pub fn cases(file: &str) -> Vec<Value> {
    match read_json(repo().join("tests/fixtures/model").join(file)) {
        Value::Array(cases) => cases,
        other => panic!("{file} is not a list: {}", brief(&other)),
    }
}

/// The start of a value, to name a case in a failure.
pub fn brief(value: &Value) -> String {
    value.to_string().chars().take(300).collect()
}

/// The ids the TypeScript gave out during a case: the same clock and counter.
pub fn ids_of(case: &Value) -> Ids {
    let now = case["ids"]["now"].as_u64().expect("the case's clock");
    let made = case["ids"]["counter"].as_u64().expect("the case's counter");
    Ids::starting_after(made, move || now)
}

/// Whether two JSON values are the same, key order aside.
///
/// A number may differ in its last digit: serde_json, as this crate builds
/// it (without `float_roundtrip`), reads a long decimal such as
/// 122.33333333333333 one step off, so what it read from the fixture is not
/// always the number Node wrote there.
fn alike(ours: &Value, theirs: &Value) -> bool {
    match (ours, theirs) {
        (Value::Number(a), Value::Number(b)) => {
            a == b || matches!((a.as_f64(), b.as_f64()), (Some(a), Some(b)) if close(a, b))
        }
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| alike(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| alike(a, b)))
        }
        _ => ours == theirs,
    }
}

/// Equal, or a float (not a whole number) within two steps of the other.
fn close(a: f64, b: f64) -> bool {
    a == b || (a.fract() != 0.0 && (a - b).abs() <= 2.0 * f64::EPSILON * a.abs().max(b.abs()))
}

/// Whether every object lists its keys in the same order in both values.
fn same_order(ours: &Value, theirs: &Value) -> bool {
    match (ours, theirs) {
        (Value::Array(a), Value::Array(b)) => a.iter().zip(b).all(|(a, b)| same_order(a, b)),
        (Value::Object(a), Value::Object(b)) => {
            a.keys().eq(b.keys()) && a.values().zip(b.values()).all(|(a, b)| same_order(a, b))
        }
        _ => true,
    }
}

/// Asserts that `ours`, as JSON, is the value the TypeScript produced.
pub fn same(what: &str, ours: &(impl Serialize + ?Sized), theirs: &Value) {
    let ours = serde_json::to_value(ours).unwrap_or_else(|error| panic!("{what}: {error}"));
    assert!(
        alike(&ours, theirs),
        "{what}\n   rust: {}\n   node: {}",
        brief(&ours),
        brief(theirs)
    );
}

/// As `same`, and written the same way too: every key in the same place,
/// since this is text that goes to disk.
pub fn same_text(what: &str, ours: &(impl Serialize + ?Sized), theirs: &Value) {
    same(what, ours, theirs);
    let ours = serde_json::to_value(ours).unwrap_or_else(|error| panic!("{what}: {error}"));
    assert!(
        same_order(&ours, theirs),
        "{what}: the order differs\n   rust: {}\n   node: {}",
        brief(&ours),
        brief(theirs)
    );
}

fn shown(var: &Var) -> String {
    match var {
        Var::Text(text) => text.clone(),
        Var::Number(number) => js::number_to_string(*number),
    }
}

/// The generator's first translator: the key, then `|name=value` for each value.
pub struct EchoVars;

impl Translate for EchoVars {
    fn t(&self, key: &str, vars: &[(&str, Var)]) -> String {
        let mut text = key.to_string();
        for (name, value) in vars {
            text.push_str(&format!("|{name}={}", shown(value)));
        }
        text
    }
}

/// A real locale file from public/locales with English behind it, read as
/// the TypeScript translator reads it. Enough for the messages this module
/// asks for: none of them is a plural.
pub struct Locale {
    messages: HashMap<String, String>,
}

impl Locale {
    pub fn load(code: &str) -> Locale {
        let mut messages = HashMap::new();
        // English first, so the language's own messages replace it key by key.
        for file in ["en", code] {
            let locale = read_json(repo().join("public/locales").join(format!("{file}.json")));
            for (key, message) in locale["messages"].as_object().expect("messages") {
                if let Some(text) = message.as_str() {
                    messages.insert(key.clone(), text.to_string());
                }
            }
        }
        Locale { messages }
    }
}

impl Translate for Locale {
    fn t(&self, key: &str, vars: &[(&str, Var)]) -> String {
        let Some(message) = self.messages.get(key) else {
            return key.to_string();
        };
        let mut text = message.clone();
        for (name, value) in vars {
            text = text.replace(&format!("{{{name}}}"), &shown(value));
        }
        text
    }
}
