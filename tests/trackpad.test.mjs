// End-to-end checks for trackpad decks: the pointer socket is signed and
// held to the same rules as every request, and what it passes on is checked.
// The companion writes pointer commands to a file here (PUNCHBOARD_POINTER_LOG),
// so the mouse of the computer running the test never moves.
//   node tests/trackpad.test.mjs
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { createPointer } from "../src/server/pointer.ts"
import { signRequest } from "../src/shared/sign.ts"
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const logFile = path.join(os.tmpdir(), `punchboard-pointer-${process.pid}.log`)
process.env.PUNCHBOARD_POINTER_LOG = logFile
const companion = startCompanion()
const { port, request } = companion

function signedPath(device, pathname) {
  const s = signRequest(device, "GET", pathname, "", Date.now(), crypto.randomBytes(16).toString("hex"))
  return `${pathname}?d=${encodeURIComponent(s.device)}&t=${s.time}&n=${s.nonce}&s=${s.signature}`
}

function signedHeaders(device, method, pathname, body) {
  const s = signRequest(device, method, pathname, body, Date.now(), crypto.randomBytes(16).toString("hex"))
  return { "X-Punchboard-Device": s.device, "X-Punchboard-Time": s.time, "X-Punchboard-Nonce": s.nonce, "X-Punchboard-Signature": s.signature }
}

/** Opens a socket and reports how it ended up: "open", or the HTTP status that refused it. */
function connect(urlPath, { host = LAN, origin = `http://${host}:${port}` } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${port}${urlPath}`, { headers: origin ? { Origin: origin } : {} })
    ws.on("open", () => resolve({ ws, result: "open" }))
    ws.on("unexpected-response", (_req, res) => resolve({ ws: null, result: res.statusCode }))
    ws.on("error", () => resolve({ ws: null, result: "error" }))
  })
}

const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : [])

async function main() {
  if (!LAN) throw new Error("No LAN address on this machine.")
  await companion.ready

  // Pair a device, as the security test does.
  const code = (await request({ path: "/api/pair" })).json.code
  const claimed = await request({ host: LAN, method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code, name: "Trackpad test" }) })
  const device = claimed.json.device

  let r = await connect("/api/pointer")
  check("Unsigned trackpad from the network refused", r.result === 401, r.result)
  r = await connect(signedPath(device, "/api/pointer"), { origin: "http://evil.example" })
  check("Trackpad from another site refused", r.result === 403, r.result)
  r = await connect(signedPath(device, "/api/pointer"), { origin: null })
  check("Trackpad without an Origin refused", r.result === 403, r.result)
  r = await connect(signedPath({ id: device.id, secret: "0".repeat(64) }, "/api/pointer"))
  check("Wrong secret refused", r.result === 401, r.result)
  const reused = signedPath(device, "/api/pointer")
  r = await connect(reused)
  check("Signed trackpad from a paired device opens", r.result === "open", r.result)
  const ws = r.ws
  const again = await connect(reused)
  check("A trackpad address cannot be replayed", again.result === 401, again.result)

  for (const message of [["m", 12, -4], ["s", 0, 30], ["c", "left"], ["c", "right"], ["m", 9999, 0], ["x", 1], ["c", "middle"], "junk", ["d"], ["m", 3, 3]]) {
    ws.send(typeof message === "string" ? message : JSON.stringify(message))
  }
  await wait(300)
  const got = lines()
  check("Moves, scrolls and clicks are passed on", got.slice(0, 4).join("|") === "m 12 -4|s 0 30|c left|c right", got.join("|"))
  check("Huge moves are capped", got[4] === "m 400 0", got[4])
  check("Unknown messages are dropped", !got.some((line) => /^x|middle|junk/.test(line)), got.join("|"))
  const beforePinch = lines().length
  for (const message of [["p", "begin", 0], ["p", "change", 0.5], ["p", "change", 0.05], ["p", "end", 0], ["p", "sideways", 1], ["p", "change", "big"]]) ws.send(JSON.stringify(message))
  await wait(300)
  const pinchLines = lines().slice(beforePinch)
  const pinchOk = process.platform === "darwin"
    ? pinchLines.join("|") === "p 1 0.0000|p 2 0.5000|p 2 0.0500|p 4 0.0000"
    : pinchLines.length >= 1 && pinchLines.every((line) => /^z /.test(line))
  check("A real pinch reaches the computer as a pinch (Mac) or zoom steps (Windows)", pinchOk, pinchLines.join("|"))
  const before = lines().length
  for (const message of [["g", 3, "up"], ["z", 1], ["g", 5, "up"], ["g", 3, "sideways"], ["z", 7]]) ws.send(JSON.stringify(message))
  await wait(300)
  const gestures = lines().slice(before)
  check("Gestures and zoom become this system's shortcuts", gestures.length === 2 && gestures.every((line) => /^[kz] /.test(line)), gestures.join("|"))
  ws.close()
  await wait(300)
  check("Closing mid-drag releases the button", lines().slice(-1)[0] === "u", lines().slice(-3).join("|"))

  r = await connect("/api/pointer", { host: "127.0.0.1", origin: `http://127.0.0.1:${port}` })
  check("This computer's own page may use the trackpad", r.result === "open", r.result)
  r.ws?.close()
  await wait(200)

  // Two trackpads at once: each lets go only of what it holds itself.
  const dragging = (await connect(signedPath(device, "/api/pointer"))).ws
  const other = (await connect(signedPath(device, "/api/pointer"))).ws
  const beforeTwo = lines().length
  dragging.send(JSON.stringify(["d"]))
  await wait(200)
  other.close()
  await wait(300)
  check("Another trackpad closing does not drop this one's drag", lines().slice(beforeTwo).join("|") === "d", lines().slice(beforeTwo).join("|"))
  dragging.close()
  await wait(300)
  check("The trackpad holding the button lets go of it on closing", lines().slice(beforeTwo).join("|") === "d|u", lines().slice(beforeTwo).join("|"))

  const pinching = (await connect(signedPath(device, "/api/pointer"))).ws
  const beforePinchEnd = lines().length
  pinching.send(JSON.stringify(["p", "begin", 0]))
  pinching.send(JSON.stringify(["p", "change", 0.1]))
  await wait(200)
  pinching.close()
  await wait(300)
  const pinchEnd = lines().slice(beforePinchEnd)
  // Windows turns a pinch into zoom steps, so there is nothing left open to end.
  check("A trackpad closing mid-pinch ends the pinch", process.platform !== "darwin" || pinchEnd.slice(-1)[0] === "p 4 0.0000", pinchEnd.join("|"))

  // --- traces from a deck's debug mode
  const tracePath = "/api/trackpad/traces"
  const trace = JSON.stringify({
    settings: { speed: 1.5, naturalScroll: true },
    frames: [{ time: 0, contacts: [{ id: 1, x: 10, y: 10 }] }, { time: 60, contacts: [] }],
    events: [{ type: "button", button: "left", state: "down" }, { type: "button", button: "left", state: "up" }],
    userAgent: "test"
  })
  r = await request({ host: LAN, method: "POST", path: tracePath, headers: JSON_TYPE, body: trace })
  check("An unpaired device cannot save a trace", r.status === 401, r.status)
  r = await request({ host: LAN, method: "POST", path: tracePath, headers: { ...JSON_TYPE, ...signedHeaders(device, "POST", tracePath, trace) }, body: trace })
  check("A paired device can save a trace", r.status === 200 && /^trace-[\dTZ-]+\.json$/.test(r.json?.file ?? ""), r.text)
  const file = r.json?.file ? path.join(companion.dataDir, "trackpad-traces", r.json.file) : null
  const saved = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null
  check("The trace is written with its expected summary filled in", saved !== null && saved.frames.length === 2 && saved.expected.join("|") === "click left" && saved.settings.speed === 1.5, saved ? JSON.stringify(saved.expected) : "no file")
  const junk = JSON.stringify({ settings: {}, frames: [{ time: "soon", contacts: [] }], events: [] })
  r = await request({ host: LAN, method: "POST", path: tracePath, headers: { ...JSON_TYPE, ...signedHeaders(device, "POST", tracePath, junk) }, body: junk })
  check("A malformed trace is refused", r.status === 400, r.status)

  const open = await connect(signedPath(device, "/api/pointer"))
  const cut = new Promise((resolve) => { open.ws.on("close", () => resolve(true)); setTimeout(() => resolve(false), 2000) })
  await request({ method: "DELETE", path: `/api/devices/${device.id}` })
  check("Removing a device closes its open trackpad", await cut, "still open")
  r = await connect(signedPath(device, "/api/pointer"))
  check("A removed device loses the trackpad", r.result === 401, r.result)

  await dyingHelper()
}

/** The pointer module with a stand-in helper (plain Node, never the mouse)
    that dies at once, while moves keep streaming in as fast as a finger sends
    them. Writing to a dead helper must not crash, and it must not be started
    again for every message. */
async function dyingHelper() {
  let spawned = 0
  const problems = []
  const pointer = createPointer({
    macHelper: "",
    log: () => {},
    onProblem: (message) => problems.push(message),
    ignoreTestLog: true,
    spawn: () => {
      spawned += 1
      return spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 30)"], { stdio: ["pipe", "pipe", "ignore"] })
    }
  })
  const owner = {}
  const stream = setInterval(() => { for (let i = 0; i < 20; i++) pointer.send(["m", 1, 1], owner) }, 2)
  await wait(3000)
  clearInterval(stream)
  check("A helper that dies mid-stream does not crash the companion", true, "")
  check("A helper that keeps dying is not restarted for every move", spawned >= 2 && spawned <= 5, `${spawned} starts`)
  check("…and the deck is told once", problems.length === 1, JSON.stringify(problems))
  pointer.dispose()
}

main()
  .catch((error) => { console.error(error); tally.fail++ })
  .finally(async () => {
    await companion.stop()
    companion.cleanup()
    fs.rmSync(logFile, { force: true })
    console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
    process.exit(tally.fail ? 1 : 0)
  })
