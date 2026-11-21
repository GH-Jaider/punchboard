//! The computer's volume on Windows, through Core Audio: the main output
//! (the endpoint API) and each application's own (its audio sessions, the
//! mixer Windows shows as "Volume mixer").
//!
//! COM objects belong to the thread that made them, so one thread
//! ([`super::AudioThread`]) initialises COM, owns them and answers one
//! request at a time. It replaces the PowerShell process that compiled a C#
//! bridge to these same calls; what that bridge did, line by line, is here.
//!
//! The app key is the process name without .exe, lower-cased ("chrome"), so a
//! fader keeps working across restarts, and one key covers all of an app's
//! processes: Chrome plays from several.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::Arc;

use windows::core::{Interface, GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::app_volume::{
    friendly_name, own_processes, process_name, session_app, set_every_session, SessionFacts,
    SessionVolume,
};
use super::{float_as_printed, AudioBackend, AudioThread, MakeBackend, SystemApp, ThreadMessages};

/// What each request says when it fails. A failed read of the main volume
/// says "would not change", as the TypeScript's did.
pub const MESSAGES: ThreadMessages = ThreadMessages {
    failed: "server.winVolume.failed",
    no_read: "server.winVolume.noChange",
    no_change: "server.winVolume.noChange",
    no_app_read: "server.winVolume.noAppRead",
    no_app_change: "server.winVolume.noAppChange",
    no_list: "server.winVolume.noList",
    slow_answer: "server.winVolume.slowAnswer",
    helper_stopped: "server.winVolume.helperStopped",
    stopped: "server.winVolume.stopped",
};

/// Windows's volumes. The thread, and COM on it, start with the first request.
pub fn audio_thread() -> AudioThread {
    let make: MakeBackend =
        Arc::new(|| WindowsAudio::open().map(|audio| Box::new(audio) as Box<dyn AudioBackend>));
    AudioThread::new("punchboard-volume", MESSAGES, make)
}

/// COM on this thread, for as long as this lives.
struct Com;

impl Com {
    fn start() -> Result<Com, String> {
        // SAFETY: called once on the audio thread, before any COM call on it,
        // and paired with the CoUninitialize in `drop` on the same thread.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|error| error.message())?;
        Ok(Com)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        // SAFETY: balances the successful CoInitializeEx of `start`, on the
        // thread that made it; every COM object of `WindowsAudio` is declared
        // before `com` and so is released first.
        unsafe { CoUninitialize() };
    }
}

struct WindowsAudio {
    devices: IMMDeviceEnumerator,
    // Last: dropped after `devices`.
    _com: Com,
}

/// One app's session on one output.
struct Session {
    key: String,
    pid: u32,
    volume: ISimpleAudioVolume,
}

/// What `session_app` asks of a session, each a call into Core Audio.
struct Facts<'a>(&'a IAudioSessionControl2);

impl SessionFacts for Facts<'_> {
    fn expired(&self) -> Option<bool> {
        // SAFETY: a COM call on an object the audio thread owns.
        unsafe { self.0.GetState() }
            .ok()
            .map(|state| state == AudioSessionStateExpired)
    }

    fn system_sounds(&self) -> bool {
        // S_OK (0) says it is the system sounds session.
        // SAFETY: a COM call on an object the audio thread owns.
        unsafe { self.0.IsSystemSoundsSession() }.0 == 0
    }

    fn process(&self) -> Option<u32> {
        // A session shared by several processes answers with a success
        // code other than 0 and no one process: it belongs to no app
        // key. The wrapper would call that a success, so the call is
        // made through the table to see the code itself.
        let mut pid = 0u32;
        // SAFETY: the interface's own method, called with its own
        // pointer and a writable u32, as the wrapper does.
        let answered = unsafe {
            (Interface::vtable(self.0).GetProcessId)(Interface::as_raw(self.0), &mut pid)
        };
        (answered.0 == 0).then_some(pid)
    }
}

impl SessionVolume for Session {
    fn set(&self, level: f32) -> Result<(), String> {
        // SAFETY: a COM call on an object the audio thread owns; the
        // context is a GUID that lives for the call.
        unsafe { self.volume.SetMasterVolume(level, &GUID::zeroed()) }
            .map_err(|error| error.message())
    }

    fn read(&self) -> Option<f32> {
        // SAFETY: a COM call on an object the audio thread owns.
        unsafe { self.volume.GetMasterVolume() }.ok()
    }
}

/// The processes running now: each one's program file and its parent.
struct Processes {
    files: HashMap<u32, String>,
    parents: Vec<(u32, u32)>,
}

fn processes() -> Option<Processes> {
    // SAFETY: plain call; the handle it returns is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.ok()?;
    let mut found = Processes {
        files: HashMap::new(),
        parents: Vec::new(),
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: `snapshot` is a live snapshot handle and `entry` a writable
    // PROCESSENTRY32W whose dwSize is set, as both calls require.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let length = entry
            .szExeFile
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(entry.szExeFile.len());
        found.files.insert(
            entry.th32ProcessID,
            String::from_utf16_lossy(&entry.szExeFile[..length]),
        );
        found
            .parents
            .push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: as for Process32FirstW above.
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    // SAFETY: `snapshot` came from CreateToolhelp32Snapshot and is closed once.
    let _ = unsafe { CloseHandle(snapshot) };
    Some(found)
}

/// The full path of a process's program, as UTF-16 with its final 0.
fn program_path(pid: u32) -> Option<Vec<u16>> {
    // SAFETY: plain call; the handle it returns is closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut path = vec![0u16; 32768];
    let mut length = path.len() as u32;
    // SAFETY: `process` is a live handle with the right to be asked this;
    // `path` is `length` writable UTF-16 units, and `length` is updated to
    // how many were written (without the final 0).
    let asked = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    };
    // SAFETY: `process` came from OpenProcess and is closed once.
    let _ = unsafe { CloseHandle(process) };
    asked.ok()?;
    path.truncate(length as usize);
    path.push(0);
    Some(path)
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A value in a version resource: where it is in `data`, and how long.
fn version_value(data: &[u8], name: &str) -> Option<(*const u8, usize)> {
    let name = wide(name);
    let mut value: *mut c_void = std::ptr::null_mut();
    let mut length = 0u32;
    // SAFETY: `data` is a whole version resource as GetFileVersionInfoW
    // filled it, `name` is 0-terminated, and the two out-pointers are
    // writable. The pointer returned points into `data`.
    let found = unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(name.as_ptr()),
            &mut value,
            &mut length,
        )
    };
    (found.as_bool() && !value.is_null() && length > 0)
        .then_some((value as *const u8, length as usize))
}

/// UTF-16 units read from inside `data`, which promises no alignment.
fn units_at(data: &[u8], start: *const u8, count: usize) -> Option<Vec<u16>> {
    let offset = (start as usize).checked_sub(data.as_ptr() as usize)?;
    let bytes = data.get(offset..offset.checked_add(count.checked_mul(2)?)?)?;
    let (pairs, _) = bytes.as_chunks::<2>();
    Some(pairs.iter().map(|pair| u16::from_le_bytes(*pair)).collect())
}

/// The "File description" of a program, as Explorer's Details tab has it
/// (.NET's `FileVersionInfo.FileDescription`).
fn file_description(path: &[u16]) -> Option<String> {
    let file = PCWSTR(path.as_ptr());
    // SAFETY: `path` is 0-terminated and outlives both calls; `data` is
    // `size` writable bytes, the size the first call asked for.
    let data = unsafe {
        let size = GetFileVersionInfoSizeW(file, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(file, None, size, data.as_mut_ptr().cast()).ok()?;
        data
    };
    // The language the file says it is in first, then the ones .NET tries.
    let mut languages: Vec<String> = Vec::new();
    if let Some((start, length)) = version_value(&data, "\\VarFileInfo\\Translation") {
        if let Some(pair) = units_at(&data, start, 2).filter(|_| length >= 4) {
            languages.push(format!("{:04X}{:04X}", pair[0], pair[1]));
        }
    }
    languages.extend(["040904B0", "040904E4", "04090000"].map(str::to_string));
    for language in languages {
        let name = format!("\\StringFileInfo\\{language}\\FileDescription");
        // For a string, the length is in characters.
        let Some((start, length)) = version_value(&data, &name) else {
            continue;
        };
        let Some(units) = units_at(&data, start, length) else {
            continue;
        };
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        return Some(String::from_utf16_lossy(&units[..end]));
    }
    None
}

/// The name an app is listed by (`FriendlyName` in the bridge): its
/// program's description, else its process name; `fallback` when the
/// process cannot be asked (it is gone, or is not ours to ask).
fn name_of(pid: u32, exe_file: Option<&String>, fallback: &str) -> String {
    let (Some(path), Some(exe_file)) = (program_path(pid), exe_file) else {
        return fallback.to_string();
    };
    friendly_name(file_description(&path).as_deref(), process_name(exe_file))
}

fn level(volume: f32) -> f64 {
    float_as_printed(volume.clamp(0.0, 1.0))
}

impl WindowsAudio {
    fn open() -> Result<WindowsAudio, String> {
        let com = Com::start()?;
        // SAFETY: COM is initialised on this thread (`com`), and the class
        // and interface asked for are the system's own device enumerator.
        let devices: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|error| error.message())?;
        Ok(WindowsAudio { devices, _com: com })
    }

    /// The default output's volume control, asked for each time: the
    /// default output can change between two requests.
    fn endpoint(&self) -> windows::core::Result<IAudioEndpointVolume> {
        // SAFETY: COM calls on objects this thread owns, with no pointers
        // of ours beyond the ones the wrappers make.
        unsafe {
            self.devices
                .GetDefaultAudioEndpoint(eRender, eMultimedia)?
                .Activate(CLSCTX_ALL, None)
        }
    }

    /// Every live app session on every active output, not just the default
    /// one: a game or Discord may play to a headset while the rest plays to
    /// the speakers. The system sounds session, sessions that have ended and
    /// those of processes already gone are left out. A computer with no output
    /// (or no audio service) has no sessions, which is not an error.
    fn sessions(&self, files: &HashMap<u32, String>) -> Vec<Session> {
        let mut found = Vec::new();
        // SAFETY (this whole function): COM calls on objects this thread
        // owns; every interface pointer is held by a wrapper that releases
        // it, and nothing borrowed outlives its call.
        let Ok(devices) = (unsafe {
            self.devices
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
        }) else {
            return found;
        };
        let Ok(count) = (unsafe { devices.GetCount() }) else {
            return found;
        };
        for index in 0..count {
            let Ok(device) = (unsafe { devices.Item(index) }) else {
                continue;
            };
            let Ok(manager) =
                (unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) })
            else {
                continue;
            };
            let Ok(sessions) = (unsafe { manager.GetSessionEnumerator() }) else {
                continue;
            };
            let Ok(total) = (unsafe { sessions.GetCount() }) else {
                continue;
            };
            for number in 0..total {
                let Ok(control) = (unsafe { sessions.GetSession(number) }) else {
                    continue;
                };
                let Ok(session) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                // Which sessions are an app's is decided in app_volume.rs.
                let Some((key, pid)) = session_app(&Facts(&session), files) else {
                    continue;
                };
                let Ok(volume) = session.cast::<ISimpleAudioVolume>() else {
                    continue;
                };
                found.push(Session { key, pid, volume });
            }
        }
        found
    }
}

impl AudioBackend for WindowsAudio {
    fn main_volume(&mut self) -> Result<f64, String> {
        let endpoint = self.endpoint().map_err(|error| error.message())?;
        // SAFETY: a COM call on an object this thread owns.
        unsafe { endpoint.GetMasterVolumeLevelScalar() }
            .map(float_as_printed)
            .map_err(|error| error.message())
    }

    fn set_main_volume(&mut self, level: f64) -> Result<f64, String> {
        let endpoint = self.endpoint().map_err(|error| error.message())?;
        // SAFETY: a COM call on an object this thread owns; the context is
        // a GUID that lives for the call.
        unsafe { endpoint.SetMasterVolumeLevelScalar(level as f32, &GUID::zeroed()) }
            .map_err(|error| error.message())?;
        self.main_volume()
    }

    fn app_volume(&mut self, key: &str) -> Result<Option<f64>, String> {
        let files = processes().map(|all| all.files).unwrap_or_default();
        for session in self.sessions(&files) {
            if session.key != key {
                continue;
            }
            // SAFETY: a COM call on an object this thread owns.
            if let Ok(volume) = unsafe { session.volume.GetMasterVolume() } {
                return Ok(Some(level(volume)));
            }
        }
        Ok(None)
    }

    /// Sets every session of every process named `key` (`set_every_session`
    /// in app_volume.rs decides which, and what is answered).
    fn set_app_volume(&mut self, key: &str, wanted: f64) -> Result<Option<f64>, String> {
        let files = processes().map(|all| all.files).unwrap_or_default();
        let sessions = self.sessions(&files);
        let now = set_every_session(
            sessions
                .iter()
                .map(|session| (session.key.as_str(), session)),
            key,
            wanted as f32,
        )?;
        Ok(now.map(level))
    }

    /// Every app with an audio session, leaving out the companion and
    /// everything it started: they are Punchboard itself, not apps to offer.
    fn list_apps(&mut self) -> Result<Vec<SystemApp>, String> {
        let running = processes();
        let own = std::process::id();
        let skip = match &running {
            Some(all) => own_processes(own, &all.parents),
            None => HashSet::from([own]),
        };
        let files = running.map(|all| all.files).unwrap_or_default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut apps = Vec::new();
        for session in self.sessions(&files) {
            if skip.contains(&session.pid)
                || session.key == "punchboard"
                || seen.contains(&session.key)
            {
                continue;
            }
            // SAFETY: a COM call on an object this thread owns.
            let Ok(volume) = (unsafe { session.volume.GetMasterVolume() }) else {
                continue;
            };
            seen.insert(session.key.clone());
            apps.push(SystemApp {
                name: name_of(session.pid, files.get(&session.pid), &session.key),
                key: session.key,
                level: level(volume),
            });
        }
        Ok(apps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// tests/windows.test.mjs, "app volumes": the real Core Audio mixer. A
    /// machine with no sound device (CI) may well list nothing, but the list
    /// must come back without an error, with keys as faders store them. The
    /// app asked about below cannot exist, so no session's volume is ever
    /// set: "The volume bridge compiles and lists the apps playing sound",
    /// "Punchboard's own processes are not offered", "An app that is not
    /// there reads as unknown". (The friendly message a write to it ends in
    /// is app_volume.rs's, tested there and by tests/app-volume.test.mjs.)
    #[test]
    fn the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there() {
        const NO_SUCH_APP: &str = "punchboard-test-no-such-app";
        let mut audio = WindowsAudio::open().expect("Core Audio opens");
        let apps = audio.list_apps().expect("the list of apps playing sound");
        for app in &apps {
            assert_eq!(app.key, app.key.to_lowercase(), "{}", app.key);
            assert!(!app.key.ends_with(".exe"), "{}", app.key);
            assert!(
                (0.0..=1.0).contains(&app.level),
                "{}: {}",
                app.key,
                app.level
            );
            assert!(!app.key.starts_with("punchboard"), "{}", app.key);
        }
        assert_eq!(audio.app_volume(NO_SUCH_APP), Ok(None));
        assert_eq!(audio.set_app_volume(NO_SUCH_APP, 0.5), Ok(None));
    }
}
