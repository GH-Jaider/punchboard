// Sounds and faders, through the companion: uploads are checked, a sound's
// length is known at once, names keep the letters of any script, a slot is
// replaced while it plays, and faders refuse a level that is not a number.
// Only generated silent audio is used, the companion plays nothing here
// (server/src/test_system.rs), and the computer's own volume is never set:
// the "system" fader is only sent levels it must refuse. How lengths are
// read, uploads judged and names cleaned, case by case, is tested in
// server/src/sounds.rs.
//   node tests/sounds.test.mjs
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { checker, JSON_TYPE, startCompanion } from "./companion.mjs"

const { check, tally } = checker()

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
const MP3_100 = 100 * 417 * 8 / 128 // ms in 100 frames at 128 kbps

const adts = Buffer.concat([Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x2e, 0x7f, 0xfc]), Buffer.alloc(4000)])
const riffOnly = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WAVE")])

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
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
