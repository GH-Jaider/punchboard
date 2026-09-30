// Live state pushed to every connected page over server-sent events: button
// toggles, fader levels, revisions, and sound playback.
//
// Sound playback is a toggle the server owns. One Control Center tab is the
// audio output: it plays what it is told, reports when a sound ends, and a
// second press on the same sound stops it instead of stacking another copy.
import type { ServerResponse } from "node:http"
import type { ObsLink, Snapshot, SoundCommand, SoundPlayback } from "../shared/api.ts"
import type { ThemeId } from "../shared/types.ts"
import type { Request } from "./http.ts"

export interface LiveSettings {
  accent: () => string
  theme: () => ThemeId
  libraryRev: () => number
  obs: () => ObsLink
  /** A sound's length, so decks can draw its progress; null while unknown. */
  soundDuration: (slot: number) => number | null
}

export type Live = ReturnType<typeof createLive>

export function createLive(settings: LiveSettings, soundVolume: number) {
  const toggles = new Map<string, boolean>()
  const playing = new Set<number>()
  /** When each playing sound started and how long it runs, for progress. */
  const playback: Record<string, SoundPlayback> = {}
  const soundCommands: SoundCommand[] = []
  let soundSeq = 0
  let soundsRev = 1
  /** Control Center tabs that can play audio; the newest one plays. */
  const audioOutputs = new Map<string, ServerResponse>()
  /** Fader levels by target key, 0..1, so every deck agrees. */
  const levels: Record<string, number> = { sounds: soundVolume }
  /** Open streams, each with its device id ("" for this computer). */
  const listeners = new Map<ServerResponse, string>()

  function audioOutputId(): string | null {
    let newest: string | null = null
    for (const id of audioOutputs.keys()) newest = id
    return newest
  }

  function snapshot(): Snapshot {
    return {
      libraryRev: settings.libraryRev(),
      soundsRev,
      toggles: Object.fromEntries(toggles),
      soundCommands,
      playing: [...playing],
      audioOutput: audioOutputId(),
      levels,
      playback,
      obs: settings.obs(),
      tablets: new Set([...listeners.values()].filter(Boolean)).size,
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
  function broadcastMeters(levels: Record<string, number>): void {
    const payload = `event: meters\ndata: ${JSON.stringify({ levels })}\n\n`
    for (const res of listeners.keys()) {
      try { res.write(payload) } catch { listeners.delete(res) }
    }
  }

  const hasListeners = (): boolean => listeners.size > 0

  function clearPlayback(slot?: number): void {
    if (slot === undefined) for (const key of Object.keys(playback)) delete playback[key]
    else delete playback[String(slot)]
  }

  function openStream(req: Request, res: ServerResponse, { deviceId = "", audioId = "" }: { deviceId?: string; audioId?: string }): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    })
    res.write("retry: 2000\n\n")
    listeners.set(res, deviceId)
    if (deviceId) broadcast()
    if (audioId) {
      // Re-adding moves it to the end, so a reloaded tab becomes the output again.
      audioOutputs.delete(audioId)
      audioOutputs.set(audioId, res)
      broadcast()
    } else {
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    }
    // A comment frame keeps intermediaries and sleeping wifi from dropping it.
    const beat = setInterval(() => { try { res.write(": beat\n\n") } catch { /* closing */ } }, 20000)
    const close = (): void => {
      clearInterval(beat)
      listeners.delete(res)
      // A tablet leaving changes the count the Control Center shows.
      if (deviceId) broadcast()
      if (!audioId || audioOutputs.get(audioId) !== res) return
      const wasPlaying = audioOutputId() === audioId
      audioOutputs.delete(audioId)
      // Its audio died with the tab, so nothing is playing any more.
      if (wasPlaying) {
        playing.clear()
        clearPlayback()
      }
      broadcast()
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

  function sendSoundCommand(slot: number, action: SoundCommand["action"]): void {
    soundSeq += 1
    soundCommands.push({ id: soundSeq, slot, action })
    if (soundCommands.length > 20) soundCommands.shift()
    if (action === "play") {
      playing.add(slot)
      playback[String(slot)] = { startedAt: Date.now(), durationMs: settings.soundDuration(slot) }
    } else {
      playing.delete(slot)
      clearPlayback(slot)
    }
    broadcast()
  }

  function toggleSound(slot: number): void {
    if (!audioOutputId()) throw new Error("Open the Control Center on this computer to play sounds.")
    sendSoundCommand(slot, playing.has(slot) ? "stop" : "play")
  }

  function soundEnded(slot: number): void {
    clearPlayback(slot)
    if (playing.delete(slot)) broadcast()
  }

  function stopAllSounds(): void {
    for (const slot of [...playing]) sendSoundCommand(slot, "stop")
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
