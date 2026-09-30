// End-to-end checks for pairing, signatures, access rules and safe saving.
// Starts its own companion on a spare port with a throwaway data folder, so
// it never touches a running Punchboard or anyone's real decks.
//   node tests/security.test.mjs
// "Remote" requests go to this machine's LAN address, which the server
// treats like any tablet.
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { signRequest } from "../src/shared/sign.ts"

const S = { sign: (d, m, p, b, t) => signRequest(d, m, p, b, t, crypto.randomBytes(16).toString("hex")) }

const PORT = 18000 + Math.floor(Math.random() * 1000)
const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address
if (!LAN) {
  console.log("No LAN address on this machine; the remote checks need one.")
  process.exit(1)
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-test-"))
let server = null
let pass = 0, fail = 0
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`) }

/** Starts the companion and resolves once it says it is listening. */
function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, ["src/server/main.ts"], {
      env: { ...process.env, PUNCHBOARD_DATA_DIR: dataDir, PUNCHBOARD_PORT: String(PORT), PUNCHBOARD_NO_OPEN: "1", PUNCHBOARD_DESKTOP: "1" },
      stdio: ["pipe", "pipe", "inherit"]
    })
    let out = ""
    const timer = setTimeout(() => reject(new Error(`The companion did not start:\n${out}`)), 20000)
    server.stdout.on("data", (chunk) => {
      out += chunk
      const ready = out.match(/PUNCHBOARD_READY (\d+)/)
      if (ready) { clearTimeout(timer); resolve(Number(ready[1])) }
    })
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`The companion exited (${code}):\n${out}`)) })
  })
}

/** Asks for the clean exit the desktop app uses, and checks it happens. */
function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve(false)
    const timer = setTimeout(() => { server.kill(); resolve(false) }, 5000)
    server.removeAllListeners("exit")
    server.on("exit", () => { clearTimeout(timer); resolve(true) })
    server.stdin.write("quit\n")
  })
}

function request({ host = "127.0.0.1", method = "GET", path, headers = {}, body, hostHeader }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: PORT, method, path, headers: { Host: hostHeader || `${host}:${PORT}`, ...headers } }, (res) => {
      let text = ""
      res.on("data", (c) => (text += c))
      res.on("end", () => { let json = null; try { json = JSON.parse(text) } catch {} resolve({ status: res.statusCode, json, text, headers: res.headers }) })
    })
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
const remote = (opts) => request({ host: LAN, ...opts })
function signed(device, method, path, body = "", time = Date.now()) {
  const s = S.sign(device, method, path, body, time)
  return { "X-Punchboard-Device": s.device, "X-Punchboard-Time": s.time, "X-Punchboard-Nonce": s.nonce, "X-Punchboard-Signature": s.signature }
}
const JSON_TYPE = { "Content-Type": "application/json" }

async function main() {
  const port = await startServer()
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
  r = await remote({ path: "/api/pair" })
  check("Tablet cannot read the pairing code", r.status === 403, r.status)

  // --- pairing
  r = await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: '{"code":"000001"}' })
  check("Wrong pairing code refused", r.status === 400 && r.json.code === "bad_code", r.text)
  const pairInfo = (await request({ path: "/api/pair" })).json
  r = await remote({ method: "POST", path: "/api/pair/claim", headers: JSON_TYPE, body: JSON.stringify({ code: pairInfo.code, name: "Test iPad" }) })
  check("Right pairing code gives a device secret", r.status === 200 && /^[0-9a-f]{64}$/.test(r.json.device.secret), r.text)
  const device = r.json.device

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
  .catch((error) => { console.error(error); fail++ })
  .finally(async () => {
    await stopServer()
    fs.rmSync(dataDir, { recursive: true, force: true })
    console.log(`\n${pass} passed, ${fail} failed`)
    process.exit(fail ? 1 : 0)
  })
