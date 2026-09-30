// Live state from the companion: theme and accent, sounds, other windows'
// saves, and the sound commands this tab may have to play.
import type { Snapshot, StatusResponse } from "../../shared/api.ts"
import { applyAccent } from "../common/dom.ts"
import { request } from "../common/http.ts"
import { activeTheme, setTheme } from "./appearance.ts"
import { showTabletCount } from "./pairing.ts"
import { AUDIO_ID, handleSoundCommands, renderNowPlaying, setSoundVolume } from "./sound-output.ts"
import { loadSounds } from "./sounds.ts"
import { reloadLibrary, saveTimerPending, store } from "./state.ts"

let knownSoundsRev: number | null = null

function handle(state: Snapshot): void {
  if (state.accent) applyAccent(state.accent)
  if (state.theme && state.theme !== activeTheme()) setTheme(state.theme)
  if (knownSoundsRev !== null && state.soundsRev !== knownSoundsRev) void loadSounds()
  knownSoundsRev = state.soundsRev
  // Another window saved: follow it, unless an edit here is on its way (that
  // save gets the conflict and reloads instead).
  if (store.libraryRev !== null && state.libraryRev > store.libraryRev && !store.saving && !saveTimerPending()) {
    void reloadLibrary("Updated with changes from another window.")
  }
  if (typeof state.levels.sounds === "number") setSoundVolume(state.levels.sounds)
  renderNowPlaying(state.playing)
  showTabletCount(state.tablets)
  handleSoundCommands(state.soundCommands, state.audioOutput)
}

export function watchEvents(): void {
  if (window.EventSource) {
    const source = new EventSource(`/api/events?audio=${AUDIO_ID}`)
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        handle(JSON.parse(event.data) as Snapshot)
      } catch {
        // A malformed frame is skipped; the next one carries the full state.
      }
    }
    // A stream left open on unload is logged by the browser as an error.
    window.addEventListener("pagehide", () => source.close())
    return
  }
  window.setInterval(() => {
    request<StatusResponse>("/api/status").then(handle).catch(() => {})
  }, 1500)
}
