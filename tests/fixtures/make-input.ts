// Writes the live files of tests/fixtures/input: trace-*.json, how the code
// shared with the deck reads a recorded trackpad trace
// (src/shared/touchpad/trace.ts). The Rust companion's copy
// (server/src/touch_trace.rs) reads them in its tests and must give the same
// answers. The folder's other files (keys-*.json, pointer-lines.json) are
// frozen records of the Node companion (tests/fixtures/README.md) and are
// left as they are.
//   node tests/fixtures/make-input.ts       (npm run fixtures runs them all)
//
// Each file is a list of { input, output }, and running it twice writes the
// same files.
import fs from "node:fs"
import path from "node:path"
import { isTouchFrame, isTouchpadEvent, summarize, TRACE_LIMITS } from "../../src/shared/touchpad/trace.ts"
import type { TouchpadEvent } from "../../src/shared/touchpad/types.ts"


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

fs.mkdirSync(OUT, { recursive: true })
traces()

for (const [name, count] of written) console.log(`${String(count).padStart(6)}  ${name}`)
console.log(`${written.reduce((sum, entry) => sum + entry[1], 0)} cases in ${written.length} files`)
