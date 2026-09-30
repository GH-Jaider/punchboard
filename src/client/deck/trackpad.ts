// A trackpad deck: the whole screen moves this computer's mouse.
//
//   one finger        moves the cursor (faster flicks go further)
//   tap               left click; two fingers tapping: right click
//   two fingers       scroll
//   double tap, hold  drag (release to drop)
//
// Like a Magic Trackpad: no keys, the whole deck is the surface.
//
// Movement is gathered for a frame and sent over a signed WebSocket, so a
// finger never waits for a request. Touch events only: pointer events are
// missing on the older tablets this runs on.
import type { PointerMessage, PointerNotice } from "../../shared/api.ts"
import type { Profile, TrackpadSettings } from "../../shared/types.ts"
import { el } from "../common/dom.ts"
import { streamUrl } from "./api.ts"
import { toast } from "./ui.ts"

const TAP_MS = 250
const TAP_SLOP = 10
const DOUBLE_TAP_MS = 300
const SCROLL_GAIN = 1.2

let socket: WebSocket | null = null
let shown = false
let settings: TrackpadSettings = { speed: 1.5, naturalScroll: true }
let retryTimer: number | undefined
let statusEl: HTMLElement | null = null

// Movement waiting for the next frame, with the fractions carried over.
let moveX = 0
let moveY = 0
let scrollX = 0
let scrollY = 0
let flushQueued = false

function setStatus(text: string, ok: boolean): void {
  if (!statusEl) return
  statusEl.textContent = text
  statusEl.className = `trackpad-status${ok ? " is-ready" : ""}`
}

function open(): void {
  window.clearTimeout(retryTimer)
  if (!shown || socket) return
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${streamUrl("/api/pointer")}`
  let next: WebSocket
  try { next = new WebSocket(url) } catch { return retry() }
  socket = next
  setStatus("Connecting…", false)
  next.onopen = () => setStatus("Ready", true)
  next.onmessage = (event: MessageEvent<string>) => {
    let notice: PointerNotice
    try { notice = JSON.parse(event.data) as PointerNotice } catch { return }
    if (notice.error) toast(notice.error, true)
  }
  next.onclose = () => {
    if (socket === next) socket = null
    retry()
  }
}

function retry(): void {
  if (!shown) return
  setStatus("Reconnecting…", false)
  // Every attempt is signed afresh, so it is made here rather than by the browser.
  retryTimer = window.setTimeout(open, 1500)
}

function send(message: PointerMessage): void {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message))
}

function flush(): void {
  flushQueued = false
  const mx = Math.trunc(moveX)
  const my = Math.trunc(moveY)
  if (mx || my) {
    moveX -= mx
    moveY -= my
    send(["m", mx, my])
  }
  const sx = Math.trunc(scrollX)
  const sy = Math.trunc(scrollY)
  if (sx || sy) {
    scrollX -= sx
    scrollY -= sy
    send(["s", sx, sy])
  }
}

function queueFlush(): void {
  if (flushQueued) return
  flushQueued = true
  window.requestAnimationFrame(flush)
}

/** Slow movement is precise, a quick flick crosses the screen. */
function gain(distance: number, ms: number): number {
  const speed = distance / Math.max(ms, 1)
  return settings.speed * (0.7 + Math.min(speed, 2) * 0.9)
}

interface Point { x: number; y: number }

function centre(touches: TouchList): Point {
  let x = 0
  let y = 0
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches[i]!
    x += touch.clientX
    y += touch.clientY
  }
  return { x: x / touches.length, y: y / touches.length }
}

function bindSurface(surface: HTMLElement): void {
  let last: Point | null = null
  let lastAt = 0
  let fingers = 0
  let mostFingers = 0
  let startedAt = 0
  let travelled = 0
  let lastTapAt = 0
  let dragging = false

  surface.addEventListener("touchstart", (event: TouchEvent) => {
    event.preventDefault()
    const touches = event.targetTouches
    if (fingers === 0) {
      startedAt = Date.now()
      travelled = 0
      mostFingers = 0
      // A tap, then a finger down again at once: pick up and drag.
      if (touches.length === 1 && startedAt - lastTapAt < DOUBLE_TAP_MS) {
        dragging = true
        send(["d"])
      }
    }
    fingers = touches.length
    mostFingers = Math.max(mostFingers, fingers)
    last = centre(touches)
    lastAt = Date.now()
  })

  surface.addEventListener("touchmove", (event: TouchEvent) => {
    event.preventDefault()
    const touches = event.targetTouches
    if (!touches.length || !last) return
    const now = Date.now()
    const point = centre(touches)
    // A finger joining or leaving shifts the centre: start again from there.
    if (touches.length !== fingers) {
      fingers = touches.length
      mostFingers = Math.max(mostFingers, fingers)
      last = point
      lastAt = now
      return
    }
    const dx = point.x - last.x
    const dy = point.y - last.y
    travelled += Math.abs(dx) + Math.abs(dy)
    if (fingers >= 2) {
      // Natural: the page follows the fingers. Positive scroll is up and left.
      const direction = settings.naturalScroll ? 1 : -1
      scrollX += dx * SCROLL_GAIN * direction
      scrollY += dy * SCROLL_GAIN * direction
    } else {
      const factor = gain(Math.sqrt(dx * dx + dy * dy), now - lastAt)
      moveX += dx * factor
      moveY += dy * factor
    }
    last = point
    lastAt = now
    queueFlush()
  })

  const end = (event: TouchEvent): void => {
    event.preventDefault()
    fingers = event.targetTouches.length
    if (fingers > 0) {
      last = centre(event.targetTouches)
      return
    }
    last = null
    const now = Date.now()
    const tapped = now - startedAt < TAP_MS && travelled < TAP_SLOP
    if (dragging) {
      dragging = false
      send(["u"])
      lastTapAt = 0
      return
    }
    if (!tapped) return
    if (mostFingers >= 2) {
      send(["c", "right"])
      lastTapAt = 0
    } else {
      send(["c", "left"])
      lastTapAt = now
    }
  }
  surface.addEventListener("touchend", end)
  surface.addEventListener("touchcancel", end)
}

/** Replaces the grid's contents with the trackpad. */
export function showTrackpad(profile: Profile, host: HTMLElement): void {
  settings = profile.trackpad ?? settings
  host.innerHTML = ""
  host.style.display = "flex"
  host.style.gridTemplateRows = ""

  const pad = el("div", "trackpad")
  const surface = el("div", "trackpad-surface")
  surface.setAttribute("aria-label", "Trackpad: moves this computer's mouse")
  statusEl = el("span", "trackpad-status", "Connecting…")
  surface.appendChild(statusEl)
  surface.appendChild(el("span", "trackpad-hint", "Tap to click · two fingers to scroll · two-finger tap to right-click · double-tap and hold to drag"))
  bindSurface(surface)
  pad.appendChild(surface)
  host.appendChild(pad)

  shown = true
  open()
}

/** Leaving the trackpad (another deck, or the page going away) closes its socket. */
export function hideTrackpad(): void {
  if (!shown) return
  shown = false
  statusEl = null
  window.clearTimeout(retryTimer)
  const closing = socket
  socket = null
  if (closing) closing.close()
}

window.addEventListener("pagehide", hideTrackpad)
