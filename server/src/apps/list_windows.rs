//! Windows: where the Start Menus are and which language sorts their names.
use std::env;

use super::list::{windows_apps, windows_start_menus, AppEntry};

pub fn apps() -> Vec<AppEntry> {
    windows_apps(&windows_start_menus(
        |name| env::var(name).ok(),
        &env::home_dir().unwrap_or_default(),
    ))
}

/// The locale of this user's regional settings, which is what Node's Intl
/// started in on Windows.
pub fn locale() -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultLocaleName(name: *mut u16, length: i32) -> i32;
    }
    // LOCALE_NAME_MAX_LENGTH
    let mut name = [0u16; 85];
    // SAFETY: the buffer is as long as the length passed, and the function
    // writes at most that many UTF-16 units, the final zero included.
    let written = unsafe { GetUserDefaultLocaleName(name.as_mut_ptr(), name.len() as i32) };
    if written <= 1 {
        return "en-US".to_string();
    }
    String::from_utf16_lossy(&name[..written as usize - 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_says_which_language_it_is_in() {
        let locale = locale();
        assert!(
            locale.len() >= 2
                && locale
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "{locale}"
        );
    }

    /// The real Start Menu is read without failing, and nothing in it is
    /// an uninstaller. (tests/windows.test.mjs has no check of the list; this
    /// is the one a Windows machine can add.)
    #[test]
    fn the_real_start_menu_is_read() {
        for app in apps() {
            assert!(super::super::list::is_app_name(&app.name), "{}", app.name);
            let lower = app.path.to_lowercase();
            assert!(
                lower.ends_with(".lnk") || lower.ends_with(".url"),
                "{}",
                app.path
            );
        }
    }
}
