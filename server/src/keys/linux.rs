//! Linux: key events through XTest on an X11 session, or a virtual keyboard
//! on /dev/uinput on Wayland (where no program may inject into another's
//! session, but the kernel takes a new input device from an account allowed
//! to open /dev/uinput). Only system calls live here; which events to send is
//! decided in `keys/mod.rs`. The pointer (`pointer/linux.rs`) uses the same
//! two doors.
use std::io;
use std::sync::Mutex;
use std::time::Duration;

use evdev::uinput::VirtualDevice;
use evdev::{AttributeSet, EventType, InputEvent, KeyCode, RelativeAxisCode};
use x11rb::connection::Connection;
use x11rb::protocol::xtest::ConnectionExt;
use x11rb::rust_connection::RustConnection;

use super::{
    KeyEvent, KeyFailure, LINUX_CODES, LINUX_MEDIA, LINUX_MODIFIER_CODES, X11_KEYCODE_OFFSET,
};

/// Which of the two doors this session has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Session {
    X11,
    Wayland,
}

/// Wayland when WAYLAND_DISPLAY is set, or when there is no DISPLAY to
/// reach an X server through (a console, a service): the virtual device
/// works in all of those.
pub(crate) fn session_from(wayland: Option<&str>, display: Option<&str>) -> Session {
    let set = |value: Option<&str>| value.is_some_and(|text| !text.is_empty());
    if set(wayland) || !set(display) {
        Session::Wayland
    } else {
        Session::X11
    }
}

pub(crate) fn session() -> Session {
    session_from(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("DISPLAY").ok().as_deref(),
    )
}

/// Why neither door opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum OpenFailure {
    /// This account may not open /dev/uinput.
    Permission,
    Other(String),
}

// XTest's FakeInput takes the core protocol's event numbers.
pub(crate) const X_KEY_PRESS: u8 = 2;
pub(crate) const X_KEY_RELEASE: u8 = 3;
pub(crate) const X_BUTTON_PRESS: u8 = 4;
pub(crate) const X_BUTTON_RELEASE: u8 = 5;
pub(crate) const X_MOTION: u8 = 6;

/// A connection to the X server with the XTEST extension checked.
pub(crate) struct XTest {
    /// Boxed: a connection is several hundred bytes, and this sits in an enum.
    connection: Box<RustConnection>,
}

impl XTest {
    pub(crate) fn open() -> Result<XTest, OpenFailure> {
        let other = |error: &dyn std::fmt::Display| OpenFailure::Other(error.to_string());
        let (connection, _screen) = x11rb::connect(None).map_err(|error| other(&error))?;
        connection
            .xtest_get_version(2, 2)
            .map_err(|error| other(&error))?
            .reply()
            .map_err(|_| OpenFailure::Other("The X server has no XTEST extension.".to_string()))?;
        Ok(XTest {
            connection: Box::new(connection),
        })
    }

    /// One fake event; `detail` is a keycode, a button, or 1 for a motion
    /// that is relative to where the pointer is.
    pub(crate) fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> Result<(), String> {
        self.connection
            .xtest_fake_input(kind, detail, x11rb::CURRENT_TIME, x11rb::NONE, x, y, 0)
            .map(drop)
            .map_err(|error| error.to_string())
    }

    pub(crate) fn key(&self, code: u16, down: bool) -> Result<(), String> {
        let keycode = u8::try_from(code + X11_KEYCODE_OFFSET)
            .map_err(|_| format!("X11 has no keycode for key {code}."))?;
        self.fake(
            if down { X_KEY_PRESS } else { X_KEY_RELEASE },
            keycode,
            0,
            0,
        )
    }

    /// Sends what has been queued.
    pub(crate) fn flush(&self) -> Result<(), String> {
        self.connection.flush().map_err(|error| error.to_string())
    }
}

/// How long a compositor is given to notice a new device before its first
/// event; sooner, and that event is lost.
const SETTLE: Duration = Duration::from_millis(300);

/// A virtual device on /dev/uinput with these keys, and a mouse's axes and
/// buttons when `axes` is not empty.
pub(crate) fn open_uinput(
    name: &str,
    keys: &[u16],
    axes: &[RelativeAxisCode],
) -> Result<VirtualDevice, OpenFailure> {
    let failure = |error: io::Error| {
        if error.kind() == io::ErrorKind::PermissionDenied {
            OpenFailure::Permission
        } else {
            OpenFailure::Other(format!("/dev/uinput: {error}"))
        }
    };
    let mut key_set = AttributeSet::<KeyCode>::new();
    for code in keys {
        key_set.insert(KeyCode::new(*code));
    }
    let mut builder = VirtualDevice::builder()
        .map_err(failure)?
        .name(name)
        .with_keys(&key_set)
        .map_err(failure)?;
    if !axes.is_empty() {
        let mut axis_set = AttributeSet::<RelativeAxisCode>::new();
        for axis in axes {
            axis_set.insert(*axis);
        }
        builder = builder.with_relative_axes(&axis_set).map_err(failure)?;
    }
    let device = builder.build().map_err(failure)?;
    std::thread::sleep(SETTLE);
    Ok(device)
}

pub(crate) fn key_event(code: u16, down: bool) -> InputEvent {
    InputEvent::new(EventType::KEY.0, code, i32::from(down))
}

/// Where this session's keys go.
enum Keyboard {
    X(XTest),
    Uinput(Box<VirtualDevice>),
}

impl Keyboard {
    fn open() -> Result<Keyboard, OpenFailure> {
        match session() {
            Session::X11 => XTest::open().map(Keyboard::X),
            Session::Wayland => {
                let codes: Vec<u16> = LINUX_CODES
                    .iter()
                    .map(|entry| entry.1)
                    .chain(LINUX_MODIFIER_CODES.iter().map(|entry| entry.1))
                    .chain(LINUX_MEDIA.iter().map(|entry| entry.1))
                    .collect();
                open_uinput("Punchboard keyboard", &codes, &[])
                    .map(|device| Keyboard::Uinput(Box::new(device)))
            }
        }
    }

    fn key(&mut self, code: u16, down: bool) -> Result<(), String> {
        match self {
            Keyboard::X(x) => x.key(code, down).and_then(|()| x.flush()),
            Keyboard::Uinput(device) => device
                .emit(&[key_event(code, down)])
                .map_err(|error| error.to_string()),
        }
    }
}

/// Opened at the first key and kept, like the helper the Node companion
/// kept running on Windows: a new virtual keyboard takes the compositor a
/// moment to notice, too long to wait at every press.
static KEYBOARD: Mutex<Option<Keyboard>> = Mutex::new(None);

pub(crate) fn send(events: &[KeyEvent]) -> Result<(), KeyFailure> {
    let mut held = KEYBOARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if held.is_none() {
        *held = Some(Keyboard::open().map_err(|failure| match failure {
            OpenFailure::Permission => KeyFailure::LinuxPermission,
            OpenFailure::Other(reason) => KeyFailure::Other(reason),
        })?);
    }
    let Some(keyboard) = held.as_mut() else {
        return Ok(());
    };
    // Everything is sent whatever happened before it, so a modifier is never
    // left held down; the first failure is the one reported.
    let mut failure: Option<String> = None;
    for event in events {
        match *event {
            KeyEvent::Evdev { code, down } => {
                if let Err(reason) = keyboard.key(code, down) {
                    failure.get_or_insert(reason);
                }
            }
            KeyEvent::Wait { ms } => std::thread::sleep(Duration::from_millis(ms)),
            // Other systems' events are never planned for this one.
            KeyEvent::Mac { .. }
            | KeyEvent::MacMedia { .. }
            | KeyEvent::Scan { .. }
            | KeyEvent::Virtual { .. } => {}
        }
    }
    match failure {
        None => Ok(()),
        Some(reason) => {
            // The X server or the device went away: open it again next time.
            *held = None;
            Err(KeyFailure::Other(reason))
        }
    }
}

/// Closes the X connection or removes the virtual keyboard.
pub(crate) fn stop() {
    *KEYBOARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{combo_events, Platform};
    use crate::model::keys::parse_combo;

    #[test]
    fn the_session_decides_which_door() {
        assert_eq!(
            session_from(Some("wayland-0"), Some(":0")),
            Session::Wayland
        );
        assert_eq!(session_from(Some("wayland-0"), None), Session::Wayland);
        assert_eq!(session_from(None, Some(":0")), Session::X11);
        assert_eq!(session_from(Some(""), Some(":1")), Session::X11);
        assert_eq!(session_from(None, None), Session::Wayland);
        assert_eq!(session_from(None, Some("")), Session::Wayland);
    }

    /// Really presses F13 on this computer: run it by hand, in a session.
    ///   cargo test manual_presses_a_real_key -- --ignored
    #[test]
    #[ignore = "posts a real key event"]
    fn manual_presses_a_real_key() {
        let combo = parse_combo("f13").expect("a combination");
        let events = combo_events(&combo, Platform::Linux).expect("planned");
        send(&events).expect("sent");
        stop();
    }
}
