// Loads this page's language before anything is drawn, and puts it into the
// page's own HTML. The pages keep their English in the markup, so one that
// cannot fetch a locale file still reads; data-i18n attributes say which key
// each text, placeholder, title or aria-label comes from:
//
//   <h2 data-i18n="designer.appearance.title">Appearance</h2>
//   <input data-i18n-placeholder="designer.apps.search" placeholder="Search…">
//   <p data-i18n-html="deck.pair.intro">On the computer, open <strong>…</strong></p>
//
// data-i18n-html allows only <strong>, <em>, <b>, <kbd> and <br> (see richText).
import type { HelloResponse } from "../../shared/api.ts"
import { createTranslator, FALLBACK_LANGUAGE, isLocaleFile, resolveLanguage, setTranslator, t } from "../../shared/i18n.ts"
import type { LocaleFile, Messages } from "../../shared/i18n.ts"
import { storage } from "./dom.ts"

/** The language last spoken here, so its file can be fetched while the
    companion is still being asked which one to use. */
const LANGUAGE_KEY = "punchboard-language"

/** The languages the browser asks for, most wanted first. */
export function browserLanguages(): string[] {
  const nav = navigator as Navigator & { userLanguage?: string }
  if (nav.languages && nav.languages.length) return Array.prototype.slice.call(nav.languages) as string[]
  return [nav.language || nav.userLanguage || ""]
}

/** What the companion says about languages, kept for later changes. */
let setting = "auto"
let available: string[] = [FALLBACK_LANGUAGE]
let current = FALLBACK_LANGUAGE

export const languageSetting = (): string => setting
export const availableLanguages = (): string[] => available
export const pageLanguage = (): string => current

/** The language this page would speak for a setting. */
export const languageForSetting = (value: string): string => resolveLanguage(value, browserLanguages(), available)

const files: Record<string, Promise<Messages | null>> = {}

/** One locale file's messages, or null when it cannot be had. Fetched once
    per page; the companion answers a repeat visit with a 304. */
function fetchMessages(code: string): Promise<Messages | null> {
  const known = files[code]
  if (known) return known
  const loading = fetch(`/locales/${encodeURIComponent(code)}.json`)
    .then((response) => (response.ok ? response.json() : null))
    .then((data: unknown) => (isLocaleFile(data) ? (data as LocaleFile).messages : null))
    .catch(() => null)
  files[code] = loading
  // A failed fetch may be tried again later.
  loading.then((messages) => { if (!messages) delete files[code] })
  return loading
}

const missing: Record<string, true> = {}
function warnMissing(key: string): void {
  if (missing[key]) return
  missing[key] = true
  if (typeof console !== "undefined") console.warn(`Punchboard: no text for "${key}"`)
}

/** Switches the page to a language: fetches its file (and English, which
    every missing key falls back to) and makes t() speak it. */
export function useLanguage(code: string): Promise<string> {
  const wanted = code === FALLBACK_LANGUAGE ? [fetchMessages(FALLBACK_LANGUAGE)] : [fetchMessages(code), fetchMessages(FALLBACK_LANGUAGE)]
  return Promise.all(wanted).then((loaded) => {
    const english = (code === FALLBACK_LANGUAGE ? loaded[0] : loaded[1]) || {}
    const own = code === FALLBACK_LANGUAGE ? english : loaded[0]
    // No file for that language after all: English it is.
    const spoken = own ? code : FALLBACK_LANGUAGE
    setTranslator(spoken, createTranslator(spoken, own || english, english, { onMissing: warnMissing }))
    current = spoken
    storage.set(LANGUAGE_KEY, spoken)
    document.documentElement.setAttribute("lang", spoken)
    return spoken
  })
}

/** Takes the setting and the list of files from the companion's hello, then
    loads the language. The remembered language's file is fetched alongside
    the hello, so the usual start costs one round trip, not two. */
export function loadLanguage(hello: Promise<Pick<HelloResponse, "language" | "languages"> | null>): Promise<string> {
  const remembered = storage.get(LANGUAGE_KEY)
  if (remembered && remembered !== FALLBACK_LANGUAGE) void fetchMessages(remembered)
  void fetchMessages(FALLBACK_LANGUAGE)
  return hello
    .then((info) => {
      if (info) noteLanguages(info.language, info.languages)
    }, () => undefined)
    .then(() => useLanguage(languageForSetting(setting)))
    .then((code) => {
      translatePage(document)
      return code
    })
}

/** Records the companion's setting and list (from a hello, settings or a snapshot). */
export function noteLanguages(value: string | undefined, codes?: string[]): void {
  if (typeof value === "string" && value) setting = value
  if (codes && codes.length) available = codes
}

// ------------------------------------------------------------ the page's HTML

/** Text with a little markup from a locale file: everything is escaped, then
    only <strong>, <em>, <b>, <kbd> and <br> are let back in. */
export function richText(element: Element, text: string): void {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  element.innerHTML = escaped.replace(/&lt;(\/?)(strong|em|b|kbd)&gt;/g, "<$1$2>").replace(/&lt;br\s*\/?&gt;/g, "<br>")
}

const ATTRIBUTES: ReadonlyArray<{ data: string; target: string }> = [
  { data: "data-i18n-placeholder", target: "placeholder" },
  { data: "data-i18n-title", target: "title" },
  { data: "data-i18n-aria-label", target: "aria-label" }
]

/** Puts the current language into every marked element under `root`. Run
    again after a language change: the keys stay on the elements. */
export function translatePage(root: ParentNode): void {
  const texts = root.querySelectorAll("[data-i18n]")
  for (let i = 0; i < texts.length; i += 1) {
    const element = texts[i]!
    element.textContent = t(element.getAttribute("data-i18n") || "")
  }
  const rich = root.querySelectorAll("[data-i18n-html]")
  for (let i = 0; i < rich.length; i += 1) {
    const element = rich[i]!
    richText(element, t(element.getAttribute("data-i18n-html") || ""))
  }
  for (const attribute of ATTRIBUTES) {
    const marked = root.querySelectorAll(`[${attribute.data}]`)
    for (let i = 0; i < marked.length; i += 1) {
      const element = marked[i]!
      element.setAttribute(attribute.target, t(element.getAttribute(attribute.data) || ""))
    }
  }
}

/** Sets an element's text from a key and keeps the key on it, so
    translatePage() rewords it after a language change. For texts set once. */
export function keyedText(element: Element, key: string): void {
  element.setAttribute("data-i18n", key)
  element.textContent = t(key)
}

/** Sets an attribute (title, aria-label, placeholder) from a key and keeps
    the key on the element, like keyedText. */
export function keyedAttribute(element: Element, attribute: "title" | "aria-label" | "placeholder", key: string): void {
  element.setAttribute(`data-i18n-${attribute}`, key)
  element.setAttribute(attribute, t(key))
}

const listeners: Array<() => void> = []

/** Runs after the page has switched language in place, for anything that
    draws its text once and keeps it. */
export function onLanguageChange(listener: () => void): void {
  listeners.push(listener)
}

/** Switches the page in place: the new file, the marked HTML, then whatever listens. */
export function changeLanguage(code: string): Promise<string> {
  return useLanguage(code).then((spoken) => {
    translatePage(document)
    for (const listener of listeners) listener()
    return spoken
  })
}
