// Windows-only pieces, on Windows only (CI runs them there): the sound player
// takes a new volume while it plays and never hangs, finds files with odd
// names, gives up on one it cannot open, the app launcher's script runs, and
// the trackpad helper compiles. Elsewhere it reports itself skipped. Nothing is
// heard on CI.
//   node tests/windows.test.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { windowsLaunchScript } from "../src/server/launch.ts"
import { playCommand } from "../src/server/player.ts"
import { WINDOWS_POINTER } from "../src/server/pointer.ts"
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

// The app launcher: a shortcut that is not there is reported, not a script error.
const launcher = await new Promise((resolve) => {
  const encoded = Buffer.from(windowsLaunchScript("C:\\nowhere\\Missing app.lnk"), "utf16le").toString("base64")
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true })
  let text = ""
  ps.stderr.on("data", (chunk) => { text += chunk })
  ps.on("exit", (exitCode) => resolve({ exitCode, text }))
})
check("The app launcher's script parses and reports a missing app", !/ParserError|unexpected token|Missing closing/i.test(launcher.text) && /cannot|find|not/i.test(launcher.text), launcher.text.trim().slice(0, 300))

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

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
