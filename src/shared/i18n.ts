// Every word the interface says comes from a locale file, public/locales/
// <code>.json: { "meta": { "name", "code" }, "messages": { key: text } }.
// Adding a language is adding one file; nothing here names a language but
// English, which every other one falls back to, key by key.
//
// This runs on old tablets too (Safari 11): ES2015 only, and Intl.PluralRules
// is used only where it exists.

/** A plural message: the CLDR category ("one", "few"…) picks the text, "other" is required. */
export interface PluralMessage {
  [category: string]: string
}
export type Message = string | PluralMessage
export interface Messages {
  [key: string]: Message
}

export interface LocaleMeta {
  /** The language's own name for itself ("Español"), as the picker lists it. */
  name: string
  /** The file's name without .json: "es", "pt-BR". */
  code: string
}

export interface LocaleFile {
  meta: LocaleMeta
  messages: Messages
}

/** A language the companion has a file for. */
export interface LanguageInfo {
  code: string
  name: string
}

export type Vars = Record<string, string | number>

/** "auto" follows each device's own language; a code fixes one for all. */
export type LanguageSetting = string

export const FALLBACK_LANGUAGE = "en"
export const AUTO_LANGUAGE = "auto"

/** The plural categories CLDR knows; a locale file may use any of them. */
export const PLURAL_CATEGORIES: readonly string[] = ["zero", "one", "two", "few", "many", "other"]

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key)

export const isPluralMessage = (value: unknown): value is PluralMessage =>
  typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as PluralMessage).other === "string"

/** Whether a parsed file has the shape of a locale file. */
export function isLocaleFile(value: unknown): value is LocaleFile {
  if (typeof value !== "object" || value === null) return false
  const file = value as Partial<LocaleFile>
  return typeof file.meta === "object" && file.meta !== null && typeof file.meta.name === "string" && typeof file.meta.code === "string"
    && typeof file.messages === "object" && file.messages !== null && !Array.isArray(file.messages)
}

/** Language codes compare without case, with "_" read as "-" (es_CO is es-CO). */
const tidyCode = (code: string): string => code.trim().replace(/_/g, "-").toLowerCase()

/** The best available file for the languages a person reads, in their order of
    preference: an exact match ("pt-BR"), else the base language ("es-CO" is
    served by "es"), else a regional file of the same language ("pt" by
    "pt-BR"). Null when none fits. */
export function matchLanguage(wanted: readonly string[], available: readonly string[]): string | null {
  const tidy = available.map(tidyCode)
  for (let i = 0; i < wanted.length; i += 1) {
    const code = tidyCode(wanted[i] || "")
    if (!code) continue
    const exact = tidy.indexOf(code)
    if (exact !== -1) return available[exact]!
    const base = code.split("-")[0]!
    const baseIndex = tidy.indexOf(base)
    if (baseIndex !== -1) return available[baseIndex]!
    for (let j = 0; j < tidy.length; j += 1) {
      if (tidy[j]!.split("-")[0] === base) return available[j]!
    }
  }
  return null
}

/** The language to speak: a fixed setting if there is a file for it, else
    the reader's own languages matched to the files, else English. */
export function resolveLanguage(setting: string | null | undefined, preferred: readonly string[], available: readonly string[]): string {
  if (setting && setting !== AUTO_LANGUAGE) {
    const fixed = matchLanguage([setting], available)
    if (fixed) return fixed
  }
  return matchLanguage(preferred, available) || FALLBACK_LANGUAGE
}

/** The languages in an Accept-Language header, most wanted first. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  const entries: Array<{ code: string; q: number; at: number }> = []
  const parts = header.split(",")
  for (let i = 0; i < parts.length; i += 1) {
    const pieces = parts[i]!.trim().split(";")
    const code = pieces[0]!.trim()
    if (!code || code === "*") continue
    let q = 1
    for (let j = 1; j < pieces.length; j += 1) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(pieces[j]!)
      if (match) q = Number(match[1])
    }
    if (q > 0) entries.push({ code, q, at: i })
  }
  entries.sort((a, b) => b.q - a.q || a.at - b.at)
  return entries.map((entry) => entry.code)
}

// ------------------------------------------------------------------ plurals

interface PluralRulesLike { select(count: number): string }
type PluralRulesConstructor = new (locale: string) => PluralRulesLike

const pluralRules: Record<string, PluralRulesLike | null> = {}

/** The CLDR category for a count. Safari 11 and Android 5's Chrome have no
    Intl.PluralRules; there, 1 is "one" and everything else "other", which is
    right for English and Spanish. */
export function pluralCategory(code: string, count: number): string {
  if (!hasOwn(pluralRules, code)) {
    const intl = typeof Intl !== "undefined" ? (Intl as unknown as { PluralRules?: PluralRulesConstructor }) : undefined
    let rules: PluralRulesLike | null = null
    if (intl && typeof intl.PluralRules === "function") {
      try { rules = new intl.PluralRules(code) } catch { rules = null }
    }
    pluralRules[code] = rules
  }
  const rules = pluralRules[code]
  return rules ? rules.select(count) : count === 1 ? "one" : "other"
}

/** Lets the tests take the path old browsers take. */
export function forgetPluralRules(): void {
  for (const code of Object.keys(pluralRules)) delete pluralRules[code]
}

// --------------------------------------------------------------- formatting

/** Fills {name} placeholders; one without a value is left as it is, so a
    mistake shows rather than vanishing. */
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole: string, name: string) => (hasOwn(vars, name) ? String(vars[name]) : whole))
}

/** The {placeholders} a message uses, sorted, across all its plural forms. */
export function placeholdersOf(message: Message): string[] {
  const texts = typeof message === "string" ? [message] : Object.keys(message).map((category) => message[category]!)
  const found: string[] = []
  for (const text of texts) {
    const pattern = /\{([A-Za-z0-9_]+)\}/g
    let match = pattern.exec(text)
    while (match) {
      if (found.indexOf(match[1]!) === -1) found.push(match[1]!)
      match = pattern.exec(text)
    }
  }
  return found.sort()
}

export type Translate = (key: string, vars?: Vars) => string

export interface TranslatorOptions {
  /** Told about a key that is in no file at all (a typo, or a key not added yet). */
  onMissing?: (key: string) => void
}

/** A t() for one language: its own messages, then English's, then the key itself. */
export function createTranslator(code: string, messages: Messages, fallback: Messages, options: TranslatorOptions = {}): Translate {
  const pick = (key: string): { message: Message; code: string } | null => {
    if (hasOwn(messages, key)) return { message: messages[key]!, code }
    if (hasOwn(fallback, key)) return { message: fallback[key]!, code: FALLBACK_LANGUAGE }
    return null
  }
  return (key, vars) => {
    const found = pick(key)
    if (!found) {
      if (options.onMissing) options.onMissing(key)
      return key
    }
    const message = found.message
    if (typeof message === "string") return fill(message, vars)
    const count = vars && typeof vars.count === "number" ? vars.count : Number(vars && vars.count)
    const category = pluralCategory(found.code, count)
    const text = hasOwn(message, category) ? message[category]! : message.other!
    return fill(text, vars)
  }
}

// ------------------------------------------------------ this page's language

// A page speaks one language at a time. The browser sets it once the locale
// file is in; the shared tables (action names, starter decks) read it through
// t(), so they always say what the page says.
let current: Translate = createTranslator(FALLBACK_LANGUAGE, {}, {})
let currentCode = FALLBACK_LANGUAGE

export function setTranslator(code: string, translate: Translate): void {
  current = translate
  currentCode = code
}

/** The current language's text for a key. */
export const t: Translate = (key, vars) => current(key, vars)

/** The language the page speaks now. */
export const currentLanguage = (): string => currentCode

/** Runs `work` in another language, then puts the page's back. Used where one
    process speaks for several people (the companion making starter decks). */
export function inLanguage<T>(code: string, translate: Translate, work: () => T): T {
  const before = current
  const beforeCode = currentCode
  setTranslator(code, translate)
  try {
    return work()
  } finally {
    setTranslator(beforeCode, before)
  }
}
