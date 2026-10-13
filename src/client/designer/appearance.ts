// Theme, accent colour and language, applied here and pushed to every paired deck.
import type { LanguagesResponse, SettingsSaved } from "../../shared/api.ts"
import { AUTO_LANGUAGE, t } from "../../shared/i18n.ts"
import type { LanguageInfo } from "../../shared/i18n.ts"
import { DEFAULT_THEME, isDarkVariant, THEMES, themeById, themeFamily } from "../../shared/themes.ts"
import type { ThemeId } from "../../shared/types.ts"
import { applyAccent, applyTheme, byId, el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { changeLanguage, languageForSetting, languageSetting, noteLanguages, onLanguageChange, pageLanguage } from "../common/i18n.ts"
import { toast } from "./hub.ts"

let currentTheme: ThemeId = DEFAULT_THEME

export const activeTheme = (): ThemeId => currentTheme

/** A miniature deck in the theme's own colours: six keys, one of them lit. */
function themePreview(themeId: ThemeId): HTMLElement {
  const preview = el("span", `theme-preview ${themeFamily(themeId)}${isDarkVariant(themeId) ? " dark" : ""}`)
  preview.setAttribute("aria-hidden", "true")
  for (let key = 0; key < 6; key += 1) preview.appendChild(el("span", key === 1 ? "k on" : "k"))
  return preview
}

function renderThemes(): void {
  const host = byId("theme-list")
  host.innerHTML = ""
  const family = themeFamily(currentTheme)
  for (const theme of THEMES) {
    const chosen = theme.id === family
    // The Hardware card shows the light or dark chassis that is in use.
    const shown = chosen ? currentTheme : theme.id
    const card = el("button", "theme-card")
    card.type = "button"
    card.setAttribute("role", "radio")
    card.setAttribute("aria-checked", String(chosen))
    card.appendChild(themePreview(shown))
    const text = el("span", "theme-text")
    text.appendChild(el("strong", null, theme.label))
    text.appendChild(el("small", null, themeById(shown).hint))
    card.appendChild(text)
    card.onclick = () => void chooseTheme(chosen ? currentTheme : theme.id)
    host.appendChild(card)
  }
  // Only Hardware comes in light and dark.
  if (family === "hardware") host.appendChild(modeSwitch())
}

function modeSwitch(): HTMLElement {
  const row = el("div", "theme-mode")
  row.appendChild(el("span", "field-label", themeById("hardware").label))
  const group = el("div", "segmented")
  group.setAttribute("role", "group")
  group.setAttribute("aria-label", t("designer.appearance.hardwareMode"))
  const choices: ReadonlyArray<{ id: ThemeId; text: string }> = [
    { id: "hardware", text: t("designer.appearance.light") },
    { id: "hardware-dark", text: t("designer.appearance.dark") }
  ]
  for (const choice of choices) {
    const option = el("button", null, choice.text)
    option.type = "button"
    option.setAttribute("aria-pressed", String(currentTheme === choice.id))
    option.onclick = () => void chooseTheme(choice.id)
    group.appendChild(option)
  }
  row.appendChild(group)
  return row
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
    const label = themeById(id).label
    toast(t("designer.appearance.themeApplied", { theme: isDarkVariant(id) ? t("designer.appearance.themeDark", { theme: label }) : label }))
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

// --------------------------------------------------------------- language

let languageList: LanguageInfo[] = []

function renderLanguages(): void {
  const picker = byId<HTMLSelectElement>("language-picker")
  picker.innerHTML = ""
  picker.appendChild(new Option(t("designer.appearance.languageAuto"), AUTO_LANGUAGE))
  // Each language in its own name, as people look for it.
  for (const language of languageList) picker.appendChild(new Option(language.name, language.code))
  const setting = languageSetting()
  picker.value = languageList.some((language) => language.code === setting) ? setting : AUTO_LANGUAGE
}

/** Fills the language picker from the files the companion has right now. */
export async function showLanguage(): Promise<void> {
  try {
    languageList = (await request<LanguagesResponse>("/api/languages")).languages
    noteLanguages(undefined, languageList.map((language) => language.code))
  } catch {
    // Without the list the picker still offers Automatic and what is in use.
  }
  renderLanguages()
}

/** Follows a language setting, from here or another window: the page
    switches in place when it changes what this page speaks. */
export async function followLanguage(setting: string): Promise<void> {
  noteLanguages(setting)
  const code = languageForSetting(setting)
  if (code !== pageLanguage()) await changeLanguage(code)
  renderLanguages()
}

async function chooseLanguage(setting: string): Promise<void> {
  const previous = languageSetting()
  if (setting === previous) return
  try {
    const saved = await request<SettingsSaved>("/api/settings", { method: "PUT", json: { language: setting } })
    await followLanguage(saved.language)
    toast(t("designer.appearance.languageSaved"))
  } catch (error) {
    noteLanguages(previous)
    renderLanguages()
    toast(errorMessage(error), true)
  }
}

export function bindAppearance(): void {
  const dialog = byId<HTMLDialogElement>("dlg-appearance")
  byId("appearance-btn").addEventListener("click", () => {
    dialog.showModal()
    // A language file dropped in since the page loaded shows up here.
    void showLanguage()
  })

  const picker = byId<HTMLInputElement>("accent-picker")
  picker.addEventListener("input", () => {
    byId("accent-hex").textContent = picker.value
    applyAccent(picker.value)
  })
  picker.addEventListener("change", async () => {
    try {
      const saved = await request<SettingsSaved>("/api/settings", { method: "PUT", json: { accent: picker.value } })
      applyAccent(saved.accent)
      toast(t("designer.appearance.accentSaved"))
    } catch (error) {
      toast(errorMessage(error), true)
    }
  })

  const languages = byId<HTMLSelectElement>("language-picker")
  languages.addEventListener("change", () => void chooseLanguage(languages.value))
  onLanguageChange(() => {
    renderThemes()
    renderLanguages()
  })
}
