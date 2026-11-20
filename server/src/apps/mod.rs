//! The applications on this computer: listing them for the "Launch an app"
//! picker, starting one (or bringing it forward), and opening a web address
//! or a file with whatever the system uses for it.
//! (src/server/apps.ts, src/server/launch.ts; src/server/powershell.ts is
//! gone with PowerShell, and what it did for people, turning a system's
//! failure into a sentence, is `launch::clean_system_error`.)
//!
//! list.rs, launch.rs and desktop_entry.rs decide and are the same on every
//! system; the files named after a system make its calls.
pub mod desktop_entry;
pub mod launch;
pub mod list;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod launch_linux;
#[cfg(target_os = "macos")]
mod launch_mac;
#[cfg(target_os = "windows")]
mod launch_windows;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod list_linux;
#[cfg(target_os = "macos")]
mod list_mac;
#[cfg(target_os = "windows")]
mod list_windows;
#[cfg(test)]
mod testing;

pub use launch::{
    launch_with, open_path_with, open_url_with, Computer, Failure, SystemFailure, GENERIC_HOSTS,
};
pub use list::{installed_apps, list_apps, AppEntry};

/// This computer. Its [`Computer`] is in launch_mac.rs, launch_windows.rs
/// or launch_linux.rs.
pub struct System;

/// Runs system calls that wait (and, on Windows, need COM on their thread)
/// off the threads that serve requests.
async fn off_thread(
    work: impl FnOnce() -> Result<(), Failure> + Send + 'static,
) -> Result<(), Failure> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result,
        Err(stopped) => Err(Box::new(SystemFailure(stopped.to_string()))),
    }
}

/// "Launch an app": starts `target` (what [`list_apps`] gave as `path`, or a
/// path typed in), or brings it forward if it is already running. A failure
/// is a `UserError`: "server.launch.failed" with the system's reason,
/// "server.press.noApp" for no target, and on Linux
/// "server.launch.noCommand" or "server.launch.noTerminal".
pub async fn launch_app(target: &str) -> Result<(), Failure> {
    let target = target.to_string();
    off_thread(move || launch_with(&System, &target)).await
}

/// "Open a link", and the Control Center or the deck in this computer's
/// browser: opens what `model::links::web_address` makes of `address`, or
/// fails with the `UserError` "server.press.noLink" when that is not a web
/// address. A failure to open is a [`SystemFailure`], the system's words.
pub async fn open_url(address: &str) -> Result<(), Failure> {
    let address = address.to_string();
    off_thread(move || open_url_with(&System, &address)).await
}

/// Opens a file or a folder with what the system uses for it. A failure is
/// a [`SystemFailure`].
pub async fn open_path(path: &str) -> Result<(), Failure> {
    let path = path.to_string();
    off_thread(move || open_path_with(&System, &path)).await
}
