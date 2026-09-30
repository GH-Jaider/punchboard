// Theme and accent colour, applied here and pushed to every paired deck.
import type { SettingsSaved } from "../../shared/api.ts"
import { DEFAULT_THEME, THEMES, themeById } from "../../shared/themes.ts"
import type { ThemeId } from "../../shared/types.ts"
import { applyAccent, applyTheme, byId, el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"

let currentTheme: ThemeId = DEFAULT_THEME

export const activeTheme = (): ThemeId => currentTheme

/** A miniature deck in the theme's own colours: six keys, one of them lit. */
function themePreview(themeId: ThemeId): HTMLElement {
  const preview = el("span", `theme-preview ${themeId}`)
  preview.setAttribute("aria-hidden", "true")
  for (let key = 0; key < 6; key += 1) preview.appendChild(el("span", key === 1 ? "k on" : "k"))
  return preview
}

function renderThemes(): void {
  const host = byId("theme-list")
  host.innerHTML = ""
  for (const theme of THEMES) {
    const card = el("button", "theme-card")
    card.type = "button"
    card.setAttribute("role", "radio")
    card.setAttribute("aria-checked", String(theme.id === currentTheme))
    card.appendChild(themePreview(theme.id))
    const text = el("span", "theme-text")
    text.appendChild(el("strong", null, theme.label))
    text.appendChild(el("small", null, theme.hint))
    card.appendChild(text)
    card.onclick = () => void chooseTheme(theme.id)
    host.appendChild(card)
  }
}

export function setTheme(id: string | undefined): void {
  currentTheme = applyTheme(id)
  renderThemes()
}

/** Applied at once so the choice feels instant; rolled back if the save fails. */
async function chooseTheme(id: ThemeId): Promise<void> {
  if (id === currentTheme) return
  const previous = currentTheme
  setTheme(id)
  try {
    await request<SettingsSaved>("/api/settings", { method: "PUT", json: { theme: id } })
    toast(`${themeById(id).label} theme applied to every deck.`)
  } catch (error) {
    setTheme(previous)
    toast(errorMessage(error), true)
  }
}

/** Shows the saved accent in the picker and applies it. */
export function showAccent(accent: string): void {
  byId<HTMLInputElement>("accent-picker").value = accent
  byId("accent-hex").textContent = accent
  applyAccent(accent)
}

export function bindAppearance(): void {
  const dialog = byId<HTMLDialogElement>("dlg-appearance")
  byId("appearance-btn").addEventListener("click", () => dialog.showModal())

  const picker = byId<HTMLInputElement>("accent-picker")
  picker.addEventListener("input", () => {
    byId("accent-hex").textContent = picker.value
    applyAccent(picker.value)
  })
  picker.addEventListener("change", async () => {
    try {
      const saved = await request<SettingsSaved>("/api/settings", { method: "PUT", json: { accent: picker.value } })
      applyAccent(saved.accent)
      toast("Interface colour saved for every deck.")
    } catch (error) {
      toast(errorMessage(error), true)
    }
  })
}
