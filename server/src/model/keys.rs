//! Key combinations for the "Key combination" action, stored as one canonical
//! string: modifiers in a fixed order, then one key, joined by "+", e.g.
//! "ctrl+shift+k". Keys are named after the physical key (KeyboardEvent.code),
//! so a combination recorded on one keyboard layout fires the same key on
//! another, which is how OBS hotkeys behave too.
//! (src/shared/keys.ts)
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::translate::{Translate, Var};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Meta,
}

impl Modifier {
    pub fn as_str(self) -> &'static str {
        match self {
            Modifier::Ctrl => "ctrl",
            Modifier::Alt => "alt",
            Modifier::Shift => "shift",
            Modifier::Meta => "meta",
        }
    }

    fn named(name: &str) -> Option<Modifier> {
        MODIFIERS
            .iter()
            .copied()
            .find(|modifier| modifier.as_str() == name)
    }
}

/// The modifiers, in the order a combination lists them.
pub const MODIFIERS: [Modifier; 4] = [
    Modifier::Ctrl,
    Modifier::Alt,
    Modifier::Shift,
    Modifier::Meta,
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyCombo {
    pub modifiers: Vec<Modifier>,
    pub key: String,
}

/// Every key a combination can end in: letters, digits, F1 to F24, then the
/// named keys, in the TypeScript's order.
#[rustfmt::skip]
pub const KEY_NAMES: [&str; 85] = [
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
    "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
    "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
    "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24",
    "enter", "space", "tab", "escape", "backspace", "delete",
    "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
    "minus", "equal", "comma", "period", "slash", "backquote", "bracketleft", "bracketright", "backslash", "semicolon", "quote",
];

pub fn is_key_name(value: &str) -> bool {
    KEY_NAMES.contains(&value)
}

/// Reads a stored combination; None when it is malformed.
pub fn parse_combo(text: &str) -> Option<KeyCombo> {
    let lowered = text.to_lowercase();
    let parts: Vec<&str> = lowered
        .split('+')
        .map(super::js::trim)
        .filter(|part| !part.is_empty())
        .collect();
    let (key, before) = parts.split_last()?;
    if !is_key_name(key) {
        return None;
    }
    let mut modifiers: Vec<Modifier> = Vec::new();
    for part in before {
        let modifier = Modifier::named(part)?;
        if modifiers.contains(&modifier) {
            return None;
        }
        modifiers.push(modifier);
    }
    // The enum is declared in MODIFIERS' order.
    modifiers.sort();
    Some(KeyCombo {
        modifiers,
        key: key.to_string(),
    })
}

/// `parse_combo` on anything a deck file held: only a string can be one.
pub fn parse_combo_value(value: &Value) -> Option<KeyCombo> {
    parse_combo(value.as_str()?)
}

pub fn combo_to_string(combo: &KeyCombo) -> String {
    let mut parts: Vec<&str> = combo
        .modifiers
        .iter()
        .map(|modifier| modifier.as_str())
        .collect();
    parts.push(&combo.key);
    parts.join("+")
}

/// What the recorder needs from a keydown event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyEventLike {
    pub code: String,
    pub ctrl_key: bool,
    pub alt_key: bool,
    pub shift_key: bool,
    pub meta_key: bool,
}

const CODE_ALIASES: [(&str, &str); 26] = [
    ("Enter", "enter"),
    ("NumpadEnter", "enter"),
    ("Space", "space"),
    ("Tab", "tab"),
    ("Escape", "escape"),
    ("Backspace", "backspace"),
    ("Delete", "delete"),
    ("ArrowUp", "up"),
    ("ArrowDown", "down"),
    ("ArrowLeft", "left"),
    ("ArrowRight", "right"),
    ("Home", "home"),
    ("End", "end"),
    ("PageUp", "pageup"),
    ("PageDown", "pagedown"),
    ("Minus", "minus"),
    ("Equal", "equal"),
    ("Comma", "comma"),
    ("Period", "period"),
    ("Slash", "slash"),
    ("Backquote", "backquote"),
    ("BracketLeft", "bracketleft"),
    ("BracketRight", "bracketright"),
    ("Backslash", "backslash"),
    ("Semicolon", "semicolon"),
    ("Quote", "quote"),
];

fn key_from_code(code: &str) -> Option<String> {
    if let Some(letter) = code.strip_prefix("Key") {
        if letter.len() == 1 && letter.bytes().all(|b| b.is_ascii_uppercase()) {
            return Some(letter.to_ascii_lowercase());
        }
    }
    if let Some(digit) = code.strip_prefix("Digit") {
        if digit.len() == 1 && digit.bytes().all(|b| b.is_ascii_digit()) {
            return Some(digit.to_string());
        }
    }
    if let Some(number) = code.strip_prefix('F') {
        if (1..=2).contains(&number.len()) && number.bytes().all(|b| b.is_ascii_digit()) {
            let name = format!("f{number}");
            if is_key_name(&name) {
                return Some(name);
            }
        }
    }
    CODE_ALIASES
        .iter()
        .find(|alias| alias.0 == code)
        .map(|alias| alias.1.to_string())
}

/// The combination a keydown represents, or None for a modifier-only press
/// (Shift alone, for instance) or a key this action cannot send.
pub fn combo_from_event(event: &KeyEventLike) -> Option<String> {
    let key = key_from_code(&event.code)?;
    let mut modifiers = Vec::new();
    if event.ctrl_key {
        modifiers.push(Modifier::Ctrl);
    }
    if event.alt_key {
        modifiers.push(Modifier::Alt);
    }
    if event.shift_key {
        modifiers.push(Modifier::Shift);
    }
    if event.meta_key {
        modifiers.push(Modifier::Meta);
    }
    Some(combo_to_string(&KeyCombo { modifiers, key }))
}

fn mac_modifier_glyph(modifier: Modifier) -> &'static str {
    match modifier {
        Modifier::Ctrl => "⌃",
        Modifier::Alt => "⌥",
        Modifier::Shift => "⇧",
        Modifier::Meta => "⌘",
    }
}

fn other_modifier_name(modifier: Modifier) -> &'static str {
    match modifier {
        Modifier::Ctrl => "Ctrl",
        Modifier::Alt => "Alt",
        Modifier::Shift => "Shift",
        Modifier::Meta => "Win",
    }
}

// Symbols read the same everywhere; only the keys named with a word take
// their name from the locale file ("Space" is "Espacio" on Spanish keyboards).
const KEY_SYMBOLS: [(&str, &str); 17] = [
    ("backspace", "⌫"),
    ("delete", "⌦"),
    ("up", "↑"),
    ("down", "↓"),
    ("left", "←"),
    ("right", "→"),
    ("minus", "-"),
    ("equal", "="),
    ("comma", ","),
    ("period", "."),
    ("slash", "/"),
    ("backquote", "`"),
    ("bracketleft", "["),
    ("bracketright", "]"),
    ("backslash", "\\"),
    ("semicolon", ";"),
    ("quote", "'"),
];
const WORD_KEYS: [&str; 8] = [
    "enter", "space", "tab", "escape", "home", "end", "pageup", "pagedown",
];

/// How a key is printed on the keyboard: a symbol, its name, or its letter.
fn key_label(key: &str, t: &dyn Translate) -> String {
    if WORD_KEYS.contains(&key) {
        return t.t(&format!("shared.key.{key}"), &[]);
    }
    match KEY_SYMBOLS.iter().find(|symbol| symbol.0 == key) {
        Some(symbol) => symbol.1.to_string(),
        None => key.to_uppercase(),
    }
}

/// One modifier's label, for the builder's toggles.
pub fn modifier_label(modifier: Modifier, mac: bool) -> &'static str {
    if mac {
        mac_modifier_glyph(modifier)
    } else {
        other_modifier_name(modifier)
    }
}

/// Human form: "⌃⇧K" on a Mac, "Ctrl+Shift+K" elsewhere. Empty when `text`
/// is missing or not a combination.
pub fn format_combo(text: Option<&str>, mac: bool, t: &dyn Translate) -> String {
    let Some(combo) = text.and_then(parse_combo) else {
        return String::new();
    };
    let key = key_label(&combo.key, t);
    if mac {
        let glyphs: String = combo
            .modifiers
            .iter()
            .map(|modifier| mac_modifier_glyph(*modifier))
            .collect();
        return glyphs + &key;
    }
    let mut parts: Vec<&str> = combo
        .modifiers
        .iter()
        .map(|modifier| other_modifier_name(*modifier))
        .collect();
    parts.push(&key);
    parts.join("+")
}

/// The systems that send keys differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyPlatform {
    Mac,
    Windows,
    Linux,
    Other,
}

/// Which of them a platform name is: Node's ("darwin", "win32", "linux") or
/// the browser's navigator.platform ("MacIntel", "Win32", "Linux x86_64").
pub fn key_platform(name: &str) -> KeyPlatform {
    // The TypeScript's patterns ignore case, for ASCII letters only.
    let lowered = name.to_ascii_lowercase();
    if lowered == "darwin"
        || ["mac", "iphone", "ipad"]
            .iter()
            .any(|word| lowered.contains(word))
    {
        return KeyPlatform::Mac;
    }
    if lowered.starts_with("win") {
        return KeyPlatform::Windows;
    }
    if lowered.starts_with("linux") {
        return KeyPlatform::Linux;
    }
    KeyPlatform::Other
}

/// Why `key` cannot be pressed on `platform`, or None when it can. Said
/// when the key is recorded, so nobody finds out mid-stream. macOS has no
/// key codes for F21 to F24 (the server's MAC_CODES has none); Windows
/// sends every key here by its scan code, and Linux by the kernel's code
/// (LINUX_CODES has one for each, and the tests in `keys` say so).
pub fn unsendable_reason(key: &str, platform: KeyPlatform, t: &dyn Translate) -> Option<String> {
    if platform == KeyPlatform::Other {
        return Some(t.t("shared.keys.unsupportedPlatform", &[]));
    }
    if platform == KeyPlatform::Mac && matches!(key, "f21" | "f22" | "f23" | "f24") {
        return Some(t.t(
            "shared.keys.noMacKeyCode",
            &[("key", Var::from(key.to_uppercase()))],
        ));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::testing::{cases, same, EchoVars, Locale};
    use crate::translate::Keys;
    use serde_json::{json, Value};

    #[test]
    fn tables_match_the_typescript() {
        let all = cases("keys-tables.json");
        let tables = &all[0]["output"];
        same("MODIFIERS", &MODIFIERS, &tables["MODIFIERS"]);
        same("KEY_NAMES", &KEY_NAMES[..], &tables["KEY_NAMES"]);
    }

    #[test]
    fn parse_combo_matches_the_typescript() {
        let all = cases("keys-parseCombo.json");
        assert!(all.len() >= 300, "{} cases", all.len());
        for case in &all {
            let combo = parse_combo_value(&case["input"]);
            same(
                &format!("parseCombo({})", case["input"]),
                &combo,
                &case["output"]["combo"],
            );
            let text = combo.as_ref().map(combo_to_string);
            same(
                &format!("comboToString({})", case["input"]),
                &text,
                &case["output"]["text"],
            );
        }
    }

    #[test]
    fn format_combo_matches_the_typescript() {
        let english = Locale::load("en");
        let all = cases("keys-formatCombo.json");
        assert!(all.len() >= 300, "{} cases", all.len());
        for case in &all {
            let text = case["input"]["text"].as_str();
            let mac = case["input"]["mac"] == json!(true);
            same(
                &format!("formatCombo {}", case["input"]),
                &format_combo(text, mac, &EchoVars),
                &case["output"]["echo"],
            );
            same(
                &format!("formatCombo en {}", case["input"]),
                &format_combo(text, mac, &english),
                &case["output"]["en"],
            );
        }
    }

    #[test]
    fn combo_from_event_matches_the_typescript() {
        let all = cases("keys-comboFromEvent.json");
        assert!(all.len() >= 100, "{} cases", all.len());
        for case in &all {
            let event: KeyEventLike =
                serde_json::from_value(case["input"].clone()).expect("an event");
            same(
                &format!("comboFromEvent({})", case["input"]),
                &combo_from_event(&event),
                &case["output"],
            );
        }
    }

    #[test]
    fn modifier_labels_match_the_typescript() {
        for case in cases("keys-modifierLabel.json") {
            let modifier: Modifier =
                serde_json::from_value(case["input"]["modifier"].clone()).expect("a modifier");
            let mac = case["input"]["mac"] == json!(true);
            same(
                &format!("modifierLabel({})", case["input"]),
                &modifier_label(modifier, mac),
                &case["output"],
            );
        }
    }

    #[test]
    fn key_platform_matches_the_typescript() {
        let all = cases("keys-keyPlatform.json");
        assert!(all.len() >= 40, "{} cases", all.len());
        for case in &all {
            let name = case["input"].as_str().expect("a name");
            same(
                &format!("keyPlatform({name})"),
                &key_platform(name),
                &case["output"],
            );
        }
    }

    #[test]
    fn unsendable_reason_matches_the_typescript() {
        let english = Locale::load("en");
        let all = cases("keys-unsendableReason.json");
        assert!(all.len() >= 250, "{} cases", all.len());
        for case in &all {
            let key = case["input"]["key"].as_str().expect("a key");
            let platform: KeyPlatform =
                serde_json::from_value(case["input"]["platform"].clone()).expect("a platform");
            same(
                &format!("unsendableReason {}", case["input"]),
                &unsendable_reason(key, platform, &EchoVars),
                &case["output"]["echo"],
            );
            same(
                &format!("unsendableReason en {}", case["input"]),
                &unsendable_reason(key, platform, &english),
                &case["output"]["en"],
            );
        }
    }

    // ---- the assertions of tests/scripts.test.mjs that touch this file

    #[test]
    fn the_recorder_flags_exactly_f21_to_f24_on_macos() {
        let flagged: Vec<&str> = KEY_NAMES
            .iter()
            .copied()
            .filter(|name| unsendable_reason(name, KeyPlatform::Mac, &Keys).is_some())
            .collect();
        assert_eq!(flagged.join(" "), "f21 f22 f23 f24");
    }

    #[test]
    fn nothing_is_flagged_on_windows() {
        assert!(KEY_NAMES
            .iter()
            .all(|name| unsendable_reason(name, KeyPlatform::Windows, &Keys).is_none()));
    }

    #[test]
    fn nothing_is_flagged_on_linux() {
        assert!(KEY_NAMES
            .iter()
            .all(|name| unsendable_reason(name, KeyPlatform::Linux, &Keys).is_none()));
    }

    #[test]
    fn other_systems_are_told_key_combinations_do_not_work_there() {
        assert!(unsendable_reason("a", KeyPlatform::Other, &Keys)
            .is_some_and(|reason| !reason.is_empty()));
    }

    #[test]
    fn platform_names_are_read_from_node_and_from_the_browser() {
        assert_eq!(key_platform("darwin"), KeyPlatform::Mac);
        assert_eq!(key_platform("MacIntel"), KeyPlatform::Mac);
        assert_eq!(key_platform("iPad"), KeyPlatform::Mac);
        assert_eq!(key_platform("win32"), KeyPlatform::Windows);
        assert_eq!(key_platform("Win32"), KeyPlatform::Windows);
        assert_eq!(key_platform("Linux x86_64"), KeyPlatform::Linux);
        assert_eq!(key_platform("linux"), KeyPlatform::Linux);
        assert_eq!(key_platform("freebsd"), KeyPlatform::Other);
        assert_eq!(key_platform(""), KeyPlatform::Other);
    }

    #[test]
    fn modifiers_keep_their_fixed_order() {
        let names: Vec<&str> = MODIFIERS.iter().map(|modifier| modifier.as_str()).collect();
        assert_eq!(names.join(" "), "ctrl alt shift meta");
    }

    #[test]
    fn every_key_parses_with_every_modifier() {
        // tests/scripts.test.mjs and tests/windows.test.mjs build these.
        for name in KEY_NAMES {
            let combo = parse_combo(&format!("meta+shift+alt+ctrl+{name}")).expect("a combination");
            assert_eq!(combo.modifiers, MODIFIERS.to_vec());
            assert_eq!(combo.key, name);
            assert_eq!(
                parse_combo(&format!("shift+{name}")).map(|combo| combo.modifiers),
                Some(vec![Modifier::Shift])
            );
        }
        assert!(
            parse_combo("meta+shift+s").is_some()
                && parse_combo("ctrl+f24").is_some()
                && parse_combo("ctrl+a").is_some()
        );
        assert_eq!(parse_combo_value(&Value::Null), None);
    }
}
