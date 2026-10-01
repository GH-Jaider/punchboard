// Writes dist/THIRD_PARTY_NOTICES.txt: the licence of every npm package
// esbuild bundled into server.mjs, which the desktop app ships. The list
// comes from the bundle itself (esbuild's metafile), so a package added or
// dropped is picked up without anyone keeping a list, and the text comes from
// each package's own licence file. Nothing in it depends on the date or the
// machine, so the same lockfile always gives the same file.
//   npm run build:server       bundles, then writes the notices
//   node scripts/notices.mjs   writes them again from the last bundle
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const NOTICES_FILE = "dist/THIRD_PARTY_NOTICES.txt"
/** What esbuild says went into server.mjs, saved by build-server.mjs. */
export const METAFILE = "dist/server/meta.json"

/** node_modules/a/node_modules/@b/c/lib/x.js -> node_modules/a/node_modules/@b/c */
function packageDir(input) {
  return input.replace(/\\/g, "/").match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1]
}

function licenceText(dir, declared) {
  const files = fs.readdirSync(dir).filter((name) => /^(licen[cs]e|copying|notice)(\b|[.-]|$)/i.test(name)).sort()
  if (!files.length) return `The package has no licence file; its package.json declares: ${declared ?? "nothing"}.`
  return files.map((name) => fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n").trim()).join("\n\n")
}

/** Writes the notices for the packages in an esbuild metafile; returns their names. */
export function writeNotices(metafile) {
  const dirs = [...new Set(Object.keys(metafile.inputs).map(packageDir).filter(Boolean))]
  const packages = dirs.map((dir) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
    const declared = typeof manifest.license === "string" ? manifest.license : manifest.license?.type
    return { id: `${manifest.name}@${manifest.version}`, declared, text: licenceText(dir, declared) }
  })
  // One entry per name@version, however many copies node_modules holds.
  const unique = [...new Map(packages.map((p) => [p.id, p])).values()].sort((a, b) => (a.id < b.id ? -1 : 1))
  const rule = "=".repeat(78)
  const body = unique.map((p) => `${rule}\n${p.id}${p.declared ? ` (${p.declared})` : ""}\n${rule}\n\n${p.text}\n`).join("\n")
  const header =
    "Punchboard's companion (server.mjs) includes the following open source\n" +
    "packages. Their licences follow. The Node.js runtime that ships with the\n" +
    "app has its own licence in node-LICENSE.txt beside this file.\n\n"
  fs.mkdirSync(path.dirname(NOTICES_FILE), { recursive: true })
  fs.writeFileSync(NOTICES_FILE, header + body)
  return unique.map((p) => p.id)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(METAFILE)) throw new Error(`No ${METAFILE}; run npm run build:server first.`)
  const ids = writeNotices(JSON.parse(fs.readFileSync(METAFILE, "utf8")))
  console.log(`Wrote ${NOTICES_FILE} (${ids.length} packages)`)
}
