// This tab as the computer's sound output. Decks cannot play audio, so the
// Control Center does. The server owns the state: it decides play or stop and
// knows what is playing; this tab obeys and reports when a sound ends on its
// own. With several Control Center tabs open only the newest plays.
import type { Ok, SoundCommand, SoundPlayback } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"
import { formatDuration, learnDuration, playback, setPreviewVolume, soundUrl } from "./sounds.ts"

export const AUDIO_ID = `cc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** Sounds a deck started, by slot. */
const deckAudio = new Map<number, HTMLAudioElement>()
let lastCommandId: number | null = null

function reportEnded(slot: number): void {
  request<Ok>("/api/sounds/ended", { method: "POST", json: { slot } }).catch(() => {})
}

function stopDeckSound(slot: number): void {
  const audio = deckAudio.get(slot)
  if (!audio) return
  deckAudio.delete(slot)
  audio.pause()
}

function playDeckSound(slot: number): void {
  stopDeckSound(slot)
  if (!playback.unlocked) {
    toast(`A deck asked for Sound ${slot}. Click anywhere on this page once to allow playback.`, true)
    reportEnded(slot)
    return
  }
  const audio = new Audio(soundUrl(slot))
  audio.volume = playback.volume
  learnDuration(slot, audio)
  deckAudio.set(slot, audio)
  const finish = (): void => {
    if (deckAudio.get(slot) !== audio) return
    deckAudio.delete(slot)
    reportEnded(slot)
  }
  audio.addEventListener("ended", finish)
  audio.addEventListener("error", () => {
    if (deckAudio.get(slot) === audio) toast(`Sound ${slot} could not be played.`, true)
    finish()
  })
  audio.play().catch(() => {
    toast("Your browser blocked playback. Click anywhere on this page once to allow it.", true)
    finish()
  })
}

export function setSoundVolume(level: number): void {
  playback.volume = Math.max(0, Math.min(1, level))
  deckAudio.forEach((audio) => { audio.volume = playback.volume })
  setPreviewVolume(playback.volume)
}

/** What is playing, so the Stop button can count down. This tab runs on the
    server's computer, so Date.now() is the server clock. */
let current: Record<string, SoundPlayback> = {}
let ticker: number | undefined

function nowPlayingText(): string {
  const slots = Object.keys(current)
  if (slots.length !== 1) return `Stop ${slots.length} sounds`
  const slot = slots[0]!
  const entry = current[slot]
  const text = `Stop sound ${slot}`
  if (!entry || entry.durationMs === null) return text
  const left = Math.max(0, entry.startedAt + entry.durationMs - Date.now())
  return `${text} · ${formatDuration(left)}`
}

export function renderNowPlaying(playback: Record<string, SoundPlayback>): void {
  current = playback
  const active = Object.keys(current).length > 0
  byId("now-playing").hidden = !active
  byId("now-playing-text").textContent = active ? nowPlayingText() : "Stop sound"
  if (active && ticker === undefined) {
    ticker = window.setInterval(() => { byId("now-playing-text").textContent = nowPlayingText() }, 250)
  } else if (!active && ticker !== undefined) {
    window.clearInterval(ticker)
    ticker = undefined
  }
}

/** Follows the server's play/stop commands; only the output tab acts on them. */
export function handleSoundCommands(commands: readonly SoundCommand[], audioOutput: string | null): void {
  const isOutput = audioOutput === AUDIO_ID
  // Another tab took over: hand this tab's sounds back rather than leave them
  // playing where no stop can reach them.
  if (!isOutput) {
    for (const slot of Array.from(deckAudio.keys())) {
      stopDeckSound(slot)
      reportEnded(slot)
    }
  }

  if (lastCommandId === null) {
    // The first snapshot only says where the queue already is.
    lastCommandId = commands.length ? commands[commands.length - 1]!.id : 0
    return
  }
  for (const command of commands) {
    if (command.id <= lastCommandId) continue
    lastCommandId = command.id
    if (!isOutput) continue
    if (command.action === "stop") stopDeckSound(command.slot)
    else playDeckSound(command.slot)
  }
}

export function bindSoundOutput(): void {
  byId("now-playing").addEventListener("click", () => {
    request<Ok>("/api/sounds/stop", { method: "POST" }).catch((error: unknown) => toast(errorMessage(error), true))
  })
}
