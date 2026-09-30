// Theme and accent colour, applied here and pushed to every paired deck.
import type { SettingsSaved } from "../../shared/api.ts"
import { DEFAULT_THEME, THEMES, themeById } from "../../shared/themes.ts"
import type { ThemeId } from "../../shared/types.ts"
import { applyAccent, applyTheme, byId, el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"

let currentTheme: ThemeId = DEFAULT_THEME

export const activeTheme = (): ThemeId => currentTheme

function renderThemes(): void {
  const host = byId("theme-list")
  host.innerHTML = ""
  for (const theme of THEMES) {
    const option = el("button", "theme-option")
    option.type = "button"
    option.setAttribute("role", "radio")
    option.setAttribute("aria-checked", String(theme.id === currentTheme))
    option.appendChild(el("span", `theme-swatch ${theme.id}`))
    const text = el("span")
    text.appendChild(el("strong", null, theme.label))
    text.appendChild(el("small", null, theme.hint))
    option.appendChild(text)
    option.onclick = () => void chooseTheme(theme.id)
    host.appendChild(option)
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
