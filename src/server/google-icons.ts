// Google's Material Symbols (fonts.google.com/icons).
//
// The Control Center browses the catalog through the companion, and a picked
// icon is stored in the deck as its vector path, so tablets never need to
// reach Google. The catalog is cached on disk and refreshed monthly; if Google
// is unreachable the last copy is used.
import fs from "node:fs"
import path from "node:path"
import type { GoogleIconEntry } from "../shared/api.ts"
import { safeGlyph } from "../shared/icons.ts"
import type { Glyph, GlyphStyle } from "../shared/types.ts"
import { errorText } from "./http.ts"
import { isObject } from "./store.ts"

const CATALOG_URL = "https://fonts.google.com/metadata/icons?incomplete=1&key=material_symbols"
const SVG_URL = "https://fonts.gstatic.com/s/i/short-term/release/materialsymbols{style}/{name}/{variant}/24px.svg"
const STYLES: readonly GlyphStyle[] = ["outlined", "rounded", "sharp"]
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface CatalogFile { fetchedAt: number; icons: GoogleIconEntry[] }

const isCatalogFile = (value: unknown): value is CatalogFile => isObject(value) && typeof value.fetchedAt === "number" && Array.isArray(value.icons)

interface RawIcon { name: string; popularity?: number; tags?: string[]; categories?: string[] }

const isRawIcon = (value: unknown): value is RawIcon => isObject(value) && typeof value.name === "string"

export const isGlyphStyle = (value: unknown): value is GlyphStyle => STYLES.some((style) => style === value)

export function createGoogleIcons(cacheDir: string) {
  const catalogFile = path.join(cacheDir, "material-symbols.json")
  let catalog: GoogleIconEntry[] | null = null
  const glyphs = new Map<string, Glyph>()

  function readCache(): CatalogFile | null {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(catalogFile, "utf8"))
      return isCatalogFile(data) ? data : null
    } catch {
      return null
    }
  }

  async function loadCatalog(): Promise<GoogleIconEntry[]> {
    if (catalog) return catalog
    const cached = readCache()
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return (catalog = cached.icons)
    try {
      const response = await fetch(CATALOG_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // The body starts with an anti-JSON-hijacking prefix: )]}'
      const raw: unknown = JSON.parse((await response.text()).replace(/^\)\]\}'\s*/, ""))
      const list = isObject(raw) && Array.isArray(raw.icons) ? raw.icons.filter(isRawIcon) : []
      const icons = list
        .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
        .map((icon): GoogleIconEntry => ({ n: icon.name, t: (icon.tags ?? []).slice(0, 16).join(" ").toLowerCase(), c: icon.categories?.[0] ?? "" }))
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(catalogFile, JSON.stringify({ fetchedAt: Date.now(), icons } satisfies CatalogFile))
      return (catalog = icons)
    } catch (error) {
      if (cached) return (catalog = cached.icons)
      throw new Error(`Could not reach Google Fonts to list icons. (${errorText(error)})`)
    }
  }

  async function loadGlyph(name: string, style: string, fill: boolean): Promise<Glyph> {
    if (!/^[a-z0-9_]{1,64}$/.test(name)) throw new Error("That is not a Google icon name.")
    if (!isGlyphStyle(style)) throw new Error("Choose outlined, rounded or sharp.")
    const key = `${style}/${name}/${fill ? 1 : 0}`
    const known = glyphs.get(key)
    if (known) return known

    const url = SVG_URL.replace("{style}", style).replace("{name}", name).replace("{variant}", fill ? "fill1" : "default")
    const response = await fetch(url)
    if (!response.ok) throw new Error(response.status === 404 ? `Google has no “${name}” icon in that style.` : `Google Fonts answered ${response.status}.`)
    const svg = await response.text()
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
    const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
    const glyph = safeGlyph({ source: "google", name, style, fill, viewBox, paths })
    if (!glyph) throw new Error("That icon came back in a shape this deck cannot draw.")
    glyphs.set(key, glyph)
    return glyph
  }

  return { loadCatalog, loadGlyph }
}
