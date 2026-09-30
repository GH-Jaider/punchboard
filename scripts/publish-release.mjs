// Publishes a finished release where the app's updater looks for it.
//
//   node scripts/publish-release.mjs [notes]
//
// Collects the Windows installer built by GitHub Actions for this version's
// tag (and the Mac builds too, unless release/<version>/ already has them
// from `npm run release:mac`), writes latest.json, and creates the release
// on the public releases repository. Uses your own `gh` login, so CI needs
// no extra token.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const CODE_REPO = "GH-Jaider/punchboard"
const RELEASES_REPO = "GH-Jaider/punchboard-releases"
const version = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const tag = `v${version}`
const dir = path.join("release", version)
fs.mkdirSync(dir, { recursive: true })

const gh = (args, options = {}) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options })

// The newest successful build of this tag.
const runs = JSON.parse(gh(["run", "list", "-R", CODE_REPO, "--workflow", "release.yml", "--branch", tag, "--status", "success", "--limit", "1", "--json", "databaseId"]))
if (!runs.length) throw new Error(`No successful release build for ${tag} yet. Push the tag and wait for GitHub Actions to finish.`)
const runId = String(runs[0].databaseId)

const haveMac = fs.readdirSync(dir).some((name) => name.startsWith("latest-darwin-"))
const artifacts = haveMac ? ["windows"] : ["windows", "mac"]
for (const name of artifacts) {
  console.log(`Downloading the ${name} build from run ${runId}…`)
  gh(["run", "download", runId, "-R", CODE_REPO, "-n", `punchboard-${name}`, "-D", dir], { stdio: "inherit" })
}

execFileSync("node", ["scripts/latest-json.mjs", ...process.argv.slice(2)], { stdio: "inherit" })

const assets = fs.readdirSync(dir)
  .filter((name) => /\.(dmg|exe|tar\.gz|sig)$/.test(name) || name === "latest.json")
  .map((name) => path.join(dir, name))
gh(["release", "create", tag, "-R", RELEASES_REPO, "--title", `Punchboard ${version}`, "--notes", process.argv[2] ?? `Punchboard ${version}`, ...assets], { stdio: "inherit" })
console.log(`Published ${tag}: https://github.com/${RELEASES_REPO}/releases/tag/${tag}`)
