// Downloads the Node.js binary that ships inside the desktop app, checked
// against nodejs.org's published SHA-256 sums, and names it the way Tauri
// expects a sidecar: src-tauri/binaries/node-<target triple>.
//   node scripts/fetch-node.mjs                 this machine's target
//   node scripts/fetch-node.mjs x86_64-apple-darwin
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const VERSION = "24.15.0"
const TARGETS = {
  "aarch64-apple-darwin": { archive: `node-v${VERSION}-darwin-arm64.tar.gz`, inner: `node-v${VERSION}-darwin-arm64/bin/node` },
  "x86_64-apple-darwin": { archive: `node-v${VERSION}-darwin-x64.tar.gz`, inner: `node-v${VERSION}-darwin-x64/bin/node` },
  "x86_64-pc-windows-msvc": { archive: `node-v${VERSION}-win-x64.zip`, inner: `node-v${VERSION}-win-x64/node.exe` },
  "aarch64-pc-windows-msvc": { archive: `node-v${VERSION}-win-arm64.zip`, inner: `node-v${VERSION}-win-arm64/node.exe` }
}

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1]
const target = process.argv[2] ?? host
const spec = TARGETS[target]
if (!spec) throw new Error(`No Node build known for ${target}`)

const outDir = "src-tauri/binaries"
const out = path.join(outDir, `node-${target}${target.includes("windows") ? ".exe" : ""}`)
if (fs.existsSync(out)) {
  console.log(`${out} is already there`)
  process.exit(0)
}

const base = `https://nodejs.org/dist/v${VERSION}`
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
const expected = sums.split("\n").find((line) => line.endsWith(`  ${spec.archive}`))?.split(/\s+/)[0]
if (!expected) throw new Error(`No checksum published for ${spec.archive}`)

console.log(`Downloading ${spec.archive}…`)
const data = Buffer.from(await (await fetch(`${base}/${spec.archive}`)).arrayBuffer())
const actual = createHash("sha256").update(data).digest("hex")
if (actual !== expected) throw new Error(`Checksum mismatch for ${spec.archive}; nothing was saved.`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-node-"))
const archive = path.join(tmp, spec.archive)
fs.writeFileSync(archive, data)
execFileSync("tar", ["-xf", archive, "-C", tmp, spec.inner])
fs.mkdirSync(outDir, { recursive: true })
fs.copyFileSync(path.join(tmp, spec.inner), out)
fs.chmodSync(out, 0o755)
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`Saved ${out} (${(fs.statSync(out).size / 1048576).toFixed(0)} MB, checksum verified)`)
