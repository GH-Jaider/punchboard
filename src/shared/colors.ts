// Colour maths in plain hex, so old tablets need no oklch() or color-mix():
// anything derived from a colour is computed here and handed to CSS.
import { t } from "./i18n.ts"
import type { ButtonColor, ButtonColorId, HexColor } from "./types.ts"

export interface Rgb { r: number; g: number; b: number }

const clamp255 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)))

export function parseHex(hex: string | null | undefined): Rgb | null {
  let value = String(hex ?? "").trim().replace(/^#/, "")
  if (value.length === 3) value = value.split("").map((digit) => digit + digit).join("")
  if (!/^[0-9a-f]{6}$/i.test(value)) return null
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  }
}

export const isHexColor = (value: unknown): value is HexColor => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)

const FALLBACK: Rgb = { r: 95, g: 208, b: 214 }

// No destructuring in shared code: Safari 11 has destructuring bugs that
// esbuild will not paper over, and the deck has to run there.
export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? FALLBACK
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`
}

export function mixHex(hex: string, towardHex: string, amount: number): string {
  const a = parseHex(hex) ?? { r: 0, g: 0, b: 0 }
  const b = parseHex(towardHex) ?? { r: 0, g: 0, b: 0 }
  return `rgb(${clamp255(a.r + (b.r - a.r) * amount)},${clamp255(a.g + (b.g - a.g) * amount)},${clamp255(a.b + (b.b - a.b) * amount)})`
}

/** WCAG relative luminance, so text on a user-chosen colour stays readable. */
function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex) ?? FALLBACK
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

export const DARK_INK = "#08100f"
export const LIGHT_INK = "#ffffff"

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The ink, dark or white, with the higher contrast on this colour. A fixed
    luminance cut-off gave white ink on mid-tones (blue, red, orange) at under
    3:1, where dark ink reads at 6:1 and more. */
export const readableInk = (hex: string): string => (contrastRatio(hex, DARK_INK) >= contrastRatio(hex, LIGHT_INK) ? DARK_INK : LIGHT_INK)

/** So dark it all but vanishes on a dark theme. */
export const isVeryDark = (hex: string): boolean => relativeLuminance(hex) < 0.03

export interface ColorPreset { id: ButtonColorId; label: string; value: string }

/** A preset whose name is read in the page's language when it is shown. */
const preset = (id: ButtonColorId, value: string): ColorPreset => ({
  id,
  value,
  get label() { return t(`shared.color.${id}`) }
})

export const BUTTON_COLORS: readonly ColorPreset[] = [
  preset("accent", "#5fd0d6"),
  preset("blue", "#69a9ff"),
  preset("indigo", "#8095ff"),
  preset("violet", "#b18cd9"),
  preset("pink", "#e982bd"),
  preset("rose", "#e8778c"),
  preset("red", "#f06d6d"),
  preset("orange", "#ed9a55"),
  preset("amber", "#e0b95c"),
  preset("yellow", "#f2d85b"),
  preset("lime", "#9ed36a"),
  preset("green", "#56c596"),
  preset("mint", "#63d6b6"),
  preset("cyan", "#38c7e8"),
  preset("slate", "#93a2ad"),
  preset("white", "#eaf1f8")
]

export const isButtonColorId = (value: unknown): value is ButtonColorId => BUTTON_COLORS.some((color) => color.id === value)

/** A preset's id or a custom #rrggbb. */
export const isButtonColor = (value: unknown): value is ButtonColor => isButtonColorId(value) || isHexColor(value)

export function colorValue(color: ButtonColor): string {
  if (isHexColor(color)) return color.toLowerCase()
  return (BUTTON_COLORS.find((preset) => preset.id === color) ?? BUTTON_COLORS[0]!).value
}
