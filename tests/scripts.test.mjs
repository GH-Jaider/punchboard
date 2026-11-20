// What the Control Center's key recorder knows about each system, from the
// code it shares with the deck (src/shared/keys.ts): which keys it must warn
// about, and how a platform is named. How the companion turns a combination
// into scan codes and key events, starts apps and lists them is tested in
// server/src/keys and server/src/apps (docs/rust-port-test-map.md says which
// test took over each check that used to be here).
//   node tests/scripts.test.mjs
import "./english.mjs"
import { KEY_NAMES, MODIFIERS, keyPlatform, unsendableReason } from "../src/shared/keys.ts"
import { checker } from "./companion.mjs"

const { check, tally } = checker()

// ------------------------------------------------------------- macOS keys

const macUnsendable = KEY_NAMES.filter((name) => unsendableReason(name, "mac"))
// The companion's own table of Mac key codes has no entry for exactly these
// (server/src/keys: the_recorder_flags_exactly_the_keys_macos_has_no_code_for).
check("The recorder flags exactly the keys macOS has no code for (F21 to F24)", macUnsendable.join(" ") === "f21 f22 f23 f24", macUnsendable.join(" "))
check("Nothing is flagged on Windows", KEY_NAMES.every((name) => !unsendableReason(name, "windows")), "")
// The companion has a Linux key code for every key
// (server/src/keys: the_recorder_flags_exactly_the_keys_linux_has_no_code_for).
check("Nothing is flagged on Linux", KEY_NAMES.every((name) => !unsendableReason(name, "linux")), "")
check("Other systems are told key combinations do not work there", Boolean(unsendableReason("a", "other")), "")
check("Platform names are read from Node and from the browser", keyPlatform("darwin") === "mac" && keyPlatform("MacIntel") === "mac" && keyPlatform("iPad") === "mac" && keyPlatform("win32") === "windows" && keyPlatform("Win32") === "windows" && keyPlatform("Linux x86_64") === "linux" && keyPlatform("linux") === "linux" && keyPlatform("freebsd") === "other" && keyPlatform("") === "other", "")
check("Modifiers keep their fixed order", MODIFIERS.join(" ") === "ctrl alt shift meta", "")

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
