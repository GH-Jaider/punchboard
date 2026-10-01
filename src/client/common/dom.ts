// Browser helpers every page shares: colour tokens, themes, small DOM
// builders and the toast.
import { colorValue, isVeryDark, LIGHT_INK, mixHex, parseHex, readableInk, withAlpha } from "../../shared/colors.ts"
import { isDarkVariant, themeById, themeFamily } from "../../shared/themes.ts"
import type { ButtonColor, ThemeId } from "../../shared/types.ts"

export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id} in the page`)
  return element as T
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string | null, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Publishes every accent-derived CSS token at once, so the accent has one source of truth. */
export function applyAccent(hex: string | undefined, root: HTMLElement = document.documentElement): string {
  const accent = hex && parseHex(hex) ? hex : "#5fd0d6"
  const style = root.style
  style.setProperty("--accent", accent)
  style.setProperty("--accent-ink", readableInk(accent))
  style.setProperty("--accent-line", withAlpha(accent, 0.45))
  style.setProperty("--accent-soft", withAlpha(accent, 0.14))
  style.setProperty("--accent-softer", withAlpha(accent, 0.07))
  style.setProperty("--accent-glow", withAlpha(accent, 0.28))
  style.setProperty("--accent-dim", mixHex(accent, "#0a0c0f", 0.55))
  return accent
}

/** Paints one tile's colour-derived custom properties. */
export function applyTileColor(element: HTMLElement, color: ButtonColor): void {
  const hex = colorValue(color)
  const ink = readableInk(hex)
  const style = element.style
  style.setProperty("--tile-color", hex)
  style.setProperty("--tile-ink", ink)
  // Lines and marks drawn in the ink, softer than the text itself.
  style.setProperty("--tile-ink-line", withAlpha(ink, 0.38))
  // A label strip on a lit key: moved away from the ink, so its text reads
  // even better than on the key itself.
  style.setProperty("--tile-strip", mixHex(hex, ink === LIGHT_INK ? "#000000" : "#ffffff", 0.35))
  // The ring of a lit key. A near-black colour gets a light one, or the lit
  // key vanishes into a dark theme.
  style.setProperty("--tile-edge", isVeryDark(hex) ? "rgba(255,255,255,0.55)" : hex)
  style.setProperty("--tile-soft", withAlpha(hex, 0.16))
  style.setProperty("--tile-line", withAlpha(hex, 0.45))
  style.setProperty("--tile-glow", withAlpha(hex, 0.3))
  style.setProperty("--tile-dim", mixHex(hex, "#0b0b0b", 0.55))
}

export const THEME_STORAGE_KEY = "punchboard-theme"

/** Switches theme without the page smearing between palettes, and remembers it
    so the inline script in each page's <head> can paint it before loading. */
export function applyTheme(id: string | undefined): ThemeId {
  const theme = themeById(id)
  const root = document.documentElement
  const family = themeFamily(theme.id)
  const mode = isDarkVariant(theme.id) ? "dark" : null
  if (root.getAttribute("data-theme") === family && root.getAttribute("data-mode") === mode) return theme.id
  root.setAttribute("data-theme-switching", "")
  root.setAttribute("data-theme", family)
  if (mode) root.setAttribute("data-mode", mode)
  else root.removeAttribute("data-mode")
  setTimeout(() => root.removeAttribute("data-theme-switching"), 60)
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bg)
  storage.set(THEME_STORAGE_KEY, theme.id)
  return theme.id
}

/** localStorage that never throws (private windows, blocked storage). */
export const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value) } catch { /* not available */ }
  },
  remove(key: string): void {
    try { localStorage.removeItem(key) } catch { /* not available */ }
  }
}

export interface ToastAction {
  label: string
  onClick: () => void
}

export type Toast = (message: string, isError?: boolean, action?: ToastAction) => void

/** A single toast element per page (#toast). A toast with an action (e.g.
    Undo) stays up longer, since it is waiting for a click. */
export function createToast(element: HTMLElement, durationMs = 2600): Toast {
  let timer: number | undefined
  const hide = (): void => { element.className = "toast" }
  return (message, isError = false, action) => {
    element.textContent = message
    if (action) {
      const button = el("button", "toast-action", action.label)
      button.type = "button"
      button.onclick = () => {
        hide()
        action.onClick()
      }
      element.appendChild(button)
    }
    element.className = `toast show${isError ? " is-error" : ""}${action ? " has-action" : ""}`
    window.clearTimeout(timer)
    timer = window.setTimeout(hide, action ? Math.max(durationMs, 6000) : durationMs)
  }
}

/** An inline stroke SVG from path markup, for UI chrome icons. */
export function svg(paths: string, size?: number): string {
  const sizing = size ? ` style="width:${size}px;height:${size}px"` : ""
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${sizing}>${paths}</svg>`
}
