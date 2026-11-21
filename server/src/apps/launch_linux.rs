//! Linux (and the other systems that follow the XDG specifications):
//! starting what a desktop entry says to run, and opening addresses and
//! files with xdg-open, which is the desktop's own way to do that.
//!
//! An application is always started, never looked for among the running
//! ones: see launch.rs.
use std::env;
use std::fs;
use std::process::{Command, Stdio};

use super::desktop_entry::{find_program, find_terminal, locale_candidates};
use super::launch::{desktop_program, is_desktop_file, launch_failed, Computer, Failure};
use super::list_linux::{is_program, search_path};
use super::System;

/// Starts a program on its own: no input or output of ours, its own process
/// group (what stops Punchboard does not stop it), and nobody waiting on it.
fn start(command: &[String], dir: Option<&str>) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let Some((program, arguments)) = command.split_first() else {
        return Err(String::new());
    };
    let mut process = Command::new(program);
    process
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    if let Some(dir) = dir {
        process.current_dir(dir);
    }
    let mut child = process
        .spawn()
        .map_err(|error| format!("{program}: {error}"))?;
    // Collected when it ends, so it does not stay behind as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn xdg_open(target: &str) -> Result<(), String> {
    start(&["xdg-open".to_string(), target.to_string()], None)
}

impl Computer for System {
    fn launch(&self, target: &str) -> Result<(), Failure> {
        let failed = |reason: String| Box::new(launch_failed(&reason)) as Failure;
        // Not a desktop entry (a path typed in): opened with what opens it.
        if !is_desktop_file(target) {
            return xdg_open(target).map_err(failed);
        }
        let bytes = fs::read(target).map_err(|error| failed(error.to_string()))?;
        let variable = |name: &str| env::var(name).ok();
        let program = desktop_program(
            &String::from_utf8_lossy(&bytes),
            target,
            &locale_candidates(variable),
            || {
                let path = search_path();
                find_terminal(variable("TERMINAL").as_deref(), &|name| {
                    find_program(name, &path, &is_program).is_some()
                })
            },
        )?;
        start(&program.command, program.dir.as_deref()).map_err(failed)
    }

    fn open_url(&self, address: &str) -> Result<(), String> {
        xdg_open(address)
    }

    fn open_path(&self, path: &str) -> Result<(), String> {
        xdg_open(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::UserError;

    // Nothing here starts an application or opens anything: only programs
    // that are not there, and /bin/true.

    #[test]
    fn a_program_that_is_not_there_is_reported() {
        let error = start(&["/nowhere/punchboard-missing".to_string()], None).unwrap_err();
        assert!(
            error.starts_with("/nowhere/punchboard-missing: "),
            "{error}"
        );
        assert!(start(&[], None).is_err());
        if std::path::Path::new("/bin/true").exists() {
            assert_eq!(start(&["/bin/true".to_string()], Some("/")), Ok(()));
        }
    }

    #[test]
    fn a_desktop_entry_that_is_not_there_is_reported() {
        let failure = System.launch("/nowhere/missing.desktop").unwrap_err();
        let error = failure.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(error.text.key, "server.launch.failed");
    }

    #[test]
    fn a_desktop_entry_with_nothing_to_run_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("empty.desktop");
        fs::write(&file, "[Desktop Entry]\nType=Application\nName=Empty\n").unwrap();
        let failure = System.launch(&file.to_string_lossy()).unwrap_err();
        let error = failure.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(error.text.key, "server.launch.noCommand");
        // One that runs a program that is not installed.
        fs::write(
            &file,
            "[Desktop Entry]\nExec=/nowhere/punchboard-missing %U\n",
        )
        .unwrap();
        let failure = System.launch(&file.to_string_lossy()).unwrap_err();
        let error = failure.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(error.text.key, "server.launch.failed");
    }
}
