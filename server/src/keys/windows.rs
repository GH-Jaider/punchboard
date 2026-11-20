//! Windows: key events through SendInput. Only system calls live here;
//! which events to send is decided in `keys/mod.rs`.
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, VIRTUAL_KEY,
};

use super::{KeyEvent, KeyFailure, KeySink};

/// One keyboard event as SendInput takes it. INPUT holds a union of the
/// mouse, keyboard and hardware events, so its size is the real one whatever
/// kind it carries (the C# before had to declare the mouse one for that).
pub(crate) fn keyboard_input(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(vk),
                wScan: scan,
                dwFlags: KEYBD_EVENT_FLAGS(flags),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Hands Windows a batch of events and says how many it took.
pub(crate) fn post(inputs: &[INPUT]) -> u32 {
    if inputs.is_empty() {
        return 0;
    }
    // SAFETY: the slice is valid for the call and the size is INPUT's own.
    unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) }
}

pub(crate) struct Sink;

impl KeySink for Sink {
    /// The events up to a pause go in one call, the ones after it in
    /// another. Every batch is sent whatever happened to the one before, so
    /// a modifier is never left held down.
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure> {
        let mut batch: Vec<INPUT> = Vec::new();
        // Scan codes are counted; a music key, like keybd_event before, is not.
        let mut wanted: u32 = 0;
        let mut taken: u32 = 0;
        let mut counted = false;
        let mut flush = |batch: &mut Vec<INPUT>, counted: &mut bool| {
            let sent = post(batch);
            if *counted {
                taken += sent;
            }
            batch.clear();
            *counted = false;
        };
        for event in events {
            match *event {
                KeyEvent::Scan { scan, flags } => {
                    batch.push(keyboard_input(0, scan, flags));
                    wanted += 1;
                    counted = true;
                }
                KeyEvent::Virtual { vk, flags } => {
                    // Each on its own, as two keybd_event calls were.
                    flush(&mut batch, &mut counted);
                    post(&[keyboard_input(u16::from(vk), 0, flags)]);
                }
                KeyEvent::Wait { ms } => {
                    flush(&mut batch, &mut counted);
                    std::thread::sleep(Duration::from_millis(ms));
                }
                // Other systems' events are never planned for this one.
                KeyEvent::Mac { .. } | KeyEvent::MacMedia { .. } | KeyEvent::Evdev { .. } => {}
            }
        }
        flush(&mut batch, &mut counted);
        if taken != wanted {
            // SendInput does not say why it refused; a locked screen or an app run as
            // administrator in front are the usual reasons.
            return Err(KeyFailure::Other(format!(
                "Windows took {taken} of {wanted} key events: is the screen locked, or an app running as administrator in front?"
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{combo_events, Platform};
    use crate::model::keys::parse_combo;

    // What the C#'s Size and "The C# declares the mouse event too, so INPUT
    // has its real size" guarded: the size SendInput is told.
    #[test]
    fn input_has_its_real_size() {
        let expected = if cfg!(target_pointer_width = "64") {
            40
        } else {
            28
        };
        assert_eq!(std::mem::size_of::<INPUT>(), expected);
    }

    /// Really presses F13 on this computer: run it by hand.
    ///   cargo test manual_presses_a_real_key -- --ignored
    #[test]
    #[ignore = "posts a real key event"]
    fn manual_presses_a_real_key() {
        let combo = parse_combo("f13").expect("a combination");
        let events = combo_events(&combo, Platform::Windows).expect("planned");
        Sink.send(&events).expect("sent");
    }
}
