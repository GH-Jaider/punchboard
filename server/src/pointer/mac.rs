//! macOS: the pointer's events posted as Quartz events. Only system calls
//! live here; `MacPointer` in `pointer/mod.rs` decides which events, the way
//! helpers/mac-pointer.js did.
//!
//! Needs the Accessibility permission, like key combinations.
use std::ffi::c_void;
use std::time::{SystemTime, UNIX_EPOCH};

use core_graphics::display::CGDisplay;
use core_graphics::event::{
    CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
    ScrollEventUnit,
};
use core_graphics::event_source::CGEventSource;
use core_graphics::geometry::CGPoint;
use objc2::rc::autoreleasepool;
use objc2_app_kit::NSWorkspace;
use objc2_foundation::{NSString, NSURL};

use super::{
    mac_gesture_fields as gesture, MacEvent, MacPointer, MacSystem, MouseKind, OpenError, Point,
    PointerSink, Rect,
};
use crate::keys::mac::{hardware_source, may_post_events, post_key, post_raw};

// What the bindings do not cover: an event of a type they have no name for
// (the gesture), built field by field.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGEventSourceCreate(state: i32) -> *mut c_void;
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventSetSource(event: *mut c_void, source: *const c_void);
    fn CGEventSetType(event: *mut c_void, kind: u32);
    fn CGEventSetFlags(event: *mut c_void, flags: u64);
    fn CGEventSetIntegerValueField(event: *mut c_void, field: u32, value: i64);
    fn CGEventSetDoubleValueField(event: *mut c_void, field: u32, value: f64);
    fn CFRelease(object: *const c_void);
}

/// kCGEventSourceStateHIDSystemState.
const HID_SYSTEM_STATE: i32 = 1;

struct System {
    source: CGEventSource,
}

/// The pointer of this Mac, or why it cannot be reached. macOS is asked to
/// show its permission prompt when the answer is no.
pub(super) fn open() -> Result<Box<dyn PointerSink>, OpenError> {
    if !may_post_events() {
        return Err(OpenError::MacPermission);
    }
    let source = hardware_source().map_err(OpenError::Other)?;
    Ok(Box::new(MacPointer::new(System { source })))
}

fn mouse_type(kind: MouseKind) -> CGEventType {
    match kind {
        MouseKind::LeftDown => CGEventType::LeftMouseDown,
        MouseKind::LeftUp => CGEventType::LeftMouseUp,
        MouseKind::RightDown => CGEventType::RightMouseDown,
        MouseKind::RightUp => CGEventType::RightMouseUp,
        MouseKind::Moved => CGEventType::MouseMoved,
        MouseKind::LeftDragged => CGEventType::LeftMouseDragged,
    }
}

/// Builds the magnify gesture and, unless `dry`, posts it.
fn magnify(phase: i64, magnification: f64, dry: bool) -> Result<(), String> {
    // SAFETY: every pointer is checked before use and released once; the
    // functions take exactly these argument types.
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return Err("macOS could not make the pinch event.".to_string());
        }
        let source = CGEventSourceCreate(HID_SYSTEM_STATE);
        if !source.is_null() {
            CGEventSetSource(event, source);
        }
        CGEventSetType(event, gesture::EVENT_TYPE);
        CGEventSetFlags(event, gesture::FLAGS);
        CGEventSetIntegerValueField(event, gesture::FIELD_KIND, gesture::KIND_MAGNIFY);
        CGEventSetDoubleValueField(event, gesture::FIELD_MAGNIFICATION, magnification);
        CGEventSetIntegerValueField(event, gesture::FIELD_PHASE, phase);
        if !dry {
            post_raw(event);
        }
        if !source.is_null() {
            CFRelease(source);
        }
        CFRelease(event);
    }
    Ok(())
}

/// Four fingers pinching: the app launcher (Apps on macOS 26, Launchpad
/// before), found by name as `open -a` finds it.
fn open_launcher() -> Result<(), String> {
    autoreleasepool(|_| {
        let workspace = NSWorkspace::sharedWorkspace();
        for name in ["Apps", "Launchpad"] {
            #[allow(deprecated)]
            let path = workspace.fullPathForApplication(&NSString::from_str(name));
            if let Some(path) = path {
                if workspace.openURL(&NSURL::fileURLWithPath(&path)) {
                    return Ok(());
                }
            }
        }
        Err("macOS has no app launcher to open.".to_string())
    })
}

impl MacSystem for System {
    fn now_ms(&mut self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
    }

    fn location(&mut self) -> Result<Point, String> {
        let event = CGEvent::new(self.source.clone())
            .map_err(|()| "macOS did not say where the cursor is.".to_string())?;
        let at = event.location();
        Ok(Point { x: at.x, y: at.y })
    }

    /// Every display in CoreGraphics coordinates (origin top left of the
    /// main one, which comes first).
    fn displays(&mut self) -> Vec<Rect> {
        CGDisplay::active_displays()
            .unwrap_or_default()
            .into_iter()
            .map(|id| {
                let bounds = CGDisplay::new(id).bounds();
                Rect {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    w: bounds.size.width,
                    h: bounds.size.height,
                }
            })
            .collect()
    }

    fn post(&mut self, event: MacEvent) -> Result<(), String> {
        match event {
            MacEvent::Mouse {
                kind,
                at,
                button,
                clicks,
            } => {
                let button = if button == 1 {
                    CGMouseButton::Right
                } else {
                    CGMouseButton::Left
                };
                let event = CGEvent::new_mouse_event(
                    self.source.clone(),
                    mouse_type(kind),
                    CGPoint::new(at.x, at.y),
                    button,
                )
                .map_err(|()| "macOS could not make the mouse event.".to_string())?;
                // No modifier rides along: a shortcut must never turn a click into a ⌘-click.
                event.set_flags(CGEventFlags::empty());
                if clicks != 0 {
                    event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
                }
                event.post(CGEventTapLocation::HID);
                Ok(())
            }
            MacEvent::Scroll {
                vertical,
                horizontal,
            } => {
                let event = CGEvent::new_scroll_event(
                    self.source.clone(),
                    ScrollEventUnit::PIXEL,
                    2,
                    vertical,
                    horizontal,
                    0,
                )
                .map_err(|()| "macOS could not make the scroll event.".to_string())?;
                event.set_flags(CGEventFlags::empty());
                event.post(CGEventTapLocation::HID);
                Ok(())
            }
            MacEvent::Key { code, down, flags } => post_key(&self.source, code, down, flags),
            MacEvent::Magnify {
                phase,
                magnification,
            } => magnify(phase, magnification, false),
            MacEvent::Hold(time) => {
                std::thread::sleep(time);
                Ok(())
            }
            MacEvent::Launcher => open_launcher(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pointer::Command;

    // Nothing here posts an event: the system is only asked things.
    #[test]
    fn the_system_says_where_the_cursor_and_the_displays_are() {
        let Ok(source) = hardware_source() else {
            // No window server (a bare build machine): nothing to ask.
            return;
        };
        let mut system = System { source };
        assert!(system.now_ms() > 1.7e12);
        let at = system.location().expect("a cursor");
        assert!(at.x.is_finite() && at.y.is_finite());
        for display in system.displays() {
            assert!(display.w > 0.0 && display.h > 0.0, "{display:?}");
        }
    }

    #[test]
    fn the_pinch_event_is_built_without_being_sent() {
        magnify(1, 0.0, true).expect("built");
        magnify(2, 0.05, true).expect("built");
        magnify(4, 0.0, true).expect("built");
    }

    /// Really moves this Mac's cursor a little and back: run it by hand.
    ///   cargo test manual_moves_the_real_pointer -- --ignored
    #[test]
    #[ignore = "posts real pointer events"]
    fn manual_moves_the_real_pointer() {
        let mut pointer = open().expect("allowed under Accessibility");
        pointer
            .run(&Command::Move { dx: 20, dy: 10 })
            .expect("moved");
        pointer
            .run(&Command::Move { dx: -20, dy: -10 })
            .expect("moved back");
        pointer.close();
    }
}
