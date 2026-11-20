// Writes the live files of tests/fixtures/base: what JavaScript itself and
// the code shared with the browser (src/shared/i18n.ts) answer over many
// inputs, as arrays of { input, output }: how numbers and JSON are printed
// and read, dates, Accept-Language, matching and resolving a language,
// plural categories, placeholders and the translators over the real locale
// files. The Rust companion's copies (server/src/{model/js,store,i18n}.rs)
// read them in their tests and must answer the same. The folder's other
// files are frozen records of the Node companion (tests/fixtures/README.md)
// and are left as they are. Nothing here depends on the clock or on chance,
// so a second run writes the same files.
//   node tests/fixtures/make-base.ts        (npm run fixtures runs them all)
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
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
    // biome-ignore lint/correctness/noPrecisionLoss: numbers JavaScript cannot hold exactly are the point of this case
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

for (const name of Object.keys(counts).sort()) console.log(`${String(counts[name]).padStart(6)}  ${name}`)
console.log(`${String(Object.values(counts).reduce((sum, count) => sum + count, 0)).padStart(6)}  cases in ${path.relative(ROOT, OUT)}`)
