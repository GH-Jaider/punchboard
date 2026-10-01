// Full-screen mode, and a way back out that works on a touchscreen: the grip
// at the top, Escape, or leaving browser full screen.
//
// iPads only offer the webkit-prefixed API; iPhones offer none for pages, so
// there the deck hides its own bar and points at Add to Home Screen, which
// opens it with no browser chrome at all.
import { byId } from "../common/dom.ts"
import { scaleTiles } from "./grid.ts"
import { hint } from "./ui.ts"

type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => unknown }
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => unknown }

const button = byId("immersive-btn")
const doc = document as FullscreenDocument
const HINT_KEY = "punchboard-homescreen-hint"

const isImmersive = (): boolean => document.body.classList.contains("immersive")

/** Opened from the Home Screen: there is no browser chrome to hide. */
const standalone = (): boolean =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)

const fullscreenElement = (): Element | null => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null

/** Asks the browser for full screen; false when this browser has no way. */
function requestFullscreen(): boolean {
  const root = document.documentElement as FullscreenRoot
  if (typeof root.requestFullscreen === "function") {
    root.requestFullscreen().catch(() => { /* refused: the bar still hides */ })
    return true
  }
  if (typeof root.webkitRequestFullscreen === "function") {
    try { root.webkitRequestFullscreen() } catch { /* refused */ }
    return true
  }
  return false
}

function exitFullscreen(): void {
  if (!fullscreenElement()) return
  if (typeof doc.exitFullscreen === "function") doc.exitFullscreen().catch(() => { /* already out */ })
  else if (typeof doc.webkitExitFullscreen === "function") doc.webkitExitFullscreen()
}

function hintHomeScreen(): void {
  hint(HINT_KEY, "This browser cannot go full screen. Use Share › Add to Home Screen, then open Punchboard from there and pair once.")
}

function setImmersive(on: boolean): void {
  document.body.classList.toggle("immersive", on)
  button.textContent = on ? "Exit full screen" : "Full screen"
  button.setAttribute("aria-pressed", String(on))
  setTimeout(scaleTiles, 60)
}

export function initImmersive(): void {
  if (standalone()) button.hidden = true

  button.addEventListener("click", () => {
    const leaving = isImmersive()
    if (leaving) exitFullscreen()
    else if (!requestFullscreen()) hintHomeScreen()
    setImmersive(!leaving)
  })

  byId("reveal-grip").addEventListener("click", () => setImmersive(false))

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isImmersive()) setImmersive(false)
  })

  const onChange = (): void => {
    if (!fullscreenElement() && isImmersive()) setImmersive(false)
  }
  document.addEventListener("fullscreenchange", onChange)
  document.addEventListener("webkitfullscreenchange", onChange)
}
