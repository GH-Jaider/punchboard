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

let switchLabel: HTMLLabelElement | null = null

/** A hidden switch whose toggling the iPhone answers with a tap of the Taptic Engine. */
function iosSwitch(): HTMLLabelElement | null {
  if (switchLabel) return switchLabel
  const input = document.createElement("input")
  if (!("switch" in input)) return null
  input.type = "checkbox"
  input.setAttribute("switch", "")
  input.id = "haptic-switch"
  input.tabIndex = -1
  input.setAttribute("aria-hidden", "true")
  const label = document.createElement("label")
  label.htmlFor = input.id
  label.setAttribute("aria-hidden", "true")
  const hidden = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none"
  input.style.cssText = hidden
  label.style.cssText = hidden
  document.body.appendChild(input)
  document.body.appendChild(label)
  switchLabel = label
  return label
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
  const label = iosSwitch()
  if (!label) return
  label.click()
  // An error is two taps, so it reads differently from a press.
  if (kind === "error") window.setTimeout(() => label.click(), 120)
}
