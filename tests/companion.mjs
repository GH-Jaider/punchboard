// Shared by the tests: a companion of their own, on a spare port with a
// throwaway data folder, so they never touch a running Punchboard or anyone's
// real decks.
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

export const LAN = Object.values(os.networkInterfaces()).flat().find((i) => i.family === "IPv4" && !i.internal)?.address

export function checker() {
  const tally = { pass: 0, fail: 0 }
  const check = (name, ok, detail) => {
    ok ? tally.pass++ : tally.fail++
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`)
  }
  return { check, tally }
}

/** Starts a companion; `config` is written to its config.json first. */
export function startCompanion({ config } = {}) {
  const port = 18000 + Math.floor(Math.random() * 1000)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-test-"))
  if (config) fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config))
  // Pointer commands always go to a file, so no test can move the real mouse.
  const pointerLog = process.env.PUNCHBOARD_POINTER_LOG || path.join(dataDir, "pointer.log")
  const child = spawn(process.execPath, ["src/server/main.ts"], {
    env: { ...process.env, PUNCHBOARD_DATA_DIR: dataDir, PUNCHBOARD_PORT: String(port), PUNCHBOARD_NO_OPEN: "1", PUNCHBOARD_DESKTOP: "1", PUNCHBOARD_POINTER_LOG: pointerLog },
    stdio: ["pipe", "pipe", "inherit"]
  })
  let out = ""
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The companion did not start:\n${out}`)), 20000)
    child.stdout.on("data", (chunk) => {
      out += chunk
      const match = out.match(/PUNCHBOARD_READY (\d+)/)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`The companion exited (${code}):\n${out}`)) })
  })

  /** Asks for the clean exit the desktop app uses; true if it happened. */
  function stop() {
    return new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(false)
      const timer = setTimeout(() => { child.kill(); resolve(false) }, 5000)
      child.removeAllListeners("exit")
      child.on("exit", () => { clearTimeout(timer); resolve(true) })
      child.stdin.write("quit\n")
    })
  }

  function request({ host = "127.0.0.1", method = "GET", path: urlPath, headers = {}, body, hostHeader }) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host, port, method, path: urlPath, headers: { Host: hostHeader || `${host}:${port}`, ...headers } }, (res) => {
        let text = ""
        res.on("data", (c) => (text += c))
        res.on("end", () => { let json = null; try { json = JSON.parse(text) } catch {} resolve({ status: res.statusCode, json, text, headers: res.headers }) })
      })
      req.on("error", reject)
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true })
  /** True while the companion process is still running. */
  const alive = () => child.exitCode === null && child.signalCode === null
  return { port, dataDir, ready, stop, request, cleanup, alive, log: () => out }
}

export const JSON_TYPE = { "Content-Type": "application/json" }
