// Runs the companion from source (npm start): builds the pages if public/js
// is not there yet, then builds and runs the Rust crate in server/, pointed
// at this repository so it serves ./public. Run this way it is not the
// desktop app: it prints the pairing QR code in the terminal and opens the
// Control Center in the browser. Ctrl+C stops it.
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { ROOT, SERVER_DIR } from "./build-companion.ts"

if (!fs.existsSync(path.join(ROOT, "public", "js", "deck.js"))) {
  console.log("Building the pages...")
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: ROOT, stdio: "inherit" })
}

const companion = spawn("cargo", ["run", "--release", "--locked"], { cwd: SERVER_DIR, stdio: "inherit", env: { ...process.env, PUNCHBOARD_APP_DIR: ROOT } })
// Ctrl+C reaches the companion too, which stops by itself: wait for it.
process.on("SIGINT", () => {})
process.on("SIGTERM", () => companion.kill("SIGTERM"))
companion.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error
  console.error("Running Punchboard from source needs Rust: install it from https://rustup.rs and try again.")
  console.error("Most people should install the app instead: https://github.com/GH-Jaider/punchboard/releases/latest")
  process.exit(1)
})
companion.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
