//! macOS: where the applications are and which language sorts them.
use std::env;

use super::list::{mac_apps, mac_roots, posix_locale, AppEntry};

pub fn apps() -> Vec<AppEntry> {
    // The home folder as Node's os.homedir() finds it: HOME, else the
    // account's own.
    mac_apps(&mac_roots(&env::home_dir().unwrap_or_default()))
}

pub fn locale() -> String {
    posix_locale(|name| env::var(name).ok())
}
