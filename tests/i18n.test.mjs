// Languages: every locale file is complete and shaped like English's, no
// interface English is left in the code, t() falls back and counts right
// (also without Intl.PluralRules, as on Safari 11), the companion words its
// replies in the right language and lists dropped-in files, and the pages
// switch to Spanish when the setting changes.
//   node tests/i18n.test.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findChrome, launchChrome } from "./chrome.mjs"
import { checker, JSON_TYPE, startCompanion } from "./companion.mjs"
import { scan, ALLOWED } from "./i18n-literals.mjs"
import {
  createTranslator, fill, forgetPluralRules, isPluralMessage, matchLanguage, parseAcceptLanguage, PLURAL_CATEGORIES,
  placeholdersOf, pluralCategory, resolveLanguage
} from "../src/shared/i18n.ts"

const { check, tally } = checker()
const LOCALES = path.resolve("public/locales")
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"))

// ------------------------------------------------------- the locale files

const english = read(path.join(LOCALES, "en.json"))
const englishKeys = Object.keys(english.messages).sort()
check("en.json has messages", englishKeys.length > 500, `${englishKeys.length} keys`)

for (const name of fs.readdirSync(LOCALES).filter((file) => file.endsWith(".json")).sort()) {
  const code = name.slice(0, -5)
  const file = read(path.join(LOCALES, name))
  check(`${name}: meta.name and meta.code (${code})`, typeof file.meta?.name === "string" && file.meta.name.length > 0 && file.meta?.code === code, JSON.stringify(file.meta))
  const keys = Object.keys(file.messages ?? {}).sort()
  const missing = englishKeys.filter((key) => !(key in file.messages))
  const extra = keys.filter((key) => !(key in english.messages))
  check(`${name}: no key missing`, missing.length === 0, missing.slice(0, 20).join(", "))
  check(`${name}: no key en.json lacks`, extra.length === 0, extra.slice(0, 20).join(", "))
  const badPlaceholders = []
  const badShape = []
  const empty = []
  for (const key of englishKeys) {
    if (!(key in file.messages)) continue
    const theirs = file.messages[key]
    const ours = english.messages[key]
    if (JSON.stringify(placeholdersOf(theirs)) !== JSON.stringify(placeholdersOf(ours))) badPlaceholders.push(`${key} (${placeholdersOf(theirs)} vs ${placeholdersOf(ours)})`)
    // A plural in English is a plural everywhere, with "other" and only
    // CLDR's categories (Polish needs "few" and "many"; English does not).
    const shapeOk = typeof ours === "string"
      ? typeof theirs === "string"
      : isPluralMessage(theirs) && Object.keys(theirs).every((category) => PLURAL_CATEGORIES.includes(category) && typeof theirs[category] === "string")
    if (!shapeOk) badShape.push(key)
    const texts = typeof theirs === "string" ? [theirs] : Object.values(theirs ?? {})
    if (texts.some((text) => typeof text !== "string" || !text.trim())) empty.push(key)
  }
  check(`${name}: the same {placeholders} as English, key by key`, badPlaceholders.length === 0, badPlaceholders.slice(0, 10).join("; "))
  check(`${name}: the same plural shape as English`, badShape.length === 0, badShape.slice(0, 10).join(", "))
  check(`${name}: no empty text`, empty.length === 0, empty.slice(0, 10).join(", "))
}

// ------------------------------------------------------- English left over

const left = scan()
check("no interface English left in src/ or the pages", left.length === 0,
  `${left.length} found, e.g.\n${left.slice(0, 25).map((hit) => `    ${hit.file}:${hit.line} ${JSON.stringify(hit.text)}`).join("\n")}\n  (node tests/i18n-literals.mjs lists them; tests/i18n-literals.mjs ALLOWED says what is let through)`)
check("every allowed exception says why", ALLOWED.every((entry) => typeof entry[2] === "string" && entry[2].length > 10), "")

// -------------------------------------------------------------------- t()

const en = { "a.hello": "Hello, {name}.", "a.items": { one: "{count} item", other: "{count} items" }, "a.only": "Only in English" }
const es = { "a.hello": "Hola, {name}.", "a.items": { one: "{count} elemento", other: "{count} elementos" } }
const warned = []
const t = createTranslator("es", es, en, { onMissing: (key) => warned.push(key) })
check("t(): placeholders are filled", t("a.hello", { name: "Ana" }) === "Hola, Ana.", t("a.hello", { name: "Ana" }))
check("t(): one and other", t("a.items", { count: 1 }) === "1 elemento" && t("a.items", { count: 3 }) === "3 elementos" && t("a.items", { count: 0 }) === "0 elementos", `${t("a.items", { count: 1 })} / ${t("a.items", { count: 3 })}`)
check("t(): a key missing in the language falls back to English", t("a.only") === "Only in English", t("a.only"))
check("t(): a key in no file comes back as itself, and is reported", t("a.nowhere") === "a.nowhere" && warned.includes("a.nowhere"), JSON.stringify(warned))
check("fill(): a placeholder without a value stays visible", fill("Hi {name}", {}) === "Hi {name}", fill("Hi {name}", {}))

// Safari 11 and Android 5's Chrome have no Intl.PluralRules.
const PluralRules = Intl.PluralRules
try {
  delete Intl.PluralRules
  forgetPluralRules()
  check("without Intl.PluralRules: 1 is one, the rest other", pluralCategory("es", 1) === "one" && pluralCategory("es", 2) === "other" && pluralCategory("en", 0) === "other", "")
  const old = createTranslator("es", es, en)
  check("without Intl.PluralRules: t() still counts", old("a.items", { count: 1 }) === "1 elemento" && old("a.items", { count: 5 }) === "5 elementos", old("a.items", { count: 5 }))
} finally {
  Intl.PluralRules = PluralRules
  forgetPluralRules()
}
check("with Intl.PluralRules: its categories are used", pluralCategory("pl", 3) === "few", pluralCategory("pl", 3))

check("matchLanguage(): es-CO is served by es", matchLanguage(["es-CO"], ["en", "es"]) === "es", "")
check("matchLanguage(): a regional file serves its base language", matchLanguage(["pt"], ["en", "pt-BR"]) === "pt-BR", "")
check("matchLanguage(): the first language that has a file wins", matchLanguage(["fr-FR", "es-MX", "en"], ["en", "es"]) === "es", "")
check("resolveLanguage(): auto with no match is English", resolveLanguage("auto", ["fr"], ["en", "es"]) === "en", "")
check("resolveLanguage(): a fixed setting beats the browser", resolveLanguage("es", ["en-US"], ["en", "es"]) === "es", "")
check("resolveLanguage(): a setting with no file follows the browser", resolveLanguage("de", ["es"], ["en", "es"]) === "es", "")
check("parseAcceptLanguage(): by weight", JSON.stringify(parseAcceptLanguage("en;q=0.5, es-CO, es;q=0.9")) === JSON.stringify(["es-CO", "es", "en"]), JSON.stringify(parseAcceptLanguage("en;q=0.5, es-CO, es;q=0.9")))

// ------------------------------------------------------------ the companion

// A copy of the locale folder with one more language in it: the repository's
// own folder is never touched.
const localesCopy = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-locales-"))
for (const name of fs.readdirSync(LOCALES)) fs.copyFileSync(path.join(LOCALES, name), path.join(localesCopy, name))
const spanish = read(path.join(LOCALES, "es.json")).messages
fs.writeFileSync(path.join(localesCopy, "eo.json"), JSON.stringify({ meta: { name: "Esperanto (test)", code: "eo" }, messages: { "server.settings.badTheme": "Tiu etoso ne ekzistas." } }))

const OBS_OFF = { address: "ws://127.0.0.1:1", password: "", source: "manual" }
const companion = startCompanion({ config: { supportShown: true, obs: OBS_OFF, language: "es" }, env: { PUNCHBOARD_LOCALES_DIR: localesCopy } })
const { request } = companion
const badTheme = (headers = {}) => request({ method: "PUT", path: "/api/settings", headers: { ...JSON_TYPE, ...headers }, body: JSON.stringify({ theme: "nope" }) })
const setLanguage = (language) => request({ method: "PUT", path: "/api/settings", headers: JSON_TYPE, body: JSON.stringify({ language }) })
try {
  await companion.ready
  let r = await badTheme()
  check("server: an error in Spanish when the setting is es", r.status === 400 && r.json?.error === spanish["server.settings.badTheme"], `${r.status} ${r.text}`)
  r = await badTheme({ "Accept-Language": "en-US" })
  check("server: the setting beats Accept-Language", r.json?.error === spanish["server.settings.badTheme"], r.text)

  r = await setLanguage("auto")
  check("server: the setting can go back to auto", r.status === 200 && r.json?.language === "auto", r.text)
  r = await badTheme({ "Accept-Language": "es-CO,es;q=0.9,en;q=0.8" })
  check("server: under auto, Accept-Language es-CO gets Spanish", r.json?.error === spanish["server.settings.badTheme"], r.text)
  r = await badTheme({ "Accept-Language": "fr-FR" })
  check("server: under auto, a language with no file gets English", r.json?.error === english.messages["server.settings.badTheme"], r.text)
  r = await badTheme()
  check("server: no Accept-Language gets English", r.json?.error === english.messages["server.settings.badTheme"], r.text)

  r = await request({ path: "/api/languages" })
  const codes = (r.json?.languages ?? []).map((language) => language.code)
  check("server: /api/languages lists the files, a dropped-in one too", r.status === 200 && codes[0] === "en" && codes.includes("es") && codes.includes("eo"), r.text)
  check("server: each language comes with its own name", (r.json?.languages ?? []).some((language) => language.code === "es" && language.name === "Español"), r.text)
  r = await request({ path: "/api/hello" })
  check("server: the hello carries the setting and the codes", r.json?.language === "auto" && r.json?.languages?.includes("eo"), r.text)

  r = await setLanguage("eo")
  check("server: the dropped-in language can be chosen", r.status === 200 && r.json?.language === "eo", r.text)
  r = await badTheme()
  check("server: its own text is used", r.json?.error === "Tiu etoso ne ekzistas.", r.text)
  r = await request({ method: "PUT", path: "/api/settings", headers: JSON_TYPE, body: JSON.stringify({ accent: "nope" }) })
  check("server: a key it lacks falls back to English", r.json?.error === english.messages["server.settings.badColour"], r.text)
  r = await setLanguage("xx")
  check("server: a language with no file is refused", r.status === 400, r.text)

  r = await request({ path: "/locales/eo.json" })
  check("server: /locales/ serves the same folder", r.status === 200 && r.json?.meta?.code === "eo", `${r.status}`)
  const etag = r.headers.etag
  r = await request({ path: "/locales/eo.json", headers: { "If-None-Match": etag } })
  check("server: a locale file the browser holds is a 304", Boolean(etag) && r.status === 304 && r.text === "", `${r.status} ${etag}`)
  r = await request({ path: "/locales/..%2Fdeck.html" })
  check("server: /locales/ serves nothing outside its folder", r.status === 403 || r.status === 404, `${r.status}`)
  await setLanguage("auto")
} catch (error) {
  check("server: the language checks ran to the end", false, error.stack)
} finally {
  await companion.stop()
  companion.cleanup()
  fs.rmSync(localesCopy, { recursive: true, force: true })
}

// ------------------------------------------------------------- in Chrome

const KEY_LIKE = /\b(designer|deck|pair|common|server|shared)\.[a-z][A-Za-z0-9]*\.[A-Za-z]/
if (!findChrome()) {
  console.log("SKIP  pages in Spanish: Chrome is not installed (set CHROME_PATH)")
} else {
  const pages = startCompanion({ config: { supportShown: true, obs: OBS_OFF } })
  let chrome = null
  try {
    const port = await pages.ready
    chrome = await launchChrome({ width: 1440, height: 900 })
    const { evaluate, waitFor } = chrome
    const visibleText = () => evaluate(`(() => {
      const bits = [document.body.innerText, document.title]
      for (const el of document.querySelectorAll("[placeholder],[title],[aria-label]")) bits.push(el.getAttribute("placeholder") || "", el.getAttribute("title") || "", el.getAttribute("aria-label") || "")
      return bits.join("\\n")
    })()`)

    await chrome.goto(`http://127.0.0.1:${port}/designer`)
    await waitFor(`document.getElementById("save-text").textContent === ${JSON.stringify(english.messages["designer.save.inSync"])}`, 10000)
    check("Chrome: the Control Center starts in English", await evaluate(`document.documentElement.lang`) === "en", await evaluate(`document.documentElement.lang`))

    // The Appearance dialog's picker, as a person would use it.
    await evaluate(`document.getElementById("appearance-btn").click()`)
    await waitFor(`[...document.getElementById("language-picker").options].some((o) => o.value === "es")`)
    await evaluate(`(() => { const s = document.getElementById("language-picker"); s.value = "es"; s.dispatchEvent(new Event("change")) })()`)
    await waitFor(`document.documentElement.lang === "es"`, 8000)
    await evaluate(`document.getElementById("dlg-appearance").close()`)
    await waitFor(`document.getElementById("save-text").textContent === ${JSON.stringify(spanish["designer.save.inSync"])}`, 8000)
    let text = await visibleText()
    check("Chrome: the Control Center switches to Spanish without a reload", text.includes(spanish["designer.appearance.language"] ?? "Idioma") || text.includes(spanish["designer.save.inSync"]), text.slice(0, 300))
    check("Chrome: no key shows in the Control Center", !KEY_LIKE.test(text), (text.match(KEY_LIKE) ?? [""])[0])
    const fresh = await pages.request({ path: "/api/settings" })
    check("Chrome: the choice is saved", fresh.json?.language === "es", fresh.text)

    await chrome.goto(`http://127.0.0.1:${port}/designer`)
    await waitFor(`document.documentElement.lang === "es" && document.getElementById("save-text").textContent === ${JSON.stringify(spanish["designer.save.inSync"])}`, 10000)
    text = await visibleText()
    check("Chrome: a reloaded Control Center starts in Spanish, keys and all", !KEY_LIKE.test(text), (text.match(KEY_LIKE) ?? [""])[0])

    // The deck on this computer needs no pairing.
    await chrome.setSize(1024, 768, true)
    await chrome.goto(`http://127.0.0.1:${port}/deck`)
    await waitFor(`document.documentElement.lang === "es" && document.querySelectorAll(".tile").length > 0`, 10000)
    text = await visibleText()
    check("Chrome: the deck speaks Spanish", deckSpeaks(text, spanish), text.slice(0, 200))
    check("Chrome: no key shows on the deck", !KEY_LIKE.test(text), (text.match(KEY_LIKE) ?? [""])[0])

    // Back to English from elsewhere: the open deck follows by itself.
    await pages.request({ method: "PUT", path: "/api/settings", headers: JSON_TYPE, body: JSON.stringify({ language: "en" }) })
    await waitFor(`document.documentElement.lang === "en" && document.querySelectorAll(".tile").length > 0`, 10000)
    check("Chrome: an open deck follows a language change", true, "")
    check("Chrome: no page errors", chrome.errors.length === 0, chrome.errors.join("\n"))
  } catch (error) {
    check("Chrome: the language checks ran to the end", false, error.stack)
  } finally {
    if (chrome) await chrome.close()
    await pages.stop()
    pages.cleanup()
  }
}

/** Whether a page's text holds a few Spanish texts that a deck shows. */
function deckSpeaks(text, messages) {
  return ["deck.status.connected", "deck.immersive.enter"].some((key) => messages[key] && text.includes(messages[key]))
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
