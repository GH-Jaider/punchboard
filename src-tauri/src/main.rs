// Punchboard's desktop shell. The companion itself is the Node server in
// src/server, bundled as server.mjs and run here with a Node binary that
// ships inside the app. This file only starts and stops it, shows the
// Control Center in a window, and keeps an icon in the menu bar.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::Write;
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// Passed when the app starts at login: stay in the menu bar, no window.
const HIDDEN_ARG: &str = "--hidden";

#[derive(Default)]
struct Companion {
    child: Mutex<Option<CommandChild>>,
    port: Mutex<Option<u16>>,
    quitting: Mutex<bool>,
    /** The companion's last lines, shown if it stops. */
    recent: Mutex<VecDeque<String>>,
    /** Everything it printed this run, for the next time something goes wrong. */
    log: Mutex<Option<std::fs::File>>,
}

const RECENT_LINES: usize = 40;

/// Keeps a line the companion printed, in the log file and the recent lines.
fn note(app: &AppHandle, line: &str) {
    let state = app.state::<Companion>();
    if let Some(file) = state.log.lock().unwrap().as_mut() {
        let _ = writeln!(file, "{line}");
    }
    let mut recent = state.recent.lock().unwrap();
    recent.push_back(line.to_string());
    while recent.len() > RECENT_LINES {
        recent.pop_front();
    }
}

fn log_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_log_dir().ok().map(|dir| dir.join("companion.log"))
}

/// Replaces whatever the window shows (the starting screen, or a Control
/// Center that can no longer reach its companion) with the problem.
const PROBLEM_PAGE: &str = r#"function (title, details, log) {
  var body = document.body
  body.innerHTML = ""
  body.style.cssText = "margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0e11;color:#a3a9b4;font:15px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
  var box = document.createElement("div")
  box.style.cssText = "max-width:760px;padding:0 24px"
  function add(tag, text, css) { var el = document.createElement(tag); el.textContent = text; if (css) el.style.cssText = css; box.appendChild(el) }
  add("h1", title, "margin:0 0 8px;color:#f1f2f4;font-size:18px")
  add("p", "Quit Punchboard from its icon next to the clock (or in the menu bar) and open it again. If it keeps happening, send the lines below, or the log file, to whoever looks after your Punchboard.")
  add("pre", details || "It printed nothing.", "max-height:50vh;overflow:auto;padding:12px;border-radius:8px;background:#16181d;color:#d7dae0;font:12px ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap")
  if (log) add("p", "Full log: " + log)
  body.appendChild(box)
}"#;

/// The companion stopped on its own: say so in the window, with what it last
/// printed and where the full log is, instead of vanishing.
fn show_problem(app: &AppHandle, status: String) {
    *app.state::<Companion>().port.lock().unwrap() = None;
    open_window(app, "/designer");
    let details = app.state::<Companion>().recent.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
    let log = log_path(app).map(|p| p.display().to_string()).unwrap_or_default();
    let script = format!(
        "({})({}, {}, {})",
        PROBLEM_PAGE,
        serde_json::to_string(&format!("Punchboard's companion stopped ({status}).")).unwrap_or_default(),
        serde_json::to_string(&details).unwrap_or_default(),
        serde_json::to_string(&log).unwrap_or_default()
    );
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The window may still be loading the starting screen.
        for _ in 0..20 {
            tokio_sleep(Duration::from_millis(250)).await;
            if let Some(window) = app.get_webview_window("main") {
                if window.eval(&script).is_ok() {
                    break;
                }
            }
        }
    });
}

/// The menu-bar item that checks for, and then offers, an update.
struct Updates {
    item: MenuItem<tauri::Wry>,
    /// A downloaded update waiting for the person to restart into it.
    ready: Mutex<Option<Ready>>,
    checking: Mutex<bool>,
}

struct Ready {
    version: String,
    /// Windows only: the verified installer, run when the person picks
    /// "Restart to update". Running it quits Punchboard on the spot (the
    /// updater exits the process for the installer), so it must never happen
    /// on its own in the middle of a stream. On macOS the new app is already
    /// in place and this is None: a restart is all that is left.
    installer: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
}

const CHECK_LABEL: &str = "Check for updates…";
/// Checked a little after start, then this often.
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

fn port(app: &AppHandle) -> Option<u16> {
    *app.state::<Companion>().port.lock().unwrap()
}

fn control_center_url(port: u16, page: &str) -> Url {
    Url::parse(&format!("http://localhost:{port}{page}")).expect("a valid local address")
}

/// Shows the Control Center (or the starting screen, until the companion has
/// said which port it is on), creating the window the first time.
fn open_window(app: &AppHandle, page: &str) {
    let target = port(app).map(|port| control_center_url(port, page));
    if let Some(window) = app.get_webview_window("main") {
        if let Some(url) = target {
            go_to(&window, url);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let source = match target {
        Some(url) => WebviewUrl::External(url),
        None => WebviewUrl::App("index.html".into()),
    };
    let downloads = app.path().download_dir().ok();
    let opener = app.clone();
    let built = WebviewWindowBuilder::new(app, "main", source)
        .title("Punchboard")
        .inner_size(1440.0, 900.0)
        // Wider than the Control Center's stacked phone layout (980px and
        // under), which has no place in a desktop window.
        .min_inner_size(1040.0, 640.0)
        // Tauri's own file-drop handling swallows the page's drag and drop on
        // Windows (WebView2), so buttons could not be moved there. The Control
        // Center takes files through its own pickers, never by dropping.
        .disable_drag_drop_handler()
        // "Open deck" and other new-window links belong in the real browser.
        // Only web addresses go out: a page should never get to hand the
        // system a file:// path or another app's URL scheme to open.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                #[allow(deprecated)]
                let _ = opener.shell().open(url.as_str(), None);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        // "Back up" saves to Downloads, next to any earlier backup rather than over it.
        .on_download(move |_webview, event| {
            if let tauri::webview::DownloadEvent::Requested { destination, .. } = event {
                if let Some(folder) = &downloads {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .filter(|n| !n.is_empty() && n != "Unknown")
                        .unwrap_or_else(|| "punchboard-backup.json".to_string());
                    *destination = unique_path(folder, &name);
                }
            }
            true
        })
        .build();
    if let Ok(window) = built {
        keep_running_on_close(&window);
    }
}

/// Takes a window already showing the Control Center to `url` without
/// reloading it: a reload would throw away whatever is half-edited there (an
/// open dialog, a step being typed). Only a different page, or the starting
/// screen, is navigated; "#pair" on the same page just sets the hash, which
/// the Control Center listens for.
fn go_to(window: &WebviewWindow, url: Url) {
    let same_page = window.url().is_ok_and(|current| {
        current.scheme() == url.scheme()
            && current.host_str() == url.host_str()
            && current.port_or_known_default() == url.port_or_known_default()
            && current.path() == url.path()
    });
    if !same_page {
        let _ = window.navigate(url);
        return;
    }
    if let Some(fragment) = url.fragment() {
        let script = format!("location.hash = {}", serde_json::to_string(fragment).unwrap_or_default());
        let _ = window.eval(&script);
    }
}

/// "name.json", or "name (2).json" and so on if that is taken.
fn unique_path(folder: &std::path::Path, name: &str) -> std::path::PathBuf {
    let candidate = folder.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(name);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..).map(|n| folder.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).expect("a free name")
}

/// Closing the window hides it; Punchboard keeps serving decks from the menu bar.
fn keep_running_on_close(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
}

/// Starts the companion and follows what it prints.
fn start_companion(app: &AppHandle, show_window: bool) -> Result<(), Box<dyn std::error::Error>> {
    // Windows hands out the resource folder as \\?\C:\…, a form Node cannot
    // start a module from; dunce turns it back into C:\… where that is safe.
    let resources = dunce::simplified(&app.path().resource_dir()?).to_path_buf();
    let script = resources.join("server.mjs");
    if let Some(path) = log_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        *app.state::<Companion>().log.lock().unwrap() = std::fs::File::create(&path).ok();
    }
    let (mut events, child) = app
        .shell()
        .sidecar("node")?
        .args([script.to_string_lossy().to_string()])
        .env("PUNCHBOARD_APP_DIR", resources.to_string_lossy().to_string())
        .env("PUNCHBOARD_DESKTOP", "1")
        .env("PUNCHBOARD_VERSION", app.package_info().version.to_string())
        .env("PUNCHBOARD_NO_OPEN", "1")
        .spawn()?;
    let pid = child.pid();
    *app.state::<Companion>().child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffered = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buffered.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(end) = buffered.find('\n') {
                        let line: String = buffered.drain(..=end).collect();
                        let line = line.trim();
                        println!("{line}");
                        note(&app, line);
                        if let Some(value) = line.strip_prefix("PUNCHBOARD_READY ") {
                            if let Ok(ready) = value.trim().parse::<u16>() {
                                *app.state::<Companion>().port.lock().unwrap() = Some(ready);
                                if show_window || app.get_webview_window("main").is_some() {
                                    open_window(&app, "/designer");
                                }
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes).to_string();
                    eprint!("{text}");
                    for line in text.lines() {
                        note(&app, line);
                    }
                }
                CommandEvent::Error(error) => note(&app, &format!("error: {error}")),
                CommandEvent::Terminated(status) => {
                    // Stopped on purpose: by Quit, or for an update (which
                    // may have started a new companion since, if installing
                    // failed). Only the current one stopping is a problem.
                    let current = app.state::<Companion>().child.lock().unwrap().as_ref().map(|c| c.pid());
                    if *app.state::<Companion>().quitting.lock().unwrap() || current != Some(pid) {
                        break;
                    }
                    // A Punchboard already running (say, from the starter
                    // script) keeps serving; this app just shows it.
                    let still_served = port(&app)
                        .map(|p| TcpStream::connect_timeout(&([127, 0, 0, 1], p).into(), Duration::from_millis(500)).is_ok())
                        .unwrap_or(false);
                    if !still_served {
                        eprintln!("The companion stopped ({status:?}).");
                        note(&app, &format!("The companion stopped ({status:?})."));
                        show_problem(&app, format!("exit code {}", status.code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())));
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Asks the companion to stop cleanly (sounds, OBS, pending saves), then makes sure.
fn stop_companion(app: &AppHandle) {
    let state = app.state::<Companion>();
    *state.quitting.lock().unwrap() = true;
    let child = state.child.lock().unwrap().take();
    if let Some(mut child) = child {
        let _ = child.write(b"quit\n");
        std::thread::sleep(Duration::from_millis(600));
        let _ = child.kill();
    }
}

/// The updater, set to stop the companion if it ever quits the app itself:
/// on Windows, installing exits the process at once, skipping RunEvent::Exit,
/// and a companion left running would hold node.exe while the installer
/// replaces it.
fn updater(app: &AppHandle) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let handle = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            stop_companion(&handle);
            // What the plugin's own hook does; this one replaces it.
            handle.cleanup_before_exit();
        })
        .build()
}

/// Looks for an update and, if there is one, downloads it in the background
/// (on macOS also putting it in place, which leaves the running app alone);
/// the menu then offers the restart. On Windows nothing is installed until
/// the person picks that. `manual` reports "up to date" and failures in the
/// menu too.
fn check_for_updates(app: &AppHandle, manual: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updates = app.state::<Updates>();
        if updates.ready.lock().unwrap().is_some() || *updates.checking.lock().unwrap() {
            return;
        }
        *updates.checking.lock().unwrap() = true;
        if manual {
            let _ = updates.item.set_text("Checking for updates…");
        }
        let found = match updater(&app) {
            Ok(updater) => updater.check().await,
            Err(error) => Err(error),
        };
        match found {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let _ = updates.item.set_text(format!("Downloading version {version}…"));
                let _ = updates.item.set_enabled(false);
                match download(update).await {
                    Ok(installer) => {
                        *updates.ready.lock().unwrap() = Some(Ready { version: version.clone(), installer });
                        let _ = updates.item.set_text(format!("Restart to update to {version}"));
                    }
                    Err(error) => {
                        eprintln!("Update download failed: {error}");
                        let _ = updates.item.set_text(CHECK_LABEL);
                    }
                }
                let _ = updates.item.set_enabled(true);
            }
            Ok(None) => {
                if manual {
                    let _ = updates.item.set_text("Punchboard is up to date");
                    let item = updates.item.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio_sleep(Duration::from_secs(4)).await;
                        let _ = item.set_text(CHECK_LABEL);
                    });
                }
            }
            Err(error) => {
                eprintln!("Update check failed: {error}");
                if manual {
                    let _ = updates.item.set_text("Could not check (offline?)");
                    let item = updates.item.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio_sleep(Duration::from_secs(4)).await;
                        let _ = item.set_text(CHECK_LABEL);
                    });
                }
            }
        }
        *updates.checking.lock().unwrap() = false;
    });
}

/// Downloads and verifies an update. On Windows the installer is kept for
/// later; elsewhere the new version is put in place now and takes over at
/// the next start.
async fn download(
    update: tauri_plugin_updater::Update,
) -> tauri_plugin_updater::Result<Option<(tauri_plugin_updater::Update, Vec<u8>)>> {
    let bytes = update.download(|_, _| {}, || {}).await?;
    if cfg!(windows) {
        return Ok(Some((update, bytes)));
    }
    update.install(bytes)?;
    Ok(None)
}

/// "Restart to update": stops the companion first (so it saves what is
/// pending, and on Windows lets go of node.exe), then restarts into the new
/// version.
fn restart_to_update(app: &AppHandle) {
    let Some(ready) = app.state::<Updates>().ready.lock().unwrap().take() else {
        return;
    };
    stop_companion(app);
    let Some((update, bytes)) = ready.installer else {
        app.restart();
    };
    // Windows: starts the installer and exits; the installer opens the new
    // version when it is done. Returning means it could not be started.
    if let Err(error) = update.install(bytes) {
        let message = format!("Update {} could not be installed: {error}", ready.version);
        eprintln!("{message}");
        note(app, &message);
        let _ = app.state::<Updates>().item.set_text(CHECK_LABEL);
        // Keep serving decks on this version.
        *app.state::<Companion>().quitting.lock().unwrap() = false;
        if let Err(error) = start_companion(app, false) {
            show_problem(app, format!("could not start again: {error}"));
        }
    }
}

async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Control Center", true, None::<&str>)?;
    let pair = MenuItem::with_id(app, "pair", "Pair a device…", true, None::<&str>)?;
    let login_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Open at login", true, login_enabled, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", CHECK_LABEL, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Punchboard", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &pair, &PredefinedMenuItem::separator(app)?, &login, &update, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    app.manage(Updates { item: update, ready: Mutex::new(None), checking: Mutex::new(false) });

    let login_item = login.clone();
    TrayIconBuilder::with_id("punchboard")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Punchboard")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => open_window(app, "/designer"),
            "pair" => open_window(app, "/designer#pair"),
            "login" => {
                let autolaunch = app.autolaunch();
                let enable = !autolaunch.is_enabled().unwrap_or(false);
                let _ = if enable { autolaunch.enable() } else { autolaunch.disable() };
                let _ = login_item.set_checked(autolaunch.is_enabled().unwrap_or(false));
            }
            "update" => {
                let ready = app.state::<Updates>().ready.lock().unwrap().is_some();
                if ready {
                    restart_to_update(app);
                } else {
                    check_for_updates(app, true);
                }
            }
            "quit" => {
                stop_companion(app);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch brings this one forward instead of starting a second companion.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_window(app, "/designer")))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Companion::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let show_window = !std::env::args().any(|arg| arg == HIDDEN_ARG);
            build_tray(&handle)?;
            if show_window {
                open_window(&handle, "/designer");
            }
            start_companion(&handle, show_window)?;
            // Quietly, a little after start and then every few hours.
            let checker = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(Duration::from_secs(20)).await;
                loop {
                    check_for_updates(&checker, false);
                    tokio_sleep(CHECK_EVERY).await;
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Punchboard could not start");

    app.run(|app, event| match event {
        // Cmd+Q or the Dock's Quit: stop the companion before going.
        RunEvent::ExitRequested { .. } => {
            if !*app.state::<Companion>().quitting.lock().unwrap() {
                stop_companion(app);
            }
        }
        // Clicking the Dock icon with the window hidden shows it again.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => open_window(app, "/designer"),
        _ => {}
    });
}
