// Sounds and faders: reading a sound's length, checking uploads, names in any
// script, replacing a slot while it plays, and faders that refuse a level
// that is not a number. Only generated silent audio is used, the sounds
// fader is at 0 before anything plays, and the computer's own volume is never
// set: the "system" fader is only sent levels it must refuse.
//   node tests/sounds.test.mjs
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isAudio, mp3DurationMs, safeName, wavDurationMs } from "../src/server/sounds.ts"
import { playCommand, psQuote } from "../src/server/player.ts"
import { latestWins } from "../src/server/volume.ts"
import { checker, JSON_TYPE, startCompanion } from "./companion.mjs"

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-sounds-"))

// ------------------------------------------------------------ silent audio

/** Silence as a 16-bit mono WAV, with an optional chunk before "fmt ". */
function silentWav(ms, { rate = 8000, before = null } = {}) {
  const data = Buffer.alloc(Math.round((rate * ms) / 1000) * 2)
  const fmt = Buffer.alloc(24)
  fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10)
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * 2, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22)
  const dataHead = Buffer.alloc(8)
  dataHead.write("data", 0); dataHead.writeUInt32LE(data.length, 4)
  const body = Buffer.concat([Buffer.from("WAVE"), ...(before ? [before] : []), fmt, dataHead, data])
  const riff = Buffer.alloc(8)
  riff.write("RIFF", 0); riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

/** A chunk of `size` bytes: a LIST with album-art-like noise in it. */
function chunk(id, size) {
  const head = Buffer.alloc(8)
  head.write(id, 0); head.writeUInt32LE(size, 4)
  return Buffer.concat([head, crypto.randomBytes(size + (size % 2))])
}

/** Silent MPEG-1 Layer III frames, 128 kbps at 44.1 kHz (417 bytes, 26.1 ms
    each). All-zero side info decodes to silence. `info` puts a frame count
    in the first frame, the way encoders do for VBR. */
function silentMp3(count, { info = false } = {}) {
  const frames = []
  for (let i = 0; i < count; i++) {
    const frame = Buffer.alloc(417)
    frame[0] = 0xff; frame[1] = 0xfb; frame[2] = 0x90; frame[3] = 0x64
    frames.push(frame)
  }
  if (info) {
    frames[0].write("Info", 36)
    frames[0].writeUInt32BE(1, 40) // flags: the frame count is there
    frames[0].writeUInt32BE(count - 1, 44)
  }
  return Buffer.concat(frames)
}

/** An ID3v2 tag of `size` bytes of noise (album art), with sync-like bytes in it. */
function id3(size, { footer = false } = {}) {
  const head = Buffer.alloc(10)
  head.write("ID3", 0)
  head[3] = footer ? 4 : 3
  head[5] = footer ? 0x10 : 0
  head[6] = (size >> 21) & 0x7f; head[7] = (size >> 14) & 0x7f; head[8] = (size >> 7) & 0x7f; head[9] = size & 0x7f
  const body = crypto.randomBytes(size)
  for (let i = 0; i + 4 < size; i += 997) { body[i] = 0xff; body[i + 1] = 0xfb; body[i + 2] = 0x90; body[i + 3] = 0x64 }
  const tail = footer ? Buffer.concat([Buffer.from("3DI"), head.subarray(3)]) : Buffer.alloc(0)
  return Buffer.concat([head, body, tail])
}

const near = (value, expected, slack = 30) => typeof value === "number" && Math.abs(value - expected) <= slack
const write = (name, data) => {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, data)
  return file
}
const MP3_100 = 100 * 417 * 8 / 128 // ms in 100 frames at 128 kbps

// ---------------------------------------------------------- reading lengths

check("An MP3's length is read", near(mp3DurationMs(write("plain.mp3", silentMp3(100))), MP3_100), mp3DurationMs(path.join(tmp, "plain.mp3")))
let file = write("art.mp3", Buffer.concat([id3(300 * 1024), silentMp3(100)]))
check("An MP3 behind a 300 KB ID3 tag (album art) still has a length", near(mp3DurationMs(file), MP3_100), mp3DurationMs(file))
file = write("footer.mp3", Buffer.concat([id3(70 * 1024, { footer: true }), silentMp3(100)]))
check("An ID3v2.4 tag with a footer is skipped whole", near(mp3DurationMs(file), MP3_100), mp3DurationMs(file))
file = write("two-tags.mp3", Buffer.concat([id3(5000), id3(80 * 1024), silentMp3(100)]))
check("Two ID3 tags in a row are both skipped", near(mp3DurationMs(file), MP3_100), mp3DurationMs(file))
file = write("vbr.mp3", Buffer.concat([id3(100 * 1024), silentMp3(200, { info: true })]))
check("A frame count (Info header) past a big tag gives the length", near(mp3DurationMs(file), 199 * 1152 / 44.1, 2), mp3DurationMs(file))
file = write("list.wav", silentWav(1500, { before: chunk("LIST", 100 * 1024) }))
check("A WAV with a 100 KB chunk before its format still has a length", wavDurationMs(file) === 1500, wavDurationMs(file))

// -------------------------------------------------------- checking uploads

const adts = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x2e, 0x7f, 0xfc]), Buffer.alloc(4000)])
const riffOnly = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WAVE")])
const fmtOnly = silentWav(100).subarray(0, 36)
const uploads = [
  ["\"ID3\" and nothing else is not an MP3", Buffer.from("ID3"), "audio/mpeg", false],
  ["An ID3 tag with no audio after it is not an MP3", id3(2000), "audio/mpeg", false],
  ["An AAC (ADTS) stream is not an MP3", adts, "audio/mpeg", false],
  ["Noise with a sync word in it is not an MP3", Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), crypto.randomBytes(3000)]), "audio/mpeg", false],
  ["A RIFF header with no chunks is not a WAV", riffOnly, "audio/wav", false],
  ["A WAV with a format but no data is not a WAV", fmtOnly, "audio/wav", false],
  ["Real MP3 frames are an MP3", silentMp3(20), "audio/mpeg", true],
  ["An MP3 behind a big tag is an MP3", Buffer.concat([id3(200 * 1024), silentMp3(20)]), "audio/mpeg", true],
  ["A WAV with its chunks is a WAV", silentWav(200, { before: chunk("LIST", 33) }), "audio/wav", true]
]
for (const [name, data, type, expected] of uploads) check(name, isAudio(data, type) === expected, `isAudio said ${!expected}`)

// --------------------------------------------------------------- names

check("Names keep letters of every script", safeName(encodeURIComponent("Café ñandú 日本 Ελλάδα (1) [x]-y.mp3")) === "Café ñandú 日本 Ελλάδα (1) [x]-y.mp3", safeName(encodeURIComponent("Café ñandú 日本 Ελλάδα (1) [x]-y.mp3")))
check("A Mac's decomposed accent stays one letter", safeName(encodeURIComponent("Cafe\u0301")) === "Café", safeName(encodeURIComponent("Cafe\u0301")))
check("Slashes, control characters and symbols still go", safeName(encodeURIComponent("../a\u0007/b<>%.wav")) === "..ab.wav", safeName(encodeURIComponent("../a\u0007/b<>%.wav")))
check("A name that is not encoded is taken as is", safeName("100% done") === "100 done", safeName("100% done"))

// ---------------------------------------------- the Windows player's script

check("PowerShell quoting doubles straight and typographic quotes", psQuote("it’s ‘a’ ‚b‛ 'c'") === "'it’’s ‘‘a’’ ‚‚b‛‛ ''c'''", psQuote("it’s ‘a’ ‚b‛ 'c'"))
const script = playCommand("C:\\Sounds\\it’s #1 50%.wav", 1, "win32").args.at(-1)
check("The Windows player is given a file URI with # and % escaped", script.includes("[Uri]'file:///C:/Sounds/it%E2%80%99s%20%231%2050%25.wav'"), script.slice(0, 300))
check("A sound whose length never shows exits instead of pretending to play", /'length unknown'.*exit 3/.test(script) && !/60000/.test(script), script)

// ------------------------------------------------- one volume write at a time

{
  const order = []
  let running = 0
  let overlap = false
  const set = latestWins(async (level) => {
    running += 1
    if (running > 1) overlap = true
    order.push(level)
    await wait(40)
    running -= 1
    return level
  })
  await Promise.all([0.1, 0.2, 0.3, 0.4].map((level) => set(level)))
  await wait(120)
  check("Volume writes never overlap, and the newest level is set last", !overlap && order.join(",") === "0.1,0.4", `${order.join(",")} overlap ${overlap}`)
}

// ------------------------------------ the Windows volume bridge, faked here

if (process.platform !== "win32") {
  // A stand-in "powershell" that speaks the bridge's protocol: slow to get
  // ready (the first-time compile), answers out of order, hangs on request.
  const bin = path.join(tmp, "bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "powershell"), `#!${process.execPath}
let gets = 0
setTimeout(() => process.stdout.write("ready\\n"), Number(process.env.FAKE_READY_MS))
let pending = ""
process.stdin.on("data", (chunk) => {
  pending += chunk
  const lines = pending.split("\\n")
  pending = lines.pop()
  for (const line of lines) {
    const [id, command] = line.split(" ")
    if (command === "get") {
      gets += 1
      if (gets === 1) setTimeout(() => process.stdout.write(id + " ok 0.1\\n"), Number(process.env.FAKE_READY_MS) + 50)
      else if (gets <= 4) { const answer = id + " ok 0." + gets + "\\n"; setTimeout(() => process.stdout.write(answer), (5 - gets) * 60) }
      // later gets hang
    } else {
      process.stdout.write("77 ok 0.77\\n")
      process.stdout.write(id + " ok " + command + "\\n")
    }
  }
})
`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`
  // Ready only after 8.5 s: the 8 s answer timer used to run through it.
  process.env.FAKE_READY_MS = "8500"
  const { readWindowsVolume, writeWindowsVolume, stopWindowsVolume } = await import("../src/server/win-volume.ts")
  const first = await readWindowsVolume().catch((error) => error)
  check("Windows volume: a slow first start (the compile) does not time the request out", first === 0.1, String(first))
  const answers = await Promise.all([readWindowsVolume(), readWindowsVolume(), readWindowsVolume()]).catch((error) => [String(error)])
  check("Windows volume: answers that come back out of order reach the right request", answers.join(",") === "0.2,0.3,0.4", answers.join(","))
  const written = await writeWindowsVolume(0.5).catch((error) => error)
  check("Windows volume: an answer for nobody is not handed to the next request", written === 0.5, String(written))
  const asked = Date.now()
  const hung = readWindowsVolume().then(() => "answered", (error) => error.message)
  await wait(50)
  stopWindowsVolume()
  const outcome = await hung
  check("Windows volume: stopping fails a waiting request at once", /stopped/.test(outcome) && Date.now() - asked < 1000, `${outcome} after ${Date.now() - asked} ms`)
  process.env.PATH = savedPath
}

// ------------------------------------------------ the Mac player, faked here

if (process.platform === "darwin") {
  // Stand-ins for osascript (the helper) and afplay, so nothing plays at all.
  const bin = path.join(tmp, "mac-bin")
  const calls = path.join(tmp, "calls.log")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "osascript"), `#!${process.execPath}
const fs = require("node:fs")
fs.appendFileSync(${JSON.stringify(calls)}, "osascript\\n")
if (process.env.FAKE_HELPER === "dies") process.exit(1)
process.stdout.write(JSON.stringify({ event: "ready" }) + "\\n")
let pending = ""
process.stdin.on("data", (chunk) => {
  pending += chunk
  const lines = pending.split("\\n")
  pending = lines.pop()
  for (const line of lines) {
    const command = JSON.parse(line)
    if (command.cmd !== "play") continue
    // Slow to start, as a cold audio device is; then 300 ms of sound.
    setTimeout(() => process.stdout.write(JSON.stringify({ event: "started", slot: command.slot }) + "\\n"), 500)
    setTimeout(() => process.stdout.write(JSON.stringify({ event: "ended", slot: command.slot }) + "\\n"), 800)
  }
})
`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "afplay"), `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(calls)}, "afplay " + process.argv.slice(2).join(" ") + "\\n")
setTimeout(() => process.exit(0), 300)
`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`
  const faked = execFileSync("/usr/bin/which", ["osascript", "afplay"], { encoding: "utf8" }).trim().split("\n")
  if (faked.every((found) => found.startsWith(bin))) {
    const { createPlayer } = await import("../src/server/player.ts")
    const silent = write("silent.wav", silentWav(300))
    const ended = []
    const options = { helper: path.join(tmp, "no-helper.js"), volume: () => 0, log: () => {}, onEnded: (slot, ranMs) => ended.push({ slot, ranMs }) }

    process.env.FAKE_HELPER = "plays"
    const player = createPlayer(options)
    player.play(1, silent)
    await wait(1200)
    const run = ended.find((item) => item.slot === 1)
    check("Mac: a sound's run time counts from when the helper started it", run && run.ranMs !== null && run.ranMs < 600, JSON.stringify(run))
    player.dispose()
    await wait(400)

    fs.writeFileSync(calls, "")
    ended.length = 0
    process.env.FAKE_HELPER = "dies"
    const broken = createPlayer(options)
    broken.play(2, silent)
    await wait(1000)
    check("Mac: a press sent to a helper that died at start still plays (through afplay)", /^afplay .*silent\.wav$/m.test(fs.readFileSync(calls, "utf8")) && ended.some((item) => item.slot === 2 && item.ranMs !== null), fs.readFileSync(calls, "utf8") + JSON.stringify(ended))
    broken.play(3, silent)
    broken.play(4, silent)
    await wait(800)
    const log = fs.readFileSync(calls, "utf8")
    check("Mac: a helper that dies at start is not respawned on every press", log.split("osascript").length - 1 === 1 && (log.match(/^afplay/gm) || []).length === 3, log)
    broken.dispose()
  } else {
    check("Mac player stand-ins are found first on PATH", false, faked.join(", "))
  }
  process.env.PATH = savedPath
  delete process.env.FAKE_HELPER
}

// ------------------------------------------------- the companion's routes

const library = {
  version: 1,
  activeProfileId: "main",
  profiles: [{
    id: "main", name: "Main", columns: 4, rows: 3,
    buttons: [
      { id: "soundsFader", slot: 0, label: "Sounds", icon: "tune", color: "accent", control: "fader", fader: { target: "sounds" }, steps: [] },
      { id: "systemFader", slot: 1, label: "Computer", icon: "tune", color: "accent", control: "fader", fader: { target: "system" }, steps: [] }
    ]
  }]
}

// soundVolume null used to load as 0: a muted sounds fader.
const companion = startCompanion({ config: { soundVolume: null } })
const request = companion.request
const status = async () => (await request({ path: "/api/status" })).json
const setLevel = (buttonId, level) => request({ method: "POST", path: "/api/volume", headers: JSON_TYPE, body: JSON.stringify(level === undefined ? { profileId: "main", buttonId } : { profileId: "main", buttonId, level }) })
const upload = (slot, data, type, name) => request({ method: "PUT", path: `/api/sounds/${slot}`, headers: { "Content-Type": type, ...(name ? { "X-Sound-Name": name } : {}) }, body: data })

try {
  await companion.ready
  check("A saved sounds volume of null loads as full, not muted", (await status()).levels.sounds === 1, JSON.stringify((await status()).levels))
  const rev = (await request({ path: "/api/library" })).headers["x-library-rev"]
  const saved = await request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: JSON.stringify(library) })
  check("The fader deck saves", saved.status === 200, saved.text)

  // --- faders: the sounds fader goes to 0 first, so nothing below is heard
  let r = await setLevel("soundsFader", 0)
  check("The sounds fader takes a number", r.status === 200 && r.json.levels.sounds === 0, r.text)
  r = await setLevel("soundsFader", 0.4)
  for (const [what, level] of [["missing", undefined], ["null", null], ["text", "loud"], ["a number as text", "0.5"], ["true", true]]) {
    r = await setLevel("soundsFader", level)
    check(`A ${what} level is refused`, r.status === 400, `${r.status} ${r.text}`)
  }
  check("Refused levels leave the sounds fader where it was", (await status()).levels.sounds === 0.4, JSON.stringify((await status()).levels))
  // Only if the sounds fader refused them all: otherwise this could set the computer's volume.
  if (tally.fail === 0) {
    for (const [what, level] of [["missing", undefined], ["null", null], ["text", "x"]]) {
      r = await setLevel("systemFader", level)
      check(`A ${what} level for the computer's volume is refused`, r.status === 400, `${r.status} ${r.text}`)
    }
  }
  await setLevel("soundsFader", 0)

  // --- uploads
  const bad = [["ID3 alone", Buffer.from("ID3"), "audio/mpeg"], ["ADTS", adts, "audio/mpeg"], ["a bare RIFF header", riffOnly, "audio/wav"]]
  for (const [what, data, type] of bad) {
    r = await upload(2, data, type)
    check(`Upload of ${what} is refused`, r.status === 400, `${r.status} ${r.text}`)
  }
  r = await request({ path: "/api/sounds" })
  check("A refused upload leaves the slot's tone in place", r.json.slots[1].custom === false, JSON.stringify(r.json.slots[1]))

  const name = "Café ñandú 日本 (take 2).mp3"
  r = await upload(2, Buffer.concat([id3(256 * 1024), silentMp3(100)]), "audio/mpeg", encodeURIComponent(name))
  const slot2 = r.json?.slots?.[1]
  check("An MP3 with a big tag uploads", r.status === 200 && slot2?.custom === true, r.text.slice(0, 300))
  check("Its length is known at once", near(slot2?.durationMs, MP3_100), JSON.stringify(slot2))
  check("Its name keeps every letter", slot2?.name === name, JSON.stringify(slot2?.name))

  // --- replacing and restoring a slot that is playing (5 s of silence, fader at 0)
  if (process.platform === "darwin" || process.platform === "win32") {
    r = await upload(4, silentWav(5000), "audio/wav", "long")
    check("A long silent sound uploads", r.status === 200, r.text.slice(0, 200))
    await request({ method: "POST", path: "/api/sounds/4/preview", headers: JSON_TYPE })
    check("The slot plays", (await status()).playing.includes(4), JSON.stringify((await status()).playing))
    r = await upload(4, silentWav(800), "audio/wav", "short")
    check("Replacing a playing slot works", r.status === 200, r.text.slice(0, 200))
    check("Replacing a playing slot stops the old sound", !(await status()).playing.includes(4), JSON.stringify((await status()).playing))
    check("The new file's length stands", (await request({ path: "/api/sounds" })).json.slots[3].durationMs === 800, JSON.stringify((await request({ path: "/api/sounds" })).json.slots[3]))

    r = await upload(4, silentWav(5000), "audio/wav", "long again")
    await request({ method: "POST", path: "/api/sounds/4/preview", headers: JSON_TYPE })
    const playingBefore = (await status()).playing.includes(4)
    r = await request({ method: "DELETE", path: "/api/sounds/4" })
    check("Restoring a playing slot stops it", r.status === 200 && playingBefore && !(await status()).playing.includes(4), `${r.status} playing before: ${playingBefore}, after: ${JSON.stringify((await status()).playing)}`)
  } else {
    console.log("(sounds play on macOS and Windows only: the replace-while-playing checks are skipped)")
  }

  // --- a fader move right before quitting is saved
  r = await setLevel("soundsFader", 0.25)
  const quit = await companion.stop()
  const config = JSON.parse(fs.readFileSync(path.join(companion.dataDir, "config.json"), "utf8"))
  check("A fader move just before quitting is saved", quit && config.soundVolume === 0.25, `quit ${quit}, saved ${config.soundVolume}`)
} catch (error) {
  check("The sound checks ran to the end", false, error?.stack || String(error))
  await companion.stop()
} finally {
  companion.cleanup()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
