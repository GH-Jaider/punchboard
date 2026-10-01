// Keeping the deck in step with the companion: the library, and live state
// pushed over a signed EventSource (or polled where there is none).
import type { LibraryResponse, MetersEvent, Snapshot, StatusResponse } from "../../shared/api.ts"
import { nameDecksWith } from "../../shared/actions.ts"
import { isStateful, normalizeLibrary, shownProfiles } from "../../shared/model.ts"
import type { Button } from "../../shared/types.ts"
import { applyAccent, applyTheme } from "../common/dom.ts"
import { api, eventsUrl, UnpairedError } from "./api.ts"
import { levelFor, showLevel, syncFaders } from "./faders.ts"
import { gridEl, openedByButton, renderGrid, renderProfiles } from "./grid.ts"
import { applyMeters, updatePlayback } from "./indicators.ts"
import { activeProfile, state } from "./state.ts"
import { paintState } from "./tile-state.ts"
import { needsPairing, setOnline } from "./ui.ts"

export async function loadLibrary(): Promise<void> {
  const next = await api<LibraryResponse>("/api/library")
  const library = normalizeLibrary(next)
  state.library = library
  nameDecksWith((id) => library.profiles.find((profile) => profile.id === id)?.name)
  // A deck that is gone, or that is no longer offered here, gives way to one that is.
  const current = library.profiles.find((profile) => profile.id === state.activeId)
  if (!current || (current.hidden && !openedByButton(current.id))) {
    const first = shownProfiles(library).find((profile) => profile.id === library.activeProfileId) ?? shownProfiles(library)[0]
    state.activeId = first ? first.id : library.activeProfileId
  }
  renderProfiles()
  renderGrid()
  syncFaders()
}

/** The build this page was loaded against. A newer one means new code on
    the companion, so the deck fetches it; there is nothing here to lose. */
let loadedBuild: string | null = null

export function applyState(snapshot: Snapshot): void {
  if (snapshot.build) {
    if (loadedBuild === null) loadedBuild = snapshot.build
    else if (snapshot.build !== loadedBuild) return location.reload()
  }
  if (snapshot.accent) applyAccent(snapshot.accent)
  if (snapshot.theme) applyTheme(snapshot.theme)
  if (snapshot.toggles) {
    // The companion's list is complete: a state it no longer reports (OBS
    // closed) is off. A key whose press is still in the air keeps its value.
    const next: Record<string, boolean> = {}
    for (const key of Object.keys(snapshot.toggles)) {
      const value = snapshot.toggles[key]
      if (value !== undefined) next[key] = value
    }
    for (const key of Object.keys(state.inflight)) {
      const current = state.toggles[key]
      if (current !== undefined) next[key] = current
    }
    state.toggles = next
  }
  if (snapshot.playing) state.playing = snapshot.playing
  if (snapshot.playback) updatePlayback(snapshot.playback)
  if (snapshot.levels) {
    for (const key of Object.keys(snapshot.levels)) {
      const value = snapshot.levels[key]
      if (value !== undefined) state.levels[key] = value
    }
  }
  refreshLiveState()
  if (typeof snapshot.libraryRev === "number" && snapshot.libraryRev !== state.libraryRev) {
    state.libraryRev = snapshot.libraryRev
    loadLibrary().catch(() => {})
  }
}

/** Repaints live state without rebuilding the DOM, so a tile never flickers under a finger. */
function refreshLiveState(): void {
  const profile = activeProfile()
  if (!profile) return
  const byId = new Map<string, Button>()
  for (const button of profile.buttons) byId.set(button.id, button)
  const tiles = gridEl.querySelectorAll<HTMLElement>(".tile")
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i]
    const button = tile ? byId.get(tile.getAttribute("data-button-id") ?? "") : undefined
    if (!tile || !button) continue
    if (button.control === "fader") {
      if (!state.dragging[button.id]) showLevel(tile, levelFor(button))
    } else if (isStateful(button)) {
      paintState(tile, button)
    }
  }
}

// EventSource cannot send headers, so the stream is signed in its address, and
// each reconnect needs a fresh signature: reconnecting is done here rather than
// left to the browser.
let source: EventSource | null = null
let reconnectTimer: number | undefined

function scheduleReconnect(delay: number): void {
  window.clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(connect, delay)
}

export function connect(): void {
  if (source) {
    source.close()
    source = null
  }

  if (typeof EventSource === "undefined") {
    api<StatusResponse>("/api/status")
      .then((status) => {
        setOnline(true)
        applyState(status)
      })
      .catch((error: unknown) => {
        if (!(error instanceof UnpairedError)) setOnline(false)
      })
      .then(() => {
        if (!needsPairing()) scheduleReconnect(1500)
      })
    return
  }

  const stream = new EventSource(eventsUrl())
  source = stream
  stream.onopen = () => setOnline(true)
  stream.onmessage = (event: MessageEvent<string>) => {
    setOnline(true)
    let snapshot: Snapshot
    try {
      snapshot = JSON.parse(event.data) as Snapshot
    } catch {
      return
    }
    applyState(snapshot)
  }
  // Meter levels arrive as their own event, so they never re-send the snapshot.
  stream.addEventListener("meters", (event: Event) => {
    const data = (event as MessageEvent<string>).data
    let meters: MetersEvent
    try {
      meters = JSON.parse(data) as MetersEvent
    } catch {
      return
    }
    if (meters && meters.levels) applyMeters(meters)
  })
  stream.onerror = () => {
    stream.close()
    if (source === stream) source = null
    setOnline(false)
    // Find out why: an unpaired deck shows the pairing screen instead of
    // retrying forever. The status check also resyncs the clock.
    api<StatusResponse>("/api/status")
      .then(() => scheduleReconnect(0))
      .catch((error: unknown) => {
        if (!(error instanceof UnpairedError)) scheduleReconnect(2000)
      })
  }
}

// Closing on unload stops the browser logging the aborted stream as an error.
window.addEventListener("pagehide", () => {
  if (source) source.close()
})
