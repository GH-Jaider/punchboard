// Merges the per-platform fragments in release/<version>/ into the
// latest.json the updater reads from the latest GitHub release.
//   node scripts/latest-json.mjs [notes]
import fs from "node:fs"
import path from "node:path"

const REPO = "GH-Jaider/punchboard"
const version = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")).version
const dir = path.join("release", version)
const platforms = {}

for (const name of fs.readdirSync(dir).filter((n) => /^latest-.+\.json$/.test(n))) {
  const fragment = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
  if (!fragment.signature) throw new Error(`${name} has no updater signature; it cannot go in latest.json`)
  platforms[fragment.platform] = {
    signature: fragment.signature,
    url: `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(fragment.file)}`
  }
}
if (!Object.keys(platforms).length) throw new Error(`No platform fragments in ${dir}`)

const latest = { version, notes: process.argv[2] ?? `Punchboard ${version}`, pub_date: new Date().toISOString(), platforms }
fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latest, null, 2) + "\n")
console.log(`Wrote ${path.join(dir, "latest.json")} for ${Object.keys(platforms).join(", ")}`)
