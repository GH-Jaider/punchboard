// Live state pushed to every connected page over server-sent events: button
// toggles, fader levels, revisions, sound playback, meters.
import type { ServerResponse } from "node:http"
import type { ObsLink, Snapshot, SoundPlayback } from "../shared/api.ts"
import type { ThemeId } from "../shared/types.ts"
import type { Request } from "./http.ts"
import type { Player } from "./player.ts"

export interface LiveSettings {
  accent: () => string
  theme: () => ThemeId
  libraryRev: () => number
  build: () => string
  obs: () => ObsLink
  /** A sound's length, so decks can draw its progress; null while unknown. */
  soundDuration: (slot: number) => number | null
  /** The file behind a slot, for the player. */
  soundFile: (slot: number) => string
}

export type Live = ReturnType<typeof createLive>

export function createLive(settings: LiveSettings, player: Player, soundVolume: number) {
  const toggles = new Map<string, boolean>()
  /** When each playing sound started and how long it runs, for progress. */
  const playback: Record<string, SoundPlayback> = {}
  let soundsRev = 1
  /** Fader levels by target key, 0..1, so every deck agrees. */
  const levels: Record<string, number> = { sounds: soundVolume }
  /** Open streams, each with its device id ("" for this computer). */
  const listeners = new Map<ServerResponse, string>()

  function snapshot(): Snapshot {
    return {
      libraryRev: settings.libraryRev(),
      soundsRev,
      toggles: Object.fromEntries(toggles),
      playing: player.playing(),
      playback,
      levels,
      obs: settings.obs(),
      tablets: new Set([...listeners.values()].filter(Boolean)).size,
      build: settings.build(),
      accent: settings.accent(),
      theme: settings.theme()
    }
  }

  function broadcast(): void {
    const payload = `data: ${JSON.stringify(snapshot())}\n\n`
    for (const res of listeners.keys()) {
      try { res.write(payload) } catch { listeners.delete(res) }
    }
  }

  /** Meter levels go out as their own event, so 15 updates a second never
      carry the whole snapshot with them. */
  function broadcastMeters(levelsNow: Record<string, number>): void {
    const payload = `event: meters\ndata: ${JSON.stringify({ levels: levelsNow })}\n\n`
    for (const res of listeners.keys()) {
      try { res.write(payload) } catch { listeners.delete(res) }
    }
  }

  const hasListeners = (): boolean => listeners.size > 0

  function openStream(req: Request, res: ServerResponse, deviceId: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })
    res.write("retry: 2000\n\n")
    listeners.set(res, deviceId)
    // A tablet arriving changes the count the Control Center shows.
    if (deviceId) broadcast()
    else res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    // A comment frame keeps intermediaries and sleeping wifi from dropping it.
    const beat = setInterval(() => { try { res.write(": beat\n\n") } catch { /* closing */ } }, 20000)
    const close = (): void => {
      clearInterval(beat)
      listeners.delete(res)
      if (deviceId) broadcast()
    }
    req.on("close", close)
    req.on("error", close)
  }

  /** Ends a revoked device's live streams, so it notices straight away. */
  function disconnectDevice(deviceId: string): void {
    for (const [res, owner] of listeners) {
      if (owner !== deviceId) continue
      try { res.end() } catch { /* already closed */ }
      listeners.delete(res)
    }
  }

  function closeAll(): void {
    for (const res of listeners.keys()) {
      try { res.end() } catch { /* already closed */ }
    }
  }

  // ---------------------------------------------------------------- sounds

  /** A second press on a playing sound stops it instead of stacking a copy. */
  function toggleSound(slot: number): void {
    if (player.stop(slot)) return
    player.play(slot, settings.soundFile(slot))
    playback[String(slot)] = { startedAt: player.startedAt(slot) ?? Date.now(), durationMs: settings.soundDuration(slot) }
    broadcast()
  }

  /** The player reports every end, requested or natural. */
  function soundEnded(slot: number): void {
    delete playback[String(slot)]
    broadcast()
  }

  function stopAllSounds(): void {
    player.stopAll()
  }

  function setToggle(key: string, active: boolean): void {
    // Written when it turns off too, so a tile can never latch on for good.
    toggles.set(key, active)
    broadcast()
  }

  function soundsChanged(): void {
    soundsRev += 1
    broadcast()
  }

  return { levels, snapshot, broadcast, broadcastMeters, hasListeners, openStream, disconnectDevice, closeAll, toggleSound, soundEnded, stopAllSounds, setToggle, soundsChanged }
}
