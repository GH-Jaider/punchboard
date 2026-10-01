// Haptic feedback on the device, where it has a way to give it.
//
// Android: the Vibration API, with short pulses for a crisp tick.
// iPhone: Safari offers pages no vibration at all. What it does have is the
// switch control (iOS 18 and later), which ticks like a switch in Settings
// when a finger flips it, and only a finger: iOS 26 ignores a switch flipped
// from code. So on an iPhone each deck button carries an invisible switch on
// top (tapSwitch), and the tap that presses the button flips it. The tick is
// the light one of a switch: felt in the hand, not on a table. iPads have no
// Taptic Engine at all.
import { storage } from "../common/dom.ts"

export type Haptic = "tap" | "tick" | "click" | "error"

const STORAGE_KEY = "punchboard-haptics"
const PATTERNS: Record<Haptic, number | number[]> = { tap: 12, tick: 5, click: 8, error: [10, 60, 10] }

/** iPhones and iPads, including iPads that present themselves as a Mac. */
const appleTouch = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

/** Whether taps are felt through a switch under the finger rather than vibration. */
export function tapsThroughSwitch(): boolean {
  return typeof navigator.vibrate !== "function" && appleTouch() && hapticsEnabled()
}

/** The invisible switch a button carries on an iPhone: the finger that presses
    the button flips it, and iOS ticks. */
export function tapSwitch(): HTMLInputElement {
  const input = document.createElement("input")
  input.type = "checkbox"
  input.setAttribute("switch", "")
  input.className = "tap-switch"
  input.tabIndex = -1
  input.setAttribute("aria-hidden", "true")
  return input
}

export function hapticsEnabled(): boolean {
  return storage.get(STORAGE_KEY) !== "off"
}

export function setHapticsEnabled(on: boolean): void {
  storage.set(STORAGE_KEY, on ? "on" : "off")
}

export function haptic(kind: Haptic): void {
  if (!hapticsEnabled()) return
  // An iPhone can only tick under a finger (tapSwitch); nothing to do from here.
  if (typeof navigator.vibrate !== "function") return
  try { navigator.vibrate(PATTERNS[kind]) } catch { /* not allowed here */ }
}
