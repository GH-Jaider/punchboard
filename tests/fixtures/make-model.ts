// Writes tests/fixtures/model/*.json: what the TypeScript deck model
// (src/shared) answers for many inputs. The Rust companion's copy of the
// model (server/src/model) reads these files in its tests and must give the
// same answers, which is what proves a deck file reads the same in both.
//   node tests/fixtures/make-model.ts
//
// Each file is a list of { input, output }. A case that makes new ids also
// says where the clock and the id counter stood ("ids"), so Rust can start
// from the same place. Running this twice writes the same files.
import fs from "node:fs"
import path from "node:path"
import { mock } from "node:test"
import {
  ACTION_FIELDS, ACTION_GROUPS, ACTION_META, ACTION_TYPES, actionGroupLabel, FADER_TARGETS, isActionType, isFaderTarget, isMediaKey,
  isSetMode, LIMITS, MEDIA_KEYS, nameDecksWith, SET_LABELS, SET_MODES, setModeOf, STATEFUL_ACTIONS, stepSummary, stepText
} from "../../src/shared/actions.ts"
import {
  BUTTON_COLORS, colorValue, contrastRatio, DARK_INK, isButtonColor, isButtonColorId, isHexColor, isVeryDark, LIGHT_INK, mixHex, parseHex,
  readableInk, withAlpha
} from "../../src/shared/colors.ts"
import { DEFAULT_FADER_GLYPH, DEFAULT_PRESS_GLYPH } from "../../src/shared/default-glyphs.ts"
import { createTranslator, isLocaleFile, setTranslator } from "../../src/shared/i18n.ts"
import type { Messages, Translate } from "../../src/shared/i18n.ts"
import { DEFAULT_ICON, glyphSvg, ICON_GROUPS, iconMarkup, ICONS, iconSvg, isIconId, isSafeIconData, safeGlyph } from "../../src/shared/icons.ts"
import {
  comboFromEvent, comboToString, formatCombo, KEY_NAMES, keyPlatform, modifierLabel, MODIFIERS, parseCombo, unsendableReason
} from "../../src/shared/keys.ts"
import type { KeyPlatform } from "../../src/shared/keys.ts"
import { layoutGrid, MAX_ASPECT, TILE_MIN, TOUCH_MIN } from "../../src/shared/layout.ts"
import { SUPPORT_URL, webAddress } from "../../src/shared/links.ts"
import {
  APP_KEY_MAX, appDisplayName, buttonStateKey, clampDelay, createEmptyButton, createEmptyProfile, createStep, DEFAULT_TRACKPAD,
  faderLevelKey, isConfigured, isLibraryShape, isStateful, isSwitch, makeStep, nextId, normalizeAppKey, normalizeButton, normalizeLibrary,
  normalizeStep, normalizeTrackpad, parkedButtons, retypeStep, shownProfiles, soundSlotOf, stateKeyOf, TRACKPAD_SPEED, withControl
} from "../../src/shared/model.ts"
import { STARTER_IDS, starterDeck, starterLibrary, STARTERS } from "../../src/shared/starter-decks.ts"
import { STARTER_GLYPHS } from "../../src/shared/starter-glyphs.ts"
import { DEFAULT_THEME, isDarkVariant, isThemeId, themeById, themeFamily, THEMES } from "../../src/shared/themes.ts"
import type { ActionType, Button, Library, Step, StepTextField } from "../../src/shared/types.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Fields = { [key: string]: Json }
interface Case { input: Json; output: unknown; [extra: string]: unknown }

const ROOT = path.resolve(import.meta.dirname, "../..")
const OUT = path.join(ROOT, "tests/fixtures/model")

// ------------------------------------------------------------ a fixed world

/** The moment every case happens at, so ids and dates repeat. */
const NOW = 1750000000000
mock.timers.enable({ apis: ["Date"], now: NOW })

/** How many ids have been made. Asking makes one, which is counted. */
const idsMade = (): number => Number(nextId("probe").split("_")[2])

/** Where the clock and the counter stand, for a case that makes ids. */
const idsNow = (): { now: number; counter: number } => ({ now: Date.now(), counter: idsMade() })

type Words = "echo" | "en" | "es"

/** A translator Rust can copy without any file: the key, then each value. */
const echo: Translate = (key, vars) => key + Object.keys(vars ?? {}).map((name) => `|${name}=${String((vars ?? {})[name])}`).join("")

function readMessages(code: string): Messages {
  const file: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, "public/locales", `${code}.json`), "utf8"))
  if (!isLocaleFile(file)) throw new Error(`${code}.json is not a locale file`)
  return file.messages
}

const english = readMessages("en")
const TRANSLATORS: Record<Words, Translate> = {
  echo,
  en: createTranslator("en", english, english),
  es: createTranslator("es", readMessages("es"), english)
}

setTranslator("en", echo)

/** Runs `work` with other words, then goes back to the echo. */
function inWords<T>(words: Words, work: () => T): T {
  setTranslator(words === "echo" ? "en" : words, TRANSLATORS[words])
  try {
    return work()
  } finally {
    setTranslator("en", echo)
  }
}

/** The page's platform, as isMacLike() reads it. */
function onPlatform<T>(platform: string, work: () => T): T {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", { value: { platform }, configurable: true })
  try {
    return work()
  } finally {
    if (before) Object.defineProperty(globalThis, "navigator", before)
  }
}

const isFields = (value: Json): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value)

/** The buttons of every deck in a library written as plain JSON. */
function buttonsOf(library: Json): Json[] {
  const profiles = isFields(library) && Array.isArray(library.profiles) ? library.profiles : []
  return profiles.flatMap((profile) => (isFields(profile) && Array.isArray(profile.buttons) ? profile.buttons : []))
}

/** A value as Rust will read it from the file: through JSON. */
const viaJson = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json

/** Numbers that repeat on every run, where "any number" is wanted. */
function sequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const written: Array<[string, number]> = []

function write(name: string, cases: Case[]): void {
  const text = `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`
  // A character JavaScript cut in half cannot be read by Rust at all.
  if (/\\ud[89a-f][0-9a-f]{2}/i.test(text.replace(/\\\\/g, ""))) throw new Error(`${name} holds half a character`)
  fs.writeFileSync(path.join(OUT, name), text)
  written.push([name, cases.length])
}

/** One file with a single case: a table or a few constants. */
const writeTable = (name: string, output: unknown): void => write(name, [{ input: null, output }])

/** Leaves out what was already seen, by its JSON. */
function unique<T>(values: T[]): T[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const text = JSON.stringify(value)
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
}

// ------------------------------------------------------------- odd values

/** What a hand-edited file or a hostile request can hold in any field. */
const ODD: Json[] = [
  null, true, false,
  0, 1, -1, 2, 3, 3.7, -0.5, 0.5, 8, 8.9, 9, 12.5, 100, 59999.5, 60000, 60001, 1e21, 1e300, -1e300, 5e-324, 1e-7, 9007199254740992, 18446744073709552000,
  "", " ", "0", "1", "2.5", " 3 ", "\t7\n", "0x10", "0X1f", "0b11", "0o17", "0x", "1e3", "1E-2", "Infinity", "-Infinity", "+Infinity", "infinity", "inf",
  "NaN", "nan", "abc", "1,2", ".5", "5.", ".", "+5", "-5", "--5", "1_000", "12px", "１２", "true", "null",
  "constructor", "__proto__", "toString", "hasOwnProperty",
  "on", "off", "toggle", "press", "fader", "keys",
  "Ünïcödé ñ 日本語", "emoji 😀 here", " nbsp﻿", "KK İ ǅ ſ", "x".repeat(200),
  [], [5], ["7"], [1, 2], [[3]], [null], [true], [""], [{}],
  {}, { a: 1 }, { type: "none" }, { length: 2 }
]

const ODD_STRINGS: string[] = ODD.filter((value): value is string => typeof value === "string")

/** `base` with one field replaced by each odd value, and once without it. */
function mutations(base: Fields, field: string, values: Json[] = ODD): Fields[] {
  const out: Fields[] = values.map((value) => ({ ...base, [field]: value }))
  const without = { ...base }
  delete without[field]
  out.push(without)
  return out
}

/** `base` with the object under `key` mutated the same way. */
function nested(base: Fields, key: string, inner: Fields, field: string, values: Json[] = ODD): Fields[] {
  return mutations(inner, field, values).map((changed) => ({ ...base, [key]: changed }))
}

// ------------------------------------------------------------------ steps

const STEP_FIELDS: Record<ActionType, string[]> = {
  obs_scene: ["sceneName"],
  obs_toggle_source: ["sceneName", "sourceName", "set"],
  obs_toggle_mute: ["sourceName", "set"],
  obs_start_stop_stream: ["set"],
  obs_toggle_record: ["set"],
  obs_toggle_filter: ["sourceName", "filterName", "set"],
  obs_toggle_virtualcam: ["set"],
  obs_save_replay: [],
  obs_studio_transition: [],
  open_url: ["url"],
  launch_app: ["appPath", "appName"],
  play_sound: ["soundId"],
  hotkey: ["keys"],
  media_key: ["mediaKey"],
  stop_sounds: [],
  browser_tile: ["url"],
  go_to_deck: ["profileId"],
  none: []
}

/** Every field any step can carry, filled in, with two that are never kept. */
const FULL_STEP: Fields = {
  id: "s1", delayMs: 250, sceneName: "Main", sourceName: "Camera", filterName: "Blur", set: "on", url: "twitch.tv/x",
  appPath: "/Applications/OBS.app", appName: "OBS", soundId: 3, keys: "shift+ctrl+k", mediaKey: "next", profileId: "music",
  open: true, extra: { kept: false }
}

const COMBOS: string[] = [
  "k", "ctrl+k", "Shift + CTRL+K", "meta+shift+alt+ctrl+f24", "ctrl+nope", "ctrl+ctrl+k", "ctrl+", "+k", "k+", "ctrl++k", "ctrl+shift", "", "+",
  " enter ", "ALT+PageUp", "ctrl+k+j", "cmd+k", "ctrl + alt + delete", "f25", "f0", "shift+1", "shift+meta+4", "meta+c", "ctrl+y", "ctrl+backslash"
]

function stepInputs(): Json[] {
  const inputs: Json[] = [...ODD]
  ACTION_TYPES.forEach((type, at) => {
    const full: Fields = { ...FULL_STEP, type }
    inputs.push(full, { type }, { id: `only_${type}`, type, delayMs: 0 })
    for (const field of STEP_FIELDS[type]) inputs.push(...mutations(full, field))
    for (const set of [...SET_MODES, "ON", "", null]) inputs.push({ id: "s", type, delayMs: 0, sourceName: "Mic", sceneName: "Main", filterName: "Blur", set })
    // The fields every step has take every odd value on a different action each time.
    if (at === 0) {
      ODD.forEach((value, n) => {
        const other = ACTION_TYPES[n % ACTION_TYPES.length]!
        inputs.push({ ...FULL_STEP, type: other, id: value }, { ...FULL_STEP, type: other, delayMs: value }, { ...FULL_STEP, type: value })
      })
    }
  })
  for (const type of ["OBS_SCENE", "obs_scene ", "obs", "browser_tile", "go_to_deck", "valueOf"]) inputs.push({ ...FULL_STEP, type })
  for (let delay = -500; delay <= 61000; delay += 1537.25) inputs.push({ id: "d", type: "none", delayMs: delay })
  for (let sound = -1; sound <= 10; sound += 0.25) inputs.push({ id: "p", type: "play_sound", delayMs: 0, soundId: sound }, { id: "p", type: "play_sound", delayMs: 0, soundId: String(sound) })
  for (const keys of COMBOS) inputs.push({ id: "h", type: "hotkey", delayMs: 0, keys })
  for (const name of KEY_NAMES) inputs.push({ id: "h", type: "hotkey", delayMs: 0, keys: `Meta+SHIFT+${name.toUpperCase()}` })
  for (const mediaKey of ["play_pause", "next", "previous", "PLAY", "stop", ""]) inputs.push({ id: "m", type: "media_key", delayMs: 0, mediaKey })
  for (const profileId of ["music", "empty", "other", ""]) inputs.push({ id: "g", type: "go_to_deck", delayMs: 0, profileId })
  for (const [filterName, sourceName] of [["Blur", "Camera"], ["Blur", ""], ["", "Camera"], ["", ""]]) {
    inputs.push({ id: "f", type: "obs_toggle_filter", delayMs: 0, filterName: filterName!, sourceName: sourceName! }, { id: "f", type: "obs_toggle_source", delayMs: 0, sceneName: filterName!, sourceName: sourceName! })
  }
  for (const [appName, appPath] of [["OBS", "/a/OBS.app"], ["", "/a/OBS.app"], ["OBS", ""], ["", ""]]) inputs.push({ id: "l", type: "launch_app", delayMs: 0, appName: appName!, appPath: appPath! })
  return unique(inputs.map(viaJson))
}

const normalizedSteps: Step[] = []

function steps(): void {
  write("model-normalizeStep.json", stepInputs().map((input) => {
    const ids = idsNow()
    const step = normalizeStep(input)
    normalizedSteps.push(step)
    const delay = isFields(input) ? clampDelay(input.delayMs) : clampDelay(undefined)
    return { input, ids, output: { step, delay } }
  }))

  const fieldSets: Fields[] = [
    {}, FULL_STEP, { id: "", delayMs: -5 }, { id: "kept", delayMs: 60001, set: "off" }, { id: 7, delayMs: "250", set: "toggle" },
    { delayMs: 12.5, soundId: 8.9, keys: "Shift + CTRL+K", mediaKey: "previous" }, { soundId: "4", keys: 5, mediaKey: 3, url: 9, sceneName: null },
    { id: "x", sceneName: "", sourceName: "", filterName: "", url: "", appPath: "", appName: "", profileId: "" },
    { id: "y", delayMs: null, set: "ON", soundId: 0, keys: "ctrl+nope", mediaKey: "stop" }, { id: "z", delayMs: [300], soundId: [2], set: ["on"] },
    ...ODD.slice(0, 12).map((value): Fields => ({ id: value, delayMs: value, set: value, soundId: value }))
  ]
  const made: Case[] = []
  ACTION_TYPES.forEach((type, typeAt) => {
    fieldSets.forEach((raw, setAt) => {
      const fields = viaJson(raw)
      if (!isFields(fields)) throw new Error("a field set is an object")
      const ids = idsNow()
      const step = makeStep(type, fields)
      // To every action for the first sets, to two others for the rest.
      const others = setAt < 3 ? ACTION_TYPES : [ACTION_TYPES[(typeAt + setAt) % ACTION_TYPES.length]!, ACTION_TYPES[(typeAt * 7 + setAt * 3 + 1) % ACTION_TYPES.length]!]
      const retyped: Record<string, Step> = {}
      for (const other of others) retyped[other] = retypeStep(step, other)
      made.push({ input: { type, fields }, ids, output: { made: step, retyped } })
    })
  })
  write("model-makeStep.json", made)
  write("model-createStep.json", ACTION_TYPES.map((type) => {
    const ids = idsNow()
    return { input: type, ids, output: createStep(type) }
  }))

  nameDecksWith((id) => (id === "music" ? "Music" : id === "empty" ? "" : undefined))
  const summaries = (step: Step | undefined): Record<string, Record<string, string>> => {
    const out: Record<string, Record<string, string>> = { summary: {}, summaryMac: {} }
    for (const words of ["echo", "en"] as const) {
      out.summary![words] = inWords(words, () => onPlatform("Win32", () => stepSummary(step)))
      out.summaryMac![words] = inWords(words, () => onPlatform("MacIntel", () => stepSummary(step)))
    }
    return out
  }
  const textFields: StepTextField[] = ["sceneName", "sourceName", "filterName", "url", "appPath"]
  const questions: Case[] = [{ input: null, output: summaries(undefined) }]
  for (const step of unique(normalizedSteps)) {
    const texts: Record<string, string | null> = {}
    for (const key of textFields) texts[key] = stepText(step, key) ?? null
    questions.push({ input: viaJson(step), output: { setModeOf: setModeOf(step), stepText: texts, ...summaries(step) } })
  }
  write("actions-steps.json", questions)
}

// ----------------------------------------------------------------- buttons

const GLYPH: Fields = { source: "google", name: "mic", style: "rounded", fill: true, viewBox: "0 -960 960 960", paths: ["M0 0L1 1", "M2 2h4v4Z"] }
const TINY_PNG = "data:image/png;base64,iVBORw0KGgo="
const stepOf = (id: string, type: ActionType, fields: Fields = {}): Fields => ({ id, type, delayMs: 0, ...fields })

const PRESS: Fields = {
  id: "b1", slot: 2, label: "Go live", icon: "mic", color: "red", control: "press",
  steps: [stepOf("s1", "obs_scene", { sceneName: "Main" }), stepOf("s2", "obs_toggle_mute", { sourceName: "Mic", set: "on" })],
  offSteps: [stepOf("s3", "obs_toggle_mute", { sourceName: "Mic", set: "off" })],
  action: stepOf("old", "open_url", { url: "example.com" }),
  iconData: TINY_PNG, glyph: GLYPH, onGlyph: { ...GLYPH, name: "mic_off" },
  fader: { target: "system", inputName: "" }, extra: "dropped", open: true
}
const FADER_SETTINGS: Fields = { target: "app", inputName: "Mic/Aux", app: "Chrome.EXE", appName: "Google Chrome", extra: 1 }
const FADER: Fields = { id: "f1", slot: 5, label: "Mic", icon: "sliders", color: "#12AbEf", control: "fader", fader: FADER_SETTINGS, steps: [] }
const BUTTON_FIELDS = ["id", "slot", "label", "icon", "color", "control", "steps", "offSteps", "action", "iconData", "glyph", "onGlyph", "fader", "extra"]

const picture = (bytes: number, type = "png"): string => `data:image/${type};base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`

/** App keys: every ASCII character at the start, in the middle and at the end, then the special cases. */
function appKeys(): Json[] {
  const keys: Json[] = [...ODD]
  for (let code = 0; code < 128; code += 1) {
    const c = String.fromCharCode(code)
    keys.push(`a${c}b`, `${c}ab`, `ab${c}`)
  }
  keys.push(
    "Chrome.EXE", "  Chrome.EXE ", "chrome.exe.exe", ".exe", "a.exe ", "a .exe", "exe", "chrome.Exe", "chrome.exe\n", "Battle.net Launcher-2", "..\\evil", "a\"b",
    ".hidden", "-dash", "_under", "+plus", "9lives", "a".repeat(63), "a".repeat(64), "a".repeat(65), `${"a".repeat(64)}.exe`, `${"a".repeat(65)}.exe`,
    ` ${"a".repeat(64)} `, " spotify﻿", " music ", "Kelvin", "İstanbul", "ｓｐｏｔｉｆｙ", "SPOTIFY", "Spotify", "music", "a\u0085b"
  )
  return unique(keys)
}

/** App names: one line, no control characters, 80 at most. */
const APP_NAMES: Json[] = [
  ...ODD, " Google\nChrome  ", "Something", "\u0000\u0001a\u001f\u007fb", "a\t\tb", "a    b", "\n\n", "a".repeat(79), "a".repeat(80), "a".repeat(81),
  `${"a".repeat(79)} b`, `${"a".repeat(78)}  b`, `   ${"b".repeat(90)}`, `😀${"a".repeat(76)}😀`, `${"a".repeat(78)}😀b`, "Ñandú — café", "a\u0085b", "a b c"
]

function buttonInputs(): Json[] {
  const inputs: Json[] = [...ODD, PRESS, FADER]
  for (const field of BUTTON_FIELDS) inputs.push(...mutations(PRESS, field))
  for (const field of ["slot", "color", "control", "steps", "fader"]) inputs.push(...mutations(FADER, field))
  for (const field of ["target", "inputName", "app", "appName"]) inputs.push(...nested(FADER, "fader", FADER_SETTINGS, field))
  for (const target of Object.keys(FADER_TARGETS)) {
    for (const inputName of ["", "Mic"]) for (const app of [null, "", "spotify"]) inputs.push({ ...FADER, fader: { target, inputName, app, appName: null } })
  }
  for (const app of appKeys()) inputs.push({ id: "f", slot: 0, control: "fader", fader: { target: "app", app, appName: "Something" }, steps: [] })
  for (const appName of APP_NAMES) inputs.push({ id: "f", slot: 0, control: "fader", fader: { target: "app", app: "chrome", appName }, steps: [] })

  // Collections: none, one, the limit, past it, far past it.
  const many = (count: number): Fields[] => Array.from({ length: count }, (_, n) => stepOf(`m${n}`, ACTION_TYPES[n % ACTION_TYPES.length]!, { ...FULL_STEP, id: `m${n}`, delayMs: n }))
  for (const count of [0, 1, 2, 11, 12, 13, 40]) {
    inputs.push({ id: "c", slot: 0, steps: many(count) }, { id: "c", slot: 0, steps: many(1), offSteps: many(count) }, { id: "c", slot: 0, steps: many(count), action: stepOf("a", "stop_sounds") })
  }
  inputs.push({ id: "c", slot: 0, steps: [null, 5, "x", [], {}, { type: "play_sound", soundId: 2 }], offSteps: [null, { type: "nope" }] })
  inputs.push({ id: "c", slot: 0, steps: [stepOf("same", "none"), stepOf("same", "none")], offSteps: [stepOf("same", "none")] })
  inputs.push({ slot: 0 }, { steps: [{}] }, { steps: [{}, {}], offSteps: [{}] }, { control: "fader" }, { control: "fader", fader: {} }, { action: { type: "obs_save_replay" } }, { action: null }, { action: "x" })

  // Single steps, switches and macros of every action, for the questions asked of a button.
  ACTION_TYPES.forEach((type, at) => {
    const one = { ...FULL_STEP, type, id: `q${at}` }
    inputs.push({ id: `one${at}`, slot: at, steps: [one] }, { id: `two${at}`, slot: at, steps: [one, stepOf("n", "none")] }, { id: `sw${at}`, slot: at, steps: [one], offSteps: [] })
    inputs.push({ id: `fd${at}`, slot: at, steps: [one], offSteps: [one], control: "fader", fader: { target: "obs_input", inputName: "Mic" } })
    inputs.push({ id: `bare${at}`, slot: at, steps: [{ id: "b", type }] }, { id: `off${at}`, slot: at, steps: [stepOf("n", "none")], offSteps: [{ id: "b", type }] })
  })
  for (const soundId of [null, 0, 1, 8, 9]) inputs.push({ id: "snd", slot: 0, steps: [{ id: "s", type: "play_sound", soundId }] })

  // Slots, colours, icons, pictures and glyphs in their own ranges.
  for (let slot = -3; slot <= 50; slot += 0.75) inputs.push({ id: "s", slot }, { id: "s", slot: String(slot) })
  for (const color of [...BUTTON_COLORS.map((preset) => preset.id), "ACCENT", "#000000", "#FFFFFF", "#abcdef", "#ABCDEF", "#abcde", "#abcdefg", "#abcdeg", "abcdef", "#abc", " #abcdef", "#abcdef\n"]) inputs.push({ id: "c", slot: 0, color })
  for (const icon of [...Object.keys(ICONS), "Radio", "mic ", "valueOf", "isPrototypeOf"]) inputs.push({ id: "i", slot: 0, icon })
  for (const type of ["png", "jpeg", "webp", "svg+xml", "gif", "PNG", "svg xml", "jpg"]) inputs.push({ id: "p", slot: 0, iconData: picture(9, type) })
  for (const iconData of [
    "data:image/png;base64,", "data:image/png;base64,AA AA", "data:image/png;base64,AA\n", "DATA:IMAGE/PNG;BASE64,QUJD", "data:image/png;base64,QUJD+/=", "data:image/png;base64,QUJD-_",
    "data:text/html;base64,QUJD", " data:image/png;base64,QUJD", "data:image/png;charset=utf-8;base64,QUJD", "data:image/png,QUJD", "https://example.com/a.png", "data:image/png;base64,é"
  ]) inputs.push({ id: "p", slot: 0, iconData })
  // The limit is 750 KB of image: 1024064 characters with the prefix.
  const prefix = "data:image/png;base64,".length
  // (The 700 KB and 2 MB pictures of tests/library.test.mjs are a Rust unit test: megabytes of "A" add nothing here.)
  for (const length of [1024064, 1024065]) inputs.push({ id: "big", slot: 0, iconData: `data:image/png;base64,${"A".repeat(length - prefix)}` })
  for (const name of ["sensors", "tune", "mic"]) {
    for (const icon of ["radio", "mic"]) {
      for (const iconData of [null, "", TINY_PNG]) {
        for (const control of ["press", "fader"]) {
          inputs.push({ id: "d", slot: 0, icon, iconData, control, glyph: { ...GLYPH, name }, fader: { target: "sounds", inputName: "" } }, { id: "d", slot: 0, icon, iconData, control })
        }
      }
    }
  }
  for (const glyph of glyphInputs().slice(0, 150)) inputs.push({ id: "g", slot: 0, glyph, onGlyph: glyph })

  // tests/library.test.mjs, tests/app-volume.test.mjs and tests/actions.test.mjs.
  for (const library of TEST_LIBRARIES) inputs.push(...buttonsOf(library))
  for (const fields of APP_VOLUME_FADERS) inputs.push({ id: "f", slot: 0, label: "", control: "fader", steps: [], fader: fields })
  return unique(inputs.map(viaJson))
}

const normalizedButtons: Button[] = []

function buttons(): void {
  write("model-normalizeButton.json", buttonInputs().map((input) => {
    const ids = idsNow()
    const output = normalizeButton(input)
    normalizedButtons.push(output)
    return { input, ids, output }
  }))

  // The questions are asked of buttons as Rust holds them: normalized, and
  // read back from JSON. A slot of Infinity does not survive that, and a
  // megabyte of picture says nothing more than nine bytes of it.
  const asked = unique(normalizedButtons).filter((button) => JSON.stringify(button).length < 4000 && Number.isFinite(button.slot))
  write("model-buttonQuestions.json", asked.map((button) => {
    const output: Record<string, unknown> = {
      isConfigured: isConfigured(button),
      isSwitch: isSwitch(button),
      buttonStateKey: buttonStateKey(button),
      soundSlotOf: soundSlotOf(button),
      isStateful: isStateful(button),
      stateKeys: button.steps.map(stateKeyOf),
      asFader: withControl(button, "fader"),
      asPress: withControl(button, "press")
    }
    if (button.control === "fader") {
      output.faderLevelKey = faderLevelKey(button.fader)
      output.appDisplayName = { echo: appDisplayName(button.fader), en: inWords("en", () => appDisplayName(button.fader)) }
    }
    return { input: viaJson(button), output }
  }))
  write("icons-iconMarkup.json", asked.filter((_, at) => at % 3 === 0).map((button) => ({ input: viaJson(button), output: iconMarkup(button) })))

  write("model-normalizeAppKey.json", appKeys().map((input) => ({ input, output: normalizeAppKey(input) ?? null })))
  write("model-createEmptyButton.json", [0, 1, 5, 11, 47, 1000].map((slot) => {
    const ids = idsNow()
    return { input: slot, ids, output: createEmptyButton(slot) }
  }))
}

// --------------------------------------------------------------- libraries

const testDeck = (name: string, deckButtons: Json[] = []): Fields => ({ id: name.toLowerCase(), name, columns: 4, rows: 3, buttons: deckButtons })
const testPress = (id: string, slot: number, pressSteps: Json[] = [{ id: `s_${id}`, type: "none", delayMs: 0 }]): Fields =>
  ({ id, slot, label: id, icon: "zap", color: "accent", control: "press", steps: pressSteps })
const MINE: Fields = { version: 1, activeProfileId: "mine", profiles: [testDeck("Mine", [testPress("a", 0)])] }

/** The faders tests/app-volume.test.mjs normalizes one by one. */
const APP_VOLUME_FADERS: Fields[] = [
  { target: "app", app: "  Chrome.EXE ", appName: " Google\nChrome  " },
  ...(["..\\evil", "a\"b", "a\nb", "  ", 7, "a".repeat(65), ".hidden"] as Json[]).map((app): Fields => ({ target: "app", app, appName: "Something" })),
  { target: "system", inputName: "" },
  { target: "app_x" }
]

/** tests/actions.test.mjs's deck, with ids that repeat instead of random ones. */
function actionsTestLibrary(): Fields {
  let made = 0
  const step = (type: ActionType, fields: Fields = {}): Fields => ({ id: `s_${type}_${(made += 1)}`, type, delayMs: 0, ...fields })
  const press = (id: string, pressSteps: Fields[], slot: number): Fields => ({ id, slot, label: id, icon: "bolt", color: "accent", control: "press", steps: pressSteps })
  return {
    version: 1,
    activeProfileId: "main",
    profiles: [
      {
        id: "main", name: "Main", columns: 4, rows: 3,
        buttons: [
          press("intro", [step("obs_scene", { sceneName: "Intro" })], 0),
          press("mainScene", [step("obs_scene", { sceneName: "Main" })], 1),
          press("mic", [step("obs_toggle_mute", { sourceName: "Mic" })], 2),
          press("cam", [step("obs_toggle_source", { sceneName: "Main", sourceName: "Camera" })], 3),
          press("blur", [step("obs_toggle_filter", { sourceName: "Camera", filterName: "Blur" })], 4),
          press("vcam", [step("obs_toggle_virtualcam")], 5),
          press("replay", [step("obs_save_replay")], 6),
          press("studio", [step("obs_studio_transition")], 7),
          press("broken", [step("stop_sounds"), step("obs_scene", { sceneName: "Nope" }), step("obs_toggle_virtualcam")], 8),
          press("toMusic", [step("stop_sounds"), step("go_to_deck", { profileId: "music" })], 9),
          { ...press("break", [step("obs_scene", { sceneName: "BRB" }), step("obs_toggle_mute", { sourceName: "Mic", set: "on" })], 11),
            offSteps: [step("obs_scene", { sceneName: "Main" }), step("obs_toggle_mute", { sourceName: "Mic", set: "off" })] },
          { id: "micFader", slot: 10, label: "Mic", icon: "tune", color: "accent", control: "fader", fader: { target: "obs_input", inputName: "Mic" }, steps: [] }
        ]
      },
      { id: "music", name: "Music", columns: 4, rows: 3, buttons: [press("mic2", [step("obs_toggle_mute", { sourceName: "Mic" })], 0)] },
      {
        id: "macros", name: "Macros", columns: 4, rows: 3,
        buttons: [
          press("pause", [step("none", { delayMs: 400 }), step("go_to_deck", { profileId: "music" })], 0),
          { ...press("slowSwitch", [step("none", { delayMs: 500 }), step("obs_scene", { sceneName: "Intro" })], 1), offSteps: [step("obs_scene", { sceneName: "Main" })] },
          press("counted", [step("none"), step("obs_scene", { sceneName: "Intro" }), step("none", { delayMs: 10 }), step("obs_scene", { sceneName: "Main" })], 2),
          press("single", [step("none", { delayMs: 10 }), step("obs_scene", { sceneName: "Main" })], 3)
        ]
      }
    ]
  }
}

const appFader = (id: string, slot: number, app?: string): Fields => ({ id, slot, control: "fader", fader: app ? { target: "app", app } : { target: "app" }, steps: [] })
const oneDeck = (deckButtons: Json[]): Fields => ({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: deckButtons }] })

/** The libraries the existing tests build, as they build them. */
const TEST_LIBRARIES: Fields[] = [
  // tests/library.test.mjs
  MINE,
  { version: 1, activeProfileId: "one", profiles: [
    testDeck("One", [testPress("x", 0), testPress("x", 1), testPress("y", 1), testPress("z", 2)]),
    { ...testDeck("One"), name: "Copy", buttons: [testPress("x", 0)] }
  ] },
  { version: 1, activeProfileId: "f", profiles: [{ ...testDeck("F"), columns: 2, rows: 1, buttons: [testPress("p", 0), testPress("q", 1), testPress("r", 1)] }] },
  { version: 1, activeProfileId: "mine", profiles: [testDeck("Mine", [testPress("a", 0), testPress("a", 0)]), testDeck("Mine")] },
  { version: 1, activeProfileId: "", profiles: [] },
  { version: 2, activeProfileId: "x", decks: [{ id: "x", stuff: "from the future" }] },
  ...(["constructor", "__proto__", "mic"] as Json[]).map((icon): Fields => ({ version: 1, activeProfileId: "d", profiles: [testDeck("D", [{ ...testPress("b", 0), icon }])] })),
  ...([
    { type: "play_sound", soundId: 8.9 }, { type: "play_sound", soundId: 9 }, { type: "play_sound", soundId: 0.5 },
    { type: "hotkey", keys: "Shift + CTRL+K" }, { type: "hotkey", keys: "ctrl+nope" }
  ] as Fields[]).map((fields): Fields => ({ version: 1, activeProfileId: "d", profiles: [testDeck("D", [{ ...testPress("b", 0), steps: [{ id: "s", delayMs: 0, ...fields }] }])] })),
  ...([null, "", 2, "2.5", 0] as Json[]).map((speed): Fields => ({ version: 1, activeProfileId: "t", profiles: [{ ...testDeck("T"), trackpad: { speed } }] })),
  { version: 1, activeProfileId: "t", profiles: [{ ...testDeck("T"), trackpad: {} }] },
  // tests/app-volume.test.mjs
  oneDeck([appFader("a", 0), appFader("b", 1, "spotify")]),
  oneDeck([appFader("a", 0, "spotify"), appFader("b", 1, "chrome"), appFader("c", 2, "chrome")]),
  oneDeck([]),
  oneDeck([appFader("a", 0, "spotify")]),
  // tests/actions.test.mjs
  actionsTestLibrary(),
  // tests/trackpad.test.mjs
  ...[1, 1.5, 3].map((speed): Fields => ({
    activeProfileId: "pad",
    profiles: [
      { id: "pad", name: "Pad", columns: 3, rows: 2, buttons: [], trackpad: { speed, naturalScroll: true, pinchZoom: "gesture" } },
      { id: "keys", name: "Keys", columns: 3, rows: 2, buttons: [] }
    ]
  }))
]

const PROFILE: Fields = {
  id: "main", name: "Main", columns: 4, rows: 3, updatedAt: "2026-01-02T03:04:05.678Z", hidden: true,
  trackpad: { speed: 2, naturalScroll: false, pinchZoom: "keys", extra: 1 },
  buttons: [testPress("a", 0), { ...FADER, slot: 1 }], extra: [1, 2]
}
const SECOND: Fields = { id: "second", name: "Second", columns: 2, rows: 1, buttons: [testPress("b", 0), testPress("c", 7)] }
const LIBRARY: Fields = { version: 1, activeProfileId: "second", profiles: [PROFILE, SECOND], extra: "dropped" }

function libraryInputs(): Json[] {
  const inputs: Json[] = [...ODD, LIBRARY, ...TEST_LIBRARIES]
  for (const field of ["version", "activeProfileId", "profiles", "extra"]) inputs.push(...mutations(LIBRARY, field))
  for (const field of ["id", "name", "columns", "rows", "buttons", "updatedAt", "trackpad", "hidden", "extra"]) {
    // First in the library, then second, turn about.
    mutations(PROFILE, field).forEach((changed, at) => inputs.push(at % 2 ? { version: 1, activeProfileId: "main", profiles: [SECOND, changed] } : { ...LIBRARY, profiles: [changed, SECOND] }))
  }
  // A button's own fields, inside a library: a smaller set of values, since normalizeButton has them all.
  const few = ODD.filter((_, at) => at % 4 === 0)
  for (const field of BUTTON_FIELDS) {
    for (const changed of mutations(PRESS, field, few)) inputs.push({ version: 1, activeProfileId: "main", profiles: [{ ...SECOND, buttons: [changed, testPress("b", 2)] }] })
  }
  for (const columns of [-1, 0, 1, 2, 2.9, 8, 8.5, 9, 100]) for (const rows of [-1, 0, 1, 1.9, 6, 6.5, 7, 100]) inputs.push({ version: 1, activeProfileId: "g", profiles: [{ id: "g", name: "G", columns, rows, buttons: [] }] })

  // Repeated ids and slots: every way to give four buttons three slots, and
  // three ids ("__proto__" among them, which the TypeScript never remembers).
  const names = ["a", "b", "__proto__"]
  for (let code = 0; code < 81; code += 1) {
    const digits = [code % 3, Math.floor(code / 3) % 3, Math.floor(code / 9) % 3, Math.floor(code / 27) % 3]
    inputs.push({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", columns: 2, rows: 1, buttons: digits.map((slot, n) => testPress(`k${n}`, slot)) }] })
    inputs.push({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: digits.map((id, n) => testPress(names[id]!, n)) }] })
    inputs.push({ version: 1, activeProfileId: names[digits[3]!]!, profiles: digits.slice(0, 3).map((id, n) => ({ id: names[id]!, name: `D${n}`, buttons: [testPress(names[digits[(n + 1) % 3]!]!, digits[n]!)] })) })
  }
  for (const slots of [[1e300, 1e300, 0], ["Infinity", "Infinity", 0, 0], [0, 0, 0, 0, 1, 1, 2], [5, 5, 5], [0.5, 0.2, 1.9, 1], [-1, 0, "0", null], [1e21, 1e21, 9007199254740992, 9007199254740992]]) {
    inputs.push({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: slots.map((slot, n) => ({ id: `s${n}`, slot })) }] })
  }
  for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "0", "1"]) {
    inputs.push({ version: 1, activeProfileId: id, profiles: [{ id, name: "A" }, { id, name: "B", buttons: [{ id, slot: 0 }, { id, slot: 0 }] }, { id, name: "C", buttons: [{ id, slot: 1 }] }] })
  }
  // Nothing has an id: every one is made, in order.
  inputs.push({ profiles: [{}, {}, { buttons: [{}, {}, { steps: [{}, {}], offSteps: [{}] }] }] }, { profiles: [null, 5, "x", [], {}] }, { version: 1, activeProfileId: "nope", profiles: [{ id: "a" }, { id: "b" }] })
  // Hidden decks and buttons past the grid, for shownProfiles and parkedButtons.
  for (const hidden of [true, false, null, "true", 1]) {
    inputs.push({ version: 1, activeProfileId: "h", profiles: [{ id: "h", name: "H", hidden, columns: 2, rows: 2, buttons: [3, 4, 5, 100].map((slot) => testPress(`h${slot}`, slot)) }, { id: "v", name: "V", hidden: !hidden }] })
  }
  // Empty and huge collections.
  inputs.push({ version: 1, activeProfileId: "p0", profiles: Array.from({ length: 300 }, (_, n) => ({ id: `p${n % 150}`, name: `Deck ${n}` })) })
  inputs.push({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: Array.from({ length: 600 }, (_, n) => ({ id: `b${n % 400}`, slot: n % 7 })) }] })
  inputs.push({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: [] }, { id: "q", name: "Q", buttons: [] }] })
  return unique(inputs.map(viaJson))
}

function libraries(): void {
  const inputs = libraryInputs()
  const normalized: Library[] = []
  write("model-normalizeLibrary.json", inputs.map((input) => {
    const ids = idsNow()
    const output = normalizeLibrary(input)
    normalized.push(output)
    return { input, ids, shape: isLibraryShape(input), output }
  }))
  // The words a deck without a name gets, in each language.
  const worded = inputs.filter((input) => JSON.stringify(input).length < 600).filter((_, at) => at % 9 === 0)
  for (const words of ["en", "es"] as const) {
    write(`model-normalizeLibrary-${words}.json`, worded.map((input) => {
      const ids = idsNow()
      return { input, ids, output: inWords(words, () => normalizeLibrary(input)) }
    }))
  }

  const versions: Json[] = [1, 1.0, "1", 2, 0, true, null]
  const actives: Json[] = ["", "main", 0, null, ["main"], {}]
  const lists: Json[] = [[], [{}], {}, { length: 0 }, null, "[]"]
  const shapes: Json[] = [...ODD, { activeProfileId: "", profiles: [] }, { version: 1, profiles: [] }, { version: 1, activeProfileId: "" }, [{ version: 1, activeProfileId: "", profiles: [] }]]
  for (const version of versions) for (const activeProfileId of actives) for (const profiles of lists) shapes.push({ version, activeProfileId, profiles })
  write("model-isLibraryShape.json", unique(shapes.map(viaJson)).map((input) => ({ input, output: isLibraryShape(input) })))

  const asked = unique(normalized).filter((library) =>
    JSON.stringify(library).length < 20000 && library.profiles.every((profile) => profile.buttons.every((button) => Number.isFinite(button.slot))))
  write("model-libraryQuestions.json", asked.filter((_, at) => at % 4 === 0).map((library) => ({
    input: viaJson(library),
    output: {
      shown: shownProfiles(library).map((profile) => profile.id),
      parked: library.profiles.map((profile) => parkedButtons(profile).map((button) => button.id))
    }
  })))

  const TRACKPAD: Fields = { speed: 2, naturalScroll: false, pinchZoom: "keys", extra: 1 }
  const trackpads: Json[] = [...ODD, TRACKPAD, ...mutations(TRACKPAD, "speed"), ...mutations(TRACKPAD, "naturalScroll"), ...mutations(TRACKPAD, "pinchZoom")]
  for (let speed = -1; speed <= 4; speed += 0.125) trackpads.push({ speed }, { speed: String(speed) }, { speed: ` ${speed} ` })
  for (const pinchZoom of ["keys", "gesture", "KEYS", "keys "]) for (const naturalScroll of [true, false, "true", 0]) trackpads.push({ pinchZoom, naturalScroll })
  write("model-normalizeTrackpad.json", unique(trackpads.map(viaJson)).map((input) => ({ input, output: normalizeTrackpad(input) })))

  write("model-createEmptyProfile.json", ["My deck", "", "Ünïcödé 😀"].map((name) => {
    const ids = idsNow()
    return { input: name, ids, output: createEmptyProfile(name) }
  }))
  writeTable("model-constants.json", { DEFAULT_TRACKPAD, TRACKPAD_SPEED, APP_KEY_MAX })
}

function clock(): void {
  const random = sequence(7)
  const moments = [
    0, 1, 35, 36, 1295, 1296, 999, 1000, 59999, 86399999, 86400000, 1e12, NOW, 2 ** 41,
    Date.UTC(1999, 11, 31, 23, 59, 59, 999), Date.UTC(2000, 0, 1), Date.UTC(2000, 1, 29), Date.UTC(2000, 2, 1), Date.UTC(2023, 1, 28, 23, 59, 59, 999),
    Date.UTC(2024, 1, 29, 12), Date.UTC(2024, 11, 31, 23, 59, 59, 999), Date.UTC(2100, 1, 28), Date.UTC(2100, 2, 1), Date.UTC(2400, 1, 29), Date.UTC(9999, 11, 31, 23, 59, 59, 999)
  ]
  for (let n = 0; n < 60; n += 1) moments.push(Math.floor(random() * 4e12))
  const prefixes = ["btn", "step", "profile", ""]
  write("model-nextId.json", moments.map((now, at) => {
    mock.timers.setTime(now)
    const prefix = prefixes[at % prefixes.length]!
    const counter = idsMade()
    return { input: { now, counter, prefix }, output: { id: nextId(prefix), iso: new Date().toISOString() } }
  }))
  mock.timers.setTime(NOW)
}

// ----------------------------------------------------------------- actions

function actions(): void {
  const names: Json[] = [
    ...ODD, ...ACTION_TYPES, ...SET_MODES, ...Object.keys(MEDIA_KEYS), ...Object.keys(FADER_TARGETS),
    "OBS_SCENE", "obs_scene ", " none", "None", "On", "play-pause", "obs_input ", "App", "valueOf", "label", "group", "hint"
  ]
  write("actions-validators.json", unique(names).map((input) => ({
    input,
    output: { isActionType: isActionType(input), isSetMode: isSetMode(input), isMediaKey: isMediaKey(input), isFaderTarget: isFaderTarget(input) }
  })))

  const worded = <T>(read: () => T): Record<string, T> => ({ echo: read(), en: inWords("en", read) })
  const actionTable: Record<string, unknown> = {}
  for (const type of ACTION_TYPES) {
    const labels = SET_LABELS[type]
    actionTable[type] = {
      group: ACTION_META[type].group,
      ...worded(() => ({
        label: ACTION_META[type].label,
        hint: ACTION_META[type].hint,
        fields: ACTION_FIELDS[type]?.map((spec) => ({ ...spec, label: spec.label, placeholder: spec.placeholder })) ?? null,
        set: labels ? { toggle: labels.toggle, on: labels.on, off: labels.off } : null
      }))
    }
  }
  const groups: Record<string, unknown> = {}
  for (const group of ACTION_GROUPS) groups[group] = worded(() => actionGroupLabel(group))
  const mediaKeys: Record<string, unknown> = {}
  for (const key of ["play_pause", "next", "previous"] as const) mediaKeys[key] = worded(() => MEDIA_KEYS[key])
  const faderTargets: Record<string, unknown> = {}
  for (const target of ["obs_input", "sounds", "system", "app"] as const) faderTargets[target] = worded(() => ({ label: FADER_TARGETS[target].label, hint: FADER_TARGETS[target].hint }))
  writeTable("actions-tables.json", {
    ACTION_TYPES, ACTION_GROUPS, STATEFUL_ACTIONS, SET_MODES, SET_ACTIONS: Object.keys(SET_LABELS), MEDIA_KEYS: Object.keys(MEDIA_KEYS),
    FADER_TARGETS: Object.keys(FADER_TARGETS), LIMITS, actions: actionTable, groups, mediaKeys, faderTargets
  })
}

// -------------------------------------------------------------------- keys

function keys(): void {
  writeTable("keys-tables.json", { MODIFIERS, KEY_NAMES })

  const combos: Json[] = [...ODD, ...COMBOS, ...KEY_NAMES]
  for (const name of KEY_NAMES) combos.push(`ctrl+${name}`, `meta+shift+alt+ctrl+${name}`, ` Shift + ${name.toUpperCase()} `)
  // Every order of every set of modifiers.
  const orders = (left: readonly string[]): string[][] => (left.length ? left.flatMap((first) => orders(left.filter((other) => other !== first)).map((rest) => [first, ...rest])) : [[]])
  for (let set = 0; set < 16; set += 1) {
    const chosen = MODIFIERS.filter((_, bit) => set & (1 << bit))
    for (const order of orders(chosen)) combos.push([...order, "k"].join("+"), [...order, order[0] ?? "ctrl", "k"].join("+"), order.join("+"))
  }
  combos.push("CTRL+K", "Ctrl+K", "ctrl + k", "ctrl\t+\nk", "ctrl+ k", "ctrl+ｋ", "control+k", "K", "ctrl+K", "İ", "shift+İ", "ctrl+k ", "ctrl-k", "ctrl k", "meta", "ctrl+alt")
  const parsed = unique(combos)
  write("keys-parseCombo.json", parsed.map((input) => {
    const combo = parseCombo(input)
    return { input, output: { combo, text: combo ? comboToString(combo) : null } }
  }))

  const formatted: Array<{ text: string | null; mac: boolean }> = []
  for (const mac of [false, true]) {
    formatted.push({ text: null, mac })
    for (const text of parsed) if (typeof text === "string") formatted.push({ text, mac })
  }
  write("keys-formatCombo.json", formatted.map((input) => {
    const read = (): string => formatCombo(input.text ?? undefined, input.mac)
    return { input, output: { echo: read(), en: inWords("en", read) } }
  }))

  // No "constructor" or "toString" among the codes: comboFromEvent looks a
  // code up in a plain object and answers with what it inherits ("ctrl+function
  // Object() { [native code] }"). No keyboard sends such a code, and Rust says null.
  const codes: string[] = ["", "KeyA ", "keya", "KeyAA", "Key1", "Digit", "DigitA", "Digit10", "F", "F0", "F01", "F001", "F25", "F99", "f1", "Numpad1", "ShiftLeft", "ControlRight", "MetaLeft", "AltRight", "CapsLock", "IntlBackslash", "enter", "nope"]
  for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") codes.push(`Key${letter}`)
  for (let n = 0; n <= 9; n += 1) codes.push(`Digit${n}`)
  for (let n = 1; n <= 24; n += 1) codes.push(`F${n}`)
  codes.push("Enter", "NumpadEnter", "Space", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
    "Minus", "Equal", "Comma", "Period", "Slash", "Backquote", "BracketLeft", "BracketRight", "Backslash", "Semicolon", "Quote")
  write("keys-comboFromEvent.json", codes.flatMap((code, at) => [at % 16, (at * 7 + 5) % 16].map((held) => {
    const input = { code, ctrlKey: Boolean(held & 1), altKey: Boolean(held & 2), shiftKey: Boolean(held & 4), metaKey: Boolean(held & 8) }
    return { input, output: comboFromEvent(input) }
  })))

  write("keys-modifierLabel.json", MODIFIERS.flatMap((modifier) => [false, true].map((mac) => ({ input: { modifier, mac }, output: modifierLabel(modifier, mac) }))))

  const platforms = [
    "darwin", "Darwin", "DARWIN", "darwin ", "xdarwin", "MacIntel", "MacPPC", "macOS", "mac", "MAC", "iPhone", "iphone", "iPad", "IPAD", "iPod", "machine", "stomach", "Linux armv8l mac",
    "win32", "Win32", "WIN64", "Windows", "windows", "win", "wIn", "cygwin", "darwin32", " win32", "Linux x86_64", "linux", "Linux armv8l", "freebsd", "openbsd", "sunos", "aix", "android", "Android",
    "", " ", "X11", "CrOS", "ｍａｃ", "K", "ıpad", "WİN", "ſ"
  ]
  write("keys-keyPlatform.json", platforms.map((input) => ({ input, output: keyPlatform(input) })))

  const reasons: Array<{ key: string; platform: KeyPlatform }> = []
  for (const platform of ["mac", "windows", "other"] as const) {
    for (const key of [...KEY_NAMES, "F21", "f25", "f2", "f210", " f21", "f21 ", "", "nope"]) reasons.push({ key, platform })
  }
  write("keys-unsendableReason.json", reasons.map((input) => {
    const read = (): string | null => unsendableReason(input.key, input.platform)
    return { input, output: { echo: read(), en: inWords("en", read) } }
  }))
}

// ----------------------------------------------------------------- colours

function colors(): void {
  const random = sequence(11)
  const hex = (): string => `#${Math.floor(random() * 0x1000000).toString(16).padStart(6, "0")}`
  const randomHex = Array.from({ length: 80 }, hex)
  const presets = BUTTON_COLORS.map((preset) => preset.id)
  const spellings = [
    "#000000", "#ffffff", "#FFFFFF", "#AbCdEf", "#abcde", "#abcdefg", "#abcdeg", "abcdef", "#abc", "abc", "#ABC", " #abcdef", "#abcdef ", "#abcdef\n", "##abcdef", "#", "# abc", "#12345６",
    "#08100f", "#5fd0d6", "rgb(0,0,0)", "red", "ACCENT", "accent ", "Accent", "é12", "#é12", "#12", "#1234", "#12345", "  abc  ", " #abc﻿", "#a b", "0x1234", "ffffff", "FFF", "#ggg"
  ]
  write("colors-validators.json", unique<Json>([...ODD, ...presets, ...spellings, ...randomHex]).map((input) => {
    const output: Record<string, unknown> = { isHexColor: isHexColor(input), isButtonColorId: isButtonColorId(input), isButtonColor: isButtonColor(input) }
    if (isButtonColor(input)) output.colorValue = colorValue(input)
    return { input, output }
  }))

  const hexes = unique<string | null>([null, ...ODD_STRINGS, ...spellings, ...BUTTON_COLORS.map((preset) => preset.value), ...randomHex])
  write("colors-hex.json", hexes.map((input) => {
    const output: Record<string, unknown> = { parseHex: parseHex(input) }
    if (input !== null) {
      output.readableInk = readableInk(input)
      output.isVeryDark = isVeryDark(input)
      output.contrastDark = contrastRatio(input, DARK_INK)
      output.contrastLight = contrastRatio(input, LIGHT_INK)
    }
    return { input, output }
  }))

  const some = ["#000000", "#ffffff", "#5fd0d6", "#abc", "nope", "", ...randomHex.slice(0, 14)]
  const alphas = [0, 0.5, 1, 0.123456789, 1e-7, 0.000001, 2, -1, 1e21, 0.1 + 0.2]
  write("colors-withAlpha.json", some.flatMap((hex) => alphas.map((alpha) => ({ input: { hex, alpha }, output: withAlpha(hex, alpha) }))))
  const amounts = [0, 0.25, 0.5, 0.75, 1, 1.5, -0.5, 1 / 3, 0.0019607843137254902, 1e9]
  const mixes: Case[] = []
  some.forEach((hex, at) => {
    for (const toward of [some[(at + 1) % some.length]!, some[(at * 5 + 3) % some.length]!]) {
      for (const amount of amounts) mixes.push({ input: { hex, toward, amount }, output: mixHex(hex, toward, amount) })
    }
  })
  write("colors-mixHex.json", mixes)
  write("colors-presets.json", BUTTON_COLORS.map((preset) => ({ input: preset.id, output: { value: preset.value, echo: preset.label, en: inWords("en", () => preset.label) } })))
  writeTable("colors-inks.json", { DARK_INK, LIGHT_INK })
}

// ------------------------------------------------------------------ themes

function themes(): void {
  const all = ["studio", "hardware", "hardware-dark", "broadcast"] as const
  const names: Json[] = [...ODD, ...all, "Studio", "studio ", "hardware_dark", "hardware-light", "dark", "broadcast-dark", "STUDIO"]
  write("themes-isThemeId.json", unique(names).map((input) => {
    const theme = typeof input === "string" || input === null ? themeById(input) : null
    return { input, output: { isThemeId: isThemeId(input), themeById: theme ? { id: theme.id, bg: theme.bg } : null } }
  }))
  write("themes-themes.json", all.map((id) => {
    const theme = themeById(id)
    const words = (): { label: string; hint: string } => ({ label: theme.label, hint: theme.hint })
    return { input: id, output: { listed: THEMES.some((listed) => listed.id === id), bg: theme.bg, family: themeFamily(id), dark: isDarkVariant(id), echo: words(), en: inWords("en", words) } }
  }))
  writeTable("themes-default.json", DEFAULT_THEME)
}

// ------------------------------------------------------------------- links

function links(): void {
  const typed: Array<string | null> = [null, ...ODD_STRINGS]
  // tests/library.test.mjs
  typed.push("twitch.tv/x", "https://example.com/a", "192.168.1.5:8080", "nas.local:8080", "localhost:8787/deck", "nas", "nas:5000", "mailto:a@b.com", "tel:123", "javascript:alert(1)", "file:///etc/passwd", "ftp://x.com", "data:text/html,hi", "")
  const hosts = [
    "twitch.tv", "example.com", "EXAMPLE.com", "nas", "NAS", "nas.local", "NAS.LOCAL", "a.b.c.local", "local", "x.localhost", "localhost", "192.168.1.5", "10.0.0.1", "1.2.3", "1.2.3.4.5",
    "[::1]", "[fe80::1]", "xn--bcher-kva.de", "bücher.de", "user@host.com", "user:pw@host.com", "example.com.", "sub.example.co.uk", "a-b.example", "tel", "sip", "mailto"
  ]
  const tails = ["", "/", ":80", ":443", ":8080", ":8787/deck", ":65535", ":65536", ":99999", ":123456", ":0", ":", ":abc", ":80a", "/path/to?x=1&y=2#top", "?q=a b", "?q=1", "#frag", "/a%20b/ü", ":8080?x#y", "/../up", "//double"]
  const starts = ["", "http://", "https://", "HTTPS://", "ftp://", "//"]
  for (const host of hosts) for (const tail of tails) for (const start of starts) typed.push(`${start}${host}${tail}`)
  for (const scheme of ["tel", "sms", "mms", "fax", "callto", "facetime", "facetime-audio", "sip", "sips", "TEL", "Sip", "mailto", "javascript", "data", "about", "blob", "foo", "FOO", "a+b.c-d", "x1", "ws", "wss", "file", "http", "https"]) {
    for (const rest of ["123", "80", "8080/x", "8080?x", "8080#x", "123456", "a@b.com", "alert(1)", "", "/", "//", "//x.com", "///x", "80:80", "+15551234"]) typed.push(`${scheme}:${rest}`)
  }
  typed.push(
    "  twitch.tv/x  ", "\ttwitch.tv\n", "twitch .tv", "twitch.tv/a b", "twitch.tv/a b", "﻿twitch.tv", "http://", "https://", "https:///x.com", "http://:80", "http://?x", "https://#", "http:/x.com", "http:x.com", "https:example.com",
    "http:\\\\x.com\\a", "x.com\\a", "1abc:80", "-a:80", "a_b:80", "a_b.com", "exa_mple.com/x", "example.com:80:80", "http://example.com:80", "https://example.com:443", "http://example.com:443", "https://example.com:80",
    "http://EXAMPLE.com/Path?Q=1#F", "http://example.com/%7Efoo/../bar/./baz", "http://example.com/a b", "example.com/<>\"`{}|^", "example.com/?<>\"`{}|^#<>\"`{}", "http://user:p%40ss@example.com/", "http://[::1]:8080/x", "[::1]:8080", "[::1", "::1",
    "http://0x7f.1/", "0x7f.1", "127.1", "2130706433", "http://2130706433", "256.256.256.256", "999.1.1.1", "1.2.3.4", "01.02.03.04", "1.2.3.4.", "192.168.1.5.", "http://192.168.1.5", "https://192.168.1.5", "192.168.1.5/x",
    "日本語.jp", "http://日本語.jp/パス", "😀.com", "ex ample.com", "example.com.local", "EXAMPLE.LOCAL", "foo.local.", "foo.locale", "..", ".", "a..b", "-.com", "example.com:08080", "example.com:+80", "%41.com", "a%2Fb.com", "exa%mple.com",
    "a.com/^x/../^y//^?^#^", "http://u^:p^@example.com/^/%5e/%5E?^#^", "nas:80/^", "example.com/a^b/c d/%zz/é/|/~/[]/\\", "example.com/;=@:$&+,!*'()", "http://a.b?c@d", "http://a@b@c/", "x".repeat(300), `${"a.".repeat(100)}com`, `http://example.com/${"p".repeat(2000)}`, "about:blank", "view-source:http://x.com", "chrome://settings", "obs://x", "HTTP://X.COM", "hTtPs://X.com/"
  )
  write("links-webAddress.json", unique(typed).map((input) => ({ input, output: webAddress(input) })))
  writeTable("links-constants.json", { SUPPORT_URL })
}

// ------------------------------------------------------------------- icons

function glyphInputs(): Json[] {
  const inputs: Json[] = [...ODD, GLYPH, [GLYPH]]
  for (const field of ["source", "name", "style", "fill", "viewBox", "paths", "extra"]) inputs.push(...mutations(GLYPH, field))
  for (const style of ["outlined", "rounded", "sharp", "Rounded", "filled", "sharp "]) inputs.push({ ...GLYPH, style })
  for (const name of ["Mic_Off", "MIC OFF", "mic-off", "mic.off", "a".repeat(64), "a".repeat(65), `${"A1_".repeat(30)}`, "ñandú", "İKK", "ｍｉｃ", "😀mic", "__proto__", "<script>", 12, 1.5, -3, 1e21, 1e-7, 0.000001, 1e20, true, false, ["a", "B"], [1, [2, null]], { a: 1 }, null]) inputs.push({ ...GLYPH, name })
  const numbers = ["0", "24", "-960", "960.5", ".5", "5.", "..", ".", "-", "", "1e3", "+5", "--5", "0x10", " 0", "24 ", "-0"]
  for (const number of numbers) for (let at = 0; at < 4; at += 1) inputs.push({ ...GLYPH, viewBox: ["0", "0", "24", "24"].map((part, n) => (n === at ? number : part)).join(" ") })
  for (const viewBox of ["0 0 24", "0 0 24 24 24", "0  0 24 24", "0\t0 24 24", "0 0 24 24\n", "\n0 0 24 24", "0,0,24,24", "0 0 24 24 ", " 0 0 24 24", "0 -960 960 960", "-0.5 -0.5 1.5 1.5"]) inputs.push({ ...GLYPH, viewBox })
  // One path of each printable ASCII character: only path commands and numbers pass.
  for (let code = 32; code < 127; code += 1) inputs.push({ ...GLYPH, paths: [`M0 0${String.fromCharCode(code)}1`] })
  for (const paths of [[], [""], ["M0 0"], Array.from({ length: 8 }, () => "M0 0"), Array.from({ length: 9 }, () => "M0 0"), ["M0 0", 5], ["M0 0", null], ["M0 0", ["M1 1"]], ["M0 0\n"], ["\tM0 0"], ["M0 0é"], ["M0 0", ""], ["m1e-5,2E3z"]] as Json[]) inputs.push({ ...GLYPH, paths })
  for (const length of [1, 19999, 20000, 20001]) inputs.push({ ...GLYPH, paths: ["M".repeat(length)] })
  for (const fill of [0, 1, -0.5, "", "false", "0", [], {}, null]) inputs.push({ ...GLYPH, fill })
  inputs.push({ viewBox: "0 0 24 24", paths: ["M0 0L1 1"] }, { name: "Mic_Off", viewBox: "0 0 24 24", paths: ["M0 0L1 1"] }, viaJson(DEFAULT_PRESS_GLYPH), viaJson(DEFAULT_FADER_GLYPH))
  return unique(inputs.map(viaJson))
}

function icons(): void {
  write("icons-safeGlyph.json", glyphInputs().map((input) => {
    const glyph = safeGlyph(input)
    return { input, output: { glyph, svg: glyph ? glyphSvg(glyph) : null } }
  }))
  const names: Json[] = [
    ...ODD, ...Object.keys(ICONS), "Radio", "radio ", "mic_off", "valueOf", "isPrototypeOf",
    TINY_PNG, picture(9, "jpeg"), picture(9, "webp"), picture(9, "svg+xml"), picture(9, "gif"), picture(9, "PNG"), "DATA:IMAGE/SVG+XML;BASE64,QUJD", "data:image/svg xml;base64,QUJD",
    "data:image/png;base64,", "data:image/png;base64,AA AA", "data:image/png;base64,AA\n", "\ndata:image/png;base64,AA", "data:image/png;base64,QUJD+/=", "data:image/png;base64,QUJD-_", "data:image/png;base64,é",
    "data:image/png;base64,QUJD;base64,QUJD", "data:image/pngx;base64,QUJD", "data:image/;base64,QUJD", "data:image/png;BASE64,QUJD", "data:image/KPNG;base64,QUJD", "data:ımage/png;base64,QUJD"
  ]
  write("icons-ids.json", unique(names).map((input) => {
    const output: Record<string, unknown> = { isIconId: isIconId(input), isSafeIconData: isSafeIconData(input) }
    if (typeof input === "string") output.iconSvg = iconSvg(input)
    return { input, output }
  }))
  writeTable("icons-tables.json", { DEFAULT_ICON, ICONS: Object.keys(ICONS).map((id) => [id, ICONS[id]]), ICON_GROUPS })
  writeTable("default-glyphs.json", { DEFAULT_PRESS_GLYPH, DEFAULT_FADER_GLYPH })
}

// ------------------------------------------------------------------ layout

function layout(): void {
  const boxes: Array<{ width: number; height: number; columns: number; rows: number }> = []
  for (const width of [0, 183, 184, 320, 375, 551.5, 768, 1024, 1366]) {
    for (const height of [0, 43, 100, 200, 331, 480, 667, 1024]) {
      for (const columns of [0, 1, 2, 3, 4, 8]) {
        for (const rows of [0, 1, 2, 3, 6]) boxes.push({ width, height, columns, rows })
      }
    }
  }
  // Around each threshold: the 92 px column, the 56 and 44 px rows, the 62 px label, the one pixel of scroll.
  for (let width = 360; width <= 372; width += 0.5) boxes.push({ width, height: 300, columns: 4, rows: 3 })
  for (let height = 120; height <= 200; height += 1) boxes.push({ width: 400, height, columns: 4, rows: 3 }, { width: 300, height, columns: 4, rows: 3 })
  for (const odd of [-100, -1, 0.5, 2.5, 1e-9, 1e9, 1e308, -1e308]) {
    boxes.push({ width: odd, height: 480, columns: 4, rows: 3 }, { width: 800, height: odd, columns: 4, rows: 3 }, { width: 800, height: 480, columns: odd, rows: 3 }, { width: 800, height: 480, columns: 4, rows: odd }, { width: odd, height: odd, columns: odd, rows: odd })
  }
  write("layout-layoutGrid.json", boxes.map((input) => ({ input, output: layoutGrid(input) })))
  writeTable("layout-constants.json", { TILE_MIN, TOUCH_MIN, MAX_ASPECT })
}

// ----------------------------------------------------------------- starters

function starters(): void {
  const decks: Case[] = []
  const whole: Case[] = []
  for (const words of ["echo", "en", "es"] as const) {
    for (const mac of [false, true]) {
      for (const id of STARTER_IDS) {
        const made = idsNow()
        decks.push({ input: { id, mac, words }, ids: made, output: inWords(words, () => starterDeck(id, mac)) })
      }
      const made = idsNow()
      // What a first start saves (src/server/library.ts).
      whole.push({ input: { mac, words }, ids: made, output: inWords(words, () => {
        const library = starterLibrary(mac)
        return { library, normalized: normalizeLibrary({ version: 1, ...library }) }
      }) })
    }
  }
  write("starter-starterDeck.json", decks)
  write("starter-starterLibrary.json", whole)
  const table: Record<string, unknown> = {}
  for (const id of STARTER_IDS) {
    const words = (): { label: string; hint: string } => ({ label: STARTERS[id].label, hint: STARTERS[id].hint })
    table[id] = { echo: words(), en: inWords("en", words) }
  }
  writeTable("starter-tables.json", { STARTER_IDS, starters: table, STARTER_GLYPHS })
}

// ---------------------------------------------------------------------- run

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
steps()
buttons()
libraries()
clock()
actions()
keys()
colors()
themes()
links()
icons()
layout()
starters()
mock.timers.reset()

for (const [name, count] of written) console.log(`${String(count).padStart(6)}  ${name}`)
console.log(`${written.reduce((sum, entry) => sum + entry[1], 0)} cases in ${written.length} files`)
