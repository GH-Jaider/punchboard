// Fixtures for the Rust port of the link to OBS Studio (server/src/obs/):
// the TypeScript is run over many inputs and what it answers is written to
// tests/fixtures/obs/*.json as arrays of { input, output }. The Rust unit
// tests read them and must answer the same. Nothing here depends on the
// clock or on chance, so a second run writes the same files.
//   node tests/fixtures/make-obs.ts        (from the repository's root)
import fs from "node:fs"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { EventSubscription, OBSWebSocket } from "obs-websocket-js/json"
import { WebSocketServer } from "ws"
import { meterPosition, readMeters } from "../../src/server/obs.ts"
import { readLocalObs } from "../../src/server/obs-config.ts"
import { faderPosition } from "../../src/server/obs-state.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { input: Json; output: Json }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")
const OUT = path.join(HERE, "obs")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-fixtures-obs-"))

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

// ------------------------------------------- meter and fader positions

{
  // A gain ("mul") is 0..1 in practice, a little over 1 when boosted; the
  // edges and everything a float can be are here too.
  const gains: number[] = [
    0, -0, NaN, Infinity, -Infinity, -1, -0.5, -1e-300, 5e-324, 2.2250738585072014e-308, 1e-300, 1e-100, 1e-20, 1e-10,
    0.001, 0.0009999999999999998, 0.0010000000000000002, 0.01, 0.1, 0.125, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999999, 0.9999999999999999,
    1, 1.0000000000000002, 1.000001, 1.5, 2, 3, 8, 10, 20, 27, 64, 100, 1000, 1e10, 1e100, 1.7976931348623157e308,
    1 / 3, 2 / 3, 1 / 7, 1 / 8, 1 / 27, 1 / 64, 1 / 1000, 0.5 ** 10, 0.5 ** 20, 0.5 ** 52, Math.SQRT1_2, Math.LN2, Math.E, Math.PI
  ]
  // Every decibel from +6 down to -70, and the halves between.
  for (let db = 12; db >= -140; db -= 1) gains.push(10 ** (db / 40))
  // Every step of a fader: positions 0..1 by hundredths, cubed.
  for (let step = 0; step <= 100; step += 1) gains.push((step / 100) ** 3)
  const next = sequence(11)
  for (let i = 0; i < 150; i += 1) gains.push(next())
  for (let i = 0; i < 100; i += 1) gains.push(Number(`${1 + next() * 9}e${Math.floor(next() * 12) - 9}`))
  for (let i = 0; i < 40; i += 1) gains.push(Number(`${1 + next() * 9}e${Math.floor(next() * 600) - 300}`))
  write("meter-position.json", gains.map((gain) => ({ input: bits(gain), output: bits(meterPosition(gain)) })))
  write("fader-position.json", gains.map((gain) => ({ input: bits(gain), output: bits(faderPosition(gain)) })))
}

// ------------------------------------------------------------- meters

{
  const stereo = (left: number, right: number): Json => [[left / 2, left, left], [right / 2, right, right]]
  const scenarios: { inputs: Json; wanted: string[] }[] = [
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(0.5, 0.25) }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(0.25, 0.5) }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(1, 1) }, { inputName: "Desktop Audio", inputLevelsMul: stereo(0.1, 0.2) }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(1, 1) }, { inputName: "Desktop Audio", inputLevelsMul: stereo(0.1, 0.2) }], wanted: ["Desktop Audio", "Mic"] },
    { inputs: [{ inputName: "Desktop Audio", inputLevelsMul: stereo(0.1, 0.2) }, { inputName: "Mic", inputLevelsMul: stereo(1, 1) }], wanted: ["Mic", "Desktop Audio"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(1, 1) }], wanted: [] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(1, 1) }], wanted: ["mic"] },
    { inputs: [], wanted: ["Mic"] },
    { inputs: null, wanted: ["Mic"] },
    { inputs: {}, wanted: ["Mic"] },
    { inputs: "Mic", wanted: ["Mic"] },
    { inputs: 7, wanted: ["Mic"] },
    { inputs: { inputName: "Mic", inputLevelsMul: stereo(1, 1) }, wanted: ["Mic"] },
    // The same input twice: the later reading stands, in the first one's place.
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(1, 1) }, { inputName: "Cam", inputLevelsMul: stereo(0.3, 0.3) }, { inputName: "Mic", inputLevelsMul: stereo(0.01, 0.02) }], wanted: ["Mic", "Cam"] },
    // No channels, silent ones, mono, 5.1.
    { inputs: [{ inputName: "Mic", inputLevelsMul: [] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic" }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: null }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: "loud" }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: { 0: [1, 1, 1] } }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, 0, 0], [0, 0, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0.2, 0.4, 0.9]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0.1, 0.2, 0], [0.1, 0.3, 0], [0.1, 0.05, 0], [0.1, 0.31, 0], [0.1, 0.3, 0], [0, 0, 0]] }], wanted: ["Mic"] },
    // Channels that are not what they should be.
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0.5], [0.2, 0.1]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[], [0.2, 0.7]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [0.9, [0.2, 0.3, 0.3]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [null, "x", {}, [0.2, 0.3, 0.3]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, "0.5", 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, " 0.25 ", 0], [0, "loud", 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, true, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, null, 0], [0, false, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, [0.5], 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, [0.5, 0.6], 0], [0, {}, 0], [0, [], 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, -1, 0], [0, -0.5, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, 2, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, 1e-9, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, 0.001, 0]] }], wanted: ["Mic"] },
    { inputs: [{ inputName: "Mic", inputLevelsMul: [[0, 0.0316227766016838, 0]] }], wanted: ["Mic"] },
    // Inputs that are not what they should be.
    { inputs: [{ inputLevelsMul: stereo(1, 1) }, { inputName: "", inputLevelsMul: stereo(1, 1) }], wanted: ["", "undefined", "Mic"] },
    { inputs: [{ inputName: 7, inputLevelsMul: stereo(1, 1) }, { inputName: null, inputLevelsMul: stereo(1, 1) }, { inputName: ["Mic"], inputLevelsMul: stereo(1, 1) }], wanted: ["7", "null", "Mic"] },
    { inputs: [7, "Mic", true, [], ["Mic"], {}, { inputName: "Mic", inputLevelsMul: stereo(0.5, 0.5) }], wanted: ["Mic"] },
    // A null among them is where the TypeScript throws: the whole event is lost.
    { inputs: [{ inputName: "Mic", inputLevelsMul: stereo(0.5, 0.5) }, null], wanted: ["Mic"] },
    { inputs: [null], wanted: ["Mic"] },
    // Names as people write them.
    { inputs: [{ inputName: "Micrófono 🎙️", inputLevelsMul: stereo(0.4, 0.4) }, { inputName: "obs:Mic", inputLevelsMul: stereo(0.2, 0.2) }, { inputName: "a\nb", inputLevelsMul: stereo(0.1, 0.1) }], wanted: ["Micrófono 🎙️", "obs:Mic", "a\nb"] },
    { inputs: [{ inputName: "2", inputLevelsMul: stereo(0.4, 0.4) }, { inputName: "10", inputLevelsMul: stereo(0.2, 0.2) }, { inputName: "1", inputLevelsMul: stereo(0.1, 0.1) }], wanted: ["1", "2", "10"] }
  ]
  const next = sequence(23)
  const names = ["Mic", "Desktop Audio", "Music", "Guest", "Camera"]
  for (let i = 0; i < 30; i += 1) {
    const inputs: Json[] = []
    const count = 1 + Math.floor(next() * 5)
    for (let n = 0; n < count; n += 1) {
      const channels: Json[] = []
      const channelCount = Math.floor(next() * 4)
      for (let c = 0; c < channelCount; c += 1) {
        const peak = next() < 0.2 ? 0 : next() ** 3
        channels.push([peak * next(), peak, peak])
      }
      inputs.push({ inputName: names[Math.floor(next() * names.length)]!, inputLevelsMul: channels })
    }
    scenarios.push({ inputs, wanted: names.filter(() => next() < 0.6) })
  }
  write("read-meters.json", scenarios.map((scenario) => {
    let output: Json
    try {
      output = Object.entries(readMeters(scenario.inputs, new Set(scenario.wanted))).map(([key, level]) => [key, bits(level)])
    } catch {
      output = null
    }
    return { input: scenario, output }
  }))
}

// ------------------------------------------------- OBS's own settings

{
  // os.homedir() reads HOME each time it is asked (USERPROFILE on Windows).
  const kept = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  const tail = path.join("obs-studio", "plugin_config", "obs-websocket", "config.json")
  const fileIn = (home: string): string => {
    if (process.platform === "darwin") return path.join(home, "Library", "Application Support", tail)
    if (process.platform === "win32") return path.join(home, "AppData", "Roaming", tail)
    return path.join(home, ".config", tail)
  }
  const real = { alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: "Xk3pQ9vTz1LmN8aB", server_port: 4455 }
  const files: ({ text: string } | { hex: string } | Record<string, never>)[] = [
    {},
    { text: JSON.stringify(real) },
    { text: JSON.stringify(real, null, 4) },
    { text: `\n\t ${JSON.stringify(real)} \r\n` },
    { text: JSON.stringify({ ...real, server_enabled: false }) },
    { text: JSON.stringify({ ...real, auth_required: false }) },
    { text: JSON.stringify({ ...real, auth_required: false, server_password: "" }) },
    { text: JSON.stringify({ ...real, server_port: 4460 }) },
    { text: JSON.stringify({ ...real, server_password: "" }) },
    { text: JSON.stringify({ ...real, server_password: "contraseña ✓ 日本語 🎛️ \"quoted\" \\ back" }) },
    { text: JSON.stringify({ ...real, server_password: "  spaced  " }) },
    // Missing fields.
    { text: "{}" },
    { text: JSON.stringify({ server_enabled: true }) },
    { text: JSON.stringify({ server_port: 4470 }) },
    { text: JSON.stringify({ server_password: "only" }) },
    { text: JSON.stringify({ auth_required: true, server_password: "kept" }) },
    { text: JSON.stringify({ auth_required: false }) },
    { text: JSON.stringify({ server_enabled: true, server_port: 4455, server_password: "no auth field" }) },
    // Wrong types: enabled must be true itself, auth is on unless false itself.
    { text: JSON.stringify({ ...real, server_enabled: "true" }) },
    { text: JSON.stringify({ ...real, server_enabled: 1 }) },
    { text: JSON.stringify({ ...real, server_enabled: null }) },
    { text: JSON.stringify({ ...real, server_enabled: [] }) },
    { text: JSON.stringify({ ...real, auth_required: "false" }) },
    { text: JSON.stringify({ ...real, auth_required: 0 }) },
    { text: JSON.stringify({ ...real, auth_required: null }) },
    { text: JSON.stringify({ ...real, server_password: 12345 }) },
    { text: JSON.stringify({ ...real, server_password: null }) },
    { text: JSON.stringify({ ...real, server_password: ["a"] }) },
    { text: JSON.stringify({ ...real, server_password: { value: "a" } }) },
    { text: JSON.stringify({ ...real, server_password: true }) },
    // Ports, as Number() reads them; nothing and zero fall back to 4455.
    { text: JSON.stringify({ ...real, server_port: "4460" }) },
    { text: JSON.stringify({ ...real, server_port: " 4461 " }) },
    { text: JSON.stringify({ ...real, server_port: "0x1167" }) },
    { text: JSON.stringify({ ...real, server_port: "4455px" }) },
    { text: JSON.stringify({ ...real, server_port: "" }) },
    { text: JSON.stringify({ ...real, server_port: "abc" }) },
    { text: JSON.stringify({ ...real, server_port: 0 }) },
    { text: JSON.stringify({ ...real, server_port: -1 }) },
    { text: JSON.stringify({ ...real, server_port: 4455.5 }) },
    { text: JSON.stringify({ ...real, server_port: 65536 }) },
    { text: JSON.stringify({ ...real, server_port: 1e21 }) },
    { text: JSON.stringify({ ...real, server_port: null }) },
    { text: JSON.stringify({ ...real, server_port: true }) },
    { text: JSON.stringify({ ...real, server_port: false }) },
    { text: JSON.stringify({ ...real, server_port: [] }) },
    { text: JSON.stringify({ ...real, server_port: [4470] }) },
    { text: JSON.stringify({ ...real, server_port: ["4471"] }) },
    { text: JSON.stringify({ ...real, server_port: [1, 2] }) },
    { text: JSON.stringify({ ...real, server_port: {} }) },
    { text: `{"server_port":4455.0,"server_enabled":true}` },
    { text: `{"server_port":4.456e3,"server_enabled":true}` },
    { text: `{"server_port":-0,"server_enabled":true}` },
    // The same key twice: the last one stands.
    { text: `{"server_port":1,"server_port":4480,"server_enabled":false,"server_enabled":true,"server_password":"a","server_password":"b"}` },
    // JSON that is not an object. Only null has no fields to ask for.
    { text: "null" },
    { text: "[]" },
    { text: `[${JSON.stringify(real)}]` },
    { text: "true" },
    { text: "false" },
    { text: "4455" },
    { text: "\"server_enabled\"" },
    // Not JSON at all.
    { text: "" },
    { text: " " },
    { text: "{" },
    { text: "{\"server_enabled\":true" },
    { text: "{\"server_enabled\":true,}" },
    { text: "{'server_enabled':true}" },
    { text: "{server_enabled:true}" },
    { text: `// OBS\n${JSON.stringify(real)}` },
    { text: `${JSON.stringify(real)} trailing` },
    { text: `${JSON.stringify(real)}${JSON.stringify(real)}` },
    { text: "{\"server_port\":NaN}" },
    { text: "{\"server_port\":+4455}" },
    { text: "{\"server_port\":04455}" },
    { text: "{\"server_port\":.5}" },
    { text: "{\"server_password\":\"line\nbreak\"}" },
    { text: "[general]\nserver_enabled=true\n" },
    { text: "undefined" },
    // A byte-order mark, and bytes that are not text.
    { hex: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(real))]).toString("hex") },
    { hex: Buffer.concat([Buffer.from("{\"server_enabled\":true,\"server_password\":\"a"), Buffer.from([0xff, 0xfe]), Buffer.from("b\"}")]).toString("hex") },
    { hex: Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]).toString("hex") },
    { hex: Buffer.from(JSON.stringify(real), "utf16le").toString("hex") }
  ]
  const cases: Case[] = []
  files.forEach((file, index) => {
    const home = path.join(TMP, `home-${index}`)
    fs.mkdirSync(home, { recursive: true })
    process.env.HOME = home
    process.env.USERPROFILE = home
    delete process.env.APPDATA
    delete process.env.XDG_CONFIG_HOME
    if ("text" in file || "hex" in file) {
      const target = fileIn(home)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, "hex" in file ? Buffer.from(file.hex, "hex") : file.text)
    }
    const read = readLocalObs()
    cases.push({ input: file, output: { found: read.found, enabled: read.enabled, port: bits(read.port), password: read.password } })
  })
  for (const [name, value] of Object.entries(kept)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  write("local-obs.json", cases)
}

// ------------------------------------- what obs-websocket-js sends OBS

{
  // The package itself is asked: a server greets it as OBS would, with a
  // salt and a challenge, and keeps the Identify it answers with.
  interface Greeting { authentication: { salt: string; challenge: string } | null; password: string | null }
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const port = (server.address() as AddressInfo).port
  let greeting: Greeting = { authentication: null, password: null }
  let identified: Json = null
  server.on("connection", (socket) => {
    const hello: Json = { obsWebSocketVersion: "5.5.0", rpcVersion: 1 }
    if (greeting.authentication) hello.authentication = greeting.authentication
    socket.send(JSON.stringify({ op: 0, d: hello }))
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { op: number; d: Json }
      if (message.op !== 1) return
      identified = message.d
      socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }))
    })
  })
  async function identify(next: Greeting): Promise<Json> {
    greeting = next
    identified = null
    const client = new OBSWebSocket()
    // What src/server/obs.ts asks for.
    await client.connect(`ws://127.0.0.1:${port}`, next.password ?? undefined, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters })
    await client.disconnect()
    return identified
  }

  const salt = "lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI="
  const challenge = "+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY="
  const triples: { password: string; salt: string; challenge: string }[] = [
    // obs-websocket's own documentation uses this one.
    { password: "supersecretpassword", salt, challenge },
    { password: "Xk3pQ9vTz1LmN8aB", salt, challenge },
    { password: "a", salt, challenge },
    { password: " ", salt, challenge },
    { password: "  spaced  ", salt, challenge },
    { password: "contraseña", salt, challenge },
    { password: "пароль", salt, challenge },
    { password: "パスワード", salt, challenge },
    { password: "🎛️🔊", salt, challenge },
    { password: "quote\"back\\slash/", salt, challenge },
    { password: "line\nbreak\ttab", salt, challenge },
    { password: "x".repeat(499), salt, challenge },
    { password: "secret", salt: "", challenge: "" },
    { password: "secret", salt: "salt", challenge: "" },
    { password: "secret", salt: "", challenge: "challenge" },
    { password: "secret", salt: "s", challenge: "c" },
    { password: "secret", salt: "sal", challenge: "tchallenge" },
    { password: "secrets", salt: "al", challenge: "tchallenge" },
    { password: "secret", salt: "sél", challenge: "desafío ✓" },
    { password: "secret", salt: "+/+/==", challenge: "==//++" }
  ]
  const next = sequence(41)
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  const made = (length: number): string => Array.from({ length }, () => letters[Math.floor(next() * letters.length)]!).join("")
  for (let i = 0; i < 30; i += 1) triples.push({ password: made(1 + Math.floor(next() * 40)), salt: `${made(43)}=`, challenge: `${made(43)}=` })

  const strings: Case[] = []
  for (const triple of triples) {
    const sent = await identify({ authentication: { salt: triple.salt, challenge: triple.challenge }, password: triple.password })
    const proof = sent !== null && typeof sent === "object" && !Array.isArray(sent) ? sent.authentication : undefined
    if (typeof proof !== "string") throw new Error(`No authentication sent for ${JSON.stringify(triple)}`)
    strings.push({ input: triple, output: proof })
  }
  write("authentication.json", strings)

  const greetings: Greeting[] = [
    { authentication: null, password: null },
    { authentication: null, password: "not asked for" },
    { authentication: { salt, challenge }, password: "supersecretpassword" },
    // Asked for one and has none: nothing to prove with (OBS then closes with 4009).
    { authentication: { salt, challenge }, password: null },
    { authentication: { salt, challenge }, password: "" }
  ]
  const identifies: Case[] = []
  for (const each of greetings) identifies.push({ input: { ...each }, output: await identify(each) })
  write("identify.json", identifies)
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

fs.rmSync(TMP, { recursive: true, force: true })
for (const name of Object.keys(counts).sort()) console.log(`${String(counts[name]).padStart(6)}  ${name}`)
console.log(`${String(Object.values(counts).reduce((sum, count) => sum + count, 0)).padStart(6)}  cases in ${path.relative(ROOT, OUT)}`)
