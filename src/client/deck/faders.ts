// Fader tiles: the whole tile is the handle, and dragging is relative, so
// touching it never jumps the level to where the finger landed.
import { FADER_TARGETS } from "../../shared/actions.ts"
import type { LevelsResponse, VolumeRequest, VolumeSyncRequest } from "../../shared/api.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { faderLevelKey } from "../../shared/model.ts"
import type { FaderButton } from "../../shared/types.ts"
import { applyTileColor, el } from "../common/dom.ts"
import { errorMessage } from "../common/http.ts"
import { api } from "./api.ts"
import { activeProfile, state } from "./state.ts"
import { haptic } from "./haptics.ts"
import { isOffline, toast } from "./ui.ts"

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

export function levelFor(button: FaderButton): number | null {
  const level = state.levels[faderLevelKey(button.fader)]
  return typeof level === "number" ? level : null
}

function setLevel(button: FaderButton, level: number): void {
  state.levels[faderLevelKey(button.fader)] = level
}

export function showLevel(tile: HTMLElement, level: number | null): void {
  const known = level !== null
  const percent = known ? Math.round(level * 100) : 0
  const fill = tile.querySelector<HTMLElement>(".fader-fill")
  const value = tile.querySelector<HTMLElement>(".fader-value")
  if (fill) fill.style.height = `${percent}%`
  if (value) value.textContent = known ? `${percent}%` : "–"
  // No value is claimed until the companion has said where the level is.
  if (known) {
    tile.setAttribute("aria-valuenow", String(percent))
    tile.setAttribute("aria-valuetext", `${percent}%`)
  } else {
    tile.removeAttribute("aria-valuenow")
    tile.setAttribute("aria-valuetext", "Level not known yet")
  }
}

export function faderMarkup(button: FaderButton): HTMLElement {
  const tile = el("div", "tile fader")
  tile.setAttribute("data-button-id", button.id)
  tile.setAttribute("role", "slider")
  tile.setAttribute("aria-valuemin", "0")
  tile.setAttribute("aria-valuemax", "100")
  tile.setAttribute("aria-label", button.label || FADER_TARGETS[button.fader.target].label)
  tile.tabIndex = 0
  applyTileColor(tile, button.color)

  // The meter (indicators.ts) finds this tile by its level key.
  tile.setAttribute("data-level-key", faderLevelKey(button.fader))

  const icon = el("span", "tile-icon")
  icon.innerHTML = iconMarkup(button)
  tile.appendChild(el("span", "fader-fill"))
  tile.appendChild(el("span", "fader-value"))
  const meter = el("span", "fader-meter")
  meter.appendChild(el("span", "fader-meter-fill"))
  tile.appendChild(meter)
  tile.appendChild(icon)
  if (button.label) tile.appendChild(el("span", "tile-label", button.label))
  showLevel(tile, levelFor(button))
  bindFader(tile, button)
  return tile
}

/* Touch and mouse are bound separately because the oldest tablets have no
   pointer events. A full tile height is the whole range. */
function bindFader(tile: HTMLElement, button: FaderButton): void {
  let startY = 0
  let startLevel = 0
  let active = false
  let lastStep = 0

  const begin = (y: number): boolean => {
    if (isOffline()) {
      toast("Companion offline — nothing was sent.", true)
      return false
    }
    active = true
    state.dragging[button.id] = true
    startY = y
    startLevel = levelFor(button) ?? 0.5
    lastStep = Math.round(startLevel * 10)
    tile.classList.add("is-dragging")
    return true
  }
  const move = (y: number): void => {
    if (!active) return
    const level = clamp01(startLevel + (startY - y) / (tile.clientHeight || 1))
    // A tick each tenth of the way, and at either end, like detents on a knob.
    const step = Math.round(level * 10)
    if (step !== lastStep) {
      lastStep = step
      haptic("tick")
    }
    setLevel(button, level)
    showLevel(tile, level)
    sendLevel(button, level)
  }
  const end = (): void => {
    if (!active) return
    active = false
    tile.classList.remove("is-dragging")
    flushLevel(button)
    // Let the last echo from the server land before pushes move it again.
    setTimeout(() => { delete state.dragging[button.id] }, 400)
  }

  tile.addEventListener("touchstart", (event: TouchEvent) => {
    const touch = event.touches[0]
    if (event.touches.length !== 1 || !touch) return
    event.preventDefault()
    begin(touch.clientY)
  })
  tile.addEventListener("touchmove", (event: TouchEvent) => {
    const touch = event.touches[0]
    event.preventDefault()
    if (touch) move(touch.clientY)
  })
  tile.addEventListener("touchend", end)
  tile.addEventListener("touchcancel", end)

  tile.addEventListener("mousedown", (event: MouseEvent) => {
    if (!begin(event.clientY)) return
    event.preventDefault()
    const onMove = (moved: MouseEvent): void => move(moved.clientY)
    const onUp = (): void => {
      document.removeEventListener("mousemove", onMove)
      document.removeEventListener("mouseup", onUp)
      end()
    }
    document.addEventListener("mousemove", onMove)
    document.addEventListener("mouseup", onUp)
  })

  // The slider keys: arrows by 5%, Page Up / Down by 20%, Home and End to the ends.
  const KEY_STEPS: Record<string, number> = {
    ArrowUp: 0.05, ArrowRight: 0.05, Up: 0.05, Right: 0.05,
    ArrowDown: -0.05, ArrowLeft: -0.05, Down: -0.05, Left: -0.05,
    PageUp: 0.2, PageDown: -0.2, Home: -1, End: 1
  }
  tile.addEventListener("keydown", (event: KeyboardEvent) => {
    const step = KEY_STEPS[event.key]
    if (step === undefined) return
    event.preventDefault()
    if (isOffline()) {
      toast("Companion offline — nothing was sent.", true)
      return
    }
    const level = clamp01((levelFor(button) ?? 0.5) + step)
    setLevel(button, level)
    showLevel(tile, level)
    postLevel(button, level)
  })
}

// At most one request per fader every 90 ms while dragging, always ending on the final value.
interface Queued { timer: number | null; level: number }
const queue: Record<string, Queued> = {}

function sendLevel(button: FaderButton, level: number): void {
  const queued = queue[button.id] ?? (queue[button.id] = { timer: null, level: 0 })
  queued.level = level
  if (queued.timer !== null) return
  queued.timer = window.setTimeout(() => {
    queued.timer = null
    postLevel(button, queued.level)
  }, 90)
}

function flushLevel(button: FaderButton): void {
  const queued = queue[button.id]
  if (!queued || queued.timer === null) return
  window.clearTimeout(queued.timer)
  queued.timer = null
  postLevel(button, queued.level)
}

function postLevel(button: FaderButton, level: number): void {
  const body: VolumeRequest = { profileId: state.activeId ?? "", buttonId: button.id, level }
  api<LevelsResponse>("/api/volume", { method: "POST", json: body }).catch((error: unknown) => toast(errorMessage(error), true))
}

/** Asks the companion to read the real levels (OBS, the computer), so a fader starts where the sound actually is. */
export function syncFaders(): void {
  const profile = activeProfile()
  if (!profile || !profile.buttons.some((button) => button.control === "fader")) return
  const body: VolumeSyncRequest = { profileId: state.activeId ?? profile.id }
  api<LevelsResponse>("/api/volume/sync", { method: "POST", json: body }).catch(() => {})
}
