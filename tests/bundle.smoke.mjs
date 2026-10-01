// Starts the bundled companion the way the desktop app does (dist/server/server.mjs
// with the app folder in PUNCHBOARD_APP_DIR, stdin held open for "quit") and
// checks that it serves. The other tests run
// the TypeScript sources, so a package esbuild cannot bundle, or a file the
// bundle looks for in the wrong place, would only show up in the app.
//   npm run build && npm run build:server && node tests/bundle.smoke.mjs
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checker } from "./companion.mjs"

const BUNDLE = "dist/server/server.mjs"
const NOTICES = "dist/THIRD_PARTY_NOTICES.txt"
if (!fs.existsSync(BUNDLE)) {
  console.error(`No ${BUNDLE}; run npm run build:server first.`)
  process.exit(1)
}

const { check, tally } = checker()
// A spare port and a throwaway data folder: never anyone's real Punchboard.
const port = 19000 + Math.floor(Math.random() * 1000)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-bundle-"))
const child = spawn(process.execPath, [BUNDLE], {
  env: {
    ...process.env,
    // The repository stands in for the app's resources (public/, helpers).
    // Absolute, as the app passes it: the companion's public-folder guard
    // compares against it as given, so a relative "." gets every page a 403.
    PUNCHBOARD_APP_DIR: path.resolve("."),
    PUNCHBOARD_DATA_DIR: dataDir,
    PUNCHBOARD_PORT: String(port),
    PUNCHBOARD_DESKTOP: "1",
    PUNCHBOARD_NO_OPEN: "1"
  },
  // stdin stays open, as in the app: the companion quits when it closes.
  stdio: ["pipe", "pipe", "inherit"]
})

let out = ""
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)))
const ready = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 20000)
  child.stdout.on("data", (chunk) => {
    out += chunk
    const match = out.match(/PUNCHBOARD_READY (\d+)/)
    if (match) { clearTimeout(timer); resolve(Number(match[1])) }
  })
  exited.then(() => { clearTimeout(timer); resolve(null) })
})

try {
  check("the bundle starts and says PUNCHBOARD_READY", ready !== null, out || "it printed nothing")
  if (ready !== null) {
    const hello = await fetch(`http://127.0.0.1:${ready}/api/hello`).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }), (e) => ({ status: 0, error: String(e) }))
    check("/api/hello answers", hello.status === 200 && typeof hello.json?.serverTime === "number", JSON.stringify(hello))
    const deck = await fetch(`http://127.0.0.1:${ready}/deck`).then(async (r) => ({ status: r.status, text: await r.text() }), (e) => ({ status: 0, text: String(e) }))
    check("/deck serves the deck page", deck.status === 200 && /<html/i.test(deck.text), `${deck.status} ${deck.text.slice(0, 200)}`)

    child.stdin.write("quit\n")
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))])
    check('"quit" on stdin stops it cleanly', code === 0, `exit: ${code}`)
  }
  const notices = fs.existsSync(NOTICES) ? fs.readFileSync(NOTICES, "utf8") : ""
  check("the third-party notices were written with the bundle", /^ws@/m.test(notices) && /^obs-websocket-js@/m.test(notices), `${NOTICES} is missing or incomplete`)
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
