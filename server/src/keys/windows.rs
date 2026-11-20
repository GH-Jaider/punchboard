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
            return Err(KeyFailure::WindowsRefused { taken, wanted });
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

    /// tests/windows.test.mjs: "Every key's scan code is that physical key
    /// (US layout), modifiers the left-hand ones". Windows' own US layout,
    /// which is what KeyboardEvent.code names keys by, maps each scan code to
    /// the virtual key of the key it is named after. Nothing is pressed.
    #[test]
    fn every_scan_code_is_that_physical_key_on_the_us_layout() {
        use crate::keys::{WIN_MODIFIER_SCAN_CODES, WIN_SCAN_CODES};
        use crate::model::keys::Modifier;
        use windows::core::w;
        use windows::Win32::UI::Input::KeyboardAndMouse::{
            LoadKeyboardLayoutW, MapVirtualKeyExW, ACTIVATE_KEYBOARD_LAYOUT_FLAGS,
            MAPVK_VSC_TO_VK_EX,
        };

        fn vk_of(name: &str) -> u32 {
            match name {
                "enter" => 0x0d,
                "space" => 0x20,
                "tab" => 0x09,
                "escape" => 0x1b,
                "backspace" => 0x08,
                "delete" => 0x2e,
                "up" => 0x26,
                "down" => 0x28,
                "left" => 0x25,
                "right" => 0x27,
                "home" => 0x24,
                "end" => 0x23,
                "pageup" => 0x21,
                "pagedown" => 0x22,
                "minus" => 0xbd,
                "equal" => 0xbb,
                "comma" => 0xbc,
                "period" => 0xbe,
                "slash" => 0xbf,
                "backquote" => 0xc0,
                "bracketleft" => 0xdb,
                "backslash" => 0xdc,
                "bracketright" => 0xdd,
                "quote" => 0xde,
                "semicolon" => 0xba,
                // A letter or a digit is its own capital; F1 is 0x70.
                _ => match name.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
                    Some(number) => 0x6f + number,
                    None => name
                        .chars()
                        .next()
                        .map(|c| u32::from(c.to_ascii_uppercase()))
                        .unwrap_or(0),
                },
            }
        }

        let mut named: Vec<(String, u16, u32)> = WIN_SCAN_CODES
            .iter()
            .map(|(name, code)| (name.to_string(), *code, vk_of(name)))
            .collect();
        for (modifier, code) in WIN_MODIFIER_SCAN_CODES {
            // The left-hand Ctrl, Alt and Shift, and the left Windows key.
            let (name, vk) = match modifier {
                Modifier::Ctrl => ("ctrl", 0xa2),
                Modifier::Alt => ("alt", 0xa4),
                Modifier::Shift => ("shift", 0xa0),
                Modifier::Meta => ("meta", 0x5b),
            };
            named.push((name.to_string(), code, vk));
        }
        // SAFETY: the layout's name is a constant, zero-ended string.
        let us = unsafe { LoadKeyboardLayoutW(w!("00000409"), ACTIVATE_KEYBOARD_LAYOUT_FLAGS(0)) }
            .expect("the US layout");
        let wrong: Vec<String> = named
            .iter()
            .filter_map(|(name, code, vk)| {
                // MAPVK_VSC_TO_VK_EX reads an E0 prefix in the high byte.
                // SAFETY: plain values; the layout was just loaded.
                let mapped =
                    unsafe { MapVirtualKeyExW(u32::from(*code), MAPVK_VSC_TO_VK_EX, Some(us)) };
                (mapped != *vk).then(|| format!("{name}: {code:#x} is VK {mapped:#x}, not {vk:#x}"))
            })
            .collect();
        assert!(wrong.is_empty(), "{}", wrong.join("; "));
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
