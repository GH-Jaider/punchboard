//! Recorded traces: the frames a device saw and what the engine made of them,
//! as a JSON file the tests replay. The deck records them in its debug mode
//! (#trackpad-debug) and the companion writes them; a developer then edits
//! `expected` to say what should have happened.
//! (src/shared/touchpad/trace.ts, and what it needs of types.ts)
//!
//! Frames and events stay as the JSON the device sent: the validators accept
//! fields nobody asked for, and the trace is written with them still there.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::js;
use crate::model::TrackpadSettings;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TouchpadTrace {
    /// Always 1.
    pub version: u8,
    #[serde(rename = "recordedAt")]
    pub recorded_at: String,
    pub settings: TrackpadSettings,
    /// Each one passed [`is_touch_frame`].
    pub frames: Vec<Value>,
    /// What the device's engine emitted, kept for reference. Each one passed
    /// [`is_touchpad_event`].
    pub events: Vec<Value>,
    /// The summary the replay must produce; starts as the summary of `events`.
    pub expected: Vec<String>,
    /// The device's browser, since bounces and timing differ between them.
    /// Last, as the TypeScript adds it after the rest.
    #[serde(rename = "userAgent", default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
}

/// Trace frames are held to these, since a device sends them.
pub struct TraceLimits {
    pub frames: usize,
    pub contacts: usize,
    pub events: usize,
}

pub const TRACE_LIMITS: TraceLimits = TraceLimits {
    frames: 6000,
    contacts: 10,
    events: 20000,
};

/// A field as a template string prints it: `undefined` when it is not there.
fn printed(event: &Value, name: &str) -> String {
    match event.get(name) {
        Some(value) => js::to_string(value),
        None => "undefined".to_string(),
    }
}

/// `a === b` for two fields that may be missing: text, numbers, booleans and
/// null by their value; a list or an object only equals itself, which two
/// fields of two events never are.
fn strictly_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Number(_)), Some(Value::Number(_))) => {
            js::to_number(a.unwrap_or(&Value::Null)) == js::to_number(b.unwrap_or(&Value::Null))
        }
        (Some(Value::Array(_) | Value::Object(_)), _) => false,
        (Some(a), Some(b)) => a == b,
        _ => false,
    }
}

fn is_text(event: &Value, name: &str, text: &str) -> bool {
    event.get(name).and_then(Value::as_str) == Some(text)
}

/// One line per meaningful thing: runs of moves, scrolls and pinches fold
/// into one entry, and a button down followed at once by its up is a click.
///
/// The events are the ones a device sent, already checked with
/// [`is_touchpad_event`]; anything else is still summarized the way the
/// TypeScript would ("unknown …", "undefined" for a field that is missing).
pub fn summarize(events: &[Value]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    fn push(lines: &mut Vec<String>, line: String, foldable: bool) {
        if foldable && lines.last() == Some(&line) {
            return;
        }
        lines.push(line);
    }
    let mut i = 0;
    while i < events.len() {
        let event = &events[i];
        match event.get("type").and_then(Value::as_str) {
            Some("move") => push(&mut lines, "move".to_string(), true),
            Some("button") => {
                let click = is_text(event, "state", "down")
                    && events.get(i + 1).is_some_and(|next| {
                        js::truthy(next)
                            && is_text(next, "type", "button")
                            && strictly_equal(next.get("button"), event.get("button"))
                            && is_text(next, "state", "up")
                    });
                if click {
                    push(
                        &mut lines,
                        format!("click {}", printed(event, "button")),
                        false,
                    );
                    i += 1;
                } else {
                    let line = format!("{} {}", printed(event, "button"), printed(event, "state"));
                    push(&mut lines, line, false);
                }
            }
            Some("scroll") => {
                if is_text(event, "phase", "end") {
                    push(&mut lines, "scroll end".to_string(), false);
                } else if is_text(event, "phase", "momentum") {
                    push(&mut lines, "momentum".to_string(), true);
                } else {
                    push(&mut lines, "scroll".to_string(), true);
                }
            }
            Some("pinch") => {
                let end = is_text(event, "phase", "end");
                let line = if end { "pinch end" } else { "pinch" };
                push(&mut lines, line.to_string(), !end);
            }
            Some("swipe") => {
                let line = format!(
                    "swipe {} {}",
                    printed(event, "fingers"),
                    printed(event, "direction")
                );
                push(&mut lines, line, false);
            }
            Some("fingers") => {
                let line = format!(
                    "fingers {} {}",
                    printed(event, "fingers"),
                    printed(event, "gesture")
                );
                push(&mut lines, line, false);
            }
            Some("tap") => push(
                &mut lines,
                format!("tap {}", printed(event, "fingers")),
                false,
            ),
            _ => push(
                &mut lines,
                format!("unknown {}", printed(event, "type")),
                false,
            ),
        }
        i += 1;
    }
    lines
}

/// A number, as JSON holds one: never NaN or Infinity.
fn finite(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(_)))
}

pub fn is_touch_frame(value: &Value) -> bool {
    let Value::Object(frame) = value else {
        return false;
    };
    let Some(Value::Array(contacts)) = frame.get("contacts") else {
        return false;
    };
    if !finite(frame.get("time")) || contacts.len() > TRACE_LIMITS.contacts {
        return false;
    }
    if !matches!(frame.get("cancelled"), None | Some(Value::Bool(_))) {
        return false;
    }
    contacts.iter().all(|contact| {
        contact.is_object()
            && finite(contact.get("id"))
            && finite(contact.get("x"))
            && finite(contact.get("y"))
    })
}

const BUTTONS: [&str; 3] = ["left", "right", "middle"];
const DIRECTIONS: [&str; 4] = ["up", "down", "left", "right"];

/// `list.indexOf(String(value.name)) >= 0`: the field is read as text first,
/// so a list holding one name passes as that name.
fn named(event: &Value, name: &str, list: &[&str]) -> bool {
    list.contains(&printed(event, name).as_str())
}

/// `value.name === number`.
fn is_number(event: &Value, name: &str, number: f64) -> bool {
    matches!(event.get(name), Some(value @ Value::Number(_)) if js::to_number(value) == number)
}

pub fn is_touchpad_event(value: &Value) -> bool {
    if !value.is_object() {
        return false;
    }
    match value.get("type").and_then(Value::as_str) {
        Some("move") => finite(value.get("dx")) && finite(value.get("dy")),
        Some("button") => {
            named(value, "button", &BUTTONS)
                && (is_text(value, "state", "down") || is_text(value, "state", "up"))
        }
        Some("scroll") => {
            named(value, "phase", &["begin", "change", "end", "momentum"])
                && finite(value.get("dx"))
                && finite(value.get("dy"))
        }
        Some("pinch") => {
            named(value, "phase", &["begin", "change", "end"]) && finite(value.get("scale"))
        }
        Some("swipe") => {
            (is_number(value, "fingers", 3.0) || is_number(value, "fingers", 4.0))
                && named(value, "direction", &DIRECTIONS)
        }
        Some("fingers") => {
            is_number(value, "fingers", 4.0)
                && (is_text(value, "gesture", "spread") || is_text(value, "gesture", "pinch"))
        }
        Some("tap") => is_number(value, "fingers", 3.0),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    fn read(path: PathBuf) -> Value {
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    /// The cases written by tests/fixtures/make-input.ts.
    fn cases(file: &str) -> Vec<Value> {
        match read(repo().join("tests/fixtures/input").join(file)) {
            Value::Array(cases) => cases,
            _ => panic!("{file} is not a list"),
        }
    }

    fn brief(value: &Value) -> String {
        value.to_string().chars().take(300).collect()
    }

    #[test]
    fn the_limits_match_the_typescript() {
        let limits = &cases("trace-limits.json")[0]["output"];
        assert_eq!(limits["frames"], TRACE_LIMITS.frames);
        assert_eq!(limits["contacts"], TRACE_LIMITS.contacts);
        assert_eq!(limits["events"], TRACE_LIMITS.events);
    }

    #[test]
    fn frames_are_judged_as_the_typescript_judges_them() {
        let all = cases("trace-frames.json");
        assert!(all.len() > 200, "{} frames", all.len());
        for case in &all {
            let theirs = case["output"].as_bool().expect("true or false");
            assert_eq!(
                is_touch_frame(&case["input"]),
                theirs,
                "{}",
                brief(&case["input"])
            );
        }
    }

    #[test]
    fn events_are_judged_as_the_typescript_judges_them() {
        let all = cases("trace-events.json");
        assert!(all.len() > 400, "{} events", all.len());
        for case in &all {
            let theirs = case["output"].as_bool().expect("true or false");
            assert_eq!(
                is_touchpad_event(&case["input"]),
                theirs,
                "{}",
                brief(&case["input"])
            );
        }
    }

    #[test]
    fn summaries_match_the_typescript() {
        let all = cases("trace-summaries.json");
        assert!(all.len() > 2000, "{} summaries", all.len());
        for case in &all {
            let events = case["input"].as_array().expect("a list of events");
            let ours = Value::from(summarize(events));
            assert_eq!(ours, case["output"], "{}", brief(&case["input"]));
        }
    }

    // tests/touchpad.test.mjs, "traces": every recorded trace is well formed
    // and its events summarize to what the file expects. (Replaying the
    // frames through the engine stays in that test: the engine is the
    // deck's, in TypeScript.)
    #[test]
    fn the_recorded_traces_read_and_summarize_as_expected() {
        let dir = repo().join("tests/touchpad-traces");
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .expect("the recorded traces")
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.ends_with(".json"))
            .collect();
        names.sort();
        assert!(!names.is_empty(), "There are recorded traces to replay");
        for name in names {
            let trace = read(dir.join(&name));
            assert_eq!(trace["version"], 1, "{name}");
            let frames = trace["frames"].as_array().expect("frames");
            let events = trace["events"].as_array().expect("events");
            assert!(
                !frames.is_empty() && frames.len() <= TRACE_LIMITS.frames,
                "{name}"
            );
            assert!(events.len() <= TRACE_LIMITS.events, "{name}");
            assert!(frames.iter().all(is_touch_frame), "{name}: frames");
            assert!(events.iter().all(is_touchpad_event), "{name}: events");
            assert_eq!(Value::from(summarize(events)), trace["expected"], "{name}");
        }
    }

    // tests/trackpad.test.mjs: "The trace is written with its expected
    // summary filled in" and "A malformed trace is refused", as far as this
    // module decides them.
    #[test]
    fn a_saved_trace_gets_its_summary_and_a_malformed_one_is_refused() {
        let events = serde_json::json!([
            { "type": "button", "button": "left", "state": "down" },
            { "type": "button", "button": "left", "state": "up" }
        ]);
        let frames = serde_json::json!([
            { "time": 0, "contacts": [{ "id": 1, "x": 10, "y": 10 }] },
            { "time": 60, "contacts": [] }
        ]);
        let events = events.as_array().expect("a list");
        let frames = frames.as_array().expect("a list");
        assert!(frames.iter().all(is_touch_frame));
        assert!(events.iter().all(is_touchpad_event));
        assert_eq!(summarize(events), ["click left"]);
        assert!(!is_touch_frame(
            &serde_json::json!({ "time": "soon", "contacts": [] })
        ));
    }

    #[test]
    fn a_trace_is_written_in_the_order_the_typescript_writes_it() {
        let trace = TouchpadTrace {
            version: 1,
            recorded_at: "2026-09-30T12:00:00.000Z".to_string(),
            settings: serde_json::from_value(serde_json::json!({
                "speed": 1.5, "naturalScroll": true, "pinchZoom": "gesture"
            }))
            .expect("settings"),
            frames: vec![serde_json::json!({ "time": 0, "contacts": [], "extra": "kept" })],
            events: Vec::new(),
            expected: Vec::new(),
            user_agent: Some("test".to_string()),
        };
        let text =
            crate::store::stringify(&serde_json::to_value(&trace).expect("a trace is plain JSON"));
        assert_eq!(
            text,
            r#"{"version":1,"recordedAt":"2026-09-30T12:00:00.000Z","settings":{"speed":1.5,"naturalScroll":true,"pinchZoom":"gesture"},"frames":[{"time":0,"contacts":[],"extra":"kept"}],"events":[],"expected":[],"userAgent":"test"}"#
        );
    }
}
