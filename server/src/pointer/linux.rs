//! Linux: the pointer's events through XTest on an X11 session, or a
//! virtual mouse on /dev/uinput on Wayland. Only system calls live here;
//! `LinuxPlanner` in `pointer/mod.rs` decides which events.
use evdev::uinput::VirtualDevice;
use evdev::{EventType, InputEvent, RelativeAxisCode};

use super::{
    linux_button_code, linux_pointer_keys, Button, Command, LinuxEvent, LinuxPlanner, OpenError,
    PointerSink,
};
use crate::keys::linux::{
    key_event, open_uinput, session, OpenFailure, Session, XTest, X_BUTTON_PRESS, X_BUTTON_RELEASE,
    X_MOTION,
};

enum Door {
    X(XTest),
    Uinput(Box<VirtualDevice>),
}

struct Sink {
    planner: LinuxPlanner,
    door: Door,
}

/// The pointer of this session, or why it cannot be reached.
pub(super) fn open() -> Result<Box<dyn PointerSink>, OpenError> {
    let door = match session() {
        Session::X11 => XTest::open().map(Door::X),
        Session::Wayland => open_uinput(
            "Punchboard trackpad",
            &linux_pointer_keys(),
            &[
                RelativeAxisCode::REL_X,
                RelativeAxisCode::REL_Y,
                RelativeAxisCode::REL_WHEEL,
                RelativeAxisCode::REL_HWHEEL,
                RelativeAxisCode::REL_WHEEL_HI_RES,
                RelativeAxisCode::REL_HWHEEL_HI_RES,
            ],
        )
        .map(|device| Door::Uinput(Box::new(device))),
    }
    .map_err(|failure| match failure {
        OpenFailure::Permission => OpenError::LinuxPermission,
        OpenFailure::Other(reason) => OpenError::Other(reason),
    })?;
    Ok(Box::new(Sink {
        planner: LinuxPlanner::default(),
        door,
    }))
}

/// X11's pointer buttons: 1 left, 3 right; the wheel is 4 up, 5 down, 6
/// left, 7 right, a press and release for every notch.
fn x_button(button: Button) -> u8 {
    match button {
        Button::Left => 1,
        Button::Right => 3,
    }
}

fn x_wheel(x: &XTest, notches: i32, positive: u8, negative: u8) -> Result<(), String> {
    let button = if notches > 0 { positive } else { negative };
    for _ in 0..notches.unsigned_abs() {
        x.fake(X_BUTTON_PRESS, button, 0, 0)?;
        x.fake(X_BUTTON_RELEASE, button, 0, 0)?;
    }
    Ok(())
}

fn to_x(x: &XTest, event: LinuxEvent) -> Result<(), String> {
    match event {
        LinuxEvent::Motion { dx, dy } => {
            // Detail 1: relative to where the pointer is. A move is capped
            // at 400 long before it reaches here.
            let clamp = |value: i32| value.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
            x.fake(X_MOTION, 1, clamp(dx), clamp(dy))
        }
        LinuxEvent::Button { button, down } => {
            let kind = if down {
                X_BUTTON_PRESS
            } else {
                X_BUTTON_RELEASE
            };
            x.fake(kind, x_button(button), 0, 0)
        }
        LinuxEvent::Key { code, down } => x.key(code, down),
        LinuxEvent::Wheel {
            vertical_notches,
            horizontal_notches,
            ..
        } => {
            x_wheel(x, vertical_notches, 4, 5)?;
            x_wheel(x, horizontal_notches, 7, 6)
        }
    }
}

fn relative(axis: RelativeAxisCode, value: i32) -> InputEvent {
    InputEvent::new(EventType::RELATIVE.0, axis.0, value)
}

/// One batch for the virtual device, which ends it with a report itself.
fn to_uinput(device: &mut VirtualDevice, event: LinuxEvent) -> Result<(), String> {
    let mut batch: Vec<InputEvent> = Vec::new();
    match event {
        LinuxEvent::Motion { dx, dy } => {
            batch.push(relative(RelativeAxisCode::REL_X, dx));
            batch.push(relative(RelativeAxisCode::REL_Y, dy));
        }
        LinuxEvent::Button { button, down } => {
            batch.push(key_event(linux_button_code(button), down))
        }
        LinuxEvent::Key { code, down } => batch.push(key_event(code, down)),
        LinuxEvent::Wheel {
            vertical,
            horizontal,
            vertical_notches,
            horizontal_notches,
        } => {
            let axes = [
                (RelativeAxisCode::REL_WHEEL_HI_RES, vertical),
                (RelativeAxisCode::REL_WHEEL, vertical_notches),
                (RelativeAxisCode::REL_HWHEEL_HI_RES, horizontal),
                (RelativeAxisCode::REL_HWHEEL, horizontal_notches),
            ];
            for (axis, value) in axes {
                if value != 0 {
                    batch.push(relative(axis, value));
                }
            }
        }
    }
    if batch.is_empty() {
        return Ok(());
    }
    device.emit(&batch).map_err(|error| error.to_string())
}

impl PointerSink for Sink {
    fn run(&mut self, command: &Command) -> Result<(), String> {
        let events = self.planner.events(command);
        match &mut self.door {
            Door::X(x) => {
                // Everything is queued whatever happened before it, so a
                // key is never left held down.
                let mut failure = None;
                for event in events {
                    if let Err(reason) = to_x(x, event) {
                        failure.get_or_insert(reason);
                    }
                }
                let flushed = x.flush();
                failure.map_or(flushed, Err)
            }
            Door::Uinput(device) => {
                let mut failure = None;
                for event in events {
                    if let Err(reason) = to_uinput(device, event) {
                        failure.get_or_insert(reason);
                    }
                }
                failure.map_or(Ok(()), Err)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Really moves this computer's cursor a little and back: run it by
    /// hand, in a session.
    ///   cargo test manual_moves_the_real_pointer -- --ignored
    #[test]
    #[ignore = "posts real pointer events"]
    fn manual_moves_the_real_pointer() {
        let mut pointer = open().expect("a pointer");
        pointer
            .run(&Command::Move { dx: 20, dy: 10 })
            .expect("moved");
        pointer
            .run(&Command::Move { dx: -20, dy: -10 })
            .expect("moved back");
    }
}
