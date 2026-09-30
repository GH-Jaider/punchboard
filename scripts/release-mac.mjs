// Builds a Mac release: for each target, the app, signed with our own
// certificate, as a .dmg for people and a signed .app.tar.gz for the updater.
//
//   node scripts/release-mac.mjs                      both Apple Silicon and Intel
//   node scripts/release-mac.mjs aarch64-apple-darwin just one
//
// Output: release/<version>/, plus latest-<target>.json fragments that
// scripts/latest-json.mjs merges into the updater's latest.json.
// Needs: ~/.punchboard-signing (or the CI secrets), rcodesign, and for the
// updater signature TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) or the local key.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { signApp, signingAvailable } from "./mac-signing.mjs"

const TARGETS = { "aarch64-apple-darwin": "darwin-aarch64", "x86_64-apple-darwin": "darwin-x86_64" }
const ARCH_LABEL = { "aarch64-apple-darwin": "apple-silicon", "x86_64-apple-darwin": "intel" }

const version = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const outDir = path.join("release", version)
fs.mkdirSync(outDir, { recursive: true })

const requested = process.argv.slice(2)
const targets = requested.length ? requested : Object.keys(TARGETS)

// The updater key: CI secrets, or the local one beside the certificate.
const signingDir = path.join(os.homedir(), ".punchboard-signing")
const updaterKey = process.env.TAURI_SIGNING_PRIVATE_KEY ?? (fs.existsSync(path.join(signingDir, "updater.key")) ? fs.readFileSync(path.join(signingDir, "updater.key"), "utf8") : null)
const updaterPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? (fs.existsSync(path.join(signingDir, "updater-password")) ? fs.readFileSync(path.join(signingDir, "updater-password"), "utf8") : "")

const run = (file, args, env = {}) => execFileSync(file, args, { stdio: "inherit", env: { ...process.env, ...env } })

for (const target of targets) {
  const platform = TARGETS[target]
  if (!platform) throw new Error(`Unknown target ${target}`)
  console.log(`\n=== ${target}`)
  run("node", ["scripts/fetch-node.mjs", target])

  // Built without Tauri's own updater artifacts: they would pack the app
  // before it is signed. They are made below, after signing.
  const env = { TAURI_SIGNING_PRIVATE_KEY: "", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" }
  run("npx", ["tauri", "build", "--target", target, "--bundles", "app", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } })], env)

  const app = path.join("src-tauri", "target", target, "release", "bundle", "macos", "Punchboard.app")
  if (signingAvailable()) {
    console.log(`Signed: ${signApp(app)}`)
  } else {
    console.warn("No signing certificate: the app keeps an ad-hoc signature and macOS may forget its permissions on update.")
  }

  const base = `Punchboard_${version}_${ARCH_LABEL[target]}`

  // The updater's archive: Punchboard.app at the top of a .tar.gz, signed.
  const archive = path.join(outDir, `${base}.app.tar.gz`)
  run("tar", ["-czf", archive, "-C", path.dirname(app), "Punchboard.app"])
  let signature = null
  if (updaterKey) {
    execFileSync("npx", ["tauri", "signer", "sign", "-k", updaterKey, "-p", updaterPassword, archive], { stdio: ["ignore", "ignore", "inherit"] })
    signature = fs.readFileSync(`${archive}.sig`, "utf8").trim()
  } else {
    console.warn("No updater key: this build cannot be offered as an automatic update.")
  }

  // The .dmg people download: the app beside a link to Applications.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-dmg-"))
  run("ditto", [app, path.join(staging, "Punchboard.app")])
  fs.symlinkSync("/Applications", path.join(staging, "Applications"))
  const dmg = path.join(outDir, `${base}.dmg`)
  if (fs.existsSync(dmg)) fs.rmSync(dmg)
  run("hdiutil", ["create", "-quiet", "-volname", "Punchboard", "-srcfolder", staging, "-fs", "HFS+", "-format", "UDZO", "-imagekey", "zlib-level=9", dmg])
  fs.rmSync(staging, { recursive: true, force: true })

  fs.writeFileSync(path.join(outDir, `latest-${platform}.json`), JSON.stringify({ platform, file: path.basename(archive), signature }, null, 2))
  // Packed into the .dmg and the archive now; a loose copy in target/ would
  // show up in Spotlight and Launchpad as a second Punchboard.
  fs.rmSync(app, { recursive: true, force: true })
  console.log(`Done: ${dmg} (${(fs.statSync(dmg).size / 1048576).toFixed(0)} MB)`)
}
