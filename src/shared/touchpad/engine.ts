// The touchpad engine: frames of fingers in, meaning out. It keeps two
// machines in step, the tap machine (tap.ts, clicks and drags) and the
// gesture machine (gestures.ts, movement), and owns the clock: nothing in
// here reads the time, it is told, so a recorded trace replays exactly.
//
// Between the frames and the tap machine sits the bounce filter. A finger
// that lifts and lands straight back, close to where it left, never lifted
// as far as tapping is concerned; otherwise a tap that bounced would be
// a double tap, and a drag that bounced would drop. So a lift is held back
// for debounceMs before the tap machine hears of it, at the time it really
// happened; a timeout due in between waits for the verdict. The gesture
// machine is told at once, since a bounce mid-scroll costs nothing but a
// moment of momentum.
import type { TrackpadSettings } from "../types.ts"
import { createGestureMachine } from "./gestures.ts"
import { createTapMachine } from "./tap.ts"
import { TUNING } from "./tuning.ts"
import type { Touchpad, TouchContact, TouchFrame, TouchpadEvent } from "./types.ts"

/** A finger as the tap machine knows it: it may outlive its touch by debounceMs. */
interface Slot {
  /** The touch's own id; a bounce takes over the new touch's id. */
  id: number
  startX: number
  startY: number
  x: number
  y: number
  /** Whether it has strayed past the tap threshold. */
  moved: boolean
  /** When the touch ended, while the lift waits to be sure it was one. */
  liftedAt: number | null
}

const distance = (ax: number, ay: number, bx: number, by: number): number => Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by))

export function createTouchpad(initial: TrackpadSettings): Touchpad {
  const tap = createTapMachine()
  const gestures = createGestureMachine(initial)
  let slots: Slot[] = []
  /** The latest time seen, so a clock that steps back cannot run anything twice. */
  let latest = -Infinity

  function release(slot: Slot, out: TouchpadEvent[]): void {
    slots = slots.filter((other) => other !== slot)
    tap.handle("release", slot.liftedAt ?? latest, out)
  }

  /** The lift that has waited longest, if any. */
  function pendingLift(): Slot | null {
    let pending: Slot | null = null
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!
      if (slot.liftedAt !== null && (pending === null || slot.liftedAt < (pending.liftedAt ?? 0))) pending = slot
    }
    return pending
  }

  /** Delivers, in time order, every lift that is now certain and every
      timeout that is due. A timeout does not fire past a lift that happened
      before it but is still in doubt: it waits, then either the lift comes
      first (a tap in time) or the bounce rejoined and the timeout goes ahead. */
  function advance(now: number, out: TouchpadEvent[]): void {
    for (;;) {
      const pending = pendingLift()
      const liftedAt = pending && pending.liftedAt !== null ? pending.liftedAt : null
      const deadline = tap.deadline()
      if (pending && liftedAt !== null && liftedAt + TUNING.debounceMs <= now && (deadline === null || liftedAt <= deadline)) {
        release(pending, out)
        continue
      }
      if (deadline !== null && deadline <= now && (liftedAt === null || liftedAt > deadline)) {
        tap.handle("timeout", deadline, out)
        continue
      }
      return
    }
  }

  function liveSlot(id: number): Slot | undefined {
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!
      if (slot.id === id && slot.liftedAt === null) return slot
    }
    return undefined
  }

  /** A finger that lifted a moment ago near this point: the same one, back. */
  function bouncedSlot(contact: TouchContact, now: number): Slot | undefined {
    let best: Slot | undefined
    let bestDistance: number = TUNING.debouncePx
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!
      if (slot.liftedAt === null || slot.liftedAt + TUNING.debounceMs < now) continue
      const gap = distance(slot.x, slot.y, contact.x, contact.y)
      if (gap <= bestDistance) {
        best = slot
        bestDistance = gap
      }
    }
    return best
  }

  function frame(input: TouchFrame): TouchpadEvent[] {
    if (input.cancelled) return cancel(input.time)
    const now = Math.max(input.time, latest)
    latest = now
    const out: TouchpadEvent[] = []
    advance(now, out)

    const contacts = input.contacts
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!
      if (slot.liftedAt !== null) continue
      let present = false
      for (let j = 0; j < contacts.length; j += 1) if (contacts[j]!.id === slot.id) present = true
      if (!present) slot.liftedAt = now
    }

    for (let i = 0; i < contacts.length; i += 1) {
      const contact = contacts[i]!
      const live = liveSlot(contact.id)
      if (live) {
        live.x = contact.x
        live.y = contact.y
        continue
      }
      const bounced = bouncedSlot(contact, now)
      if (bounced) {
        bounced.id = contact.id
        bounced.liftedAt = null
        // Where it lands is noise, not movement: the tap threshold restarts here.
        bounced.startX = bounced.x = contact.x
        bounced.startY = bounced.y = contact.y
        continue
      }
      // Touch ids come round again: a finger that left with this id has really gone.
      for (let j = 0; j < slots.length; j += 1) {
        const stale = slots[j]!
        if (stale.id === contact.id && stale.liftedAt !== null) {
          release(stale, out)
          break
        }
      }
      slots.push({ id: contact.id, startX: contact.x, startY: contact.y, x: contact.x, y: contact.y, moved: false, liftedAt: null })
      tap.handle("touch", now, out)
    }

    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i]!
      if (slot.liftedAt !== null || slot.moved) continue
      if (distance(slot.x, slot.y, slot.startX, slot.startY) > TUNING.tapMovePx) {
        slot.moved = true
        tap.handle("motion", now, out)
      }
    }

    gestures.frame(contacts, now, tap.dragging(), out)
    return out
  }

  function tick(now: number): TouchpadEvent[] {
    const at = Math.max(now, latest)
    latest = at
    const out: TouchpadEvent[] = []
    advance(at, out)
    gestures.tick(at, out)
    return out
  }

  function cancel(now: number): TouchpadEvent[] {
    latest = Math.max(now, latest)
    const out: TouchpadEvent[] = []
    tap.reset(out)
    slots = []
    gestures.cancel(out)
    return out
  }

  return {
    frame,
    tick,
    cancel,
    setSettings: (settings) => gestures.setSettings(settings),
    needsTick: () => tap.deadline() !== null || pendingLift() !== null || gestures.momentum(),
    state() {
      let fingers = 0
      for (let i = 0; i < slots.length; i += 1) if (slots[i]!.liftedAt === null) fingers += 1
      return { tap: tap.state(), gesture: gestures.state(), fingers, momentum: gestures.momentum() }
    }
  }
}
