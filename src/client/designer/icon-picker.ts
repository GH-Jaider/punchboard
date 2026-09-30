// The icon picker (Google's Material Symbols) and custom image uploads.
import { LIMITS } from "../../shared/actions.ts"
import type { GlyphResponse, GoogleIconEntry, GoogleIconsResponse } from "../../shared/api.ts"
import type { Button, GlyphStyle } from "../../shared/types.ts"
import { byId, el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast, view } from "./hub.ts"
import { selectedButton, touch } from "./state.ts"

const GOOGLE_PREVIEW = "https://fonts.gstatic.com/s/i/short-term/release/materialsymbols{style}/{name}/{variant}/24px.svg"
const GOOGLE_LIMIT = 180
const GLYPH_STYLES: readonly GlyphStyle[] = ["outlined", "rounded", "sharp"]

let googleStyle: GlyphStyle = "outlined"
let googleCatalog: GoogleIconEntry[] | null = null
let targetId: string | null = null

const dialog = (): HTMLDialogElement => byId<HTMLDialogElement>("dlg-icons")
const search = (): HTMLInputElement => byId<HTMLInputElement>("icon-search")
const filled = (): boolean => byId<HTMLInputElement>("google-fill").checked

/** Applies a pick: redraws the tile and the inspector and closes the picker. */
function picked(button: Button): void {
  touch()
  view.refreshTile(button)
  dialog().close()
  view.renderInspector()
}

export function openIconPicker(button: Button): void {
  targetId = button.id
  search().value = ""
  drawGoogleIcons(button)
  dialog().showModal()
  search().focus()
}

function googlePreviewUrl(name: string): string {
  return GOOGLE_PREVIEW.replace("{style}", googleStyle).replace("{name}", name).replace("{variant}", filled() ? "fill1" : "default")
}

/** Whole-word prefixes, so "mic" finds mic and microphone but not academic.
    An exact name wins, then name words, then tags; the catalog is already in
    popularity order, which breaks ties. */
function rankGoogleIcons(catalog: readonly GoogleIconEntry[], query: string): GoogleIconEntry[] {
  const words = query.split("_").filter(Boolean)
  const ranked: Array<{ icon: GoogleIconEntry; order: number }> = []
  catalog.forEach((icon, popularity) => {
    let score = 0
    const matched = words.every((word) => {
      if (`_${icon.n}`.includes(`_${word}`)) return true
      if (` ${icon.t}`.includes(` ${word}`)) {
        score += 1
        return true
      }
      return false
    })
    if (!matched) return
    if (icon.n === query) score = -1
    ranked.push({ icon, order: score * 100000 + popularity })
  })
  return ranked.sort((a, b) => a.order - b.order).map((entry) => entry.icon)
}

/** Previews load from Google while browsing; a picked icon is fetched through
    the companion and saved into the deck as a path, so tablets never need the internet. */
function drawGoogleIcons(button: Button): void {
  const host = byId("icon-groups")
  if (!googleCatalog) {
    host.innerHTML = ""
    host.appendChild(el("p", "field-help", "Loading Google icons…"))
    request<GoogleIconsResponse>("/api/icons/google").then((data) => {
      googleCatalog = data.icons
      if (dialog().open) drawGoogleIcons(button)
    }).catch((error: unknown) => {
      host.innerHTML = ""
      host.appendChild(el("p", "field-help", errorMessage(error)))
    })
    return
  }

  const query = search().value.trim().toLowerCase().replace(/\s+/g, "_")
  const matches = rankGoogleIcons(googleCatalog, query)

  host.innerHTML = ""
  host.appendChild(el("p", "picker-note", matches.length > GOOGLE_LIMIT
    ? `Showing the ${GOOGLE_LIMIT} most popular of ${matches.length}. Search to narrow it down.`
    : `${matches.length}${matches.length === 1 ? " icon" : " icons"}`))
  const grid = el("div", "picker-grid")
  for (const icon of matches.slice(0, GOOGLE_LIMIT)) {
    const choice = el("button", "icon-choice")
    choice.type = "button"
    choice.title = icon.n.replace(/_/g, " ")
    choice.setAttribute("aria-label", choice.title)
    choice.setAttribute("aria-pressed", String(button.glyph?.name === icon.n))
    const preview = el("span", "g-preview")
    preview.style.setProperty("--glyph", `url("${googlePreviewUrl(icon.n)}")`)
    choice.appendChild(preview)
    choice.onclick = () => void pickGoogleIcon(button, icon.n, choice)
    grid.appendChild(choice)
  }
  host.appendChild(grid)
  if (!matches.length) host.appendChild(el("p", "field-help", `No Google icon matches “${query.replace(/_/g, " ")}”.`))
}

async function pickGoogleIcon(button: Button, name: string, choice: HTMLElement): Promise<void> {
  choice.classList.add("is-loading")
  const params = `name=${encodeURIComponent(name)}&style=${googleStyle}&fill=${filled() ? "1" : "0"}`
  try {
    button.glyph = await request<GlyphResponse>(`/api/icons/google/glyph?${params}`)
    button.iconData = null
    picked(button)
  } catch (error) {
    choice.classList.remove("is-loading")
    toast(errorMessage(error), true)
  }
}

// ------------------------------------------------------------ custom images

const UNSAFE_SVG = /<script|<foreignObject|\son\w+\s*=|(?:href|src)\s*=\s*["']\s*(?:https?:|data:|javascript:)/i

/** Reads an uploaded icon as a data URI, refusing SVGs with scripts or external references. */
export function readIcon(file: File): Promise<string | null> {
  if (file.size > LIMITS.maxIconBytes) {
    toast("Keep custom icons under 750 KB.", true)
    return Promise.resolve(null)
  }
  if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) {
    toast("Choose a PNG, JPG, WebP or SVG file.", true)
    return Promise.resolve(null)
  }
  const isSvg = file.type === "image/svg+xml"
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const data = String(reader.result)
      if (!isSvg) return resolve(data)
      if (UNSAFE_SVG.test(data)) {
        toast("That SVG contains embedded content this deck will not load.", true)
        return resolve(null)
      }
      resolve(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(data)))}`)
    }
    if (isSvg) reader.readAsText(file)
    else reader.readAsDataURL(file)
  })
}

export function bindIconPicker(): void {
  const styleOptions = document.querySelectorAll<HTMLElement>("#google-options [data-style]")
  styleOptions.forEach((option) => {
    option.addEventListener("click", () => {
      googleStyle = GLYPH_STYLES.find((style) => style === option.dataset.style) ?? "outlined"
      styleOptions.forEach((other) => other.setAttribute("aria-pressed", String(other === option)))
      const button = selectedButton()
      if (button) drawGoogleIcons(button)
    })
  })
  byId("google-fill").addEventListener("change", () => {
    const button = selectedButton()
    if (button) drawGoogleIcons(button)
  })
  search().addEventListener("input", () => {
    const button = selectedButton()
    if (button && button.id === targetId) drawGoogleIcons(button)
  })
  byId("icons-close").addEventListener("click", () => dialog().close())
}
