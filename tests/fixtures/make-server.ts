// Writes tests/fixtures/server/*.json: what the TypeScript companion answers
// where the top of the server has a Rust twin (server/src/actions.rs,
// events.rs and the QR code server.rs prints at start). The Rust unit tests
// read these files and must give the same answers.
//   node tests/fixtures/make-server.ts        (from the repository's root)
//
// Each file is a list of { input, output } cases. Nothing here presses a key,
// opens anything or plays a sound: only steps that stop before reaching the
// computer are run, timers are replaced by ones that count the wait and call
// back at once, and the player and the streams are stand-ins. Running this
// twice writes the same files.
process.env.PUNCHBOARD_LOCALE = "en"

import { EventEmitter } from "node:events"
import fs from "node:fs"
import type { ServerResponse } from "node:http"
import path from "node:path"
import QRCode from "qrcode"
import qrcodeTerminal from "qrcode-terminal"
import type { ActionContext } from "../../src/server/actions.ts"
import type { LiveSettings } from "../../src/server/events.ts"
import type { Request } from "../../src/server/http.ts"
import type { Player } from "../../src/server/player.ts"
import type { Step } from "../../src/shared/types.ts"

const { render, textOf } = await import("../../src/server/i18n.ts")
const { HttpError } = await import("../../src/server/http.ts")
const { normalizeStep } = await import("../../src/shared/model.ts")
const { prepareSteps, runSteps } = await import("../../src/server/actions.ts")
const { createLive } = await import("../../src/server/events.ts")

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { input: Json; output: Json }

const ROOT = path.resolve(import.meta.dirname, "../..")
const OUT = path.join(ROOT, "tests/fixtures/server")
fs.mkdirSync(OUT, { recursive: true })

const written: Array<[string, number]> = []
function write(name: string, cases: Case[]): void {
  fs.writeFileSync(path.join(OUT, name), `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`)
  written.push([name, cases.length])
}

// ------------------------------------------------------------ timers
// A wait is counted, not waited; a repeating timer (a stream's ping) never runs.

let waited = 0
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = ((callback: () => void, ms?: number) => {
  waited += ms ?? 0
  return realSetTimeout(callback, 0)
}) as typeof globalThis.setTimeout
globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval
globalThis.clearInterval = (() => undefined) as typeof globalThis.clearInterval

// ------------------------------------------------------------ prepareSteps

const step = (type: string, fields: Record<string, Json> = {}): Json => ({ id: `s_${type}`, type, delayMs: 0, ...fields })
const stepsOf = (raw: Json): Step[] => (raw as Json[]).map((entry) => normalizeStep(entry))

{
  const lists: Json[] = [
    [],
    [step("none")],
    [step("stop_sounds"), step("play_sound", { soundId: 3 })],
    [step("browser_tile", { url: "twitch.tv/x" })],
    [step("browser_tile")],
    [step("browser_tile", { url: "" })],
    [step("browser_tile", { url: "javascript:alert(1)" })],
    [step("stop_sounds"), step("browser_tile", { url: "file:///etc/passwd" }), step("none")],
    [step("open_url")],
    [step("go_to_deck", { profileId: "music" }), step("obs_scene", { sceneName: "Intro" }), step("hotkey", { keys: "ctrl+k" })],
    Array.from({ length: 20 }, () => step("none")),
    Array.from({ length: 21 }, () => step("none")),
    Array.from({ length: 40 }, (_, index) => step("none", { delayMs: index }))
  ]
  write("prepare-steps.json", lists.map((input) => {
    try {
      return { input, output: { steps: prepareSteps(stepsOf(input)) as unknown as Json } }
    } catch (error) {
      if (!(error instanceof HttpError) || !error.text) throw error
      return { input, output: { status: error.status, error: render(error.text, "en"), es: render(error.text, "es") } }
    }
  }))
}

// ---------------------------------------------------------------- runSteps

{
  const lists: Json[] = [
    [step("none")],
    [step("none", { delayMs: 250 })],
    [step("none", { delayMs: 60000 }), step("none", { delayMs: 90000 })],
    [step("stop_sounds")],
    [step("play_sound")],
    [step("play_sound", { soundId: 5 })],
    [step("play_sound", { soundId: 99 })],
    [step("play_sound", { soundId: 0 })],
    [step("play_sound", { soundId: 2, delayMs: 300 }), step("stop_sounds", { delayMs: 200 })],
    [step("browser_tile", { url: "twitch.tv/x" })],
    [step("browser_tile", { url: "twitch.tv/first", delayMs: 100 }), step("browser_tile", { url: "twitch.tv/second" })],
    [step("go_to_deck", { profileId: "music" })],
    [step("go_to_deck")],
    [step("go_to_deck"), step("go_to_deck", { profileId: "second", delayMs: 40 }), step("go_to_deck", { profileId: "third" })],
    [step("none", { delayMs: 400 }), step("go_to_deck", { profileId: "music" }), step("browser_tile", { url: "example.com", delayMs: 50 }), step("play_sound", { soundId: 8 })],
    // Steps that stop before they reach the computer.
    [step("open_url")],
    [step("open_url", { url: "not a link" })],
    [step("launch_app")],
    [step("launch_app", { appPath: "" })],
    [step("obs_scene")],
    [step("obs_toggle_mute")],
    [step("obs_toggle_source", { sceneName: "Main" })],
    [step("obs_toggle_source", { sourceName: "Camera" })],
    [step("obs_toggle_filter", { sourceName: "Camera" })],
    [step("obs_toggle_filter", { filterName: "Blur" })],
    // OBS is not there: the reason is whatever the link said.
    [step("obs_scene", { sceneName: "Intro" })],
    [step("obs_toggle_mute", { sourceName: "Mic", set: "on" })],
    [step("obs_toggle_source", { sceneName: "Main", sourceName: "Camera" })],
    [step("obs_toggle_filter", { sourceName: "Camera", filterName: "Blur" })],
    [step("obs_start_stop_stream")],
    [step("obs_toggle_record", { delayMs: 120 })],
    [step("obs_toggle_virtualcam")],
    [step("obs_save_replay")],
    [step("obs_studio_transition")],
    // In a macro the message says which step failed, and the rest does not run.
    [step("stop_sounds"), step("open_url"), step("play_sound", { soundId: 1 })],
    [step("play_sound", { soundId: 4 }), step("none", { delayMs: 30 }), step("obs_scene", { sceneName: "Nope", delayMs: 70 }), step("stop_sounds")],
    [step("none"), step("launch_app")],
    [step("go_to_deck", { profileId: "music" }), step("obs_toggle_mute"), step("browser_tile", { url: "example.com" })],
    [step("none"), step("none"), step("obs_save_replay")]
  ]
  const cases: Case[] = []
  for (const input of lists) {
    const asked: string[] = []
    const context = {
      config: {},
      obs: { connect: () => Promise.reject(new Error("no OBS here")) },
      onSound: (slot: number) => { asked.push(`sound ${slot}`) },
      stopSounds: () => { asked.push("stop sounds") }
    } as unknown as ActionContext
    waited = 0
    try {
      const result = await runSteps(stepsOf(input), context)
      cases.push({ input, output: { result: { active: result.active ?? null, tabletUrl: result.tabletUrl, deckId: result.deckId }, asked, waited } })
    } catch (error) {
      const said = textOf(error)
      cases.push({ input, output: { error: render(said, "en"), es: render(said, "es"), asked, waited } })
    }
  }
  write("run-steps.json", cases)
}

// -------------------------------------------------------------- createLive
// A list of things that happen to the live state, and every frame each
// stream was sent because of them.

type Op =
  | ["open", string, string]
  | ["close", string]
  | ["toggles", Record<string, boolean>]
  | ["clearToggles"]
  | ["levels", Record<string, number>]
  | ["dropLevels", string[]]
  | ["clearObsLevels"]
  | ["put", string, number]
  | ["forget", string]
  | ["soundsChanged"]
  | ["broadcast"]
  | ["meters", Record<string, number>]
  | ["disconnect", string]
  | ["closeAll"]
  | ["rev", number]

{
  const scripts: Array<{ soundVolume: number; ops: Op[] }> = [
    { soundVolume: 1, ops: [["open", "control", ""], ["broadcast"], ["close", "control"]] },
    { soundVolume: 0.4, ops: [
      ["open", "control", ""], ["open", "tablet", "dev_1"], ["open", "tablet again", "dev_1"], ["open", "phone", "dev_2"],
      ["close", "tablet again"], ["close", "tablet"], ["rev", 12], ["broadcast"], ["close", "phone"], ["close", "control"]
    ] },
    { soundVolume: 0, ops: [
      ["open", "control", ""],
      ["toggles", { "scene:Intro": true }], ["toggles", { "mute:Mic": false, stream: true }], ["toggles", { "scene:Main": true }],
      ["toggles", { "scene:Main": true, "mute:Mic": false }], ["toggles", { "scene:BRB": true, "scene:Intro": true }],
      ["toggles", { "switch:btn_1": true, "source:Main\nCamera": true }], ["toggles", { "scene:Intro": false }], ["toggles", {}],
      ["clearToggles"], ["clearToggles"], ["toggles", { "switch:btn_1": false }], ["toggles", { record: true }], ["clearToggles"]
    ] },
    { soundVolume: 0.25, ops: [
      ["open", "tablet", "dev_1"],
      ["levels", { "obs:Mic": 0.5 }], ["levels", { "obs:Mic": 0.5 }], ["levels", { "obs:Desktop Audio": 1, "app:spotify": 0.3, system: 0.123456789 }],
      ["put", "sounds", 0.75], ["broadcast"], ["dropLevels", ["obs:Mic", "never"]], ["dropLevels", ["obs:Mic"]],
      ["levels", { "obs:Mic": 0.2 }], ["forget", "app:spotify"], ["put", "app:spotify", 0.9], ["broadcast"],
      ["clearObsLevels"], ["clearObsLevels"], ["levels", { "app:music": 1e-7, "obs:Línea 2": 0.3333333333333333 }]
    ] },
    { soundVolume: 1, ops: [
      ["open", "control", ""], ["open", "tablet", "dev_1"], ["open", "phone", "dev_2"],
      ["meters", { "obs:Mic": 0.5, "obs:Desktop Audio": 1 }], ["meters", {}], ["soundsChanged"], ["soundsChanged"],
      ["disconnect", "dev_1"], ["broadcast"], ["disconnect", "dev_9"], ["close", "tablet"], ["closeAll"], ["close", "phone"], ["close", "control"]
    ] }
  ]
  const cases: Case[] = []
  for (const script of scripts) {
    let libraryRev = 7
    const settings: LiveSettings = {
      accent: () => "#5fd0d6",
      theme: () => "studio",
      language: () => "auto",
      libraryRev: () => libraryRev,
      build: () => "a.b.c.d",
      obs: () => "disconnected",
      obsIssue: () => "unreachable",
      soundDuration: () => null,
      soundFile: () => ""
    }
    const player = { playing: () => [] } as unknown as Player
    const live = createLive(settings, player, script.soundVolume)
    const streams = new Map<string, { frames: string[]; ended: boolean; req: EventEmitter }>()
    for (const op of script.ops) {
      switch (op[0]) {
        case "open": {
          const stream = { frames: [] as string[], ended: false, req: new EventEmitter() }
          const res = {
            writeHead: () => undefined,
            // Nothing reaches a stream that was ended.
            write: (frame: string) => { if (!stream.ended) stream.frames.push(frame) },
            end: () => { stream.ended = true }
          }
          streams.set(op[1], stream)
          live.openStream(stream.req as unknown as Request, res as unknown as ServerResponse, op[2])
          break
        }
        case "close": streams.get(op[1])?.req.emit("close"); break
        case "toggles": live.setToggles(op[1]); break
        case "clearToggles": live.clearToggles(); break
        case "levels": live.setLevels(op[1]); break
        case "dropLevels": live.dropLevels(op[1]); break
        case "clearObsLevels": live.clearObsLevels(); break
        case "put": live.levels[op[1]] = op[2]; break
        case "forget": delete live.levels[op[1]]; break
        case "soundsChanged": live.soundsChanged(); break
        case "broadcast": live.broadcast(); break
        case "meters": live.broadcastMeters(op[1]); break
        case "disconnect": live.disconnectDevice(op[1]); break
        case "closeAll": live.closeAll(); break
        case "rev": libraryRev = op[1]; break
      }
    }
    const frames: Record<string, Json> = {}
    for (const [name, stream] of streams) frames[name] = { frames: stream.frames, ended: stream.ended }
    cases.push({
      input: script as unknown as Json,
      output: { streams: frames, snapshot: JSON.stringify(live.snapshot()), hasListeners: live.hasListeners(), hasDevices: live.hasDevices() }
    })
  }
  write("live.json", cases)
}

// ------------------------------------------------------------------ QR codes

{
  const addresses = [
    "http://192.168.1.5:8787/deck#pair=123456",
    "http://10.0.0.12:8787/deck#pair=000001",
    "http://127.0.0.1:18034/deck#pair=987654",
    "http://172.16.254.100:8807/deck#pair=555555",
    "http://192.168.100.200:65535/deck#pair=424242",
    "http://1.2.3.4:80/deck#pair=1",
    "x",
    "http://192.168.1.5:8787/deck#pair=123456&and=a-much-longer-address-than-any-the-companion-prints"
  ]
  // What the terminal is shown at start: qrcode-terminal's small code.
  write("qr-terminal.json", addresses.map((input) => {
    let output = ""
    qrcodeTerminal.generate(input, { small: true }, (code: string) => { output = code })
    return { input, output }
  }))
  // The pairing window's code: its modules, row by row ("1" is dark).
  write("qr-modules.json", addresses.map((input) => {
    const code = QRCode.create(input, { errorCorrectionLevel: "M" })
    const rows: string[] = []
    for (let row = 0; row < code.modules.size; row += 1) {
      let line = ""
      for (let column = 0; column < code.modules.size; column += 1) line += code.modules.get(row, column) ? "1" : "0"
      rows.push(line)
    }
    return { input, output: rows }
  }))
}

for (const [name, count] of written) console.log(`${name}: ${count} cases`)
process.exit(0)
