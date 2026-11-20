# Porting the companion to Rust

The companion (`src/server`, TypeScript on Node) is being replaced by this crate.
The client (`src/client`) and the code it shares (`src/shared`) stay in TypeScript.

## The goal

A person who updates Punchboard notices nothing except that it is smaller and faster:
their decks, paired devices, sounds and settings keep working, and every button does
what it did. On Linux, which the Node companion never drove, the same features work.

## The contract that must not change

- **The process**: same environment variables (`PUNCHBOARD_DATA_DIR`, `PUNCHBOARD_PORT`,
  `PUNCHBOARD_NO_OPEN`, `PUNCHBOARD_DESKTOP`, `PUNCHBOARD_POINTER_LOG`, `PUNCHBOARD_LOCALE`,
  `PUNCHBOARD_LOCALES_DIR`, `PUNCHBOARD_APP_DIR`, `PUNCHBOARD_VERSION`), the same
  `PUNCHBOARD_READY <port>` and `PUNCHBOARD_LANGUAGE <code>` lines on stdout, `quit` on stdin.
- **HTTP**: every route, status code, header, JSON field and error text. The pages in
  `public/` and the bundles in `public/js` are served unchanged.
- **Files on disk**: `config.json`, `devices.json`, `decks/library.json`, `sounds/`, `cache/`.
  The Rust companion reads what the Node one wrote and writes what the Node one could read,
  including the legacy migration and the backups.
- **Behaviour the TypeScript comments describe.** Those comments are the specification:
  read them, keep the behaviour, and carry the reasoning over as Rust comments.

## Rules

1. **Port faithfully first.** Same validation, same limits, same order of checks, same
   messages. Do not redesign behaviour. If the TypeScript looks wrong, keep it and note
   it under "Open questions" in your final report.
2. **Native, not scripted.** No `osascript`, no PowerShell, no helper processes, where the
   operating system has an API for it. The one accepted exception: the volume of Music
   and Spotify on macOS, which only AppleScript can reach.
3. **Three platforms.** macOS, Windows and Linux, behind `#[cfg(target_os = "...")]` in
   files named `mac.rs`, `windows.rs`, `linux.rs` inside the module. Everything that is
   not a system call is shared and tested once.
4. **Split deciding from doing.** Code that works out *what* to do (which key codes, which
   volume, which file) is a pure function with unit tests. Code that *does* it is a thin
   call into the system behind a trait, so tests can swap in a recorder.
5. **Dependencies** must build on all three platforms and must not compile C for macOS or
   Windows. Add them to `Cargo.toml` under the right `[target.'cfg(...)'.dependencies]`
   table; append, never reorder, because other agents edit that file too.
6. **No `unwrap()` on anything that comes from outside** (files, network, system calls).
   A failure becomes an error the caller can show, in the user's language via `i18n`.
7. **Stay in your files.** Each task lists the files it owns. Other modules are read-only;
   if you need something from one, say so in your report instead of editing it.

## Tests

- `cargo test` in `server/` — unit tests live beside the code (`#[cfg(test)]`).
- **Fixtures**: where a TypeScript function has a Rust twin, a generator
  `tests/fixtures/make-<area>.ts` runs the TypeScript over many inputs and writes
  `tests/fixtures/<area>/*.json` (committed). A Rust test reads them and must produce the
  same output. This is what proves "same as before", and it keeps catching drift later.
- **Black box**: `tests/*.test.mjs` start a companion and talk to it over HTTP. With
  `PUNCHBOARD_BIN=server/target/debug/punchboard-server` they run against this crate.
  The baseline on Node is 629 passing, 0 failing.
- Every assertion in the existing tests that covers code you port must have a Rust
  equivalent, or still pass through the black-box run. List in your report any you dropped
  and why (for example: it asserted the text of a PowerShell script that no longer exists).

## TypeScript and linting

Anything new that is not Rust is TypeScript (`.ts`, which Node runs directly): no new
`.mjs` or `.js` files. Type it properly: no `any`, no `@ts-ignore`.
Rust must pass `cargo clippy --all-targets -- -D warnings` for the files you own, and be
formatted with `cargo fmt` (your own files only: `rustfmt path/to/file.rs`).

## Building without getting in each other's way

Several agents work in this checkout at once. Use your own build folder:
`CARGO_TARGET_DIR=target/<your-task-name> cargo test` (run from `server/`).
Check Windows with `cargo check --target x86_64-pc-windows-msvc` in the same folder.
Do not run `cargo fmt` or `cargo fix` on files you do not own. Do not commit.

## What already exists (read these before writing)

- `src/translate.rs`: `Translate` and `Var`. Code that needs words is handed a `&dyn Translate`.
- `src/i18n.rs`: `say("key").with("name", value)` builds a `Text`; `UserError::new(text)` is the
  error a person is shown; `render(&said, language)` turns it into a sentence. Errors that the
  TypeScript throws as `UserError` (or a subclass) are `UserError` here, or an enum that
  converts into one.
- `src/store.rs`: `write_json_atomic`, `read_json_safe`, and `stringify` / `stringify_pretty`.
  **All JSON that is saved or sent goes through these**, never `serde_json::to_string`: they
  print numbers and order keys the way JavaScript does.
- `src/http.rs`: `HttpError`, `send_json`, `json_body`, `raw_body`, `static_file`.
- `src/latest_wins.rs`: `latest_wins`, `latest_wins_per_key`.
- `src/model/`: the deck types (`Library`, `Profile`, `Button`, `Step`, `Action`, `Fader`…),
  `normalize_*`, `LIMITS`, `model::keys::parse_combo`, `model::js` (JavaScript's own
  `Number()`, `String()`, rounding) and `model::Ids`.
- `src/paths.rs`, `src/config.rs`, `src/port.rs`, `src/net.rs`.

## Linux

`scripts/linux.sh <command>` runs a command in a Linux container, in `server/`, with the
repository mounted (Docker is running). Use your own build folder there too:
`CARGO_TARGET_DIR=/work/server/target/linux-<your-task-name> scripts/linux.sh cargo test <filter>`.
The container has no display, no sound server and no input devices: Linux system calls
can be compiled and their pure halves tested there, not exercised. Say so in your report.
Prefer pure-Rust crates on Linux as well (for example `x11rb`, `evdev`); a crate that needs a
system library is acceptable on Linux only, and you must name the package it needs.

## Where each file goes

| TypeScript | Rust |
|---|---|
| `src/shared/{types,model,actions,colors,themes,links,icons,icon-data,default-glyphs,starter-decks,starter-glyphs,layout,keys}.ts` | `src/model/` |
| `src/server/i18n.ts`, `src/shared/i18n.ts` | `src/i18n.rs` |
| `src/server/{http,store,paths,config,port,net,latest-wins}.ts` | `src/{http,store,paths,config,port,net,latest_wins}.rs` |
| `src/shared/sign.ts`, `src/server/auth.ts` | `src/{sign,auth}.rs` |
| `src/server/{library,google-icons,sounds}.ts` | `src/{library,google_icons,sounds}.rs` |
| `src/server/keys.ts` | `src/keys/` |
| `src/server/pointer.ts`, `helpers/mac-pointer.js`, `src/shared/touchpad/{trace,types}.ts` | `src/pointer/`, `src/touch_trace.rs` |
| `src/server/{player,volume,win-volume,app-volume,app-levels}.ts`, `helpers/mac-player.js` | `src/audio/` |
| `src/server/{obs,obs-state,obs-config}.ts` | `src/obs/` |
| `src/server/{apps,launch,powershell}.ts` | `src/apps/` |
| `src/server/{events,actions,main}.ts` | `src/{events,actions,server}.rs`, `src/main.rs` |
