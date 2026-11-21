//! Windows: key events through SendInput. Only system calls live here;
//! which events to send is decided in `keys/mod.rs`.
use std::time::Duration;

use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, VIRTUAL_KEY,
};

use super::{post_windows_events, KeyEvent, KeyFailure, KeySink, WindowsInput, WindowsPoster};

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

/// Batches go to SendInput and a pause is slept through.
struct SendInputPoster;

impl WindowsPoster for SendInputPoster {
    fn post(&mut self, inputs: &[WindowsInput]) -> u32 {
        let inputs: Vec<INPUT> = inputs
            .iter()
            .map(|input| keyboard_input(input.vk, input.scan, input.flags))
            .collect();
        post(&inputs)
    }

    fn wait(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

pub(crate) struct Sink;

impl KeySink for Sink {
    /// What goes in which call, and that the releases are sent even when
    /// the presses were refused, is decided in `keys/mod.rs`.
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure> {
        post_windows_events(events, &mut SendInputPoster)
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
