//! Moves this computer's mouse for trackpad decks.
//! (src/server/pointer.ts and helpers/mac-pointer.js)
//!
//! The Node companion kept a helper process running (osascript on a Mac, a
//! PowerShell loop on Windows) and wrote it one line per command: "m dx dy",
//! "s dx dy", "c left|right", "d", "u", and "k …" for a gesture's shortcut
//! ("z ±1" zooms on Windows). Here the same commands are plain data
//! ([`Command`], whose [`Command::line`] is that very text) and go to the
//! system directly:
//!
//! - deciding: [`pointer_command`] reads one message from a deck;
//!   [`MacPointer`], [`windows_inputs`] and [`LinuxPlanner`] turn a command
//!   into the exact events each system is given. All of it is shared and
//!   tested on every system.
//! - doing: a [`PointerSink`] per system (`mac.rs`, `windows.rs`,
//!   `linux.rs`) that only makes the system calls, on a thread of its own
//!   because a finger sends dozens of moves a second and a click holds the
//!   button for a moment.
//!
//! Tests set PUNCHBOARD_POINTER_LOG to a file: lines go there, the mouse
//! stays put.
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::i18n::{say, Text};
use crate::keys::{self, KeyEvent, Platform};
use crate::model::js;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod windows;

// ----------------------------------------------------------------- commands

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PinchPhase {
    Begin,
    Change,
    End,
}

impl PinchPhase {
    fn as_str(self) -> &'static str {
        match self {
            PinchPhase::Begin => "begin",
            PinchPhase::Change => "change",
            PinchPhase::End => "end",
        }
    }

    /// The phases as macOS numbers them: began 1, changed 2, ended 4.
    fn mac_number(self) -> i64 {
        match self {
            PinchPhase::Begin => 1,
            PinchPhase::Change => 2,
            PinchPhase::End => 4,
        }
    }
}

/// One thing the pointer is asked to do: what a line to the old helpers said.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    /// "m dx dy": move the cursor by that many points (drags while the button is down).
    Move { dx: i32, dy: i32 },
    /// "s dx dy": scroll by that many pixels (positive is up and left).
    Scroll { dx: i32, dy: i32 },
    /// "c left|right": click where the cursor is.
    Click(Button),
    /// "d": press the left button: a tap (its release comes later) or a drag
    /// (moves in between).
    Down,
    /// "u": release it.
    Up,
    /// "z ±1": one step of zoom, Ctrl + wheel (Windows and Linux).
    Zoom(i32),
    /// "k code flags": a shortcut by macOS key code and modifier flags.
    MacKey { code: u16, flags: u64 },
    /// "k a,b,c": keys pressed in order and released in reverse: virtual
    /// keys on Windows, the kernel's key codes on Linux.
    Keys(Vec<u16>),
    /// "p phase magnification": a pinch as a Mac trackpad makes it.
    MacPinch {
        phase: PinchPhase,
        magnification: f64,
    },
    /// "pinch phase magnification": a pinch where no such event exists; the
    /// pointer turns it into zoom steps before anything reaches the system.
    Pinch {
        phase: PinchPhase,
        magnification: f64,
    },
    /// "app": the app launcher, which is opened rather than typed (macOS).
    Launcher,
}

/// `number.toFixed(4)`: four decimals, a half going away from zero where
/// Rust's own formatting sends it to the even digit. Only a number that is
/// a whole count of 1/32 can sit exactly on a half here.
fn to_fixed4(number: f64) -> String {
    if number == 0.0 {
        return "0.0000".to_string();
    }
    let thirty_seconds = number.abs() * 32.0;
    if thirty_seconds.fract() == 0.0 && thirty_seconds % 2.0 == 1.0 {
        // Exact: an odd count of 1/32, times 10000, ends in .5.
        let ten_thousandths = (number.abs() * 10000.0 + 0.5).floor() as u64;
        let sign = if number < 0.0 { "-" } else { "" };
        return format!(
            "{sign}{}.{:04}",
            ten_thousandths / 10000,
            ten_thousandths % 10000
        );
    }
    format!("{number:.4}")
}

/// The magnification the system is given: the four decimals of the line,
/// which is all the helper ever read.
fn fixed4_value(number: f64) -> f64 {
    to_fixed4(number).parse().unwrap_or(0.0)
}

impl Command {
    /// The line the helpers were written, and what PUNCHBOARD_POINTER_LOG gets.
    pub fn line(&self) -> String {
        match self {
            Command::Move { dx, dy } => format!("m {dx} {dy}"),
            Command::Scroll { dx, dy } => format!("s {dx} {dy}"),
            Command::Click(Button::Left) => "c left".to_string(),
            Command::Click(Button::Right) => "c right".to_string(),
            Command::Down => "d".to_string(),
            Command::Up => "u".to_string(),
            Command::Zoom(steps) => format!("z {steps}"),
            Command::MacKey { code, flags } => format!("k {code} {flags}"),
            Command::Keys(codes) => {
                let codes: Vec<String> = codes.iter().map(u16::to_string).collect();
                format!("k {}", codes.join(","))
            }
            Command::MacPinch {
                phase,
                magnification,
            } => format!("p {} {}", phase.mac_number(), to_fixed4(*magnification)),
            Command::Pinch {
                phase,
                magnification,
            } => format!("pinch {} {}", phase.as_str(), to_fixed4(*magnification)),
            Command::Launcher => "app".to_string(),
        }
    }
}

// ---------------------------------------------------------------- gestures
//
// No system lets a program perform a real trackpad gesture, so each one
// becomes the shortcut that system already has for it. Swipes are named for
// what the fingers did: fingers moving left bring in what is on the right.

/// macOS key codes. Arrows carry the fn flag, as a real keyboard sends them.
mod mac_key {
    pub const UP: u16 = 126;
    pub const DOWN: u16 = 125;
    pub const LEFT: u16 = 123;
    pub const RIGHT: u16 = 124;
    pub const D: u16 = 2;
    pub const F11: u16 = 103;
    pub const EQUAL: u16 = 24;
    pub const MINUS: u16 = 27;
}

const fn mac_arrow(code: u16) -> Command {
    Command::MacKey {
        code,
        flags: keys::MAC_FLAG_CTRL | keys::MAC_FLAG_FN,
    }
}

/// The gestures a deck can name.
const GESTURES: [&str; 7] = ["up", "down", "left", "right", "tap", "spread", "pinch"];

fn mac_gesture(name: &str) -> Option<Command> {
    Some(match name {
        "up" => mac_arrow(mac_key::UP),      // Mission Control
        "down" => mac_arrow(mac_key::DOWN),  // App Exposé
        "left" => mac_arrow(mac_key::RIGHT), // the desktop or full-screen app to the right
        "right" => mac_arrow(mac_key::LEFT), // … and to the left
        // Look Up
        "tap" => Command::MacKey {
            code: mac_key::D,
            flags: keys::MAC_FLAG_CTRL | keys::MAC_FLAG_CMD,
        },
        // Show Desktop
        "spread" => Command::MacKey {
            code: mac_key::F11,
            flags: 0,
        },
        "pinch" => Command::Launcher, // the app launcher, opened by name
        _ => return None,
    })
}

/// Windows virtual keys, pressed in order and released in reverse. Modifiers
/// are the left-hand keys (VK_LCONTROL, VK_LMENU, VK_LSHIFT), sent without the
/// extended flag, so no keyboard layout reads Alt as AltGr.
mod vk {
    pub const WIN: u16 = 0x5b;
    pub const CTRL: u16 = 0xa2;
    pub const ALT: u16 = 0xa4;
    pub const SHIFT: u16 = 0xa0;
    pub const TAB: u16 = 0x09;
    pub const D: u16 = 0x44;
    pub const S: u16 = 0x53;
    pub const LEFT: u16 = 0x25;
    pub const RIGHT: u16 = 0x27;
}

fn windows_gesture(fingers: u8, name: &str) -> Option<Command> {
    // Four fingers left and right move between virtual desktops on Windows.
    let four: Option<&[u16]> = match (fingers, name) {
        (4, "left") => Some(&[vk::CTRL, vk::WIN, vk::RIGHT]),
        (4, "right") => Some(&[vk::CTRL, vk::WIN, vk::LEFT]),
        _ => None,
    };
    let keys: &[u16] = match four {
        Some(keys) => keys,
        None => match name {
            "up" => &[vk::WIN, vk::TAB],               // Task View
            "down" => &[vk::WIN, vk::D],               // Show Desktop
            "left" => &[vk::ALT, vk::TAB],             // the next app
            "right" => &[vk::ALT, vk::SHIFT, vk::TAB], // … the previous one
            "tap" => &[vk::WIN, vk::S],                // Search
            "spread" => &[vk::WIN, vk::D],
            "pinch" => &[vk::WIN, vk::TAB],
            _ => return None,
        },
    };
    Some(Command::Keys(keys.to_vec()))
}

/// The kernel's key codes (KEY_*), for the shortcuts GNOME and KDE share or
/// come closest on. New here: the Node companion had no pointer on Linux.
mod linux_key {
    pub const META: u16 = 125;
    pub const CTRL: u16 = 29;
    pub const ALT: u16 = 56;
    pub const SHIFT: u16 = 42;
    pub const TAB: u16 = 15;
    pub const A: u16 = 30;
    pub const D: u16 = 32;
    pub const LEFT: u16 = 105;
    pub const RIGHT: u16 = 106;
    pub const BTN_LEFT: u16 = 0x110;
    pub const BTN_RIGHT: u16 = 0x111;
}

fn linux_gesture(fingers: u8, name: &str) -> Option<Command> {
    use linux_key::*;
    // Four fingers left and right move between workspaces.
    let four: Option<&[u16]> = match (fingers, name) {
        (4, "left") => Some(&[CTRL, ALT, RIGHT]),
        (4, "right") => Some(&[CTRL, ALT, LEFT]),
        _ => None,
    };
    let keys: &[u16] = match four {
        Some(keys) => keys,
        None => match name {
            "up" => &[META],               // the overview
            "down" => &[META, D],          // Show Desktop
            "left" => &[ALT, TAB],         // the next app
            "right" => &[ALT, SHIFT, TAB], // … the previous one
            "tap" => &[META],              // the overview, where typing searches
            "spread" => &[META, D],
            "pinch" => &[META, A], // the app grid
            _ => return None,
        },
    };
    Some(Command::Keys(keys.to_vec()))
}

/// `Math.max(-limit, Math.min(limit, Math.round(value)))`.
fn clamp(value: f64, limit: f64) -> i32 {
    js::max(-limit, js::min(limit, js::round(value))) as i32
}

/// Turns one message from a deck into a command, or None if it is not one.
/// `Launcher` asks for the app launcher, which is opened rather than typed.
pub fn pointer_command(message: &Value, platform: Platform) -> Option<Command> {
    let items = message.as_array()?;
    let a = items.get(1);
    let b = items.get(2);
    // Number(undefined) is NaN.
    let number = |value: Option<&Value>| value.map_or(f64::NAN, js::to_number);
    let x = number(a);
    let y = number(b);
    fn text(value: Option<&Value>) -> Option<&str> {
        value.and_then(Value::as_str)
    }
    let mac = platform == Platform::Mac;
    match items.first().and_then(Value::as_str)? {
        "m" if x.is_finite() && y.is_finite() => Some(Command::Move {
            dx: clamp(x, 400.0),
            dy: clamp(y, 400.0),
        }),
        "s" if x.is_finite() && y.is_finite() => Some(Command::Scroll {
            dx: clamp(x, 2000.0),
            dy: clamp(y, 2000.0),
        }),
        "c" => match text(a) {
            Some("left") => Some(Command::Click(Button::Left)),
            Some("right") => Some(Command::Click(Button::Right)),
            _ => None,
        },
        "d" => Some(Command::Down),
        "u" => Some(Command::Up),
        "z" if x == 1.0 || x == -1.0 => {
            // Pinch zoom: Cmd +/- on a Mac, Ctrl + wheel elsewhere.
            Some(if mac {
                Command::MacKey {
                    code: if x > 0.0 {
                        mac_key::EQUAL
                    } else {
                        mac_key::MINUS
                    },
                    flags: keys::MAC_FLAG_CMD,
                }
            } else {
                Command::Zoom(x as i32)
            })
        }
        "p" if y.is_finite() => {
            let phase = match text(a)? {
                "begin" => PinchPhase::Begin,
                "change" => PinchPhase::Change,
                "end" => PinchPhase::End,
                _ => return None,
            };
            // A real magnify gesture on a Mac: phases as the system numbers
            // them, the magnification kept to a sane step. Windows and Linux
            // have no such event; the pointer turns it into zoom steps.
            let magnification = js::max(-0.5, js::min(0.5, y));
            Some(if mac {
                Command::MacPinch {
                    phase,
                    magnification,
                }
            } else {
                Command::Pinch {
                    phase,
                    magnification,
                }
            })
        }
        "g" => {
            let fingers = match a {
                Some(value @ Value::Number(_)) if js::to_number(value) == 3.0 => 3,
                Some(value @ Value::Number(_)) if js::to_number(value) == 4.0 => 4,
                _ => return None,
            };
            let name = text(b).filter(|name| GESTURES.contains(name))?;
            match platform {
                Platform::Mac => mac_gesture(name),
                Platform::Windows => windows_gesture(fingers, name),
                Platform::Linux => linux_gesture(fingers, name),
            }
        }
        _ => None,
    }
}

/// Turns one message from a deck into a helper line, or None if it is not
/// one: the text the Node companion wrote, and what the pointer log holds.
pub fn pointer_line(message: &Value, platform: Platform) -> Option<String> {
    pointer_command(message, platform).map(|command| command.line())
}

// ------------------------------------------------------------- doing: sinks

/// Where commands go: this system's pointer, or a list in a test.
pub trait PointerSink {
    fn run(&mut self, command: &Command) -> Result<(), String>;
    /// The pointer is going away: leave nothing held.
    fn close(&mut self) {}
}

/// Why the system's pointer could not be reached.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OpenError {
    /// No pointer on this system.
    Unsupported,
    /// macOS: the app running Punchboard is not allowed under Accessibility.
    MacPermission,
    /// Linux: this account may not use /dev/uinput.
    LinuxPermission,
    /// Anything else, in the system's own words.
    Other(String),
}

/// Reaches the system's pointer; called again, after a wait, when it failed.
pub type Opener = Box<dyn FnMut() -> Result<Box<dyn PointerSink>, OpenError> + Send>;

pub struct PointerOptions {
    pub log: Box<dyn Fn(&str) + Send + Sync>,
    /// A problem worth showing on the deck, such as a missing permission;
    /// worded for each deck when it is sent.
    pub on_problem: Box<dyn Fn(Text) + Send + Sync>,
}

/// The first wait before reaching for a failing pointer again; it doubles.
const FIRST_RETRY: Duration = Duration::from_millis(500);
/// The longest wait before reaching for a failing pointer again.
const MAX_RETRY: Duration = Duration::from_millis(30000);

/// Runs commands on the system's pointer, opening it at the first one.
///
/// A pointer that cannot be reached (permission missing, no X server) is
/// tried again after a growing wait, not on every move a finger sends, and
/// the deck is told once.
struct Driver {
    opener: Opener,
    sink: Option<Box<dyn PointerSink>>,
    options: Arc<PointerOptions>,
    failures: u32,
    retry_at: Option<Instant>,
    reported: bool,
}

impl Driver {
    fn new(opener: Opener, options: Arc<PointerOptions>) -> Driver {
        Driver {
            opener,
            sink: None,
            options,
            failures: 0,
            retry_at: None,
            reported: false,
        }
    }

    fn failed(&mut self, now: Instant, log: String, problem: Text) {
        self.sink = None;
        self.failures += 1;
        let wait = FIRST_RETRY
            .checked_mul(2u32.saturating_pow(self.failures - 1))
            .map_or(MAX_RETRY, |wait| wait.min(MAX_RETRY));
        self.retry_at = Some(now + wait);
        if !self.reported {
            self.reported = true;
            (self.options.log)(&log);
            (self.options.on_problem)(problem);
        }
    }

    fn run(&mut self, command: &Command, now: Instant) {
        if self.sink.is_none() {
            if self.retry_at.is_some_and(|at| now < at) {
                return;
            }
            match (self.opener)() {
                Ok(sink) => self.sink = Some(sink),
                Err(error) => {
                    let (log, problem) = match error {
                        OpenError::Unsupported => (
                            "Trackpad: not supported on this system".to_string(),
                            say("server.trackpad.unsupported"),
                        ),
                        OpenError::MacPermission => (
                            "Trackpad: not allowed to post events".to_string(),
                            say("server.trackpad.macPermission"),
                        ),
                        OpenError::LinuxPermission => (
                            "Trackpad: not allowed to use /dev/uinput".to_string(),
                            say("server.pointer.linuxPermission"),
                        ),
                        OpenError::Other(reason) => (
                            format!("Trackpad: {reason}"),
                            say("server.trackpad.refused").with("reason", reason),
                        ),
                    };
                    return self.failed(now, log, problem);
                }
            }
        }
        let Some(sink) = self.sink.as_mut() else {
            return;
        };
        match sink.run(command) {
            Ok(()) => {
                self.failures = 0;
                self.retry_at = None;
                self.reported = false;
            }
            Err(reason) => {
                let problem = say("server.trackpad.refused").with("reason", reason.clone());
                self.failed(now, format!("Trackpad: {reason}"), problem);
            }
        }
    }

    fn close(&mut self) {
        if let Some(mut sink) = self.sink.take() {
            sink.close();
        }
    }
}

/// This system's own pointer.
fn system_opener() -> Opener {
    Box::new(|| {
        #[cfg(target_os = "macos")]
        return mac::open();
        #[cfg(windows)]
        return windows::open();
        #[cfg(target_os = "linux")]
        return linux::open();
        #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
        Err(OpenError::Unsupported)
    })
}

// -------------------------------------------------------------- the pointer

/// Who sent a message: each open trackpad socket is its own owner.
pub type PointerOwner = u64;

/// A new owner, unlike every other one.
pub fn next_owner() -> PointerOwner {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

enum Output {
    /// PUNCHBOARD_POINTER_LOG: lines go to this file, the mouse stays put.
    Log(PathBuf),
    /// The thread that drives the system's pointer.
    Worker {
        commands: Option<Sender<Command>>,
        thread: Option<JoinHandle<()>>,
    },
}

struct State {
    // The computer has one left button and one pinch in progress, whoever
    // holds them. A deck that goes away lets go only of what it holds
    // itself, never of a drag another deck is in the middle of.
    left_held: bool,
    left_owner: Option<PointerOwner>,
    pinch_open: bool,
    pinch_owner: Option<PointerOwner>,
    /// Windows and Linux: how much of a zoom step a pinch has built up.
    pinch_carry: f64,
    output: Output,
}

pub struct Pointer {
    platform: Platform,
    options: Arc<PointerOptions>,
    state: Mutex<State>,
}

impl Pointer {
    /// The pointer of this computer (`createPointer`). Nothing is opened
    /// until the first command. With PUNCHBOARD_POINTER_LOG set, commands go
    /// to that file and the system is never touched.
    pub fn new(options: PointerOptions) -> Pointer {
        // A system without a pointer still reads messages, as the Node
        // companion did (with the lines of Windows); the deck is told at
        // the first one.
        let platform = Platform::current().unwrap_or(Platform::Windows);
        let log = std::env::var_os("PUNCHBOARD_POINTER_LOG").filter(|file| !file.is_empty());
        match log {
            Some(file) => Pointer::with_log(options, platform, PathBuf::from(file)),
            None => Pointer::with_opener(options, platform, system_opener()),
        }
    }

    /// A pointer that only writes its lines to a file.
    pub fn with_log(options: PointerOptions, platform: Platform, file: PathBuf) -> Pointer {
        Pointer::build(options, platform, Output::Log(file))
    }

    /// A pointer that reads messages as `platform` does and drives whatever
    /// `opener` gives: tests pass a stand-in here, so the real mouse is never
    /// touched (and PUNCHBOARD_POINTER_LOG is ignored).
    pub fn with_opener(options: PointerOptions, platform: Platform, opener: Opener) -> Pointer {
        let options = Arc::new(options);
        let (commands, received) = mpsc::channel::<Command>();
        let for_thread = Arc::clone(&options);
        let spawned = std::thread::Builder::new()
            .name("pointer".to_string())
            .spawn(move || {
                let mut driver = Driver::new(opener, for_thread);
                for command in received {
                    driver.run(&command, Instant::now());
                }
                driver.close();
            });
        let thread = match spawned {
            Ok(thread) => Some(thread),
            Err(error) => {
                (options.log)(&format!("The trackpad could not start: {error}"));
                None
            }
        };
        Pointer::build_shared(
            options,
            platform,
            Output::Worker {
                commands: Some(commands),
                thread,
            },
        )
    }

    fn build(options: PointerOptions, platform: Platform, output: Output) -> Pointer {
        Pointer::build_shared(Arc::new(options), platform, output)
    }

    fn build_shared(options: Arc<PointerOptions>, platform: Platform, output: Output) -> Pointer {
        Pointer {
            platform,
            options,
            state: Mutex::new(State {
                left_held: false,
                left_owner: None,
                pinch_open: false,
                pinch_owner: None,
                pinch_carry: 0.0,
                output,
            }),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// One message from a deck's socket, already parsed as JSON. Anything
    /// that is not a pointer message is dropped.
    pub fn send(&self, message: &Value, owner: Option<PointerOwner>) {
        self.send_locked(&mut self.state(), message, owner);
    }

    fn send_locked(&self, state: &mut State, message: &Value, owner: Option<PointerOwner>) {
        let Some(command) = pointer_command(message, self.platform) else {
            return;
        };
        match &command {
            Command::Down => {
                state.left_held = true;
                state.left_owner = owner;
            }
            Command::Up => {
                state.left_held = false;
                state.left_owner = None;
            }
            Command::MacPinch { phase, .. } | Command::Pinch { phase, .. } => {
                if *phase == PinchPhase::End {
                    state.pinch_open = false;
                    state.pinch_owner = None;
                } else {
                    state.pinch_open = true;
                    state.pinch_owner = owner;
                }
            }
            _ => {}
        }
        // Turned into zoom steps before anything is written, so tests see what the computer would.
        if let Command::Pinch {
            phase,
            magnification,
        } = command
        {
            return self.pinch_steps(state, phase, fixed4_value(magnification));
        }
        self.emit(state, command);
    }

    /// Windows and Linux: a pinch becomes Ctrl + wheel steps, about one per 35% of zoom.
    fn pinch_steps(&self, state: &mut State, phase: PinchPhase, magnification: f64) {
        if phase == PinchPhase::Begin {
            state.pinch_carry = 0.0;
        }
        state.pinch_carry += (1.0 + magnification).ln();
        while state.pinch_carry.abs() >= 0.3 {
            let zoom_in = state.pinch_carry > 0.0;
            self.emit(state, Command::Zoom(if zoom_in { 1 } else { -1 }));
            state.pinch_carry += if zoom_in { -0.3 } else { 0.3 };
        }
        if phase == PinchPhase::End {
            state.pinch_carry = 0.0;
        }
    }

    fn emit(&self, state: &mut State, command: Command) {
        match &state.output {
            Output::Log(file) => {
                let written = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(file)
                    .and_then(|mut file| file.write_all((command.line() + "\n").as_bytes()));
                if let Err(error) = written {
                    (self.options.log)(&format!("The pointer log could not be written: {error}"));
                }
            }
            Output::Worker { commands, .. } => {
                if let Some(commands) = commands {
                    // The thread only ends when this end is dropped.
                    let _ = commands.send(command);
                }
            }
        }
    }

    /// A deck went away mid-drag or mid-pinch: never leave the button held
    /// down or a pinch open. Only what this owner started is let go; None
    /// lets go of everything.
    pub fn release(&self, owner: Option<PointerOwner>) {
        self.release_locked(&mut self.state(), owner);
    }

    fn release_locked(&self, state: &mut State, owner: Option<PointerOwner>) {
        if state.left_held && (owner.is_none() || state.left_owner == owner) {
            self.send_locked(state, &serde_json::json!(["u"]), None);
        }
        if state.pinch_open && (owner.is_none() || state.pinch_owner == owner) {
            self.send_locked(state, &serde_json::json!(["p", "end", 0]), None);
        }
    }

    /// Lets go of everything and stops: what is queued is still done, then
    /// the system's pointer is closed. Messages after this are dropped.
    pub fn dispose(&self) {
        let thread = {
            let mut state = self.state();
            self.release_locked(&mut state, None);
            match &mut state.output {
                Output::Log(_) => None,
                Output::Worker { commands, thread } => {
                    commands.take();
                    thread.take()
                }
            }
        };
        if let Some(thread) = thread {
            if thread.join().is_err() {
                (self.options.log)("The trackpad stopped with an error.");
            }
        }
    }
}

impl Drop for Pointer {
    fn drop(&mut self) {
        self.dispose();
    }
}

// ------------------------------------------------- deciding: macOS's events
//
// helpers/mac-pointer.js, as data: what it posted for each line it read.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// A display in CoreGraphics coordinates (origin top left of the main one).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The mouse event types, as Quartz numbers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseKind {
    LeftDown = 1,
    LeftUp = 2,
    RightDown = 3,
    RightUp = 4,
    Moved = 5,
    LeftDragged = 6,
}

/// One thing macOS is given.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MacEvent {
    /// A mouse event at a point. No modifier rides along (its flags are 0):
    /// a shortcut must never turn a click into a ⌘-click. `clicks` is the
    /// click count of a press or release, 0 where the event carries none.
    Mouse {
        kind: MouseKind,
        at: Point,
        /// 0 left, 1 right.
        button: u8,
        clicks: i64,
    },
    /// Pixel units, vertical then horizontal; positive is up and left.
    Scroll { vertical: i32, horizontal: i32 },
    /// A key down or up with the modifier flags it carries.
    Key { code: u16, down: bool, flags: u64 },
    /// A trackpad pinch: a "gesture" event of the magnify kind. See
    /// [`mac_gesture_fields`].
    Magnify { phase: i64, magnification: f64 },
    /// Nothing for this long, with the button still down.
    Hold(Duration),
    /// Four fingers pinching: the app launcher (Apps on macOS 26, Launchpad before).
    Launcher,
}

/// A trackpad pinch is a "gesture" event (type 29) of the magnify kind.
/// Apple does not document how to make one; these field numbers are how
/// macOS stores it, and the system reads the result back as an ordinary
/// magnify event, the kind apps zoom maps, photos and pages with.
pub mod mac_gesture_fields {
    pub const EVENT_TYPE: u32 = 29;
    pub const FLAGS: u64 = 0x100;
    pub const FIELD_KIND: u32 = 110;
    pub const FIELD_MAGNIFICATION: u32 = 113;
    pub const FIELD_PHASE: u32 = 132;
    pub const KIND_MAGNIFY: i64 = 8;
}

/// What deciding needs to ask macOS, and where the events go.
pub trait MacSystem {
    /// The clock, in milliseconds.
    fn now_ms(&mut self) -> f64;
    /// Where the cursor is.
    fn location(&mut self) -> Result<Point, String>;
    /// Every display, the main one first.
    fn displays(&mut self) -> Vec<Rect>;
    fn post(&mut self, event: MacEvent) -> Result<(), String>;
}

/// A left press this soon after the last one, and this close to it, is the
/// next click of the same series: the second is a double click. A slow
/// double tap reaches here as the first tap's press, its release up to the
/// deck's drag wait later (dragMs, 300 ms in src/shared/touchpad/tuning.ts),
/// then a second tap of up to tapMs (180 ms): about 500 ms between presses.
const DOUBLE_CLICK_MS: f64 = 550.0;
const DOUBLE_CLICK_PX: f64 = 6.0;
/// How long a click holds the button. A press and release at the same instant
/// is sometimes dropped (Chrome is known to), and no finger clicks that fast.
const CLICK_HOLD: Duration = Duration::from_millis(20);
/// How long the list of displays is trusted.
const DISPLAYS_FRESH_MS: f64 = 2000.0;

fn inside(point: Point, rect: &Rect) -> bool {
    point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h
}

/// Keeps the cursor on a screen: it may cross onto another display, never off all of them.
fn clamp_point(displays: &[Rect], from: Point, to: Point) -> Point {
    if displays.iter().any(|display| inside(to, display)) {
        return to;
    }
    let mut home = displays.first();
    for display in displays {
        if inside(from, display) {
            home = Some(display);
        }
    }
    let Some(home) = home else {
        return to;
    };
    Point {
        x: home.x.max((home.x + home.w - 1.0).min(to.x)),
        y: home.y.max((home.y + home.h - 1.0).min(to.y)),
    }
}

/// The pointer of a Mac: turns commands into the events macOS is given.
pub struct MacPointer<S: MacSystem> {
    system: S,
    left_down: bool,
    last_down_at: f64,
    last_down_point: Point,
    click_count: i64,
    screens: Vec<Rect>,
    screens_at: f64,
    pinch_open: bool,
}

impl<S: MacSystem> MacPointer<S> {
    pub fn new(system: S) -> MacPointer<S> {
        MacPointer {
            system,
            left_down: false,
            last_down_at: 0.0,
            last_down_point: Point { x: 0.0, y: 0.0 },
            click_count: 1,
            screens: Vec::new(),
            screens_at: 0.0,
            pinch_open: false,
        }
    }

    pub fn system(&self) -> &S {
        &self.system
    }

    fn displays(&mut self) -> &[Rect] {
        let now = self.system.now_ms();
        let fresh = now - self.screens_at < DISPLAYS_FRESH_MS && !self.screens.is_empty();
        if !fresh {
            self.screens = self.system.displays();
            self.screens_at = now;
        }
        &self.screens
    }

    fn mouse(&mut self, kind: MouseKind, at: Point, button: u8, clicks: i64) -> Result<(), String> {
        self.system.post(MacEvent::Mouse {
            kind,
            at,
            button,
            clicks,
        })
    }

    fn movement(&mut self, dx: f64, dy: f64) -> Result<(), String> {
        let from = self.system.location()?;
        let wanted = Point {
            x: from.x + dx,
            y: from.y + dy,
        };
        let to = clamp_point(self.displays(), from, wanted);
        let kind = if self.left_down {
            MouseKind::LeftDragged
        } else {
            MouseKind::Moved
        };
        self.mouse(kind, to, 0, 0)
    }

    /// Presses the left button at the cursor, counting clicks the way macOS does
    /// for a mouse: a press soon after the last one, in the same place, is the
    /// next click of it, and its release carries the same count. The count is
    /// kept here rather than in click() alone because a deck sends a tap as a
    /// press whose release follows later (a finger may come back to drag with
    /// it), and a double tap as that release and then a click: the second press
    /// must read as the double click whichever command made the first.
    fn left_press(&mut self, point: Point) -> Result<(), String> {
        let now = self.system.now_ms();
        let near = (point.x - self.last_down_point.x).abs() <= DOUBLE_CLICK_PX
            && (point.y - self.last_down_point.y).abs() <= DOUBLE_CLICK_PX;
        self.click_count = if now - self.last_down_at < DOUBLE_CLICK_MS && near {
            self.click_count + 1
        } else {
            1
        };
        self.last_down_at = now;
        self.last_down_point = point;
        self.left_down = true;
        self.mouse(MouseKind::LeftDown, point, 0, self.click_count)
    }

    fn left_release(&mut self, point: Point) -> Result<(), String> {
        self.left_down = false;
        self.mouse(MouseKind::LeftUp, point, 0, self.click_count)
    }

    /// Where the cursor is, after a move to that very spot: the window under it
    /// is the one macOS hands the press to, even if nothing has moved since it
    /// started.
    fn press_point(&mut self) -> Result<Point, String> {
        let point = self.system.location()?;
        self.mouse(MouseKind::Moved, point, 0, 0)?;
        Ok(point)
    }

    fn click(&mut self, button: Button) -> Result<(), String> {
        let point = self.press_point()?;
        if button == Button::Right {
            self.mouse(MouseKind::RightDown, point, 1, 1)?;
            self.system.post(MacEvent::Hold(CLICK_HOLD))?;
            return self.mouse(MouseKind::RightUp, point, 1, 1);
        }
        self.left_press(point)?;
        self.system.post(MacEvent::Hold(CLICK_HOLD))?;
        self.left_release(point)
    }

    fn pinch(&mut self, phase: i64, magnification: f64) -> Result<(), String> {
        self.pinch_open = phase != 4;
        self.system.post(MacEvent::Magnify {
            phase,
            magnification,
        })
    }
}

impl<S: MacSystem> PointerSink for MacPointer<S> {
    fn run(&mut self, command: &Command) -> Result<(), String> {
        match command {
            Command::Move { dx, dy } => self.movement(f64::from(*dx), f64::from(*dy)),
            Command::Scroll { dx, dy } => self.system.post(MacEvent::Scroll {
                vertical: *dy,
                horizontal: *dx,
            }),
            Command::Click(button) => self.click(*button),
            Command::Down => {
                let point = self.press_point()?;
                self.left_press(point)
            }
            Command::Up => {
                let point = self.system.location()?;
                self.left_release(point)
            }
            Command::MacKey { code, flags } => {
                for event in keys::mac_shortcut(*code, *flags) {
                    if let KeyEvent::Mac { code, down, flags } = event {
                        self.system.post(MacEvent::Key { code, down, flags })?;
                    }
                }
                Ok(())
            }
            Command::MacPinch {
                phase,
                magnification,
            } => self.pinch(phase.mac_number(), fixed4_value(*magnification)),
            Command::Launcher => self.system.post(MacEvent::Launcher),
            // Other systems' commands are never made for this one.
            Command::Zoom(_) | Command::Keys(_) | Command::Pinch { .. } => Ok(()),
        }
    }

    /// Leaves nothing held on the way out: macOS keeps a pressed button or an
    /// open pinch down until it hears otherwise, so a companion that quit
    /// mid-drag would leave every window dragging.
    fn close(&mut self) {
        if self.left_down {
            if let Ok(point) = self.system.location() {
                let _ = self.left_release(point);
            }
        }
        if self.pinch_open {
            let _ = self.pinch(4, 0.0);
        }
    }
}

// ------------------------------------------------ deciding: Windows' events

/// One event SendInput is given: what the PowerShell loop passed to
/// user32's mouse_event and keybd_event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WinInput {
    Mouse {
        flags: u32,
        dx: i32,
        dy: i32,
        data: i32,
    },
    Key {
        vk: u8,
        flags: u32,
    },
}

// MOUSEEVENTF_*.
const WIN_MOVE: u32 = 0x0001;
const WIN_LEFTDOWN: u32 = 0x0002;
const WIN_LEFTUP: u32 = 0x0004;
const WIN_RIGHTDOWN: u32 = 0x0008;
const WIN_RIGHTUP: u32 = 0x0010;
const WIN_WHEEL: u32 = 0x0800;
const WIN_HWHEEL: u32 = 0x1000;
/// One notch of a wheel.
const WHEEL_DELTA: i32 = 120;

/// Only these keys are "extended". Flagging a plain modifier presses its
/// right-hand twin instead: Alt becomes AltGr on Spanish and German layouts.
fn win_extended(vk: u8) -> bool {
    vk == 0x5b
        || vk == 0x5c
        || (0x21..=0x28).contains(&vk)
        || vk == 0x2d
        || vk == 0x2e
        || (0xad..=0xb7).contains(&vk)
}

/// The events Windows is given for one command, in order. Scroll arrives in
/// pixels (positive is up and left). Windows counts wheel units, 120 to a
/// notch, with positive meaning up and right.
pub fn windows_inputs(command: &Command) -> Vec<WinInput> {
    let button = |flags: u32| WinInput::Mouse {
        flags,
        dx: 0,
        dy: 0,
        data: 0,
    };
    let wheel = |flags: u32, data: i32| WinInput::Mouse {
        flags,
        dx: 0,
        dy: 0,
        data,
    };
    match command {
        Command::Move { dx, dy } => vec![WinInput::Mouse {
            flags: WIN_MOVE,
            dx: *dx,
            dy: *dy,
            data: 0,
        }],
        Command::Scroll { dx, dy } => {
            let vertical = dy * 3;
            let horizontal = -dx * 3;
            let mut inputs = Vec::new();
            if vertical != 0 {
                inputs.push(wheel(WIN_WHEEL, vertical));
            }
            if horizontal != 0 {
                inputs.push(wheel(WIN_HWHEEL, horizontal));
            }
            inputs
        }
        Command::Click(Button::Right) => vec![button(WIN_RIGHTDOWN), button(WIN_RIGHTUP)],
        Command::Click(Button::Left) => vec![button(WIN_LEFTDOWN), button(WIN_LEFTUP)],
        Command::Down => vec![button(WIN_LEFTDOWN)],
        Command::Up => vec![button(WIN_LEFTUP)],
        Command::Zoom(steps) => vec![
            WinInput::Key {
                vk: vk::CTRL as u8,
                flags: 0,
            },
            wheel(WIN_WHEEL, steps * WHEEL_DELTA),
            WinInput::Key {
                vk: vk::CTRL as u8,
                flags: 2,
            },
        ],
        Command::Keys(codes) => {
            let codes: Vec<u8> = codes
                .iter()
                .filter_map(|code| u8::try_from(*code).ok())
                .collect();
            let down = codes.iter().map(|vk| WinInput::Key {
                vk: *vk,
                flags: u32::from(win_extended(*vk)),
            });
            let up = codes.iter().rev().map(|vk| WinInput::Key {
                vk: *vk,
                flags: if win_extended(*vk) { 3 } else { 2 },
            });
            down.chain(up).collect()
        }
        // Other systems' commands are never made for this one, and a pinch
        // has become zoom steps by now.
        Command::MacKey { .. }
        | Command::MacPinch { .. }
        | Command::Pinch { .. }
        | Command::Launcher => Vec::new(),
    }
}

// -------------------------------------------------- deciding: Linux's events

/// One thing a Linux pointer is given, whichever door it goes through
/// (XTest or a virtual device on /dev/uinput).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinuxEvent {
    /// The cursor, by this many pixels.
    Motion {
        dx: i32,
        dy: i32,
    },
    Button {
        button: Button,
        down: bool,
    },
    /// A key by the kernel's code.
    Key {
        code: u16,
        down: bool,
    },
    /// The wheel. `vertical` and `horizontal` are in 120ths of a notch
    /// (positive is up and right), which a virtual device passes on as they
    /// are; the notches are the whole ones those have added up to, which is
    /// all XTest can press (buttons 4 to 7).
    Wheel {
        vertical: i32,
        horizontal: i32,
        vertical_notches: i32,
        horizontal_notches: i32,
    },
}

/// Turns commands into Linux's events, keeping the part of a wheel notch
/// that scrolling has not yet added up to.
#[derive(Debug, Default)]
pub struct LinuxPlanner {
    vertical_carry: i32,
    horizontal_carry: i32,
}

/// The whole notches in what has built up, which are taken out of it.
fn notches(carry: &mut i32, units: i32) -> i32 {
    *carry += units;
    let whole = *carry / WHEEL_DELTA;
    *carry -= whole * WHEEL_DELTA;
    whole
}

impl LinuxPlanner {
    /// The events for one command, in order. Scroll arrives in pixels
    /// (positive is up and left) and is scaled as on Windows: 40 pixels to
    /// a notch.
    pub fn events(&mut self, command: &Command) -> Vec<LinuxEvent> {
        let key = |code: u16, down: bool| LinuxEvent::Key { code, down };
        let button = |button: Button, down: bool| LinuxEvent::Button { button, down };
        match command {
            Command::Move { dx, dy } => vec![LinuxEvent::Motion { dx: *dx, dy: *dy }],
            Command::Scroll { dx, dy } => {
                let vertical = dy * 3;
                let horizontal = -dx * 3;
                if vertical == 0 && horizontal == 0 {
                    return Vec::new();
                }
                vec![LinuxEvent::Wheel {
                    vertical,
                    horizontal,
                    vertical_notches: notches(&mut self.vertical_carry, vertical),
                    horizontal_notches: notches(&mut self.horizontal_carry, horizontal),
                }]
            }
            Command::Click(which) => vec![button(*which, true), button(*which, false)],
            Command::Down => vec![button(Button::Left, true)],
            Command::Up => vec![button(Button::Left, false)],
            Command::Zoom(steps) => vec![
                key(linux_key::CTRL, true),
                LinuxEvent::Wheel {
                    vertical: steps * WHEEL_DELTA,
                    horizontal: 0,
                    vertical_notches: *steps,
                    horizontal_notches: 0,
                },
                key(linux_key::CTRL, false),
            ],
            Command::Keys(codes) => {
                let down = codes.iter().map(|code| key(*code, true));
                let up = codes.iter().rev().map(|code| key(*code, false));
                down.chain(up).collect()
            }
            // Other systems' commands are never made for this one, and a
            // pinch has become zoom steps by now.
            Command::MacKey { .. }
            | Command::MacPinch { .. }
            | Command::Pinch { .. }
            | Command::Launcher => Vec::new(),
        }
    }
}

/// Every key a Linux pointer may press, for the virtual device to announce.
pub fn linux_pointer_keys() -> Vec<u16> {
    use linux_key::*;
    vec![
        BTN_LEFT, BTN_RIGHT, META, CTRL, ALT, SHIFT, TAB, A, D, LEFT, RIGHT,
    ]
}

/// The kernel's code of a mouse button.
pub fn linux_button_code(button: Button) -> u16 {
    match button {
        Button::Left => linux_key::BTN_LEFT,
        Button::Right => linux_key::BTN_RIGHT,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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

    fn line_json(line: Option<String>) -> Value {
        line.map_or(Value::Null, Value::from)
    }

    fn quiet() -> PointerOptions {
        PointerOptions {
            log: Box::new(|_| {}),
            on_problem: Box::new(|_| {}),
        }
    }

    // ------------------------------------------------------ the fixtures

    #[test]
    fn messages_become_the_lines_the_typescript_made() {
        let all = cases("pointer-lines.json");
        assert!(all.len() > 6000, "{} messages", all.len());
        let mut gestures = 0;
        for case in &all {
            let message = &case["input"];
            let theirs = &case["output"];
            assert_eq!(
                line_json(pointer_line(message, Platform::Mac)),
                theirs["darwin"],
                "{message} on a Mac"
            );
            assert_eq!(
                line_json(pointer_line(message, Platform::Windows)),
                theirs["win32"],
                "{message} on Windows"
            );
            // Linux is new. The Node companion read messages there as on
            // Windows, and so does this one, but for the gestures: their
            // shortcuts are Linux's own keys.
            let ours = pointer_line(message, Platform::Linux);
            let gesture = message.get(0).and_then(Value::as_str) == Some("g");
            if gesture && !theirs["linux"].is_null() {
                gestures += 1;
                let line = ours.unwrap_or_else(|| panic!("{message} on Linux"));
                assert!(line.starts_with("k "), "{message} on Linux: {line}");
            } else {
                assert_eq!(line_json(ours), theirs["linux"], "{message} on Linux");
            }
        }
        assert!(gestures >= 14, "every gesture with three and four fingers");
    }

    #[test]
    fn four_decimals_are_rounded_as_javascript_rounds_them() {
        assert_eq!(to_fixed4(0.0), "0.0000");
        assert_eq!(to_fixed4(-0.0), "0.0000");
        assert_eq!(to_fixed4(0.03125), "0.0313");
        assert_eq!(to_fixed4(-0.03125), "-0.0313");
        assert_eq!(to_fixed4(0.46875), "0.4688");
        assert_eq!(to_fixed4(0.5), "0.5000");
        assert_eq!(to_fixed4(-0.00001), "-0.0000");
        assert_eq!(to_fixed4(0.05), "0.0500");
        assert_eq!(fixed4_value(-0.00001), 0.0);
        assert_eq!(fixed4_value(0.123449), 0.1234);
    }

    #[test]
    fn linux_gestures_are_its_own_shortcuts() {
        let line = |fingers: u8, name: &str| {
            pointer_line(&json!(["g", fingers, name]), Platform::Linux).expect(name)
        };
        assert_eq!(line(3, "up"), "k 125");
        assert_eq!(line(3, "down"), "k 125,32");
        assert_eq!(line(3, "left"), "k 56,15");
        assert_eq!(line(3, "right"), "k 56,42,15");
        assert_eq!(line(3, "tap"), "k 125");
        assert_eq!(line(4, "spread"), "k 125,32");
        assert_eq!(line(4, "pinch"), "k 125,30");
        assert_eq!(line(4, "left"), "k 29,56,106");
        assert_eq!(line(4, "right"), "k 29,56,105");
        assert_eq!(line(4, "up"), "k 125");
        // Every key of every gesture is one the virtual device announces.
        let announced = linux_pointer_keys();
        for fingers in [3, 4] {
            for name in GESTURES {
                let Some(Command::Keys(codes)) = linux_gesture(fingers, name) else {
                    panic!("{name}");
                };
                assert!(codes.iter().all(|code| announced.contains(code)), "{name}");
            }
        }
    }

    // ------------------------- tests/trackpad.test.mjs, through the log file

    struct Logged {
        _dir: tempfile::TempDir,
        file: PathBuf,
        pointer: Pointer,
    }

    fn logged(platform: Platform) -> Logged {
        let dir = tempfile::tempdir().expect("a folder");
        let file = dir.path().join("pointer.log");
        let pointer = Pointer::with_log(quiet(), platform, file.clone());
        Logged {
            _dir: dir,
            file,
            pointer,
        }
    }

    impl Logged {
        fn lines(&self) -> Vec<String> {
            std::fs::read_to_string(&self.file)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        }
    }

    #[test]
    fn moves_scrolls_and_clicks_are_passed_on_and_the_rest_dropped() {
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            let log = logged(platform);
            let owner = Some(next_owner());
            for message in [
                json!(["m", 12, -4]),
                json!(["s", 0, 30]),
                json!(["c", "left"]),
                json!(["c", "right"]),
                json!(["m", 9999, 0]),
                json!(["x", 1]),
                json!(["c", "middle"]),
                json!("junk"),
                json!(["d"]),
                json!(["m", 3, 3]),
            ] {
                log.pointer.send(&message, owner);
            }
            let got = log.lines();
            assert_eq!(got[..4], ["m 12 -4", "s 0 30", "c left", "c right"]);
            assert_eq!(got[4], "m 400 0", "Huge moves are capped");
            assert_eq!(got[5..], ["d", "m 3 3"], "Unknown messages are dropped");

            // Closing mid-drag releases the button.
            log.pointer.release(owner);
            assert_eq!(log.lines().last().map(String::as_str), Some("u"));
            // …once.
            let before = log.lines().len();
            log.pointer.release(owner);
            log.pointer.release(None);
            assert_eq!(log.lines().len(), before);
        }
    }

    #[test]
    fn a_real_pinch_reaches_the_computer_as_a_pinch_or_as_zoom_steps() {
        let pinch = [
            json!(["p", "begin", 0]),
            json!(["p", "change", 0.5]),
            json!(["p", "change", 0.05]),
            json!(["p", "end", 0]),
            json!(["p", "sideways", 1]),
            json!(["p", "change", "big"]),
        ];
        let log = logged(Platform::Mac);
        for message in &pinch {
            log.pointer.send(message, None);
        }
        assert_eq!(
            log.lines(),
            ["p 1 0.0000", "p 2 0.5000", "p 2 0.0500", "p 4 0.0000"]
        );
        for platform in [Platform::Windows, Platform::Linux] {
            let log = logged(platform);
            for message in &pinch {
                log.pointer.send(message, None);
            }
            // ln(1.5) is one step of 0.3 and a rest; the 5% does not reach the next.
            assert_eq!(log.lines(), ["z 1"]);
        }
    }

    #[test]
    fn a_pinch_becomes_a_zoom_step_about_every_35_percent() {
        let log = logged(Platform::Windows);
        log.pointer.send(&json!(["p", "begin", 0]), None);
        for _ in 0..4 {
            log.pointer.send(&json!(["p", "change", 0.2]), None);
        }
        // ln(1.2) = 0.182: steps at the 2nd and 4th.
        assert_eq!(log.lines(), ["z 1", "z 1"]);
        log.pointer.send(&json!(["p", "end", 0]), None);
        log.pointer.send(&json!(["p", "begin", 0]), None);
        for _ in 0..2 {
            log.pointer.send(&json!(["p", "change", -0.3]), None);
        }
        // ln(0.7) = -0.357, twice: two steps out.
        assert_eq!(log.lines(), ["z 1", "z 1", "z -1", "z -1"]);
    }

    #[test]
    fn gestures_and_zoom_become_this_systems_shortcuts() {
        for platform in [Platform::Mac, Platform::Windows, Platform::Linux] {
            let log = logged(platform);
            for message in [
                json!(["g", 3, "up"]),
                json!(["z", 1]),
                json!(["g", 5, "up"]),
                json!(["g", 3, "sideways"]),
                json!(["z", 7]),
            ] {
                log.pointer.send(&message, None);
            }
            let got = log.lines();
            assert_eq!(got.len(), 2, "{got:?}");
            assert!(
                got.iter()
                    .all(|line| line.starts_with("k ") || line.starts_with("z ")),
                "{got:?}"
            );
        }
        let log = logged(Platform::Mac);
        log.pointer.send(&json!(["g", 3, "up"]), None);
        log.pointer.send(&json!(["z", 1]), None);
        log.pointer.send(&json!(["z", -1]), None);
        log.pointer.send(&json!(["g", 4, "pinch"]), None);
        assert_eq!(
            log.lines(),
            ["k 126 8650752", "k 24 1048576", "k 27 1048576", "app"]
        );
        let log = logged(Platform::Windows);
        log.pointer.send(&json!(["g", 3, "up"]), None);
        log.pointer.send(&json!(["g", 4, "left"]), None);
        log.pointer.send(&json!(["z", -1]), None);
        assert_eq!(log.lines(), ["k 91,9", "k 162,91,39", "z -1"]);
    }

    #[test]
    fn two_trackpads_each_let_go_only_of_what_they_hold() {
        let log = logged(Platform::Mac);
        let dragging = Some(next_owner());
        let other = Some(next_owner());
        assert_ne!(dragging, other);
        log.pointer.send(&json!(["d"]), dragging);
        log.pointer.release(other);
        assert_eq!(
            log.lines(),
            ["d"],
            "Another trackpad closing does not drop this one's drag"
        );
        log.pointer.release(dragging);
        assert_eq!(
            log.lines(),
            ["d", "u"],
            "The trackpad holding the button lets go of it on closing"
        );
    }

    #[test]
    fn a_trackpad_closing_mid_pinch_ends_the_pinch() {
        let log = logged(Platform::Mac);
        let pinching = Some(next_owner());
        log.pointer.send(&json!(["p", "begin", 0]), pinching);
        log.pointer.send(&json!(["p", "change", 0.1]), pinching);
        log.pointer.release(Some(next_owner()));
        assert_eq!(log.lines().len(), 2);
        log.pointer.release(pinching);
        assert_eq!(log.lines().last().map(String::as_str), Some("p 4 0.0000"));

        // Windows turns a pinch into zoom steps, so there is nothing left open to end.
        let log = logged(Platform::Windows);
        log.pointer.send(&json!(["p", "begin", 0]), pinching);
        log.pointer.send(&json!(["p", "change", 0.1]), pinching);
        log.pointer.release(pinching);
        assert!(log.lines().is_empty(), "{:?}", log.lines());
    }

    #[test]
    fn disposing_lets_go_of_everything() {
        let log = logged(Platform::Mac);
        log.pointer.send(&json!(["d"]), Some(next_owner()));
        log.pointer
            .send(&json!(["p", "begin", 0]), Some(next_owner()));
        log.pointer.dispose();
        assert_eq!(log.lines(), ["d", "p 1 0.0000", "u", "p 4 0.0000"]);
    }

    // --------------------------------- the whole path, with a recording sink

    type Seen = Arc<Mutex<Vec<Command>>>;

    struct Recording(Seen);

    impl PointerSink for Recording {
        fn run(&mut self, command: &Command) -> Result<(), String> {
            self.0.lock().expect("the list").push(command.clone());
            Ok(())
        }
        fn close(&mut self) {
            self.0.lock().expect("the list").push(Command::Launcher);
        }
    }

    #[test]
    fn commands_reach_the_sink_in_order_and_it_is_closed_at_the_end() {
        let seen: Seen = Arc::default();
        let for_sink = Arc::clone(&seen);
        let pointer = Pointer::with_opener(
            quiet(),
            Platform::Windows,
            Box::new(move || Ok(Box::new(Recording(Arc::clone(&for_sink))))),
        );
        let owner = Some(next_owner());
        pointer.send(&json!(["m", 1.4, -2.6]), owner);
        pointer.send(&json!(["nope"]), owner);
        pointer.send(&json!(["d"]), owner);
        pointer.send(&json!(["p", "begin", 0.5]), owner);
        pointer.dispose();
        // After dispose, nothing more is taken.
        pointer.send(&json!(["m", 1, 1]), owner);
        assert_eq!(
            *seen.lock().expect("the list"),
            [
                Command::Move { dx: 1, dy: -3 },
                Command::Down,
                Command::Zoom(1),
                // dispose: the button is let go (the pinch is not open on Windows
                // as far as the system knows, so only its count is cleared)…
                Command::Up,
                // …and the sink is closed (this recorder marks it so).
                Command::Launcher,
            ]
        );
    }

    // tests/trackpad.test.mjs, dyingHelper: the pointer that cannot be
    // reached while moves keep streaming in as fast as a finger sends them.
    // It must not be reached for again at every message, and the deck is
    // told once.
    #[test]
    fn a_pointer_that_keeps_failing_is_not_reopened_for_every_move() {
        let opened = Arc::new(Mutex::new(0u32));
        let problems: Arc<Mutex<Vec<Text>>> = Arc::default();
        let logs: Arc<Mutex<Vec<String>>> = Arc::default();
        let (count, told, logged) = (
            Arc::clone(&opened),
            Arc::clone(&problems),
            Arc::clone(&logs),
        );
        let options = Arc::new(PointerOptions {
            log: Box::new(move |line| logged.lock().expect("logs").push(line.to_string())),
            on_problem: Box::new(move |text| told.lock().expect("problems").push(text)),
        });
        let mut driver = Driver::new(
            Box::new(move || {
                *count.lock().expect("count") += 1;
                Err(OpenError::LinuxPermission)
            }),
            options,
        );
        let start = Instant::now();
        // Three seconds of twenty moves every 2 ms.
        for tick in 0..1500u64 {
            let now = start + Duration::from_millis(tick * 2);
            for _ in 0..20 {
                driver.run(&Command::Move { dx: 1, dy: 1 }, now);
            }
        }
        // At 0, 0.5, 1.5 s (and next at 3.5 s).
        assert_eq!(*opened.lock().expect("count"), 3);
        let problems = problems.lock().expect("problems");
        assert_eq!(problems.len(), 1, "…and the deck is told once");
        assert_eq!(problems[0].key, "server.pointer.linuxPermission");
        assert_eq!(logs.lock().expect("logs").len(), 1);
    }

    #[test]
    fn the_wait_grows_to_half_a_minute_and_a_working_pointer_resets_it() {
        let fail = Arc::new(Mutex::new(true));
        let opened = Arc::new(Mutex::new(0u32));
        let problems: Arc<Mutex<Vec<Text>>> = Arc::default();
        let (failing, count, told) = (
            Arc::clone(&fail),
            Arc::clone(&opened),
            Arc::clone(&problems),
        );
        let seen: Seen = Arc::default();
        let for_sink = Arc::clone(&seen);
        let options = Arc::new(PointerOptions {
            log: Box::new(|_| {}),
            on_problem: Box::new(move |text| told.lock().expect("problems").push(text)),
        });
        let mut driver = Driver::new(
            Box::new(move || {
                *count.lock().expect("count") += 1;
                if *failing.lock().expect("flag") {
                    Err(OpenError::Other("no display".to_string()))
                } else {
                    Ok(Box::new(Recording(Arc::clone(&for_sink))))
                }
            }),
            options,
        );
        let start = Instant::now();
        let step = Command::Down;
        // Ten minutes of a move a second: 0.5, 1, 2, 4, 8, 16, then every 30 s.
        for second in 0..600u64 {
            driver.run(&step, start + Duration::from_secs(second));
        }
        let tries = *opened.lock().expect("count");
        assert!((24..=27).contains(&tries), "{tries} tries");
        assert_eq!(problems.lock().expect("problems").len(), 1);
        assert_eq!(
            problems.lock().expect("problems")[0],
            say("server.trackpad.refused").with("reason", "no display")
        );

        *fail.lock().expect("flag") = false;
        driver.run(&step, start + Duration::from_secs(700));
        assert_eq!(*seen.lock().expect("the list"), [Command::Down]);
        // It works again: a later failure is tried again at once, and told again.
        driver.sink = None;
        *fail.lock().expect("flag") = true;
        driver.run(&step, start + Duration::from_secs(701));
        assert_eq!(*opened.lock().expect("count"), tries + 2);
        assert_eq!(problems.lock().expect("problems").len(), 2);
    }

    #[test]
    fn each_failure_to_open_has_its_own_words() {
        let told = |error: OpenError| {
            let problems: Arc<Mutex<Vec<Text>>> = Arc::default();
            let list = Arc::clone(&problems);
            let options = Arc::new(PointerOptions {
                log: Box::new(|_| {}),
                on_problem: Box::new(move |text| list.lock().expect("problems").push(text)),
            });
            let mut driver = Driver::new(Box::new(move || Err(error.clone())), options);
            driver.run(&Command::Up, Instant::now());
            let text = problems.lock().expect("problems")[0].clone();
            crate::i18n::english(&text.into())
        };
        assert!(told(OpenError::MacPermission).contains("Accessibility"));
        assert!(told(OpenError::LinuxPermission).contains("/dev/uinput"));
        assert!(told(OpenError::Unsupported).contains("trackpad"));
        assert_eq!(
            told(OpenError::Other("no XTEST".to_string())),
            "The computer refused the trackpad: no XTEST"
        );
    }

    // ------------------------------------------- macOS, as mac-pointer.js did

    #[derive(Default)]
    struct FakeMac {
        now: f64,
        at: Point,
        screens: Vec<Rect>,
        asked_for_screens: u32,
        posted: Vec<MacEvent>,
    }

    impl Default for Point {
        fn default() -> Point {
            Point { x: 0.0, y: 0.0 }
        }
    }

    impl MacSystem for FakeMac {
        fn now_ms(&mut self) -> f64 {
            self.now
        }
        fn location(&mut self) -> Result<Point, String> {
            Ok(self.at)
        }
        fn displays(&mut self) -> Vec<Rect> {
            self.asked_for_screens += 1;
            self.screens.clone()
        }
        fn post(&mut self, event: MacEvent) -> Result<(), String> {
            // The cursor goes where a mouse event puts it.
            if let MacEvent::Mouse { at, .. } = event {
                self.at = at;
            }
            self.posted.push(event);
            Ok(())
        }
    }

    fn mac_at(x: f64, y: f64) -> MacPointer<FakeMac> {
        MacPointer::new(FakeMac {
            now: 1_000_000.0,
            at: Point { x, y },
            // A 1440×900 main display with a 1920×1080 one to its right.
            screens: vec![
                Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 1440.0,
                    h: 900.0,
                },
                Rect {
                    x: 1440.0,
                    y: -100.0,
                    w: 1920.0,
                    h: 1080.0,
                },
            ],
            ..FakeMac::default()
        })
    }

    fn mouse(kind: MouseKind, x: f64, y: f64, button: u8, clicks: i64) -> MacEvent {
        MacEvent::Mouse {
            kind,
            at: Point { x, y },
            button,
            clicks,
        }
    }

    fn take(pointer: &mut MacPointer<FakeMac>) -> Vec<MacEvent> {
        std::mem::take(&mut pointer.system.posted)
    }

    #[test]
    fn a_move_goes_from_where_the_cursor_is_and_stays_on_a_display() {
        let mut pointer = mac_at(100.0, 100.0);
        pointer
            .run(&Command::Move { dx: 12, dy: -4 })
            .expect("moved");
        assert_eq!(
            take(&mut pointer),
            [mouse(MouseKind::Moved, 112.0, 96.0, 0, 0)]
        );
        // Off the top left: held at the edge of the display it is on.
        pointer
            .run(&Command::Move { dx: -400, dy: -400 })
            .expect("moved");
        assert_eq!(
            take(&mut pointer),
            [mouse(MouseKind::Moved, 0.0, 0.0, 0, 0)]
        );
        // Across to the display on the right.
        pointer.system.at = Point { x: 1430.0, y: 50.0 };
        pointer
            .run(&Command::Move { dx: 30, dy: 0 })
            .expect("moved");
        assert_eq!(
            take(&mut pointer),
            [mouse(MouseKind::Moved, 1460.0, 50.0, 0, 0)]
        );
        // Off the bottom of the main display, where there is none below: its last row.
        pointer.system.at = Point { x: 700.0, y: 890.0 };
        pointer
            .run(&Command::Move { dx: 0, dy: 400 })
            .expect("moved");
        assert_eq!(
            take(&mut pointer),
            [mouse(MouseKind::Moved, 700.0, 899.0, 0, 0)]
        );
        // The displays were asked for once: the list is trusted for 2 s.
        assert_eq!(pointer.system.asked_for_screens, 1);
        pointer.system.now += 2000.0;
        pointer.run(&Command::Move { dx: 1, dy: 1 }).expect("moved");
        assert_eq!(pointer.system.asked_for_screens, 2);
    }

    #[test]
    fn with_no_display_known_a_move_is_not_held_back() {
        let mut pointer = mac_at(10.0, 10.0);
        pointer.system.screens.clear();
        pointer
            .run(&Command::Move { dx: -400, dy: 0 })
            .expect("moved");
        assert_eq!(
            take(&mut pointer),
            [mouse(MouseKind::Moved, -390.0, 10.0, 0, 0)]
        );
    }

    #[test]
    fn a_press_drags_until_its_release() {
        let mut pointer = mac_at(300.0, 300.0);
        pointer.run(&Command::Down).expect("pressed");
        pointer
            .run(&Command::Move { dx: 10, dy: 5 })
            .expect("moved");
        pointer.run(&Command::Up).expect("released");
        pointer.run(&Command::Move { dx: 1, dy: 1 }).expect("moved");
        assert_eq!(
            take(&mut pointer),
            [
                // A move to the very spot, then the press there.
                mouse(MouseKind::Moved, 300.0, 300.0, 0, 0),
                mouse(MouseKind::LeftDown, 300.0, 300.0, 0, 1),
                mouse(MouseKind::LeftDragged, 310.0, 305.0, 0, 0),
                mouse(MouseKind::LeftUp, 310.0, 305.0, 0, 1),
                mouse(MouseKind::Moved, 311.0, 306.0, 0, 0),
            ]
        );
    }

    #[test]
    fn a_click_holds_the_button_for_a_moment() {
        let mut pointer = mac_at(50.0, 60.0);
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(
            take(&mut pointer),
            [
                mouse(MouseKind::Moved, 50.0, 60.0, 0, 0),
                mouse(MouseKind::LeftDown, 50.0, 60.0, 0, 1),
                MacEvent::Hold(Duration::from_millis(20)),
                mouse(MouseKind::LeftUp, 50.0, 60.0, 0, 1),
            ]
        );
        pointer.system.now += 5000.0;
        pointer
            .run(&Command::Click(Button::Right))
            .expect("clicked");
        assert_eq!(
            take(&mut pointer),
            [
                mouse(MouseKind::Moved, 50.0, 60.0, 0, 0),
                mouse(MouseKind::RightDown, 50.0, 60.0, 1, 1),
                MacEvent::Hold(Duration::from_millis(20)),
                mouse(MouseKind::RightUp, 50.0, 60.0, 1, 1),
            ]
        );
    }

    fn click_counts(events: &[MacEvent]) -> Vec<i64> {
        events
            .iter()
            .filter_map(|event| match event {
                MacEvent::Mouse {
                    kind: MouseKind::LeftDown | MouseKind::LeftUp,
                    clicks,
                    ..
                } => Some(*clicks),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_press_soon_after_the_last_at_the_same_spot_is_a_double_click() {
        // A double tap from a deck: the first tap's press, its release
        // later, then a click.
        let mut pointer = mac_at(200.0, 200.0);
        pointer.run(&Command::Down).expect("pressed");
        pointer.system.now += 300.0;
        pointer.run(&Command::Up).expect("released");
        pointer.system.now += 200.0;
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(click_counts(&take(&mut pointer)), [1, 1, 2, 2]);
        // A third in time is a triple click.
        pointer.system.now += 549.0;
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(click_counts(&take(&mut pointer)), [3, 3]);
        // Too late: a new series.
        pointer.system.now += 550.0;
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(click_counts(&take(&mut pointer)), [1, 1]);
        // In time, but more than 6 points away: a new series too.
        pointer.system.now += 100.0;
        pointer.system.at = Point { x: 207.0, y: 200.0 };
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(click_counts(&take(&mut pointer)), [1, 1]);
        // Six points away still counts.
        pointer.system.now += 100.0;
        pointer.system.at = Point { x: 213.0, y: 194.0 };
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(click_counts(&take(&mut pointer)), [2, 2]);
        // A right click neither counts nor resets the series.
        pointer.system.now += 100.0;
        pointer
            .run(&Command::Click(Button::Right))
            .expect("clicked");
        pointer.system.now += 100.0;
        pointer.run(&Command::Click(Button::Left)).expect("clicked");
        assert_eq!(click_counts(&take(&mut pointer)), [3, 3]);
    }

    #[test]
    fn scroll_is_in_pixels_vertical_first() {
        let mut pointer = mac_at(0.0, 0.0);
        pointer
            .run(&Command::Scroll { dx: -7, dy: 30 })
            .expect("scrolled");
        assert_eq!(
            take(&mut pointer),
            [MacEvent::Scroll {
                vertical: 30,
                horizontal: -7
            }]
        );
    }

    #[test]
    fn a_shortcut_presses_its_modifiers_as_keys() {
        let mut pointer = mac_at(0.0, 0.0);
        let key = |code, down, flags| MacEvent::Key { code, down, flags };
        // Mission Control: Ctrl+Up, the arrow carrying fn.
        let command = pointer_command(&json!(["g", 3, "up"]), Platform::Mac).expect("a gesture");
        pointer.run(&command).expect("typed");
        assert_eq!(
            take(&mut pointer),
            [
                key(59, true, 0x40000),
                key(126, true, 0x840000),
                key(126, false, 0x840000),
                key(59, false, 0),
            ]
        );
        // Look Up: Ctrl+Cmd+D, control first, command last, released in reverse.
        let command = pointer_command(&json!(["g", 3, "tap"]), Platform::Mac).expect("a gesture");
        pointer.run(&command).expect("typed");
        assert_eq!(
            take(&mut pointer),
            [
                key(59, true, 0x40000),
                key(55, true, 0x140000),
                key(2, true, 0x140000),
                key(2, false, 0x140000),
                key(55, false, 0x40000),
                key(59, false, 0),
            ]
        );
        // Show Desktop: F11 alone.
        let command =
            pointer_command(&json!(["g", 4, "spread"]), Platform::Mac).expect("a gesture");
        pointer.run(&command).expect("typed");
        assert_eq!(take(&mut pointer), [key(103, true, 0), key(103, false, 0)]);
        // Zoom: Cmd and =.
        let command = pointer_command(&json!(["z", 1]), Platform::Mac).expect("zoom");
        pointer.run(&command).expect("typed");
        assert_eq!(
            take(&mut pointer),
            [
                key(55, true, 0x100000),
                key(24, true, 0x100000),
                key(24, false, 0x100000),
                key(55, false, 0),
            ]
        );
        // The launcher is opened, not typed.
        let command = pointer_command(&json!(["g", 4, "pinch"]), Platform::Mac).expect("a gesture");
        pointer.run(&command).expect("opened");
        assert_eq!(take(&mut pointer), [MacEvent::Launcher]);
    }

    #[test]
    fn a_pinch_is_a_magnify_gesture_with_the_lines_four_decimals() {
        let mut pointer = mac_at(0.0, 0.0);
        for message in [
            json!(["p", "begin", 0]),
            json!(["p", "change", 0.123449]),
            json!(["p", "change", 7]),
            json!(["p", "end", 0]),
        ] {
            let command = pointer_command(&message, Platform::Mac).expect("a pinch");
            pointer.run(&command).expect("pinched");
        }
        let magnify = |phase, magnification| MacEvent::Magnify {
            phase,
            magnification,
        };
        assert_eq!(
            take(&mut pointer),
            [
                magnify(1, 0.0),
                magnify(2, 0.1234),
                magnify(2, 0.5),
                magnify(4, 0.0)
            ]
        );
        assert_eq!(
            (
                mac_gesture_fields::EVENT_TYPE,
                mac_gesture_fields::FLAGS,
                mac_gesture_fields::FIELD_KIND,
                mac_gesture_fields::FIELD_MAGNIFICATION,
                mac_gesture_fields::FIELD_PHASE,
                mac_gesture_fields::KIND_MAGNIFY
            ),
            (29, 0x100, 110, 113, 132, 8)
        );
    }

    #[test]
    fn closing_leaves_nothing_held() {
        let mut pointer = mac_at(40.0, 40.0);
        pointer.run(&Command::Down).expect("pressed");
        let begin = pointer_command(&json!(["p", "begin", 0]), Platform::Mac).expect("a pinch");
        pointer.run(&begin).expect("pinched");
        take(&mut pointer);
        pointer.close();
        assert_eq!(
            take(&mut pointer),
            [
                mouse(MouseKind::LeftUp, 40.0, 40.0, 0, 1),
                MacEvent::Magnify {
                    phase: 4,
                    magnification: 0.0
                }
            ]
        );
        pointer.close();
        assert!(take(&mut pointer).is_empty());
    }

    // --------------------------------------- Windows, as WINDOWS_POINTER did

    fn win(message: Value) -> Vec<WinInput> {
        let command = pointer_command(&message, Platform::Windows).expect("a command");
        windows_inputs(&command)
    }

    // Replaces reading the C# of WINDOWS_POINTER: the same calls, as data.
    #[test]
    fn windows_is_given_what_the_powershell_loop_gave_it() {
        let mouse = |flags, dx, dy, data| WinInput::Mouse {
            flags,
            dx,
            dy,
            data,
        };
        let key = |vk, flags| WinInput::Key { vk, flags };
        assert_eq!(win(json!(["m", 12, -4])), [mouse(0x0001, 12, -4, 0)]);
        // Wheel units: three to a pixel, vertical then horizontal, right is positive.
        assert_eq!(
            win(json!(["s", 5, 30])),
            [mouse(0x0800, 0, 0, 90), mouse(0x1000, 0, 0, -15)]
        );
        assert_eq!(win(json!(["s", 0, -2])), [mouse(0x0800, 0, 0, -6)]);
        assert_eq!(win(json!(["s", -1, 0])), [mouse(0x1000, 0, 0, 3)]);
        assert_eq!(win(json!(["s", 0, 0])), []);
        assert_eq!(
            win(json!(["c", "left"])),
            [mouse(0x0002, 0, 0, 0), mouse(0x0004, 0, 0, 0)]
        );
        assert_eq!(
            win(json!(["c", "right"])),
            [mouse(0x0008, 0, 0, 0), mouse(0x0010, 0, 0, 0)]
        );
        assert_eq!(win(json!(["d"])), [mouse(0x0002, 0, 0, 0)]);
        assert_eq!(win(json!(["u"])), [mouse(0x0004, 0, 0, 0)]);
        // Zoom: left Ctrl down, a notch, left Ctrl up.
        assert_eq!(
            win(json!(["z", -1])),
            [key(0xa2, 0), mouse(0x0800, 0, 0, -120), key(0xa2, 2)]
        );
        // Task View: Win (an extended key) and Tab, released in reverse.
        assert_eq!(
            win(json!(["g", 3, "up"])),
            [key(0x5b, 1), key(0x09, 0), key(0x09, 2), key(0x5b, 3)]
        );
        // The previous app: Alt, Shift, Tab, none of them extended (no AltGr).
        assert_eq!(
            win(json!(["g", 3, "right"])),
            [
                key(0xa4, 0),
                key(0xa0, 0),
                key(0x09, 0),
                key(0x09, 2),
                key(0xa0, 2),
                key(0xa4, 2)
            ]
        );
        // The desktop to the right: Ctrl, Win, Right (the arrow is extended).
        assert_eq!(
            win(json!(["g", 4, "left"])),
            [
                key(0xa2, 0),
                key(0x5b, 1),
                key(0x27, 1),
                key(0x27, 3),
                key(0x5b, 3),
                key(0xa2, 2)
            ]
        );
    }

    #[test]
    fn only_the_keys_windows_calls_extended_are_flagged() {
        let extended: Vec<u8> = (0..=255u8).filter(|vk| win_extended(*vk)).collect();
        let mut wanted: Vec<u8> = vec![0x5b, 0x5c, 0x2d, 0x2e];
        wanted.extend(0x21..=0x28);
        wanted.extend(0xad..=0xb7);
        wanted.sort();
        assert_eq!(extended, wanted);
    }

    // ------------------------------------------------------------- Linux

    #[test]
    fn linux_is_given_the_same_things_in_its_own_terms() {
        let mut planner = LinuxPlanner::default();
        let mut plan = |message: Value| {
            let command = pointer_command(&message, Platform::Linux).expect("a command");
            planner.events(&command)
        };
        let key = |code, down| LinuxEvent::Key { code, down };
        let button = |button, down| LinuxEvent::Button { button, down };
        assert_eq!(
            plan(json!(["m", 12, -4])),
            [LinuxEvent::Motion { dx: 12, dy: -4 }]
        );
        assert_eq!(
            plan(json!(["c", "left"])),
            [button(Button::Left, true), button(Button::Left, false)]
        );
        assert_eq!(
            plan(json!(["c", "right"])),
            [button(Button::Right, true), button(Button::Right, false)]
        );
        assert_eq!(plan(json!(["d"])), [button(Button::Left, true)]);
        assert_eq!(plan(json!(["u"])), [button(Button::Left, false)]);
        assert_eq!(
            plan(json!(["z", 1])),
            [
                key(29, true),
                LinuxEvent::Wheel {
                    vertical: 120,
                    horizontal: 0,
                    vertical_notches: 1,
                    horizontal_notches: 0
                },
                key(29, false)
            ]
        );
        assert_eq!(
            plan(json!(["g", 3, "right"])),
            [
                key(56, true),
                key(42, true),
                key(15, true),
                key(15, false),
                key(42, false),
                key(56, false)
            ]
        );
        assert_eq!(linux_button_code(Button::Left), 0x110);
        assert_eq!(linux_button_code(Button::Right), 0x111);
    }

    #[test]
    fn scrolling_adds_up_to_whole_notches() {
        let mut planner = LinuxPlanner::default();
        let mut notches = Vec::new();
        let mut units = 0;
        // 15 pixels up at a time: 45 units each, a notch at 120.
        for _ in 0..8 {
            for event in planner.events(&Command::Scroll { dx: 0, dy: 15 }) {
                let LinuxEvent::Wheel {
                    vertical,
                    horizontal,
                    vertical_notches,
                    horizontal_notches,
                } = event
                else {
                    panic!("{event:?}");
                };
                assert_eq!((horizontal, horizontal_notches), (0, 0));
                units += vertical;
                notches.push(vertical_notches);
            }
        }
        assert_eq!(units, 360);
        assert_eq!(notches, [0, 0, 1, 0, 0, 1, 0, 1]);
        // Down and to the right: negative vertical, positive horizontal.
        let mut planner = LinuxPlanner::default();
        assert_eq!(
            planner.events(&Command::Scroll { dx: -40, dy: -100 }),
            [LinuxEvent::Wheel {
                vertical: -300,
                horizontal: 120,
                vertical_notches: -2,
                horizontal_notches: 1
            }]
        );
        assert_eq!(planner.events(&Command::Scroll { dx: 0, dy: 0 }), []);
        // The rest of that scroll (60 units down) is still owed.
        assert_eq!(
            planner.events(&Command::Scroll { dx: 0, dy: -20 }),
            [LinuxEvent::Wheel {
                vertical: -60,
                horizontal: 0,
                vertical_notches: -1,
                horizontal_notches: 0
            }]
        );
    }
}
