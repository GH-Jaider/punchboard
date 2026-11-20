// Fixtures for the Rust port of the companion's base (server/src/{i18n,http,
// store,paths,config,port,net,latest_wins}.rs): the TypeScript is run over
// many inputs and what it answers is written to tests/fixtures/base/*.json
// as arrays of { input, output }. The Rust unit tests read them and must
// answer the same. Nothing here depends on the clock or on chance, so a
// second run writes the same files.
//   node tests/fixtures/make-base.ts        (from the repository's root)
import fs from "node:fs"
import type { ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  createTranslator, fill, matchLanguage, parseAcceptLanguage, placeholdersOf, pluralCategory, resolveLanguage
} from "../../src/shared/i18n.ts"
import type { LocaleFile, Message, Messages, Vars } from "../../src/shared/i18n.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { input: Json; output: Json }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")
const OUT = path.join(HERE, "base")
const LOCALES = path.join(ROOT, "public", "locales")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-fixtures-"))

// The companion's own modules read the environment when they load.
process.env.PUNCHBOARD_LOCALES_DIR = LOCALES
delete process.env.PUNCHBOARD_LOCALE
type ServerI18n = typeof import("../../src/server/i18n.ts")
const serverI18n: ServerI18n = await import("../../src/server/i18n.ts")
const { staticFile } = await import("../../src/server/http.ts")
const { writeJsonAtomic } = await import("../../src/server/store.ts")
const { loadConfig, saveConfig } = await import("../../src/server/config.ts")
const { latestWinsPerKey } = await import("../../src/server/latest-wins.ts")

const counts: Record<string, number> = {}
function write(name: string, cases: Case[]): void {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`)
  counts[name] = cases.length
}

/** The same "random" numbers every run. */
function sequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** A number as its 64 bits, so NaN, -0 and every last digit reach Rust. */
function bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, "0")
}

const readLocale = (code: string): LocaleFile => JSON.parse(fs.readFileSync(path.join(LOCALES, `${code}.json`), "utf8")) as LocaleFile
const localeCodes = fs.readdirSync(LOCALES).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort()
const locales: Record<string, Messages> = {}
for (const code of localeCodes) locales[code] = readLocale(code).messages
const english: Messages = locales.en ?? {}

// ------------------------------------------------------ numbers and JSON

{
  const numbers: number[] = [
    0, -0, 1, -1, 2, 10, 100, 1000, 8787, 0.1, 0.2, 0.3, 0.1 + 0.2, 0.5, 1.5, 0.35, 1 / 3, 2 / 3, 100 / 3,
    1e20, 1e21, 1e22, 1.5e21, 123456789012345680000, 1234567890123456800000, 999999999999999900000, 1e300, 1.7976931348623157e308,
    0.000001, 0.0000001, 0.00000123, 1.5e-7, 1e-10, 5e-324, 2.2250738585072014e-308, 123.456, 1e-6, 1.234e-6, 12345.6789,
    9007199254740991, 9007199254740992, 9007199254740993, 4294967295, 4294967296, 1700000000000, 1700000000123.5,
    NaN, Infinity, -Infinity, -0.1, -1e21, -1e-7, -123.456, 0.30000000000000004, 0.7999999999999999, 4.35, 0.000035, 25e-8
  ]
  const next = sequence(7)
  for (let i = 0; i < 150; i += 1) {
    const mantissa = next() * 10
    const exponent = Math.floor(next() * 60) - 30
    numbers.push(Number(`${mantissa}e${exponent}`), Math.round(next() * 1e6) / 1000)
  }
  write("js-number-to-string.json", numbers.map((value) => ({ input: bits(value), output: String(value) })))

  const texts: string[] = [
    "", " ", "0", "1", "-1", "+1", "1.5", ".5", "5.", "-.5", "+.5", ".", "-", "+", "1e3", "1E3", "1e+3", "1e-3", "1e", "e3", "1.e2", ".e2",
    " 42 ", "\t42\n", "\u00a042\u00a0", "\ufeff7", "4 2", "42px", "0x10", "0X1f", "0x", "0xg", "-0x10", "+0x10", "0o17", "0O7", "0o8", "0b101", "0B1", "0b2",
    "Infinity", "-Infinity", "+Infinity", "infinity", "INFINITY", "Inf", "NaN", "nan", "null", "true", "undefined", "1_000", "1,000", "1.2.3", "--1", "+-1",
    "00012", "012", "0.0", "-0", "-0.0", "1e400", "-1e400", "1e-400", "9007199254740993", "123456789012345678901234567890", "0.1", "0.30000000000000004",
    "8787", "9000", " 9000 ", "abc", "q=0.5", "0.50", "1.", "٣", "１", "1\u2028", "\u20281\u2029", "\u00851", "1e1.5", "0x1p3", "1d", "1f"
  ]
  write("js-string-to-number.json", texts.map((text) => ({ input: text, output: bits(Number(text)) })))

  const values: Json[] = [
    null, true, false, 0, 1, -1, 1.5, 8787, "", " ", "8787", " 9000 ", "0x1F", "1e3", "Infinity", "x", "12px",
    [], [5], ["8080"], [1, 2], [[7]], [null], [""], [[]], [[], []], [" 3 "], [true], ["x"], [1.5], [[[42]]], [null, null],
    {}, { port: 1 }, { valueOf: 3 }, [{}]
  ]
  write("js-value-to-number.json", values.map((value) => ({ input: value, output: bits(Number(value)) })))

  const jsonTexts: string[] = [
    "null", "true", "false", "0", "-0", "-0.0", "1", "1.0", "1.50", "-1", "1e21", "1E21", "1e+21", "1e22", "1e-7", "0.000001", "1.5e-7", "100e-2", "0.1", "0.35",
    "123456789012345678901234567890", "12345678901234567890", "-12345678901234567890", "9007199254740993", "-9007199254740993", "18446744073709551615",
    "9007199254740992", "9223372036854775807", "-9223372036854775808", "1700000000000", "4.35", "0.30000000000000004", "5e-324", "1.7976931348623157e308",
    "\"\"", "\"plain\"", "\"Añadir «botón» 日本語 🎛️\"", "\"quote \\\" slash \\\\ solidus \\/\"", "\"\\b\\f\\n\\r\\t\"", "\"\\u0000\\u0001\\u001f\\u007f\\u0080\\u2028\\u2029\"",
    "\"\\ud83c\\udf9b\"", "\"<script>&'\"",
    "[]", "{}", "[[]]", "[{}]", "{\"a\":[]}", "{\"a\":{}}", "[1,2,3]", "[1,[2,[3,[4]]]]", "[null,true,false,\"x\",1.5]",
    "{\"a\":1}", "{\"b\":1,\"a\":2}", "{\"a\":1,\"a\":2}", "{\"a\":1,\"b\":2,\"a\":3}",
    "{\"b\":1,\"2\":2,\"a\":3,\"1\":4}", "{\"10\":1,\"9\":2,\"01\":3,\"1.5\":4,\"-1\":5,\"0\":6}", "{\"4294967294\":1,\"4294967295\":2,\"4294967296\":3,\"3\":4,\"x\":5}",
    "{\"8\":\"sound-8.wav\",\"1\":\"sound-1.mp3\",\"3\":\"sound-3.wav\"}", "{\"\":1,\" \":2,\"a b\":3,\"ñ\":4,\"\\n\":5}",
    "{\"version\":1,\"devices\":[{\"id\":\"d1\",\"name\":\"iPad de Ana\",\"secret\":\"00ff\",\"pairedAt\":1700000000000,\"lastSeen\":1700000012345}]}",
    "{\"port\":8787,\"theme\":{\"name\":\"studio\",\"accent\":\"#5fd0d6\",\"accentPreset\":\"custom\"},\"soundVolume\":0.35,\"obs\":{\"address\":\"ws://127.0.0.1:4455\",\"password\":\"\",\"source\":\"auto\"},\"supportShown\":false,\"tourShown\":true,\"language\":\"es\"}",
    "{\"profiles\":[{\"id\":\"p1\",\"name\":\"My deck\",\"grid\":{\"cols\":5,\"rows\":3},\"buttons\":[{\"id\":\"b1\",\"label\":\"Mute\",\"steps\":[{\"type\":\"hotkey\",\"keys\":[\"ctrl\",\"m\"]}],\"level\":0.5},{\"id\":\"b2\",\"label\":\"\",\"steps\":[]}]}],\"rev\":12}",
    " { \"spaced\" : [ 1 , 2 ] } ", "{\"deep\":{\"er\":{\"est\":[{\"x\":[[],{}]}]}}}", "[0.1,0.2,0.30000000000000004,1e21,1e-7,-0,100]"
  ]
  write("stringify.json", jsonTexts.map((text) => {
    const value: unknown = JSON.parse(text)
    return { input: text, output: { compact: JSON.stringify(value), pretty: JSON.stringify(value, null, 2) } }
  }))

  const dir = path.join(TMP, "written")
  write("written-files.json", jsonTexts.map((text, index) => {
    const file = path.join(dir, `nested-${index}`, "file.json")
    writeJsonAtomic(file, JSON.parse(text) as unknown)
    return { input: text, output: fs.readFileSync(file, "utf8") }
  }))

  const moments: number[] = [
    0, 1, 999, 1000, 86399999, 86400000, 951782400000, 951868799999, 951868800000, 1078012800000, 1078099199999, 1700000000000, 1700000012345,
    1709164800000, 1709251199999, 1709251200000, 1735689599999, 1735689600000, 1795000000007, 4102444800000, 4107542399999, 7258118400000, 32503679999999
  ]
  for (let year = 1970; year <= 2110; year += 7) moments.push(Date.UTC(year, (year * 5) % 12, 1 + (year % 28), year % 24, year % 60, (year * 7) % 60, year % 1000))
  write("iso-dates.json", moments.map((ms) => ({ input: ms, output: new Date(ms).toISOString() })))
}

// ------------------------------------------------------------- languages

{
  const qualities = ["", ";q=0.5", ";q=1", ";q=0", ";q=.8", ";q=1.5", "; q = 0.3 ", ";q=abc", ";q=0.5;q=0.9", ";level=1;q=0.2", ";q=1.2.3", ";Q=0.5", ";q=", ";q=0.50", ";q=0.0", ";q=00.7", ";q=5."]
  const headers: Array<string | null> = [
    null, "", "*", "en", "es-CO", "en;q=0.5, es-CO, es;q=0.9", "es-CO,es;q=0.9,en;q=0.8", "fr-FR", "en-US", " en , es ", ",,", "en,,es", "*, en;q=0.1",
    "en;q=0.3,*;q=0.9,es;q=0.3", "a;q=0.1,b;q=0.2,c;q=0.3,d;q=0.2,e;q=0.1", "zh-Hant-TW;q=0.7,zh;q=0.9", "en ;q=0.2, es ; q=0.4", "en;q=0.2;es",
    ";q=0.5", "en;;q=0.4,es;q=0.5", "en;q=0.5 ,es", "pt_BR", "EN-us", "en;q=1e1,es", "en;q=-1,es", "en;q=+1,es;q=0.5", "de;q=0.99999,fr;q=0.999999"
  ]
  for (const first of qualities) {
    for (const second of ["", ";q=0.6", ";q=0.5"]) headers.push(`en${first},es${second},pt-BR;q=0.55`)
  }
  write("parse-accept-language.json", headers.map((header) => ({ input: header, output: parseAcceptLanguage(header) })))

  const wantedSingles = ["es", "es-CO", "ES_co", " pt ", "pt", "pt-BR", "pt_PT", "zh-Hant-TW", "zh", "en-US", "fr", "", "de-CH", "EN", "e", "-", "es-", "auto"]
  const availableSets: string[][] = [
    ["en", "es"], ["en", "pt-BR"], ["en", "pt-BR", "pt-PT"], ["en", "es", "pt", "zh-Hant"], [], ["ES", "en"], ["en", "es-MX", "es"], ["en", "es-MX", "es-AR"], ["pt_BR", "en"], ["en", "eo", "es"]
  ]
  const wantedLists: string[][] = wantedSingles.map((code) => [code])
  for (let i = 0; i < wantedSingles.length; i += 1) wantedLists.push([wantedSingles[i]!, wantedSingles[(i * 7 + 3) % wantedSingles.length]!, "en"])
  wantedLists.push([], ["fr-FR", "es-MX", "en"], ["fr", "de", "it"])
  const matches: Case[] = []
  for (const wanted of wantedLists) {
    for (const available of availableSets) matches.push({ input: { wanted, available }, output: matchLanguage(wanted, available) })
  }
  write("match-language.json", matches)

  const settings: Array<string | null> = [null, "", "auto", "es", "de", "pt", "ES", "es-CO", "xx", "en"]
  const preferredLists: string[][] = [[], ["fr"], ["en-US"], ["es"], ["pt-PT", "es"], ["fr-FR", "es-MX", "en"], ["zh-TW"]]
  const resolved: Case[] = []
  for (const setting of settings) {
    for (const preferred of preferredLists) {
      for (const available of [["en", "es"], ["en", "pt-BR"], ["en", "es", "pt", "zh-Hant"], []]) {
        resolved.push({ input: { setting, preferred, available }, output: resolveLanguage(setting, preferred, available) })
      }
    }
  }
  write("resolve-language.json", resolved)
}

// --------------------------------------------------------------- plurals

const PLURAL_CODES = [...new Set([...localeCodes, "en", "es", "fr", "ru", "ar", "pl", "ja", "pt-BR"])]
{
  const numbers: number[] = []
  for (let count = 0; count <= 200; count += 1) numbers.push(count)
  numbers.push(
    0.5, 1.5, 2.5, 0.1, 1.1, 1.01, 1.001, 1.0001, 1.0004, 1.0005, 1.0006, 0.0004, 0.0005, 0.0625, 0.9995, 0.9996, 1.9995, 9.9995, 99.9999, 2.0005,
    1.2345, 10.5, 11.5, 21.1, 100.5, 101.1, 0.001, 0.01, 1.25, 1.999, 3.14159,
    -1, -2, -1.5, -0.5, -5, -11, -21,
    1000, 1001, 1002, 1011, 1111, 10000, 100000, 999999, 1000000, 1000001, 2000000, 3000000, 1500000, 10000000, 100000000, 1e9, 1e12, 1e15, 1e16, 1e17,
    123456789, 123456789012345, 9007199254740991, 999999999999999900
  )
  // Up to 18 digits. Past that Node's ICU reads one number two ways (the last
  // 18 digits for "i", the binary double for "n"), which no rule set written
  // for people does, and no count in Punchboard comes near.
  const cases: Case[] = []
  for (const code of PLURAL_CODES) {
    for (const count of numbers) cases.push({ input: { code, count }, output: pluralCategory(code, count) })
  }
  write("plural-category.json", cases)
}

// ------------------------------------------------------------ formatting

{
  const texts = [
    "", "plain", "Hi {name}", "{a}{b}", "{a} and {a}", "{{a}}", "{a", "a}", "{}", "{a b}", "{é}", "{a_1} {A1} {_}", "{count} of {total}", "{ name }", "{name}}", "{{name}",
    "{toString} {constructor} {hasOwnProperty}", "«{name}» 日本語 {name}", "{a}{", "{a-b}", "{0}", "{{{a}}}", "{a}{b}{c}{d}"
  ]
  const varSets: Array<Vars | null> = [
    null, {}, { name: "Ana" }, { a: "1", b: "2" }, { a: 1, b: 2.5, count: 3, total: 10 }, { name: "$& $1 {name}", a: "{b}", b: "{a}" },
    { a: 1e21, b: 1e-7, count: 0.1 + 0.2, total: -0 }, { name: "", a: "", _: "under", a_1: "x", A1: "y", "0": "zero" }, { count: 1234567.891, total: 100, a: -1.5, b: 0.000001 }
  ]
  const fills: Case[] = []
  for (const text of texts) {
    for (const vars of varSets) fills.push({ input: { text, vars }, output: fill(text, vars ?? undefined) })
  }
  write("fill.json", fills)

  const messages: Message[] = [
    "", "plain", "{b} {a} {b}", "{z}{y}{x}", "{A} {a} {_} {0}", "{{a}} {b c} {d}", { other: "{count} things", one: "{count} thing in {place}" },
    { other: "none", few: "{few}", many: "{many} {few}", zero: "{zero}" }, { other: "" }
  ]
  for (const code of localeCodes) for (const key of Object.keys(locales[code]!)) messages.push(locales[code]![key]!)
  write("placeholders-of.json", messages.map((message) => ({ input: message, output: placeholdersOf(message) })))
}

// ------------------------------------------------------------ translators

/** Values for a message's placeholders: each name as "<name>", and a count. */
function varsFor(message: Message, count: number | string): Vars {
  const vars: Vars = {}
  for (const name of placeholdersOf(message)) vars[name] = `<${name}>`
  vars.count = count
  return vars
}

{
  const cases: Case[] = []
  const keys = Object.keys(english)
  const translate = (code: string, key: string, vars: Vars | null): void => {
    const t = createTranslator(code, locales[code] ?? {}, english)
    cases.push({ input: { code, key, vars }, output: t(key, vars ?? undefined) })
  }
  for (const code of [...localeCodes, "fr"]) {
    keys.forEach((key, index) => {
      // A language with no file answers in English: a tenth of the keys shows it.
      if (code === "fr" && index % 10 !== 0 && typeof english[key] === "string") return
      const message = english[key]!
      translate(code, key, null)
      if (typeof message === "string") {
        if (placeholdersOf(message).length) translate(code, key, varsFor(message, 3))
      } else {
        for (const count of [0, 1, 2, 5, 21, 1.5, "1", "7"]) translate(code, key, varsFor(message, count))
      }
    })
    for (const key of ["nowhere.at.all", "", "server", "toString", "server.request.notFound.more"]) translate(code, key, { count: 1 })
  }
  write("translator-real.json", cases)

  const fallback: Messages = {
    "a.hello": "Hello, {name}.",
    "a.items": { one: "{count} item", other: "{count} items" },
    "a.only": "Only in English ({count})",
    "a.onlyPlural": { one: "one only", other: "{count} only" }
  }
  const everyForm: Messages = {
    "a.hello": "[{name}]",
    "a.items": { zero: "zero:{count}", one: "one:{count}", two: "two:{count}", few: "few:{count}", many: "many:{count}", other: "other:{count}" },
    "a.some": { one: "one:{count}", few: "few:{count}", other: "other:{count}" }
  }
  const madeUp: Case[] = []
  const counted: Array<number | string> = [0, 1, 2, 3, 4, 5, 10, 11, 12, 21, 22, 25, 100, 101, 102, 1.5, 1000000, "1", "2", "x", "", " 3 "]
  for (const code of PLURAL_CODES) {
    const run = (key: string, vars: Vars | null): void => {
      const missing: string[] = []
      const t = createTranslator(code, everyForm, fallback, { onMissing: (missed) => missing.push(missed) })
      const text = t(key, vars ?? undefined)
      madeUp.push({ input: { code, messages: everyForm, fallback, key, vars }, output: { text, missing } })
    }
    for (const count of counted) {
      run("a.items", { count })
      run("a.some", { count })
      run("a.onlyPlural", { count })
    }
    run("a.items", null)
    run("a.items", {})
    run("a.items", { name: "no count" })
    run("a.hello", { name: "Ana" })
    run("a.hello", null)
    run("a.only", { count: 2 })
    run("a.nowhere", { count: 2 })
    run("a.nowhere", null)
  }
  write("translator-made-up.json", madeUp)
}

// ------------------------------------------------ the companion's languages

type Text = import("../../src/server/i18n.ts").Text
type Said = import("../../src/server/i18n.ts").Said

/** A Text as plain data. */
function textJson(said: Said): Json {
  if (typeof said === "string") return said
  if (!said.vars) return { key: said.key }
  const vars: { [name: string]: Json } = {}
  for (const name of Object.keys(said.vars)) {
    const value = said.vars[name]!
    vars[name] = typeof value === "object" ? textJson(value) : value
  }
  return { key: said.key, vars }
}

{
  const { say, render, isLanguageSetting, languageFor, useLanguageSetting } = serverI18n
  const keys = Object.keys(english)
  const withPlaceholders = keys.filter((key) => placeholdersOf(english[key]!).length > 0)
  const plain = keys.filter((key) => typeof english[key] === "string" && placeholdersOf(english[key]!).length === 0)
  const saids: Said[] = ["", "plain text from OBS", "{not} a {placeholder}", say("nowhere.at.all"), say("nowhere.at.all", { count: 2 })]
  withPlaceholders.forEach((key, index) => {
    const message = english[key]!
    const names = placeholdersOf(message)
    const flat: Record<string, string | number | Text> = {}
    const nested: Record<string, string | number | Text> = {}
    names.forEach((name, at) => {
      flat[name] = name === "count" ? (index % 4) + at : `«${name}»`
      // A reason inside a sentence: another message, itself with a value in it.
      const inner = withPlaceholders[(index * 3 + at + 1) % withPlaceholders.length]!
      const innerVars: Record<string, string | number | Text> = {}
      for (const innerName of placeholdersOf(english[inner]!)) innerVars[innerName] = innerName === "count" ? index % 3 : say(plain[(index + at) % plain.length]!)
      nested[name] = name === "count" ? 1 : say(inner, innerVars)
    })
    saids.push(say(key), say(key, flat))
    if (index % 2 === 0) saids.push(say(key, nested))
  })
  const rendered: Case[] = []
  for (const said of saids) {
    for (const code of ["en", "es", "eo", "es-CO"]) rendered.push({ input: { said: textJson(said), code }, output: render(said, code) })
  }
  write("render.json", rendered)

  const candidates: Json[] = [
    "auto", "en", "es", "EN", "Es", "es-CO", "es_CO", "fr", "", " ", "auto ", "AUTO", " en", "en ", "eo", "xx", "english",
    null, 0, 1, 5, true, false, [], ["en"], {}, { code: "en" }, "meta", "messages"
  ]
  write("is-language-setting.json", candidates.map((value) => ({ input: value, output: isLanguageSetting(value) })))

  const headers: Array<string | null> = [
    null, "", "en", "es", "es-CO", "es-CO,es;q=0.9,en;q=0.8", "fr-FR", "en-US", "fr,es;q=0.5", "fr;q=0.9,en;q=0.1,es;q=0.5", "pt-BR,pt;q=0.9", "*", "ES", "es_MX", "de, es-AR;q=0.2", "en;q=0, es"
  ]
  const forRequests: Case[] = []
  for (const setting of ["auto", "es", "en", "de", "", "es-CO", "ES"]) {
    useLanguageSetting(() => setting)
    for (const header of headers) {
      const requestHeaders: Record<string, string | undefined> = header === null ? {} : { "accept-language": header }
      forRequests.push({ input: { setting, header }, output: languageFor({ headers: requestHeaders }) })
    }
  }
  useLanguageSetting(() => "auto")
  write("language-for.json", forRequests)
}

{
  // Each folder gets a module of its own: the folder is read when it loads.
  const file = (name: string, code: string, messages: Messages = {}): string => JSON.stringify({ meta: { name, code }, messages })
  const folders: Array<Record<string, string>> = [
    {},
    { "en.json": file("English", "en") },
    { "es.json": file("Español", "es"), "en.json": file("English", "en"), "eo.json": file("Esperanto (test)", "eo") },
    {
      "zu.json": file("Zulu", "zu"), "en.json": file("English", "en"), "de.json": file("Deutsch", "de"), "da.json": file("Dansk", "da"), "es.json": file("Español", "es"),
      "eo.json": file("Esperanto", "eo"), "fr.json": file("Français", "fr"), "it.json": file("italiano", "it"), "pt-BR.json": file("Português (Brasil)", "pt-BR"),
      "pt.json": file("Português", "pt"), "nl.json": file("Nederlands", "nl"), "pl.json": file("Polski", "pl"), "tr.json": file("Türkçe", "tr")
    },
    {
      "en.json": file("English", "wrong-code"), "broken.json": "{", "de.json": "{ not json", "fr.json": JSON.stringify({ meta: { name: "Français" }, messages: {} }),
      "it.json": JSON.stringify({ meta: { name: "Italiano", code: "it" }, messages: [] }), "english.json": file("Too long a name", "english"), "x.json": file("Too short", "x"),
      "pt-BR.json": file("Português (Brasil)", "pt"), "es_CO.json": file("Underscore", "es_CO"), "notes.txt": "hello", "nl.JSON": file("Upper ending", "nl"), "sv.json": file("Svenska", "sv")
    },
    { "es.json": file("Español", "es"), "fr.json": file("Français", "fr") },
    { "en.json": file("Zzz English is first whatever its name", "en"), "aa.json": file("Aaa", "aa"), "ab.json": file("aab", "ab"), "ac.json": file("AAC", "ac") }
  ]
  const cases: Case[] = []
  for (const [index, folder] of folders.entries()) {
    const dir = path.join(TMP, `locales-${index}`)
    fs.mkdirSync(dir, { recursive: true })
    for (const name of Object.keys(folder)) fs.writeFileSync(path.join(dir, name), folder[name]!)
    process.env.PUNCHBOARD_LOCALES_DIR = dir
    const quiet = console.log
    console.log = () => { /* "Skipped the language file…" is expected here */ }
    try {
      const fresh: unknown = await import(`${pathToFileURL(path.join(ROOT, "src/server/i18n.ts")).href}?folder=${index}`)
      const module = fresh as ServerI18n
      cases.push({ input: folder, output: { languages: module.languages().map((language) => ({ code: language.code, name: language.name })), codes: module.languageCodes() } })
    } finally {
      console.log = quiet
    }
  }
  process.env.PUNCHBOARD_LOCALES_DIR = LOCALES
  write("languages.json", cases)
}

// ------------------------------------------------------------------ ETags

{
  interface Reply { status: number; headers: Record<string, string | number> }
  /** What staticFile answers for a file, through a stand-in for the response. */
  const serve = (file: string): Promise<Reply> => new Promise((resolve) => {
    const reply: Reply = { status: 0, headers: {} }
    const stand = {
      writeHead(status: number, headers: Record<string, string | number>): void {
        reply.status = status
        reply.headers = headers
      },
      end(): void { resolve(reply) }
    }
    staticFile(stand as unknown as ServerResponse, file)
  })
  const dir = path.join(TMP, "etags")
  fs.mkdirSync(dir, { recursive: true })
  const next = sequence(11)
  const sizes = [0, 1, 2, 35, 36, 37, 1295, 1296, 4096, 46655, 46656, 100000]
  const fractions = [0, 0.25, 0.5, 0.75, 0.499, 0.501, 0.001, 0.999]
  const cases: Case[] = []
  for (let i = 0; i < 72; i += 1) {
    const size = sizes[i % sizes.length]! + (i >= sizes.length ? Math.floor(next() * 5000) : 0)
    // Whole seconds, and moments inside a millisecond, since 2001.
    const millis = 1000000000000 + Math.floor(next() * 800000000000) + (i % 9 === 0 ? 0 : fractions[i % fractions.length]!)
    const file = path.join(dir, `file-${i}.bin`)
    fs.writeFileSync(file, Buffer.alloc(size, 120))
    fs.utimesSync(file, millis / 1000, i % 9 === 0 ? Math.floor(millis / 1000) : millis / 1000)
    const stats = fs.statSync(file)
    const reply = await serve(file)
    cases.push({ input: { size: stats.size, mtimeMs: stats.mtimeMs }, output: String(reply.headers.ETag) })
  }
  write("etag.json", cases)
}

// ----------------------------------------------------------------- config

{
  const valid = {
    port: 9100,
    theme: { name: "hardware", accent: "#AB12ef", accentPreset: "teal" },
    soundVolume: 0.35,
    obs: { address: "ws://192.168.1.5:4455", password: "secret", source: "manual" },
    supportShown: true,
    tourShown: true,
    language: "es"
  }
  type Raw = { [key: string]: Json }
  const copy = (): Raw => JSON.parse(JSON.stringify(valid)) as Raw
  const FIELDS: string[][] = [
    ["port"], ["theme"], ["theme", "name"], ["theme", "accent"], ["theme", "accentPreset"], ["soundVolume"], ["obs"], ["obs", "address"], ["obs", "password"], ["obs", "source"],
    ["supportShown"], ["tourShown"], ["language"]
  ]
  const WRONG: Json[] = [
    null, true, false, 0, 1, -1, 0.5, 2, 65536, 1e21, 8080.5, "", " ", "x", "9000", " 9000 ", "0x1F", "1e3", "Infinity", "auto", "manual", "Auto",
    "#ABCDEF", "#abcdeg", "#abc", "abcdef", "studio", "hardware-dark", "broadcast", "Studio", "pt-BR", "es_CO", "engl", "zh-Hant-TW", "  ws://host:1  ", "\u00a0ws://nbsp\ufeff",
    [], [9001], ["9002"], [1, 2], {}, { name: "broadcast" }, { password: "typed long ago" }, { address: 5, password: 5, source: 5 }
  ]
  const texts: Array<string | null> = [
    null, "", " ", "{", "{ this is not json", "[]", "[1]", "null", "5", "\"text\"", "true", "{}", JSON.stringify(valid), JSON.stringify(valid, null, 2),
    JSON.stringify({ ...valid, extra: 1, nested: { more: [1, 2] } }), JSON.stringify({ unknown: true }), JSON.stringify({ obs: { password: "typed long ago" } }),
    JSON.stringify({ obs: { password: "typed long ago", source: "auto" } }), JSON.stringify({ obs: { source: "manual" } }), JSON.stringify({ obs: { password: "", source: "other" } }),
    JSON.stringify({ soundVolume: -0 }), "{\"soundVolume\": -0.0}", "{\"soundVolume\": 1.0000001}", "{\"soundVolume\": 0.30000000000000004}", "{\"port\": 8787.0}", "{\"port\": 1e3}",
    "{\"port\": 9000, \"port\": 9001}", "{\"theme\": {\"name\": \"hardware\"}, \"theme\": {\"accent\": \"#000000\"}}", "\ufeff{}"
  ]
  const set = (raw: Raw, field: string[], value: Json | undefined): void => {
    let target: Raw = raw
    for (const name of field.slice(0, -1)) target = target[name] as Raw
    const last = field[field.length - 1]!
    if (value === undefined) delete target[last]
    else target[last] = value
  }
  for (const field of FIELDS) {
    const missing = copy()
    set(missing, field, undefined)
    texts.push(JSON.stringify(missing))
    for (const wrong of WRONG) {
      const raw = copy()
      set(raw, field, wrong)
      texts.push(JSON.stringify(raw))
    }
  }
  const cases: Case[] = []
  texts.forEach((text, index) => {
    const dir = path.join(TMP, `config-${index}`)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "config.json")
    if (text !== null) fs.writeFileSync(file, text)
    let logged = 0
    const config = loadConfig(file, () => { logged += 1 })
    const saved = path.join(dir, "saved.json")
    saveConfig(saved, config)
    // Through JSON, as it goes to disk: an endless port is written as null.
    cases.push({ input: text, output: { config: JSON.parse(JSON.stringify(config)) as Json, logged, saved: fs.readFileSync(saved, "utf8") } })
  })
  write("config.json", cases)
}

// ------------------------------------------------------------ latest wins

{
  interface Call { at: number; key: string; level: number }
  interface Scenario { durationMs: number; failLevels: number[]; calls: Call[] }
  type Result = { ok: number } | { error: string }

  /** Runs a scenario on a clock of its own: nothing waits for real time. */
  async function play(scenario: Scenario): Promise<Json> {
    let now = 0
    const timers: Array<{ at: number; fire: () => void }> = []
    const wait = (ms: number): Promise<void> => new Promise((resolve) => { timers.push({ at: now + ms, fire: resolve }) })
    const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })
    const writes: { [key: string]: string[] } = {}
    const set = latestWinsPerKey(async (key: string, level: number): Promise<number> => {
      (writes[key] ??= []).push(String(level))
      await wait(scenario.durationMs)
      if (scenario.failLevels.includes(level)) throw new Error(`fail ${level}`)
      return level * 2
    })
    const results: Result[] = []
    const pending = scenario.calls.map((call, index) => ({ call, index })).sort((a, b) => a.call.at - b.call.at)
    while (pending.length || timers.length) {
      timers.sort((a, b) => a.at - b.at)
      const timerAt = timers.length ? timers[0]!.at : Infinity
      const callAt = pending.length ? pending[0]!.call.at : Infinity
      if (timerAt === callAt) throw new Error(`A write ends just as a call arrives at ${callAt}: which goes first would be chance.`)
      if (timerAt < callAt) {
        now = timerAt
        timers.shift()!.fire()
      } else {
        now = callAt
        const { call, index } = pending.shift()!
        set(call.key, call.level).then(
          (value) => { results[index] = { ok: value } },
          (error: unknown) => { results[index] = { error: error instanceof Error ? error.message : String(error) } }
        )
      }
      await settle()
    }
    return { writes, results }
  }

  const scenarios: Scenario[] = [
    // tests/sounds.test.mjs and tests/app-volume.test.mjs, as data.
    { durationMs: 37, failLevels: [], calls: [0.1, 0.2, 0.3, 0.4].map((level, i) => ({ at: i * 10, key: "volume", level })) },
    {
      durationMs: 37,
      failLevels: [],
      calls: [["chrome", 0.1], ["chrome", 0.2], ["spotify", 0.7], ["chrome", 0.3], ["chrome", 0.4], ["spotify", 0.8]].map((entry, i) => ({ at: i * 10, key: String(entry[0]), level: Number(entry[1]) }))
    },
    { durationMs: 7, failLevels: [], calls: [{ at: 0, key: "a", level: 0.25 }] },
    { durationMs: 7, failLevels: [0.25], calls: [{ at: 0, key: "a", level: 0.25 }, { at: 10, key: "a", level: 0.5 }] },
    { durationMs: 37, failLevels: [0.1], calls: [0.1, 0.2, 0.3].map((level, i) => ({ at: i * 10, key: "a", level })) },
    { durationMs: 37, failLevels: [0.3], calls: [0.1, 0.2, 0.3, 0.4].map((level, i) => ({ at: i * 10, key: "a", level })) }
  ]
  const next = sequence(23)
  const KEYS = ["chrome", "spotify", "music"]
  for (let i = 0; i < 60; i += 1) {
    const durationMs = [7, 13, 37, 53][i % 4]!
    const callCount = 2 + Math.floor(next() * 7)
    const keyCount = 1 + (i % 3)
    const calls: Call[] = []
    let at = 0
    for (let c = 0; c < callCount; c += 1) {
      // Calls land on tens; a write lasts an odd number, so none ends on one.
      at += 10 * (1 + Math.floor(next() * (i % 5 === 0 ? 8 : 3)))
      calls.push({ at, key: KEYS[Math.floor(next() * keyCount)]!, level: Math.round(next() * 100) / 100 })
    }
    const failLevels = i % 6 === 0 ? [calls[Math.floor(next() * calls.length)]!.level] : []
    scenarios.push({ durationMs, failLevels, calls })
  }
  const cases: Case[] = []
  for (const scenario of scenarios) cases.push({ input: scenario as unknown as Json, output: await play(scenario) })
  write("latest-wins.json", cases)
}

fs.rmSync(TMP, { recursive: true, force: true })
for (const name of Object.keys(counts).sort()) console.log(`${String(counts[name]).padStart(6)}  ${name}`)
console.log(`${String(Object.values(counts).reduce((sum, count) => sum + count, 0)).padStart(6)}  cases in ${path.relative(ROOT, OUT)}`)
