//! Windows: the system calls of the launcher. What they are made for, and in
//! which order, is decided in launch.rs (`launch_on_windows`, `bring_forward`);
//! each method here is one call, or one small loop of them.
use std::ffi::c_void;

use windows::core::{Interface, BOOL, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, STGM_READ,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
};
use windows::Win32::UI::Shell::{
    IShellLinkW, ShellExecuteExW, ShellLink, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC,
    SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindowAsync, GW_OWNER, SW_RESTORE,
    SW_SHOWNORMAL,
};

use super::launch::{
    launch_failed, launch_on_windows, Computer, Failure, Process, Shortcut, Window, WindowsDesktop,
};
use super::System;

/// COM on this thread, for as long as this lives: reading a shortcut and
/// ShellExecute both need it.
struct Com {
    ours: bool,
}

impl Com {
    fn new() -> Com {
        // SAFETY: may be called on any thread, any number of times.
        let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        // A thread that already has COM in another mode keeps it, and it is
        // not ours to close.
        Com {
            ours: result.is_ok(),
        }
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.ours {
            // SAFETY: pairs with the CoInitializeEx that succeeded on this thread.
            unsafe { CoUninitialize() };
        }
    }
}

/// The text in a buffer Windows filled, up to its final zero.
fn text(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

fn handle(window: Window) -> HWND {
    HWND(window.0 as *mut c_void)
}

/// What a .lnk holds, read the way the Start Menu does (IShellLink).
fn read_shortcut(path: &str) -> windows::core::Result<Shortcut> {
    let mut target = [0u16; 1024];
    let mut arguments = [0u16; 8192];
    // SAFETY: COM is initialised on this thread (the caller holds a `Com`),
    // the interfaces are released when they go out of scope, and each buffer
    // is passed with its own length.
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        file.Load(&HSTRING::from(path), STGM_READ)?;
        link.GetPath(&mut target, std::ptr::null_mut(), 0)?;
        link.GetArguments(&mut arguments)?;
    }
    Ok(Shortcut {
        target: text(&target),
        arguments: text(&arguments),
    })
}

/// What EnumWindows is looking for, and what it found.
struct Search {
    process: u32,
    found: Option<Window>,
}

/// Called by EnumWindows for each top-level window: stops at the first one
/// of the process that is visible and that no window owns, which is what
/// .NET (and so the PowerShell this replaces) called a process's main window.
unsafe extern "system" fn visit(window: HWND, parameter: LPARAM) -> BOOL {
    // SAFETY: `parameter` is the `Search` that `main_window` passed, which
    // outlives the EnumWindows call and is used by nothing else meanwhile.
    let search = unsafe { &mut *(parameter.0 as *mut Search) };
    let mut process = 0u32;
    // SAFETY: `window` is a handle EnumWindows just gave; the calls only read.
    let main = unsafe {
        GetWindowThreadProcessId(window, Some(&mut process));
        process == search.process
            && GetWindow(window, GW_OWNER).is_err()
            && IsWindowVisible(window).as_bool()
    };
    if main {
        search.found = Some(Window(window.0 as isize));
    }
    BOOL::from(!main)
}

struct Win32;

impl WindowsDesktop for Win32 {
    fn shortcut(&self, path: &str) -> Shortcut {
        // A shortcut that is not there reads as an empty one, as it did for
        // WScript.Shell: it is then started, and Windows says what is wrong.
        read_shortcut(path).unwrap_or_default()
    }

    fn processes(&self) -> Vec<Process> {
        let mut processes = Vec::new();
        // SAFETY: the snapshot handle is closed below; the entry is a plain
        // structure whose size is set as the functions require.
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return processes;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut more = Process32FirstW(snapshot, &mut entry).is_ok();
            while more {
                processes.push(Process {
                    id: entry.th32ProcessID,
                    exe: text(&entry.szExeFile),
                });
                more = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        }
        processes
    }

    fn main_window(&self, process: u32) -> Option<Window> {
        let mut search = Search {
            process,
            found: None,
        };
        // SAFETY: `visit` is only called during this call, with the pointer
        // to `search`, which lives until after it. EnumWindows reports
        // "failure" when the callback stops it early, which is the plan.
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
        }
        search.found
    }

    fn is_minimized(&self, window: Window) -> bool {
        // SAFETY: a handle that is no longer a window answers false.
        unsafe { IsIconic(handle(window)).as_bool() }
    }

    fn restore(&self, window: Window) {
        // SAFETY: as above; the request is only posted to the window.
        unsafe {
            let _ = ShowWindowAsync(handle(window), SW_RESTORE);
        }
    }

    fn key(&self, code: u8, up: bool) {
        let flags = if up {
            KEYEVENTF_KEYUP
        } else {
            KEYBD_EVENT_FLAGS(0)
        };
        // SAFETY: takes plain values.
        unsafe { keybd_event(code, 0, flags, 0) };
    }

    fn set_foreground(&self, window: Window) -> bool {
        // SAFETY: a handle that is no longer a window answers false.
        unsafe { SetForegroundWindow(handle(window)).as_bool() }
    }

    fn current_thread(&self) -> u32 {
        // SAFETY: takes nothing and cannot fail.
        unsafe { GetCurrentThreadId() }
    }

    fn foreground_thread(&self) -> u32 {
        // SAFETY: with no window in front the handle is null and the answer 0.
        unsafe { GetWindowThreadProcessId(GetForegroundWindow(), None) }
    }

    fn attach_input(&self, from: u32, to: u32, attach: bool) -> bool {
        // SAFETY: takes thread ids; one that is gone answers false.
        unsafe { AttachThreadInput(from, to, attach).as_bool() }
    }

    fn bring_to_top(&self, window: Window) {
        // SAFETY: a handle that is no longer a window is an error, ignored.
        unsafe {
            let _ = BringWindowToTop(handle(window));
        }
    }

    fn start(&self, target: &str) -> Result<(), String> {
        shell_execute(target)
    }
}

/// ShellExecute, as a double-click does: a shortcut, a program, a document,
/// a folder or an address is opened with what Windows uses for it. No
/// dialog on failure; what Windows says comes back instead.
fn shell_execute(target: &str) -> Result<(), String> {
    let file = HSTRING::from(target);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
        lpFile: PCWSTR(file.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    // SAFETY: the structure says its own size, `file` outlives the call, and
    // every other field is zero, which each of them allows.
    unsafe { ShellExecuteExW(&mut info) }.map_err(|error| error.message())
}

impl Computer for System {
    fn launch(&self, target: &str) -> Result<(), Failure> {
        let _com = Com::new();
        launch_on_windows(&Win32, target)
            .map(|_| ())
            .map_err(|reason| Box::new(launch_failed(&reason)) as Failure)
    }

    fn open_url(&self, address: &str) -> Result<(), String> {
        let _com = Com::new();
        shell_execute(address)
    }

    fn open_path(&self, path: &str) -> Result<(), String> {
        let _com = Com::new();
        shell_execute(path)
    }
}

/// The intent of tests/windows.test.mjs's launcher section: real shortcuts
/// with curly quotes in their names, read back and planned (its dry runs),
/// then one real run on a shortcut that is not there. No app is started.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::apps::launch::{processes_named, windows_plan};
    use crate::i18n::UserError;
    use std::path::{Path, PathBuf};

    /// Writes a shortcut as WScript.Shell's CreateShortcut did in the test.
    fn make_shortcut(file: &Path, target: &str, arguments: &str) {
        // SAFETY: COM is initialised by the caller; the interfaces are
        // released when they go out of scope.
        unsafe {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).expect("a shell link");
            link.SetPath(&HSTRING::from(target)).expect("the target");
            link.SetArguments(&HSTRING::from(arguments))
                .expect("the arguments");
            let persist: IPersistFile = link.cast().expect("IPersistFile");
            persist
                .Save(&HSTRING::from(file.as_os_str()), true)
                .expect("the shortcut is saved");
        }
    }

    fn system_root() -> PathBuf {
        PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()))
    }

    #[test]
    fn the_launcher_would_on_real_shortcuts() {
        let _com = Com::new();
        let dir = tempfile::tempdir().unwrap();
        let apps = dir.path().join("Start Menu ‘test’");
        std::fs::create_dir_all(apps.join("Squirrel")).unwrap();
        let tool = system_root().join("System32").join("whoami.exe");
        let update = apps.join("Squirrel").join("Update.exe");
        std::fs::copy(&tool, &update).unwrap();
        std::fs::write(
            apps.join("Dota 2.url"),
            "[InternetShortcut]\r\nURL=steam://rungameid/570\r\n",
        )
        .unwrap();
        let tool = tool.to_string_lossy().into_owned();
        let update = update.to_string_lossy().into_owned();
        let cmd = system_root().join("System32").join("cmd.exe");
        let shortcuts = [
            ("Bob’s ‘tool’.lnk", tool.as_str(), "", "focus whoami"),
            (
                "Chrome - Work profile.lnk",
                tool.as_str(),
                "--profile-directory=\"Profile 1\"",
                "start arguments",
            ),
            (
                "Console.lnk",
                cmd.to_str().unwrap(),
                "",
                "start launcher cmd",
            ),
            (
                "Discord.lnk",
                update.as_str(),
                "--processStart \"Discord.exe\"",
                "focus Discord",
            ),
            (
                "Slack.lnk",
                update.as_str(),
                "--processStart slack.exe",
                "focus slack",
            ),
            (
                "Teams.lnk",
                update.as_str(),
                "--processStart \"Teams.exe\" --process-start-args \"--profile=AAD\"",
                "start arguments",
            ),
        ];
        for (name, target, arguments, want) in shortcuts {
            let file = apps.join(name);
            make_shortcut(&file, target, arguments);
            assert!(file.exists(), "{name} is made");
            let read = Win32.shortcut(&file.to_string_lossy());
            assert_eq!(read.arguments, arguments, "{name}");
            assert!(
                read.target.eq_ignore_ascii_case(target),
                "{name}: {}",
                read.target
            );
            let plan = windows_plan(&file.to_string_lossy(), |path| Win32.shortcut(path));
            assert_eq!(plan.to_string(), want, "{name}");
        }
        let plan = |target: &str| windows_plan(target, |path| Win32.shortcut(path)).to_string();
        assert_eq!(
            plan(&apps.join("Dota 2.url").to_string_lossy()),
            "start not a program"
        );
        assert_eq!(plan(&tool), "focus whoami");
        assert_eq!(
            plan("C:\\nowhere\\Bob’s missing app.lnk"),
            "start not a program"
        );
    }

    #[test]
    fn running_programs_and_their_windows_are_read() {
        let processes = Win32.processes();
        assert!(processes.len() > 3, "{} processes", processes.len());
        // This test is one of them, and it has no window of its own to find
        // or a console's; either way the search ends.
        let own = std::process::id();
        assert!(processes.iter().any(|process| process.id == own));
        let _ = Win32.main_window(own);
        // "focus whoami idle": nothing called that is running.
        assert!(processes_named(&processes, "punchboard-no-such-program").is_empty());
        assert_ne!(Win32.current_thread(), 0);
    }

    /// "A missing app is reported in plain words, not CLIXML".
    #[test]
    fn a_missing_app_is_reported_in_plain_words() {
        let failure = System
            .launch("C:\\nowhere\\Bob’s ‘missing’ app.lnk")
            .unwrap_err();
        let error = failure.downcast_ref::<UserError>().expect("a UserError");
        assert_eq!(error.text.key, "server.launch.failed");
        let message = error.message();
        assert!(
            message.starts_with("Could not open that app. (")
                && message.ends_with(')')
                && message.len() > 28,
            "{message}"
        );
        assert!(!message.contains(['\r', '\n', '<']), "{message}");
    }
}
