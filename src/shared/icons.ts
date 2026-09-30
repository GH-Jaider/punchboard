// Icon markup for a button: an uploaded image, a Google glyph, or a built-in
// icon. Everything here returns HTML strings built only from validated parts.
import { DEFAULT_ICON, ICONS } from "./icon-data.ts"
import type { Button, Glyph, GlyphStyle } from "./types.ts"

export { DEFAULT_ICON, ICON_GROUPS, ICONS } from "./icon-data.ts"

const SAFE_IMAGE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i

export const isSafeIconData = (value: unknown): value is string => typeof value === "string" && SAFE_IMAGE.test(value)

export function iconSvg(id: string): string {
  const glyph = ICONS[id] ?? ICONS[DEFAULT_ICON]
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${glyph}</svg>`
}

// Google glyphs arrive from Google and from backup files alike, so only a
// viewBox of four numbers and path data made of path commands are accepted.
const GLYPH_VIEWBOX = /^-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+$/
const GLYPH_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-eE]{1,20000}$/
const GLYPH_STYLES: readonly GlyphStyle[] = ["outlined", "rounded", "sharp"]

export function safeGlyph(value: unknown): Glyph | null {
  if (!value || typeof value !== "object") return null
  const glyph = value as Record<string, unknown>
  if (typeof glyph.viewBox !== "string" || !GLYPH_VIEWBOX.test(glyph.viewBox)) return null
  const paths = glyph.paths
  if (!Array.isArray(paths) || !paths.length || paths.length > 8) return null
  if (!paths.every((path): path is string => typeof path === "string" && GLYPH_PATH.test(path))) return null
  return {
    source: "google",
    name: String(glyph.name ?? "").replace(/[^a-z0-9_]/g, "").slice(0, 64),
    style: GLYPH_STYLES.find((style) => style === glyph.style) ?? "outlined",
    fill: Boolean(glyph.fill),
    viewBox: glyph.viewBox,
    paths: paths.slice()
  }
}

export function glyphSvg(glyph: Glyph): string {
  const paths = glyph.paths.map((path) => `<path d="${path}"/>`).join("")
  return `<svg viewBox="${glyph.viewBox}" fill="currentColor" aria-hidden="true" focusable="false">${paths}</svg>`
}

export function iconMarkup(button: Pick<Button, "icon" | "iconData" | "glyph">): string {
  if (isSafeIconData(button.iconData)) return `<img src="${button.iconData}" alt="">`
  const glyph = safeGlyph(button.glyph)
  if (glyph) return glyphSvg(glyph)
  return iconSvg(button.icon)
}
