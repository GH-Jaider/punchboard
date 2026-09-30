// Google's Material Symbols (fonts.google.com/icons).
//
// The Control Center browses the catalog through the companion, and a picked
// icon is stored in the deck as its vector path, so tablets never need to
// reach Google. The catalog is cached on disk and refreshed monthly; if Google
// is unreachable the last copy is used.
const fs = require("fs")
const path = require("path")
const { safeGlyph } = require("../public/deck-shared.js")

const CATALOG_URL = "https://fonts.google.com/metadata/icons?incomplete=1&key=material_symbols"
const SVG_URL = "https://fonts.gstatic.com/s/i/short-term/release/materialsymbols{style}/{name}/{variant}/24px.svg"
const STYLES = new Set(["outlined", "rounded", "sharp"])
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function createGoogleIcons(cacheDir) {
  const catalogFile = path.join(cacheDir, "material-symbols.json")
  let catalog = null
  const glyphs = new Map()

  async function loadCatalog() {
    if (catalog) return catalog
    let cached = null
    try { cached = JSON.parse(fs.readFileSync(catalogFile, "utf8")) } catch {}
    if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return (catalog = cached.icons)
    try {
      const response = await fetch(CATALOG_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // The body starts with an anti-JSON-hijacking prefix: )]}'
      const raw = JSON.parse((await response.text()).replace(/^\)\]\}'\s*/, ""))
      const icons = raw.icons
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .map((icon) => ({ n: icon.name, t: (icon.tags || []).slice(0, 16).join(" ").toLowerCase(), c: (icon.categories || [])[0] || "" }))
      fs.mkdirSync(cacheDir, { recursive: true })
      fs.writeFileSync(catalogFile, JSON.stringify({ fetchedAt: Date.now(), icons }))
      return (catalog = icons)
    } catch (error) {
      if (cached) return (catalog = cached.icons)
      throw new Error(`Could not reach Google Fonts to list icons. (${error.message})`)
    }
  }

  // Returns { name, style, fill, viewBox, paths } for one icon.
  async function loadGlyph(name, style, fill) {
    if (!/^[a-z0-9_]{1,64}$/.test(name)) throw new Error("That is not a Google icon name.")
    if (!STYLES.has(style)) throw new Error("Choose outlined, rounded or sharp.")
    const key = `${style}/${name}/${fill ? 1 : 0}`
    if (glyphs.has(key)) return glyphs.get(key)

    const url = SVG_URL.replace("{style}", style).replace("{name}", name).replace("{variant}", fill ? "fill1" : "default")
    const response = await fetch(url)
    if (!response.ok) throw new Error(response.status === 404 ? `Google has no “${name}” icon in that style.` : `Google Fonts answered ${response.status}.`)
    const svg = await response.text()
    const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1]
    const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1])
    const glyph = safeGlyph({ source: "google", name, style, fill: Boolean(fill), viewBox, paths })
    if (!glyph) throw new Error("That icon came back in a shape this deck cannot draw.")
    glyphs.set(key, glyph)
    return glyph
  }

  return { loadCatalog, loadGlyph }
}

module.exports = { createGoogleIcons }
