// Haptic feedback on the device, where it has a way to give it.
//
// Android: the Vibration API, with short pulses for a crisp tick.
// iPhone (iOS 18 and later): Safari offers pages no vibration, but toggling a
// switch control fires the Taptic Engine, the same tick a switch in Settings
// gives; a hidden one is toggled for each haptic. iPads have no Taptic Engine.
//
// Safari only allows that inside a touch or click, so on an iPhone faders and
// the trackpad tick as far as the touch events let them.
import { storage } from "../common/dom.ts"

export type Haptic = "tap" | "tick" | "click" | "error"

const STORAGE_KEY = "punchboard-haptics"
const PATTERNS: Record<Haptic, number | number[]> = { tap: 12, tick: 5, click: 8, error: [10, 60, 10] }

/** iPhones and iPads, including iPads that present themselves as a Mac. */
const appleTouch = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

/** Toggles a throwaway switch control, which iOS 18 answers with a tap of the
    Taptic Engine. The switch sits inside its label and the label is clicked,
    the shape that works; it is hidden and removed straight away. Safari does
    not say whether it knows the switch attribute, so it is not asked. */
function tapticTick(): void {
  const label = document.createElement("label")
  label.setAttribute("aria-hidden", "true")
  label.style.display = "none"
  const input = document.createElement("input")
  input.type = "checkbox"
  input.setAttribute("switch", "")
  label.appendChild(input)
  document.head.appendChild(label)
  label.click()
  document.head.removeChild(label)
}

export function hapticsEnabled(): boolean {
  return storage.get(STORAGE_KEY) !== "off"
}

export function setHapticsEnabled(on: boolean): void {
  storage.set(STORAGE_KEY, on ? "on" : "off")
}

export function haptic(kind: Haptic): void {
  if (!hapticsEnabled()) return
  if (typeof navigator.vibrate === "function") {
    try { navigator.vibrate(PATTERNS[kind]) } catch { /* not allowed here */ }
    return
  }
  if (!appleTouch()) return
  tapticTick()
  // An error is two taps, so it reads differently from a press.
  if (kind === "error") window.setTimeout(tapticTick, 120)
}
