// Builds the companion (the Rust crate in server/) for the desktop app and
// names it the way Tauri expects a sidecar:
// src-tauri/binaries/punchboard-server-<target triple>[.exe].
//   node scripts/build-companion.ts                       this machine's target
//   node scripts/build-companion.ts x86_64-apple-darwin   one or more others
// Run by `tauri build` (beforeBuildCommand, through npm run build:server), it
// builds for the target Tauri is building: TAURI_ENV_TARGET_TRIPLE says which.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const SERVER_DIR: string = path.join(ROOT, "server")
export const TAURI_DIR: string = path.join(ROOT, "src-tauri")
/** The sidecar's name in tauri.conf.json's externalBin and in main.rs. */
export const BINARY = "punchboard-server"

const executable = (triple: string): string => BINARY + (triple.includes("windows") ? ".exe" : "")

/** The target triple of the Rust installed here ("aarch64-apple-darwin"). */
export function hostTriple(): string {
  const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1]
  if (!host) throw new Error("rustc -vV did not say which target this machine is")
  return host.trim()
}

/** The triples asked for: on the command line, else the one Tauri is building, else this machine's. */
export function requestedTriples(args: readonly string[]): string[] {
  if (args.length) return [...args]
  const fromTauri = process.env.TAURI_ENV_TARGET_TRIPLE
  return [fromTauri || hostTriple()]
}

/** Where Tauri looks for the sidecar of a target. */
export function sidecarPath(triple: string): string {
  return path.join(TAURI_DIR, "binaries", `${BINARY}-${triple}${triple.includes("windows") ? ".exe" : ""}`)
}

/** The oldest macOS the app runs on, so the companion is built for it too. */
function minimumMacOS(): string | undefined {
  const conf: unknown = JSON.parse(fs.readFileSync(path.join(TAURI_DIR, "tauri.conf.json"), "utf8"))
  const version = (conf as { bundle?: { macOS?: { minimumSystemVersion?: unknown } } }).bundle?.macOS?.minimumSystemVersion
  return typeof version === "string" ? version : undefined
}

/** Builds the companion in release for one target and puts it where Tauri wants it; returns that path. */
export function buildCompanion(triple: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const macOS = triple.includes("apple") ? minimumMacOS() : undefined
  if (macOS) env.MACOSX_DEPLOYMENT_TARGET = macOS
  // Always with --target, so the result is in target/<triple>/release whether
  // or not that is this machine's own.
  execFileSync("cargo", ["build", "--release", "--locked", "--target", triple], { cwd: SERVER_DIR, stdio: "inherit", env })
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(SERVER_DIR, process.env.CARGO_TARGET_DIR) : path.join(SERVER_DIR, "target")
  const built = path.join(targetDir, triple, "release", executable(triple))
  const out = sidecarPath(triple)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.copyFileSync(built, out)
  if (!triple.includes("windows")) fs.chmodSync(out, 0o755)
  return out
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const triple of requestedTriples(process.argv.slice(2))) {
    const out = buildCompanion(triple)
    console.log(`Built ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`)
  }
}
