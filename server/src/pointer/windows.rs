//! Windows: the pointer's events through SendInput (the PowerShell loop
//! before called user32's mouse_event and keybd_event, which SendInput
//! replaced). Only system calls live here; `windows_inputs` in
//! `pointer/mod.rs` decides which events.
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT, MOUSE_EVENT_FLAGS,
};

use super::{windows_inputs, Command, OpenError, PointerSink, WinInput};
use crate::keys::windows::{keyboard_input, post};

struct Sink;

/// Nothing to open and no permission to ask for on Windows.
pub(super) fn open() -> Result<Box<dyn PointerSink>, OpenError> {
    Ok(Box::new(Sink))
}

fn input(event: WinInput) -> INPUT {
    match event {
        WinInput::Mouse {
            flags,
            dx,
            dy,
            data,
        } => INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx,
                    dy,
                    // A wheel amount is signed; the field carries its bits.
                    mouseData: data as u32,
                    dwFlags: MOUSE_EVENT_FLAGS(flags),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        WinInput::Key { vk, flags } => keyboard_input(u16::from(vk), 0, flags),
    }
}

impl PointerSink for Sink {
    /// One call per event, as before. Windows does not say why it drops
    /// one (a locked screen, an app run as administrator in front), and a
    /// finger's next move is already on its way, so nothing is reported.
    fn run(&mut self, command: &Command) -> Result<(), String> {
        for event in windows_inputs(command) {
            post(&[input(event)]);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Really moves this computer's cursor a little and back: run it by hand.
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
