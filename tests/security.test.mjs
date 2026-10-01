// End-to-end checks for pairing, signatures, access rules and safe saving.
// Starts its own companion on a spare port with a throwaway data folder, so
// it never touches a running Punchboard or anyone's real decks.
//   node tests/security.test.mjs
// "Remote" requests go to this machine's LAN address, which the server
// treats like any tablet.
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { WebSocket } from "ws"
import { createAuth } from "../src/server/auth.ts"
import { signRequest } from "../src/shared/sign.ts"
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"

const S = { sign: (d, m, p, b, t) => signRequest(d, m, p, b, t, crypto.randomBytes(16).toString("hex")) }

if (!LAN) {
  console.log("No LAN address on this machine; the remote checks need one.")
  process.exit(1)
}
const companion = startCompanion()
const PORT = companion.port
const dataDir = companion.dataDir
const request = companion.request
const { check, tally } = checker()
const stopServer = companion.stop
const remote = (opts) => request({ host: LAN, ...opts })
function signed(device, method, path, body = "", time = Date.now()) {
  const s = S.sign(device, method, path, body, time)
  return { "X-Punchboard-Device": s.device, "X-Punchboard-Time": s.time, "X-Punchboard-Nonce": s.nonce, "X-Punchboard-Signature": s.signature }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function signedStream(device, pathname) {
  const s = S.sign(device, "GET", pathname, "", Date.now())
  return `${pathname}?d=${encodeURIComponent(s.device)}&t=${s.time}&n=${s.nonce}&s=${s.signature}`
}

/** Asks for a trackpad socket from the network and resets the connection
    straight after, as a hostile machine on the wifi could. */
function resetUpgrade(origin) {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, LAN, () => {
      socket.write([
        "GET /api/pointer HTTP/1.1", `Host: ${LAN}:${PORT}`, "Upgrade: websocket", "Connection: Upgrade",
        `Origin: ${origin}`, `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`, "Sec-WebSocket-Version: 13", "", ""
      ].join("\r\n"))
      setImmediate(() => { socket.resetAndDestroy(); resolve() })
    })
    socket.on("error", () => resolve())
  })
}

/** Starts a request with a body and resets the connection halfway through it. */
function resetMidBody() {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, "127.0.0.1", () => {
      socket.write(`PUT /api/settings HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"accent":"`)
      setTimeout(() => { socket.resetAndDestroy(); resolve() }, 50)
    })
    socket.on("error", () => resolve())
  })
}

/** A body sent in chunks, with no Content-Length to refuse it by. */
function chunkedPut(urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method: "PUT", path: urlPath, headers: { Host: `127.0.0.1:${PORT}`, ...JSON_TYPE } }, (res) => {
      let text = ""
      res.on("data", (c) => (text += c))
      res.on("end", () => { let json = null; try { json = JSON.parse(text) } catch {} resolve({ status: res.statusCode, json, text }) })
    })
    req.on("error", reject)
    for (let at = 0; at < body.length; at += 16 * 1024) req.write(body.slice(at, at + 16 * 1024))
    req.end()
  })
}

/** Pairing rules checked on the auth module itself, with made-up addresses. */
function authUnitChecks() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-auth-")), "devices.json")
  const auth = createAuth({ file, log: () => {} })
  const tryClaim = (code, ip) => {
    try { auth.claim(code, "Unit", ip); return "paired" } catch (error) { return error.code }
  }
  const wrong = (code) => String((Number(code) + 1) % 1000000).padStart(6, "0")

  let code = auth.currentCode().code
  check("Unit: a code pairs once", tryClaim(code, "10.0.0.2") === "paired" && tryClaim(code, "10.0.0.3") === "bad_code", "reused")
  code = auth.currentCode().code
  const results = []
  for (let i = 0; i < 9; i++) results.push(tryClaim(wrong(code), "10.0.0.66"))
  check("Unit: eight wrong codes lock that address", results.slice(0, 8).every((result) => result === "bad_code") && results[8] === "locked", results.join(","))
  check("Unit: the code is not replaced by one address's guesses", auth.currentCode().code === code, "replaced")
  check("Unit: other addresses still pair while one is locked", tryClaim(code, "10.0.0.7") === "paired", "refused")

  code = auth.currentCode().code
  const v6 = []
  for (let i = 0; i < 9; i++) v6.push(tryClaim(wrong(code), `fd00:1:2:3::${(i + 1).toString(16)}`))
  check("Unit: a whole IPv6 /64 counts as one address", v6[8] === "locked" && tryClaim(code, "fd00:1:2:3:ffff::9") === "locked", v6.join(","))
  check("Unit: another /64 is not locked by it", tryClaim(code, "fd00:1:2:4::1") === "paired", "refused")

  code = auth.currentCode().code
  let addresses = 0
  while (auth.currentCode().code === code && addresses < 10) {
    addresses += 1
    for (let i = 0; i < 7; i++) tryClaim(wrong(code), `10.1.0.${addresses}`)
  }
  check("Unit: many addresses guessing together get the code replaced", auth.currentCode().code !== code && addresses <= 4, `${addresses} addresses`)
  check("Unit: the replaced code no longer pairs", tryClaim(code, "10.2.0.1") === "bad_code", "paired")
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
}

async function main() {
  const port = await companion.ready
  check("Companion starts on the port it was given", port === PORT, port)
  console.log(`LAN address used as the remote tablet: ${LAN}\n`)

  // --- browser-borne attacks on this computer
  let r = await request({ path: "/api/library", hostHeader: `evil.example:${PORT}` })
  check("DNS rebinding: foreign Host header refused", r.status === 403, r.status)
  r = await request({ method: "POST", path: "/api/shutdown", headers: { Origin: "https://evil.example" } })
  check("CSRF: shutdown from another site refused", r.status === 403, r.status)
  r = await request({ method: "POST", path: "/api/press", headers: { "Content-Type": "text/plain" }, body: '{"profileId":"x","buttonId":"y"}' })
  check("CSRF: text/plain form-style POST refused", r.status === 415, r.status)

  // --- remote without pairing
  r = await remote({ path: "/api/library" })
  check("Unpaired tablet cannot read the deck", r.status === 401 && r.json.code === "unpaired", `${r.status} ${r.text}`)
  r = await remote({ method: "POST", path: "/api/press", headers: JSON_TYPE, body: JSON.stringify({ profileId: "p", buttonId: "b", steps: [{ type: "launch_app", appPath: "/System/Applications/Calculator.app" }] }) })
  check("Unpaired tablet cannot press (the old launch-any-app hole)", r.status === 401, r.status)
  r = await remote({ method: "PUT", path: "/api/library", headers: JSON_TYPE, body: "{}" })
  check("Tablet cannot overwrite the library", r.status === 403, r.status)
  r = await remote({ method: "PUT", path: "/api/settings", headers: JSON_TYPE, body: '{"obsPassword":"x"}' })
  check("Tablet cannot change settings / OBS password", r.status === 403, r.status)
  r = await remote({ method: "POST", path: "/api/open-deck", headers: JSON_TYPE, body: "{}" })
  check("A device cannot open windows on this computer", r.status === 403, r.status)
  r = await remote({ path: "/api/pair" })
  check("Tablet cannot read the pairing code", r.status === 403, r.status)

  // --- pairing
  r = await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: '{"code":"000001"}' })
  check("Wrong pairing code refused", r.status === 400 && r.json.code === "bad_code", r.text)
  const pairInfo = (await request({ path: "/api/pair" })).json
  r = await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code: pairInfo.code, name: "Test iPad" }) })
  check("Right pairing code gives a device secret", r.status === 200 && /^[0-9a-f]{64}$/.test(r.json.device.secret), r.text)
  const device = r.json.device
  r = await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code: pairInfo.code, name: "Second iPad" }) })
  check("A pairing code pairs one device only", r.status === 400 && r.json.code === "bad_code", r.text)
  const nextCode = (await request({ path: "/api/pair" })).json.code
  check("The pairing window gets a new code once one is used", /^\d{6}$/.test(nextCode) && nextCode !== pairInfo.code, nextCode)

  // --- connections that go wrong must not take the companion down
  const sockets = []
  for (const origin of [`http://${LAN}:${PORT}`, "http://evil.example"]) {
    for (let i = 0; i < 5; i++) sockets.push(resetUpgrade(origin))
  }
  await Promise.all(sockets)
  await wait(500)
  r = await remote({ path: "/api/hello" })
  check("A connection reset mid-upgrade does not crash the companion", companion.alive() && r.status === 200, companion.alive() ? r.status : "it exited")
  await resetMidBody()
  await wait(300)
  r = await remote({ path: "/api/hello" })
  check("A connection reset mid-request does not crash the companion", companion.alive() && r.status === 200, companion.alive() ? r.status : "it exited")

  const pointerPath = signedStream(device, "/api/pointer")
  const ws = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${LAN}:${PORT}${pointerPath}`, { headers: { Origin: `http://${LAN}:${PORT}` } })
    socket.on("open", () => resolve(socket))
    socket.on("error", reject)
  })
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)))
  ws.on("error", () => {})
  ws.send(JSON.stringify(["d"]))
  ws.send("x".repeat(4096))
  const closeCode = await Promise.race([closed, wait(3000).then(() => "still open")])
  await wait(300)
  r = await remote({ path: "/api/hello" })
  check("A trackpad frame over the size limit closes that socket only", closeCode === 1009 && companion.alive() && r.status === 200, `${closeCode} ${companion.alive() ? r.status : "it exited"}`)
  const pointerLines = fs.existsSync(path.join(dataDir, "pointer.log")) ? fs.readFileSync(path.join(dataDir, "pointer.log"), "utf8").trim().split("\n") : []
  check("…and lets go of the button it held", pointerLines.join("|") === "d|u", pointerLines.join("|"))

  // --- bodies
  const big = JSON.stringify({ accent: "#123456", padding: "x".repeat(300 * 1024) })
  r = await request({ method: "PUT", path: "/api/settings", headers: JSON_TYPE, body: big })
  check("An oversized body gets a 413 reply, not a reset", r.status === 413 && /too large/.test(r.json?.error ?? ""), `${r.status} ${r.text}`)
  r = await chunkedPut("/api/settings", big)
  check("An oversized body without a length gets a 413 reply too", r.status === 413 && /too large/.test(r.json?.error ?? ""), `${r.status} ${r.text}`)
  r = await request({ path: "/api/hello" })
  check("The companion answers normally after refusing a body", r.status === 200, r.status)
  r = await remote({ method: "POST", path: "/api/press", headers: JSON_TYPE, body: JSON.stringify({ padding: "x".repeat(200 * 1024) }) })
  check("An unsigned request is refused before its body is read", r.status === 401 && r.json?.code === "unpaired", `${r.status} ${r.text}`)
  r = await remote({ method: "POST", path: "/api/press", headers: { ...JSON_TYPE, "X-Punchboard-Device": device.id, "X-Punchboard-Time": "soon", "X-Punchboard-Nonce": "n", "X-Punchboard-Signature": "s" }, body: "{}" })
  check("Malformed signature headers are refused", r.status === 401 && r.json?.code === "bad_signature", `${r.status} ${r.text}`)

  // --- signatures
  r = await remote({ path: "/api/library", headers: signed(device, "GET", "/api/library") })
  check("Signed request from paired tablet works", r.status === 200 && Array.isArray(r.json.profiles), r.status)

  const replayHeaders = signed(device, "GET", "/api/status")
  await remote({ path: "/api/status", headers: replayHeaders })
  r = await remote({ path: "/api/status", headers: replayHeaders })
  check("Replayed request refused", r.status === 401 && r.json.code === "replay", r.text)

  const body = JSON.stringify({ profileId: "profile_default", buttonId: "nope" })
  r = await remote({ method: "POST", path: "/api/press", headers: { ...JSON_TYPE, ...signed(device, "POST", "/api/press", body) }, body: body.replace("nope", "btn_1") })
  check("Tampered body refused", r.status === 401 && r.json.code === "bad_signature", r.text)

  r = await remote({ path: "/api/status", headers: signed(device, "GET", "/api/status", "", Date.now() - 10 * 60 * 1000) })
  check("Stale timestamp refused", r.status === 401 && r.json.code === "clock", r.text)

  r = await remote({ path: "/api/status", headers: signed({ id: device.id, secret: "0".repeat(64) }, "GET", "/api/status") })
  check("Wrong secret refused", r.status === 401 && r.json.code === "bad_signature", r.text)

  const inject = JSON.stringify({ profileId: "profile_default", buttonId: "does_not_exist", steps: [{ type: "launch_app", appPath: "/System/Applications/Calculator.app" }] })
  r = await remote({ method: "POST", path: "/api/press", headers: { ...JSON_TYPE, ...signed(device, "POST", "/api/press", inject) }, body: inject })
  check("Steps in the request are ignored; unknown button refused", r.status === 404, `${r.status} ${r.text}`)

  // --- live stream, then revoke
  const sse = S.sign(device, "GET", "/api/events", "", Date.now())
  const streamed = await new Promise((resolve) => {
    const req = http.get({ host: LAN, port: PORT, path: `/api/events?d=${sse.device}&t=${sse.time}&n=${sse.nonce}&s=${sse.signature}`, headers: { Host: `${LAN}:${PORT}` } }, (res) => {
      let got = ""
      let ended = false
      res.on("data", (c) => { got += c })
      res.on("end", () => { ended = true })
      setTimeout(async () => {
        const firstData = got.includes("data:")
        await request({ method: "DELETE", path: `/api/devices/${device.id}` })
        setTimeout(() => { resolve({ status: res.statusCode, firstData, ended }); req.destroy() }, 400)
      }, 400)
    })
  })
  check("Signed live stream connects", streamed.status === 200 && streamed.firstData, JSON.stringify(streamed))
  check("Removing the device cuts its live stream", streamed.ended, JSON.stringify(streamed))
  r = await remote({ path: "/api/library", headers: signed(device, "GET", "/api/library") })
  check("Removed device is refused afterwards", r.status === 401 && r.json.code === "unpaired", r.text)

  // --- brute force
  let lastStatus = 0
  for (let i = 0; i < 9; i++) lastStatus = (await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: '{"code":"123456"}' })).status
  check("Guessing codes locks pairing", lastStatus === 429, lastStatus)
  const freshCode = (await request({ path: "/api/pair" })).json.code
  r = await request({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code: freshCode, name: "Other tablet" }) })
  check("One address guessing does not lock out another", r.status === 200 && r.json.device?.id, r.text)
  r = await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code: (await request({ path: "/api/pair" })).json.code }) })
  check("The guessing address stays locked, even with the right code", r.status === 429, r.status)

  authUnitChecks()

  // --- two Control Center windows
  const lib = await request({ path: "/api/library" })
  const rev = Number(lib.headers["x-library-rev"])
  r = await request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: lib.text })
  check("Save with the current revision works", r.status === 200 && r.json.libraryRev === rev + 1, r.text)
  r = await request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: lib.text })
  check("Stale save from a second window refused", r.status === 409, r.status)

  check("Companion quits cleanly when asked", await stopServer(), "still running after 5 s")
  check("Decks were saved in the data folder", fs.existsSync(path.join(dataDir, "decks", "library.json")), dataDir)
}

main()
  .catch((error) => { console.error(error); tally.fail++ })
  .finally(async () => {
    await stopServer()
    companion.cleanup()
    console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
    process.exit(tally.fail ? 1 : 0)
  })
