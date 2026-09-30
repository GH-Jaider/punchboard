// A trackpad deck: the whole screen is a Magic Trackpad for this computer.
//
//   one finger          move the cursor (faster flicks go further)
//   tap                 click            two-finger tap   right click
//   double tap, hold    drag, release to drop
//   two fingers         scroll, with momentum when flicked
//   pinch               zoom in or out
//   three fingers       swipe up, down, left or right; tap to look up / search
//   four fingers        swipe like three; spread for the desktop
//
// Gestures a computer only knows from a real trackpad (Mission Control,
// switching desktops…) become that system's own shortcuts on the companion.
// Movement is gathered for a frame and sent over a signed WebSocket, so a
// finger never waits for a request. Touch events only: pointer events are
// missing on the older tablets this runs on.
import type { PointerMessage, PointerNotice, SwipeGesture } from "../../shared/api.ts"
import type { Profile, TrackpadSettings } from "../../shared/types.ts"
import { el } from "../common/dom.ts"
import { streamUrl } from "./api.ts"
import { toast } from "./ui.ts"

const TAP_MS = 250
const TAP_SLOP = 10
const DOUBLE_TAP_MS = 300
const SCROLL_GAIN = 1.2
/** How far two fingers must go before it is clear whether they scroll or pinch. */
const DECIDE_PX = 8
/** One zoom step (an app's Cmd/Ctrl +) per this much change in finger spread:
    log scale, about 35%, so doubling the gap is two steps. */
const ZOOM_STEP = 0.3
/** Three or four fingers travelling this far is a swipe. */
const SWIPE_PX = 70
/** Momentum: velocity kept per 16 ms frame, and where it stops (px/ms). */
const FRICTION = 0.93
const MOMENTUM_MIN = 0.03

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

/** Scroll in finger terms: natural means the page follows the fingers. */
function addScroll(dx: number, dy: number): void {
  const direction = settings.naturalScroll ? 1 : -1
  scrollX += dx * SCROLL_GAIN * direction
  scrollY += dy * SCROLL_GAIN * direction
  queueFlush()
}

// ---------------------------------------------------------------- momentum

let momentumX = 0
let momentumY = 0
let momentumAt = 0
let momentumFrame = 0

function stopMomentum(): void {
  if (momentumFrame) window.cancelAnimationFrame(momentumFrame)
  momentumFrame = 0
}

/** A flicked scroll keeps going and slows down, as on a real trackpad. */
function startMomentum(vx: number, vy: number): void {
  stopMomentum()
  if (Math.sqrt(vx * vx + vy * vy) < MOMENTUM_MIN * 4) return
  momentumX = vx
  momentumY = vy
  momentumAt = Date.now()
  const step = (): void => {
    const now = Date.now()
    const dt = Math.min(now - momentumAt, 50)
    momentumAt = now
    addScroll(momentumX * dt, momentumY * dt)
    const keep = Math.pow(FRICTION, dt / 16)
    momentumX *= keep
    momentumY *= keep
    momentumFrame = Math.sqrt(momentumX * momentumX + momentumY * momentumY) > MOMENTUM_MIN ? window.requestAnimationFrame(step) : 0
  }
  momentumFrame = window.requestAnimationFrame(step)
}

// ---------------------------------------------------------------- gestures

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

/** Average distance of the fingers from their centre: grows when they spread. */
function spread(touches: TouchList, middle: Point): number {
  let total = 0
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches[i]!
    total += Math.sqrt(Math.pow(touch.clientX - middle.x, 2) + Math.pow(touch.clientY - middle.y, 2))
  }
  return Math.max(total / touches.length, 1)
}

type Mode = "none" | "move" | "drag" | "scroll" | "pinch" | "swipe"

function bindSurface(surface: HTMLElement): void {
  let mode: Mode = "none"
  let fingers = 0
  let mostFingers = 0
  let startedAt = 0
  let travelled = 0
  let lastTapAt = 0
  let fired = false
  // Where the current finger count began, and the last reading.
  let origin: Point = { x: 0, y: 0 }
  let originSpread = 1
  let last: Point = { x: 0, y: 0 }
  let lastSpread = 1
  let lastAt = 0
  let zoomCarry = 0
  let velocityX = 0
  let velocityY = 0

  function rebase(touches: TouchList): void {
    fingers = touches.length
    mostFingers = Math.max(mostFingers, fingers)
    origin = centre(touches)
    originSpread = spread(touches, origin)
    last = origin
    lastSpread = originSpread
    lastAt = Date.now()
    zoomCarry = 0
    velocityX = 0
    velocityY = 0
    // Two fingers may follow one: let them decide afresh between scroll and pinch.
    if (mode === "move" || mode === "scroll" || mode === "pinch") mode = "none"
  }

  surface.addEventListener("touchstart", (event: TouchEvent) => {
    event.preventDefault()
    stopMomentum()
    const touches = event.targetTouches
    if (fingers === 0) {
      startedAt = Date.now()
      travelled = 0
      mostFingers = 0
      fired = false
      mode = "none"
      // A tap, then a finger down again at once: pick up and drag.
      if (touches.length === 1 && startedAt - lastTapAt < DOUBLE_TAP_MS) {
        mode = "drag"
        send(["d"])
      }
    }
    rebase(touches)
  })

  surface.addEventListener("touchmove", (event: TouchEvent) => {
    event.preventDefault()
    const touches = event.targetTouches
    if (!touches.length) return
    // A finger joining or leaving shifts the centre: start again from there.
    if (touches.length !== fingers) return rebase(touches)
    const now = Date.now()
    const dt = Math.max(now - lastAt, 1)
    const point = centre(touches)
    const dx = point.x - last.x
    const dy = point.y - last.y
    travelled += Math.abs(dx) + Math.abs(dy)

    if (fingers === 1) {
      if (mode === "none") mode = "move"
      if (mode === "move" || mode === "drag") {
        const factor = gain(Math.sqrt(dx * dx + dy * dy), dt)
        moveX += dx * factor
        moveY += dy * factor
        queueFlush()
      }
    } else if (fingers === 2) {
      const width = spread(touches, point)
      if (mode === "none" || mode === "move") {
        // Whichever moved more, the pair or the gap between them, decides.
        const slide = Math.sqrt(Math.pow(point.x - origin.x, 2) + Math.pow(point.y - origin.y, 2))
        const stretch = Math.abs(width - originSpread) * 2
        if (Math.max(slide, stretch) > DECIDE_PX) mode = stretch > slide ? "pinch" : "scroll"
      }
      if (mode === "scroll") {
        addScroll(dx, dy)
        velocityX = velocityX * 0.5 + (dx / dt) * 0.5
        velocityY = velocityY * 0.5 + (dy / dt) * 0.5
      } else if (mode === "pinch") {
        zoomCarry += Math.log(width / lastSpread)
        while (Math.abs(zoomCarry) >= ZOOM_STEP) {
          const zoomIn = zoomCarry > 0
          send(["z", zoomIn ? 1 : -1])
          zoomCarry += zoomIn ? -ZOOM_STEP : ZOOM_STEP
        }
      }
      lastSpread = width
    } else if (!fired) {
      // Three or four fingers: one gesture per touch, fired as soon as it is clear.
      mode = "swipe"
      const count = fingers >= 4 ? 4 : 3
      const ratio = spread(touches, point) / originSpread
      const sx = point.x - origin.x
      const sy = point.y - origin.y
      let gesture: SwipeGesture | null = null
      if (count === 4 && ratio > 1.4) gesture = "spread"
      else if (count === 4 && ratio < 0.7) gesture = "pinch"
      else if (Math.max(Math.abs(sx), Math.abs(sy)) > SWIPE_PX) gesture = Math.abs(sx) > Math.abs(sy) ? (sx > 0 ? "right" : "left") : (sy > 0 ? "down" : "up")
      if (gesture) {
        fired = true
        send(["g", count, gesture])
      }
    }
    last = point
    lastAt = now
  })

  const end = (event: TouchEvent): void => {
    event.preventDefault()
    const touches = event.targetTouches
    if (touches.length > 0) {
      // Fingers rarely lift together: the last ones up finish a scroll, they
      // do not start a new gesture.
      if (mode === "scroll") {
        fingers = touches.length
        last = centre(touches)
        return
      }
      return rebase(touches)
    }
    fingers = 0
    const now = Date.now()
    if (mode === "drag") {
      send(["u"])
      mode = "none"
      lastTapAt = 0
      return
    }
    if (mode === "scroll" && now - lastAt < 60) startMomentum(velocityX, velocityY)
    const tapped = !fired && now - startedAt < TAP_MS && travelled < TAP_SLOP * mostFingers
    mode = "none"
    if (!tapped) return
    if (mostFingers === 1) {
      send(["c", "left"])
      lastTapAt = now
      return
    }
    lastTapAt = 0
    if (mostFingers === 2) send(["c", "right"])
    else if (mostFingers === 3) send(["g", 3, "tap"])
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
  surface.appendChild(el("span", "trackpad-hint", "Works like a laptop trackpad: tap, two fingers to scroll, pinch to zoom, three fingers to swipe between windows and desktops"))
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
  stopMomentum()
  statusEl = null
  window.clearTimeout(retryTimer)
  const closing = socket
  socket = null
  if (closing) closing.close()
}

window.addEventListener("pagehide", hideTrackpad)
