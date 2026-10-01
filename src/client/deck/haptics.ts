// Haptic feedback on the device, where it has a way to give it.
//
// Android: the Vibration API, with short pulses for a crisp tick.
// iPhone: Safari offers pages no vibration at all. What it does have is the
// switch control (iOS 18 and later), which ticks like a switch in Settings
// when a finger flips it, and only a finger: iOS 26 ignores a switch flipped
// from code. So on an iPhone each deck button carries an invisible switch on
// top (tapSwitch), and the tap that presses the button flips it. The tick is
// the light one of a switch: felt in the hand, not on a table. iPads have no
// Taptic Engine at all, so they, and iPhones before iOS 18, keep plain
// buttons. Each device can turn haptics off from the bar (initHapticsToggle).
import { storage } from "../common/dom.ts"

export type Haptic = "tap" | "tick" | "click" | "error"

const STORAGE_KEY = "punchboard-haptics"
const PATTERNS: Record<Haptic, number | number[]> = { tap: 12, tick: 5, click: 8, error: [10, 60, 10] }

/** The iOS version an iPhone reports ("iPhone OS 18_2 like Mac OS X"), or 0.
    iOS 26 freezes it at 18_6, which still counts as 18 and later. */
function iosMajor(): number {
  const match = /OS (\d+)_\d+(?:_\d+)? like Mac OS X/.exec(navigator.userAgent)
  return match && match[1] ? parseInt(match[1], 10) : 0
}

/** An iPhone whose Safari ticks under a flipped switch: iOS 18 and later.
    Not an iPad (no Taptic Engine) and not older iOS (no tick): there the
    switch would only cost the tile its keyboard access as a button. */
const switchTicks = (): boolean =>
  typeof navigator.vibrate !== "function" && /iPhone|iPod/.test(navigator.userAgent) && iosMajor() >= 18

/** Whether taps are felt through a switch under the finger rather than vibration. */
export function tapsThroughSwitch(): boolean {
  return switchTicks() && hapticsEnabled()
}

/** Whether this device can give haptic feedback at all: worth a toggle. */
export function canHaptic(): boolean {
  const touch = navigator.maxTouchPoints > 0 || "ontouchstart" in window
  return switchTicks() || (typeof navigator.vibrate === "function" && touch)
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

const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="4" width="8" height="16" rx="2"/><path d="M4 9v6M20 9v6"/></svg>'
const ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="4" width="8" height="16" rx="2"/><path d="M3 3l18 18"/></svg>'

/** The bar's haptics switch, for this device only, and only on a device that
    can give haptics. `changed` runs after each flip, so the grid can swap
    between switch-backed and plain tiles. */
export function initHapticsToggle(button: HTMLButtonElement, changed: () => void): void {
  if (!canHaptic()) return
  const paint = (): void => {
    const on = hapticsEnabled()
    button.innerHTML = on ? ICON_ON : ICON_OFF
    button.setAttribute("aria-pressed", String(on))
    button.title = on ? "Haptic feedback is on" : "Haptic feedback is off"
  }
  paint()
  button.hidden = false
  button.addEventListener("click", () => {
    setHapticsEnabled(!hapticsEnabled())
    paint()
    haptic("tap")
    changed()
  })
}
