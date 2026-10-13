// The three interface themes. Each is a set of CSS overrides keyed on
// html[data-theme] (public/themes.css); `bg` feeds the browser's theme-color.
// Hardware also comes dark: the same theme with html[data-mode="dark"],
// stored as its own id so it travels to every deck like any other choice.
import { t } from "./i18n.ts"
import type { ThemeId } from "./types.ts"

export interface Theme { id: ThemeId; label: string; hint: string; bg: string }

/** A theme whose name and hint are read in the page's language when shown. */
const theme = (id: ThemeId, bg: string): Theme => ({
  id,
  bg,
  get label() { return t(`shared.theme.${id}.label`) },
  get hint() { return t(`shared.theme.${id}.hint`) }
})

export const THEMES: readonly Theme[] = [
  theme("studio", "#0d0e11"),
  theme("hardware", "#e4e2dc"),
  theme("broadcast", "#0b0b0b")
]

/** Variants that share a card with their family in the Appearance window. */
const VARIANTS: readonly Theme[] = [
  theme("hardware-dark", "#1c1c1a")
]
const ALL_THEMES: readonly Theme[] = THEMES.concat(VARIANTS)

export const DEFAULT_THEME: ThemeId = "studio"

export const isThemeId = (value: unknown): value is ThemeId => ALL_THEMES.some((theme) => theme.id === value)

export function themeById(id: string | null | undefined): Theme {
  return ALL_THEMES.find((theme) => theme.id === id) ?? THEMES[0]!
}

/** The theme a variant belongs to: what html[data-theme] and the card say. */
export const themeFamily = (id: ThemeId): ThemeId => (id === "hardware-dark" ? "hardware" : id)

/** Whether the theme is the dark variant of its family. */
export const isDarkVariant = (id: ThemeId): boolean => id === "hardware-dark"
