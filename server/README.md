# The companion

This crate is the program that runs on the computer: it serves the Control Center
and the decks (`../public`, built from `../src/client`), pairs devices, and does what
their buttons ask: keys, apps, links, sounds, volumes, the pointer, OBS. The desktop
app (`../src-tauri`) ships it as a sidecar named `punchboard-server`; `npm start` runs
it from here.

It replaced a companion written in TypeScript for Node, and was ported to answer
exactly as that one did, so decks, paired devices, sounds and settings made before
keep working. Where a comment or a test's name says "the TypeScript", it means that
companion (gone from the tree; its answers live on in the frozen fixtures) or the
code still shared with the browser in `../src/shared`. `../docs/rust-port-test-map.md`
says which test here took over each check the Node companion's tests made.

## The process

The companion is configured through its environment, and talks to whoever started
it over stdout and stdin.

| Variable | What it does |
|---|---|
| `PUNCHBOARD_DATA_DIR` | Where decks, devices, sounds and settings live, instead of the user's own folder (`paths.rs` says where that is on each system). |
| `PUNCHBOARD_APP_DIR` | The folder that holds `public/`. Without it, the nearest folder above the binary that has one. |
| `PUNCHBOARD_PORT` | The port for this run, instead of the saved one (8787 at first). |
| `PUNCHBOARD_NO_OPEN=1` | Do not open the Control Center in the browser at start. |
| `PUNCHBOARD_DESKTOP=1` | Run for the desktop app (and the tests): also print the two lines below, and stop on `quit`. |
| `PUNCHBOARD_LOCALE` | The system's languages, most wanted first (`es-CO,en`), when the app knows them better than `LANG` does. |
| `PUNCHBOARD_LOCALES_DIR` | Another folder of locale files than `public/locales` (tests). |
| `PUNCHBOARD_VERSION` | The version to report; from the source, `package.json`'s. |

At start it prints where the Control Center is and a pairing QR code, then opens the
Control Center in the browser. With `PUNCHBOARD_DESKTOP=1` it also prints
`PUNCHBOARD_LANGUAGE <code>` (and again when the language changes) and
`PUNCHBOARD_READY <port>` once it listens, and it stops when `quit` arrives on stdin
or stdin closes. SIGINT and SIGTERM (Ctrl+C) always stop it. Every stop is a clean
one: sounds end and pending saves are written.

On disk it keeps `config.json`, `devices.json`, `decks/library.json` (with `.bak` and
daily copies in `decks/backups`), `sounds/` and `cache/`, in the same shapes the Node
companion wrote, legacy migration included.

## The modules

| Module | What it holds |
|---|---|
| `main.rs`, `server.rs` | The program: start-up, the routes and who may call them, the trackpad socket, shutdown. |
| `http.rs` | Errors, JSON replies, request bodies, static files. |
| `auth.rs`, `sign.rs` | Pairing codes, paired devices, signed requests (`sign.rs` is the twin of `src/shared/sign.ts`). |
| `i18n.rs`, `translate.rs` | The locale files, `say("key")`, `UserError`, and wording a reply in the asker's language. |
| `model/` | The deck model, the twin of `src/shared`: types, normalising, limits, keys, icons, themes, starter decks, and `model::js` (JavaScript's own number and string rules). |
| `library.rs`, `store.rs`, `config.rs`, `paths.rs` | The deck library, crash-safe JSON files, settings, and where everything lives. |
| `events.rs` | The live state pushed to every page over server-sent events. |
| `actions.rs` | Running a button's steps. |
| `keys/` | Key combinations and music keys. |
| `pointer/`, `touch_trace.rs` | The trackpad: pointer, scrolling, gestures; and the recorded traces. |
| `audio/` | Playing sounds (`player.rs`), the computer's volume and each app's (`volume.rs`, `app_volume.rs`, `app_levels.rs`). |
| `sounds.rs` | The eight sound slots on disk. |
| `apps/` | Listing installed apps, launching one or bringing it forward, opening links and files. |
| `obs/` | The obs-websocket client, the connection kept up, and what OBS is doing as the decks show it. |
| `google_icons.rs` | Google's Material Symbols, fetched and cached. |
| `net.rs`, `port.rs`, `latest_wins.rs` | Addresses, finding a port, one write at a time with the newest winning. |
| `test_system.rs` | The stand-in for the computer that tests use (below). |

Inside `keys/`, `pointer/`, `audio/` and `apps/`, `mod.rs` and the files not named
after a system decide; `mac.rs`, `windows.rs`, `linux.rs` (or `*_mac.rs`, …) make that
system's calls.

## Rules worth keeping

1. **Deciding is apart from doing.** What to do (which key events, which volume,
   which file) is a pure function with unit tests, the same on every system. Doing it
   is a thin call into the system behind a trait, so a test can put a recorder there.
2. **Three systems.** macOS, Windows and Linux, behind `#[cfg(target_os = "…")]` in
   the files named after them. A dependency must build on all three and must not
   compile C for macOS or Windows, so `cargo check --target x86_64-pc-windows-msvc`
   works from a Mac; it goes in the right `[target.'cfg(…)'.dependencies]` table.
3. **Native, not scripted.** No `osascript`, PowerShell or helper process where the
   system has an API. The one exception: the volume of Music and Spotify on macOS,
   which only AppleScript reaches.
4. **No `unwrap()` on anything from outside** (files, the network, system calls). A
   failure becomes an error the caller can show: a `UserError` made with
   `say("server.…")`, worded in the asker's language when sent. Words for people
   live in `public/locales/*.json`, never here; `tests/i18n-literals.mjs` checks, and
   its `ALLOWED` list says what rightly stays English (log lines, the system's own
   reasons).
5. **JSON goes through `store::stringify`** (or `stringify_pretty`,
   `write_json_atomic`), never `serde_json::to_string`: they print numbers and order
   keys the way JavaScript does, which the pages, the signatures and the files on
   disk depend on.
6. **Same answers as before.** Every route, status, header, JSON field and error
   text is what the pages and paired devices already expect. Change one on purpose,
   with the client, or not at all.

## Tests

- `cargo test` here: unit tests beside the code.
- `npm test` at the root: builds this crate in debug, starts it and talks to it over
  HTTP (`tests/*.test.mjs`). `PUNCHBOARD_BIN=<path>` tests another build instead.
- **Fixtures** (`../tests/fixtures`, see its README): `{ input, output }` cases the
  tests here read and must answer the same. The ones made from `src/shared` are
  live (`npm run fixtures` writes them again, and CI checks they come out as
  committed), which is what keeps this crate's twin of the shared code from
  drifting. The rest are frozen records of what the Node companion answered.

### Tests never touch the real computer

Three variables turn the system calls into files:

| Variable | Effect |
|---|---|
| `PUNCHBOARD_POINTER_LOG=<file>` | Pointer commands are appended to the file, one a line, and the mouse stays put: `m DX DY` move, `s DX DY` scroll, `c left\|right` click, `d` / `u` button down / up, `z STEPS` zoom, `k CODE FLAGS` (macOS) or `k CODE,CODE…` a gesture's shortcut, `p PHASE MAGNIFICATION` (macOS) or `pinch PHASE MAGNIFICATION` a pinch, `app` the launcher. |
| `PUNCHBOARD_KEYS_LOG=<file>` | Key events are appended to the file and no key is pressed: `mac down\|up CODE FLAGS`, `media down\|up KEY`, `scan SCAN FLAGS`, `vk VK FLAGS`, `evdev down\|up CODE`, `wait MS` (`keys/mod.rs`, at `LogSink`, says what each number is). |
| `PUNCHBOARD_TEST_SYSTEM=<folder>` | Replaces the rest of the computer: nothing is played, set, started or opened. What would have been done is written into the folder, and the volumes shown are read from it. Keys and pointer go to `keys.log` and `pointer.log` there unless the two variables above name other files. |

The files of `PUNCHBOARD_TEST_SYSTEM` (`test_system.rs` is the code, and says the same):

| File | What it holds |
|---|---|
| `sounds.jsonl` | What the sound output was asked, one JSON object a line: `{"play":{"id":3,"file":"…/sound-4.wav","gain":0.25}}`, `{"gain":0.5}`, `{"stop":3}`, `{"close":true}`. A sound "plays" until it is stopped; a missing file fails as on the real output. |
| `opened.jsonl` | `{"launch":"/Applications/Notes.app"}`, `{"url":"https://twitch.tv/x"}`, `{"path":"/some/file"}` |
| `volume.json` | The volumes the companion sees, read at every request and written when a fader sets one: `{"main":0.5,"apps":{"chrome":{"name":"Google Chrome","level":0.4}}}`. Missing: a main volume of 0.5 and no apps. An app that is not listed is not playing. (App faders on Windows and Linux; on macOS only `main` is used.) |
| `volume.jsonl` | Every change asked: `{"main":0.3}`, `{"app":"chrome","level":0.2}` |
| `mac-apps.json` | macOS only: Music and Spotify by bundle id, as the AppleScript would find them: `{"com.spotify.client":{"running":true,"volume":30}}` (`"refuse":true` refuses, as without the Automation permission). Missing file or app: closed. |
| `osascript.jsonl` | macOS only: every script that would have run, one JSON string a line. None is run. |

`tests/companion.mjs` starts every companion with a throwaway data folder, a spare
port, `PUNCHBOARD_NO_OPEN=1`, `PUNCHBOARD_POINTER_LOG` and
`PUNCHBOARD_TEST_SYSTEM=<data folder>/test-system`. A test that needs the computer in
some state writes these files (passing its own folder in `env: { PUNCHBOARD_TEST_SYSTEM }`
if it must write before the companion starts), as `tests/app-volume.test.mjs` does.

## Building and testing on each system

```sh
cargo test                                         # this system
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo clippy --all-targets --target x86_64-pc-windows-msvc -- -D warnings   # Windows, checked from a Mac or Linux
```

**macOS and Windows** need nothing but Rust. A few tests are `#[ignore]`d because
they press a real key, move the real pointer or open the audio device; each says how
to run it by hand.

**Linux** links ALSA, PulseAudio, X11, udev, D-Bus and OpenSSL:

```sh
sudo apt-get install pkg-config libasound2-dev libpulse-dev libssl-dev \
  libx11-dev libxtst-dev libxi-dev libudev-dev libdbus-1-dev
```

From a Mac or Windows, `scripts/linux.sh <command>` runs a command in a Linux
container (Docker), in `server/`, with the repository mounted and its own build
folder (`server/target/linux`):

```sh
scripts/linux.sh cargo test
scripts/linux.sh sh -c "cargo clippy --all-targets -- -D warnings && cargo test"
scripts/linux.sh sh -c "cd .. && node scripts/test.ts --except designer tour"
```

The container has no display, no sound server and no input devices: the Linux system
calls are compiled and their deciding halves tested there, not exercised. It has no
Chrome either, so the two test files that open the pages (`designer`, `tour`) are
left out there; CI's Linux job runs them.

`npm run build:server` builds the release binary for the desktop app and puts it
where Tauri expects a sidecar (`scripts/build-companion.ts`).
