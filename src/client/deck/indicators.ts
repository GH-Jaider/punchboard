// Live indicators drawn on top of tiles: how far a playing sound has got, and
// OBS meter levels on faders. Both update elements in place; nothing here
// rebuilds the grid.
import type { MetersEvent, SoundPlayback } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { serverNow } from "./api.ts"
import { state } from "./state.ts"

const grid = (): HTMLElement => byId("grid")

// ------------------------------------------------------------ sound progress

const TICK_MS = 200
let tickTimer: number | undefined

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`
}

/** Paints every sound tile from state.playback and the server clock. */
function paintPlayback(): void {
  const now = serverNow()
  const tiles = grid().querySelectorAll<HTMLElement>(".tile[data-sound-slot]")
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i]
    if (!tile) continue
    const playback: SoundPlayback | undefined = state.playback[tile.getAttribute("data-sound-slot") ?? ""]
    const bar = tile.querySelector<HTMLElement>(".sound-progress-fill")
    const time = tile.querySelector<HTMLElement>(".sound-time")
    if (!playback) {
      tile.classList.remove("is-tracking", "is-indeterminate")
      continue
    }
    tile.classList.add("is-tracking")
    if (playback.durationMs === null) {
      // Length unknown (an MP3 that has not played before): pulse instead of lying.
      tile.classList.add("is-indeterminate")
      if (time) time.textContent = ""
      continue
    }
    tile.classList.remove("is-indeterminate")
    const elapsed = Math.max(0, now - playback.startedAt)
    const fraction = Math.min(1, elapsed / Math.max(1, playback.durationMs))
    if (bar) bar.style.height = `${Math.round(fraction * 1000) / 10}%`
    if (time) time.textContent = formatRemaining(playback.durationMs - elapsed)
  }
}

/** Called with every snapshot; runs the ticker only while something plays. */
export function updatePlayback(playback: Record<string, SoundPlayback>): void {
  state.playback = playback
  paintPlayback()
  const active = Object.keys(playback).length > 0
  if (active && tickTimer === undefined) tickTimer = window.setInterval(paintPlayback, TICK_MS)
  if (!active && tickTimer !== undefined) {
    window.clearInterval(tickTimer)
    tickTimer = undefined
  }
}

/** After the grid is rebuilt, the new tiles need the current state again. */
export function repaintIndicators(): void {
  paintPlayback()
  paintMeters()
}

// -------------------------------------------------------------------- meters

/** Levels stay on screen only briefly: a meter that froze mid-way lies. */
const METER_STALE_MS = 1500
const meters: Record<string, number> = {}
let metersAt = 0
let staleTimer: number | undefined

function paintMeters(): void {
  const fresh = Date.now() - metersAt < METER_STALE_MS
  const tiles = grid().querySelectorAll<HTMLElement>(".tile.fader[data-level-key]")
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i]
    if (!tile) continue
    const level = meters[tile.getAttribute("data-level-key") ?? ""]
    const show = fresh && typeof level === "number"
    tile.classList.toggle("has-meter", show)
    if (!show) continue
    const fill = tile.querySelector<HTMLElement>(".fader-meter-fill")
    // One property per update: the fill's height and its colour scale both
    // derive from --level in CSS.
    if (fill) fill.style.setProperty("--level", String(Math.max(0.01, Math.min(1, level))))
  }
}

export function applyMeters(event: MetersEvent): void {
  for (const key of Object.keys(event.levels)) {
    const level = event.levels[key]
    if (typeof level === "number") meters[key] = level
  }
  metersAt = Date.now()
  paintMeters()
  if (staleTimer === undefined) staleTimer = window.setInterval(() => {
    if (Date.now() - metersAt < METER_STALE_MS) return
    paintMeters()
    window.clearInterval(staleTimer)
    staleTimer = undefined
  }, 500)
}
