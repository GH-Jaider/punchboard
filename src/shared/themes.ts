// The three interface themes. Each is a set of CSS overrides keyed on
// html[data-theme] (public/themes.css); `bg` feeds the browser's theme-color.
// Hardware also comes dark: the same theme with html[data-mode="dark"],
// stored as its own id so it travels to every deck like any other choice.
import type { ThemeId } from "./types.ts"

export interface Theme { id: ThemeId; label: string; hint: string; bg: string }

export const THEMES: readonly Theme[] = [
  { id: "studio", label: "Studio", hint: "Dark and soft. The original look.", bg: "#0d0e11" },
  { id: "hardware", label: "Hardware", hint: "Light chassis, physical keys.", bg: "#e4e2dc" },
  { id: "broadcast", label: "Broadcast", hint: "Switcher console, hard edges.", bg: "#0b0b0b" }
]

/** Variants that share a card with their family in the Appearance window. */
const VARIANTS: readonly Theme[] = [
  { id: "hardware-dark", label: "Hardware", hint: "Dark chassis, physical keys.", bg: "#1c1c1a" }
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
