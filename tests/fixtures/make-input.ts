// Writes tests/fixtures/input/*.json: what the TypeScript companion works out
// before it touches the keyboard or the mouse (src/server/keys.ts,
// src/server/pointer.ts) and how it reads a recorded trackpad trace
// (src/shared/touchpad/trace.ts). The Rust companion (server/src/keys,
// server/src/pointer, server/src/touch_trace.rs) reads these files in its
// tests and must give the same answers.
//   node tests/fixtures/make-input.ts
//
// Each file is a list of { input, output }. Nothing here presses a key or
// moves the pointer, and running it twice writes the same files.
import fs from "node:fs"
import path from "node:path"
import { MAC_CODES, WIN_MODIFIER_SCAN_CODES, WIN_SCAN_CODES, macMediaScript, macScript, windowsInputs, windowsMediaLine } from "../../src/server/keys.ts"
import { pointerLine } from "../../src/server/pointer.ts"
import { comboToString, KEY_NAMES, MODIFIERS } from "../../src/shared/keys.ts"
import type { KeyCombo, Modifier } from "../../src/shared/keys.ts"
import { isTouchFrame, isTouchpadEvent, summarize, TRACE_LIMITS } from "../../src/shared/touchpad/trace.ts"
import type { TouchpadEvent } from "../../src/shared/touchpad/types.ts"
import type { MediaKey } from "../../src/shared/types.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { input: Json; output: unknown }

const ROOT = path.resolve(import.meta.dirname, "../..")
const OUT = path.join(ROOT, "tests/fixtures/input")
const TRACES = path.join(ROOT, "tests/touchpad-traces")

const written: Array<[string, number]> = []

function write(name: string, cases: Case[]): void {
  const text = `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`
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

/** Numbers that repeat on every run, where "any number" is wanted. */
function sequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

const isFields = (value: unknown): value is { [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value)

/** What an error said, as the key and values it was made with. */
function thrown(error: unknown): unknown {
  if (isFields(error) && isFields(error.text)) return error.text
  throw error
}

// --------------------------------------------------------------------- keys

/** Every set of modifiers, each in the fixed order. */
function modifierSets(): Modifier[][] {
  const sets: Modifier[][] = []
  for (let bits = 0; bits < 1 << MODIFIERS.length; bits += 1) sets.push(MODIFIERS.filter((_, index) => (bits & (1 << index)) !== 0))
  return sets
}

/** What System Events is asked for, read back out of the AppleScript. */
const MAC_MODIFIER_WORDS: Record<string, Modifier> = { "control down": "ctrl", "option down": "alt", "shift down": "shift", "command down": "meta" }

function macKey(combo: KeyCombo): { code: number; modifiers: Modifier[] } {
  const script = macScript(combo)
  const match = /^tell application "System Events" to key code (\d+)(?: using \{([^}]*)\})?$/.exec(script)
  if (!match) throw new Error(`An AppleScript this generator cannot read: ${script}`)
  const modifiers = (match[2] ?? "").split(", ").filter(Boolean).map((word) => {
    const modifier = MAC_MODIFIER_WORDS[word]
    if (!modifier) throw new Error(`A modifier this generator cannot read: ${word}`)
    return modifier
  })
  return { code: Number(match[1]), modifiers }
}

/** The NX_KEYTYPE_* number in the JXA for one music key. */
function macMediaCode(key: MediaKey): number {
  const match = /\((\d+) << 16\)/.exec(macMediaScript(key))
  if (!match) throw new Error(`No key type in the music key script for ${key}`)
  return Number(match[1])
}

/** The virtual key in the key helper's command for one music key. */
function windowsMediaCode(key: MediaKey): number {
  const match = /^media (\d+)$/.exec(windowsMediaLine(key))
  if (!match) throw new Error(`No virtual key in the music key command for ${key}`)
  return Number(match[1])
}

const MEDIA: MediaKey[] = ["play_pause", "next", "previous"]

function keys(): void {
  const macMedia: Record<string, number> = {}
  const windowsMedia: Record<string, number> = {}
  for (const key of MEDIA) {
    macMedia[key] = macMediaCode(key)
    windowsMedia[key] = windowsMediaCode(key)
  }
  writeTable("keys-tables.json", { KEY_NAMES, MODIFIERS, MAC_CODES, WIN_SCAN_CODES, WIN_MODIFIER_SCAN_CODES, MAC_MEDIA: macMedia, WIN_MEDIA: windowsMedia })

  const windows: Case[] = []
  const mac: Case[] = []
  for (const key of KEY_NAMES) {
    for (const modifiers of modifierSets()) {
      const combo: KeyCombo = { modifiers, key }
      const input = comboToString(combo)
      try {
        windows.push({ input, output: { inputs: windowsInputs(combo) } })
      } catch (error) {
        windows.push({ input, output: { error: thrown(error) } })
      }
      try {
        mac.push({ input, output: macKey(combo) })
      } catch (error) {
        mac.push({ input, output: { error: thrown(error) } })
      }
    }
  }
  write("keys-windows.json", windows)
  write("keys-mac.json", mac)
}

// ------------------------------------------------------------------ pointer

/** What a deck, or anything else that reaches the socket, can put in a message. */
const NUMBERS: Json[] = [
  0, 1, -1, 2, 3, 4, 5, 7, 12, -4, 30, 0.4, 0.5, -0.5, 0.49, -0.51, 1.5, 2.5, -2.5, 399.4, 399.5, 400, 400.5, 401, -400.5, 1999.5, 2000, 2000.5, -2001, 9999,
  -9999, 1e21, -1e21, 1e-7, 5e-324, 0.05, -0.05, 0.03125, -0.03125, 0.09375, 0.46875, 0.00005, -0.00001, 0.12345, 0.123449, 0.49999, 0.5001, 0.6, -0.6
]
const WORDS: Json[] = [
  "left", "right", "middle", "begin", "change", "end", "up", "down", "tap", "spread", "pinch", "app", "sideways", "toString", "constructor", "hasOwnProperty",
  "__proto__", "", " ", "12", " 7 ", "-3.5", "0x10", "1e2", "1", "-1", "Infinity", "-Infinity", "NaN", "abc", "LEFT", "Begin"
]
const OTHERS: Json[] = [null, true, false, [], [5], ["3"], [1, 2], [[4]], {}, { valueOf: 1 }]
const ANYTHING: Json[] = [...NUMBERS, ...WORDS, ...OTHERS]

function pointer(): void {
  const messages: Json[] = [
    // What tests/trackpad.test.mjs sends, to begin with.
    ["m", 12, -4], ["s", 0, 30], ["c", "left"], ["c", "right"], ["m", 9999, 0], ["x", 1], ["c", "middle"], "junk", ["d"], ["m", 3, 3],
    ["p", "begin", 0], ["p", "change", 0.5], ["p", "change", 0.05], ["p", "end", 0], ["p", "sideways", 1], ["p", "change", "big"],
    ["g", 3, "up"], ["z", 1], ["g", 5, "up"], ["g", 3, "sideways"], ["z", 7], ["u"],
    // Not a list at all.
    null, true, 0, 7, "", "m", {}, { 0: "m", 1: 1, 2: 2 }, [], [[]], [["m"], 1, 2], [null], [1, 2, 3], ["M", 1, 2], ["", 1, 2], [" m", 1, 2],
    // Longer than it needs to be: the rest is not read.
    ["m", 1, 2, 3], ["d", "left"], ["u", 1, 2], ["c", "left", "right"], ["z", -1, 5], ["g", 4, "left", "extra"]
  ]
  for (const kind of ["m", "s", "c", "d", "u", "z", "p", "g", "k", "q", "app", "pinch"]) {
    messages.push([kind])
    for (const a of ANYTHING) {
      messages.push([kind, a])
      // A second value only matters to these.
      if (kind === "m" || kind === "s") {
        for (const b of [0, 1, -7, 2.5, -2.5, 400.5, 2000.5, -9999, "8", "", "x", null, true, [], [6], {}] satisfies Json[]) messages.push([kind, a, b])
      }
    }
  }
  // Moves and scrolls with every second value too.
  for (const b of ANYTHING) messages.push(["m", 5, b], ["s", -5, b])
  // A pinch: every phase with every magnification.
  for (const phase of ["begin", "change", "end", "cancel", 1, 2, 4, null] satisfies Json[]) {
    for (const b of ANYTHING) messages.push(["p", phase, b])
  }
  // A gesture: every number of fingers with every name.
  for (const fingers of [3, 4, 2, 5, 0, 3.5, "3", "4", null, true, [3]] satisfies Json[]) {
    for (const name of [...WORDS, ...OTHERS, 3, 0]) messages.push(["g", fingers, name])
  }
  const random = sequence(20260930)
  for (let i = 0; i < 300; i += 1) {
    const dx = (random() - 0.5) * 1000
    const dy = (random() - 0.5) * 5000
    messages.push(["m", dx, dy], ["s", dx, dy], ["p", i % 2 ? "change" : "begin", (random() - 0.5) * 1.2])
  }
  const cases: Case[] = unique(messages).map((input) => ({
    input,
    output: { darwin: pointerLine(input, "darwin"), win32: pointerLine(input, "win32"), linux: pointerLine(input, "linux") }
  }))
  write("pointer-lines.json", cases)
}

// ------------------------------------------------------------------- traces

function readTraces(): Array<{ name: string; frames: Json[]; events: Json[]; expected: Json }> {
  return fs.readdirSync(TRACES).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const trace: unknown = JSON.parse(fs.readFileSync(path.join(TRACES, name), "utf8"))
    if (!isFields(trace) || !Array.isArray(trace.frames) || !Array.isArray(trace.events)) throw new Error(`${name} is not a trace`)
    return { name, frames: trace.frames as Json[], events: trace.events as Json[], expected: trace.expected as Json }
  })
}

const BUTTONS: Json[] = ["left", "right", "middle"]
const DIRECTIONS: Json[] = ["up", "down", "left", "right"]

/** Every event the engine can make, then the ways one can be wrong. */
function eventInputs(): Json[] {
  const events: Json[] = []
  for (const dx of [0, 1.5, -3, "1", null, true] satisfies Json[]) events.push({ type: "move", dx, dy: 2 }, { type: "move", dx: 2, dy: dx }, { type: "move", dx })
  for (const button of [...BUTTONS, "LEFT", "", 1, null, ["left"], ["left", "right"], [["middle"]], {}, true] satisfies Json[]) {
    for (const state of ["down", "up", "DOWN", "", 1, null, ["up"]] satisfies Json[]) events.push({ type: "button", button, state })
    events.push({ type: "button", button })
  }
  for (const phase of ["begin", "change", "end", "momentum", "start", "", 1, null, ["end"], ["begin", "end"]] satisfies Json[]) {
    events.push({ type: "scroll", phase, dx: 0, dy: -12.5 }, { type: "scroll", phase, dx: "0", dy: 1 }, { type: "scroll", phase, dx: 1 }, { type: "scroll", phase })
    events.push({ type: "pinch", phase, scale: 1.02 }, { type: "pinch", phase, scale: "1" }, { type: "pinch", phase })
  }
  for (const fingers of [3, 4, 2, 5, 3.5, "3", "4", null, [3], [4], true] satisfies Json[]) {
    for (const direction of [...DIRECTIONS, "UP", "sideways", "", 1, null, ["up"]] satisfies Json[]) events.push({ type: "swipe", fingers, direction })
    for (const gesture of ["spread", "pinch", "tap", "", 1, null, ["spread"]] satisfies Json[]) events.push({ type: "fingers", fingers, gesture })
    events.push({ type: "tap", fingers }, { type: "swipe", fingers }, { type: "fingers", fingers })
  }
  events.push({ type: "tap" }, { type: "move" }, { type: "button" }, { type: "scroll" }, { type: "pinch" }, { type: "swipe" }, { type: "fingers" })
  for (const type of ["", "Move", "click", "unknown", 1, null, true, ["move"], {}] satisfies Json[]) events.push({ type, dx: 1, dy: 1 })
  events.push({}, { dx: 1, dy: 1 }, null, true, 0, 5, "move", "", [], [{ type: "move", dx: 1, dy: 1 }], ["move", 1, 1])
  // Fields nobody asked for do not spoil an event.
  events.push({ type: "move", dx: 1, dy: 1, extra: true }, { type: "tap", fingers: 3, at: 12 })
  return events
}

function frameInputs(recorded: Json[]): Json[] {
  const contact = (id: Json, x: Json, y: Json): Json => ({ id, x, y })
  const many = (count: number): Json[] => Array.from({ length: count }, (_, index) => contact(index, index * 10, index * 20))
  const frames: Json[] = [...recorded]
  for (const time of [0, 16.6, -1, 1e21, "0", "", null, true, [], [1], {}] satisfies Json[]) {
    frames.push({ time, contacts: [] }, { time, contacts: [contact(1, 2, 3)] }, { time })
  }
  const lists: Json[] = [[], null, {}, "", 0, true, "contacts", { length: 0 }, [null], [[]], [1], ["a"], [{}], [[contact(1, 2, 3)]]]
  for (const contacts of lists) frames.push({ time: 5, contacts })
  for (const count of [1, 2, 9, 10, 11, 12, 40]) frames.push({ time: 5, contacts: many(count) })
  for (const value of [0, -4, 7.25, 1e300, "1", "", null, true, [], [2], {}] satisfies Json[]) {
    frames.push({ time: 5, contacts: [contact(value, 2, 3)] }, { time: 5, contacts: [contact(1, value, 3)] }, { time: 5, contacts: [contact(1, 2, value)] })
    frames.push({ time: 5, contacts: [contact(1, 2, 3), contact(value, 2, 3)] })
  }
  frames.push({ time: 5, contacts: [{ id: 1, x: 2 }] }, { time: 5, contacts: [{ id: 1, y: 2 }] }, { time: 5, contacts: [{ x: 1, y: 2 }] }, { time: 5, contacts: [{ id: 1, x: 2, y: 3, force: 0.5 }] })
  for (const cancelled of [true, false, null, 0, 1, "", "true", [], {}] satisfies Json[]) {
    frames.push({ time: 5, contacts: [], cancelled }, { time: 5, contacts: [contact(1, 2, 3)], cancelled })
  }
  frames.push({}, { contacts: [] }, null, true, 0, 5, "", "frame", [], [{ time: 5, contacts: [] }], { time: 5, contacts: [], extra: "kept" })
  return frames
}

/** Whether `summarize` can be asked about this at all: it reads each
    event's type, which only something that is not null has. */
const hasType = (value: Json): boolean => value !== null

function traces(): void {
  const recorded = readTraces()
  writeTable("trace-limits.json", TRACE_LIMITS)

  const frames = unique(frameInputs(recorded.flatMap((trace) => trace.frames)))
  write("trace-frames.json", frames.map((input) => ({ input, output: isTouchFrame(input) })))

  const events = unique([...recorded.flatMap((trace) => trace.events), ...eventInputs()])
  write("trace-events.json", events.map((input) => ({ input, output: isTouchpadEvent(input) })))

  // Summaries: the recorded traces whole, every event alone, then long
  // runs of well-formed events and of anything at all, where runs fold and
  // a press followed by its release becomes a click.
  // Asked the way the companion is: about events fresh out of JSON, so no
  // two of them are the same object even where this file repeats one.
  const ask = (input: Json[]): Case => ({ input, output: summarize(JSON.parse(JSON.stringify(input)) as TouchpadEvent[]) })
  const summaries: Case[] = recorded.map((trace) => ({ input: trace.events, output: summarize(trace.events as unknown as TouchpadEvent[]), name: trace.name, expected: trace.expected }))
  const askable = events.filter(hasType)
  const wellFormed = askable.filter((event) => isTouchpadEvent(event))
  summaries.push(ask([]))
  for (const event of askable) summaries.push(ask([event]), ask([event, event]))
  const random = sequence(1750000000)
  const pick = (from: Json[]): Json => from[Math.floor(random() * from.length)] ?? null
  for (let i = 0; i < 400; i += 1) {
    const from = i % 4 === 3 ? askable : wellFormed
    const length = 2 + Math.floor(random() * 30)
    const run: Json[] = []
    while (run.length < length) {
      const event = pick(from)
      // Runs, so there is something to fold.
      const times = random() < 0.4 ? 1 + Math.floor(random() * 4) : 1
      for (let n = 0; n < times; n += 1) run.push(event)
    }
    summaries.push(ask(run))
  }
  // A press against a release, for the click: the same button, another
  // one, and buttons that are not buttons at all.
  const paired = unique<Json>(["left", "right", 1, null, ["left"], {}]).map((button) => JSON.stringify(button))
  const presses = askable.filter((event) => isFields(event) && event.type === "button" && paired.includes(JSON.stringify(event.button ?? "none")))
  for (const first of presses) for (const second of presses) summaries.push(ask([first, second]))
  write("trace-summaries.json", unique(summaries))
}

// ---------------------------------------------------------------------- run

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
keys()
pointer()
traces()

for (const [name, count] of written) console.log(`${String(count).padStart(6)}  ${name}`)
console.log(`${written.reduce((sum, entry) => sum + entry[1], 0)} cases in ${written.length} files`)
