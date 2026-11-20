//! Sends a key combination to whatever is focused on this computer, the way a
//! hardware deck's hotkey button does.
//!
//! Two halves. Deciding is shared and pure: from a combination, the exact
//! list of key events for one system ([`combo_events`], [`media_events`]),
//! with the tables the TypeScript had. Doing is a [`KeySink`]: one per
//! system, a [`Recorder`] for tests, and a [`LogSink`] that writes the events
//! to a file instead of pressing anything.
//!
//! macOS: Quartz keyboard events with the physical keys' virtual key codes
//! (the TypeScript asked System Events for the same codes through osascript).
//! macOS asks once whether the app running Punchboard may control the
//! computer; that is approved under Accessibility.
//! Windows: SendInput with keyboard scan codes, no permission needed. Scan
//! codes name the physical key, like the stored combination does, so Ctrl+=
//! stays the key right of 0 on a Spanish or French keyboard; typing
//! characters instead would make it Ctrl+Shift+0 there. Like any program, it
//! cannot reach apps running as administrator.
//! Linux: XTest on an X11 session, a virtual keyboard through /dev/uinput on
//! Wayland, both with the kernel's own codes for the physical keys.
use std::io::Write;
use std::path::PathBuf;

use crate::i18n::{say, UserError};
use crate::model::keys::{parse_combo, unsendable_reason, KeyCombo, KeyPlatform, Modifier};
use crate::model::keys::{KEY_NAMES, MODIFIERS};
use crate::model::MediaKey;
use crate::translate::Keys;

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod mac;
#[cfg(windows)]
pub(crate) mod windows;

// ------------------------------------------------------------------ systems

/// The systems keys and the pointer are sent on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
}

impl Platform {
    /// The one this companion was built for; None on a system it cannot
    /// send keys on.
    pub const fn current() -> Option<Platform> {
        if cfg!(target_os = "macos") {
            Some(Platform::Mac)
        } else if cfg!(windows) {
            Some(Platform::Windows)
        } else if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else {
            None
        }
    }
}

// ------------------------------------------------------------------- tables

/// Virtual key codes for the physical keys, as macOS numbers them. F21 to F24
/// have none: macOS cannot send them (model::keys says so when one is
/// recorded).
#[rustfmt::skip]
pub const MAC_CODES: [(&str, u16); 81] = [
    ("a", 0), ("s", 1), ("d", 2), ("f", 3), ("h", 4), ("g", 5), ("z", 6), ("x", 7), ("c", 8), ("v", 9), ("b", 11), ("q", 12), ("w", 13), ("e", 14), ("r", 15), ("y", 16), ("t", 17),
    ("1", 18), ("2", 19), ("3", 20), ("4", 21), ("6", 22), ("5", 23), ("equal", 24), ("9", 25), ("7", 26), ("minus", 27), ("8", 28), ("0", 29),
    ("bracketright", 30), ("o", 31), ("u", 32), ("bracketleft", 33), ("i", 34), ("p", 35), ("enter", 36), ("l", 37), ("j", 38), ("quote", 39), ("k", 40),
    ("semicolon", 41), ("backslash", 42), ("comma", 43), ("slash", 44), ("n", 45), ("m", 46), ("period", 47), ("tab", 48), ("space", 49), ("backquote", 50),
    ("backspace", 51), ("escape", 53), ("f17", 64), ("f18", 79), ("f19", 80), ("f20", 90), ("f5", 96), ("f6", 97), ("f7", 98), ("f3", 99), ("f8", 100), ("f9", 101),
    ("f11", 103), ("f13", 105), ("f16", 106), ("f14", 107), ("f10", 109), ("f12", 111), ("f15", 113), ("home", 115), ("pageup", 116), ("delete", 117),
    ("f4", 118), ("end", 119), ("f2", 120), ("pagedown", 121), ("f1", 122), ("left", 123), ("right", 124), ("down", 125), ("up", 126),
];

/// The modifier keys' own key codes and the flag each one sets while held:
/// left Control, Option, Shift and Command.
pub const MAC_MODIFIER_KEYS: [(Modifier, u16, u64); 4] = [
    (Modifier::Ctrl, 59, MAC_FLAG_CTRL),
    (Modifier::Alt, 58, MAC_FLAG_ALT),
    (Modifier::Shift, 56, MAC_FLAG_SHIFT),
    (Modifier::Meta, 55, MAC_FLAG_CMD),
];
pub const MAC_FLAG_CMD: u64 = 0x100000;
pub const MAC_FLAG_CTRL: u64 = 0x40000;
pub const MAC_FLAG_SHIFT: u64 = 0x20000;
pub const MAC_FLAG_ALT: u64 = 0x80000;
/// Only ever a flag, on the arrow keys, as a real keyboard sends them.
pub const MAC_FLAG_FN: u64 = 0x800000;

// Scan codes (set 1, what Windows calls a scan code) of the physical keys on
// a US keyboard, which is where KeyboardEvent.code takes its names from.
// EXTENDED marks the keys that arrive with an E0 prefix: without the extended
// flag, the arrows, Home, End, Page Up/Down and Delete would be read as the
// number pad's keys (8, 2, 4, 6... with Num Lock on).
const EXTENDED: u16 = 0xe000;
#[rustfmt::skip]
pub const WIN_SCAN_CODES: [(&str, u16); 85] = [
    ("escape", 0x01), ("1", 0x02), ("2", 0x03), ("3", 0x04), ("4", 0x05), ("5", 0x06), ("6", 0x07), ("7", 0x08), ("8", 0x09), ("9", 0x0a), ("0", 0x0b),
    ("minus", 0x0c), ("equal", 0x0d), ("backspace", 0x0e), ("tab", 0x0f),
    ("q", 0x10), ("w", 0x11), ("e", 0x12), ("r", 0x13), ("t", 0x14), ("y", 0x15), ("u", 0x16), ("i", 0x17), ("o", 0x18), ("p", 0x19), ("bracketleft", 0x1a), ("bracketright", 0x1b), ("enter", 0x1c),
    ("a", 0x1e), ("s", 0x1f), ("d", 0x20), ("f", 0x21), ("g", 0x22), ("h", 0x23), ("j", 0x24), ("k", 0x25), ("l", 0x26), ("semicolon", 0x27), ("quote", 0x28), ("backquote", 0x29),
    ("backslash", 0x2b), ("z", 0x2c), ("x", 0x2d), ("c", 0x2e), ("v", 0x2f), ("b", 0x30), ("n", 0x31), ("m", 0x32), ("comma", 0x33), ("period", 0x34), ("slash", 0x35),
    ("space", 0x39),
    ("f1", 0x3b), ("f2", 0x3c), ("f3", 0x3d), ("f4", 0x3e), ("f5", 0x3f), ("f6", 0x40), ("f7", 0x41), ("f8", 0x42), ("f9", 0x43), ("f10", 0x44), ("f11", 0x57), ("f12", 0x58),
    // F13 to F24 as Windows' own keyboard layouts map them (kbd.h: T64 to T6E, then T76).
    ("f13", 0x64), ("f14", 0x65), ("f15", 0x66), ("f16", 0x67), ("f17", 0x68), ("f18", 0x69), ("f19", 0x6a), ("f20", 0x6b), ("f21", 0x6c), ("f22", 0x6d), ("f23", 0x6e), ("f24", 0x76),
    ("home", EXTENDED | 0x47), ("up", EXTENDED | 0x48), ("pageup", EXTENDED | 0x49), ("left", EXTENDED | 0x4b), ("right", EXTENDED | 0x4d),
    ("end", EXTENDED | 0x4f), ("down", EXTENDED | 0x50), ("pagedown", EXTENDED | 0x51), ("delete", EXTENDED | 0x53),
];
/// The left-hand modifier keys, which is what a person pressing them uses.
pub const WIN_MODIFIER_SCAN_CODES: [(Modifier, u16); 4] = [
    (Modifier::Ctrl, 0x1d),
    (Modifier::Alt, 0x38),
    (Modifier::Shift, 0x2a),
    (Modifier::Meta, EXTENDED | 0x5b),
];

// KEYBDINPUT.dwFlags.
pub const KEYEVENTF_EXTENDEDKEY: u32 = 0x1;
pub const KEYEVENTF_KEYUP: u32 = 0x2;
pub const KEYEVENTF_SCANCODE: u32 = 0x8;

/// The kernel's codes for the physical keys (linux/input-event-codes.h,
/// KEY_*), which is what a virtual keyboard on /dev/uinput sends. An X11
/// server numbers the same keys 8 higher. New here: the Node companion never
/// sent keys on Linux.
#[rustfmt::skip]
pub const LINUX_CODES: [(&str, u16); 85] = [
    ("escape", 1), ("1", 2), ("2", 3), ("3", 4), ("4", 5), ("5", 6), ("6", 7), ("7", 8), ("8", 9), ("9", 10), ("0", 11),
    ("minus", 12), ("equal", 13), ("backspace", 14), ("tab", 15),
    ("q", 16), ("w", 17), ("e", 18), ("r", 19), ("t", 20), ("y", 21), ("u", 22), ("i", 23), ("o", 24), ("p", 25), ("bracketleft", 26), ("bracketright", 27), ("enter", 28),
    ("a", 30), ("s", 31), ("d", 32), ("f", 33), ("g", 34), ("h", 35), ("j", 36), ("k", 37), ("l", 38), ("semicolon", 39), ("quote", 40), ("backquote", 41),
    ("backslash", 43), ("z", 44), ("x", 45), ("c", 46), ("v", 47), ("b", 48), ("n", 49), ("m", 50), ("comma", 51), ("period", 52), ("slash", 53),
    ("space", 57),
    ("f1", 59), ("f2", 60), ("f3", 61), ("f4", 62), ("f5", 63), ("f6", 64), ("f7", 65), ("f8", 66), ("f9", 67), ("f10", 68), ("f11", 87), ("f12", 88),
    ("f13", 183), ("f14", 184), ("f15", 185), ("f16", 186), ("f17", 187), ("f18", 188), ("f19", 189), ("f20", 190), ("f21", 191), ("f22", 192), ("f23", 193), ("f24", 194),
    ("home", 102), ("up", 103), ("pageup", 104), ("left", 105), ("right", 106),
    ("end", 107), ("down", 108), ("pagedown", 109), ("delete", 111),
];
/// KEY_LEFTCTRL, KEY_LEFTALT, KEY_LEFTSHIFT and KEY_LEFTMETA.
pub const LINUX_MODIFIER_CODES: [(Modifier, u16); 4] = [
    (Modifier::Ctrl, 29),
    (Modifier::Alt, 56),
    (Modifier::Shift, 42),
    (Modifier::Meta, 125),
];
/// What an X11 server adds to the kernel's code for the same key.
pub const X11_KEYCODE_OFFSET: u16 = 8;

// The keyboard's music keys are not ordinary keys: macOS sends them as
// "system defined" events (NX_KEYTYPE_*), Windows as VK_MEDIA_* virtual keys,
// Linux as its own key codes (KEY_PLAYPAUSE, KEY_NEXTSONG, KEY_PREVIOUSSONG).
// They mean the same on every layout, so virtual keys are right for them.
pub const MAC_MEDIA: [(MediaKey, u32); 3] = [
    (MediaKey::PlayPause, 16),
    (MediaKey::Next, 17),
    (MediaKey::Previous, 18),
];
pub const WIN_MEDIA: [(MediaKey, u8); 3] = [
    (MediaKey::PlayPause, 0xb3),
    (MediaKey::Next, 0xb0),
    (MediaKey::Previous, 0xb1),
];
pub const LINUX_MEDIA: [(MediaKey, u16); 3] = [
    (MediaKey::PlayPause, 164),
    (MediaKey::Next, 163),
    (MediaKey::Previous, 165),
];

/// How long the keys of a combination stay down on Windows and Linux before
/// they are released: some programs (games among them) look at which keys
/// are down rather than at the events, and miss a key that is down and up in
/// the same instant.
pub const HOLD_MS: u64 = 30;

fn named<T: Copy>(table: &[(&str, T)], key: &str) -> Option<T> {
    table
        .iter()
        .find(|entry| entry.0 == key)
        .map(|entry| entry.1)
}

fn keyed<K: PartialEq + Copy, T: Copy>(table: &[(K, T)], key: K) -> Option<T> {
    table
        .iter()
        .find(|entry| entry.0 == key)
        .map(|entry| entry.1)
}

pub fn mac_code(key: &str) -> Option<u16> {
    named(&MAC_CODES, key)
}

pub fn win_scan_code(key: &str) -> Option<u16> {
    named(&WIN_SCAN_CODES, key)
}

pub fn linux_code(key: &str) -> Option<u16> {
    named(&LINUX_CODES, key)
}

/// The modifiers of a combination in their fixed order, whatever order it
/// lists them in.
fn modifiers_of(combo: &KeyCombo) -> impl Iterator<Item = Modifier> + '_ {
    MODIFIERS
        .into_iter()
        .filter(|modifier| combo.modifiers.contains(modifier))
}

// ----------------------------------------------------------------- deciding

/// One thing a [`KeySink`] is asked to do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyEvent {
    /// macOS: a keyboard event for a virtual key code, with the modifier
    /// flags it carries.
    Mac { code: u16, down: bool, flags: u64 },
    /// macOS: a music key (NX_KEYTYPE_*), as a "system defined" event. See
    /// [`MacMediaEvent`] for its fields.
    MacMedia { key: u32, down: bool },
    /// Windows: a scan code with its KEYBDINPUT flags.
    Scan { scan: u16, flags: u32 },
    /// Windows: a virtual key with its KEYBDINPUT flags (music keys).
    Virtual { vk: u8, flags: u32 },
    /// Linux: a kernel key code.
    Evdev { code: u16, down: bool },
    /// Nothing for this long, with the keys before it still down.
    Wait { ms: u64 },
}

/// One keyboard event SendInput is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanInput {
    pub scan: u16,
    pub flags: u32,
}

/// The key presses for one combination, in order: the modifiers down in
/// their fixed order, the key down and up, the modifiers up in reverse.
pub fn windows_inputs(combo: &KeyCombo) -> Result<Vec<ScanInput>, UserError> {
    let key = win_scan_code(&combo.key).ok_or_else(|| {
        UserError::new(say("server.keys.cannotSendWindows").with("key", combo.key.to_uppercase()))
    })?;
    let modifiers: Vec<u16> = modifiers_of(combo)
        .filter_map(|modifier| keyed(&WIN_MODIFIER_SCAN_CODES, modifier))
        .collect();
    let event = |code: u16, up: bool| ScanInput {
        scan: code & 0xff,
        flags: KEYEVENTF_SCANCODE
            | if code & EXTENDED != 0 {
                KEYEVENTF_EXTENDEDKEY
            } else {
                0
            }
            | if up { KEYEVENTF_KEYUP } else { 0 },
    };
    let down = modifiers
        .iter()
        .chain([&key])
        .map(|code| event(*code, false));
    let up = [&key]
        .into_iter()
        .chain(modifiers.iter().rev())
        .map(|code| event(*code, true));
    Ok(down.chain(up).collect())
}

/// What macOS is asked to press for one combination: the key's code and the
/// modifiers held with it. (What the TypeScript put in its AppleScript.)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MacKey {
    pub code: u16,
    pub modifiers: Vec<Modifier>,
}

pub fn mac_key(combo: &KeyCombo) -> Result<MacKey, UserError> {
    let Some(code) = mac_code(&combo.key) else {
        // F21 to F24 get the same explanation the Control Center gives when one is recorded.
        let known = unsendable_reason(&combo.key, KeyPlatform::Mac, &Keys).is_some();
        let message = if known {
            "server.keys.noMacKeyCode"
        } else {
            "server.keys.cannotSendMac"
        };
        return Err(UserError::new(
            say(message).with("key", combo.key.to_uppercase()),
        ));
    };
    Ok(MacKey {
        code,
        modifiers: combo.modifiers.clone(),
    })
}

/// A shortcut such as Ctrl+Up (Mission Control), typed the way a keyboard
/// does: modifiers down, the key, then the modifiers up again in reverse.
///
/// Modifier keys are pressed as keys rather than only named in a flag: macOS
/// tracks their state for the hardware's event source, and a modifier that
/// is never released stays down for every click after it. fn is only a flag
/// on arrow keys, never pressed. (`key` in helpers/mac-pointer.js, which the
/// pointer's gestures use too.)
pub fn mac_shortcut(code: u16, flags: u64) -> Vec<KeyEvent> {
    let mut events = Vec::new();
    let mut held = 0;
    let mut pressed = Vec::new();
    for (_, modifier_code, flag) in MAC_MODIFIER_KEYS {
        if flags & flag == 0 {
            continue;
        }
        held |= flag;
        events.push(KeyEvent::Mac {
            code: modifier_code,
            down: true,
            flags: held,
        });
        pressed.push((modifier_code, flag));
    }
    let with_fn = held | (flags & MAC_FLAG_FN);
    for down in [true, false] {
        events.push(KeyEvent::Mac {
            code,
            down,
            flags: with_fn,
        });
    }
    for (modifier_code, flag) in pressed.into_iter().rev() {
        held &= !flag;
        events.push(KeyEvent::Mac {
            code: modifier_code,
            down: false,
            flags: held,
        });
    }
    events
}

/// The arrow keys: a real keyboard sends them with the fn flag, and the
/// system's own shortcuts (Ctrl+Up for Mission Control) only answer to that.
const MAC_ARROWS: [u16; 4] = [123, 124, 125, 126];

fn mac_events(combo: &KeyCombo) -> Result<Vec<KeyEvent>, UserError> {
    let key = mac_key(combo)?;
    let mut flags = 0;
    for modifier in &key.modifiers {
        if let Some((_, _, flag)) = MAC_MODIFIER_KEYS.iter().find(|entry| entry.0 == *modifier) {
            flags |= flag;
        }
    }
    if MAC_ARROWS.contains(&key.code) {
        flags |= MAC_FLAG_FN;
    }
    Ok(mac_shortcut(key.code, flags))
}

/// The presses go in one call and the releases in another a moment later
/// (see [`HOLD_MS`]).
fn windows_events(combo: &KeyCombo) -> Result<Vec<KeyEvent>, UserError> {
    let inputs = windows_inputs(combo)?;
    let downs = inputs.len() / 2;
    let mut events = Vec::with_capacity(inputs.len() + 1);
    for (index, input) in inputs.into_iter().enumerate() {
        if index == downs {
            events.push(KeyEvent::Wait { ms: HOLD_MS });
        }
        events.push(KeyEvent::Scan {
            scan: input.scan,
            flags: input.flags,
        });
    }
    Ok(events)
}

/// The same order as on Windows: modifiers down, the key, a moment, the key
/// up, the modifiers up in reverse.
fn linux_events(combo: &KeyCombo) -> Result<Vec<KeyEvent>, UserError> {
    let key = linux_code(&combo.key).ok_or_else(|| {
        UserError::new(say("server.keys.sendFailed").with("reason", combo.key.to_uppercase()))
    })?;
    let modifiers: Vec<u16> = modifiers_of(combo)
        .filter_map(|modifier| keyed(&LINUX_MODIFIER_CODES, modifier))
        .collect();
    let mut events = Vec::with_capacity(modifiers.len() * 2 + 3);
    for code in modifiers.iter().chain([&key]) {
        events.push(KeyEvent::Evdev {
            code: *code,
            down: true,
        });
    }
    events.push(KeyEvent::Wait { ms: HOLD_MS });
    for code in [&key].into_iter().chain(modifiers.iter().rev()) {
        events.push(KeyEvent::Evdev {
            code: *code,
            down: false,
        });
    }
    Ok(events)
}

/// Every event that sends one combination on one system, in order.
pub fn combo_events(combo: &KeyCombo, platform: Platform) -> Result<Vec<KeyEvent>, UserError> {
    match platform {
        Platform::Mac => mac_events(combo),
        Platform::Windows => windows_events(combo),
        Platform::Linux => linux_events(combo),
    }
}

/// Every event that taps one music key on one system: down, then up.
pub fn media_events(key: MediaKey, platform: Platform) -> Vec<KeyEvent> {
    match platform {
        Platform::Mac => {
            let key = keyed(&MAC_MEDIA, key).unwrap_or(16);
            vec![
                KeyEvent::MacMedia { key, down: true },
                KeyEvent::MacMedia { key, down: false },
            ]
        }
        // The music keys mean the same on every layout: virtual keys, extended.
        Platform::Windows => {
            let vk = keyed(&WIN_MEDIA, key).unwrap_or(0xb3);
            vec![
                KeyEvent::Virtual {
                    vk,
                    flags: KEYEVENTF_EXTENDEDKEY,
                },
                KeyEvent::Virtual {
                    vk,
                    flags: KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP,
                },
            ]
        }
        Platform::Linux => {
            let code = keyed(&LINUX_MEDIA, key).unwrap_or(164);
            vec![
                KeyEvent::Evdev { code, down: true },
                KeyEvent::Evdev { code, down: false },
            ]
        }
    }
}

/// The "system defined" event macOS reads as a music key: what
/// `NSEvent otherEventWithType:location:modifierFlags:timestamp:windowNumber:
/// context:subtype:data1:data2:` is given (the location is 0,0; timestamp,
/// window number and context are 0 and nil).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MacMediaEvent {
    /// NSEventTypeSystemDefined.
    pub event_type: u64,
    pub modifier_flags: u64,
    /// NX_SUBTYPE_AUX_CONTROL_BUTTONS.
    pub subtype: i16,
    pub data1: i64,
    pub data2: i64,
}

pub fn mac_media_event(key: u32, down: bool) -> MacMediaEvent {
    MacMediaEvent {
        event_type: 14,
        modifier_flags: if down { 0xa00 } else { 0xb00 },
        subtype: 8,
        data1: (i64::from(key) << 16) | (if down { 0xa } else { 0xb } << 8),
        data2: -1,
    }
}

// -------------------------------------------------------------------- doing

/// Why a system did not take the keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyFailure {
    /// macOS: the app running Punchboard is not allowed under Accessibility.
    MacPermission,
    /// Linux: this account may not use /dev/uinput.
    LinuxPermission,
    /// Windows took fewer key events than it was handed. It does not say
    /// why, so the person is told the usual reasons, in their language.
    WindowsRefused { taken: u32, wanted: u32 },
    /// Anything else, in the system's own words.
    Other(String),
}

/// What Windows taking only some of the events means to a person.
fn windows_refused(taken: u32, wanted: u32) -> crate::i18n::Text {
    say("server.keys.windowsRefused")
        .with("taken", f64::from(taken))
        .with("wanted", f64::from(wanted))
}

/// Where key events go: the system, a file, or a list in a test.
pub trait KeySink {
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure>;
}

/// Keeps what it was sent, for tests.
#[derive(Debug, Default)]
pub struct Recorder {
    pub events: Vec<KeyEvent>,
    /// What every `send` answers from now on, to try a failure.
    pub failure: Option<KeyFailure>,
}

impl KeySink for Recorder {
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure> {
        self.events.extend_from_slice(events);
        match &self.failure {
            Some(failure) => Err(failure.clone()),
            None => Ok(()),
        }
    }
}

/// One event as a line of the key log (see [`LogSink`]).
pub fn log_line(event: &KeyEvent) -> String {
    let way = |down: bool| if down { "down" } else { "up" };
    match *event {
        KeyEvent::Mac { code, down, flags } => format!("mac {} {code} {flags}", way(down)),
        KeyEvent::MacMedia { key, down } => format!("media {} {key}", way(down)),
        KeyEvent::Scan { scan, flags } => format!("scan {scan} {flags}"),
        KeyEvent::Virtual { vk, flags } => format!("vk {vk} {flags}"),
        KeyEvent::Evdev { code, down } => format!("evdev {} {code}", way(down)),
        KeyEvent::Wait { ms } => format!("wait {ms}"),
    }
}

/// Tests set PUNCHBOARD_KEYS_LOG to a file: every key event is appended
/// there as one line and no key is pressed, the way PUNCHBOARD_POINTER_LOG
/// keeps the mouse still. The lines, with every number in decimal:
///
/// ```text
/// mac down|up CODE FLAGS    macOS key code, with the modifier flags it carries
/// media down|up KEY         macOS music key (NX_KEYTYPE_*: 16 play, 17 next, 18 previous)
/// scan SCAN FLAGS           Windows scan code and KEYBDINPUT flags (8 scan code, +1 extended, +2 key up)
/// vk VK FLAGS               Windows virtual key and KEYBDINPUT flags (music keys)
/// evdev down|up CODE        Linux key code (KEY_*)
/// wait MS                   the pause between presses and releases
/// ```
pub struct LogSink {
    pub file: PathBuf,
}

impl KeySink for LogSink {
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure> {
        let text: String = events.iter().map(|event| log_line(event) + "\n").collect();
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .map_err(|error| KeyFailure::Other(error.to_string()))
    }
}

/// The file key events go to instead of the keyboard, when a test asked.
fn test_log() -> Option<PathBuf> {
    std::env::var_os("PUNCHBOARD_KEYS_LOG")
        .filter(|file| !file.is_empty())
        .map(PathBuf::from)
}

/// Sends through this system's own sink, or to the key log.
fn deliver(events: &[KeyEvent]) -> Result<(), KeyFailure> {
    if let Some(file) = test_log() {
        return LogSink { file }.send(events);
    }
    #[cfg(target_os = "macos")]
    return mac::Sink.send(events);
    #[cfg(windows)]
    return windows::Sink.send(events);
    #[cfg(target_os = "linux")]
    return linux::send(events);
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = events;
        Err(KeyFailure::Other(String::new()))
    }
}

// -------------------------------------------------------------- entry points

/// A combination through a given sink, as on a given system: the whole path
/// but the system call. [`send_keys`] is this with the real ones.
pub fn send_keys_with(
    text: Option<&str>,
    platform: Platform,
    sink: &mut dyn KeySink,
) -> Result<(), UserError> {
    let combo = text
        .and_then(parse_combo)
        .ok_or_else(|| UserError::new(say("server.keys.noCombo")))?;
    let events = combo_events(&combo, platform)?;
    sink.send(&events).map_err(|failure| match failure {
        KeyFailure::MacPermission => UserError::new(say("server.keys.macPermissionTerminal")),
        KeyFailure::LinuxPermission => UserError::new(say("server.keys.linuxPermission")),
        KeyFailure::WindowsRefused { taken, wanted } => UserError::new(
            say("server.keys.sendFailed").with("reason", windows_refused(taken, wanted)),
        ),
        KeyFailure::Other(reason) => {
            UserError::new(say("server.keys.sendFailed").with("reason", reason))
        }
    })
}

/// A music key through a given sink, as on a given system.
pub fn send_media_key_with(
    key: MediaKey,
    platform: Platform,
    sink: &mut dyn KeySink,
) -> Result<(), UserError> {
    sink.send(&media_events(key, platform))
        .map_err(|failure| match failure {
            KeyFailure::MacPermission => UserError::new(say("server.keys.macPermission")),
            KeyFailure::LinuxPermission => UserError::new(say("server.keys.linuxPermission")),
            KeyFailure::WindowsRefused { taken, wanted } => UserError::new(
                say("server.keys.mediaFailed").with("reason", windows_refused(taken, wanted)),
            ),
            KeyFailure::Other(reason) => {
                UserError::new(say("server.keys.mediaFailed").with("reason", reason))
            }
        })
}

/// What `deliver` is, as a sink.
struct System;

impl KeySink for System {
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure> {
        deliver(events)
    }
}

/// Presses the combination stored as `text` ("ctrl+shift+k") on this
/// computer. It holds the keys for a moment, so it takes a few hundredths of
/// a second: call it off the async threads (`spawn_blocking`).
pub fn send_keys(text: Option<&str>) -> Result<(), UserError> {
    let Some(platform) = Platform::current() else {
        // The combination is still checked first, as the TypeScript does.
        text.and_then(parse_combo)
            .ok_or_else(|| UserError::new(say("server.keys.noCombo")))?;
        return Err(UserError::new(say("server.keys.unsupported")));
    };
    send_keys_with(text, platform, &mut System)
}

/// Taps one of the keyboard's music keys on this computer.
pub fn send_media_key(key: MediaKey) -> Result<(), UserError> {
    let Some(platform) = Platform::current() else {
        return Err(UserError::new(say("server.keys.mediaUnsupported")));
    };
    send_media_key_with(key, platform, &mut System)
}

/// Lets go of whatever sending keys keeps open (the virtual keyboard or the
/// X connection on Linux; nothing elsewhere), for shutdown.
pub fn stop_keys() {
    #[cfg(target_os = "linux")]
    linux::stop();
}

/// Every key name has a code on Windows and Linux, and on macOS all but
/// F21 to F24. Checked by the tests; here so the tables cannot drift apart
/// without the build noticing their sizes.
const _: () = assert!(WIN_SCAN_CODES.len() == KEY_NAMES.len());
const _: () = assert!(LINUX_CODES.len() == KEY_NAMES.len());
const _: () = assert!(MAC_CODES.len() == KEY_NAMES.len() - 4);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::TextVar;
    use crate::model::keys::combo_to_string;
    use serde_json::Value;
    use std::collections::HashSet;
    use std::path::PathBuf;

    /// The cases written by tests/fixtures/make-input.ts.
    fn cases(file: &str) -> Vec<Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/input")
            .join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        match serde_json::from_str(&text) {
            Ok(Value::Array(cases)) => cases,
            other => panic!("{file} is not a list: {other:?}"),
        }
    }

    fn combo(text: &str) -> KeyCombo {
        parse_combo(text).unwrap_or_else(|| panic!("{text} is not a combination"))
    }

    fn bare(key: &str) -> KeyCombo {
        KeyCombo {
            modifiers: Vec::new(),
            key: key.to_string(),
        }
    }

    fn modifier(name: &str) -> Modifier {
        MODIFIERS
            .into_iter()
            .find(|modifier| modifier.as_str() == name)
            .unwrap_or_else(|| panic!("{name} is not a modifier"))
    }

    /// An error as the fixture writes one: its key and its values.
    fn error_json(error: &UserError) -> Value {
        let mut vars = serde_json::Map::new();
        for (name, value) in &error.text.vars {
            let value = match value {
                TextVar::Str(text) => Value::from(text.clone()),
                TextVar::Num(number) => Value::from(*number),
                TextVar::Text(text) => Value::from(text.key.clone()),
            };
            vars.insert(name.clone(), value);
        }
        serde_json::json!({ "key": error.text.key, "vars": vars })
    }

    // ------------------------------------------------------- the fixtures

    #[test]
    fn the_tables_match_the_typescript() {
        let tables = &cases("keys-tables.json")[0]["output"];
        let table = |name: &str| tables[name].as_object().expect("a table").clone();
        let same = |name: &str, ours: Vec<(String, u64)>| {
            let theirs = table(name);
            assert_eq!(ours.len(), theirs.len(), "{name}");
            for (key, code) in ours {
                assert_eq!(theirs.get(&key), Some(&Value::from(code)), "{name}.{key}");
            }
        };
        let names = |list: &[(&str, u16)]| -> Vec<(String, u64)> {
            list.iter()
                .map(|(key, code)| (key.to_string(), u64::from(*code)))
                .collect()
        };
        same("MAC_CODES", names(&MAC_CODES));
        same("WIN_SCAN_CODES", names(&WIN_SCAN_CODES));
        same(
            "WIN_MODIFIER_SCAN_CODES",
            WIN_MODIFIER_SCAN_CODES
                .iter()
                .map(|(modifier, code)| (modifier.as_str().to_string(), u64::from(*code)))
                .collect(),
        );
        same(
            "MAC_MEDIA",
            MAC_MEDIA
                .iter()
                .map(|(key, code)| (key.as_str().to_string(), u64::from(*code)))
                .collect(),
        );
        same(
            "WIN_MEDIA",
            WIN_MEDIA
                .iter()
                .map(|(key, code)| (key.as_str().to_string(), u64::from(*code)))
                .collect(),
        );
        assert_eq!(Value::from(KEY_NAMES.to_vec()), tables["KEY_NAMES"]);
    }

    #[test]
    fn windows_inputs_match_the_typescript_for_every_key_and_modifier_set() {
        let all = cases("keys-windows.json");
        assert_eq!(all.len(), KEY_NAMES.len() * 16);
        for case in &all {
            let text = case["input"].as_str().expect("a combination");
            let combo = combo(text);
            let theirs = case["output"]["inputs"].as_array().expect("inputs");
            let ours = windows_inputs(&combo).expect(text);
            let ours_json: Vec<Value> = ours
                .iter()
                .map(|input| serde_json::json!({ "scan": input.scan, "flags": input.flags }))
                .collect();
            assert_eq!(&ours_json, theirs, "{text}");

            // The planned events are those inputs, the presses and the
            // releases apart: what the key helper's "keys DOWNS SCANS FLAGS"
            // carried and SCAN_KEYS_TYPE sent in two calls.
            let planned = combo_events(&combo, Platform::Windows).expect(text);
            let downs = combo.modifiers.len() + 1;
            let mut wanted: Vec<KeyEvent> = ours
                .iter()
                .map(|input| KeyEvent::Scan {
                    scan: input.scan,
                    flags: input.flags,
                })
                .collect();
            wanted.insert(downs, KeyEvent::Wait { ms: 30 });
            assert_eq!(planned, wanted, "{text}");
        }
    }

    #[test]
    fn mac_keys_match_the_typescript_for_every_key_and_modifier_set() {
        let all = cases("keys-mac.json");
        assert_eq!(all.len(), KEY_NAMES.len() * 16);
        for case in &all {
            let text = case["input"].as_str().expect("a combination");
            let combo = combo(text);
            let theirs = &case["output"];
            match mac_key(&combo) {
                Err(error) => {
                    assert_eq!(error_json(&error), theirs["error"], "{text}");
                    assert!(combo_events(&combo, Platform::Mac).is_err(), "{text}");
                }
                Ok(key) => {
                    assert_eq!(Value::from(key.code), theirs["code"], "{text}");
                    let names: Vec<&str> = key.modifiers.iter().map(|m| m.as_str()).collect();
                    assert_eq!(Value::from(names), theirs["modifiers"], "{text}");

                    // The planned events press exactly that: each modifier
                    // down in order, the key down and up carrying all of
                    // them, each modifier up in reverse.
                    let events = combo_events(&combo, Platform::Mac).expect(text);
                    let held: Vec<(u16, u64)> = key
                        .modifiers
                        .iter()
                        .map(|modifier| {
                            let entry = MAC_MODIFIER_KEYS
                                .iter()
                                .find(|entry| entry.0 == *modifier)
                                .expect("a modifier key");
                            (entry.1, entry.2)
                        })
                        .collect();
                    let all_flags = held.iter().fold(0, |flags, entry| flags | entry.1);
                    let arrow = if (123..=126).contains(&key.code) {
                        MAC_FLAG_FN
                    } else {
                        0
                    };
                    let mut wanted = Vec::new();
                    let mut flags = 0;
                    for (code, flag) in &held {
                        flags |= flag;
                        wanted.push(KeyEvent::Mac {
                            code: *code,
                            down: true,
                            flags,
                        });
                    }
                    for down in [true, false] {
                        wanted.push(KeyEvent::Mac {
                            code: key.code,
                            down,
                            flags: all_flags | arrow,
                        });
                    }
                    for (code, flag) in held.iter().rev() {
                        flags &= !flag;
                        wanted.push(KeyEvent::Mac {
                            code: *code,
                            down: false,
                            flags,
                        });
                    }
                    assert_eq!(events, wanted, "{text}");
                }
            }
        }
    }

    // ------------------------------------- tests/scripts.test.mjs, Windows keys

    #[test]
    fn every_key_name_has_a_windows_scan_code_and_no_other_name_has_one() {
        let missing: Vec<&str> = KEY_NAMES
            .into_iter()
            .filter(|name| win_scan_code(name).is_none())
            .collect();
        assert!(missing.is_empty(), "{missing:?}");
        let unknown: Vec<&str> = WIN_SCAN_CODES
            .iter()
            .map(|entry| entry.0)
            .filter(|name| !KEY_NAMES.contains(name))
            .collect();
        assert!(unknown.is_empty(), "{unknown:?}");
    }

    #[test]
    fn no_two_keys_share_a_scan_code() {
        let codes: Vec<u16> = WIN_SCAN_CODES
            .iter()
            .map(|entry| entry.1)
            .chain(WIN_MODIFIER_SCAN_CODES.iter().map(|entry| entry.1))
            .collect();
        let distinct: HashSet<u16> = codes.iter().copied().collect();
        assert_eq!(distinct.len(), codes.len());
    }

    /// The layout of set 1 is regular enough to check by rows.
    fn run(names: &[&str], first: u16) -> bool {
        names
            .iter()
            .enumerate()
            .all(|(i, name)| win_scan_code(name) == Some(first + i as u16))
    }

    #[test]
    fn the_scan_codes_follow_the_keyboard_rows() {
        assert!(
            run(
                &["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "minus", "equal"],
                0x02
            ),
            "Digit row: 1 to 0, then - and = are 0x02 to 0x0D"
        );
        assert!(
            run(
                &[
                    "q",
                    "w",
                    "e",
                    "r",
                    "t",
                    "y",
                    "u",
                    "i",
                    "o",
                    "p",
                    "bracketleft",
                    "bracketright"
                ],
                0x10
            ),
            "Top letter row: Q to ] are 0x10 to 0x1B"
        );
        assert!(
            run(
                &[
                    "a",
                    "s",
                    "d",
                    "f",
                    "g",
                    "h",
                    "j",
                    "k",
                    "l",
                    "semicolon",
                    "quote",
                    "backquote"
                ],
                0x1e
            ),
            "Home row: A to ` are 0x1E to 0x29"
        );
        assert!(
            run(
                &[
                    "backslash",
                    "z",
                    "x",
                    "c",
                    "v",
                    "b",
                    "n",
                    "m",
                    "comma",
                    "period",
                    "slash"
                ],
                0x2b
            ),
            "Bottom row: \\ then Z to / are 0x2B to 0x35"
        );
        assert!(
            run(
                &["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"],
                0x3b
            ) && win_scan_code("f11") == Some(0x57)
                && win_scan_code("f12") == Some(0x58),
            "F1 to F10 are 0x3B to 0x44, F11 and F12 0x57 and 0x58"
        );
        assert!(
            run(
                &["f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23"],
                0x64
            ) && win_scan_code("f24") == Some(0x76),
            "F13 to F23 are 0x64 to 0x6E and F24 is 0x76"
        );
    }

    #[test]
    fn exactly_the_arrows_and_the_navigation_block_are_extended_keys() {
        let mut extended: Vec<&str> = KEY_NAMES
            .into_iter()
            .filter(|name| win_scan_code(name).is_some_and(|code| code & 0xe000 != 0))
            .collect();
        extended.sort();
        assert_eq!(
            extended.join(" "),
            "delete down end home left pagedown pageup right up"
        );
    }

    #[test]
    fn the_modifiers_are_the_left_hand_ctrl_alt_shift_and_win() {
        assert_eq!(
            WIN_MODIFIER_SCAN_CODES,
            [
                (Modifier::Ctrl, 0x1d),
                (Modifier::Alt, 0x38),
                (Modifier::Shift, 0x2a),
                (Modifier::Meta, 0xe05b)
            ]
        );
    }

    #[test]
    fn every_key_bare_and_with_every_modifier_is_pressed_in_order_and_released_in_reverse() {
        const SCANCODE: u32 = 8;
        const KEYUP: u32 = 2;
        const EXTENDEDKEY: u32 = 1;
        for name in KEY_NAMES {
            let scan = win_scan_code(name).expect(name);
            let ext = if scan & 0xe000 != 0 { EXTENDEDKEY } else { 0 };
            let alone = windows_inputs(&bare(name)).expect(name);
            let want = [
                ScanInput {
                    scan: scan & 0xff,
                    flags: SCANCODE | ext,
                },
                ScanInput {
                    scan: scan & 0xff,
                    flags: SCANCODE | ext | KEYUP,
                },
            ];
            assert_eq!(alone, want, "{name}");
            let all = windows_inputs(&combo(&format!("meta+shift+alt+ctrl+{name}"))).expect(name);
            let order: Vec<String> = all
                .iter()
                .map(|input| {
                    format!(
                        "{:x}{}{}",
                        input.scan,
                        if input.flags & KEYUP != 0 { "^" } else { "v" },
                        if input.flags & EXTENDEDKEY != 0 {
                            "e"
                        } else {
                            ""
                        }
                    )
                })
                .collect();
            let k = format!("{:x}", scan & 0xff);
            let e = if ext != 0 { "e" } else { "" };
            let want_order = format!("1dv 38v 2av 5bve {k}v{e} {k}^{e} 5b^e 2a^ 38^ 1d^");
            assert_eq!(order.join(" "), want_order, "{name}");
            assert!(
                all.iter().all(|input| input.flags & SCANCODE != 0),
                "{name}"
            );
        }
    }

    // Replaces "The helper command for every key carries its scan codes as
    // plain integers, presses before releases" (the text of the key helper's
    // command line): the planned events carry the same scan codes and flags,
    // every press before the pause and every release after it.
    #[test]
    fn the_planned_events_for_every_key_are_its_inputs_presses_before_releases() {
        for name in KEY_NAMES {
            for combo in [
                bare(name),
                combo(&format!("ctrl+alt+shift+meta+{name}")),
                combo(&format!("shift+{name}")),
            ] {
                let inputs = windows_inputs(&combo).expect(name);
                let events = combo_events(&combo, Platform::Windows).expect(name);
                let downs = combo.modifiers.len() + 1;
                assert_eq!(events.len(), inputs.len() + 1, "{name}");
                assert_eq!(events[downs], KeyEvent::Wait { ms: HOLD_MS }, "{name}");
                let scans: Vec<KeyEvent> = events
                    .iter()
                    .copied()
                    .filter(|event| !matches!(event, KeyEvent::Wait { .. }))
                    .collect();
                for (index, (event, input)) in scans.iter().zip(&inputs).enumerate() {
                    assert_eq!(
                        *event,
                        KeyEvent::Scan {
                            scan: input.scan,
                            flags: input.flags
                        },
                        "{name}"
                    );
                    let up = input.flags & KEYEVENTF_KEYUP != 0;
                    assert_eq!(up, index >= downs, "{name}: presses, then releases");
                }
            }
        }
    }

    #[test]
    fn win_and_f17_to_f24_are_not_refused_on_windows() {
        assert!(combo_events(&combo("meta+shift+s"), Platform::Windows).is_ok());
        assert!(combo_events(&combo("ctrl+f24"), Platform::Windows).is_ok());
    }

    // Replaces "Music keys stay virtual keys" (the key helper's "media VK"
    // line) and the C#'s Media(): keybd_event(vk, 0, 1) then (vk, 0, 3).
    #[test]
    fn music_keys_stay_virtual_keys_on_windows() {
        let tap = |vk: u8| {
            vec![
                KeyEvent::Virtual { vk, flags: 1 },
                KeyEvent::Virtual { vk, flags: 3 },
            ]
        };
        assert_eq!(
            media_events(MediaKey::PlayPause, Platform::Windows),
            tap(179)
        );
        assert_eq!(media_events(MediaKey::Next, Platform::Windows), tap(176));
        assert_eq!(
            media_events(MediaKey::Previous, Platform::Windows),
            tap(177)
        );
    }

    // --------------------------------------- tests/scripts.test.mjs, macOS keys

    #[test]
    fn the_recorder_flags_exactly_the_keys_macos_has_no_code_for() {
        let unsendable: Vec<&str> = KEY_NAMES
            .into_iter()
            .filter(|name| unsendable_reason(name, KeyPlatform::Mac, &Keys).is_some())
            .collect();
        let missing: Vec<&str> = KEY_NAMES
            .into_iter()
            .filter(|name| mac_code(name).is_none())
            .collect();
        assert_eq!(unsendable, missing);
        assert_eq!(missing.join(" "), "f21 f22 f23 f24");
    }

    #[test]
    fn nothing_is_flagged_on_windows_and_other_systems_are_told() {
        assert!(KEY_NAMES.into_iter().all(|name| unsendable_reason(
            name,
            KeyPlatform::Windows,
            &Keys
        )
        .is_none()));
        assert!(unsendable_reason("a", KeyPlatform::Other, &Keys).is_some());
    }

    #[test]
    fn macos_says_the_same_thing_at_press_time() {
        let english = crate::i18n::translator("en");
        for name in KEY_NAMES {
            let combo = KeyCombo {
                modifiers: vec![Modifier::Meta],
                key: name.to_string(),
            };
            let reason = unsendable_reason(name, KeyPlatform::Mac, &english);
            match combo_events(&combo, Platform::Mac) {
                Ok(_) => assert_eq!(reason, None, "{name}"),
                Err(error) => assert_eq!(Some(error.message().to_string()), reason, "{name}"),
            }
        }
    }

    #[test]
    fn modifiers_keep_their_fixed_order() {
        let names: Vec<&str> = MODIFIERS.iter().map(|modifier| modifier.as_str()).collect();
        assert_eq!(names.join(" "), "ctrl alt shift meta");
    }

    // ------------------------------------------------------------- Linux

    #[test]
    fn every_key_name_has_a_linux_code_and_no_two_share_one() {
        let missing: Vec<&str> = KEY_NAMES
            .into_iter()
            .filter(|name| linux_code(name).is_none())
            .collect();
        assert!(missing.is_empty(), "{missing:?}");
        let codes: Vec<u16> = LINUX_CODES
            .iter()
            .map(|entry| entry.1)
            .chain(LINUX_MODIFIER_CODES.iter().map(|entry| entry.1))
            .chain(LINUX_MEDIA.iter().map(|entry| entry.1))
            .collect();
        let distinct: HashSet<u16> = codes.iter().copied().collect();
        assert_eq!(distinct.len(), codes.len());
        // An X11 keycode is one byte.
        assert!(codes.iter().all(|code| code + X11_KEYCODE_OFFSET <= 255));
    }

    // The kernel took its numbers from the same keyboard: up to F12, a key
    // that is not extended has its set 1 scan code as its Linux code. A slip
    // in either table shows here.
    #[test]
    fn linux_codes_agree_with_the_scan_codes_where_the_kernel_kept_them() {
        for (name, scan) in WIN_SCAN_CODES {
            if scan & EXTENDED == 0 && scan <= 0x58 {
                assert_eq!(linux_code(name), Some(scan), "{name}");
            }
        }
        for (modifier, scan) in WIN_MODIFIER_SCAN_CODES {
            if scan & EXTENDED == 0 {
                assert_eq!(keyed(&LINUX_MODIFIER_CODES, modifier), Some(scan));
            }
        }
        // linux/input-event-codes.h, for the rest.
        let named = [
            ("f13", 183),
            ("f24", 194),
            ("home", 102),
            ("up", 103),
            ("pageup", 104),
            ("left", 105),
            ("right", 106),
            ("end", 107),
            ("down", 108),
            ("pagedown", 109),
            ("delete", 111),
        ];
        for (name, code) in named {
            assert_eq!(linux_code(name), Some(code), "{name}");
        }
        assert_eq!(keyed(&LINUX_MODIFIER_CODES, Modifier::Meta), Some(125));
    }

    // ------------------------------------------- the whole path, recorded

    fn recorded(text: &str, platform: Platform) -> Vec<KeyEvent> {
        let mut sink = Recorder::default();
        send_keys_with(Some(text), platform, &mut sink).expect(text);
        sink.events
    }

    #[test]
    fn ctrl_shift_a_on_each_system() {
        let mac = |code, down, flags| KeyEvent::Mac { code, down, flags };
        assert_eq!(
            recorded("ctrl+shift+a", Platform::Mac),
            [
                mac(59, true, 0x40000),
                mac(56, true, 0x60000),
                mac(0, true, 0x60000),
                mac(0, false, 0x60000),
                mac(56, false, 0x40000),
                mac(59, false, 0),
            ]
        );
        let scan = |scan, flags| KeyEvent::Scan { scan, flags };
        assert_eq!(
            recorded("ctrl+shift+a", Platform::Windows),
            [
                scan(0x1d, 8),
                scan(0x2a, 8),
                scan(0x1e, 8),
                KeyEvent::Wait { ms: 30 },
                scan(0x1e, 10),
                scan(0x2a, 10),
                scan(0x1d, 10),
            ]
        );
        let key = |code, down| KeyEvent::Evdev { code, down };
        assert_eq!(
            recorded("ctrl+shift+a", Platform::Linux),
            [
                key(29, true),
                key(42, true),
                key(30, true),
                KeyEvent::Wait { ms: 30 },
                key(30, false),
                key(42, false),
                key(29, false),
            ]
        );
    }

    #[test]
    fn a_combination_is_read_however_it_was_typed() {
        // parse_combo puts the modifiers in their fixed order.
        assert_eq!(
            recorded(" Shift + CTRL+a ", Platform::Windows),
            recorded("ctrl+shift+a", Platform::Windows)
        );
        assert_eq!(
            recorded("meta+alt+f4", Platform::Linux),
            recorded("alt+meta+f4", Platform::Linux)
        );
    }

    #[test]
    fn a_bare_key_and_the_keys_with_an_e0_prefix() {
        assert_eq!(
            recorded("f5", Platform::Mac),
            [
                KeyEvent::Mac {
                    code: 96,
                    down: true,
                    flags: 0
                },
                KeyEvent::Mac {
                    code: 96,
                    down: false,
                    flags: 0
                }
            ]
        );
        // The Windows key and Delete are extended keys.
        let scan = |scan, flags| KeyEvent::Scan { scan, flags };
        assert_eq!(
            recorded("meta+delete", Platform::Windows),
            [
                scan(0x5b, 9),
                scan(0x53, 9),
                KeyEvent::Wait { ms: 30 },
                scan(0x53, 11),
                scan(0x5b, 11),
            ]
        );
        // An arrow carries the fn flag on a Mac, as a keyboard sends it.
        assert_eq!(
            recorded("ctrl+up", Platform::Mac),
            [
                KeyEvent::Mac {
                    code: 59,
                    down: true,
                    flags: 0x40000
                },
                KeyEvent::Mac {
                    code: 126,
                    down: true,
                    flags: 0x840000
                },
                KeyEvent::Mac {
                    code: 126,
                    down: false,
                    flags: 0x840000
                },
                KeyEvent::Mac {
                    code: 59,
                    down: false,
                    flags: 0
                },
            ]
        );
    }

    #[test]
    fn nothing_is_sent_without_a_combination_or_for_a_key_the_system_lacks() {
        for text in [
            None,
            Some(""),
            Some("ctrl+"),
            Some("ctrl+nope"),
            Some("ctrl+ctrl+a"),
        ] {
            let mut sink = Recorder::default();
            let error = send_keys_with(text, Platform::Windows, &mut sink).expect_err("refused");
            assert_eq!(error.text.key, "server.keys.noCombo", "{text:?}");
            assert!(sink.events.is_empty());
        }
        let mut sink = Recorder::default();
        let error =
            send_keys_with(Some("ctrl+f21"), Platform::Mac, &mut sink).expect_err("no key code");
        assert_eq!(error.text.key, "server.keys.noMacKeyCode");
        assert_eq!(
            error.text.vars,
            [("key".to_string(), TextVar::Str("F21".to_string()))]
        );
        assert!(sink.events.is_empty());
        assert!(!recorded("ctrl+f21", Platform::Windows).is_empty());
        assert!(!recorded("ctrl+f21", Platform::Linux).is_empty());
    }

    #[test]
    fn a_refusal_becomes_the_message_the_typescript_gave() {
        let fail = |failure: KeyFailure, platform: Platform| {
            let mut sink = Recorder {
                failure: Some(failure),
                ..Recorder::default()
            };
            send_keys_with(Some("ctrl+k"), platform, &mut sink).expect_err("refused")
        };
        let error = fail(KeyFailure::MacPermission, Platform::Mac);
        assert_eq!(error.text.key, "server.keys.macPermissionTerminal");
        assert!(error.message().contains("Accessibility"), "{error}");
        let error = fail(KeyFailure::LinuxPermission, Platform::Linux);
        assert_eq!(error.text.key, "server.keys.linuxPermission");
        assert!(error.message().contains("/dev/uinput"), "{error}");
        let error = fail(
            KeyFailure::Other("Windows took 0 of 4 key events".to_string()),
            Platform::Windows,
        );
        assert_eq!(error.text.key, "server.keys.sendFailed");
        assert_eq!(
            error.message(),
            "Could not send the keys. (Windows took 0 of 4 key events)"
        );
        // What Windows itself does not explain is explained in the person's language.
        let error = fail(
            KeyFailure::WindowsRefused {
                taken: 2,
                wanted: 4,
            },
            Platform::Windows,
        );
        assert_eq!(error.text.key, "server.keys.sendFailed");
        assert_eq!(
            error.message(),
            "Could not send the keys. (Windows took 2 of 4 key events: is the screen locked, or an app running as administrator in front?)"
        );
        assert_eq!(
            crate::i18n::render(&error.text.clone().into(), "es"),
            "No se pudieron enviar las teclas. (Windows aceptó 2 de 4 eventos de teclado: ¿está bloqueada la pantalla, o hay delante una app abierta como administrador?)"
        );

        let media = |failure: KeyFailure| {
            let mut sink = Recorder {
                failure: Some(failure),
                ..Recorder::default()
            };
            send_media_key_with(MediaKey::Next, Platform::Mac, &mut sink).expect_err("refused")
        };
        assert_eq!(
            media(KeyFailure::MacPermission).text.key,
            "server.keys.macPermission"
        );
        assert_eq!(
            media(KeyFailure::Other("no".to_string())).message(),
            "Could not send the music key. (no)"
        );
    }

    // Replaces the checks on the text of macMediaScript (tests/windows.test.mjs
    // ran it dry on a Mac): the same event fields, as data.
    #[test]
    fn music_keys_on_a_mac_are_system_defined_events() {
        let mut sink = Recorder::default();
        send_media_key_with(MediaKey::PlayPause, Platform::Mac, &mut sink).expect("recorded");
        assert_eq!(
            sink.events,
            [
                KeyEvent::MacMedia {
                    key: 16,
                    down: true
                },
                KeyEvent::MacMedia {
                    key: 16,
                    down: false
                }
            ]
        );
        assert_eq!(
            mac_media_event(17, true),
            MacMediaEvent {
                event_type: 14,
                modifier_flags: 0xa00,
                subtype: 8,
                data1: (17 << 16) | (0xa << 8),
                data2: -1
            }
        );
        assert_eq!(
            mac_media_event(18, false),
            MacMediaEvent {
                event_type: 14,
                modifier_flags: 0xb00,
                subtype: 8,
                data1: (18 << 16) | (0xb << 8),
                data2: -1
            }
        );
    }

    #[test]
    fn music_keys_on_linux_are_the_kernels_own() {
        let mut sink = Recorder::default();
        send_media_key_with(MediaKey::Previous, Platform::Linux, &mut sink).expect("recorded");
        assert_eq!(
            sink.events,
            [
                KeyEvent::Evdev {
                    code: 165,
                    down: true
                },
                KeyEvent::Evdev {
                    code: 165,
                    down: false
                }
            ]
        );
    }

    #[test]
    fn the_key_log_takes_every_event_as_a_line() {
        let dir = tempfile::tempdir().expect("a folder");
        let file = dir.path().join("keys.log");
        let mut sink = LogSink { file: file.clone() };
        send_keys_with(Some("ctrl+shift+a"), Platform::Windows, &mut sink).expect("logged");
        send_keys_with(Some("meta+up"), Platform::Mac, &mut sink).expect("logged");
        send_keys_with(Some("alt+tab"), Platform::Linux, &mut sink).expect("logged");
        send_media_key_with(MediaKey::Next, Platform::Mac, &mut sink).expect("logged");
        send_media_key_with(MediaKey::Next, Platform::Windows, &mut sink).expect("logged");
        let text = std::fs::read_to_string(&file).expect("the log");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines,
            [
                "scan 29 8",
                "scan 42 8",
                "scan 30 8",
                "wait 30",
                "scan 30 10",
                "scan 42 10",
                "scan 29 10",
                "mac down 55 1048576",
                "mac down 126 9437184",
                "mac up 126 9437184",
                "mac up 55 0",
                "evdev down 56",
                "evdev down 15",
                "wait 30",
                "evdev up 15",
                "evdev up 56",
                "media down 17",
                "media up 17",
                "vk 176 1",
                "vk 176 3",
            ]
        );
    }

    #[test]
    fn every_combination_the_typescript_knows_is_planned_on_linux() {
        for case in cases("keys-windows.json") {
            let text = case["input"].as_str().expect("a combination");
            let combo = combo(text);
            assert_eq!(combo_to_string(&combo), text);
            let events = combo_events(&combo, Platform::Linux).expect(text);
            // As many presses as releases, mirrored around the pause.
            let downs = combo.modifiers.len() + 1;
            assert_eq!(events.len(), downs * 2 + 1, "{text}");
            for index in 0..downs {
                let KeyEvent::Evdev { code, down: true } = events[index] else {
                    panic!("{text}: {:?}", events[index]);
                };
                assert_eq!(
                    events[events.len() - 1 - index],
                    KeyEvent::Evdev { code, down: false },
                    "{text}"
                );
            }
            let _ = modifier("ctrl");
        }
    }
}
