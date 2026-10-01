// A trackpad deck: the whole screen is a Magic Trackpad for this computer.
//
//   one finger          move the cursor (faster flicks go further)
//   tap                 click            two-finger tap   right click
//   tap, then hold      drag, release to drop
//   two fingers         scroll, with momentum when flicked
//   pinch               zoom in or out
//   three fingers       swipe up, down, left or right; tap to look up / search
//   four fingers        swipe like three; spread for the desktop, pinch for the apps
//
// The fingers go to the touchpad engine (shared/touchpad), which alone decides
// what they meant; this file turns its events into the companion's messages,
// gathered per frame and sent over a signed WebSocket, so a finger never waits
// for a request. Gestures a computer only knows from a real trackpad (Mission
// Control, switching desktops…) become that system's own shortcuts on the
// companion. Touch events only: pointer events are missing on the older
// devices this runs on.
//
// Opening the deck with #trackpad-debug in the address shows the engine at
// work and can keep the last 30 s as a trace for tests/touchpad-traces.
import type { PointerMessage, PointerNotice, TraceSaved, TraceUpload } from "../../shared/api.ts"
import { createTouchpad, summarize } from "../../shared/touchpad/index.ts"
import type { Touchpad, TouchFrame, TouchpadEvent, TouchpadState } from "../../shared/touchpad/index.ts"
import { DEFAULT_TRACKPAD } from "../../shared/model.ts"
import type { PinchZoom, Profile, TrackpadSettings } from "../../shared/types.ts"
import { el, storage } from "../common/dom.ts"
import { errorMessage } from "../common/http.ts"
import { api, streamUrl } from "./api.ts"
import { haptic } from "./haptics.ts"
import { toast } from "./ui.ts"

/** One zoom step (an app's Cmd/Ctrl +) per this much change in finger spread:
    log scale, about 35%, so doubling the gap is two steps. */
const ZOOM_STEP = 0.3
/** How much the debug overlay keeps for a trace. */
const TRACE_MS = 30000
/** Touches that start this close to the screen's sides or bottom are left to
    the system (home, back, app switching) instead of becoming a gesture that
    the system then takes away halfway. */
const EDGE_PX = 24
const HINT_KEY = "punchboard-trackpad-hint"

let socket: WebSocket | null = null
let shown = false
/** Which trackpad is showing: counts up each time one is built or taken down.
    A surface's listeners act only while theirs is current, since a finger
    still on a surface that left the page keeps sending it touches, and those
    must never reach the next trackpad's engine. */
let session = 0
/** The deck the trackpad belongs to, and its surface: a library update that
    keeps this deck keeps the trackpad, mid-gesture, rather than rebuilding it. */
let shownDeck: string | null = null
let padEl: HTMLElement | null = null
let settings: TrackpadSettings = DEFAULT_TRACKPAD
let retryTimer: number | undefined
let statusEl: HTMLElement | null = null
let engine: Touchpad | null = null
let debug: Debug | null = null
/** Whether the computer's left button is down for a drag. */
let held = false
/** The frame loop that drives the engine's timeouts and momentum. */
let loopFrame = 0

// Movement waiting for the next frame, with the fractions carried over.
let moveX = 0
let moveY = 0
let scrollX = 0
let scrollY = 0
let flushQueued = false
/** Pinch scale gathered in log space until it is worth a zoom step. */
let zoomCarry = 0
/** How the pinch under way goes out, chosen when it began, so a settings
    change mid-pinch cannot leave a real pinch without its end. */
let pinchMode: PinchZoom = DEFAULT_TRACKPAD.pinchZoom

function assertNever(value: never): never {
  throw new Error(`Unhandled ${String(value)}`)
}

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
  // A socket that is no longer the current one (the trackpad was taken down
  // and built again) speaks for nothing: its late events are ignored.
  next.onopen = () => {
    if (socket === next) setStatus("Ready", true)
  }
  next.onmessage = (event: MessageEvent<string>) => {
    if (socket !== next) return
    let notice: PointerNotice
    try { notice = JSON.parse(event.data) as PointerNotice } catch { return }
    if (notice.error) toast(notice.error, true)
  }
  next.onclose = () => {
    // A late close from an old socket must not clear the current one's drag,
    // or the drag's release would never be sent and the button would stick.
    if (socket !== next) return
    socket = null
    // The companion lets go of the button when a socket closes.
    held = false
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

// ------------------------------------------------------------------ events

/** Turns the engine's events into messages. Movement waits for the frame;
    anything that clicks goes out at once, after the movement before it. */
function handle(events: TouchpadEvent[]): void {
  if (debug && events.length) debug.events(events)
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    switch (event.type) {
      case "move":
        moveX += event.dx
        moveY += event.dy
        queueFlush()
        break
      case "scroll":
        if (event.phase !== "end") {
          scrollX += event.dx
          scrollY += event.dy
          queueFlush()
        }
        break
      case "button": {
        // The protocol has clicks, and a held left button; nothing else. A
        // tap's down and up arrive apart (the up waits in case a finger
        // comes back to drag with the same press), so each goes as it comes:
        // "d", then moves if any, then "u". A second tap in that time brings
        // the up and a down-up pair together: "u", then "c", which the
        // computer counts as the double click.
        if (event.button === "middle") break
        const next = events[i + 1]
        const clicked = event.state === "down" && next !== undefined && next.type === "button" && next.button === event.button && next.state === "up"
        if (clicked) {
          flush()
          send(["c", event.button])
          haptic("click")
          i += 1
        } else if (event.button === "right") {
          if (event.state === "down") {
            flush()
            send(["c", "right"])
            haptic("click")
          }
        } else if (event.state === "down") {
          flush()
          send(["d"])
          haptic("click")
          held = true
        } else if (held) {
          flush()
          send(["u"])
          held = false
        }
        break
      }
      case "pinch":
        if (event.phase === "begin") pinchMode = settings.pinchZoom
        if (pinchMode !== "keys") {
          // The real gesture: the computer zooms the way a trackpad pinch does.
          // A trackpad's pinch begins at rest and grows in changes, so the
          // ground covered while deciding it was a pinch follows as a change.
          flush()
          if (event.phase === "begin") {
            send(["p", "begin", 0])
            if (event.scale !== 1) send(["p", "change", event.scale - 1])
          } else {
            send(["p", event.phase, event.phase === "end" ? 0 : event.scale - 1])
          }
          break
        }
        if (event.phase === "end") {
          zoomCarry = 0
          break
        }
        zoomCarry += Math.log(event.scale)
        while (Math.abs(zoomCarry) >= ZOOM_STEP) {
          const zoomIn = zoomCarry > 0
          send(["z", zoomIn ? 1 : -1])
          zoomCarry += zoomIn ? -ZOOM_STEP : ZOOM_STEP
        }
        break
      case "swipe":
        send(["g", event.fingers, event.direction])
        haptic("tap")
        break
      case "fingers":
        send(["g", 4, event.gesture])
        haptic("tap")
        break
      case "tap":
        send(["g", 3, "tap"])
        haptic("tap")
        break
      default:
        assertNever(event)
    }
  }
}

/** Runs while the engine has a timeout or momentum pending, and stops itself after. */
function loop(): void {
  loopFrame = 0
  if (!engine || !shown) return
  handle(engine.tick(Date.now()))
  if (debug) debug.paint(engine.state())
  if (engine.needsTick()) loopFrame = window.requestAnimationFrame(loop)
}

function keepTicking(): void {
  if (!loopFrame && engine && engine.needsTick()) loopFrame = window.requestAnimationFrame(loop)
}

function stopTicking(): void {
  if (loopFrame) window.cancelAnimationFrame(loopFrame)
  loopFrame = 0
}

/** The touches are gone or the trackpad is: drop everything, never leaving the button down. */
function letGo(): void {
  if (engine) handle(engine.cancel(Date.now()))
  if (held) {
    flush()
    send(["u"])
    held = false
  }
}

/** Touches that began in the system's edge zone, ignored until they lift. */
let edgeTouches: Record<number, boolean> = {}

function nearEdge(touch: Touch): boolean {
  return touch.clientX < EDGE_PX || touch.clientX > window.innerWidth - EDGE_PX || touch.clientY > window.innerHeight - EDGE_PX
}

function readFrame(touches: TouchList): TouchFrame {
  const contacts = []
  for (let i = 0; i < touches.length; i += 1) {
    const touch = touches[i]!
    if (edgeTouches[touch.identifier]) continue
    contacts.push({ id: touch.identifier, x: touch.clientX, y: touch.clientY })
  }
  return { time: Date.now(), contacts }
}

/** Once per device: the system's own gestures can still leave the page, and
    only the device can stop that. */
function suggestLock(): void {
  if (storage.get(HINT_KEY)) return
  storage.set(HINT_KEY, "1")
  const agent = navigator.userAgent
  const apple = /iPad|iPhone|Macintosh.*Mobile/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
  const tip = apple
    ? "Tip: turn on Guided Access (Settings › Accessibility) and triple-click to lock the device to the trackpad, so a swipe from the edge cannot leave it."
    : /Android/.test(agent)
      ? "Tip: use Full screen, and pin the browser (Settings › Security › App pinning) so a swipe from the edge cannot leave the trackpad."
      : "Tip: use Full screen, so a swipe from the edge does not leave the trackpad."
  toast(tip, false, { label: "Got it", onClick: () => { /* dismissed */ } })
}

function bindSurface(surface: HTMLElement, own: number): void {
  const onTouch = (event: TouchEvent): void => {
    event.preventDefault()
    if (own !== session || !engine) return
    const changed = event.changedTouches
    for (let i = 0; i < changed.length; i += 1) {
      const touch = changed[i]!
      if (event.type === "touchstart" && nearEdge(touch)) edgeTouches[touch.identifier] = true
      else if (event.type === "touchend" && edgeTouches[touch.identifier]) delete edgeTouches[touch.identifier]
    }
    const frame = readFrame(event.targetTouches)
    if (debug) debug.frame(frame)
    handle(engine.frame(frame))
    if (debug) debug.paint(engine.state())
    keepTicking()
  }
  surface.addEventListener("touchstart", onTouch)
  surface.addEventListener("touchmove", onTouch)
  surface.addEventListener("touchend", onTouch)
  surface.addEventListener("touchcancel", (event: TouchEvent) => {
    event.preventDefault()
    if (own !== session) return
    edgeTouches = {}
    if (!engine) return
    // The system took the touches (a notification pulled down, say): nothing is clicked or dropped.
    const frame: TouchFrame = { time: Date.now(), contacts: [], cancelled: true }
    if (debug) debug.frame(frame)
    handle(engine.frame(frame))
    if (debug) debug.paint(engine.state())
    if (held) {
      flush()
      send(["u"])
      held = false
    }
  })
}

// ------------------------------------------------------------------- debug

interface Debug {
  /** The bar under the surface: the log, the state and the save button. */
  bar: HTMLElement
  frame(frame: TouchFrame): void
  events(events: TouchpadEvent[]): void
  paint(state: TouchpadState): void
}

/** Dots where the fingers are, a log of what the engine decided, and a button
    that keeps the last 30 s on the computer as a trace the tests can replay. */
function createDebug(surface: HTMLElement): Debug {
  const dots = el("div", "trackpad-dots")
  surface.appendChild(dots)
  const dotPool: HTMLElement[] = []
  const bar = el("div", "trackpad-debug")
  const log = el("pre", "trackpad-log")
  const side = el("div", "trackpad-debug-side")
  const stateLine = el("span", "trackpad-state", "idle · none")
  const save = el("button", "btn", "Save trace")
  save.type = "button"
  side.appendChild(stateLine)
  side.appendChild(save)
  bar.appendChild(log)
  bar.appendChild(side)

  const frames: TouchFrame[] = []
  const events: { at: number; event: TouchpadEvent }[] = []
  const lines: string[] = []
  let lastLine = ""
  let repeats = 1
  let lastState = ""

  function note(text: string): void {
    if (text === lastLine) {
      repeats += 1
      lines[lines.length - 1] = `${text} ×${repeats}`
    } else {
      lastLine = text
      repeats = 1
      lines.push(text)
      if (lines.length > 14) lines.shift()
    }
    log.textContent = lines.join("\n")
  }

  save.onclick = () => {
    save.disabled = true
    const upload: TraceUpload = { settings, frames: frames.slice(), events: events.map((entry) => entry.event), userAgent: navigator.userAgent }
    api<TraceSaved>("/api/trackpad/traces", { method: "POST", json: upload })
      .then((saved) => toast(`Saved ${saved.file} on the computer`))
      .catch((error: unknown) => toast(errorMessage(error), true))
      .then(() => { save.disabled = false })
  }

  return {
    bar,
    frame(frame) {
      frames.push(frame)
      while (frames.length && frames[0]!.time < frame.time - TRACE_MS) frames.shift()
      while (events.length && events[0]!.at < frame.time - TRACE_MS) events.shift()
      const rect = surface.getBoundingClientRect()
      for (let i = 0; i < frame.contacts.length; i += 1) {
        let dot = dotPool[i]
        if (!dot) {
          dot = el("div", "trackpad-dot")
          dotPool.push(dot)
          dots.appendChild(dot)
        }
        const contact = frame.contacts[i]!
        dot.style.display = "block"
        dot.style.transform = `translate(${Math.round(contact.x - rect.left)}px,${Math.round(contact.y - rect.top)}px)`
      }
      for (let i = frame.contacts.length; i < dotPool.length; i += 1) dotPool[i]!.style.display = "none"
    },
    events(batch) {
      const at = Date.now()
      for (let i = 0; i < batch.length; i += 1) events.push({ at, event: batch[i]! })
      const lines = summarize(batch)
      for (let i = 0; i < lines.length; i += 1) note(lines[i]!)
    },
    paint(state) {
      const text = `${state.tap} · ${state.gesture}${state.momentum ? " · momentum" : ""}`
      if (text === lastState) return
      lastState = text
      stateLine.textContent = text
      note(`[${text}]`)
    }
  }
}

// ------------------------------------------------------------------- deck

/** Replaces the grid's contents with the trackpad. */
export function showTrackpad(profile: Profile, host: HTMLElement): void {
  hideTrackpad()
  session += 1
  settings = profile.trackpad ?? settings
  engine = createTouchpad(settings)
  held = false
  zoomCarry = 0
  host.innerHTML = ""
  host.style.display = "flex"
  host.style.gridTemplateRows = ""

  const pad = el("div", "trackpad")
  const surface = el("div", "trackpad-surface")
  surface.setAttribute("aria-label", "Trackpad: moves this computer's mouse")
  statusEl = el("span", "trackpad-status", "Connecting…")
  surface.appendChild(statusEl)
  surface.appendChild(el("span", "trackpad-hint", "Works like a laptop trackpad: tap, two fingers to scroll, pinch to zoom, three fingers to swipe between windows and desktops"))
  bindSurface(surface, session)
  pad.appendChild(surface)
  if (/trackpad-debug/.test(location.hash)) {
    debug = createDebug(surface)
    pad.appendChild(debug.bar)
  }
  host.appendChild(pad)

  shown = true
  shownDeck = profile.id
  padEl = pad
  edgeTouches = {}
  open()
  suggestLock()
}

/** The library changed (any edit in the Control Center) and this deck is
    still the trackpad that is showing: its new settings apply to the fingers
    already down, and the surface, the engine and the socket stay, so a drag
    or a scroll under way carries on. False when there is nothing to keep
    (another deck, or the surface is no longer on the page), and the caller
    builds the deck afresh. */
export function updateTrackpad(profile: Profile, host: HTMLElement): boolean {
  if (!shown || !engine || !profile.trackpad || profile.id !== shownDeck || !padEl || padEl.parentNode !== host) return false
  settings = profile.trackpad
  engine.setSettings(settings)
  return true
}

/** Leaving the trackpad (another deck, or the page going away) closes its socket. */
export function hideTrackpad(): void {
  if (!shown) return
  letGo()
  shown = false
  // The old surface's listeners go quiet now, whatever its fingers do next.
  session += 1
  shownDeck = null
  padEl = null
  stopTicking()
  engine = null
  debug = null
  statusEl = null
  moveX = moveY = scrollX = scrollY = 0
  window.clearTimeout(retryTimer)
  const closing = socket
  socket = null
  if (closing) closing.close()
}

window.addEventListener("pagehide", hideTrackpad)
// A page in the background gets no frames, and frames are the engine's clock:
// the release a tap's press is waiting for could not go out until the page
// came back. Let go now; the fingers cannot be followed from there anyway.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && shown) letGo()
})
