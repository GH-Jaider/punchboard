// The companion's side of the languages: it lists the locale files in
// public/locales (so a file dropped in there is offered with no code change),
// and words what it sends people (errors, notes, toasts) in the language of
// whoever asked. Lines for the terminal and companion.log stay English.
//
// Code deep inside the companion does not know who asked, so it throws a
// UserError naming a message key and its values; the reply is translated
// where the request is known (main.ts). Its .message is the English text, so
// logs and anything that only reads .message keep working.
import fs from "node:fs"
import path from "node:path"
import {
  AUTO_LANGUAGE, createTranslator, FALLBACK_LANGUAGE, isLocaleFile, parseAcceptLanguage, resolveLanguage, setTranslator
} from "../shared/i18n.ts"
import type { LanguageInfo, LocaleFile, Messages, Translate } from "../shared/i18n.ts"
import { paths } from "./paths.ts"

/** A message to be worded for whoever reads it: a key and its values. A
    value may be another Text (a reason inside a sentence) or plain text
    from elsewhere (OBS's own error, a file name), used as it is. */
export interface Text {
  key: string
  vars?: TextVars
}
export type TextVars = Record<string, string | number | Text>

/** Either a message to translate, or text that has no translation (it came from OBS, the system…). */
export type Said = Text | string

export const say = (key: string, vars?: TextVars): Text => (vars ? { key, vars } : { key })

export const isText = (value: unknown): value is Text =>
  typeof value === "object" && value !== null && typeof (value as Text).key === "string"

/** An error meant for a person. Its message is the English wording. */
export class UserError extends Error {
  readonly text: Text
  constructor(key: string, vars?: TextVars) {
    const text = say(key, vars)
    super(english(text))
    this.text = text
  }
}

/** What an error says, translatable when it came from Punchboard itself. */
export function textOf(error: unknown): Said {
  if (error && typeof error === "object" && isText((error as { text?: unknown }).text)) return (error as { text: Text }).text
  return error instanceof Error ? error.message : String(error)
}

// -------------------------------------------------------------- the files

/** PUNCHBOARD_LOCALES_DIR points at another folder (tests). */
export const LOCALES_DIR = path.resolve(process.env.PUNCHBOARD_LOCALES_DIR ?? path.join(paths.public, "locales"))

interface Loaded { at: number; files: Map<string, LocaleFile> }
let loaded: Loaded | null = null
/** How long the folder is trusted before it is read again: long enough that
    a burst of requests reads it once, short enough that a new file shows up
    by the time anyone opens the picker. */
const FRESH_MS = 2000
const warned = new Set<string>()

const log = (message: string): void => console.log(`[punchboard] ${message}`)

function readFolder(): Map<string, LocaleFile> {
  const files = new Map<string, LocaleFile>()
  let names: string[] = []
  try {
    names = fs.readdirSync(LOCALES_DIR).filter((name) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*\.json$/.test(name)).sort()
  } catch (error) {
    if (!warned.has(LOCALES_DIR)) log(`Could not read the languages folder ${LOCALES_DIR}: ${error instanceof Error ? error.message : String(error)}`)
    warned.add(LOCALES_DIR)
  }
  for (const name of names) {
    const code = name.slice(0, -".json".length)
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, name), "utf8"))
      if (!isLocaleFile(parsed)) throw new Error("it has no meta.name, meta.code or messages")
      // The file name is the code: that is what clients ask for.
      files.set(code, { meta: { name: parsed.meta.name, code }, messages: parsed.messages })
    } catch (error) {
      const note = `${name}:${error instanceof Error ? error.message : String(error)}`
      if (!warned.has(note)) log(`Skipped the language file ${name}: ${error instanceof Error ? error.message : String(error)}`)
      warned.add(note)
    }
  }
  return files
}

function files(): Map<string, LocaleFile> {
  if (!loaded || Date.now() - loaded.at > FRESH_MS) {
    loaded = { at: Date.now(), files: readFolder() }
    translators.clear()
  }
  return loaded.files
}

/** The languages there are files for, English first, then by name. */
export function languages(): LanguageInfo[] {
  const list: LanguageInfo[] = []
  for (const file of files().values()) list.push({ code: file.meta.code, name: file.meta.name })
  return list.sort((a, b) => (a.code === FALLBACK_LANGUAGE ? -1 : b.code === FALLBACK_LANGUAGE ? 1 : a.name.localeCompare(b.name)))
}

export const languageCodes = (): string[] => [...files().keys()]

const messagesOf = (code: string): Messages => files().get(code)?.messages ?? {}

const translators = new Map<string, Translate>()

/** t() for one language, with English behind it. */
export function translator(code: string): Translate {
  let translate = translators.get(code)
  if (!translate) {
    translate = createTranslator(code, messagesOf(code), messagesOf(FALLBACK_LANGUAGE), {
      onMissing: (key) => {
        if (warned.has(`key:${key}`)) return
        warned.add(`key:${key}`)
        log(`No text for "${key}" in the language files.`)
      }
    })
    translators.set(code, translate)
  }
  return translate
}

/** Words a message in a language; plain text stays as it is. */
export function render(said: Said, code: string): string {
  if (typeof said === "string") return said
  const translate = translator(code)
  let vars: Record<string, string | number> | undefined
  if (said.vars) {
    vars = {}
    for (const name of Object.keys(said.vars)) {
      const value = said.vars[name]!
      vars[name] = typeof value === "object" ? render(value, code) : value
    }
  }
  return translate(said.key, vars)
}

export const english = (said: Said): string => render(said, FALLBACK_LANGUAGE)

// ------------------------------------------------------------ who is asking

let setting: () => string = () => AUTO_LANGUAGE

/** Where the saved choice lives (config.json's "language"). */
export function useLanguageSetting(read: () => string): void {
  setting = read
}

export const languageSetting = (): string => setting()

/** The language for a request: the saved choice if it is not "auto", else
    the browser's Accept-Language matched to the files, else English. */
export function languageFor(req: { headers: Record<string, string | string[] | undefined> }): string {
  const header = req.headers["accept-language"]
  return resolveLanguage(setting(), parseAcceptLanguage(Array.isArray(header) ? header.join(",") : header), languageCodes())
}

/** This computer's own language, for what the companion makes before anyone
    asks (the starter decks of a fresh install). The desktop app passes the
    system's in PUNCHBOARD_LOCALE (a comma-separated list, most wanted
    first); from a terminal, LANG and friends say it. */
export function systemLanguage(): string {
  const env = process.env
  const named = [env.PUNCHBOARD_LOCALE, env.LC_ALL, env.LC_MESSAGES, env.LANG]
    .filter((value): value is string => Boolean(value) && value !== "C" && value !== "POSIX")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().split(".")[0]!)
    .filter(Boolean)
  let intl = ""
  try { intl = Intl.DateTimeFormat().resolvedOptions().locale } catch { /* no Intl */ }
  if (intl) named.push(intl)
  return resolveLanguage(setting(), named, languageCodes())
}

// The shared code's t() (starter decks, a deck's default name) speaks this
// computer's language here: what the companion makes on its own, before
// anyone asks, is made for the person sitting at it.
setTranslator(FALLBACK_LANGUAGE, (key, vars) => translator(systemLanguage())(key, vars))

/** Whether a setting names a language there is a file for, or "auto". */
export const isLanguageSetting = (value: unknown): value is string =>
  value === AUTO_LANGUAGE || (typeof value === "string" && files().has(value))
