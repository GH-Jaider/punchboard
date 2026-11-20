// Starts the companion the desktop app ships (the Rust sidecar in
// src-tauri/binaries) the way the app does: the same environment main.rs
// sets, PUNCHBOARD_APP_DIR pointing at a folder laid out like the app's
// resources (public/ and licenses/, nothing else of the repository), stdin
// held open for "quit". The other tests run the debug build from inside the
// repository, so a file the release build looks for in the wrong place would
// only show up in the app.
//   npm run build && npm run build:server && node tests/companion.smoke.ts
//   node tests/companion.smoke.ts <path to a punchboard-server>   another copy, e.g. the one inside a built app
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { hostTriple, ROOT, sidecarPath } from "../scripts/build-companion.ts"
import { NOTICES_FILE } from "../scripts/notices.ts"
import { checker } from "./companion.mjs"

const sidecar = process.argv[2] ? path.resolve(process.argv[2]) : sidecarPath(hostTriple())
if (!fs.existsSync(sidecar)) {
  console.error(`No ${sidecar}; run npm run build:server first.`)
  process.exit(1)
}
if (!fs.existsSync(path.join(ROOT, "public", "js", "deck.js"))) {
  console.error("No public/js; run npm run build first.")
  process.exit(1)
}

interface Answer {
  status: number
  type: string
  text: string
}
async function get(port: number, urlPath: string): Promise<Answer> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`)
    return { status: response.status, type: response.headers.get("content-type") ?? "", text: await response.text() }
  } catch (error) {
    return { status: 0, type: "", text: String(error) }
  }
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const { check, tally } = checker()
// A spare port and throwaway folders: never anyone's real Punchboard.
const port = 19000 + Math.floor(Math.random() * 1000)
const work = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-sidecar-"))
const dataDir = path.join(work, "data")
// What the app's resource folder holds (tauri.conf.json's "resources").
const resources = path.join(work, "resources")
fs.mkdirSync(dataDir)
// With no settings of its own the companion takes OBS's from this computer
// and connects to an OBS that is running. This one is pointed at a closed
// port instead, so the test never reaches a real OBS.
fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ obs: { address: "ws://127.0.0.1:1", password: "", source: "manual" } }))
fs.cpSync(path.join(ROOT, "public"), path.join(resources, "public"), { recursive: true })
fs.mkdirSync(path.join(resources, "licenses"))
fs.copyFileSync(path.join(ROOT, "LICENSE"), path.join(resources, "licenses", "LICENSE.txt"))

const version = (JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")) as { version: string }).version
const child = spawn(sidecar, [], {
  // Started from somewhere else, as the app is: nothing may be found through
  // the working folder.
  cwd: work,
  env: {
    ...process.env,
    // What start_companion() in src-tauri/src/main.rs sets.
    PUNCHBOARD_APP_DIR: resources,
    PUNCHBOARD_DESKTOP: "1",
    PUNCHBOARD_VERSION: version,
    PUNCHBOARD_NO_OPEN: "1",
    PUNCHBOARD_LOCALE: "en-US",
    // And what keeps a test away from this computer: its own data and port,
    // and files in place of the sound, the volumes, the apps and the pointer.
    PUNCHBOARD_DATA_DIR: dataDir,
    PUNCHBOARD_PORT: String(port),
    PUNCHBOARD_TEST_SYSTEM: path.join(work, "test-system"),
    PUNCHBOARD_POINTER_LOG: path.join(work, "pointer.log"),
    PUNCHBOARD_KEYS_LOG: path.join(work, "keys.log")
  },
  // stdin stays open, as in the app: the companion quits when it closes.
  stdio: ["pipe", "pipe", "inherit"]
})

let out = ""
const exited = new Promise<number | string | null>((resolve) => {
  child.on("exit", (code, signal) => resolve(code ?? signal))
  child.on("error", (error) => resolve(String(error)))
})
const ready = await new Promise<number | null>((resolve) => {
  const timer = setTimeout(() => resolve(null), 20000)
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString()
    const match = out.match(/PUNCHBOARD_READY (\d+)/)
    if (match) {
      clearTimeout(timer)
      resolve(Number(match[1]))
    }
  })
  void exited.then(() => {
    clearTimeout(timer)
    resolve(null)
  })
})

try {
  check("the sidecar starts and says PUNCHBOARD_READY", ready !== null, out || "it printed nothing")
  if (ready !== null) {
    check("it is on the port it was given", ready === port, `asked for ${port}, got ${ready}`)
    check("it says which language it speaks", /^PUNCHBOARD_LANGUAGE en$/m.test(out), out)
    check("it leaves the OBS on this computer alone", !/Connected to OBS|from this computer/.test(out), out)

    const hello = await get(ready, "/api/hello")
    const helloJson = parse(hello.text) as { serverTime?: unknown } | null
    check("/api/hello answers", hello.status === 200 && typeof helloJson?.serverTime === "number", JSON.stringify(hello))

    const deck = await get(ready, "/deck")
    check("/deck serves the deck page", deck.status === 200 && /<html/i.test(deck.text), `${deck.status} ${deck.text.slice(0, 200)}`)
    const script = await get(ready, "/js/deck.js")
    check("the page's script is served from the resources", script.status === 200 && script.text.length > 1000, `${script.status} ${script.text.slice(0, 200)}`)

    const locale = await get(ready, "/locales/es.json")
    const messages = (parse(locale.text) as { messages?: unknown } | null)?.messages
    check("a locale file is served", locale.status === 200 && typeof messages === "object" && messages !== null, `${locale.status} ${locale.text.slice(0, 200)}`)

    child.stdin.write("quit\n")
    const code = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5000))])
    check('"quit" on stdin stops it cleanly', code === 0, `exit: ${code}`)
  }
  const notices = fs.existsSync(NOTICES_FILE) ? fs.readFileSync(NOTICES_FILE, "utf8") : ""
  check("the third-party notices list the companion's and the app's crates", /^tokio \S+ .*\[companion/m.test(notices) && /^tauri \S+ .*\[app\]/m.test(notices), `${NOTICES_FILE} is missing or incomplete`)
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  fs.rmSync(work, { recursive: true, force: true })
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
