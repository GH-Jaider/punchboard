// Fixtures for the Rust port of the sound slots and their player
// (server/src/sounds.rs, server/src/audio/player.rs): the TypeScript is run
// over many inputs and what it answers is written to tests/fixtures/sound/.
// The Rust unit tests read them and must answer the same. Nothing here depends
// on the clock or on chance (the clock is a fixed one, noise comes from a
// seed), so a second run writes the same files.
//   node tests/fixtures/make-sound.ts        (from the repository's root)
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mock } from "node:test"
import { fileURLToPath } from "node:url"
import type { SoundSlot } from "../../src/shared/api.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")
const OUT = path.join(HERE, "sound")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-sound-fixtures-"))

// The companion's own modules read the environment when they load.
process.env.PUNCHBOARD_LOCALES_DIR = path.join(ROOT, "public", "locales")
delete process.env.PUNCHBOARD_LOCALE
const { createSoundStore, isAudio, mp3DurationMs, mp3Frame, safeName, wavDurationMs } = await import("../../src/server/sounds.ts")
type AudioType = import("../../src/server/sounds.ts").AudioType
const { gainFor } = await import("../../src/server/player.ts")

const counts: Record<string, number> = {}
function write(name: string, cases: Json[]): void {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`)
  counts[name] = cases.length
}

/** A number as its 64 bits, so NaN, -0 and every last digit reach Rust. */
function bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, "0")
}

// ------------------------------------------------------- bytes, described

/** A file's bytes as a recipe, so megabytes of silence and noise stay a few
    characters in the fixture. The Rust tests build the same bytes from it. */
type Part =
  | { hex: string }
  | { zeros: number }
  /** `length` bytes of the same "random" numbers every run. */
  | { noise: [seed: number, length: number] }
  | { repeat: Part[]; times: number }

function noise(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = state >>> 24
  }
  return out
}

function bytes(parts: Part[]): Buffer {
  const made: Buffer[] = []
  for (const part of parts) {
    if ("hex" in part) made.push(Buffer.from(part.hex, "hex"))
    else if ("zeros" in part) made.push(Buffer.alloc(part.zeros))
    else if ("noise" in part) made.push(noise(part.noise[0], part.noise[1]))
    else {
      const once = bytes(part.repeat)
      for (let i = 0; i < part.times; i += 1) made.push(once)
    }
  }
  return Buffer.concat(made)
}

const hex = (data: Buffer | number[]): Part => ({ hex: Buffer.from(data).toString("hex") })
const text = (value: string): Part => hex(Buffer.from(value, "latin1"))
const u32le = (value: number): Part => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return hex(b) }
const u32be = (value: number): Part => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); return hex(b) }
const size = (parts: Part[]): number => bytes(parts).length

// ------------------------------------------------------------------- WAV

interface WavOptions {
  rate?: number
  channels?: number
  depth?: number
  /** Overrides for the fields the reader looks at. */
  byteRate?: number
  blockAlign?: number
  /** The "fmt " chunk's length: 16, or more for the extensible form. */
  fmtLength?: number
  /** Chunks before "fmt ". */
  before?: Part[]
  /** Chunks between "fmt " and "data". */
  between?: Part[]
  /** What the data chunk says its size is, when not the truth. */
  dataSize?: number
  /** Bytes after the data. */
  after?: Part[]
  magic?: string
  form?: string
}

function fmtChunk(options: WavOptions): Part[] {
  const { rate = 8000, channels = 1, depth = 16, fmtLength = 16 } = options
  const blockAlign = options.blockAlign ?? channels * depth / 8
  const byteRate = options.byteRate ?? rate * blockAlign
  const body = Buffer.alloc(Math.max(16, fmtLength))
  body.writeUInt16LE(1, 0)
  body.writeUInt16LE(channels, 2)
  body.writeUInt32LE(rate, 4)
  body.writeUInt32LE(byteRate >>> 0, 8)
  body.writeUInt16LE(blockAlign, 12)
  body.writeUInt16LE(depth, 14)
  return [text("fmt "), u32le(fmtLength), hex(body.subarray(0, fmtLength)), ...(fmtLength % 2 ? [{ zeros: 1 }] : [])]
}

/** Silence as a PCM WAV of `dataBytes` of data. */
function wav(dataBytes: number, options: WavOptions = {}): Part[] {
  const data: Part[] = [text("data"), u32le(options.dataSize ?? dataBytes), { zeros: dataBytes }]
  const body: Part[] = [text(options.form ?? "WAVE"), ...(options.before ?? []), ...fmtChunk(options), ...(options.between ?? []), ...data, ...(options.after ?? [])]
  return [text(options.magic ?? "RIFF"), u32le(size(body)), ...body]
}

/** Silence of `ms` milliseconds, as tests/sounds.test.mjs makes it. */
function silentWav(ms: number, options: WavOptions = {}): Part[] {
  const { rate = 8000, channels = 1, depth = 16 } = options
  return wav(Math.round((rate * ms) / 1000) * channels * depth / 8, options)
}

/** A chunk of `length` bytes of noise (a LIST with album art in it), padded to an even size. */
function chunk(id: string, length: number, seed = 5): Part[] {
  return [text(id), u32le(length), { noise: [seed, length + (length % 2)] }]
}

// ------------------------------------------------------------------- MP3

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

interface FrameOptions {
  /** 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved. */
  version?: number
  /** 1 = Layer III, 2 = Layer II, 3 = Layer I, 0 = reserved. */
  layer?: number
  bitrateIndex?: number
  rateIndex?: number
  padding?: boolean
  mono?: boolean
  /** "Xing" or "Info" after the side info, with these flags and frame count. */
  tag?: { name: string; flags: number; frames: number }
}

function frameHeader(options: FrameOptions): number[] {
  const { version = 3, layer = 1, bitrateIndex = 9, rateIndex = 0, padding = false, mono = false } = options
  return [0xff, 0xe0 | (version << 3) | (layer << 1) | 1, (bitrateIndex << 4) | (rateIndex << 2) | (padding ? 2 : 0), mono ? 0xc0 : 0x40]
}

/** How long a Layer III frame is, worked out here and not asked of the code under test. */
function frameLength(options: FrameOptions): number {
  const { version = 3, bitrateIndex = 9, rateIndex = 0, padding = false } = options
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]! * 1000
  const rate = RATES[version]![rateIndex]!
  return Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + (padding ? 1 : 0)
}

/** One silent frame: its header, then zeros (all-zero side info decodes to silence). */
function frame(options: FrameOptions = {}): Part[] {
  const length = frameLength(options)
  const header = frameHeader(options)
  if (!options.tag) return [hex(header), { zeros: length - 4 }]
  const { version = 3, mono = false } = options
  const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17)
  const head: Part[] = [hex(header), { zeros: sideInfo }, text(options.tag.name), u32be(options.tag.flags), u32be(options.tag.frames)]
  return [...head, { zeros: length - size(head) }]
}

const frames = (count: number, options: FrameOptions = {}): Part => ({ repeat: frame(options), times: count })

/** Silent MPEG-1 Layer III frames, 128 kbps at 44.1 kHz, as tests/sounds.test.mjs
    makes them: `info` puts a frame count in the first frame. */
function silentMp3(count: number, info = false): Part[] {
  if (!info) return [frames(count)]
  return [...frame({ tag: { name: "Info", flags: 1, frames: count - 1 } }), frames(count - 1)]
}

/** An ID3v2 tag of `length` bytes of noise, with sync-like bytes in it every 997. */
function id3(length: number, options: { footer?: boolean; seed?: number; sizeBytes?: number[] } = {}): Part[] {
  const footer = options.footer ?? false
  const seed = options.seed ?? 11
  const sizeBytes = options.sizeBytes ?? [(length >> 21) & 0x7f, (length >> 14) & 0x7f, (length >> 7) & 0x7f, length & 0x7f]
  const head = [footer ? 4 : 3, 0, footer ? 0x10 : 0, ...sizeBytes]
  const whole = Math.floor(length / 997)
  const rest = length - whole * 997
  const body: Part[] = []
  if (whole) body.push({ repeat: [hex([0xff, 0xfb, 0x90, 0x64]), { noise: [seed, 993] }], times: whole })
  if (rest) body.push({ noise: [seed + 1, rest] })
  return [text("ID3"), hex(head), ...body, ...(footer ? [text("3DI"), hex(head)] : [])]
}

// ------------------------------------------------------ the files to read

interface Sample { name: string; parts: Part[] }
const samples: Sample[] = []
const sample = (name: string, parts: Part[]): void => { samples.push({ name, parts }) }

// WAVs of many rates, channels, depths and lengths.
for (const rate of [8000, 11025, 22050, 44100, 48000, 96000]) {
  for (const channels of [1, 2, 6]) {
    for (const depth of [8, 16, 24, 32]) {
      for (const ms of [0, 1, 10, 333, 1500]) sample(`wav ${rate} Hz, ${channels} ch, ${depth} bit, ${ms} ms`, silentWav(ms, { rate, channels, depth }))
    }
  }
}
// The ones the existing test builds.
sample("wav behind a 100 KB LIST chunk", silentWav(1500, { before: chunk("LIST", 100 * 1024) }))
sample("wav behind a 33-byte chunk (odd, so padded)", silentWav(200, { before: chunk("LIST", 33) }))
sample("wav: a RIFF header with no chunks", [text("RIFF"), u32le(4), text("WAVE")])
sample("wav: a format but no data", [{ hex: bytes(silentWav(100)).subarray(0, 36).toString("hex") }])
sample("wav 5 s", silentWav(5000))
sample("wav 800 ms", silentWav(800))
sample("wav 300 ms", silentWav(300))
// Odd but real shapes.
sample("wav: extensible format (40 bytes)", silentWav(250, { fmtLength: 40, rate: 48000, channels: 2 }))
sample("wav: format of 18 bytes", silentWav(250, { fmtLength: 18 }))
sample("wav: format of 17 bytes (padded)", silentWav(250, { fmtLength: 17 }))
sample("wav: format of 14 bytes is too short", silentWav(250, { fmtLength: 14 }))
sample("wav: format of 0 bytes", silentWav(250, { fmtLength: 0 }))
sample("wav: chunks between format and data", silentWav(400, { between: [...chunk("fact", 4), ...chunk("PEAK", 16), ...chunk("LIST", 1001)] }))
sample("wav: a chunk after the data", silentWav(400, { after: chunk("LIST", 2000) }))
sample("wav: data size left blank by a streaming writer", wav(16000, { dataSize: 0 }))
sample("wav: data size of 0xffffffff", wav(16000, { dataSize: 0xffffffff }))
sample("wav: data size larger than the file", wav(16000, { dataSize: 64000 }))
sample("wav: data size smaller than what follows", wav(16000, { dataSize: 4000 }))
sample("wav: blank data size and nothing after it", wav(0, { dataSize: 0 }))
sample("wav: data of one byte", wav(1))
sample("wav: no channels", silentWav(100, { channels: 0, blockAlign: 2, byteRate: 16000 }))
sample("wav: no sample rate", silentWav(100, { rate: 0, byteRate: 16000 }))
sample("wav: no byte rate", silentWav(100, { byteRate: 0 }))
sample("wav: no block align", silentWav(100, { blockAlign: 0, byteRate: 16000 }))
sample("wav: a byte rate that is not rate x block", wav(10000, { byteRate: 3 }))
sample("wav: a huge byte rate", wav(10000, { byteRate: 0xffffffff }))
sample("wav: RIFX", silentWav(100, { magic: "RIFX" }))
sample("wav: riff in lower case", silentWav(100, { magic: "riff" }))
sample("wav: RIFF but AVI", silentWav(100, { form: "AVI " }))
sample("wav: data before its format", [text("RIFF"), u32le(4 + 8 + 800 + 24), text("WAVE"), text("data"), u32le(800), { zeros: 800 }, ...fmtChunk({})])
sample("wav: two formats, the second one counts", [text("RIFF"), u32le(4 + 24 + 24 + 8 + 8000), text("WAVE"), ...fmtChunk({ rate: 8000 }), ...fmtChunk({ rate: 4000 }), text("data"), u32le(8000), { zeros: 8000 }])
sample("wav: a chunk whose size runs past the file", [text("RIFF"), u32le(100), text("WAVE"), text("LIST"), u32le(5000), { zeros: 40 }])
sample("wav: a chunk of 0xffffffff bytes", [text("RIFF"), u32le(100), text("WAVE"), text("JUNK"), u32le(0xffffffff), ...fmtChunk({}), text("data"), u32le(100), { zeros: 100 }])
sample("wav: 999 empty chunks before the format", silentWav(100, { before: [{ repeat: [text("JUNK"), u32le(0)], times: 999 }] }))
sample("wav: 998 empty chunks before the format", silentWav(100, { before: [{ repeat: [text("JUNK"), u32le(0)], times: 998 }] }))
sample("wav: 1000 empty chunks before the format", silentWav(100, { before: [{ repeat: [text("JUNK"), u32le(0)], times: 1000 }] }))
sample("wav: half a chunk header at the end", [...silentWav(100, { dataSize: 0 }).slice(0, -3), text("LIS")])
{
  // Cut short at every length through the headers, then at a few in the data.
  const whole = bytes(silentWav(20, { before: chunk("LIST", 6) }))
  for (let length = 0; length <= 70; length += 1) sample(`wav cut to ${length} bytes`, [hex(whole.subarray(0, length))])
  for (const length of [100, 200, whole.length - 1]) sample(`wav cut to ${length} bytes`, [hex(whole.subarray(0, length))])
}

// MP3s of every version, bitrate, sample rate, with and without padding, mono and stereo.
for (const version of [3, 2, 0]) {
  for (let bitrateIndex = 1; bitrateIndex <= 14; bitrateIndex += 1) {
    for (let rateIndex = 0; rateIndex <= 2; rateIndex += 1) {
      for (const padding of [false, true]) {
        for (const mono of [false, true]) {
          const options: FrameOptions = { version, bitrateIndex, rateIndex, padding, mono }
          const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex]!
          sample(`mp3 version ${version}, ${kbps} kbps, ${RATES[version]![rateIndex]!} Hz${padding ? ", padded" : ""}${mono ? ", mono" : ""}`, [frames(7, options)])
        }
      }
    }
  }
}
// Frame counts (VBR) in every layout of the side info.
for (const version of [3, 2, 0]) {
  for (const mono of [false, true]) {
    for (const name of ["Xing", "Info"]) {
      const options: FrameOptions = { version, mono, bitrateIndex: 5, rateIndex: 1 }
      sample(`mp3 version ${version}${mono ? " mono" : ""} with ${name} of 5000 frames`, [...frame({ ...options, tag: { name, flags: 1, frames: 5000 } }), frames(6, options)])
    }
  }
}
sample("mp3: a Xing header whose flags have no frame count", [...frame({ tag: { name: "Xing", flags: 6, frames: 777 } }), frames(9)])
sample("mp3: a Xing header with every flag", [...frame({ tag: { name: "Xing", flags: 15, frames: 1234 } }), frames(9)])
sample("mp3: an Info header counting zero frames", [...frame({ tag: { name: "Info", flags: 1, frames: 0 } }), frames(9)])
sample("mp3: an Info header counting 0xffffffff frames", [...frame({ tag: { name: "Info", flags: 1, frames: 0xffffffff } }), frames(9)])
sample("mp3: \"xing\" in lower case is not a header", [...frame({ tag: { name: "xing", flags: 1, frames: 50 } }), frames(9)])
sample("mp3: VBRI is not read", [...frame({ tag: { name: "VBRI", flags: 1, frames: 50 } }), frames(9)])
// The ones the existing test builds.
sample("mp3 100 frames", silentMp3(100))
sample("mp3 20 frames", silentMp3(20))
sample("mp3 behind a 300 KB ID3 tag (album art)", [...id3(300 * 1024), ...silentMp3(100)])
sample("mp3 behind an ID3v2.4 tag with a footer", [...id3(70 * 1024, { footer: true }), ...silentMp3(100)])
sample("mp3 behind two ID3 tags", [...id3(5000), ...id3(80 * 1024), ...silentMp3(100)])
sample("mp3 with a frame count past a big tag", [...id3(100 * 1024), ...silentMp3(200, true)])
sample("mp3 behind a 200 KB tag", [...id3(200 * 1024), ...silentMp3(20)])
sample("mp3 behind a 256 KB tag", [...id3(256 * 1024), ...silentMp3(100)])
sample("mp3: \"ID3\" and nothing else", [text("ID3")])
sample("mp3: an ID3 tag with no audio after it", id3(2000))
sample("mp3: an AAC (ADTS) stream", [hex([0xff, 0xf1, 0x50, 0x80, 0x2e, 0x7f, 0xfc]), { zeros: 4000 }])
sample("mp3: noise with a sync word in front", [hex([0xff, 0xfb, 0x90, 0x64]), { noise: [3, 3000] }])
// Tags.
sample("mp3 behind an empty ID3 tag", [...id3(0), ...silentMp3(8)])
sample("mp3 behind eight ID3 tags", [{ repeat: id3(300), times: 8 }, ...silentMp3(8)])
sample("mp3 behind nine ID3 tags (one more than is skipped)", [{ repeat: id3(300), times: 9 }, ...silentMp3(8)])
sample("mp3 behind nine empty ID3 tags", [{ repeat: id3(0), times: 9 }, ...silentMp3(8)])
sample("mp3: an ID3 size with a high bit set", [...id3(500, { sizeBytes: [0, 0, 0x83, 0x74] }), ...silentMp3(8)])
sample("mp3: an ID3 tag that says it is longer than the file", [...id3(500, { sizeBytes: [0, 0x7f, 0x7f, 0x7f] }), ...silentMp3(8)])
sample("mp3: an ID3 tag that ends where the file ends", id3(4096))
sample("mp3: an ID3 tag one frame short of the end", [...id3(4096), ...frame()])
sample("mp3: nine bytes of an ID3 header", [text("ID3"), hex([3, 0, 0, 0, 0, 0])])
sample("mp3: ten bytes of an ID3 header", [text("ID3"), hex([3, 0, 0, 0, 0, 0, 0])])
sample("mp3: an ID3v1 tag at the end", [...silentMp3(10), text("TAG"), { zeros: 125 }])
// Padding and junk before the first frame.
for (const junk of [1, 100, 417, 4000, 4095, 4096, 4097, 9000]) sample(`mp3 behind ${junk} zero bytes`, [{ zeros: junk }, ...silentMp3(8)])
for (const junk of [100, 4000, 4095, 4096]) sample(`mp3 behind an ID3 tag and ${junk} zero bytes`, [...id3(1000), { zeros: junk }, ...silentMp3(8)])
sample("mp3 behind noise", [{ noise: [21, 2000] }, ...silentMp3(8)])
sample("mp3 behind noise full of sync words", [{ repeat: [hex([0xff, 0xfb, 0x90, 0x64]), { noise: [8, 60] }], times: 40 }, ...silentMp3(8)])
sample("mp3: only noise", [{ noise: [22, 9000] }])
sample("mp3: only noise full of sync words", [{ repeat: [hex([0xff, 0xfb, 0x90, 0x64]), { noise: [9, 60] }], times: 200 }])
sample("mp3: only 0xff bytes", [{ repeat: [hex([0xff])], times: 6000 }])
// How it ends.
sample("mp3: a single frame", frame())
sample("mp3: a single frame and one byte", [...frame(), { zeros: 1 }])
sample("mp3: a single frame and noise", [...frame(), { noise: [4, 500] }])
sample("mp3: two frames", [frames(2)])
sample("mp3: a frame cut one byte short", [{ hex: bytes(frame()).subarray(0, 416).toString("hex") }])
sample("mp3: a frame header and nothing else", [hex(frameHeader({}))])
sample("mp3: three bytes of a frame header", [hex(frameHeader({}).slice(0, 3))])
sample("mp3: a frame and a half", [{ hex: bytes([frames(2)]).subarray(0, 600).toString("hex") }])
sample("mp3: frames of two bitrates", [...frame({ bitrateIndex: 9 }), ...frame({ bitrateIndex: 5 }), ...frame({ bitrateIndex: 14 }), frames(3)])
sample("mp3: a padded frame then plain ones", [...frame({ padding: true }), frames(5)])
// What is not Layer III.
sample("mp3: the reserved version", [{ repeat: [hex(frameHeader({ version: 1 })), { zeros: 413 }], times: 5 }])
sample("mp3: Layer II frames", [{ repeat: [hex(frameHeader({ layer: 2 })), { zeros: 413 }], times: 5 }])
sample("mp3: Layer I frames", [{ repeat: [hex(frameHeader({ layer: 3 })), { zeros: 413 }], times: 5 }])
sample("mp3: the reserved layer", [{ repeat: [hex(frameHeader({ layer: 0 })), { zeros: 413 }], times: 5 }])
sample("mp3: the free bitrate", [{ repeat: [hex(frameHeader({ bitrateIndex: 0 })), { zeros: 413 }], times: 5 }])
sample("mp3: the bad bitrate", [{ repeat: [hex(frameHeader({ bitrateIndex: 15 })), { zeros: 413 }], times: 5 }])
sample("mp3: the reserved sample rate", [{ repeat: [hex(frameHeader({ rateIndex: 3 })), { zeros: 413 }], times: 5 }])
sample("mp3: Layer II junk, then real frames", [{ repeat: [hex(frameHeader({ layer: 2 })), { zeros: 100 }], times: 3 }, ...silentMp3(6)])
sample("empty", [])
sample("one zero byte", [{ zeros: 1 }])
sample("a megabyte of zeros", [{ zeros: 1024 * 1024 }])
sample("text", [text("RIFF is not what this is, nor ID3.")])
for (let seed = 100; seed < 140; seed += 1) sample(`noise ${seed}`, [{ noise: [seed, 300 + seed * 13] }])
{
  const whole = bytes([...id3(40), ...silentMp3(3)])
  for (let length = 0; length < whole.length; length += 37) sample(`tagged mp3 cut to ${length} bytes`, [hex(whole.subarray(0, length))])
}

{
  const dir = path.join(TMP, "samples")
  fs.mkdirSync(dir)
  const cases: Json[] = []
  let frameCases = 0
  samples.forEach((entry, index) => {
    const data = bytes(entry.parts)
    const file = path.join(dir, `sample-${index}`)
    fs.writeFileSync(file, data)
    const first = mp3Frame(data, 0)
    const starts = new Set([0, 1, 2, 4, 10, 417, 418, 1000, Math.max(0, data.length - 5), Math.max(0, data.length - 4), Math.max(0, data.length - 3), data.length, data.length + 10])
    if (first) for (const start of [first.at, first.at + 1, first.at + first.length, first.at + first.length + 1]) starts.add(start)
    const found = [...starts].sort((a, b) => a - b).map((start) => ({ start, frame: mp3Frame(data, start) as Json }))
    frameCases += found.length
    cases.push({
      name: entry.name,
      parts: entry.parts as Json,
      bytes: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      isWav: isAudio(data, "audio/wav"),
      isMp3: isAudio(data, "audio/mpeg"),
      wavDurationMs: wavDurationMs(file),
      mp3DurationMs: mp3DurationMs(file),
      frames: found
    })
  })
  cases.push({
    name: "a file that is not there", parts: null, bytes: 0, sha256: "", isWav: false, isMp3: false,
    wavDurationMs: wavDurationMs(path.join(dir, "missing")), mp3DurationMs: mp3DurationMs(path.join(dir, "missing")), frames: []
  })
  write("files.json", cases)
  counts["files.json: mp3Frame calls"] = frameCases
}

// ----------------------------------------------------------------- names

{
  const long = "é".repeat(100)
  const names: string[] = [
    encodeURIComponent("Café ñandú 日本 Ελλάδα (1) [x]-y.mp3"), encodeURIComponent("Café"), encodeURIComponent("../a\u0007/b<>%.wav"), "100% done",
    "", " ", "plain.wav", "under_score-dash (1) [2].mp3", "a/b\\c:d*e?f\"g<h>i|j", "tab\there", "line\nbreak", "nul\u0000l", "..", "...", ".hidden", "~tilde", "a+b=c", "#1 & co.", "semi;colon", "quote's", "at@sign", "dollar$", "caret^", "back`tick", "curly{}", "comma,", "excl!",
    "%", "%%", "%4", "%4G", "%41", "%41%42%43", "%e4", "%E4%B8%AD", "%e4%b8%ad", "%E4%B8", "%E4%B8%", "%C0%AF", "%ED%A0%80", "%F4%90%80%80", "%F0%9F%8E%B5", "%F0%9F%8E", "%FF", "%80", "%C3%28", "a%20b", "a+b", "%2F%2e%2E%2f", "%25", "%2525", "%00", "%0A", "%7F", "%C2%A0", "%E2%80%8B", "%e2%80%AE",
    "caf%C3%A9 %ZZ", "ok%C3%A9%", "ΑΒΓ%", "日本%E6%97%A5", "é%41",
    "é", "å", "Å", "Ω", "ﬁ", "ẛ̣", "̀", "한글", "한", "각", "ཱི", "ﬀ", "①②③", "½", "x²", "Ⅻ", "٣", "१२३", "𝟘𝟙", "𝒜𝒷", "𐐀", "🎵 song", "👩‍👩‍👧", "🇨🇴", "a‍b", "a​b", "a b", "a　b", "a b", "﻿bom", "right‮left", "שלום", "مرحبا", "ไทย", "हिन्दी", "ქართული", "ᚠᚢᚦ", "ꙮ", "́alone", "á́́", "\u{e0100}", "\u{10ffff}", "�", "",
    long, encodeURIComponent(long), "é".repeat(100), "🎵".repeat(100), "a".repeat(79) + "🎵b", "a".repeat(80) + "b", `${"a".repeat(79)}éx`, "/".repeat(50) + "a".repeat(100), "𝒜".repeat(81), " ".repeat(100), "a b ".repeat(30)
  ]
  write("safe-name.json", names.map((input) => ({ input, output: safeName(input) })))

  // Every character on its own: which stay as they are, which stay as another
  // (NFC), and which had no meaning yet in the Unicode this Node carries (a
  // newer Unicode may know them as letters; that is the one difference allowed).
  const kept: [number, number][] = []
  const unassigned: [number, number][] = []
  const changed: [number, string][] = []
  const extend = (ranges: [number, number][], point: number): void => {
    const last = ranges[ranges.length - 1]
    if (last && last[1] === point - 1) last[1] = point
    else ranges.push([point, point])
  }
  for (let point = 0; point <= 0x10ffff; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue
    const character = String.fromCodePoint(point)
    const output = safeName(character)
    if (output === character) extend(kept, point)
    else if (output !== "") changed.push([point, output])
    if (/^\p{Cn}$/u.test(character)) extend(unassigned, point)
  }
  write("safe-name-characters.json", [{ unicode: process.versions.unicode ?? "", kept, changed, unassigned }])
  counts["safe-name-characters.json: characters"] = 0x110000 - 0x800
}

// ------------------------------------------------------------------ gain

{
  const levels: number[] = []
  for (let i = 0; i <= 1000; i += 1) levels.push(i / 1000)
  levels.push(-0, -0.5, -1, 1.0000001, 1.5, 2, 100, 0.1 + 0.2, 1 / 3, Math.SQRT1_2, 5e-324, 1e-200, 0.9999999999999999, Infinity, -Infinity, NaN)
  write("gain.json", levels.map((level) => ({ input: bits(level), output: bits(gainFor(level)) })))
}

// ----------------------------------------------------------------- store

type Step =
  | { op: "ensureDefaults" }
  | { op: "saveUpload"; slot: number; type: AudioType; data: Part[]; name: string | null }
  | { op: "revert"; slot: number }
  | { op: "setDuration"; slot: number; ms: number }
  /** Not the store: the folder is changed behind its back. */
  | { op: "writeFile"; name: string; data: Part[] }
  | { op: "removeFile"; name: string }

interface Scenario { name: string; steps: Step[] }

const upload = (slot: number, type: AudioType, data: Part[], name: string | null = null): Step => ({ op: "saveUpload", slot, type, data, name })
const json = (value: Json): Part[] => [text(JSON.stringify(value, null, 2) + "\n")]
/** An MP3 whose length cannot be read from it: no second frame where the first ends. */
const oddMp3: Part[] = [...frame(), { noise: [4, 500] }]

const scenarios: Scenario[] = [
  { name: "first run", steps: [{ op: "ensureDefaults" }, { op: "ensureDefaults" }] },
  {
    name: "uploads and restores",
    steps: [
      { op: "ensureDefaults" },
      upload(2, "audio/wav", silentWav(1500), encodeURIComponent("Café ñandú 日本 (take 2).wav")),
      upload(2, "audio/mpeg", silentMp3(100), "over it.mp3"),
      upload(8, "audio/mpeg", [...id3(3000), ...silentMp3(200, true)], "%E2%9C%93 last"),
      upload(1, "audio/wav", silentWav(800), null),
      upload(2, "audio/wav", silentWav(300), "back to wav"),
      { op: "setDuration", slot: 2, ms: 900 },
      { op: "setDuration", slot: 8, ms: 4321 },
      { op: "setDuration", slot: 5, ms: 4321 },
      { op: "revert", slot: 2 },
      { op: "revert", slot: 2 },
      { op: "revert", slot: 5 },
      { op: "ensureDefaults" },
      { op: "revert", slot: 8 },
      { op: "revert", slot: 1 }
    ]
  },
  {
    name: "an MP3 whose length is learned from a play",
    steps: [
      { op: "ensureDefaults" },
      upload(4, "audio/mpeg", oddMp3, "odd.mp3"),
      { op: "setDuration", slot: 4, ms: 0 },
      { op: "setDuration", slot: 4, ms: -20 },
      { op: "setDuration", slot: 4, ms: NaN },
      { op: "setDuration", slot: 4, ms: 0.4 },
      { op: "setDuration", slot: 4, ms: 1234.4 },
      { op: "setDuration", slot: 4, ms: 1233.5 },
      { op: "setDuration", slot: 4, ms: 1234.5 },
      { op: "setDuration", slot: 4, ms: 1e12 },
      upload(4, "audio/mpeg", oddMp3, "odd again.mp3"),
      upload(3, "audio/mpeg", silentMp3(50), "even.mp3"),
      { op: "setDuration", slot: 3, ms: 77 },
      { op: "revert", slot: 4 }
    ]
  },
  {
    name: "a folder from an earlier version",
    steps: [
      { op: "writeFile", name: "sounds.json", data: json({ 3: "mp3", 5: "wav", 6: "ogg", extra: "kept", 7: { ext: "mp3", name: 7, uploadedAt: 5, durationMs: "long" }, 2: { ext: "flac", name: "two", uploadedAt: "2020-01-02T03:04:05.678Z", durationMs: 2500, more: true } }) },
      { op: "writeFile", name: "sound-3.mp3", data: silentMp3(30) },
      { op: "writeFile", name: "sound-5.wav", data: silentWav(700) },
      { op: "writeFile", name: "sound-7.mp3", data: oddMp3 },
      { op: "ensureDefaults" },
      { op: "setDuration", slot: 3, ms: 500 },
      { op: "setDuration", slot: 7, ms: 640.2 },
      { op: "setDuration", slot: 5, ms: 640 },
      { op: "setDuration", slot: 6, ms: 640 },
      { op: "setDuration", slot: 2, ms: 2500 },
      { op: "setDuration", slot: 2, ms: 2600 },
      upload(6, "audio/wav", silentWav(100), "six"),
      { op: "revert", slot: 3 },
      { op: "revert", slot: 2 },
      { op: "revert", slot: 7 }
    ]
  },
  {
    name: "entries that are not entries",
    steps: [
      { op: "writeFile", name: "sounds.json", data: json({ 1: null, 2: 0, 3: "", 4: false, 5: 12, 6: true, 7: ["mp3"], 8: {}, 9: { ext: "mp3" }, "02": "mp3", " 4 ": "mp3", "1e0": "mp3", slot: { ext: "mp3" } }) },
      { op: "ensureDefaults" },
      { op: "revert", slot: 1 },
      { op: "revert", slot: 5 },
      { op: "revert", slot: 7 },
      { op: "revert", slot: 8 },
      { op: "setDuration", slot: 8, ms: 100 },
      { op: "setDuration", slot: 6, ms: 100 },
      upload(3, "audio/mpeg", silentMp3(10), "three"),
      { op: "ensureDefaults" }
    ]
  },
  {
    name: "a map with fractional and zero lengths",
    steps: [
      { op: "writeFile", name: "sounds.json", data: json({ 1: { ext: "mp3", name: "a", durationMs: 12.5 }, 2: { ext: "mp3", name: "b", durationMs: 0 }, 3: { ext: "mp3", name: "c", durationMs: -4 }, 4: { ext: "wav", name: "d", durationMs: 99 } }) },
      { op: "writeFile", name: "sound-1.mp3", data: oddMp3 },
      { op: "writeFile", name: "sound-2.mp3", data: oddMp3 },
      { op: "writeFile", name: "sound-3.mp3", data: oddMp3 },
      { op: "writeFile", name: "sound-4.wav", data: [text("RIFF")] },
      { op: "ensureDefaults" },
      { op: "setDuration", slot: 1, ms: 12.5 },
      { op: "setDuration", slot: 1, ms: 13 },
      { op: "setDuration", slot: 4, ms: 50 }
    ]
  },
  {
    name: "a map that cannot be read",
    steps: [
      { op: "writeFile", name: "sounds.json", data: [text("{ \"2\": \"mp3\", ")] },
      { op: "writeFile", name: "sound-2.mp3", data: silentMp3(10) },
      { op: "ensureDefaults" },
      upload(2, "audio/mpeg", silentMp3(12), "again"),
      { op: "revert", slot: 2 }
    ]
  },
  {
    name: "a map that is a list",
    steps: [
      { op: "writeFile", name: "sounds.json", data: json(["mp3", "mp3"]) },
      { op: "ensureDefaults" },
      upload(1, "audio/wav", silentWav(10), "one"),
      { op: "writeFile", name: "sounds.json", data: [text("null\n")] },
      { op: "ensureDefaults" },
      { op: "setDuration", slot: 1, ms: 5 }
    ]
  },
  {
    name: "files that go missing",
    steps: [
      { op: "ensureDefaults" },
      upload(2, "audio/mpeg", silentMp3(10), "two"),
      upload(3, "audio/wav", silentWav(10), "three"),
      { op: "removeFile", name: "sound-2.mp3" },
      { op: "removeFile", name: "sound-3.wav" },
      { op: "removeFile", name: "sound-5.wav" },
      { op: "writeFile", name: "sound-6.mp3", data: silentMp3(10) },
      { op: "ensureDefaults" },
      { op: "revert", slot: 2 },
      upload(3, "audio/mpeg", silentMp3(10), "three again"),
      { op: "writeFile", name: "sound-3.wav", data: silentWav(10) },
      upload(3, "audio/wav", silentWav(20), "and again"),
      { op: "removeFile", name: "sounds.json" },
      { op: "removeFile", name: "sounds.json.bak" },
      { op: "ensureDefaults" }
    ]
  }
]

{
  const START = Date.UTC(2026, 10, 20, 12, 34, 56, 789)
  mock.timers.enable({ apis: ["Date"], now: START })
  const tonesOut = path.join(OUT, "tones")
  fs.mkdirSync(tonesOut, { recursive: true })
  const cases: Json[] = []
  let steps = 0
  scenarios.forEach((scenario, index) => {
    const dir = path.join(TMP, `store-${index}`, "sounds")
    // The folder is not made here: the store makes it.
    const store = createSoundStore(dir)
    const done: Json[] = []
    scenario.steps.forEach((step, at) => {
      mock.timers.setTime(START + (index * 100 + at) * 61_001)
      const now = new Date().toISOString()
      let result: Json = null
      if (step.op === "ensureDefaults") store.ensureDefaults()
      else if (step.op === "saveUpload") store.saveUpload(step.slot, step.type, bytes(step.data), step.name ?? undefined)
      else if (step.op === "revert") result = store.revert(step.slot)
      else if (step.op === "setDuration") result = store.setDuration(step.slot, step.ms)
      else if (step.op === "writeFile") {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, step.name), bytes(step.data))
      } else fs.rmSync(path.join(dir, step.name), { force: true })

      // Every sound file gets a time of its own, to the fraction of a
      // millisecond, so `updatedAt` can be compared.
      for (const name of fs.readdirSync(dir)) {
        const slot = /^sound-(\d+)\./.exec(name)
        if (slot) {
          const seconds = 1_700_000_000 + Number(slot[1]) * 1000 + at + (name.endsWith(".mp3") ? 0.4567 : 0.1237)
          fs.utimesSync(path.join(dir, name), seconds, seconds)
        }
      }
      const mapFile = path.join(dir, "sounds.json")
      const slots: SoundSlot[] = store.slots()
      const details = slots.map(({ slot }) => {
        const target = store.file(slot)
        return { slot, file: path.basename(target.file), ext: target.ext, isCustom: store.isCustom(slot), durationMs: store.durationMs(slot) }
      })
      // Listed last: reading a damaged map moves it aside.
      const files = fs.readdirSync(dir).sort()
      done.push({
        step: (step.op === "setDuration" ? { ...step, ms: bits(step.ms) } : step) as Json,
        now,
        result,
        soundsJson: fs.existsSync(mapFile) ? fs.readFileSync(mapFile, "utf8") : null,
        files: files.map((name) => {
          const data = fs.readFileSync(path.join(dir, name))
          // A damaged map is kept under a name with the time in it.
          return { name: name.replace(/\.corrupt-.*$/, ".corrupt-*"), bytes: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") }
        }),
        slots: slots.map((slot) => ({ ...slot })),
        details
      })
      steps += 1
    })
    cases.push({ name: scenario.name, steps: done })
    if (index === 0) {
      for (let slot = 1; slot <= 8; slot += 1) fs.copyFileSync(path.join(dir, `sound-${slot}.wav`), path.join(tonesOut, `sound-${slot}.wav`))
      counts["tones/sound-N.wav"] = 8
    }
  })
  mock.timers.reset()
  write("store.json", cases)
  counts["store.json: steps"] = steps
}

fs.rmSync(TMP, { recursive: true, force: true })
for (const name of Object.keys(counts).sort()) console.log(`${String(counts[name]).padStart(8)}  ${name}`)
