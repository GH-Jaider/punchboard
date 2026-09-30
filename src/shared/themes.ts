// The three interface themes. Each is a set of CSS overrides keyed on
// html[data-theme] (public/themes.css); `bg` feeds the browser's theme-color.
import type { ThemeId } from "./types.ts"

export interface Theme { id: ThemeId; label: string; hint: string; bg: string }

export const THEMES: readonly Theme[] = [
  { id: "studio", label: "Studio", hint: "Dark and soft. The original look.", bg: "#0d0e11" },
  { id: "hardware", label: "Hardware", hint: "Light chassis, physical keys.", bg: "#e4e2dc" },
  { id: "broadcast", label: "Broadcast", hint: "Switcher console, hard edges.", bg: "#0b0b0b" }
]

export const DEFAULT_THEME: ThemeId = "studio"

export const isThemeId = (value: unknown): value is ThemeId => THEMES.some((theme) => theme.id === value)

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0]!
}
