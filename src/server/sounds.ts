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

/** Checks the file's own header rather than trusting its extension. */
export function isAudio(data: Buffer, type: AudioType): boolean {
  if (type === "audio/wav") return data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WAVE"
  return data.subarray(0, 3).toString() === "ID3" || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0)
}

/** Only ever shown back to the user; the file on disk is always sound-N.ext. */
const safeName = (value: unknown): string => String(value ?? "").replace(/[^\w .()[\]-]/g, "").slice(0, 80)

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

  /** A WAV's length from its header: data bytes over the byte rate. Chunks are
      walked rather than assumed at fixed offsets, since editors add LIST chunks. */
  function wavDurationMs(file: string): number | null {
    let handle: number | null = null
    try {
      handle = fs.openSync(file, "r")
      const size = fs.fstatSync(handle).size
      const head = Buffer.alloc(Math.min(size, 64 * 1024))
      fs.readSync(handle, head, 0, head.length, 0)
      if (head.length < 12 || head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null
      let byteRate = 0
      let offset = 12
      while (offset + 8 <= head.length) {
        const id = head.toString("ascii", offset, offset + 4)
        const length = head.readUInt32LE(offset + 4)
        if (id === "fmt " && offset + 16 <= head.length) byteRate = head.readUInt32LE(offset + 16)
        if (id === "data") {
          // A streaming writer may leave the size blank; the file's tail is the data then.
          const dataBytes = length && length !== 0xffffffff ? length : size - offset - 8
          return byteRate > 0 ? Math.round((dataBytes / byteRate) * 1000) : null
        }
        offset += 8 + length + (length % 2)
      }
      return null
    } catch {
      return null
    } finally {
      if (handle !== null) fs.closeSync(handle)
    }
  }

  function durationMs(slot: number): number | null {
    const target = file(slot)
    if (target.ext === "wav") return fs.existsSync(target.file) ? wavDurationMs(target.file) : null
    return entry(slot)?.durationMs ?? null
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
