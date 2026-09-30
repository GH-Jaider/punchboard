// Live state from the companion: theme and accent, sounds, other windows'
// saves, devices, OBS.
import type { Snapshot, StatusResponse } from "../../shared/api.ts"
import { applyAccent } from "../common/dom.ts"
import { toast } from "./hub.ts"
import { request } from "../common/http.ts"
import { activeTheme, setTheme } from "./appearance.ts"
import { showObsLink } from "./obs.ts"
import { noteObsLink } from "./obs-names.ts"
import { showDeviceCount } from "./pairing.ts"
import { renderNowPlaying } from "./sound-output.ts"
import { loadSounds, showPlaying } from "./sounds.ts"
import { reloadLibrary, saveTimerPending, store } from "./state.ts"

let loadedBuild: string | null = null
let reloadOffered = false

let knownSoundsRev: number | null = null

function handle(state: Snapshot): void {
  if (state.accent) applyAccent(state.accent)
  if (state.theme && state.theme !== activeTheme()) setTheme(state.theme)
  if (knownSoundsRev !== null && state.soundsRev !== knownSoundsRev) void loadSounds()
  knownSoundsRev = state.soundsRev
  // Another window saved: follow it, unless an edit here is on its way (that
  // save gets the conflict and reloads instead).
  if (state.build) {
    if (loadedBuild === null) loadedBuild = state.build
    else if (state.build !== loadedBuild && !reloadOffered) {
      // Not automatic here: an edit could be mid-flight. The toast waits for the click.
      reloadOffered = true
      toast("Punchboard was updated. Reload to get the new version.", false, { label: "Reload", onClick: () => location.reload() })
    }
  }
  if (store.libraryRev !== null && state.libraryRev > store.libraryRev && !store.saving && !saveTimerPending()) {
    void reloadLibrary("Updated with changes from another window.")
  }
  renderNowPlaying(state.playback)
  showPlaying(state.playing)
  showDeviceCount(state.tablets)
  showObsLink(state.obs, state.obsIssue)
  noteObsLink(state.obs)
}

export function watchEvents(): void {
  if (window.EventSource) {
    const source = new EventSource("/api/events")
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
