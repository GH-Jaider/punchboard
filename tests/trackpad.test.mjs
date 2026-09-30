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

  const open = await connect(signedPath(device, "/api/pointer"))
  const cut = new Promise((resolve) => { open.ws.on("close", () => resolve(true)); setTimeout(() => resolve(false), 2000) })
  await request({ method: "DELETE", path: `/api/devices/${device.id}` })
  check("Removing a device closes its open trackpad", await cut, "still open")
  r = await connect(signedPath(device, "/api/pointer"))
  check("A removed device loses the trackpad", r.result === 401, r.result)
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
