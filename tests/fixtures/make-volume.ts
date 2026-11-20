// Fixtures for the Rust port of the faders (server/src/audio/{volume,
// app_volume,app_levels}.rs): the TypeScript is run over many inputs and what
// it answers is written to tests/fixtures/volume/*.json as arrays of
// { input, output }. The Rust unit tests read them and must answer the same.
// No real volume is read or set: the Mac answers come from a stand-in
// "osascript" that answers from a file, and the poll runs on stand-in timers.
// Nothing here depends on the clock or on chance, so a second run writes the
// same files.
//   node tests/fixtures/make-volume.ts        (from the repository's root)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type OBSWebSocket from "obs-websocket-js"
import type { Fader, Library } from "../../src/shared/types.ts"
import type { Config } from "../../src/server/config.ts"
import type { ObsLink } from "../../src/server/obs.ts"
import type { VolumeContext } from "../../src/server/volume.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { input: Json; output: Json }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")
const OUT = path.join(HERE, "volume")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-volume-fixtures-"))

// The companion's own modules read the environment when they load.
process.env.PUNCHBOARD_LOCALES_DIR = path.join(ROOT, "public", "locales")
delete process.env.PUNCHBOARD_LOCALE

// A stand-in "osascript", first on PATH, that runs nothing: it answers what
// the file beside it says, and keeps the script it was given.
const BIN = path.join(TMP, "bin")
const OSA_ANSWER = path.join(TMP, "osascript-answer.json")
const OSA_SCRIPT = path.join(TMP, "osascript-script.txt")
fs.mkdirSync(BIN)
fs.writeFileSync(path.join(BIN, "osascript"), `#!${process.execPath}
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(OSA_SCRIPT)}, process.argv[process.argv.indexOf("-e") + 1] || "")
const answer = JSON.parse(fs.readFileSync(${JSON.stringify(OSA_ANSWER)}, "utf8"))
process.stdout.write(answer.stdout)
process.stderr.write(answer.stderr)
process.exit(answer.code)
`, { mode: 0o755 })
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH ?? ""}`

const { normalizeLibrary } = await import("../../src/shared/model.ts")
const { UserError } = await import("../../src/server/i18n.ts")
const { isLevel, readLevel, writeLevel } = await import("../../src/server/volume.ts")
const { parseAppList, stopWindowsVolume } = await import("../../src/server/win-volume.ts")
const { MAC_APPS, appVolumeFor, macVolumeScript, roundLevel } = await import("../../src/server/app-volume.ts")
const { createAppLevels } = await import("../../src/server/app-levels.ts")

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

const numberInput = (value: number): Json => ({ text: String(value), bits: bits(value) })

// --------------------------------------------------------------- the levels

/** Fine steps over the fader's travel, what systems answer (a float's
    worth of a level), ties at three places, and what is not a level at all. */
function levels(): number[] {
  const all: number[] = []
  for (let step = 0; step <= 1000; step += 1) all.push(step / 1000)
  for (let step = 0; step <= 997; step += 1) all.push(step / 997)
  for (let step = 0; step <= 200; step += 1) all.push(Math.fround(step / 200))
  for (let step = 0; step < 64; step += 1) all.push(step / 64 + 1 / 2048)
  const random = sequence(20260821)
  for (let count = 0; count < 600; count += 1) all.push(random())
  for (let count = 0; count < 200; count += 1) all.push(random() * 3 - 1)
  all.push(-0, -1, 2, 100, -1e-9, 1e-9, 1e-300, 5e-324, 0.0005, 0.00049999999999999, 0.0625, 0.9995, 0.99949999, 0.50000006, 0.30000000000000004,
    1 - Number.EPSILON, 1 + Number.EPSILON, 1e21, -1e21, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MIN_VALUE)
  return all
}

/** A context whose OBS answers `mul` and whose calls are kept. */
interface Recorded { what: string; bits?: string; inputName?: string }
function contextFor(soundVolume: number, mul: number, calls: Recorded[]): VolumeContext {
  const socket = {
    call: async (request: string, data?: { inputName?: string; inputVolumeMul?: number }): Promise<{ inputVolumeMul: number }> => {
      const entry: Recorded = { what: request, inputName: data?.inputName ?? "" }
      if (data?.inputVolumeMul !== undefined) entry.bits = bits(data.inputVolumeMul)
      calls.push(entry)
      return { inputVolumeMul: mul }
    }
  } as unknown as OBSWebSocket
  const obs = { connect: async (): Promise<OBSWebSocket> => { calls.push({ what: "connect" }); return socket } } as unknown as ObsLink
  const config: Config = { port: 8787, theme: { name: "studio", accent: "#5fd0d6", accentPreset: "" }, soundVolume, obs: { address: "", password: "", source: "auto" }, supportShown: false, tourShown: false, language: "auto" }
  return {
    obs,
    config,
    saveConfig: () => { calls.push({ what: "save" }) },
    setSoundVolume: (level) => { calls.push({ what: "player", bits: bits(level) }) }
  }
}

const SOUNDS: Fader = { target: "sounds", inputName: "" }
const MIC: Fader = { target: "obs_input", inputName: "Mic" }

{
  const rounded: Case[] = []
  const conversions: Case[] = []
  for (const value of levels()) {
    rounded.push({ input: numberInput(value), output: bits(roundLevel(value)) })
    // The sounds fader reads config.soundVolume through clamp01, the OBS
    // fader reads faderPosition(inputVolumeMul) and writes clamp01(level) ** 3.
    const calls: Recorded[] = []
    const clamped = await readLevel(SOUNDS, contextFor(value, 0, calls))
    const position = await readLevel(MIC, contextFor(1, value, calls))
    if (clamped === null || position === null) throw new Error("a fader with no level")
    let gain = bits(clamped ** 3)
    if (Number.isFinite(value)) {
      const written: Recorded[] = []
      await writeLevel(MIC, value, contextFor(1, 0, written))
      gain = written.find((call) => call.what === "SetInputVolume")?.bits ?? ""
    }
    // What win-volume.ts sends: `level.toFixed(3)`.
    conversions.push({ input: numberInput(value), output: { clamp01: bits(clamped), faderPosition: bits(position), obsGain: gain, fixed3: bits(Number(clamped.toFixed(3))) } })
  }
  write("round-level.json", rounded)
  write("conversions.json", conversions)
}

{
  // As a level arrives: in a JSON body. What JSON cannot say (NaN, Infinity,
  // undefined) arrives as null or not at all.
  const odd: unknown[] = [0, 1, 0.5, -1, 2, 1e21, -0, 1e-7, 5e-324, NaN, Infinity, -Infinity, undefined, null, "", "0.5", "loud", " ", true, false, [], [0.5], {}, { level: 1 }, "1e3", 0.30000000000000004]
  const cases: Case[] = odd.map((value) => {
    const arrived = JSON.parse(JSON.stringify({ level: value === undefined ? null : value })) as { level: Json }
    return { input: arrived.level, output: isLevel(arrived.level) }
  })
  write("is-level.json", cases)
}

{
  // writeLevel for the two targets that need nothing from the system: what
  // is refused, what is kept, and what is called in which order.
  const cases: Case[] = []
  const given: Json[] = [0, 1, 0.5, 0.25, 0.1, 1 / 3, 0.999, 0.001, -1, -0.5, 2, 1.0000001, 100, 1e21, 1e-7, 5e-324, null, "0.5", "loud", "", true, false, [], [0.5], {}]
  for (let step = 0; step <= 40; step += 1) given.push(step / 40)
  for (const fader of [SOUNDS, MIC, { target: "obs_input", inputName: "" } as Fader, { target: "obs_input", inputName: "Música ñ" } as Fader]) {
    for (const level of given) {
      const calls: Recorded[] = []
      let output: Json
      try {
        const context = contextFor(1, 0, calls)
        const answered = await writeLevel(fader, level, context)
        output = { level: bits(answered), soundVolume: bits(context.config.soundVolume), calls: calls.map((call) => ({ ...call })) }
      } catch (error) {
        if (!(error instanceof UserError)) throw error
        output = { error: error.text.key, calls: calls.map((call) => ({ ...call })) }
      }
      cases.push({ input: { target: fader.target, inputName: fader.inputName, level }, output })
    }
  }
  write("write-level.json", cases)
}

// ------------------------------------------------------------ the Mac scripts

{
  const cases: Case[] = []
  const scriptLevels: number[] = []
  for (let step = 0; step <= 200; step += 1) scriptLevels.push(step / 200)
  scriptLevels.push(-0, -1, 2, 0.005, 0.015, 0.025, 0.125, 0.995, 0.9949999, 1e-9, 0.42, 0.55, 1 / 3, 2 / 3, 0.30000000000000004, 1e21, NaN, Infinity, -Infinity)
  const ids = [...Object.values(MAC_APPS).map((app) => app.id), "com.example.\"quoted\"\\app", "com.example.ñandú", "", "line\nbreak\ttab"]
  for (const bundleId of ids) {
    cases.push({ input: { bundleId, level: null }, output: macVolumeScript(bundleId, null) })
    for (const level of scriptLevels) cases.push({ input: { bundleId, level: bits(level) }, output: macVolumeScript(bundleId, level) })
  }
  write("mac-volume-script.json", cases)
  write("mac-apps.json", [{ input: null, output: Object.keys(MAC_APPS).map((key) => ({ key, name: MAC_APPS[key]?.name ?? "", id: MAC_APPS[key]?.id ?? "" })) }])
}

{
  // What Spotify's script answers, and what osascript says when it fails,
  // through the Mac app volume itself and the stand-in osascript.
  const mac = appVolumeFor("darwin")
  const cases: Case[] = []
  const long = `execution error: ${"Spotify got an error:   Can’t get «class pVol».\n\t ".repeat(12)}(-1728)`
  const runs: { stdout: string; stderr: string; code: number }[] = [
    ...["42", "0", "100", "55", "250", "-5", "33.3", "99.95", "0.5", "1e1", "0x10", "Infinity", "-Infinity", "NaN", "", "closed", "Closed", "closed ", "missing value", "42 43", "４２", "30\n", "  7  ", "\n", "0.05", "100.04", "12abc"]
      .map((stdout) => ({ stdout, stderr: "", code: 0 })),
    ...[
      "execution error: Not authorized to send Apple events to com.spotify.client. (-1743)",
      "execution error: Not authorised to send Apple events to Spotify.",
      "NOT AUTHORIZED", "error -1743", "something (-17430)",
      "42:79: execution error: Spotify got an error: Can’t get «class pVol». (-1728)",
      "syntax error:\n  Expected end of line   but found identifier.\r\n(-2741)",
      long, "  padded  ", "tab\tand no-break line", "emoji 🎚️ ".repeat(40), "x".repeat(199) + "🎚️🎚️", "not  authorized"
    ].map((stderr) => ({ stdout: "", stderr, code: 1 }))
  ]
  for (const run of runs) {
    fs.writeFileSync(OSA_ANSWER, JSON.stringify(run))
    const failed = run.code !== 0
    const input: Json = failed ? { kind: "error", text: run.stderr.trim() } : { kind: "answer", text: run.stdout.trim() }
    try {
      const level = await mac.read("spotify")
      cases.push({ input, output: { level: level === null ? null : bits(level) } })
    } catch (error) {
      if (!(error instanceof UserError)) throw error
      // The reason is cut at 200 UTF-16 units, which can leave half of a
      // character outside the basic plane. Rust cannot hold half a
      // character and leaves it out whole, so the half is taken out here.
      const message = error.message.replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "")
      cases.push({ input, output: { key: error.text.key, message } })
    }
  }
  write("mac-answer.json", cases)
}

// ---------------------------------------------------- the Windows app list

const LISTS: string[] = [
  "[]",
  '[{"key":"chrome","name":"Google Chrome","level":0.5},{"key":"x"},{"name":"no key"},7,{"key":"caf\\u00e9","name":"Caf\\u00e9 \\"Bar\\"","level":"2"}]',
  '[{"key":"spotify","name":"Spotify \\u00c4","level":1},{"key":"chrome","name":"Google Chrome","level":0.25}]',
  '[{"key":"discord","name":"  Discord  ","level":0.50000006},{"key":"vlc","name":"   ","level":0.3},{"key":"game","name":"","level":0}]',
  '[{"key":"a","name":"A","level":-1},{"key":"b","name":"B","level":7},{"key":"c","name":"C","level":"0.25"},{"key":"d","name":"D","level":null},{"key":"e","name":"E","level":true},{"key":"f","name":"F","level":[0.75]},{"key":"g","name":"G","level":{}},{"key":"h","name":"H","level":"loud"},{"key":"i","name":"I"}]',
  '[{"key":"","name":"empty key","level":1},{"key":7,"name":"number key","level":1},{"key":null,"name":"null key"},{"key":["x"],"name":"list key"},null,"text",true,[],[{"key":"nested"}],{}]',
  '[{"key":"obs64","name":7,"level":0.1},{"key":"steam","name":null,"level":0.2},{"key":"foobar2000","name":["x"],"level":0.3},{"key":"mpc-hc64","name":{"a":1},"level":0.4}]',
  '[{"key":"\\u30b2\\u30fc\\u30e0","name":"\\u30b2\\u30fc\\u30e0 \\u00b7 \\u00d1and\\u00fa","level":0.75},{"key":"emoji","name":"\\ud83c\\udfb5 Player","level":0.6}]',
  '[{"key":"tabs","name":"\\tTabbed\\u00a0Name\\n","level":0.5},{"key":"bom","name":"\\ufeffBom\\u2028","level":0.5}]',
  '[{"key":"chrome","name":"One","level":0.1},{"key":"chrome","name":"Two","level":0.2}]',
  '[{"level":0.5,"name":"Order","key":"order","extra":true}]',
  '[{"key":"sci","name":"Sci","level":5e-1},{"key":"tiny","name":"Tiny","level":1e-7},{"key":"neg0","name":"Neg","level":-0}]',
  '[{"key":"k","name":"dup","name":"Last wins","level":0.1,"level":0.9}]',
  ' [ { "key" : "spaced" , "name" : "Spaced" , "level" : 0.125 } ] ',
  '{"key":"chrome","name":"Not a list","level":0.5}',
  "oops", "", "null", "7", '"text"', "true", "[", '[{"key":"chrome",}]', "[1,2", "undefined", "[]]",
  '[{"key":"battle.net","name":"Battle.net","level":0.333333}]',
  '[{"key":"a b","name":"A B","level":"  0.5  "},{"key":"hex","name":"Hex","level":"0x1"},{"key":"inf","name":"Inf","level":"Infinity"},{"key":"blank","name":"Blank","level":""}]'
]
for (let count = 1; count <= 12; count += 1) {
  const random = sequence(count * 7919)
  const names = ["Zoom", "Älpha", "alpha", "Beta", "beta 2", "Éclair", "eclair", "Google Chrome", "Spotify", "Discord", "OBS Studio", "vlc", "VLC media player", "Firefox", "Microsoft Edge", "Steam", "foobar2000", "7-Zip", "Ñandú", "Zed"]
  const items: string[] = []
  for (let index = 0; index < 3 + count; index += 1) {
    const name = names[Math.floor(random() * names.length)] ?? "App"
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, "") || "app"
    items.push(`{"key":${JSON.stringify(`${key}${index}`)},"name":${JSON.stringify(name).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)},"level":${Math.round(random() * 1e6) / 1e6}}`)
  }
  LISTS.push(`[${items.join(",")}]`)
}

{
  const cases: Case[] = LISTS.map((text): Case => {
    try {
      return { input: text, output: { apps: parseAppList(text).map((app) => ({ key: app.key, name: app.name, level: bits(app.level) })) } }
    } catch (error) {
      if (!(error instanceof UserError)) throw error
      return { input: text, output: { error: error.text.key } }
    }
  })
  write("parse-app-list.json", cases)
}

{
  // The picker's list on Windows: what the Windows app volume makes of the
  // bridge's list (named, rounded, in order), through a stand-in
  // "powershell" that speaks the bridge's protocol and answers "list" from a
  // file.
  const listFile = path.join(TMP, "win-list.txt")
  fs.writeFileSync(path.join(BIN, "powershell"), `#!${process.execPath}
const fs = require("node:fs")
process.stdout.write("ready\\n")
let pending = ""
process.stdin.on("data", (chunk) => {
  pending += chunk
  const lines = pending.split("\\n")
  pending = lines.pop()
  for (const line of lines) {
    const id = line.slice(0, line.indexOf(" "))
    process.stdout.write(id + " ok " + fs.readFileSync(${JSON.stringify(listFile)}, "utf8") + "\\n")
  }
})
`, { mode: 0o755 })
  const windows = appVolumeFor("win32")
  const cases: Case[] = []
  for (const text of LISTS) {
    // One line, as the bridge writes it; what is not a list is its own fixture.
    if (text.includes("\n")) continue
    try { parseAppList(text) } catch { continue }
    fs.writeFileSync(listFile, text)
    const list = await windows.list()
    const output: { [key: string]: Json } = { platform: list.platform, apps: list.apps.map((app) => ({ ...app })) }
    if (list.note) output.note = list.note.key
    cases.push({ input: text.trim(), output })
  }
  stopWindowsVolume()
  write("mixer-list.json", cases)
}

// ------------------------------------------------------------------ the poll

// Stand-in timers: time is a number that moves a millisecond at a time, and a
// timer runs when time reaches it, in the order they were set.
interface FakeTimer { id: number; at: number; run: () => void; unref: () => FakeTimer; ref: () => FakeTimer; hasRef: () => boolean }
let now = 0
let timerIds = 0
let pending: FakeTimer[] = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSetImmediate = globalThis.setImmediate
function fakeSetTimeout(run: () => void, delay = 0): FakeTimer {
  timerIds += 1
  const timer: FakeTimer = { id: timerIds, at: now + Math.max(0, delay), run, unref: () => timer, ref: () => timer, hasRef: () => false }
  pending.push(timer)
  return timer
}
function fakeClearTimeout(timer?: FakeTimer): void {
  if (timer) pending = pending.filter((entry) => entry !== timer)
}
/** Lets every promise that can settle, settle. */
const settle = (): Promise<void> => new Promise((resolve) => { realSetImmediate(resolve) })
/** Runs what is due, and what that makes due at once. */
async function runDue(): Promise<void> {
  await settle()
  for (;;) {
    const due = pending.filter((timer) => timer.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (!due) return
    pending = pending.filter((timer) => timer !== due)
    due.run()
    await settle()
  }
}

type RawLibrary = { version: number; activeProfileId: string; profiles: { id: string; name: string; buttons: Json[] }[] }
/** A library whose faders point at these apps; null is a fader on something
    else, "" an app fader with no app yet. */
function libraryWith(apps: (string | null)[]): RawLibrary {
  const buttons: Json[] = apps.map((app, slot) => {
    const fader: { [key: string]: Json } = app === null ? { target: "system", inputName: "", app: "ignored" } : app === "" ? { target: "app", inputName: "" } : { target: "app", inputName: "", app }
    return { id: `b${slot}`, slot, label: "", control: "fader", fader, steps: [] }
  })
  buttons.push({ id: "press", slot: apps.length, label: "Press", steps: [] })
  return { version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons }] }
}

type PollEvent =
  | { at: number; do: "devices"; connected: boolean }
  | { at: number; do: "level"; key: string; level: number | null }
  | { at: number; do: "fail"; key: string; failing: boolean }
  | { at: number; do: "readMs"; ms: number }
  | { at: number; do: "write"; key: string; level: number }
  | { at: number; do: "library"; library: RawLibrary }
  | { at: number; do: "update" }
  | { at: number; do: "stop" }
interface Scenario { name: string; intervalMs: number; library: RawLibrary; events: PollEvent[]; runFor: number }

const BOTH = libraryWith(["spotify", "chrome", "chrome", null, ""])
const SCENARIOS: Scenario[] = [
  { name: "nothing is read while no device is connected", intervalMs: 60, library: BOTH, runFor: 200, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "update" }, { at: 90, do: "update" }] },
  { name: "nothing is read when no fader points at an app", intervalMs: 60, library: libraryWith([null, ""]), runFor: 200, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 5, do: "devices", connected: true }, { at: 100, do: "update" }] },
  { name: "a device connecting starts it, and only changes go out", intervalMs: 60, library: BOTH, runFor: 520, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 }, { at: 0, do: "update" },
    { at: 33, do: "devices", connected: true },
    { at: 257, do: "level", key: "spotify", level: 0.8 },
    { at: 371, do: "level", key: "chrome", level: null },
    { at: 441, do: "level", key: "chrome", level: 0.2 }] },
  { name: "an app that was never open is unknown, quietly", intervalMs: 60, library: BOTH, runFor: 200, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 3, do: "devices", connected: true }] },
  { name: "a round never undoes a deck write made while it read", intervalMs: 60, library: BOTH, runFor: 700, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 },
    { at: 1, do: "devices", connected: true },
    { at: 100, do: "readMs", ms: 40 },
    { at: 140, do: "write", key: "spotify", level: 0.3 },
    { at: 265, do: "write", key: "chrome", level: 0.9 },
    { at: 400, do: "readMs", ms: 0 }] },
  { name: "a write before the round starts is read back as it is", intervalMs: 60, library: BOTH, runFor: 200, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "write", key: "spotify", level: 0.7 },
    { at: 10, do: "devices", connected: true }, { at: 100, do: "level", key: "spotify", level: 0.75 }] },
  { name: "a read that fails keeps what the decks show", intervalMs: 60, library: BOTH, runFor: 400, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 },
    { at: 1, do: "devices", connected: true },
    { at: 90, do: "fail", key: "spotify", failing: true }, { at: 95, do: "level", key: "spotify", level: 0.1 }, { at: 95, do: "level", key: "chrome", level: 0.25 },
    { at: 250, do: "fail", key: "spotify", failing: false }] },
  { name: "it stops when no fader needs it and starts again with a new one", intervalMs: 60, library: BOTH, runFor: 600, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 }, { at: 0, do: "level", key: "discord", level: 0.6 },
    { at: 1, do: "devices", connected: true },
    { at: 150, do: "library", library: libraryWith([]) },
    { at: 300, do: "library", library: libraryWith(["discord"]) },
    { at: 450, do: "library", library: libraryWith(["discord", "spotify"]) }] },
  { name: "the library replaced during a slow round", intervalMs: 60, library: BOTH, runFor: 500, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 }, { at: 0, do: "readMs", ms: 50 },
    { at: 1, do: "devices", connected: true },
    { at: 20, do: "library", library: libraryWith([]) },
    { at: 230, do: "library", library: libraryWith(["chrome"]) }] },
  { name: "it stops when the last device leaves, also in the middle of a round", intervalMs: 60, library: BOTH, runFor: 600, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 },
    { at: 1, do: "devices", connected: true },
    { at: 100, do: "devices", connected: false },
    { at: 200, do: "readMs", ms: 30 }, { at: 210, do: "devices", connected: true },
    { at: 225, do: "devices", connected: false }, { at: 226, do: "level", key: "spotify", level: 0.9 },
    { at: 400, do: "devices", connected: true }] },
  { name: "a device back while a round still reads does not start a second", intervalMs: 60, library: BOTH, runFor: 400, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 }, { at: 0, do: "readMs", ms: 45 },
    { at: 1, do: "devices", connected: true }, { at: 10, do: "devices", connected: false }, { at: 20, do: "devices", connected: true },
    { at: 30, do: "update" }, { at: 31, do: "update" }] },
  { name: "updates while a round waits change nothing", intervalMs: 60, library: BOTH, runFor: 300, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 1, do: "devices", connected: true },
    { at: 20, do: "update" }, { at: 40, do: "update" }, { at: 59, do: "update" }, { at: 130, do: "update" }] },
  { name: "stopped in the middle of a round, nothing more goes out", intervalMs: 60, library: BOTH, runFor: 400, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 0, do: "level", key: "chrome", level: 0.2 }, { at: 0, do: "readMs", ms: 40 },
    { at: 1, do: "devices", connected: true },
    { at: 150, do: "level", key: "spotify", level: 0.9 }, { at: 215, do: "stop" }, { at: 300, do: "update" }] },
  { name: "stopped while waiting", intervalMs: 60, library: BOTH, runFor: 300, events: [
    { at: 0, do: "level", key: "spotify", level: 0.5 }, { at: 1, do: "devices", connected: true }, { at: 30, do: "stop" }, { at: 100, do: "devices", connected: true }] },
  { name: "the usual two and a half seconds", intervalMs: 2500, library: libraryWith(["music"]), runFor: 5600, events: [
    { at: 0, do: "level", key: "music", level: 0.7 }, { at: 400, do: "devices", connected: true },
    { at: 3000, do: "level", key: "music", level: 0.65 }, { at: 5000, do: "level", key: "music", level: null }] }
]

{
  globalThis.setTimeout = fakeSetTimeout as unknown as typeof setTimeout
  globalThis.clearTimeout = fakeClearTimeout as unknown as typeof clearTimeout
  const cases: Case[] = []
  for (const scenario of SCENARIOS) {
    now = 0
    pending = []
    const log: { [key: string]: Json }[] = []
    const note = (entry: { [key: string]: Json }): void => { log.push({ at: now, ...entry }) }
    const system: Record<string, number> = {}
    const failing = new Set<string>()
    let readMs = 0
    let watched = false
    let library: Library = normalizeLibrary(scenario.library)
    // The levels the decks show, kept the way events.ts keeps them: a
    // broadcast only when one really moved. (events.ts's setLevels and
    // dropLevels, without the stream.)
    const shown: Record<string, number> = {}
    const broadcast = (): void => note({ what: "broadcast", levels: { ...shown } })
    const setLevels = (changes: Record<string, number>): void => {
      let changed = false
      for (const key of Object.keys(changes)) {
        const value = changes[key]
        if (value === undefined || shown[key] === value) continue
        shown[key] = value
        changed = true
      }
      if (changed) broadcast()
    }
    const dropLevels = (keys: string[]): void => {
      let changed = false
      for (const key of keys) {
        if (!(key in shown)) continue
        delete shown[key]
        changed = true
      }
      if (changed) broadcast()
    }
    const poll = createAppLevels({
      library: () => library,
      watched: () => watched,
      read: async (key) => {
        note({ what: "read", key })
        // The level is taken now; a slow read answers it late, as a busy system would.
        const level = system[key] ?? null
        const fails = failing.has(key)
        if (readMs > 0) await new Promise<void>((resolve) => { setTimeout(resolve, readMs) })
        if (fails) throw new Error("The helper failed.")
        return level
      },
      setLevels: (changes) => {
        note({ what: "setLevels", levels: Object.keys(changes).map((key) => [key, changes[key] ?? null]) })
        setLevels(changes)
      },
      dropLevels: (keys) => {
        note({ what: "dropLevels", keys: [...keys] })
        dropLevels(keys)
      },
      intervalMs: scenario.intervalMs
    })
    for (let at = 0; at <= scenario.runFor; at += 1) {
      now = at
      for (const event of scenario.events.filter((entry) => entry.at === at)) {
        if (event.do === "devices") { watched = event.connected; poll.update() }
        else if (event.do === "level") { if (event.level === null) delete system[event.key]; else system[event.key] = event.level }
        else if (event.do === "fail") { if (event.failing) failing.add(event.key); else failing.delete(event.key) }
        else if (event.do === "readMs") readMs = event.ms
        else if (event.do === "write") {
          // What /api/volume does: stamp the key, set the app, record the level.
          poll.noteWrite(`app:${event.key}`)
          system[event.key] = event.level
          setLevels({ [`app:${event.key}`]: event.level })
        }
        else if (event.do === "library") { library = normalizeLibrary(event.library); poll.update() }
        else if (event.do === "update") poll.update()
        else poll.stop()
        note({ what: "active", value: poll.active() })
      }
      await runDue()
      now = at + 1
      await runDue()
    }
    poll.stop()
    const input = JSON.parse(JSON.stringify({ name: scenario.name, intervalMs: scenario.intervalMs, library: scenario.library, events: scenario.events, runFor: scenario.runFor })) as Json
    cases.push({ input, output: { log, anyRead: log.some((entry) => entry.what === "read") } })
  }
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  write("app-levels.json", cases)
}

fs.rmSync(TMP, { recursive: true, force: true })
for (const name of Object.keys(counts).sort()) console.log(`${String(counts[name]).padStart(8)}  ${name}`)
