// Key combinations for the "Key combination" action, stored as one canonical
// string: modifiers in a fixed order, then one key, joined by "+", e.g.
// "ctrl+shift+k". Keys are named after the physical key (KeyboardEvent.code),
// so a combination recorded on one keyboard layout fires the same key on
// another, which is how OBS hotkeys behave too.

export type Modifier = "ctrl" | "alt" | "shift" | "meta"
export const MODIFIERS: readonly Modifier[] = ["ctrl", "alt", "shift", "meta"]

export interface KeyCombo {
  modifiers: Modifier[]
  key: string
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("")
const DIGITS = "0123456789".split("")
const FUNCTION_KEYS: string[] = []
for (let n = 1; n <= 24; n += 1) FUNCTION_KEYS.push(`f${n}`)
const NAMED_KEYS = [
  "enter", "space", "tab", "escape", "backspace", "delete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  "minus", "equal", "comma", "period", "slash", "backquote", "bracketleft", "bracketright", "backslash", "semicolon", "quote"
]
export const KEY_NAMES: readonly string[] = LETTERS.concat(DIGITS, FUNCTION_KEYS, NAMED_KEYS)

const isModifier = (value: string): value is Modifier => MODIFIERS.indexOf(value as Modifier) !== -1
export const isKeyName = (value: string): boolean => KEY_NAMES.indexOf(value) !== -1

/** Reads a stored combination; null when it is malformed. */
export function parseCombo(text: unknown): KeyCombo | null {
  if (typeof text !== "string") return null
  const parts = text.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const key = parts[parts.length - 1]!
  if (!isKeyName(key)) return null
  const modifiers: Modifier[] = []
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!
    if (!isModifier(part) || modifiers.indexOf(part) !== -1) return null
    modifiers.push(part)
  }
  modifiers.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b))
  return { modifiers, key }
}

export function comboToString(combo: KeyCombo): string {
  const parts: string[] = combo.modifiers.slice()
  parts.push(combo.key)
  return parts.join("+")
}

/** What the recorder needs from a keydown event. */
export interface KeyEventLike {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const CODE_ALIASES: Record<string, string> = {
  Enter: "enter", NumpadEnter: "enter", Space: "space", Tab: "tab", Escape: "escape", Backspace: "backspace", Delete: "delete",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  Minus: "minus", Equal: "equal", Comma: "comma", Period: "period", Slash: "slash", Backquote: "backquote",
  BracketLeft: "bracketleft", BracketRight: "bracketright", Backslash: "backslash", Semicolon: "semicolon", Quote: "quote"
}

function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]!.toLowerCase()
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]!
  const fn = /^F([0-9]{1,2})$/.exec(code)
  if (fn && isKeyName(`f${fn[1]}`)) return `f${fn[1]}`
  return CODE_ALIASES[code] ?? null
}

/** The combination a keydown represents, or null for a modifier-only press
    (Shift alone, for instance) or a key this action cannot send. */
export function comboFromEvent(event: KeyEventLike): string | null {
  const key = keyFromCode(event.code)
  if (!key) return null
  const modifiers: Modifier[] = []
  if (event.ctrlKey) modifiers.push("ctrl")
  if (event.altKey) modifiers.push("alt")
  if (event.shiftKey) modifiers.push("shift")
  if (event.metaKey) modifiers.push("meta")
  return comboToString({ modifiers, key })
}

const MAC_MODIFIER_GLYPHS: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" }
const OTHER_MODIFIER_NAMES: Record<Modifier, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Win" }
const KEY_LABELS: Record<string, string> = {
  enter: "Enter", space: "Space", tab: "Tab", escape: "Esc", backspace: "⌫", delete: "⌦",
  up: "↑", down: "↓", left: "←", right: "→", home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
  minus: "-", equal: "=", comma: ",", period: ".", slash: "/", backquote: "`", bracketleft: "[", bracketright: "]", backslash: "\\", semicolon: ";", quote: "'"
}

/** One modifier's label, for the builder's toggles. */
export const modifierLabel = (modifier: Modifier, mac: boolean): string => (mac ? MAC_MODIFIER_GLYPHS[modifier] : OTHER_MODIFIER_NAMES[modifier])

/** Human form: "⌃⇧K" on a Mac, "Ctrl+Shift+K" elsewhere. */
export function formatCombo(text: string | undefined, mac: boolean): string {
  const combo = parseCombo(text)
  if (!combo) return ""
  const key = KEY_LABELS[combo.key] ?? combo.key.toUpperCase()
  if (mac) return combo.modifiers.map((modifier) => MAC_MODIFIER_GLYPHS[modifier]).join("") + key
  return combo.modifiers.map((modifier) => OTHER_MODIFIER_NAMES[modifier]).concat(key).join("+")
}

/** Whether this page runs on a Mac, for the ⌘-style labels. */
export const isMacLike = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "")
