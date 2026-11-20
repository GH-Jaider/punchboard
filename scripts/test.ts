// Runs the tests (npm test): builds the companion (server/) in debug, then
// runs every tests/*.test.mjs against it. Every file runs even after one
// fails; a table of what passed ends the run, and the exit code says whether
// everything did.
//   node scripts/test.ts                 all of them
//   node scripts/test.ts security obs    only these
//   node scripts/test.ts --except designer tour
// With PUNCHBOARD_BIN set, that companion is tested and nothing is built
// (a release build, the one inside a built app, the Linux container's).
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { BINARY, ROOT, SERVER_DIR } from "./build-companion.ts"

/** The test files: every tests/*.test.mjs, so there is no list to keep. */
function testFiles(): string[] {
  return fs.readdirSync(path.join(ROOT, "tests")).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `tests/${name}`)
}

const shortName = (file: string): string => path.basename(file).replace(/\.test\.mjs$/, "")

function debugBinary(): string {
  execFileSync("cargo", ["build", "--locked"], { cwd: SERVER_DIR, stdio: "inherit" })
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(SERVER_DIR, process.env.CARGO_TARGET_DIR) : path.join(SERVER_DIR, "target")
  return path.join(targetDir, "debug", BINARY + (process.platform === "win32" ? ".exe" : ""))
}

interface Result { file: string; pass: number; fail: number; code: number | null }

/** Runs one file, showing what it prints as it comes and counting its PASS and FAIL lines. */
function run(file: string, binary: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { cwd: ROOT, stdio: ["inherit", "pipe", "inherit"], env: { ...process.env, PUNCHBOARD_BIN: binary } })
    let pending = ""
    let pass = 0
    let fail = 0
    const count = (line: string): void => {
      if (line.startsWith("PASS  ")) pass += 1
      else if (line.startsWith("FAIL  ")) fail += 1
    }
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk)
      const lines = (pending + chunk.toString("utf8")).split("\n")
      pending = lines.pop() ?? ""
      lines.forEach(count)
    })
    child.on("close", (code) => {
      count(pending)
      resolve({ file, pass, fail, code })
    })
  })
}

const args = process.argv.slice(2)
const except = args[0] === "--except"
const names = new Set((except ? args.slice(1) : args).map(shortName))
const all = testFiles()
const unknown = [...names].filter((name) => !all.some((file) => shortName(file) === name))
if (unknown.length) throw new Error(`No such test file: ${unknown.join(", ")}`)
const chosen = all.filter((file) => (names.size === 0 ? true : names.has(shortName(file)) !== except))

if (!fs.existsSync(path.join(ROOT, "public", "js", "deck.js"))) {
  console.error("There is no public/js: the tests open the pages the companion serves. Run npm run build first.")
  process.exit(1)
}
const binary = process.env.PUNCHBOARD_BIN ? path.resolve(process.env.PUNCHBOARD_BIN) : debugBinary()
const results: Result[] = []
for (const file of chosen) {
  console.log(`\n=== ${file} (${path.relative(ROOT, binary)})`)
  results.push(await run(file, binary))
}

console.log("\n=== Summary")
for (const result of results) {
  const note = result.code === 0 ? "" : result.fail ? "" : `  (exit ${result.code})`
  console.log(`${String(result.pass).padStart(5)} passed ${String(result.fail).padStart(3)} failed  ${result.file}${note}`)
}
const pass = results.reduce((sum, result) => sum + result.pass, 0)
const fail = results.reduce((sum, result) => sum + result.fail, 0)
const failed = results.filter((result) => result.code !== 0)
console.log(`${String(pass).padStart(5)} passed ${String(fail).padStart(3)} failed  in ${results.length} files`)
if (failed.length) console.log(`Failed: ${failed.map((result) => result.file).join(", ")}`)
process.exit(failed.length ? 1 : 0)
