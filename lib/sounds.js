// Generates 8 short, distinct-pitch tone WAV files on first run, so Play Sound
// buttons work out of the box with no audio files to source. Pure Node (no
// dependency): writes a 16-bit PCM mono WAV directly.
const fs = require("fs")
const path = require("path")

const SAMPLE_RATE = 44100
const DURATION_S = 0.35

function toneBuffer(freqHz) {
  const numSamples = Math.floor(SAMPLE_RATE * DURATION_S)
  const data = Buffer.alloc(numSamples * 2)
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE
    // simple envelope so it doesn't click at the edges
    const envelope = Math.min(1, t * 40) * Math.min(1, (DURATION_S - t) * 40)
    const sample = Math.sin(2 * Math.PI * freqHz * t) * envelope * 0.35
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2)
  }
  const header = Buffer.alloc(44)
  const byteRate = SAMPLE_RATE * 2
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function writeTone(soundsDir, slot) {
  const freq = 220 * Math.pow(2, (slot - 1) / 4) // rising pitch per slot
  fs.writeFileSync(path.join(soundsDir, `sound-${slot}.wav`), toneBuffer(freq))
}

/**
 * Fills the sounds/ folder with sound-1.wav..sound-8.wav if any are missing.
 * `skipSlots` holds the slots the user has replaced with their own audio;
 * generating a tone for those would leave a stale sound-N.wav sitting beside
 * their sound-N.mp3.
 */
function ensureDefaultSounds(soundsDir, skipSlots) {
  const skip = new Set(skipSlots || [])
  fs.mkdirSync(soundsDir, { recursive: true })
  for (let slot = 1; slot <= 8; slot++) {
    if (skip.has(slot) || skip.has(String(slot))) continue
    if (!fs.existsSync(path.join(soundsDir, `sound-${slot}.wav`))) writeTone(soundsDir, slot)
  }
}

/** Puts one slot back to the tone it shipped with. */
function restoreDefaultSound(soundsDir, slot) {
  fs.mkdirSync(soundsDir, { recursive: true })
  writeTone(soundsDir, slot)
}

module.exports = { ensureDefaultSounds, restoreDefaultSound }
