// Tap-to-click as a state machine, after the one libinput documents at
// https://wayland.freedesktop.org/libinput/doc/latest/tapping.html and has
// shipped on Linux laptops for years. Every finger down, finger up, first
// movement past the tap threshold and timeout is one input; the state says
// what the next one means. Written from the documentation, not ported.
//
//   idle ─touch→ touch ─release→ click, tapped ─touch→ drag_or_tap ─move/timeout→ dragging ─release→ up
//                  │ move/timeout             │ timeout                 │ release: click, tapped again
//                  ▼                          ▼
//                 hold                       idle
//   touch ─touch→ touch2 ─release→ touch2_release ─release→ right click
//   touch2 ─touch→ touch3 ─release→ touch3_release ─release→ touch3_release2 ─release→ three-finger tap
//
// Moving past the threshold or waiting out the tap time turns a touchN
// state into touchN_hold, and lifts walk the holds back down until idle;
// a fourth finger is "dead": nothing here until all are up. Bounces are
// filtered out before they get here (engine.ts).
//
// Where this differs from libinput, on purpose: a finger that lifts out of
// a two- or three-finger group and lands straight back rejoins it; two
// fingers landing after a tap start a two-finger group rather than a drag
// (a device screen is tapped and then scrolled far more often than dragged
// with two fingers); the middle button is a "tap" event instead, and there
// is no drag lock.
import type { Button, TapState, TouchpadEvent } from "./types.ts"
import { TUNING } from "./tuning.ts"

export type TapInput = "touch" | "release" | "motion" | "timeout"

export interface TapMachine {
  state(): TapState
  /** When the pending timeout is due, or null. */
  deadline(): number | null
  /** Whether the left button is held for a drag. */
  dragging(): boolean
  handle(input: TapInput, time: number, out: TouchpadEvent[]): void
  /** Back to idle at once, releasing the button if it was held. */
  reset(out: TouchpadEvent[]): void
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ${String(value)}`)
}

export function createTapMachine(): TapMachine {
  let state: TapState = "idle"
  let deadline: number | null = null
  let fingers = 0

  const TAP = TUNING.tapMs
  const DRAG = TUNING.dragMs

  function go(next: TapState, time: number, timerMs: number | null): void {
    state = next
    deadline = timerMs === null ? null : time + timerMs
  }

  function button(which: Button, pressed: boolean, out: TouchpadEvent[]): void {
    out.push({ type: "button", button: which, state: pressed ? "down" : "up" })
  }

  function click(which: Button, out: TouchpadEvent[]): void {
    button(which, true, out)
    button(which, false, out)
  }

  function idle(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("touch", time, TAP)
      case "release":
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function touch(input: TapInput, time: number, out: TouchpadEvent[]): void {
    switch (input) {
      case "touch": return go("touch2", time, TAP)
      case "release":
        click("left", out)
        return go("tapped", time, DRAG)
      case "motion":
      case "timeout": return go("hold", time, null)
      default: return assertNever(input)
    }
  }

  function hold(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("touch2", time, TAP)
      case "release": return go("idle", time, null)
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function touch2(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("touch3", time, TAP)
      case "release": return go("touch2_release", time, TAP)
      case "motion":
      case "timeout": return go("touch2_hold", time, null)
      default: return assertNever(input)
    }
  }

  function touch2Hold(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("touch3", time, TAP)
      case "release": return go("hold", time, null)
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function touch2Release(input: TapInput, time: number, out: TouchpadEvent[]): void {
    switch (input) {
      case "touch": return go("touch2", time, TAP)
      case "release":
        click("right", out)
        return go("idle", time, null)
      case "motion":
      case "timeout": return go("hold", time, null)
      default: return assertNever(input)
    }
  }

  function touch3(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("dead", time, null)
      case "release": return go("touch3_release", time, TAP)
      case "motion":
      case "timeout": return go("touch3_hold", time, null)
      default: return assertNever(input)
    }
  }

  function touch3Hold(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("dead", time, null)
      case "release": return go("touch2_hold", time, null)
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function touch3Release(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("touch3", time, TAP)
      case "release": return go("touch3_release2", time, TAP)
      case "motion":
      case "timeout": return go("touch2_hold", time, null)
      default: return assertNever(input)
    }
  }

  function touch3Release2(input: TapInput, time: number, out: TouchpadEvent[]): void {
    switch (input) {
      case "touch": return go("touch3_release", time, TAP)
      case "release":
        out.push({ type: "tap", fingers: 3 })
        return go("idle", time, null)
      case "motion":
      case "timeout": return go("hold", time, null)
      default: return assertNever(input)
    }
  }

  function tapped(input: TapInput, time: number): void {
    switch (input) {
      case "touch": return go("drag_or_tap", time, TAP)
      case "timeout": return go("idle", time, null)
      // No finger is down here, so these cannot happen; idle is the safe place.
      case "release":
      case "motion": return go("idle", time, null)
      default: return assertNever(input)
    }
  }

  function dragOrTap(input: TapInput, time: number, out: TouchpadEvent[]): void {
    switch (input) {
      case "touch": return go("touch2", time, TAP)
      case "release":
        click("left", out)
        return go("tapped", time, DRAG)
      case "motion":
      case "timeout":
        button("left", true, out)
        return go("dragging", time, null)
      default: return assertNever(input)
    }
  }

  function dragging(input: TapInput, time: number, out: TouchpadEvent[]): void {
    switch (input) {
      case "touch": return go("dragging2", time, null)
      case "release":
        button("left", false, out)
        return go("idle", time, null)
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function dragging2(input: TapInput, time: number, out: TouchpadEvent[]): void {
    switch (input) {
      case "touch":
        button("left", false, out)
        return go("dead", time, null)
      case "release": return go("dragging", time, null)
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function dead(input: TapInput, time: number): void {
    switch (input) {
      case "release":
        if (fingers === 0) go("idle", time, null)
        return
      case "touch":
      case "motion":
      case "timeout": return
      default: return assertNever(input)
    }
  }

  function handle(input: TapInput, time: number, out: TouchpadEvent[]): void {
    if (input === "touch") fingers += 1
    else if (input === "release") fingers = Math.max(0, fingers - 1)
    // A timeout that leaves the state alone must not fire again.
    else if (input === "timeout") deadline = null
    switch (state) {
      case "idle": return idle(input, time)
      case "touch": return touch(input, time, out)
      case "hold": return hold(input, time)
      case "touch2": return touch2(input, time)
      case "touch2_hold": return touch2Hold(input, time)
      case "touch2_release": return touch2Release(input, time, out)
      case "touch3": return touch3(input, time)
      case "touch3_hold": return touch3Hold(input, time)
      case "touch3_release": return touch3Release(input, time)
      case "touch3_release2": return touch3Release2(input, time, out)
      case "tapped": return tapped(input, time)
      case "drag_or_tap": return dragOrTap(input, time, out)
      case "dragging": return dragging(input, time, out)
      case "dragging2": return dragging2(input, time, out)
      case "dead": return dead(input, time)
      default: return assertNever(state)
    }
  }

  const isDragging = (): boolean => state === "dragging" || state === "dragging2"

  return {
    state: () => state,
    deadline: () => deadline,
    dragging: isDragging,
    handle,
    reset(out) {
      if (isDragging()) button("left", false, out)
      state = "idle"
      deadline = null
      fingers = 0
    }
  }
}
