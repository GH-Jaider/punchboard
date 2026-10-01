// End-to-end checks for trackpad decks: the pointer socket is signed and
// held to the same rules as every request, and what it passes on is checked.
// The companion writes pointer commands to a file here (PUNCHBOARD_POINTER_LOG),
// so the mouse of the computer running the test never moves.
//   node tests/trackpad.test.mjs
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { signRequest } from "../src/shared/sign.ts"
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"
import { installPage } from "./fake-page.mjs"

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

  await deckPage()

  const open = await connect(signedPath(device, "/api/pointer"))
  const cut = new Promise((resolve) => { open.ws.on("close", () => resolve(true)); setTimeout(() => resolve(false), 2000) })
  await request({ method: "DELETE", path: `/api/devices/${device.id}` })
  check("Removing a device closes its open trackpad", await cut, "still open")
  r = await connect(signedPath(device, "/api/pointer"))
  check("A removed device loses the trackpad", r.result === 401, r.result)
}

// --- the deck's own trackpad code, in a stand-in page, over a real socket

/** A touch as the browser reports it. */
const touch = (id, x, y) => ({ identifier: id, clientX: x, clientY: y })

async function deckPage() {
  const code = (await request({ path: "/api/pair" })).json.code
  const device = (await request({ host: LAN, method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code, name: "Deck page" }) })).json.device
  const page = installPage({ host: `${LAN}:${port}`, origin: `http://${LAN}:${port}` })
  // Imported only now: the deck's modules look for the page as they load.
  const { normalizeLibrary } = await import("../src/shared/model.ts")
  const { saveDevice } = await import("../src/client/deck/api.ts")
  const { state } = await import("../src/client/deck/state.ts")
  const { renderGrid, showDeck } = await import("../src/client/deck/grid.ts")
  saveDevice(device)

  const library = (speed) => normalizeLibrary({
    activeProfileId: "pad",
    profiles: [
      { id: "pad", name: "Pad", columns: 3, rows: 2, buttons: [], trackpad: { speed, naturalScroll: true, pinchZoom: "gesture" } },
      { id: "keys", name: "Keys", columns: 3, rows: 2, buttons: [] }
    ]
  })
  const grid = page.byId("grid")
  const surfaceOf = () => grid.children[0]?.children[0]
  const ready = async () => {
    for (let i = 0; i < 100 && page.sockets[page.sockets.length - 1]?.readyState !== 1; i += 1) await wait(20)
  }
  /** Fingers on a surface: `changed` are the ones this event is about, `all` the ones still down. */
  const fingers = (surface, type, changed, all) => surface.dispatch(type, { changedTouches: changed, targetTouches: all })
  async function slide(surface, id, x, y, dx) {
    for (let i = 1; i <= 10; i += 1) {
      await wait(16)
      const moved = touch(id, x + (dx * i) / 10, y)
      fingers(surface, "touchmove", [moved], [moved])
    }
    return x + dx
  }
  /** Tap, then land again and drag right: the tap's press carries the drag. */
  async function tapAndDrag(surface, id, x, y) {
    fingers(surface, "touchstart", [touch(id, x, y)], [touch(id, x, y)])
    await wait(40)
    fingers(surface, "touchend", [touch(id, x, y)], [])
    await wait(120)
    fingers(surface, "touchstart", [touch(id + 1, x, y)], [touch(id + 1, x, y)])
    return slide(surface, id + 1, x, y, 60)
  }
  const moved = (list) => list.filter((line) => line.startsWith("m ")).reduce((sum, line) => sum + Number(line.split(" ")[1]), 0)

  state.library = library(1)
  state.activeId = "pad"
  renderGrid()
  await ready()
  const surface = surfaceOf()
  check("The deck page shows the trackpad and connects it", surface !== undefined && page.sockets.length === 1 && page.sockets[0].readyState === 1, page.sockets.length)

  // A library update mid-drag (any edit in the Control Center) re-renders the
  // deck: the drag must carry on, not drop and go on as plain movement.
  let from = lines().length
  let x = await tapAndDrag(surface, 1, 400, 300)
  await wait(60)
  const beforeUpdate = lines().slice(from)
  state.library = library(2.5)
  renderGrid()
  check("A library update keeps the trackpad that is showing: same surface, same socket", surfaceOf() === surface && page.sockets.length === 1 && page.sockets[0].readyState === 1, `${page.sockets.length} sockets`)
  x = await slide(surface, 2, x, 300, 60)
  await wait(60)
  const afterUpdate = lines().slice(from + beforeUpdate.length)
  fingers(surface, "touchend", [touch(2, x, 300)], [])
  await wait(150)
  const dragLines = lines().slice(from)
  check("The drag pressed once before the update", beforeUpdate[0] === "d" && !beforeUpdate.includes("u"), beforeUpdate.join("|"))
  check("…and is still held after it, moving", !afterUpdate.includes("u") && !afterUpdate.includes("d") && moved(afterUpdate) > 0, afterUpdate.join("|"))
  check("…and drops once, when the finger lifts", dragLines.filter((l) => l === "d").length === 1 && dragLines.filter((l) => l === "u").length === 1 && dragLines[dragLines.length - 1] === "u", dragLines.join("|"))
  check("The new speed applies to the fingers already down", moved(afterUpdate) > moved(beforeUpdate) * 1.5, `${moved(beforeUpdate)} then ${moved(afterUpdate)}`)

  // Another deck and back builds a new trackpad: the old surface, should a
  // finger still be on it, must never feed the new one.
  showDeck("keys")
  check("Another deck takes the trackpad down", grid.children[0]?.className === "deck-empty", grid.children[0]?.className)
  showDeck("pad")
  await ready()
  const second = surfaceOf()
  check("Coming back builds a fresh trackpad", second !== undefined && second !== surface && page.sockets.length === 2, page.sockets.length)
  from = lines().length
  fingers(surface, "touchstart", [touch(9, 300, 300)], [touch(9, 300, 300)])
  await wait(40)
  fingers(surface, "touchend", [touch(9, 300, 300)], [])
  await slide(surface, 9, 300, 300, 80)
  await wait(500)
  check("Touches on the old surface reach nothing", lines().length === from, lines().slice(from).join("|"))

  // A close that arrives late from the previous socket must not clear the
  // current drag, or its release is never sent and the button sticks down.
  page.holdCloses(true)
  showDeck("keys")
  showDeck("pad")
  await ready()
  const third = surfaceOf()
  from = lines().length
  x = await tapAndDrag(third, 20, 400, 300)
  await wait(60)
  const previous = page.sockets[page.sockets.length - 2]
  check("The previous socket was closed, its close event still on its way", previous !== undefined && previous.readyState === 3 && page.sockets.length === 3, previous?.readyState)
  page.holdCloses(false)
  page.releaseCloses()
  x = await slide(third, 21, x, 300, 40)
  fingers(third, "touchend", [touch(21, x, 300)], [])
  await wait(150)
  const late = lines().slice(from)
  check("A late close from an old socket does not lose the drag's release", late[0] === "d" && late[late.length - 1] === "u" && late.filter((l) => l === "u").length === 1, late.join("|"))
  const current = page.sockets[page.sockets.length - 1]
  check("…and the current socket stays open", current.readyState === 1, current.readyState)

  showDeck("keys")
  await wait(100)
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
