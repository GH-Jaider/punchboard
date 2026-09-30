// What moving fingers mean, once tapping is out of the way: one finger moves
// the cursor (or drags, when the tap machine holds the button), two scroll or
// pinch, three or four swipe. Like libinput's gesture code, nothing is
// decided until the fingers have moved far enough to be unambiguous, a
// gesture ends as soon as one of its fingers lifts, and a finger joining
// starts a fresh decision. Also here: cursor acceleration and the momentum a
// flicked scroll keeps after the fingers lift.
import type { TrackpadSettings } from "../types.ts"
import type { Direction, GestureState, TouchContact, TouchpadEvent } from "./types.ts"
import { TUNING } from "./tuning.ts"

export interface GestureMachine {
  state(): GestureState
  momentum(): boolean
  /** The fingers on the surface; `dragging` is whether the tap machine holds the button. */
  frame(contacts: TouchContact[], time: number, dragging: boolean, out: TouchpadEvent[]): void
  tick(now: number, out: TouchpadEvent[]): void
  cancel(out: TouchpadEvent[]): void
  setSettings(settings: TrackpadSettings): void
}

/** Where a finger landed (for thresholds) and where it was last frame (for deltas). */
interface Tracked {
  id: number
  startX: number
  startY: number
  lastX: number
  lastY: number
}

/** The fingers' centre and their average distance from it, which grows as they spread. */
interface Centre {
  x: number
  y: number
  spread: number
}

interface Sample {
  time: number
  dx: number
  dy: number
  distance: number
  dt: number
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ${String(value)}`)
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value))
const length = (x: number, y: number): number => Math.sqrt(x * x + y * y)

function centreOf(contacts: TouchContact[]): Centre {
  let x = 0
  let y = 0
  for (let i = 0; i < contacts.length; i += 1) {
    const contact = contacts[i]!
    x += contact.x
    y += contact.y
  }
  x /= contacts.length
  y /= contacts.length
  let spread = 0
  for (let i = 0; i < contacts.length; i += 1) {
    const contact = contacts[i]!
    spread += length(contact.x - x, contact.y - y)
  }
  return { x, y, spread: Math.max(spread / contacts.length, 1) }
}

/** Recent movement, so speed is read over a stretch of frames rather than one. */
function createVelocity() {
  let samples: Sample[] = []
  return {
    reset(): void {
      samples = []
    },
    add(time: number, dx: number, dy: number, dt: number): void {
      samples.push({ time, dx, dy, distance: length(dx, dy), dt })
      if (samples.length > 32) samples.shift()
    },
    /** Distance per ms over the last `windowMs`. */
    pace(now: number, windowMs: number): number {
      let distance = 0
      let dt = 0
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i]!
        if (sample.time < now - windowMs) continue
        distance += sample.distance
        dt += sample.dt
      }
      return dt > 0 ? distance / dt : 0
    },
    /** Mean velocity over the last `windowMs`, or null when the fingers had
        already stopped for `staleMs` before `now`. */
    read(now: number, windowMs: number, staleMs: number): { vx: number; vy: number } | null {
      const newest = samples[samples.length - 1]
      if (!newest || now - newest.time > staleMs) return null
      let dx = 0
      let dy = 0
      let dt = 0
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i]!
        if (sample.time < now - windowMs) continue
        dx += sample.dx
        dy += sample.dy
        dt += sample.dt
      }
      return dt > 0 ? { vx: dx / dt, vy: dy / dt } : null
    }
  }
}

export function createGestureMachine(initial: TrackpadSettings): GestureMachine {
  let settings = initial
  let kind: GestureState = "none"
  let tracked: Tracked[] = []
  let origin: Centre = { x: 0, y: 0, spread: 1 }
  let last: Centre = origin
  let lastTime = 0
  /** Until when the remaining fingers are ignored after one lifted. */
  let settleUntil = 0
  const pointerSpeed = createVelocity()
  const scrollSpeed = createVelocity()
  let coast: { vx: number; vy: number; at: number } | null = null
  /** A flick whose first finger has lifted: it coasts once the last one is up, soon. */
  let flick: { vx: number; vy: number; until: number } | null = null

  /** Scroll in finger terms: natural means the content follows the fingers. */
  const scrollUnits = (delta: number): number => delta * TUNING.scrollGain * (settings.naturalScroll ? 1 : -1)

  function rebase(contacts: TouchContact[], time: number): void {
    tracked = contacts.map((contact) => ({ id: contact.id, startX: contact.x, startY: contact.y, lastX: contact.x, lastY: contact.y }))
    origin = centreOf(contacts)
    last = origin
    lastTime = time
    pointerSpeed.reset()
    scrollSpeed.reset()
  }

  function sameFingers(contacts: TouchContact[]): boolean {
    if (contacts.length !== tracked.length) return false
    for (let i = 0; i < contacts.length; i += 1) {
      const id = contacts[i]!.id
      let found = false
      for (let j = 0; j < tracked.length; j += 1) if (tracked[j]!.id === id) found = true
      if (!found) return false
    }
    return true
  }

  function trackedFor(id: number): Tracked | undefined {
    for (let i = 0; i < tracked.length; i += 1) if (tracked[i]!.id === id) return tracked[i]
    return undefined
  }

  /** Fingers rarely lift together, so the speed is read when the first one
      goes and the coasting starts when the last one has, if that is soon. */
  function noteFlick(time: number): void {
    const velocity = scrollSpeed.read(time, TUNING.momentumWindowMs, TUNING.momentumStaleMs)
    if (!velocity || length(velocity.vx, velocity.vy) < TUNING.momentumStartSpeed) return
    flick = { vx: velocity.vx, vy: velocity.vy, until: time + TUNING.settleMs }
  }

  /** Closes a scroll or pinch; a scroll whose fingers lifted may go on coasting. */
  function endGesture(time: number, lifted: boolean, out: TouchpadEvent[]): void {
    if (kind === "scroll") {
      out.push({ type: "scroll", phase: "end", dx: 0, dy: 0 })
      if (lifted) noteFlick(time)
    } else if (kind === "pinch") {
      out.push({ type: "pinch", phase: "end", scale: 1 })
    }
  }

  function moveBy(dx: number, dy: number, time: number, dt: number, out: TouchpadEvent[]): void {
    if (dx === 0 && dy === 0) return
    if (length(dx, dy) > TUNING.jumpPx) return
    pointerSpeed.add(time, dx, dy, dt)
    const pace = pointerSpeed.pace(time, TUNING.velocityWindowMs)
    const gain = settings.speed * (TUNING.accelBase + Math.min(pace, TUNING.accelMaxSpeed) * TUNING.accelSlope)
    out.push({ type: "move", dx: dx * gain, dy: dy * gain })
  }

  function scrollBy(dx: number, dy: number, time: number, dt: number, phase: "begin" | "change", out: TouchpadEvent[]): void {
    if (length(dx, dy) > TUNING.jumpPx) return
    if (phase === "change" && dx === 0 && dy === 0) return
    scrollSpeed.add(time, dx, dy, dt)
    out.push({ type: "scroll", phase, dx: scrollUnits(dx), dy: scrollUnits(dy) })
  }

  /** Two fingers: are they sliding together (scroll) or apart (pinch)? Decided
      once the leading finger has gone far enough, by comparing how much the
      gap between them changed with how far the pair as a whole moved. In a
      scroll the gap hardly changes. In the usual pinch one finger (a thumb)
      barely moves and the other goes towards or away from it: the gap then
      changes twice as much as the pair moves, and a finger that drifts along
      with the pinch does not change that. While one finger stands still the
      other must go twice as far, since a finger that lags at the start of a
      scroll could otherwise look like a pinch. */
  function decideTwo(contacts: TouchContact[], centre: Centre, time: number, dt: number, out: TouchpadEvent[]): void {
    const a = trackedFor(contacts[0]!.id)
    const b = trackedFor(contacts[1]!.id)
    if (!a || !b) return
    const ax = contacts[0]!.x - a.startX
    const ay = contacts[0]!.y - a.startY
    const bx = contacts[1]!.x - b.startX
    const by = contacts[1]!.y - b.startY
    const ma = length(ax, ay)
    const mb = length(bx, by)
    const lead = Math.max(ma, mb)
    const lag = Math.min(ma, mb)
    if (lead < TUNING.decidePx) return
    const slide = length(centre.x - origin.x, centre.y - origin.y)
    if (slide > TUNING.jumpPx || lead > TUNING.jumpPx) {
      // Nothing moves that far in one go: start again from here.
      rebase(contacts, time)
      return
    }
    if (lag < TUNING.laggingPx && lead < TUNING.decidePx * 2) return
    // Spread is the fingers' distance from their centre: for two, half the gap.
    const pinch = gapChange(centre) > slide * TUNING.pinchBias
    if (pinch) {
      kind = "pinch"
      out.push({ type: "pinch", phase: "begin", scale: centre.spread / origin.spread })
    } else {
      kind = "scroll"
      scrollBy(centre.x - origin.x, centre.y - origin.y, time, dt, "begin", out)
    }
    last = centre
  }

  /** How much the gap between two fingers has changed since the gesture began. */
  function gapChange(centre: Centre): number {
    return Math.abs(centre.spread - origin.spread) * 2
  }

  /** A scroll that turns out to be a pinch (the gap kept changing far more than
      the fingers travelled together) becomes one, without coasting. */
  function pinchAfterAll(contacts: TouchContact[], centre: Centre, out: TouchpadEvent[]): boolean {
    if (contacts.length !== 2) return false
    const gap = gapChange(centre)
    if (gap < TUNING.pinchSwitchPx || gap < length(centre.x - origin.x, centre.y - origin.y) * TUNING.pinchSwitchBias) return false
    out.push({ type: "scroll", phase: "end", dx: 0, dy: 0 })
    scrollSpeed.reset()
    kind = "pinch"
    out.push({ type: "pinch", phase: "begin", scale: centre.spread / origin.spread })
    return true
  }

  /** Three or four fingers: a spread or pinch (four only), else a swipe along
      the axis they travelled most. One gesture per touch, then nothing more.
      Three fingers closing or opening are no swipe: they are someone pinching
      with an extra finger, and must not open App Exposé. */
  function decideMany(count: number, centre: Centre, out: TouchpadEvent[]): void {
    const ratio = centre.spread / origin.spread
    if (count === 4 && ratio > TUNING.spreadRatio) {
      out.push({ type: "fingers", fingers: 4, gesture: "spread" })
      kind = "done"
      return
    }
    if (count === 4 && ratio < TUNING.pinchRatio) {
      out.push({ type: "fingers", fingers: 4, gesture: "pinch" })
      kind = "done"
      return
    }
    if (count === 3 && (ratio > TUNING.swipeSpreadRatio || ratio < 1 / TUNING.swipeSpreadRatio)) {
      kind = "done"
      return
    }
    const dx = centre.x - origin.x
    const dy = centre.y - origin.y
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= TUNING.swipePx) return
    let direction: Direction
    if (Math.abs(dx) > Math.abs(dy)) direction = dx > 0 ? "right" : "left"
    else direction = dy > 0 ? "down" : "up"
    out.push({ type: "swipe", fingers: count === 4 ? 4 : 3, direction })
    kind = "done"
  }

  function decide(contacts: TouchContact[], time: number, dt: number, out: TouchpadEvent[]): void {
    const count = contacts.length
    if (count === 1) {
      const contact = contacts[0]!
      const start = trackedFor(contact.id)
      if (start && length(contact.x - start.startX, contact.y - start.startY) > TUNING.tapMovePx) {
        // The way here was the tap threshold's dead zone, as on a laptop: the cursor starts from the finger's position now.
        kind = "pointer"
        rebase(contacts, time)
      }
      return
    }
    const centre = centreOf(contacts)
    if (count === 2) decideTwo(contacts, centre, time, dt, out)
    else decideMany(count, centre, out)
  }

  function frame(contacts: TouchContact[], time: number, dragging: boolean, out: TouchpadEvent[]): void {
    const count = contacts.length
    if (count > 0) coast = null
    if (count === 0) {
      endGesture(time, true, out)
      kind = "none"
      tracked = []
      if (flick && time <= flick.until) coast = { vx: flick.vx, vy: flick.vy, at: time }
      flick = null
      return
    }
    if (!sameFingers(contacts)) {
      const lifted = count < tracked.length
      endGesture(time, lifted, out)
      if (kind !== "done" && kind !== "drag") kind = "undecided"
      settleUntil = lifted ? time + TUNING.settleMs : time
      rebase(contacts, time)
      if (count > 4) kind = "done"
    }
    const dt = clamp(time - lastTime, 1, 100)
    switch (kind) {
      case "none":
        // Unreachable: a first finger differs from no fingers, and became "undecided" above.
        break
      case "undecided":
        if (time < settleUntil) {
          rebase(contacts, time)
          break
        }
        // The fingers left behind stayed: whatever was flicked is not coasting.
        flick = null
        if (dragging) {
          kind = "drag"
          rebase(contacts, time)
        } else {
          decide(contacts, time, dt, out)
        }
        break
      case "pointer": {
        const contact = contacts[0]!
        const was = trackedFor(contact.id)
        if (was) moveBy(contact.x - was.lastX, contact.y - was.lastY, time, dt, out)
        break
      }
      case "drag": {
        if (!dragging) {
          // The button was let go while fingers are still down (too many of them): nothing until they lift.
          kind = "done"
          break
        }
        const centre = centreOf(contacts)
        moveBy(centre.x - last.x, centre.y - last.y, time, dt, out)
        last = centre
        break
      }
      case "scroll": {
        const centre = centreOf(contacts)
        if (!pinchAfterAll(contacts, centre, out)) scrollBy(centre.x - last.x, centre.y - last.y, time, dt, "change", out)
        last = centre
        break
      }
      case "pinch": {
        const centre = centreOf(contacts)
        if (centre.spread !== last.spread) out.push({ type: "pinch", phase: "change", scale: centre.spread / last.spread })
        last = centre
        break
      }
      case "done":
        break
      default:
        assertNever(kind)
    }
    for (let i = 0; i < contacts.length; i += 1) {
      const contact = contacts[i]!
      const was = trackedFor(contact.id)
      if (was) {
        was.lastX = contact.x
        was.lastY = contact.y
      }
    }
    lastTime = time
  }

  function tick(now: number, out: TouchpadEvent[]): void {
    if (!coast) return
    const dt = Math.min(now - coast.at, TUNING.momentumMaxStepMs)
    if (dt <= 0) return
    coast.at = now
    out.push({ type: "scroll", phase: "momentum", dx: scrollUnits(coast.vx * dt), dy: scrollUnits(coast.vy * dt) })
    const keep = Math.pow(TUNING.momentumFriction, dt / 16)
    coast.vx *= keep
    coast.vy *= keep
    if (length(coast.vx, coast.vy) < TUNING.momentumStopSpeed) coast = null
  }

  return {
    state: () => kind,
    momentum: () => coast !== null,
    frame,
    tick,
    cancel(out) {
      endGesture(lastTime, false, out)
      kind = "none"
      tracked = []
      coast = null
      flick = null
    },
    setSettings(next) {
      settings = next
    }
  }
}
