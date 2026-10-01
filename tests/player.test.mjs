// The Windows sound player, on Windows only (CI runs it there): a sound plays
// to its end, takes a new volume while it plays, and its process never hangs.
// Elsewhere it reports itself skipped. Nothing is heard on CI machines.
//   node tests/player.test.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { playCommand } from "../src/server/player.ts"
import { checker } from "./companion.mjs"

const { check, tally } = checker()
if (process.platform !== "win32") {
  console.log("Skipped: the Windows sound player is tested on Windows.")
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
const child = spawn(spec.file, spec.args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true })
let errors = ""
child.stderr.on("data", (chunk) => { errors += chunk })
setTimeout(() => child.stdin.write("0.2\n"), 600)
setTimeout(() => child.stdin.write("1\n"), 900)
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => { child.kill(); resolve("timeout") }, 15000)
  child.on("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode) })
})
const took = Date.now() - started
check("A sound plays to its end and its process exits on its own", code === 0, `exit ${code}, ${errors.trim()}`)
check("Volume changes while playing do not hold the sound past its end", took < 8000, `${took} ms`)
check("The player script runs without errors", errors.trim() === "", errors.trim())

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
