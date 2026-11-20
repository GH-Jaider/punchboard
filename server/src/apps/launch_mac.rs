//! macOS: opening applications, files and addresses through NSWorkspace,
//! which is what `open` (and the "open" package the TypeScript used) asks
//! too. Opening an application that runs brings it forward.
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::{autoreleasepool, Retained};
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSError, NSString, NSURL};

use super::launch::{is_mac_bundle, launch_failed, Computer, Failure};
use super::System;

/// How long to wait for macOS to say an opening failed. A failure (no such
/// file, nothing that opens it) is told at once. Success is only told once
/// the application has started, which can take long, and the TypeScript
/// never waited for it: after this long the press is answered, and the
/// application goes on starting.
const PATIENCE: Duration = Duration::from_millis(1000);

/// Asks the workspace to open `url`, as an application or with whatever
/// opens it, in front. The system's words on failure.
fn open(url: &NSURL, application: bool) -> Result<(), String> {
    let (answer, answered) = mpsc::channel::<Option<String>>();
    let done = RcBlock::new(
        move |_running: *mut NSRunningApplication, error: *mut NSError| {
            // SAFETY: AppKit passes nil or an NSError that is valid for the
            // length of this call.
            let reason =
                unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
            // Nobody listening any more: the wait below gave up.
            let _ = answer.send(reason);
        },
    );
    let workspace = NSWorkspace::sharedWorkspace();
    let configuration = NSWorkspaceOpenConfiguration::configuration();
    configuration.setActivates(true);
    if application {
        workspace.openApplicationAtURL_configuration_completionHandler(
            url,
            &configuration,
            Some(&done),
        );
    } else {
        workspace.openURL_configuration_completionHandler(url, &configuration, Some(&done));
    }
    match answered.recv_timeout(PATIENCE) {
        Ok(Some(reason)) => Err(reason),
        Ok(None) | Err(_) => Ok(()),
    }
}

fn open_file(path: &str) -> Result<(), String> {
    // These threads have no autorelease pool of their own.
    autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        open(&url, is_mac_bundle(path))
    })
}

impl Computer for System {
    fn launch(&self, target: &str) -> Result<(), Failure> {
        open_file(target).map_err(|reason| Box::new(launch_failed(&reason)) as Failure)
    }

    fn open_url(&self, address: &str) -> Result<(), String> {
        autoreleasepool(|_| {
            let url: Option<Retained<NSURL>> = NSURL::URLWithString(&NSString::from_str(address));
            match url {
                Some(url) => open(&url, false),
                // An address web_address() made is always one NSURL reads.
                None => Err(address.to_string()),
            }
        })
    }

    fn open_path(&self, path: &str) -> Result<(), String> {
        open_file(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::UserError;

    // Nothing here starts an application or opens anything: only what is
    // not there is asked for, which also proves macOS answers through the
    // completion handler on a thread with no run loop.

    #[test]
    fn an_application_that_is_not_there_is_reported() {
        let failure = System
            .launch("/nowhere/Punchboard missing ‘app’.app")
            .unwrap_err();
        let error = failure.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(error.text.key, "server.launch.failed");
        let message = error.message();
        assert!(
            message.starts_with("Could not open that app. (") && message.len() > 30,
            "{message}"
        );
        assert!(!message.contains('\n'), "{message}");
    }

    #[test]
    fn a_file_that_is_not_there_is_reported() {
        let reason = System
            .open_path("/nowhere/punchboard-missing.txt")
            .unwrap_err();
        assert!(!reason.is_empty());
        let failure = System
            .launch("/nowhere/punchboard-missing.txt")
            .unwrap_err();
        assert!(failure.downcast_ref::<UserError>().is_some());
    }
}
