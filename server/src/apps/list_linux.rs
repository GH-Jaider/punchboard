//! Linux (and the other systems that follow the XDG specifications): the
//! session's folders, languages and desktop, read from the environment.
use std::env;
use std::path::{Path, PathBuf};

use super::desktop_entry::locale_candidates;
use super::list::{linux_application_dirs, linux_apps, posix_locale, AppEntry, LinuxSession};

fn variable(name: &str) -> Option<String> {
    env::var(name).ok()
}

/// The folders of $PATH.
pub fn search_path() -> Vec<PathBuf> {
    env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default()
}

/// Whether a path is a file this user may run.
pub fn is_program(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0)
}

pub fn session() -> LinuxSession {
    LinuxSession {
        locales: locale_candidates(variable),
        desktops: variable("XDG_CURRENT_DESKTOP")
            .unwrap_or_default()
            .split(':')
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect(),
        path: search_path(),
    }
}

pub fn apps() -> Vec<AppEntry> {
    let dirs = linux_application_dirs(variable, &env::home_dir().unwrap_or_default());
    linux_apps(&dirs, &session(), &is_program)
}

pub fn locale() -> String {
    posix_locale(variable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_is_a_file_that_may_be_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let tool = dir.path().join("tool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_program(&tool));
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_program(&tool));
        assert!(!is_program(dir.path()));
        assert!(!is_program(&dir.path().join("missing")));
    }

    /// The real folders are read without failing; a container has few or
    /// no entries, a desktop has many.
    #[test]
    fn the_real_folders_are_read() {
        for app in apps() {
            assert!(
                !app.name.is_empty() && app.path.ends_with(".desktop"),
                "{app:?}"
            );
        }
    }
}
