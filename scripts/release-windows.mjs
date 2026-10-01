// Builds the Windows release: the NSIS installer people download, which is
// also what the updater installs, plus its updater signature.
//   node scripts/release-windows.mjs [x86_64-pc-windows-msvc]
// Runs on Windows (GitHub Actions does it). Needs TAURI_SIGNING_PRIVATE_KEY
// and TAURI_SIGNING_PRIVATE_KEY_PASSWORD for the updater signature: a Windows
// build nobody's app can update to is no release, so without them it stops.
// Output: release/<version>/, plus a latest-windows-*.json fragment for
// scripts/latest-json.mjs.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const TARGETS = { "x86_64-pc-windows-msvc": "windows-x86_64", "aarch64-pc-windows-msvc": "windows-aarch64" }

const target = process.argv[2] ?? "x86_64-pc-windows-msvc"
const platform = TARGETS[target]
if (!platform) throw new Error(`Unknown target ${target}`)
const version = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const outDir = path.join("release", version)
fs.mkdirSync(outDir, { recursive: true })

const run = (file, args) => execFileSync(file, args, { stdio: "inherit", shell: process.platform === "win32" })

// tauri.conf.json asks for updater artifacts, and tauri build refuses to make
// them without the key, after compiling everything; say so up front instead.
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY is not set: the installer could not be signed for the updater.")
}

run("node", ["scripts/fetch-node.mjs", target])
const nsisDir = path.join("src-tauri", "target", target, "release", "bundle", "nsis")
// An installer or signature left by an earlier build of this version must not
// be mistaken for this one's.
fs.rmSync(nsisDir, { recursive: true, force: true })
run("npx", ["tauri", "build", "--target", target, "--bundles", "nsis"])

const installer = fs.readdirSync(nsisDir).find((name) => name.endsWith("-setup.exe") && name.includes(version))
if (!installer) throw new Error(`No installer for ${version} in ${nsisDir}`)
const signatureFile = path.join(nsisDir, `${installer}.sig`)
if (!fs.existsSync(signatureFile)) throw new Error(`tauri build made no updater signature (${signatureFile})`)

const file = `Punchboard_${version}_windows-${target.startsWith("aarch64") ? "arm64" : "x64"}-setup.exe`
fs.copyFileSync(path.join(nsisDir, installer), path.join(outDir, file))
const signature = fs.readFileSync(signatureFile, "utf8").trim()
fs.writeFileSync(path.join(outDir, `${file}.sig`), signature)
fs.writeFileSync(path.join(outDir, `latest-${platform}.json`), JSON.stringify({ platform, file, signature }, null, 2))
console.log(`Done: ${path.join(outDir, file)}`)
