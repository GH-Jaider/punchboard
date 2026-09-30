// Browser helpers every page shares: colour tokens, themes, small DOM
// builders and the toast.
import { colorValue, mixHex, parseHex, readableInk, withAlpha } from "../../shared/colors.ts"
import { themeById } from "../../shared/themes.ts"
import type { ButtonColorId, ThemeId } from "../../shared/types.ts"

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
export function applyTileColor(element: HTMLElement, colorId: ButtonColorId): void {
  const hex = colorValue(colorId)
  const style = element.style
  style.setProperty("--tile-color", hex)
  style.setProperty("--tile-ink", readableInk(hex))
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
  if (root.getAttribute("data-theme") === theme.id) return theme.id
  root.setAttribute("data-theme-switching", "")
  root.setAttribute("data-theme", theme.id)
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

/** A single toast element per page (#toast). */
export function createToast(element: HTMLElement, durationMs = 2600): (message: string, isError?: boolean) => void {
  let timer: number | undefined
  return (message, isError = false) => {
    element.textContent = message
    element.className = `toast show${isError ? " is-error" : ""}`
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { element.className = "toast" }, durationMs)
  }
}

/** An inline stroke SVG from path markup, for UI chrome icons. */
export function svg(paths: string, size?: number): string {
  const sizing = size ? ` style="width:${size}px;height:${size}px"` : ""
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${sizing}>${paths}</svg>`
}
