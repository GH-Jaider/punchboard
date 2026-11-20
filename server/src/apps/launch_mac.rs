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
/// application goes on starting. Short, because a button with several steps
/// waits this long at each application it opens.
const PATIENCE: Duration = Duration::from_millis(150);

/// What macOS says of one opening, whenever it says it.
struct Told {
    answer: mpsc::Sender<Option<String>>,
    /// Told of a failure that came after the press was answered.
    late: Box<dyn Fn(&str) + Send>,
}

impl Told {
    /// macOS answered: `None` when it opened, or why it did not.
    fn tell(&self, reason: Option<String>) {
        // Nobody listening any more: the wait gave up, and the press was
        // answered as done. A failure is at least written down.
        if let Err(mpsc::SendError(Some(reason))) = self.answer.send(reason) {
            (self.late)(&reason);
        }
    }
}

/// Waits a moment for an early failure. One that comes later goes to `late`.
fn early_failure(
    patience: Duration,
    late: impl Fn(&str) + Send + 'static,
    ask: impl FnOnce(Told),
) -> Result<(), String> {
    let (answer, answered) = mpsc::channel::<Option<String>>();
    ask(Told {
        answer,
        late: Box::new(late),
    });
    match answered.recv_timeout(patience) {
        Ok(Some(reason)) => Err(reason),
        Ok(None) | Err(_) => Ok(()),
    }
}

/// Asks the workspace to open `url`, as an application or with whatever
/// opens it, in front. The system's words on failure.
fn open(url: &NSURL, application: bool) -> Result<(), String> {
    let late = |reason: &str| {
        println!(
            "[punchboard] Something that was opened failed afterwards: {}",
            super::launch::clean_system_error(reason)
        );
    };
    early_failure(PATIENCE, late, |told| {
        let done = RcBlock::new(
            move |_running: *mut NSRunningApplication, error: *mut NSError| {
                // SAFETY: AppKit passes nil or an NSError that is valid for the
                // length of this call.
                let reason =
                    unsafe { error.as_ref() }.map(|error| error.localizedDescription().to_string());
                told.tell(reason);
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
    })
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
    fn a_launch_waits_only_a_moment_for_a_failure() {
        use std::sync::{Arc, Mutex};
        use std::time::Instant;
        let late: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let noted = |late: &Arc<Mutex<Vec<String>>>| {
            let late = late.clone();
            move |reason: &str| late.lock().unwrap().push(reason.to_string())
        };
        assert!(PATIENCE <= Duration::from_millis(150));

        // A failure told at once is the answer.
        let failed = early_failure(PATIENCE, noted(&late), |told| {
            told.tell(Some("no such file".to_string()));
        });
        assert_eq!(failed, Err("no such file".to_string()));
        // So is one told a little later, from another thread.
        let failed = early_failure(PATIENCE, noted(&late), |told| {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                told.tell(Some("nothing opens it".to_string()));
            });
        });
        assert_eq!(failed, Err("nothing opens it".to_string()));
        // Success told at once does not wait.
        let started = Instant::now();
        assert_eq!(
            early_failure(PATIENCE, noted(&late), |told| told.tell(None)),
            Ok(())
        );
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(late.lock().unwrap().is_empty());

        // An application still starting: the press is answered after the
        // wait, and what macOS says later is written down, not reported.
        let (done, finished) = mpsc::channel();
        let started = Instant::now();
        let slow = early_failure(PATIENCE, noted(&late), |told| {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(400));
                told.tell(Some("it crashed while starting".to_string()));
                let _ = done.send(());
            });
        });
        let waited = started.elapsed();
        assert_eq!(slow, Ok(()));
        assert!(
            waited >= Duration::from_millis(140) && waited < Duration::from_millis(350),
            "{waited:?}"
        );
        finished.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(*late.lock().unwrap(), vec!["it crashed while starting"]);
        // A late success says nothing.
        let (done, finished) = mpsc::channel();
        let slow = early_failure(Duration::from_millis(10), noted(&late), |told| {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(60));
                told.tell(None);
                let _ = done.send(());
            });
        });
        assert_eq!(slow, Ok(()));
        finished.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(late.lock().unwrap().len(), 1);
    }

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
