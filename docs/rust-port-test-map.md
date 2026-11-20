# The Node companion's tests, after the port to Rust

Until the companion was rewritten in Rust (`server/`), it was TypeScript run by Node
(`src/server`), and several files in `tests/` mixed two kinds of check: black-box
ones, which start a companion and talk to it over HTTP, and unit checks that imported
`src/server/*.ts` and called it directly. When `src/server` was deleted the unit
checks went with it. This is the account of every one of them: which Rust test
took it over, or why there is nothing left to test.

The last commit that has `src/server` and the checks as they were is
`74ed04fe609de2324a0b9fb7d6dfca5012268abb`.

Checks that go through a companion, and checks that import only `src/shared` (the
code the browser runs), were left exactly as they were, with the exceptions listed
under "Changed, not removed".

## The numbers

Counted on macOS, where the thirteen files gave 629 passing checks before
(`tests/windows.test.mjs` runs its checks on Windows only: see its own section).

| File | Before | Kept | Removed | of those: a Rust test took over | the mechanism is gone |
|---|---:|---:|---:|---:|---:|
| `tests/actions.test.mjs` | 43 | 43 | 0 | 0 | 0 |
| `tests/app-volume.test.mjs` | 92 | 37 | 55 | 40 | 15 |
| `tests/designer.test.mjs` | 41 | 41 | 0 | 0 | 0 |
| `tests/i18n.test.mjs` | 55 | 55 | 0 | 0 | 0 |
| `tests/library.test.mjs` | 51 | 50 | 1 | 1 | 0 |
| `tests/obs.test.mjs` | 26 | 26 | 0 | 0 | 0 |
| `tests/scripts.test.mjs` | 62 | 5 | 57 | 30 | 27 |
| `tests/security.test.mjs` | 47 | 39 | 8 | 8 | 0 |
| `tests/sounds.test.mjs` | 56 | 26 | 30 | 25 | 5 |
| `tests/touchpad.test.mjs` | 85 | 85 | 0 | 0 | 0 |
| `tests/tour.test.mjs` | 34 | 34 | 0 | 0 | 0 |
| `tests/trackpad.test.mjs` | 37 | 34 | 3 | 3 | 0 |
| `tests/windows.test.mjs` (deleted) | 0 | 0 | 0 | 0 | 0 |
| **Total** | **629** | **475** | **154** | **107** | **47** |

475 kept + 154 removed = 629.

"The mechanism is gone" means the check asserted something about a helper that no
longer exists: the text of a PowerShell or C# script, how a value was quoted on its
way into one, the line protocol spoken with a helper process. The Rust companion
calls the system's APIs in its own process, so there is no script whose text could be
checked and no test could be written for it. Each such row says what took the
mechanism's place and names the nearest Rust test of what the check was protecting.

Three behaviours those checks protected are kept in the Rust code but sit in system
calls that only run on Windows and have **no unit test** of their own. They are marked
in the tables: the system sounds session is left out of the app list, a fader sets
every audio session of its app, and key releases are posted even when Windows refused
the presses.

## Rust tests written for this

| Test | Stands for |
|---|---|
| `audio::player::tests::a_file_is_found_under_a_name_with_typographic_quotes_hash_and_percent` | "PowerShell quoting doubles straight and typographic quotes" and "The Windows player is given a file URI with # and % escaped" (`sounds`), and on Windows "A path with typographic quotes, # and % is found and plays" |
| `keys::windows::tests::every_scan_code_is_that_physical_key_on_the_us_layout` (Windows only) | "Every key's scan code is that physical key (US layout), modifiers the left-hand ones" (`windows`) |
| `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (Windows only) | "The volume bridge compiles and lists the apps playing sound", "Punchboard's own processes are not offered", "An app that is not there reads as unknown" (`windows`) |

The two Windows-only tests were compiled for Windows
(`cargo clippy --all-targets --target x86_64-pc-windows-msvc`) and have not been run:
they run for the first time in CI's Windows job.

One more test changed with a message: `keys::tests::a_refusal_becomes_the_message_the_typescript_gave`
now also covers `KeyFailure::WindowsRefused`, whose words moved to the locale files.

## Changed, not removed

| File | Check | What changed |
|---|---|---|
| `tests/scripts.test.mjs` | "The recorder flags exactly the keys macOS has no code for (F21 to F24)" | It compared the shared `unsendableReason` with the Node companion's `MAC_CODES` table. It now compares it with the list itself (`f21 f22 f23 f24`); the companion's side is `keys::tests::the_recorder_flags_exactly_the_keys_macos_has_no_code_for`. |
| `tests/i18n.test.mjs` | "no interface English left in src/ or the pages" | `tests/i18n-literals.mjs` reads `server/src/**/*.rs` (outside `#[cfg(test)]`) where it read `src/server/*.ts`. The client and the pages are scanned as before. |
| `tests/app-volume.test.mjs` | "Routes (elsewhere): the list is empty, with a note", "Routes (elsewhere): a write is refused in words" | Linux only (not in the 629). They expected "Windows and macOS only"; Linux has a mixer now, so they became four "Routes (Linux)" checks against the stand-in mixer (`volume.json`): the refused levels never reached it, the apps playing are listed, a fader sets its app, a write to an app that is not playing fails with the friendly message and sets nothing. |
| all | `tests/english.mjs` | Makes the shared `t()` speak English from `public/locales/en.json` through `src/shared/i18n.ts`, where it loaded the Node companion's i18n module to do the same. |

## Removed checks, one by one

Rust tests are named as `cargo test` prints them; `a::b::tests::name` is in `server/src/a/b.rs` (or `a/b/mod.rs`).

### `tests/app-volume.test.mjs`: 55 removed (40 taken over, 15 with the mechanism gone)

| Check | Now |
|---|---|
| A list from the bridge is read entry by entry | `audio::app_volume::tests::parse_app_list_matches_the_typescript` (the same input is a case of `volume/parse-app-list.json`) |
| A list that is not JSON is an error in words | `audio::app_volume::tests::parse_app_list_matches_the_typescript` (the same input is a case of `volume/parse-app-list.json`) |
| A read script sets nothing | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| A write script sets the app's volume 0..100 | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| Linux: a write is refused in words | `audio::app_volume::tests::elsewhere_there_is_nothing_to_offer` (for a system that is none of the three; what Linux really does: `audio::app_volume::tests::linux_is_a_mixer_too` and the "Routes (Linux)" checks of this file) |
| Linux: an empty list with a note | `audio::app_volume::tests::elsewhere_there_is_nothing_to_offer` (for a system that is none of the three; what Linux really does: `audio::app_volume::tests::linux_is_a_mixer_too` and the "Routes (Linux)" checks of this file) |
| Mac apps are found by bundle id | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| Mac: a closed app reads as unknown | `audio::app_volume::tests::mac_list_read_and_write` |
| Mac: a closed app's volume is left alone | `audio::app_volume::tests::mac_list_read_and_write` |
| Mac: a drag's levels are coalesced, newest last | `audio::app_volume::tests::mac_a_drags_levels_are_coalesced_newest_last` |
| Mac: a level set reads back | `audio::app_volume::tests::mac_list_read_and_write` |
| Mac: a missing Automation permission is explained | `audio::app_volume::tests::mac_a_missing_automation_permission_is_explained` |
| Mac: a write to a closed app says so, kindly | `audio::app_volume::tests::mac_list_read_and_write` |
| Mac: any other app is refused with the reason | `audio::app_volume::tests::mac_list_read_and_write` |
| Mac: every script sent asks "is running" first | `audio::app_volume::tests::mac_a_drags_levels_are_coalesced_newest_last` |
| Mac: the list offers Music and Spotify, and which is running | `audio::app_volume::tests::mac_list_read_and_write` |
| One app's writes never overlap, and its newest level is set last | `latest_wins::tests::each_key_goes_one_at_a_time_and_keys_do_not_wait_for_each_other` |
| Polling: a change made outside Punchboard goes out once | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "a device connecting starts it, and only changes go out") |
| Polling: a device connecting starts it, reading each app once a round | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "a device connecting starts it, and only changes go out") |
| Polling: a round never undoes a deck write made while it read | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "a round never undoes a deck write made while it read") |
| Polling: an app that closes reads as unknown on the decks | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "a device connecting starts it, and only changes go out") |
| Polling: it starts again with a new app fader | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "it stops when no fader needs it and starts again with a new one") |
| Polling: it stops when no fader needs it | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "it stops when no fader needs it and starts again with a new one") |
| Polling: it stops when the last device leaves | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "it stops when the last device leaves, also in the middle of a round") |
| Polling: nothing is read while no device is connected | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "nothing is read while no device is connected" of `volume/app-levels.json`) |
| Polling: rounds that find nothing new broadcast nothing | `audio::app_levels::tests::the_poll_does_what_the_typescript_did` (scenario "a device connecting starts it, and only changes go out") |
| The Music read script asks "is running" before sending anything | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| The Music write script asks "is running" before sending anything | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| The Spotify read script asks "is running" before sending anything | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| The Spotify write script asks "is running" before sending anything | `audio::app_volume::tests::every_script_asks_is_running_before_sending_anything` |
| The Windows bridge has EnumAudioEndpoints | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has FileDescription | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has GetProcessId | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has IAudioSessionControl2 | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has IAudioSessionEnumerator | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has IAudioSessionManager2 | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has ISimpleAudioVolume | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has InvariantCulture | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has IsSystemSoundsSession | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has app-get  | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has app-set  | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The Windows bridge has list  | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. Nearest: `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did`, `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here). |
| The bridge leaves out Punchboard's own processes | `audio::app_volume::tests::windows_processes_are_named_and_owned_as_the_bridge_did` (`own_processes`) |
| The bridge leaves out the system sounds session | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. The behaviour is kept in `WindowsAudio::sessions` (IsSystemSoundsSession), a system call with **no unit test**. |
| The bridge sets every session of the app, not just the first | **retired with the mechanism**: text of the C# bridge that PowerShell compiled; Core Audio is now called directly (audio/system_windows.rs), so there is no script text to read. The behaviour is kept in `WindowsAudio::set_app_volume` (it loops over every session of the key), a system call with **no unit test**. |
| The bridge's list is plain ASCII JSON | **retired with the mechanism**: the list no longer crosses a pipe as JSON: it is a `Vec<SystemApp>` in the same process. Nearest: `audio::app_volume::tests::the_mixers_list_is_the_typescripts`. |
| Two apps' writes do not wait for each other | `latest_wins::tests::each_key_goes_one_at_a_time_and_keys_do_not_wait_for_each_other` |
| Windows: a drag's levels are coalesced, newest last | `audio::app_volume::tests::windows_a_drags_levels_are_coalesced_newest_last` |
| Windows: a level set reads back | `audio::app_volume::tests::windows_list_read_and_write` |
| Windows: a write to an app with no audio session says so, kindly | `audio::app_volume::tests::windows_list_read_and_write` |
| Windows: an app with no audio session reads as unknown | `audio::app_volume::tests::windows_list_read_and_write` |
| Windows: no app playing gives an empty list with a hint | `audio::app_volume::tests::windows_no_app_playing_gives_an_empty_list_with_a_hint` |
| Windows: the list has every app with a session, by name, with its level | `audio::app_volume::tests::windows_list_read_and_write` |
| Windows: the list leaves out the companion's own processes | `audio::app_volume::tests::windows_list_read_and_write` |
| latestWins still answers with what the write returned | `latest_wins::tests::each_key_goes_one_at_a_time_and_keys_do_not_wait_for_each_other` |

### `tests/sounds.test.mjs`: 30 removed (25 taken over, 5 with the mechanism gone)

| Check | Now |
|---|---|
| "ID3" and nothing else is not an MP3 | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A Mac's decomposed accent stays one letter | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A RIFF header with no chunks is not a WAV | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A WAV with a 100 KB chunk before its format still has a length | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A WAV with a format but no data is not a WAV | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A WAV with its chunks is a WAV | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A frame count (Info header) past a big tag gives the length | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A name that is not encoded is taken as is | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| A sound whose length never shows exits instead of pretending to play | `audio::player::tests::a_file_that_cannot_be_played_is_logged_and_ends_with_no_run_time` |
| An AAC (ADTS) stream is not an MP3 | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| An ID3 tag with no audio after it is not an MP3 | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| An ID3v2.4 tag with a footer is skipped whole | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| An MP3 behind a 300 KB ID3 tag (album art) still has a length | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| An MP3 behind a big tag is an MP3 | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| An MP3's length is read | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| Mac: a helper that dies at start is not respawned on every press | **retired with the mechanism**: there is no helper process (and no afplay to fall back to): sounds are mixed in the companion. What is left of it, an output that cannot start a sound is asked once per press and works again when it can: Nearest: `audio::player::tests::an_output_that_fails_is_asked_once_per_press_and_recovers`. |
| Mac: a press sent to a helper that died at start still plays (through afplay) | **retired with the mechanism**: there is no helper process (and no afplay to fall back to): sounds are mixed in the companion. What is left of it, an output that cannot start a sound is asked once per press and works again when it can: Nearest: `audio::player::tests::an_output_that_fails_is_asked_once_per_press_and_recovers`. |
| Mac: a sound's run time counts from when the helper started it | `audio::player::tests::run_time_counts_from_when_the_output_started_the_sound` |
| Names keep letters of every script | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| Noise with a sync word in it is not an MP3 | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| PowerShell quoting doubles straight and typographic quotes | **retired with the mechanism**: `psQuote` put a path inside a PowerShell script; no script carries a path now. What it protected, a file found under a name with typographic quotes: Nearest: `audio::player::tests::a_file_is_found_under_a_name_with_typographic_quotes_hash_and_percent` (**written now**). |
| Real MP3 frames are an MP3 | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| Slashes, control characters and symbols still go | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| The Windows player is given a file URI with # and % escaped | **retired with the mechanism**: the file URI was for PowerShell's MediaPlayer; the file is now read by its path in this process. What it protected, a file found under a name with # and %: Nearest: `audio::player::tests::a_file_is_found_under_a_name_with_typographic_quotes_hash_and_percent` (**written now**). |
| Two ID3 tags in a row are both skipped | `sounds::tests::the_existing_checks_on_lengths_uploads_and_names` |
| Volume writes never overlap, and the newest level is set last | `latest_wins::tests::writes_never_overlap_and_the_newest_level_is_set_last`, `audio::volume::tests::a_drag_on_the_computers_volume_is_coalesced_newest_last` |
| Windows volume: a slow first start (the compile) does not time the request out | **retired with the mechanism**: nothing is compiled at first use any more (the 8 s compile of the C# bridge was what outlasted the answer timer); opening Core Audio is part of the request. Nearest: `audio::tests::a_system_that_cannot_be_opened_is_tried_again`. |
| Windows volume: an answer for nobody is not handed to the next request | `audio::tests::a_late_answer_is_for_nobody` |
| Windows volume: answers that come back out of order reach the right request | `audio::tests::each_request_gets_its_own_answer` |
| Windows volume: stopping fails a waiting request at once | `audio::tests::stopping_fails_a_waiting_request_at_once` |

### `tests/scripts.test.mjs`: 57 removed (30 taken over, 27 with the mechanism gone)

| Check | Now |
|---|---|
| --processStart is read quoted and unquoted, and not with more arguments | `apps::launch::tests::squirrel_shortcuts_look_for_the_program_they_start` |
| .url shortcuts to a game launcher count as apps | `apps::list::tests::game_shortcuts_are_apps_and_web_pages_are_not` |
| .url shortcuts to web pages and files do not | `apps::list::tests::game_shortcuts_are_apps_and_web_pages_are_not` |
| A refused SetForegroundWindow is retried, then the shortcut is started | `apps::launch::tests::a_refused_foreground_is_retried_then_the_shortcut_is_started` |
| Bottom row: \ then Z to / are 0x2B to 0x35 | `keys::tests::the_scan_codes_follow_the_keyboard_rows` |
| CLIXML errors come back as their plain message | **retired with the mechanism**: unwrapping PowerShell's own packaging (CLIXML, the "At line:" trailer) of an error; the system's errors now arrive as plain text. Nearest: `apps::launch::tests::system_errors_read_as_the_typescript_cleaned_them`. |
| Digit row: 1 to 0, then - and = are 0x02 to 0x0D | `keys::tests::the_scan_codes_follow_the_keyboard_rows` |
| Every key name has a Windows scan code | `keys::tests::every_key_name_has_a_windows_scan_code_and_no_other_name_has_one` |
| Every key, bare and with every modifier, is pressed in order and released in reverse as scan codes | `keys::tests::every_key_bare_and_with_every_modifier_is_pressed_in_order_and_released_in_reverse` |
| Exactly the arrows and the navigation block are extended keys | `keys::tests::exactly_the_arrows_and_the_navigation_block_are_extended_keys` |
| F1 to F10 are 0x3B to 0x44, F11 and F12 0x57 and 0x58 | `keys::tests::the_scan_codes_follow_the_keyboard_rows` |
| F13 to F23 are 0x64 to 0x6E and F24 is 0x76 | `keys::tests::the_scan_codes_follow_the_keyboard_rows` |
| Falls back to the bare name when the file is not there | **retired with the mechanism**: `powershellPath`: nothing runs PowerShell. |
| Home row: A to ` are 0x1E to 0x29 | `keys::tests::the_scan_codes_follow_the_keyboard_rows` |
| Music keys stay virtual keys | `keys::tests::music_keys_stay_virtual_keys_on_windows` |
| No Alt tap: the foreground is earned with an unassigned key | `apps::launch::tests::the_foreground_is_earned_with_an_unassigned_key_not_alt` |
| No scan code is there for a key that does not exist | `keys::tests::every_key_name_has_a_windows_scan_code_and_no_other_name_has_one` |
| No two keys share a scan code | `keys::tests::no_two_keys_share_a_scan_code` |
| Plain errors lose PowerShell's position trailer | **retired with the mechanism**: unwrapping PowerShell's own packaging (CLIXML, the "At line:" trailer) of an error; the system's errors now arrive as plain text. Nearest: `apps::launch::tests::system_errors_read_as_the_typescript_cleaned_them`. |
| Plain messages pass through | `apps::launch::tests::plain_messages_pass_through` |
| Real apps are kept and uninstallers, readmes and help pages dropped | `apps::list::tests::real_apps_are_kept_and_the_rest_dropped` |
| Scripts stop on errors and show no progress | **retired with the mechanism**: `wrapScript` / `powershellArgs`: nothing runs PowerShell. |
| Scripts travel encoded, as UTF-16 | **retired with the mechanism**: `wrapScript` / `powershellArgs`: nothing runs PowerShell. |
| Shortcuts with arguments are started, not matched to a window | `apps::launch::tests::shortcuts_with_arguments_are_started` |
| Squirrel's Update.exe --processStart X.exe looks for X | `apps::launch::tests::squirrel_shortcuts_look_for_the_program_they_start` |
| The C# declares the mouse event too, so INPUT has its real size | `keys::windows::tests::input_has_its_real_size` (Windows only) |
| The C# for SendInput holds no single quote and its braces pair up | **retired with the mechanism**: text of the C# that PowerShell compiled. Nearest: `keys::windows::tests::input_has_its_real_size` (Windows only). |
| The Start Menu lists each app once, game shortcuts included and web links not | `apps::list::tests::the_start_menu_lists_each_app_once` |
| The dry run stops before touching any window | `apps::launch::tests::what_is_not_running_or_not_matched_is_started` |
| The helper command for every key carries its scan codes as plain integers, presses before releases | `keys::tests::the_planned_events_for_every_key_are_its_inputs_presses_before_releases` |
| The key helper answers every command, failures included | **retired with the mechanism**: text of the PowerShell key helper and its line protocol; key events are handed to SendInput in this process (keys/windows.rs). Nearest: `keys::tests::the_planned_events_for_every_key_are_its_inputs_presses_before_releases`. |
| The key helper gets the C# back exactly | **retired with the mechanism**: text of the PowerShell key helper and its line protocol; key events are handed to SendInput in this process (keys/windows.rs). Nearest: `keys::tests::the_planned_events_for_every_key_are_its_inputs_presses_before_releases`. |
| The key helper parses numbers with the invariant culture | **retired with the mechanism**: text of the PowerShell key helper and its line protocol; key events are handed to SendInput in this process (keys/windows.rs). Nearest: `keys::tests::the_planned_events_for_every_key_are_its_inputs_presses_before_releases`. |
| The key helper script parses | **retired with the mechanism**: text of the PowerShell key helper and its line protocol; key events are handed to SendInput in this process (keys/windows.rs). Nearest: `keys::tests::the_planned_events_for_every_key_are_its_inputs_presses_before_releases`. |
| The launcher (dry run) gets the path back exactly | **retired with the mechanism**: lexing the launcher's PowerShell script; the path is now an argument, never script text. Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only). |
| The launcher (dry run) knows every generic host | `apps::launch::tests::the_generic_hosts_are_the_typescripts`, `apps::launch::tests::a_generic_host_is_never_the_running_app` |
| The launcher (dry run) parses with a curly-quoted path | **retired with the mechanism**: lexing the launcher's PowerShell script; the path is now an argument, never script text. Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only). |
| The launcher gets the path back exactly | **retired with the mechanism**: lexing the launcher's PowerShell script; the path is now an argument, never script text. Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only). |
| The launcher knows every generic host | `apps::launch::tests::the_generic_hosts_are_the_typescripts`, `apps::launch::tests::a_generic_host_is_never_the_running_app` |
| The launcher parses with a curly-quoted path | **retired with the mechanism**: lexing the launcher's PowerShell script; the path is now an argument, never script text. Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only). |
| The modifiers are the left-hand Ctrl, Alt, Shift and Win | `keys::tests::the_modifiers_are_the_left_hand_ctrl_alt_shift_and_win` |
| The releases are sent in a finally | **retired with the mechanism**: it read the C#'s `finally`. The behaviour is kept in `keys::windows::Sink::send` (every batch is posted whatever happened to the one before, so a modifier is never left down), a system call with **no unit test**; that releases are planned after presses: Nearest: `keys::tests::the_planned_events_for_every_key_are_its_inputs_presses_before_releases`. |
| The wrapper parses | **retired with the mechanism**: `wrapScript` / `powershellArgs`: nothing runs PowerShell. |
| Top letter row: Q to ] are 0x10 to 0x1B | `keys::tests::the_scan_codes_follow_the_keyboard_rows` |
| Win and F17 to F24 are no longer refused on Windows | `keys::tests::win_and_f17_to_f24_are_not_refused_on_windows` |
| macOS says the same thing at press time | `keys::tests::macos_says_the_same_thing_at_press_time` |
| powershell.exe is found under SystemRoot | **retired with the mechanism**: `powershellPath`: nothing runs PowerShell. |
| psQuote doubles every typographic single quote | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "''" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "C:\\Users\\Ann\\Start Menu\\Bob’s app.lnk" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "C:\\[brackets]\\$dollar `tick` \"double\" “curly” „low”.lnk" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "Café ünïcode 日本" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "a'’‘b" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "‘quoted’ ‚low‛ 'plain'" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| psQuote round-trips "’" | **retired with the mechanism**: `psQuote` (PowerShell single-quoted literals) is gone with PowerShell: values reach Windows as arguments of API calls, not as script text. Paths with typographic quotes through the real launcher: Nearest: `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only), `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only). |
| windir works when SystemRoot is missing | **retired with the mechanism**: `powershellPath`: nothing runs PowerShell. |

### `tests/security.test.mjs`: 8 removed (8 taken over, 0 with the mechanism gone)

| Check | Now |
|---|---|
| Unit: a code pairs once | `auth::tests::a_code_pairs_once` |
| Unit: a whole IPv6 /64 counts as one address | `auth::tests::a_whole_ipv6_64_counts_as_one_address` |
| Unit: another /64 is not locked by it | `auth::tests::a_whole_ipv6_64_counts_as_one_address` |
| Unit: eight wrong codes lock that address | `auth::tests::eight_wrong_codes_lock_that_address_only` |
| Unit: many addresses guessing together get the code replaced | `auth::tests::many_addresses_guessing_together_get_the_code_replaced` |
| Unit: other addresses still pair while one is locked | `auth::tests::eight_wrong_codes_lock_that_address_only` |
| Unit: the code is not replaced by one address's guesses | `auth::tests::eight_wrong_codes_lock_that_address_only` |
| Unit: the replaced code no longer pairs | `auth::tests::many_addresses_guessing_together_get_the_code_replaced` |

### `tests/library.test.mjs`: 1 removed (1 taken over, 0 with the mechanism gone)

| Check | Now |
|---|---|
| A write that cannot be renamed into place throws and removes its temp file | `store::tests::a_failed_write_leaves_no_temp_file_behind` |

### `tests/trackpad.test.mjs`: 3 removed (3 taken over, 0 with the mechanism gone)

| Check | Now |
|---|---|
| A helper that dies mid-stream does not crash the companion | `pointer::tests::a_pointer_that_keeps_failing_is_not_reopened_for_every_move` |
| A helper that keeps dying is not restarted for every move | `pointer::tests::a_pointer_that_keeps_failing_is_not_reopened_for_every_move` |
| …and the deck is told once | `pointer::tests::a_pointer_that_keeps_failing_is_not_reopened_for_every_move` |

## `tests/windows.test.mjs` (deleted)

This file did nothing off Windows ("Skipped: these run on Windows."), so it adds
nothing to the 629. On Windows it ran 39 checks, every one of them by importing
`src/server` and running its PowerShell scripts for real (dry: nothing was pressed,
started or changed). None could be kept. Where they went:

| Checks (Windows) | Count | Now |
|---|---:|---|
| The player script: "runs without errors", "The sound starts and says how long it is", "A new volume reaches a playing sound", "The player takes a new volume as given, not rounded to 0 or 1", "A sound plays to its end and its process exits on its own", "Volume changes while playing do not hold the sound past its end" | 6 | **retired with the mechanism** (a PowerShell MediaPlayer process per sound). Sounds are mixed in the companion, the same code on every system: `audio::player::tests::a_press_plays_the_file_at_the_faders_gain`, `a_fader_move_reaches_what_is_playing_and_the_next_sound_reads_the_fader`, `a_voice_follows_its_gain_and_stops_when_told_without_saying_it_ended`, `a_sound_that_ends_by_itself_is_announced_with_its_run_time`, `wav_and_mp3_decode_to_silence_of_the_right_length`; with a real device, `real_output_plays_silence` (ignored: run by hand). |
| "A sound whose length never shows exits soon, with an error" / "A sound with a sound device says its length" (one of the two ran) | 1 | `audio::player::tests::a_file_that_cannot_be_played_is_logged_and_ends_with_no_run_time` |
| "A missing file is reported and the script exits with an error" | 1 | `audio::player::tests::the_real_output_refuses_missing_and_unreadable_files` |
| "A path with typographic quotes, # and % is found and plays" | 1 | `audio::player::tests::a_file_is_found_under_a_name_with_typographic_quotes_hash_and_percent` (**written now**; found and read, not played: no device is opened) |
| "Closing stdin (the companion gone) ends the sound" | 1 | **retired with the mechanism**: a sound is no longer a process that could outlive the companion. Nearest: `audio::player::tests::dispose_stops_everything_and_closes_and_the_player_still_works_after`. |
| "PowerShell is found at its full path" | 1 | **retired with the mechanism**: nothing runs PowerShell. |
| "A failing script's error is its plain message", "CLIXML on stderr is decoded to the message" | 2 | **retired with the mechanism** (PowerShell's packaging of errors). Nearest: `apps::launch::tests::system_errors_read_as_the_typescript_cleaned_them`. |
| "The key helper builds … without sending it" (a, ctrl+equal, ctrl+shift+bracketleft, meta+left, ctrl+alt+shift+meta+f24, alt+f17, shift+delete) | 7 | `keys::tests::windows_inputs_match_the_typescript_for_every_key_and_modifier_set` (every key with every set of modifiers), and for the size of INPUT `keys::windows::tests::input_has_its_real_size` (Windows only) |
| "The key helper answers an unknown command with an error and keeps going", "A malformed number is an error, not a crash" | 2 | **retired with the mechanism**: there is no helper and no command line to get wrong. |
| "Every key's scan code is that physical key (US layout), modifiers the left-hand ones" | 1 | `keys::windows::tests::every_scan_code_is_that_physical_key_on_the_us_layout` (**written now**, Windows only: compiled, not run here) |
| "Test shortcuts with curly quotes in their names are made", "The launcher would …" (9 shortcuts and paths) | 10 | `apps::launch_windows::tests::the_launcher_would_on_real_shortcuts` (Windows only; the same shortcuts, made through the shell's own COM interface) and, on what they held, `apps::launch::tests::the_launcher_would` |
| "A missing app is reported in plain words, not CLIXML" | 1 | `apps::launch_windows::tests::a_missing_app_is_reported_in_plain_words` (Windows only) |
| "The trackpad helper compiles and reports errors as JSON" | 1 | **retired with the mechanism**: there is no pointer helper. What a deck may send and what becomes of it: `pointer::tests::messages_become_the_lines_the_typescript_made`, `pointer::tests::windows_is_given_what_the_powershell_loop_gave_it`. |
| "The volume bridge compiles and lists the apps playing sound", "Punchboard's own processes are not offered", "An app that is not there reads as unknown" | 3 | `audio::system_windows::tests::the_real_mixer_lists_apps_and_leaves_alone_one_that_is_not_there` (**written now**, Windows only: compiled, not run here) |
| "A write to an app that is not there fails with the friendly message" | 1 | `audio::app_volume::tests::windows_list_read_and_write`, and black-box "Routes (Windows): a write to an app with no audio session fails with the friendly message" in `tests/app-volume.test.mjs` |
| | **39** | |
