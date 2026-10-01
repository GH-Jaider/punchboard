// The eight sound slots on disk: built-in tones generated on first run, and
// the WAV or MP3 files people upload to replace them.
import fs from "node:fs"
import path from "node:path"
import type { SoundSlot } from "../shared/api.ts"
import { LIMITS } from "../shared/actions.ts"
import { isObject, readJsonSafe, writeJsonAtomic } from "./store.ts"

const SAMPLE_RATE = 44100
const DURATION_S = 0.35

/** A short 16-bit PCM mono tone, written directly so no audio files ship. */
function toneBuffer(freqHz: number): Buffer {
  const numSamples = Math.floor(SAMPLE_RATE * DURATION_S)
  const data = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE
    // An envelope, so the tone does not click at its edges.
    const envelope = Math.min(1, t * 40) * Math.min(1, (DURATION_S - t) * 40)
    const sample = Math.sin(2 * Math.PI * freqHz * t) * envelope * 0.35
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

export type AudioType = "audio/wav" | "audio/mpeg"
type Extension = "wav" | "mp3"

interface SoundEntry { ext: Extension; name: string; uploadedAt?: string   /** Learned from the Control Center the first time an MP3 plays. */
  durationMs?: number
}

/** Reads `length` bytes at `position`, fewer at the end: from a buffer or an open file. */
type Reader = (position: number, length: number) => Buffer

const bufferReader = (data: Buffer): Reader => (position, length) => data.subarray(position, position + length)

function fileReader(handle: number, size: number): Reader {
  return (position, length) => {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - position)))
    if (buffer.length) fs.readSync(handle, buffer, 0, buffer.length, position)
    return buffer
  }
}

/** Runs `parse` on a file opened for reading; any failure is null. */
function withFile<T>(file: string, parse: (read: Reader, size: number) => T | null): T | null {
  let handle: number | null = null
  try {
    handle = fs.openSync(file, "r")
    const size = fs.fstatSync(handle).size
    return parse(fileReader(handle, size), size)
  } catch {
    return null
  } finally {
    if (handle !== null) fs.closeSync(handle)
  }
}

interface WavInfo { byteRate: number; dataBytes: number }

/** A WAV's format and data chunks. Chunks are walked rather than assumed at
    fixed offsets, since editors add LIST chunks (album art can be large). */
function wavInfo(read: Reader, size: number): WavInfo | null {
  const head = read(0, 12)
  if (head.length < 12 || head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return null
  let fmt: Buffer | null = null
  let offset = 12
  for (let chunks = 0; offset + 8 <= size && chunks < 1000; chunks += 1) {
    const chunk = read(offset, 8)
    if (chunk.length < 8) return null
    const id = chunk.toString("latin1", 0, 4)
    const length = chunk.readUInt32LE(4)
    if (id === "fmt ") {
      fmt = length >= 16 ? read(offset + 8, 16) : null
      if (!fmt || fmt.length < 16) return null
    }
    if (id === "data") {
      if (!fmt) return null
      const channels = fmt.readUInt16LE(2)
      const sampleRate = fmt.readUInt32LE(4)
      const byteRate = fmt.readUInt32LE(8)
      const blockAlign = fmt.readUInt16LE(12)
      if (!channels || !sampleRate || !byteRate || !blockAlign) return null
      // A streaming writer may leave the size blank; the file's tail is the data then.
      const tail = size - offset - 8
      const dataBytes = length && length !== 0xffffffff ? Math.min(length, tail) : tail
      return dataBytes > 0 ? { byteRate, dataBytes } : null
    }
    offset += 8 + length + (length % 2)
  }
  return null
}

/** Where the audio starts past the ID3v2 tags in front (a file can carry
    more than one). A tag's size is a 28-bit "syncsafe" number, plus a
    10-byte footer when its flags say so. Null if a tag is malformed. */
function audioStart(read: Reader): number | null {
  let offset = 0
  for (let tags = 0; tags < 8; tags += 1) {
    const header = read(offset, 10)
    if (header.length < 10 || header.toString("latin1", 0, 3) !== "ID3") return offset
    if ((header[6]! | header[7]! | header[8]! | header[9]!) & 0x80) return null
    const footer = header[5]! & 0x10 ? 10 : 0
    offset += 10 + footer + ((header[6]! << 21) | (header[7]! << 14) | (header[8]! << 7) | header[9]!)
  }
  return offset
}

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const MP3_SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
/** How far past the tags the first frame is looked for (encoders may pad). */
const FRAME_SEARCH = 4096
/** The longest Layer III frame: 320 kbps at 32 kHz, padded. */
const LONGEST_FRAME = 1441

interface Mp3Frame {
  /** Where the frame starts in the buffer searched, and its size in bytes. */
  at: number
  length: number
  bitrate: number
  sampleRate: number
  samplesPerFrame: number
  xingFrames: number | null
}

/** Reads the first Layer III frame header at or after `start`. Exposed for tests. */
export function mp3Frame(data: Buffer, start: number): Mp3Frame | null {
  for (let i = start; i + 4 <= data.length && i < start + FRAME_SEARCH; i += 1) {
    const b1 = data[i + 1]!
    if (data[i] !== 0xff || (b1 & 0xe0) !== 0xe0) continue
    const version = (b1 >> 3) & 3          // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (b1 >> 1) & 3            // 1 = Layer III
    if (version === 1 || layer !== 1) continue
    const b2 = data[i + 2]!
    const bitrateIndex = b2 >> 4
    const rateIndex = (b2 >> 2) & 3
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue
    const bitrate = (version === 3 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex]! * 1000
    const sampleRate = MP3_SAMPLE_RATES[version]![rateIndex]!
    const samplesPerFrame = version === 3 ? 1152 : 576
    const length = Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + ((b2 >> 1) & 1)
    const mono = ((data[i + 3]! >> 6) & 3) === 3
    // The Xing/Info header follows the side info, whose size depends on version and channels.
    const sideInfo = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17)
    const tag = i + 4 + sideInfo
    let xingFrames: number | null = null
    const tagName = data.toString("latin1", tag, tag + 4)
    if ((tagName === "Xing" || tagName === "Info") && tag + 12 <= data.length && (data[tag + 7]! & 1)) {
      xingFrames = data.readUInt32BE(tag + 8)
    }
    return { at: i, length, bitrate, sampleRate, samplesPerFrame, xingFrames }
  }
  return null
}

/** An MP3's first real frame, past any ID3 tags: one whose end is where the
    next frame starts (or the end of the file), so stray sync bytes do not
    count. `offset` is its place in the file. */
function firstMp3Frame(read: Reader, size: number): { frame: Mp3Frame; offset: number } | null {
  const offset = audioStart(read)
  if (offset === null || offset >= size) return null
  // Read at the frame, not from the file's start: album art makes tags large.
  const head = read(offset, FRAME_SEARCH + 2 * LONGEST_FRAME + 4)
  let from = 0
  for (;;) {
    const frame = mp3Frame(head, from)
    if (!frame || frame.at >= FRAME_SEARCH) return null
    const next = frame.at + frame.length
    const ends = offset + next >= size
    const followed = !ends && mp3Frame(head, next)?.at === next
    if (offset + next <= size && (ends || followed)) return { frame, offset: offset + frame.at }
    from = frame.at + 1
  }
}

/** An MP3's length from its first frame: a Xing/Info header gives the
    frame count (VBR), otherwise the bitrate is taken as constant. Layer III
    only, which is what an .mp3 is; anything odd returns null. */
function mp3Duration(read: Reader, size: number): number | null {
  const found = firstMp3Frame(read, size)
  if (!found) return null
  const frame = found.frame
  if (frame.xingFrames) return Math.round((frame.xingFrames * frame.samplesPerFrame / frame.sampleRate) * 1000)
  return Math.round(((size - found.offset) * 8 / frame.bitrate) * 1000)
}

/** An MP3 file's length, or null. Exposed for tests. */
export const mp3DurationMs = (file: string): number | null => withFile(file, mp3Duration)

/** A WAV file's length from its header: data bytes over the byte rate. Exposed for tests. */
export const wavDurationMs = (file: string): number | null => withFile(file, (read, size) => {
  const info = wavInfo(read, size)
  return info ? Math.round((info.dataBytes / info.byteRate) * 1000) : null
})

/** Checks the file's own structure rather than trusting its extension or
    first bytes: a WAV needs its format and data chunks, an MP3 a real
    Layer III frame after any ID3 tags. */
export function isAudio(data: Buffer, type: AudioType): boolean {
  const read = bufferReader(data)
  if (type === "audio/wav") return wavInfo(read, data.length) !== null
  return firstMp3Frame(read, data.length) !== null
}

/** Only ever shown back to the user; the file on disk is always sound-N.ext.
    The Control Center sends it URI-encoded, since a header is ASCII. Letters
    and numbers of any script stay; NFC keeps a Mac's decomposed accents whole. */
export function safeName(value: unknown): string {
  let text = String(value ?? "")
  try { text = decodeURIComponent(text) } catch { /* sent as is */ }
  return Array.from(text.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}_ .()[\]-]/gu, "")).slice(0, 80).join("")
}

export type SoundStore = ReturnType<typeof createSoundStore>

export function createSoundStore(dir: string) {
  const mapFile = path.join(dir, "sounds.json")

  function readMap(): Record<string, unknown> {
    try {
      return readJsonSafe(mapFile, isObject).data ?? {}
    } catch {
      return {}
    }
  }

  // Earlier versions stored just the extension as a bare string; both shapes
  // are read, only the richer one is written.
  function entry(slot: number): SoundEntry | null {
    const raw = readMap()[slot]
    if (!raw) return null
    if (typeof raw === "string") return { ext: raw === "mp3" ? "mp3" : "wav", name: "" }
    if (!isObject(raw)) return null
    const result: SoundEntry = { ext: raw.ext === "mp3" ? "mp3" : "wav", name: typeof raw.name === "string" ? raw.name : "" }
    if (typeof raw.uploadedAt === "string") result.uploadedAt = raw.uploadedAt
    if (typeof raw.durationMs === "number" && raw.durationMs > 0) result.durationMs = raw.durationMs
    return result
  }

  function file(slot: number): { file: string; ext: Extension } {
    const ext = entry(slot)?.ext ?? "wav"
    return { file: path.join(dir, `sound-${slot}.${ext}`), ext }
  }

  function writeTone(slot: number): void {
    const freq = 220 * Math.pow(2, (slot - 1) / 4) // rising pitch per slot
    fs.writeFileSync(path.join(dir, `sound-${slot}.wav`), toneBuffer(freq))
  }

  /** Fills in any missing built-in tones, skipping slots the user replaced. */
  function ensureDefaults(): void {
    fs.mkdirSync(dir, { recursive: true })
    const custom = new Set(Object.keys(readMap()).map(Number))
    for (let slot = 1; slot <= LIMITS.soundSlots; slot++) {
      if (custom.has(slot)) continue
      if (!fs.existsSync(path.join(dir, `sound-${slot}.wav`))) writeTone(slot)
    }
  }

  function durationMs(slot: number): number | null {
    const target = file(slot)
    if (!fs.existsSync(target.file)) return null
    if (target.ext === "wav") return wavDurationMs(target.file)
    return mp3DurationMs(target.file) ?? entry(slot)?.durationMs ?? null
  }

  /** Remembers an MP3's length once the Control Center has played it. */
  function setDuration(slot: number, ms: number): boolean {
    const map = readMap()
    const current = entry(slot)
    if (!current || current.ext !== "mp3" || !(ms > 0)) return false
    if (current.durationMs === Math.round(ms)) return false
    map[slot] = { ...current, durationMs: Math.round(ms) } satisfies SoundEntry
    writeJsonAtomic(mapFile, map)
    return true
  }

  function slots(): SoundSlot[] {
    return Array.from({ length: LIMITS.soundSlots }, (_, index) => {
      const slot = index + 1
      const info = entry(slot)
      const target = file(slot)
      const stat = fs.existsSync(target.file) ? fs.statSync(target.file) : null
      return {
        slot,
        exists: Boolean(stat),
        custom: Boolean(info),
        name: info?.name ?? "",
        format: target.ext === "mp3" ? "MP3" : "WAV",
        bytes: stat ? stat.size : 0,
        updatedAt: stat ? stat.mtime.toISOString() : null,
        durationMs: stat ? durationMs(slot) : null
      }
    })
  }

  function saveUpload(slot: number, type: AudioType, data: Buffer, name: unknown): void {
    const ext: Extension = type === "audio/wav" ? "wav" : "mp3"
    // Drop the other extension so a WAV never shadows an MP3 in the same slot.
    const other = path.join(dir, `sound-${slot}.${ext === "wav" ? "mp3" : "wav"}`)
    if (fs.existsSync(other)) fs.unlinkSync(other)
    fs.writeFileSync(path.join(dir, `sound-${slot}.${ext}`), data)
    const map = readMap()
    map[slot] = { ext, name: safeName(name), uploadedAt: new Date().toISOString() } satisfies SoundEntry
    writeJsonAtomic(mapFile, map)
  }

  /** Puts a slot back to its built-in tone. Returns false if it already holds it. */
  function revert(slot: number): boolean {
    const map = readMap()
    if (!map[slot]) return false
    const current = file(slot).file
    if (fs.existsSync(current)) fs.unlinkSync(current)
    delete map[slot]
    writeJsonAtomic(mapFile, map)
    fs.mkdirSync(dir, { recursive: true })
    writeTone(slot)
    return true
  }

  return { ensureDefaults, slots, file, saveUpload, revert, durationMs, setDuration }
}
