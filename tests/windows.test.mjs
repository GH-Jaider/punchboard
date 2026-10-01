// Windows-only pieces, on Windows only (CI runs them there): the sound player
// takes a new volume while it plays and never hangs, the app launcher's
// script runs, and the trackpad helper compiles. Elsewhere it reports itself
// skipped. Nothing is heard on CI.
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

const spec = playCommand(file, 0.5, "win32")
const started = Date.now()
const child = spawn(spec.file, spec.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
let errors = ""
let out = ""
child.stderr.on("data", (chunk) => { errors += chunk })
/** Resolves when the script has printed something matching, or after `ms`. */
const printed = (pattern, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), ms)
  const look = () => { if (pattern.test(out)) { clearTimeout(timer); resolve(true) } }
  child.stdout.on("data", look)
  look()
})
child.stdout.on("data", (chunk) => { out += chunk })
const exited = new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill(); resolve("timeout") }, 90000)
  child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode) })
})
// PowerShell starts slowly on a cold machine: the volumes go once the sound is
// playing, as they would from a fader, rather than at a fixed time.
const playing = await printed(/length \d+/, 40000)
child.stdin.write("0.2\n")
setTimeout(() => child.stdin.write("1\n"), 300)
const heard = await printed(/volume 1 now/, 10000)
const length = Number((out.match(/length (\d+)/) || [])[1])
// With no sound device the script would wait out its 60 s fallback; it has shown what it needs to.
if (length === 60000 || !length) child.kill()
const code = await exited
const took = Date.now() - started
check("The player script runs without errors", errors.trim() === "", errors.trim())
check("The sound starts and says how long it is", playing, out.trim())
check("A new volume reaches a playing sound", heard && /volume 0\.2 now/.test(out), out.trim())
const applied = Number((out.match(/volume 0\.2 now ([\d.]+)/) || [])[1])
check("The player takes a new volume as given, not rounded to 0 or 1", Math.abs(applied - 0.2) < 0.01, `0.2 became ${applied}`)
if (length === 60000 || !length) {
  // No sound device (CI machines have none): MediaPlayer never learns the length.
  console.log(`(no sound device here: length ${length || "unknown"}, so the timing checks are skipped)`)
} else {
  check("A sound plays to its end and its process exits on its own", code === 0, `exit ${code}`)
  check("Volume changes while playing do not hold the sound past its end", took < length + 3000, `${took} ms for a ${length} ms sound`)
}

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
