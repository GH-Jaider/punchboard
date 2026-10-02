// Windows-only pieces, on Windows only (CI runs them there): the sound player
// takes a new volume while it plays and never hangs, finds files with odd
// names and gives up on one it cannot open; the key script compiles and builds
// the right scan codes (dry: nothing is pressed); the app launcher decides
// right for real shortcuts (dry: nothing is started) and reports a missing one
// in plain words; the trackpad helper compiles; the volume bridge compiles,
// lists the apps playing sound and refuses an app that is not there in words
// (no volume is changed: that app cannot exist). Elsewhere it reports itself
// skipped. Nothing is heard on CI.
//   node tests/windows.test.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AppNotPlayingError, appVolumeFor } from "../src/server/app-volume.ts"
import { listWindowsAudioApps, readWindowsAppVolume, stopWindowsVolume } from "../src/server/win-volume.ts"
import { SCAN_KEYS_TYPE, WIN_MODIFIER_SCAN_CODES, WIN_SCAN_CODES, stopWindowsKeys, windowsInputs, windowsKeyLine, windowsKeyRequest } from "../src/server/keys.ts"
import { launchApp, windowsLaunchScript } from "../src/server/launch.ts"
import { playCommand } from "../src/server/player.ts"
import { WINDOWS_POINTER } from "../src/server/pointer.ts"
import { cleanPowerShellError, powershellArgs, powershellPath, psQuote, runPowerShell } from "../src/server/powershell.ts"
import { KEY_NAMES, parseCombo } from "../src/shared/keys.ts"
import { checker } from "./companion.mjs"

const { check, tally } = checker()
if (process.platform !== "win32") {
  console.log("Skipped: these run on Windows.")
  process.exit(0)
}

/** One second of silence as a 16-bit mono WAV. */
function silentWav(file, ms) {
  const rate = 8000
  const samples = Math.round((rate * ms) / 1000)
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8)
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write("data", 36); header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-player-"))
const file = path.join(dir, "silence.wav")
silentWav(file, 1000)

/** Runs the player script; `out` collects what it prints. */
function runPlayer(target, unknownLengthMs = null) {
  const spec = playCommand(target, 0.5, "win32", unknownLengthMs)
  const child = spawn(spec.file, spec.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  const run = { child, out: "", errors: "", started: Date.now() }
  child.stderr.on("data", (chunk) => { run.errors += chunk })
  child.stdout.on("data", (chunk) => { run.out += chunk })
  /** Resolves when the script has printed something matching, or after `ms`. */
  run.printed = (pattern, ms) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    const look = () => { if (pattern.test(run.out)) { clearTimeout(timer); resolve(true) } }
    child.stdout.on("data", look)
    look()
  })
  run.exited = new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve("timeout") }, 90000)
    child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode) })
  })
  return run
}

// A machine with no sound device (CI machines have none) never learns a
// sound's length: the volume checks run with a stand-in length then, which
// the companion itself never asks for.
const STAND_IN = 4321
const run = runPlayer(file, STAND_IN)
// PowerShell starts slowly on a cold machine: the volumes go once the sound is
// playing, as they would from a fader, rather than at a fixed time.
const playing = await run.printed(/length \d+/, 40000)
const playingAt = Date.now()
run.child.stdin.write("0.2\n")
setTimeout(() => run.child.stdin.write("1\n"), 300)
const heard = await run.printed(/volume 1 now/, 10000)
const length = Number((run.out.match(/length (\d+)/) || [])[1])
const code = await run.exited
const took = Date.now() - playingAt
check("The player script runs without errors", run.errors.trim() === "", run.errors.trim())
check("The sound starts and says how long it is", playing, run.out.trim())
check("A new volume reaches a playing sound", heard && /volume 0\.2 now/.test(run.out), run.out.trim())
const applied = Number((run.out.match(/volume 0\.2 now ([\d.]+)/) || [])[1])
check("The player takes a new volume as given, not rounded to 0 or 1", Math.abs(applied - 0.2) < 0.01, `0.2 became ${applied}`)
if (length === STAND_IN) console.log("(no sound device here: the stand-in length was used)")
check("A sound plays to its end and its process exits on its own", code === 0, `exit ${code}`)
check("Volume changes while playing do not hold the sound past its end", took < length + 3000, `${took} ms for a ${length} ms sound`)

// Without a stand-in, a sound whose length never shows is not faked for 60 s:
// the script says so and exits with an error (or plays, given a sound device).
const plain = runPlayer(file)
const said = await plain.printed(/length (unknown|\d+)/, 40000)
if (/length unknown/.test(plain.out)) {
  const plainCode = await plain.exited
  check("A sound whose length never shows exits soon, with an error", plainCode === 3 && Date.now() - plain.started < 45000, `exit ${plainCode} after ${Date.now() - plain.started} ms: ${plain.out.trim()}`)
} else {
  check("A sound with a sound device says its length", said, plain.out.trim())
  plain.child.kill()
  await plain.exited
}

// A file that is not there is reported at once rather than "played".
const missing = runPlayer(path.join(dir, "not here.wav"), STAND_IN)
const missingCode = await missing.exited
check("A missing file is reported and the script exits with an error", missingCode === 2 && /missing file/.test(missing.out), `exit ${missingCode}: ${missing.out.trim()} ${missing.errors.trim()}`)

// Quotes PowerShell reads as quotes (’ among them), # and % in the path: the
// file is found and the script parses. Closing stdin (the companion gone)
// then ends the sound.
const odd = path.join(dir, "it’s ‘odd’ ‚name‛ #1 100% 'x'.wav")
silentWav(odd, 1000)
const quoted = runPlayer(odd, 20000)
const quotedPlays = await quoted.printed(/length \d+/, 40000)
quoted.child.stdin.end()
const closedAt = Date.now()
const quotedCode = await quoted.exited
check("A path with typographic quotes, # and % is found and plays", quotedPlays && !/missing file/.test(quoted.out) && quoted.errors.trim() === "", `${quoted.out.trim()} ${quoted.errors.trim()}`)
check("Closing stdin (the companion gone) ends the sound", quotedCode === 0 && Date.now() - closedAt < 5000, `exit ${quotedCode} ${Date.now() - closedAt} ms after stdin closed`)

/** Runs a script through Punchboard's own runner; the error's message on failure. */
const attempt = (script) => runPowerShell(script, 90000).then((out) => ({ out: out.trim(), error: "" }), (error) => ({ out: "", error: error.message }))
const plainText = (text) => !/CLIXML|<Objs|<S S=|At line:\d|CategoryInfo|FullyQualifiedErrorId/.test(text)

check("PowerShell is found at its full path", /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(powershellPath()), powershellPath())

// Errors come back as a sentence: from the runner's own catch, and from
// PowerShell's CLIXML when something escapes it.
const thrown = await attempt(`throw ${psQuote("Bob’s ‘test’ failure")}`)
check("A failing script's error is its plain message", thrown.error === "Bob’s ‘test’ failure", thrown.error)
const raw = await new Promise((resolve) => {
  const ps = spawn(powershellPath(), powershellArgs(`Write-Error ${psQuote("boom from Write-Error")}; exit 3`), { windowsHide: true })
  let text = ""
  ps.stderr.on("data", (chunk) => { text += chunk })
  ps.on("exit", () => resolve(text))
})
const rawClean = cleanPowerShellError(raw)
check("CLIXML on stderr is decoded to the message", /boom from Write-Error/.test(rawClean) && plainText(rawClean), `${rawClean} <- ${raw.slice(0, 300)}`)

// ------------------------------------------------------------------ keys
// Dry runs through the real helper: the C# compiles and the events are built
// exactly as planned, but nothing is sent, so no key is pressed on the CI
// machine. The helper answers several commands in a row and one it does not
// know without stopping.
const ask = (line) => windowsKeyRequest(line, 60000).then((out) => ({ out, error: "" }), (error) => ({ out: "", error: error.message }))
for (const text of ["a", "ctrl+equal", "ctrl+shift+bracketleft", "meta+left", "ctrl+alt+shift+meta+f24", "alt+f17", "shift+delete"]) {
  const combo = parseCombo(text)
  const inputs = windowsInputs(combo)
  const result = await ask(windowsKeyLine(combo, true))
  const match = /^(\d+) (\d+) ([\d,]+) ([\d,]+)$/.exec(result.out)
  const size = process.arch === "ia32" ? 28 : 40
  check(`The key helper builds ${text} without sending it`,
    match && Number(match[1]) === inputs.length && Number(match[2]) === size &&
    match[3] === inputs.map((input) => input.scan).join(",") && match[4] === inputs.map((input) => input.flags).join(","),
    result.error || result.out)
}
const unknown = await ask("bogus 1 2 3")
check("The key helper answers an unknown command with an error and keeps going", /does not know/.test(unknown.error) && !(await ask(windowsKeyLine(parseCombo("ctrl+a"), true))).error, unknown.error || unknown.out)
const malformed = await ask("dry 1 30,x 8,10")
check("A malformed number is an error, not a crash", malformed.error !== "" && !/stopped/.test(malformed.error), malformed.error)
stopWindowsKeys()

// Each scan code is the key it is named after: Windows' US layout (which
// KeyboardEvent.code names keys by) maps it to that key's virtual key.
const VK = {
  enter: 0x0d, space: 0x20, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  minus: 0xbd, equal: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf, backquote: 0xc0,
  bracketleft: 0xdb, backslash: 0xdc, bracketright: 0xdd, quote: 0xde, semicolon: 0xba
}
const vkOf = (name) => VK[name] ?? (/^[a-z0-9]$/.test(name) ? name.toUpperCase().charCodeAt(0) : 0x6f + Number(name.slice(1)))
const named = KEY_NAMES.map((name) => ({ name, code: WIN_SCAN_CODES[name], vk: vkOf(name) }))
  .concat([["ctrl", 0xa2], ["alt", 0xa4], ["shift", 0xa0], ["meta", 0x5b]].map(([name, vk]) => ({ name, code: WIN_MODIFIER_SCAN_CODES[name], vk })))
const mapped = await attempt([
  `Add-Type -IgnoreWarnings -TypeDefinition ${psQuote(SCAN_KEYS_TYPE)}`,
  `Add-Type -Name Layout -Namespace PunchboardTest -MemberDefinition ${psQuote("[DllImport(\"user32.dll\")] public static extern System.IntPtr LoadKeyboardLayout(string id, uint flags); [DllImport(\"user32.dll\")] public static extern uint MapVirtualKeyEx(uint code, uint mapType, System.IntPtr layout);")}`,
  "$us = [PunchboardTest.Layout]::LoadKeyboardLayout('00000409', 0)",
  // MAPVK_VSC_TO_VK_EX (3) reads an E0 prefix in the high byte.
  `foreach ($code in [int[]]@(${named.map((entry) => entry.code).join(",")})) { [PunchboardTest.Layout]::MapVirtualKeyEx($code, 3, $us) }`
].join("\n"))
const vks = mapped.out.split(/\s+/).map(Number)
const wrong = named.filter((entry, i) => vks[i] !== entry.vk).map((entry) => `${entry.name}: 0x${entry.code.toString(16)} is VK 0x${(vks[named.indexOf(entry)] ?? 0).toString(16)}, not 0x${entry.vk.toString(16)}`)
check("Every key's scan code is that physical key (US layout), modifiers the left-hand ones", !mapped.error && vks.length === named.length && wrong.length === 0, mapped.error || wrong.join("; "))

// ------------------------------------------------------------ the launcher
// Dry runs on real shortcuts, curly quotes in their names, then one real run
// on a shortcut that is not there. No app is started.
const apps = path.join(dir, "Start Menu ‘test’")
fs.mkdirSync(path.join(apps, "Squirrel"), { recursive: true })
const tool = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe")
fs.copyFileSync(tool, path.join(apps, "Squirrel", "Update.exe"))
fs.writeFileSync(path.join(apps, "Dota 2.url"), "[InternetShortcut]\r\nURL=steam://rungameid/570\r\n")
const shortcuts = [
  ["Bob’s ‘tool’.lnk", tool, "", "focus whoami idle"],
  ["Chrome - Work profile.lnk", tool, "--profile-directory=\"Profile 1\"", "start arguments"],
  ["Console.lnk", path.join(path.dirname(tool), "cmd.exe"), "", "start launcher cmd"],
  ["Discord.lnk", path.join(apps, "Squirrel", "Update.exe"), "--processStart \"Discord.exe\"", "focus Discord idle"],
  ["Slack.lnk", path.join(apps, "Squirrel", "Update.exe"), "--processStart slack.exe", "focus slack idle"],
  ["Teams.lnk", path.join(apps, "Squirrel", "Update.exe"), "--processStart \"Teams.exe\" --process-start-args \"--profile=AAD\"", "start arguments"]
]
const made = await attempt([
  "$shell = New-Object -ComObject WScript.Shell",
  ...shortcuts.map(([name, target, args]) => `$l = $shell.CreateShortcut(${psQuote(path.join(apps, name))}); $l.TargetPath = ${psQuote(target)}; $l.Arguments = ${psQuote(args)}; $l.Save()`)
].join("\n"))
check("Test shortcuts with curly quotes in their names are made", !made.error && shortcuts.every(([name]) => fs.existsSync(path.join(apps, name))), made.error)
const cases = shortcuts.map(([name, , , want]) => [path.join(apps, name), want])
  .concat([[path.join(apps, "Dota 2.url"), "start not a program"], [tool, "focus whoami idle"], ["C:\\nowhere\\Bob’s missing app.lnk", "start not a program"]])
for (const [target, want] of cases) {
  const result = await attempt(windowsLaunchScript(target, true))
  check(`The launcher would ${want}: ${path.basename(target)}`, result.out === want, result.error || result.out)
}

const missingApp = await launchApp("C:\\nowhere\\Bob’s ‘missing’ app.lnk").then(() => "", (error) => error.message)
check("A missing app is reported in plain words, not CLIXML", /^Could not open that app\. \(.+\)$/.test(missingApp) && plainText(missingApp), missingApp)

// The trackpad helper compiles and reports bad lines as one JSON object each.
// Both lines fail while being parsed, before any mouse or key event is made.
const pointerHelper = await new Promise((resolve) => {
  const encoded = Buffer.from(WINDOWS_POINTER, "utf16le").toString("base64")
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true })
  let out = ""
  let err = ""
  ps.stdout.on("data", (chunk) => { out += chunk })
  ps.stderr.on("data", (chunk) => { err += chunk })
  ps.on("exit", () => resolve({ out, err }))
  ps.stdin.write("m 1 nope\nk 999\nq\n")
})
const pointerErrors = pointerHelper.out.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line).error } catch { return null } })
check("The trackpad helper compiles and reports errors as JSON", pointerErrors.length === 2 && pointerErrors.every((error) => typeof error === "string" && error.length > 0), `${pointerHelper.out} ${pointerHelper.err}`.trim().slice(0, 400))

// ------------------------------------------------------- app volumes
// The real Core Audio bridge. CI machines have no sound device, so the list
// may well be empty, but it must come back without an error. The app asked
// for below cannot exist, so no session's volume is ever set.
const audioApps = await listWindowsAudioApps().then((apps) => ({ apps, error: "" }), (error) => ({ apps: null, error: error.message }))
check("The volume bridge compiles and lists the apps playing sound", Array.isArray(audioApps.apps) && audioApps.apps.every((app) => typeof app.key === "string" && app.key === app.key.toLowerCase() && !/\.exe$/.test(app.key) && typeof app.name === "string" && app.level >= 0 && app.level <= 1), audioApps.error || JSON.stringify(audioApps.apps))
if (audioApps.apps?.length) console.log(`(apps with sound here: ${audioApps.apps.map((app) => app.key).join(", ")})`)
check("Punchboard's own processes are not offered", !(audioApps.apps ?? []).some((app) => app.key === "node" || app.key === "punchboard"), JSON.stringify(audioApps.apps))
const NO_SUCH_APP = "punchboard-test-no-such-app"
const unread = await readWindowsAppVolume(NO_SUCH_APP).then((level) => level, (error) => error.message)
check("An app that is not there reads as unknown", unread === null, String(unread))
const refusedWrite = await appVolumeFor("win32").write(NO_SUCH_APP, "Test App", 0.5).then(() => null, (error) => error)
check("A write to an app that is not there fails with the friendly message", refusedWrite instanceof AppNotPlayingError && refusedWrite.message === "Test App is not making any sound on this computer right now. Open it and play something first.", String(refusedWrite))
stopWindowsVolume()

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
