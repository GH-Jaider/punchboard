//! macOS: key events posted straight to the system as Quartz events.
//!
//! Needs the Accessibility permission. Only system calls live here; which
//! events to post is decided in `keys/mod.rs`.
use std::ffi::c_void;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_foundation::NSPoint;

use super::{mac_media_event, KeyEvent, KeyFailure, KeySink};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightPostEventAccess() -> bool;
    fn CGRequestPostEventAccess() -> bool;
    fn CGEventPost(tap: u32, event: *mut c_void);
}

/// kCGHIDEventTap.
const HID_TAP: u32 = 0;

/// Whether macOS lets this process post events. When it does not, macOS is
/// asked to show its prompt (once per run of the app; after that the answer
/// is in System Settings › Privacy & Security › Accessibility).
pub(crate) fn may_post_events() -> bool {
    // SAFETY: both take nothing and return a bool.
    unsafe {
        if CGPreflightPostEventAccess() {
            return true;
        }
        CGRequestPostEventAccess();
    }
    false
}

/// Posts an event the bindings have no type for.
///
/// # Safety
/// `event` must be a live CGEventRef.
pub(crate) unsafe fn post_raw(event: *mut c_void) {
    CGEventPost(HID_TAP, event);
}

/// Every event carries the hardware's own event source, so macOS treats it
/// as part of the same input as the real trackpad and keyboard. Without
/// one, the first clicks after starting were ignored until the real trackpad
/// was used.
pub(crate) fn hardware_source() -> Result<CGEventSource, String> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|()| "macOS gave no event source.".to_string())
}

/// One key down or up, carrying exactly these modifier flags.
pub(crate) fn post_key(
    source: &CGEventSource,
    code: u16,
    down: bool,
    flags: u64,
) -> Result<(), String> {
    let event = CGEvent::new_keyboard_event(source.clone(), code, down)
        .map_err(|()| "macOS could not make the key event.".to_string())?;
    event.set_flags(CGEventFlags::from_bits_retain(flags));
    event.post(CGEventTapLocation::HID);
    Ok(())
}

/// The "system defined" event of one music key, as AppKit builds it.
fn media_event(key: u32, down: bool) -> Option<Retained<NSEvent>> {
    let fields = mac_media_event(key, down);
    NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
        NSEventType(fields.event_type as usize),
        NSPoint::new(0.0, 0.0),
        NSEventModifierFlags(fields.modifier_flags as usize),
        0.0,
        0,
        None,
        fields.subtype,
        fields.data1 as isize,
        fields.data2 as isize,
    )
}

/// Builds the event of a music key and, unless `dry`, posts it. A dry run
/// says whether macOS made a Quartz event out of it.
pub(crate) fn media_key(key: u32, down: bool, dry: bool) -> Result<(), String> {
    autoreleasepool(|_| {
        let event = media_event(key, down)
            .ok_or_else(|| "macOS could not make the music key event.".to_string())?;
        let quartz = event
            .CGEvent()
            .ok_or_else(|| "The music key event has no Quartz event.".to_string())?;
        if !dry {
            // SAFETY: `quartz` is a live CGEventRef for the length of the call.
            unsafe { post_raw(Retained::as_ptr(&quartz) as *mut c_void) };
        }
        Ok(())
    })
}

pub(crate) struct Sink;

impl KeySink for Sink {
    fn send(&mut self, events: &[KeyEvent]) -> Result<(), KeyFailure> {
        if !may_post_events() {
            return Err(KeyFailure::MacPermission);
        }
        let source = hardware_source().map_err(KeyFailure::Other)?;
        for event in events {
            match *event {
                KeyEvent::Mac { code, down, flags } => {
                    post_key(&source, code, down, flags).map_err(KeyFailure::Other)?
                }
                KeyEvent::MacMedia { key, down } => {
                    media_key(key, down, false).map_err(KeyFailure::Other)?
                }
                KeyEvent::Wait { ms } => std::thread::sleep(Duration::from_millis(ms)),
                // Other systems' events are never planned for this one.
                KeyEvent::Scan { .. } | KeyEvent::Virtual { .. } | KeyEvent::Evdev { .. } => {}
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::{media_events, Platform, MAC_MEDIA};
    use crate::model::MediaKey;

    // What tests/windows.test.mjs did with macMediaScript's dry run on a Mac:
    // the events are built, and macOS reads each as a Quartz event. Nothing
    // is posted.
    #[test]
    fn music_key_events_are_built_without_being_sent() {
        for (_, key) in MAC_MEDIA {
            media_key(key, true, true).expect("down");
            media_key(key, false, true).expect("up");
        }
    }

    /// Really taps play/pause on this Mac: run it by hand, with music open.
    ///   cargo test manual_posts_a_real_music_key -- --ignored
    #[test]
    #[ignore = "posts a real key event"]
    fn manual_posts_a_real_music_key() {
        Sink.send(&media_events(MediaKey::PlayPause, Platform::Mac))
            .expect("sent");
    }
}
