// Runs the black-box tests (the files npm test runs) against the Rust
// companion: builds server/ in debug, then runs each file with PUNCHBOARD_BIN
// pointing at it. Every file runs even after one fails; the exit code says
// whether all passed.
//   node scripts/test-companion.ts                 all of them
//   node scripts/test-companion.ts security obs    only these
//   node scripts/test-companion.ts --except app-volume
// With PUNCHBOARD_BIN already set, that binary is tested and nothing is built.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { BINARY, ROOT, SERVER_DIR } from "./build-companion.ts"

/** The test files, from package.json's "test" script, so there is one list. */
function testFiles(): string[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> }
  const files = [...(manifest.scripts?.test ?? "").matchAll(/node (tests\/[\w-]+\.test\.mjs)/g)].map((match) => match[1] ?? "")
  if (!files.length) throw new Error('package.json\'s "test" script names no test files')
  return files
}

const shortName = (file: string): string => path.basename(file).replace(/\.test\.mjs$/, "")

function debugBinary(): string {
  execFileSync("cargo", ["build", "--locked"], { cwd: SERVER_DIR, stdio: "inherit" })
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(SERVER_DIR, process.env.CARGO_TARGET_DIR) : path.join(SERVER_DIR, "target")
  return path.join(targetDir, "debug", BINARY + (process.platform === "win32" ? ".exe" : ""))
}

const args = process.argv.slice(2)
const except = args[0] === "--except"
const names = new Set((except ? args.slice(1) : args).map(shortName))
const all = testFiles()
const unknown = [...names].filter((name) => !all.some((file) => shortName(file) === name))
if (unknown.length) throw new Error(`No such test file: ${unknown.join(", ")}`)
const chosen = all.filter((file) => (names.size === 0 ? true : names.has(shortName(file)) !== except))

const binary = process.env.PUNCHBOARD_BIN ? path.resolve(process.env.PUNCHBOARD_BIN) : debugBinary()
const failed: string[] = []
for (const file of chosen) {
  console.log(`\n=== ${file} (${path.relative(ROOT, binary)})`)
  const result = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: "inherit", env: { ...process.env, PUNCHBOARD_BIN: binary } })
  if (result.status !== 0) failed.push(file)
}
console.log(failed.length ? `\nFailed against the Rust companion: ${failed.join(", ")}` : `\nAll ${chosen.length} test files passed against the Rust companion.`)
process.exit(failed.length ? 1 : 0)
