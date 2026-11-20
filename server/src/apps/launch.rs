//! "Launch an app": start it, or bring it forward if it is already running.
//!
//! macOS does the right thing by itself: opening an app that runs activates it.
//! Windows does not: running a Start Menu shortcut again starts the program
//! again, and Chrome answers that with another window. So on Windows the
//! shortcut's program is looked up among the running ones first, and if one has
//! a window, that window is restored and brought to the front instead.
//!
//! That only works when the program's name says which window is meant. It
//! does not when the shortcut passes arguments ("Chrome - Work profile",
//! a web app's --app-id, a game's -profile) or starts a launcher that runs
//! something else (cmd, powershell, javaw, explorer): any window of that
//! program would be the wrong one, so those shortcuts are simply started.
//! Squirrel apps (Discord, Slack...) start through Update.exe --processStart
//! X.exe, where X.exe is the program to look for.
//!
//! Linux always starts the application: a program cannot bring another's
//! window forward on Wayland, and on X11 only some window managers let it.
//! Applications that keep one copy come forward themselves when started again.
//! (src/server/launch.ts)
//!
//! Also here: opening a web address or a file with whatever the system uses
//! for it, which the TypeScript left to the "open" package.
//!
//! This file decides; launch_mac.rs, launch_windows.rs and launch_linux.rs do.
use std::fmt;

use super::desktop_entry::{expand_exec, in_terminal, split_exec, DesktopEntry, ExecFields};
use crate::i18n::{say, UserError};
use crate::model::js;
use crate::model::links::web_address;

// ----------------------------------------------------------------- errors

/// What went wrong: a [`UserError`] (a sentence of Punchboard's own, in the
/// reader's language) or a [`SystemFailure`] (what the system said).
/// `i18n::text_of` tells them apart, as the TypeScript's `textOf` did.
pub type Failure = Box<dyn std::error::Error + Send + Sync + 'static>;

/// The system's own words for a failure, on one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemFailure(pub String);

impl fmt::Display for SystemFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SystemFailure {}

/// What a system said when it failed, as one line a person can read: runs
/// of spaces and line ends become one space ("…specified.\r\n" loses its
/// end). This is what is left of the TypeScript's `cleanPowerShellError`,
/// whose other work was unwrapping PowerShell's own packaging.
pub fn clean_system_error(text: &str) -> String {
    let mut clean = String::with_capacity(text.len());
    let mut gap = false;
    for c in js::trim(text).chars() {
        if js::is_space(c) {
            gap = true;
            continue;
        }
        if gap {
            clean.push(' ');
            gap = false;
        }
        clean.push(c);
    }
    clean
}

/// "Could not open that app. (reason)"
pub fn launch_failed(reason: &str) -> UserError {
    UserError::new(say("server.launch.failed").with("reason", clean_system_error(reason)))
}

// ------------------------------------------------------------ the computer

/// The computer, as far as opening things goes. The real one is
/// [`super::System`]; tests pass one that writes down what it was asked.
pub trait Computer {
    /// Starts an application or brings it forward. `target` is what the app
    /// list gave: a bundle, a shortcut, a .desktop file, or a path typed in.
    fn launch(&self, target: &str) -> Result<(), Failure>;
    /// Opens a web address in the default browser; the system's words on failure.
    fn open_url(&self, address: &str) -> Result<(), String>;
    /// Opens a file or a folder with what the system uses for it.
    fn open_path(&self, path: &str) -> Result<(), String>;
}

/// "Launch an app".
pub fn launch_with(computer: &dyn Computer, target: &str) -> Result<(), Failure> {
    if target.is_empty() {
        return Err(Box::new(UserError::new(say("server.press.noApp"))));
    }
    computer.launch(target)
}

/// "Open a link": only what [`web_address`] accepts is ever opened, so a
/// link can never run anything; the address opened is the one it gives
/// ("twitch.tv/x" is opened as "https://twitch.tv/x").
pub fn open_url_with(computer: &dyn Computer, address: &str) -> Result<(), Failure> {
    let Some(address) = web_address(Some(address)) else {
        return Err(Box::new(UserError::new(say("server.press.noLink"))));
    };
    computer
        .open_url(&address)
        .map_err(|reason| Box::new(SystemFailure(clean_system_error(&reason))) as Failure)
}

/// Opens a file or a folder.
pub fn open_path_with(computer: &dyn Computer, path: &str) -> Result<(), Failure> {
    computer
        .open_path(path)
        .map_err(|reason| Box::new(SystemFailure(clean_system_error(&reason))) as Failure)
}

// ---------------------------------------------------------------- Windows

/// Programs that run other things, so a window of theirs says nothing about
/// which shortcut opened it. Lower case, without .exe.
pub const GENERIC_HOSTS: [&str; 24] = [
    "explorer",
    "cmd",
    "powershell",
    "pwsh",
    "wt",
    "windowsterminal",
    "conhost",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "msiexec",
    "dllhost",
    "mmc",
    "control",
    "hh",
    "java",
    "javaw",
    "py",
    "pyw",
    "python",
    "pythonw",
    "node",
    "update",
];

/// The key tapped to earn the foreground: VK 0xE8, one no keyboard has.
pub const UNASSIGNED_KEY: u8 = 0xE8;

/// What a .lnk says: the program it starts and what it passes to it. Both
/// empty for a shortcut that is not there or cannot be read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Shortcut {
    pub target: String,
    pub arguments: String,
}

/// Why a target is started without looking for a window of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Why {
    /// Not a program's shortcut: a .url, a document, a shortcut that is gone.
    NotAProgram,
    /// The shortcut passes arguments, so a window of its program may be
    /// another shortcut's.
    Arguments,
    /// The shortcut starts a program that runs other things.
    Launcher(String),
}

/// What to do with a launch target on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Look for a running program of this name (no .exe) with a window, and
    /// bring that window forward; start the target if there is none.
    Focus(String),
    Start(Why),
}

/// In the words of the TypeScript's dry run, which its tests read:
/// "focus NAME" (there followed by "running" or "idle") or "start REASON".
impl fmt::Display for Plan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Plan::Focus(name) => write!(f, "focus {name}"),
            Plan::Start(Why::NotAProgram) => f.write_str("start not a program"),
            Plan::Start(Why::Arguments) => f.write_str("start arguments"),
            Plan::Start(Why::Launcher(name)) => write!(f, "start launcher {name}"),
        }
    }
}

/// Whether `text` ends with `ending`, case aside. (PowerShell's
/// `-match '\.lnk$'`, where `$` also matches before a last line feed.)
fn ends_with(text: &str, ending: &str) -> bool {
    let text = text.strip_suffix('\n').unwrap_or(text);
    text.len()
        .checked_sub(ending.len())
        .and_then(|at| text.get(at..))
        .is_some_and(|end| end.eq_ignore_ascii_case(ending))
}

/// [System.IO.Path]::GetFileName
fn file_name(path: &str) -> &str {
    path.rsplit(['\\', '/', ':']).next().unwrap_or(path)
}

/// [System.IO.Path]::GetFileNameWithoutExtension
fn file_stem(path: &str) -> &str {
    let name = file_name(path);
    name.rfind('.').map_or(name, |dot| &name[..dot])
}

/// The program Squirrel's Update.exe is asked to start: the X.exe of
/// `--processStart X.exe` or `--processStart "X.exe"`, and of nothing else
/// (with more arguments, the window may be another shortcut's).
/// The script's `^\s*--processStart\s+(?:"([^"]+)"|(\S+))\s*$`.
pub fn squirrel_program(arguments: &str) -> Option<String> {
    const FLAG: &str = "--processStart";
    let rest = arguments.trim_start();
    if !rest
        .get(..FLAG.len())
        .is_some_and(|flag| flag.eq_ignore_ascii_case(FLAG))
    {
        return None;
    }
    let rest = &rest[FLAG.len()..];
    let name = rest.trim_start();
    if name.len() == rest.len() {
        return None;
    }
    // In quotes, with nothing after them.
    if let Some(quoted) = name.strip_prefix('"') {
        if let Some(end) = quoted.find('"') {
            if end > 0 && quoted[end + 1..].trim().is_empty() {
                return Some(quoted[..end].to_string());
            }
        }
    }
    // Or one word, with nothing after it.
    let name = name.trim_end();
    (!name.is_empty() && !name.contains(char::is_whitespace)).then(|| name.to_string())
}

/// What to do with `target`. `shortcut` reads a .lnk; it is only asked for
/// targets that are one.
pub fn windows_plan(target: &str, shortcut: impl FnOnce(&str) -> Shortcut) -> Plan {
    // The program to look for among the running ones; empty when the
    // shortcut cannot be matched to one window, `why` says why.
    let mut exe = String::new();
    let mut why = Why::NotAProgram;
    if ends_with(target, ".lnk") {
        let link = shortcut(target);
        exe = link.target;
        let squirrel = if file_name(&exe).eq_ignore_ascii_case("Update.exe") {
            squirrel_program(&link.arguments)
        } else {
            None
        };
        if let Some(program) = squirrel {
            exe = program;
        } else if !link.arguments.trim().is_empty() {
            exe = String::new();
            why = Why::Arguments;
        }
    } else if ends_with(target, ".exe") {
        exe = target.to_string();
    }
    if !ends_with(&exe, ".exe") {
        return Plan::Start(why);
    }
    let name = file_stem(&exe);
    if GENERIC_HOSTS
        .iter()
        .any(|host| host.eq_ignore_ascii_case(name))
    {
        return Plan::Start(Why::Launcher(name.to_string()));
    }
    if name.is_empty() {
        return Plan::Start(why);
    }
    Plan::Focus(name.to_string())
}

/// A running program: its id and its file's name ("chrome.exe").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Process {
    pub id: u32,
    pub exe: String,
}

/// The ids of the running programs called `name`, lowest first: the order
/// PowerShell's Get-Process gave them in, of which the first with a window
/// was taken.
pub fn processes_named(processes: &[Process], name: &str) -> Vec<u32> {
    let mut ids: Vec<u32> = processes
        .iter()
        .filter(|process| {
            // A process's name is its file's without ".exe".
            let exe = process.exe.as_str();
            let stem = if ends_with(exe, ".exe") {
                &exe[..exe.len() - 4]
            } else {
                exe
            };
            stem.to_lowercase() == name.to_lowercase()
        })
        .map(|process| process.id)
        .collect();
    ids.sort_unstable();
    ids
}

/// A window, by its handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window(pub isize);

/// Windows, as far as the launcher needs it: one method per system call, so
/// the order they are made in is decided (and tested) here.
pub trait WindowsDesktop {
    /// What a .lnk holds; empty when it is not there.
    fn shortcut(&self, path: &str) -> Shortcut;
    fn processes(&self) -> Vec<Process>;
    /// The main window of a process: its first visible window that no other
    /// window owns.
    fn main_window(&self, process: u32) -> Option<Window>;
    fn is_minimized(&self, window: Window) -> bool;
    fn restore(&self, window: Window);
    /// One key event: down, or up.
    fn key(&self, code: u8, up: bool);
    fn set_foreground(&self, window: Window) -> bool;
    fn current_thread(&self) -> u32;
    /// The thread of the window in front; 0 when there is none.
    fn foreground_thread(&self) -> u32;
    fn attach_input(&self, from: u32, to: u32, attach: bool) -> bool;
    fn bring_to_top(&self, window: Window);
    /// Starts `target` as a double-click does (ShellExecute); the system's
    /// words on failure.
    fn start(&self, target: &str) -> Result<(), String>;
}

/// Restores a window and brings it to the front; whether Windows let it.
pub fn bring_forward(desktop: &dyn WindowsDesktop, window: Window) -> bool {
    if desktop.is_minimized(window) {
        desktop.restore(window);
    }
    // Windows lets a program take the foreground only if it sent the last
    // input. A tap of VK 0xE8, a key no keyboard has (AutoHotkey uses it for
    // the same reason), earns that without doing anything: Alt, the usual
    // choice, opens the menu bar of the app in front.
    desktop.key(UNASSIGNED_KEY, false);
    desktop.key(UNASSIGNED_KEY, true);
    let mut front = desktop.set_foreground(window);
    if !front {
        // Second try: borrow the input queue of the window in front, which may
        // always hand the foreground on.
        let me = desktop.current_thread();
        let other = desktop.foreground_thread();
        if other != 0 && other != me && desktop.attach_input(me, other, true) {
            desktop.bring_to_top(window);
            front = desktop.set_foreground(window);
            desktop.attach_input(me, other, false);
        }
    }
    front
}

/// What a launch on Windows ended up doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launched {
    BroughtForward,
    Started,
}

/// Brings the target's window forward if its program runs and has one,
/// else starts it.
pub fn launch_on_windows(desktop: &dyn WindowsDesktop, target: &str) -> Result<Launched, String> {
    if let Plan::Focus(name) = windows_plan(target, |path| desktop.shortcut(path)) {
        let running = processes_named(&desktop.processes(), &name)
            .into_iter()
            .find_map(|process| desktop.main_window(process));
        // If Windows still says no, start the shortcut as the Start Menu would:
        // most apps run one copy and come forward themselves when started again
        // (Windows allows them), and at worst one opens another window, which
        // beats a button that seems to do nothing.
        if running.is_some_and(|window| bring_forward(desktop, window)) {
            return Ok(Launched::BroughtForward);
        }
    }
    // ShellExecute, as a double-click does.
    desktop.start(target).map(|()| Launched::Started)
}

// ------------------------------------------------------------------ macOS

/// Whether a path names an application bundle, which is opened as an
/// application; anything else is opened as a file, with what opens it.
pub fn is_mac_bundle(target: &str) -> bool {
    target.trim_end_matches('/').ends_with(".app")
}

// ------------------------------------------------------------------ Linux

/// Whether a launch target is a desktop entry; anything else is handed to
/// the desktop to open, as on a Mac.
pub fn is_desktop_file(target: &str) -> bool {
    target.ends_with(".desktop")
}

/// A program to start: its command line and the folder to start it in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub command: Vec<String>,
    pub dir: Option<String>,
}

/// The program a desktop entry starts: its Exec line with the field codes
/// filled in, in its Path folder, inside a terminal if it says Terminal=true.
/// `text` is the file's content and `file` where it is; `terminal` finds
/// the terminal to use, and is only asked when one is needed.
pub fn desktop_program(
    text: &str,
    file: &str,
    locales: &[String],
    terminal: impl FnOnce() -> Option<String>,
) -> Result<Program, UserError> {
    let no_command = || UserError::new(say("server.launch.noCommand"));
    let entry = DesktopEntry::parse(text);
    let exec = entry.string("Exec").ok_or_else(no_command)?;
    let fields = ExecFields {
        icon: entry.localized("Icon", locales),
        name: entry.localized("Name", locales).unwrap_or_default(),
        file: file.to_string(),
    };
    let arguments = split_exec(&exec).map_err(|_| no_command())?;
    let mut command = expand_exec(&arguments, &fields);
    if command.first().is_none_or(|program| program.is_empty()) {
        return Err(no_command());
    }
    if entry.boolean("Terminal") {
        let terminal = terminal().ok_or_else(|| UserError::new(say("server.launch.noTerminal")))?;
        command = in_terminal(&terminal, &command);
    }
    Ok(Program {
        command,
        dir: entry.string("Path").filter(|dir| !dir.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::testing::cases;
    use crate::i18n::{text_of, Said};
    use std::cell::RefCell;

    // --------------------------------------------------------- errors

    #[test]
    fn system_errors_read_as_the_typescript_cleaned_them() {
        let all = cases("cleanPowerShellError.json");
        let plain: Vec<_> = all.iter().filter(|case| case["plain"] == true).collect();
        assert!(plain.len() >= 35, "{} of {} cases", plain.len(), all.len());
        for case in plain {
            assert_eq!(
                clean_system_error(case["input"].as_str().unwrap()),
                case["output"].as_str().unwrap(),
                "{}",
                case["input"]
            );
        }
    }

    /// tests/scripts.test.mjs: "Plain messages pass through".
    #[test]
    fn plain_messages_pass_through() {
        assert_eq!(
            clean_system_error("  The system cannot find the file specified\r\n"),
            "The system cannot find the file specified"
        );
    }

    fn key_of(failure: &Failure) -> String {
        match text_of(failure.as_ref()) {
            Said::Text(text) => text.key,
            Said::Plain(plain) => format!("plain: {plain}"),
        }
    }

    // ---------------------------------------------------- the computer

    #[derive(Default)]
    struct Recorder {
        did: RefCell<Vec<String>>,
        fails: Option<&'static str>,
    }

    impl Recorder {
        fn result(&self, did: String) -> Result<(), String> {
            self.did.borrow_mut().push(did);
            self.fails.map_or(Ok(()), |reason| Err(reason.to_string()))
        }
    }

    impl Computer for Recorder {
        fn launch(&self, target: &str) -> Result<(), Failure> {
            self.result(format!("launch {target}"))
                .map_err(|reason| Box::new(launch_failed(&reason)) as Failure)
        }
        fn open_url(&self, address: &str) -> Result<(), String> {
            self.result(format!("url {address}"))
        }
        fn open_path(&self, path: &str) -> Result<(), String> {
            self.result(format!("path {path}"))
        }
    }

    #[test]
    fn only_web_addresses_are_opened() {
        let computer = Recorder::default();
        for refused in [
            "",
            "   ",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "mailto:a@b.com",
            "steam://run/1",
            "two words",
            "C:\\Windows\\System32\\calc.exe",
        ] {
            let failure = open_url_with(&computer, refused).unwrap_err();
            assert_eq!(key_of(&failure), "server.press.noLink", "{refused}");
        }
        assert!(computer.did.borrow().is_empty());
        open_url_with(&computer, "twitch.tv/x").unwrap();
        open_url_with(&computer, "http://localhost:8787/deck").unwrap();
        open_url_with(&computer, " https://ko-fi.com/hit_here ").unwrap();
        open_url_with(&computer, "192.168.1.5:8080").unwrap();
        assert_eq!(
            *computer.did.borrow(),
            [
                "url https://twitch.tv/x",
                "url http://localhost:8787/deck",
                "url https://ko-fi.com/hit_here",
                "url http://192.168.1.5:8080/"
            ]
        );
    }

    #[test]
    fn failures_keep_the_systems_words() {
        let computer = Recorder {
            fails: Some("  The system cannot find\r\n the file specified.\r\n"),
            ..Recorder::default()
        };
        let failure = open_url_with(&computer, "example.com").unwrap_err();
        assert_eq!(
            key_of(&failure),
            "plain: The system cannot find the file specified."
        );
        let failure = open_path_with(&computer, "/nowhere").unwrap_err();
        assert_eq!(
            key_of(&failure),
            "plain: The system cannot find the file specified."
        );
        // tests/windows.test.mjs: "A missing app is reported in plain words".
        let failure = launch_with(&computer, "C:\\nowhere\\Bob’s ‘missing’ app.lnk").unwrap_err();
        let error = failure.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(error.text.key, "server.launch.failed");
        assert_eq!(
            error.text.vars,
            [(
                "reason".to_string(),
                crate::i18n::TextVar::Str("The system cannot find the file specified.".into())
            )]
        );
        assert_eq!(
            error.message(),
            "Could not open that app. (The system cannot find the file specified.)"
        );
    }

    #[test]
    fn launching_nothing_asks_for_an_app() {
        let computer = Recorder::default();
        let failure = launch_with(&computer, "").unwrap_err();
        assert_eq!(key_of(&failure), "server.press.noApp");
        launch_with(&computer, "/Applications/Safari.app").unwrap();
        open_path_with(&computer, "/tmp/a folder").unwrap();
        assert_eq!(
            *computer.did.borrow(),
            ["launch /Applications/Safari.app", "path /tmp/a folder"]
        );
    }

    // ---------------------------------------------------------- Windows

    #[test]
    fn the_generic_hosts_are_the_typescripts() {
        let all = cases("constants.json");
        let hosts: Vec<&str> = all[0]["output"]
            .as_array()
            .unwrap()
            .iter()
            .map(|host| host.as_str().unwrap())
            .collect();
        assert_eq!(hosts, GENERIC_HOSTS);
    }

    fn link(target: &str, arguments: &str) -> Shortcut {
        Shortcut {
            target: target.to_string(),
            arguments: arguments.to_string(),
        }
    }

    fn plan(target: &str, shortcut: Shortcut) -> String {
        windows_plan(target, |_| shortcut).to_string()
    }

    /// The table of tests/windows.test.mjs ("The launcher would …"), which
    /// ran the script dry on real shortcuts; here on what they held.
    #[test]
    fn the_launcher_would() {
        let tool = "C:\\Windows\\System32\\whoami.exe";
        let update = "C:\\t\\Start Menu ‘test’\\Squirrel\\Update.exe";
        let apps = "C:\\t\\Start Menu ‘test’\\";
        for (name, shortcut, want) in [
            ("Bob’s ‘tool’.lnk", link(tool, ""), "focus whoami"),
            (
                "Chrome - Work profile.lnk",
                link(tool, "--profile-directory=\"Profile 1\""),
                "start arguments",
            ),
            (
                "Console.lnk",
                link("C:\\Windows\\System32\\cmd.exe", ""),
                "start launcher cmd",
            ),
            (
                "Discord.lnk",
                link(update, "--processStart \"Discord.exe\""),
                "focus Discord",
            ),
            (
                "Slack.lnk",
                link(update, "--processStart slack.exe"),
                "focus slack",
            ),
            (
                "Teams.lnk",
                link(
                    update,
                    "--processStart \"Teams.exe\" --process-start-args \"--profile=AAD\"",
                ),
                "start arguments",
            ),
        ] {
            assert_eq!(plan(&format!("{apps}{name}"), shortcut), want, "{name}");
        }
        // A link to a game, a program itself, and a shortcut that is not there.
        let unread = |_: &str| -> Shortcut { panic!("only a .lnk is read") };
        assert_eq!(
            windows_plan(&format!("{apps}Dota 2.url"), unread).to_string(),
            "start not a program"
        );
        assert_eq!(windows_plan(tool, unread).to_string(), "focus whoami");
        assert_eq!(
            plan("C:\\nowhere\\Bob’s missing app.lnk", Shortcut::default()),
            "start not a program"
        );
    }

    /// Replaces "The launcher knows every generic host" (the script held the
    /// list as text): a generic host is never taken for the running app.
    #[test]
    fn a_generic_host_is_never_the_running_app() {
        for host in GENERIC_HOSTS {
            for name in [host.to_string(), host.to_uppercase()] {
                let exe = format!("C:\\Windows\\{name}.exe");
                let want = format!("start launcher {name}");
                assert_eq!(plan("C:\\a.lnk", link(&exe, "")), want);
                assert_eq!(
                    windows_plan(&exe, |_| Shortcut::default()).to_string(),
                    want
                );
            }
        }
        // Squirrel's own Update.exe with nothing to start is a launcher too.
        assert_eq!(
            plan("C:\\a.lnk", link("C:\\x\\Update.exe", "")),
            "start launcher Update"
        );
        assert_eq!(
            plan(
                "C:\\a.lnk",
                link("C:\\x\\Update.exe", "--processStart cmd.exe")
            ),
            "start launcher cmd"
        );
    }

    /// Replaces "Shortcuts with arguments are started, not matched to a window".
    #[test]
    fn shortcuts_with_arguments_are_started() {
        let chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        assert_eq!(plan("C:\\a.lnk", link(chrome, "")), "focus chrome");
        assert_eq!(plan("C:\\a.lnk", link(chrome, "   ")), "focus chrome");
        assert_eq!(plan("C:\\A.LNK", link(chrome, "")), "focus chrome");
        assert_eq!(
            plan("C:\\a.lnk", link(chrome, "--app-id=abc")),
            "start arguments"
        );
        assert_eq!(
            plan("C:\\a.lnk", link(chrome, " -profile x ")),
            "start arguments"
        );
        // Not programs: a document's shortcut, a folder's, one with no target.
        assert_eq!(
            plan("C:\\a.lnk", link("C:\\docs\\notes.txt", "")),
            "start not a program"
        );
        assert_eq!(
            plan("C:\\a.lnk", link("C:\\Games", "")),
            "start not a program"
        );
        assert_eq!(plan("C:\\a.lnk", link("", "")), "start not a program");
        assert_eq!(
            plan("C:\\a.lnk", link("C:\\x\\.exe", "")),
            "start not a program"
        );
        // Neither a shortcut nor a program: started, never read as a shortcut.
        let unread = |_: &str| -> Shortcut { panic!("only a .lnk is read") };
        for target in ["C:\\docs\\notes.txt", "C:\\a.lnk.bak", "steam://run/1", ""] {
            assert_eq!(
                windows_plan(target, unread),
                Plan::Start(Why::NotAProgram),
                "{target}"
            );
        }
        assert_eq!(
            windows_plan("D:\\Tools\\Tool.EXE", unread),
            Plan::Focus("Tool".into())
        );
    }

    /// "Squirrel's Update.exe --processStart X.exe looks for X" and
    /// "--processStart is read quoted and unquoted, and not with more
    /// arguments" (which ran the script's regular expression).
    #[test]
    fn squirrel_shortcuts_look_for_the_program_they_start() {
        assert_eq!(
            squirrel_program("--processStart \"Discord.exe\"").as_deref(),
            Some("Discord.exe")
        );
        assert_eq!(
            squirrel_program("--processStart slack.exe").as_deref(),
            Some("slack.exe")
        );
        assert_eq!(
            squirrel_program("--processStart \"Teams.exe\" --process-start-args \"--profile=AAD\""),
            None
        );
        assert_eq!(
            squirrel_program("  --processstart   \"My App.exe\"  ").as_deref(),
            Some("My App.exe")
        );
        assert_eq!(squirrel_program("--processStart a.exe b"), None);
        assert_eq!(squirrel_program("--processStart"), None);
        assert_eq!(squirrel_program("--processStart "), None);
        assert_eq!(squirrel_program("--processStartx.exe"), None);
        assert_eq!(squirrel_program("x --processStart a.exe"), None);
        assert_eq!(squirrel_program("--processStart \"\""), Some("\"\"".into()));
        assert_eq!(
            squirrel_program("--processStart \"open.exe").as_deref(),
            Some("\"open.exe")
        );
        assert_eq!(squirrel_program(""), None);
        // Only Update.exe is read this way.
        assert_eq!(
            plan(
                "C:\\a.lnk",
                link("C:\\x\\update.EXE", "--processStart \"Discord.exe\"")
            ),
            "focus Discord"
        );
        assert_eq!(
            plan(
                "C:\\a.lnk",
                link("C:\\x\\Updater.exe", "--processStart \"Discord.exe\"")
            ),
            "start arguments"
        );
        assert_eq!(
            plan(
                "C:\\a.lnk",
                link("C:\\x\\Update.exe", "--processStart \"notes.txt\"")
            ),
            "start not a program"
        );
    }

    #[test]
    fn running_programs_are_found_by_name() {
        let processes: Vec<Process> = [
            (900, "chrome.exe"),
            (12, "System"),
            (300, "Chrome.EXE"),
            (40, "chromedriver.exe"),
            (50, "chrome"),
            (60, "chrome.exe.bak"),
        ]
        .into_iter()
        .map(|(id, exe)| Process {
            id,
            exe: exe.to_string(),
        })
        .collect();
        assert_eq!(processes_named(&processes, "chrome"), [50, 300, 900]);
        assert_eq!(processes_named(&processes, "CHROME"), [50, 300, 900]);
        assert_eq!(processes_named(&processes, "system"), [12]);
        assert!(processes_named(&processes, "firefox").is_empty());
    }

    /// A Windows that writes down every call and answers as told.
    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<String>>,
        shortcut: Shortcut,
        processes: Vec<(u32, &'static str)>,
        /// The processes that have a window; its handle is the id times ten.
        windowed: Vec<u32>,
        minimized: bool,
        /// What SetForegroundWindow answers, call by call; false after.
        foreground: RefCell<Vec<bool>>,
        front_thread: u32,
        attaches: bool,
        start_fails: Option<&'static str>,
    }

    impl Fake {
        fn did(&self, call: impl Into<String>) {
            self.calls.borrow_mut().push(call.into());
        }
        fn calls(&self) -> String {
            self.calls.borrow().join(", ")
        }
    }

    impl WindowsDesktop for Fake {
        fn shortcut(&self, path: &str) -> Shortcut {
            self.did(format!("shortcut {path}"));
            self.shortcut.clone()
        }
        fn processes(&self) -> Vec<Process> {
            self.processes
                .iter()
                .map(|(id, exe)| Process {
                    id: *id,
                    exe: exe.to_string(),
                })
                .collect()
        }
        fn main_window(&self, process: u32) -> Option<Window> {
            self.did(format!("window of {process}"));
            self.windowed
                .contains(&process)
                .then_some(Window(process as isize * 10))
        }
        fn is_minimized(&self, _: Window) -> bool {
            self.minimized
        }
        fn restore(&self, window: Window) {
            self.did(format!("restore {}", window.0));
        }
        fn key(&self, code: u8, up: bool) {
            self.did(format!(
                "key {code:#04X} {}",
                if up { "up" } else { "down" }
            ));
        }
        fn set_foreground(&self, window: Window) -> bool {
            self.did(format!("foreground {}", window.0));
            let mut answers = self.foreground.borrow_mut();
            !answers.is_empty() && answers.remove(0)
        }
        fn current_thread(&self) -> u32 {
            7
        }
        fn foreground_thread(&self) -> u32 {
            self.front_thread
        }
        fn attach_input(&self, from: u32, to: u32, attach: bool) -> bool {
            self.did(format!(
                "{} {from} {to}",
                if attach { "attach" } else { "detach" }
            ));
            self.attaches
        }
        fn bring_to_top(&self, window: Window) {
            self.did(format!("top {}", window.0));
        }
        fn start(&self, target: &str) -> Result<(), String> {
            self.did(format!("start {target}"));
            self.start_fails
                .map_or(Ok(()), |reason| Err(reason.to_string()))
        }
    }

    fn chrome() -> Fake {
        Fake {
            shortcut: link("C:\\Chrome\\chrome.exe", ""),
            processes: vec![(30, "chrome.exe"), (20, "chrome.exe"), (10, "other.exe")],
            windowed: vec![30],
            ..Fake::default()
        }
    }

    #[test]
    fn a_running_app_comes_forward_instead_of_starting_again() {
        let desktop = Fake {
            foreground: RefCell::new(vec![true]),
            ..chrome()
        };
        assert_eq!(
            launch_on_windows(&desktop, "C:\\Chrome.lnk"),
            Ok(Launched::BroughtForward)
        );
        // The first process with a window, lowest id first; nothing is started.
        assert_eq!(
            desktop.calls(),
            "shortcut C:\\Chrome.lnk, window of 20, window of 30, key 0xE8 down, key 0xE8 up, foreground 300"
        );
    }

    /// Replaces "No Alt tap: the foreground is earned with an unassigned
    /// key" (which read the script's text).
    #[test]
    fn the_foreground_is_earned_with_an_unassigned_key_not_alt() {
        let desktop = Fake {
            minimized: true,
            foreground: RefCell::new(vec![true]),
            ..Fake::default()
        };
        assert!(bring_forward(&desktop, Window(5)));
        assert_eq!(
            desktop.calls(),
            "restore 5, key 0xE8 down, key 0xE8 up, foreground 5"
        );
        assert_eq!(UNASSIGNED_KEY, 0xE8);
        // 0x12 is Alt.
        assert!(!desktop.calls().contains("0x12"));
    }

    /// Replaces "A refused SetForegroundWindow is retried, then the shortcut
    /// is started".
    #[test]
    fn a_refused_foreground_is_retried_then_the_shortcut_is_started() {
        // Refused, then allowed with the front window's input queue.
        let desktop = Fake {
            foreground: RefCell::new(vec![false, true]),
            front_thread: 9,
            attaches: true,
            ..chrome()
        };
        assert_eq!(
            launch_on_windows(&desktop, "C:\\Chrome.lnk"),
            Ok(Launched::BroughtForward)
        );
        assert!(desktop
            .calls()
            .ends_with("foreground 300, attach 7 9, top 300, foreground 300, detach 7 9"));

        // Refused twice: detached all the same, and the shortcut is started.
        let desktop = Fake {
            front_thread: 9,
            attaches: true,
            ..chrome()
        };
        assert_eq!(
            launch_on_windows(&desktop, "C:\\Chrome.lnk"),
            Ok(Launched::Started)
        );
        assert!(desktop.calls().ends_with(
            "foreground 300, attach 7 9, top 300, foreground 300, detach 7 9, start C:\\Chrome.lnk"
        ));

        // No window in front, this thread's own window in front, or a queue
        // that cannot be borrowed: no second try.
        for (front_thread, attaches, tried) in
            [(0, true, ""), (7, true, ""), (9, false, ", attach 7 9")]
        {
            let desktop = Fake {
                front_thread,
                attaches,
                ..chrome()
            };
            assert_eq!(
                launch_on_windows(&desktop, "C:\\Chrome.lnk"),
                Ok(Launched::Started)
            );
            assert!(
                desktop
                    .calls()
                    .ends_with(&format!("foreground 300{tried}, start C:\\Chrome.lnk")),
                "{}",
                desktop.calls()
            );
        }
    }

    /// Replaces "The dry run stops before touching any window": what is not
    /// matched to a window touches none.
    #[test]
    fn what_is_not_running_or_not_matched_is_started() {
        // Running, but with no window.
        let desktop = Fake {
            windowed: vec![],
            ..chrome()
        };
        assert_eq!(
            launch_on_windows(&desktop, "C:\\Chrome.lnk"),
            Ok(Launched::Started)
        );
        assert_eq!(
            desktop.calls(),
            "shortcut C:\\Chrome.lnk, window of 20, window of 30, start C:\\Chrome.lnk"
        );
        // With arguments: no process is looked at, even though one runs.
        let desktop = Fake {
            shortcut: link("C:\\Chrome\\chrome.exe", "--profile-directory=Work"),
            ..chrome()
        };
        assert_eq!(
            launch_on_windows(&desktop, "C:\\Work.lnk"),
            Ok(Launched::Started)
        );
        assert_eq!(desktop.calls(), "shortcut C:\\Work.lnk, start C:\\Work.lnk");
        // A link to a game is not read as a shortcut at all.
        let desktop = chrome();
        assert_eq!(
            launch_on_windows(&desktop, "C:\\Dota 2.url"),
            Ok(Launched::Started)
        );
        assert_eq!(desktop.calls(), "start C:\\Dota 2.url");
        // What Windows says when it cannot start it comes back.
        let desktop = Fake {
            start_fails: Some("The system cannot find the file specified."),
            ..Fake::default()
        };
        assert_eq!(
            launch_on_windows(&desktop, "C:\\nowhere\\gone.lnk"),
            Err("The system cannot find the file specified.".to_string())
        );
    }

    // ------------------------------------------------------------ macOS

    #[test]
    fn bundles_are_opened_as_applications() {
        assert!(is_mac_bundle("/Applications/Safari.app"));
        assert!(is_mac_bundle("/Applications/Safari.app/"));
        assert!(!is_mac_bundle(
            "/Applications/Safari.app/Contents/MacOS/Safari"
        ));
        assert!(!is_mac_bundle("/Users/ann/notes.txt"));
        assert!(!is_mac_bundle("/Applications/Upper.APP"));
    }

    // ------------------------------------------------------------ Linux

    fn program(text: &str, terminal: Option<&str>) -> Result<Program, String> {
        let locales = vec!["es".to_string()];
        desktop_program(
            &format!("[Desktop Entry]\n{text}"),
            "/usr/share/applications/app.desktop",
            &locales,
            || terminal.map(str::to_string),
        )
        .map_err(|error| error.text.key)
    }

    fn command(text: &str) -> Vec<String> {
        program(text, None).expect("a program").command
    }

    #[test]
    fn a_desktop_entry_says_what_to_run() {
        assert!(is_desktop_file("/usr/share/applications/firefox.desktop"));
        assert!(!is_desktop_file("/usr/bin/firefox"));
        assert_eq!(command("Exec=firefox %u\n"), ["firefox"]);
        assert_eq!(
            command("Name=Files\nName[es]=Archivos\nIcon=folder\nExec=\"/opt/My Files/run\" %i --title %c --from %k %F\n"),
            [
                "/opt/My Files/run",
                "--icon",
                "folder",
                "--title",
                "Archivos",
                "--from",
                "/usr/share/applications/app.desktop"
            ]
        );
        assert_eq!(
            command("Exec=env GDK_BACKEND=x11 sh -c \"exec app \\\\$HOME\"\n"),
            ["env", "GDK_BACKEND=x11", "sh", "-c", "exec app $HOME"]
        );
        let started = program("Exec=app\nPath=/opt/app\n", None).unwrap();
        assert_eq!(started.dir.as_deref(), Some("/opt/app"));
        assert_eq!(program("Exec=app\nPath=\n", None).unwrap().dir, None);
        assert_eq!(program("Exec=app\n", None).unwrap().dir, None);
    }

    #[test]
    fn an_entry_with_nothing_to_run_says_so() {
        for text in [
            "Name=No command\n",
            "Exec=\n",
            "Exec=   \n",
            "Exec=%U\n",
            "Exec=\"\" --flag\n",
            "Exec=app \"unclosed\n",
            "DBusActivatable=true\n",
        ] {
            assert_eq!(
                program(text, Some("xterm")),
                Err("server.launch.noCommand".to_string()),
                "{text}"
            );
        }
    }

    #[test]
    fn terminal_apps_run_in_a_terminal() {
        assert_eq!(
            program("Exec=htop -d 5\nTerminal=true\n", Some("gnome-terminal"))
                .unwrap()
                .command,
            ["gnome-terminal", "--", "htop", "-d", "5"]
        );
        assert_eq!(
            program("Exec=htop\nTerminal=true\n", None),
            Err("server.launch.noTerminal".to_string())
        );
        // Not asked for when the entry needs none.
        let unasked = || -> Option<String> { panic!("no terminal is needed") };
        let plain = desktop_program(
            "[Desktop Entry]\nExec=app\nTerminal=false\n",
            "f",
            &[],
            unasked,
        );
        assert_eq!(plain.unwrap().command, ["app"]);
    }

    #[test]
    fn the_new_messages_are_in_both_languages() {
        for code in ["en", "es"] {
            for key in ["server.launch.noCommand", "server.launch.noTerminal"] {
                let said = crate::i18n::render(&Said::Text(say(key)), code);
                assert!(said != key && !said.is_empty(), "{code}: {key}");
            }
        }
        assert_ne!(
            crate::i18n::render(&Said::Text(say("server.launch.noTerminal")), "en"),
            crate::i18n::render(&Said::Text(say("server.launch.noTerminal")), "es")
        );
    }
}
