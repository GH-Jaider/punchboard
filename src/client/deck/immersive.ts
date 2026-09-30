// Full-screen mode, and a way back out that works on a touchscreen: the grip
// at the top, Escape, or leaving browser full screen.
import { byId } from "../common/dom.ts"
import { scaleTiles } from "./grid.ts"

const button = byId("immersive-btn")
const isImmersive = (): boolean => document.body.classList.contains("immersive")

function setImmersive(on: boolean): void {
  document.body.classList.toggle("immersive", on)
  button.textContent = on ? "Exit full screen" : "Full screen"
  button.setAttribute("aria-pressed", String(on))
  setTimeout(scaleTiles, 60)
}

export function initImmersive(): void {
  button.addEventListener("click", () => {
    const leaving = isImmersive()
    const root = document.documentElement
    if (!leaving && typeof root.requestFullscreen === "function") {
      root.requestFullscreen().catch(() => {})
    } else if (leaving && document.fullscreenElement && typeof document.exitFullscreen === "function") {
      document.exitFullscreen().catch(() => {})
    }
    setImmersive(!leaving)
  })

  byId("reveal-grip").addEventListener("click", () => setImmersive(false))

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isImmersive()) setImmersive(false)
  })

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && isImmersive()) setImmersive(false)
  })
}
