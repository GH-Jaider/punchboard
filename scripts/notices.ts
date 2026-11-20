// Writes dist/THIRD_PARTY_NOTICES.txt: the licence of every Rust crate linked
// into what the desktop app ships, the companion (server/) and the app's own
// shell (src-tauri/). The list comes from Cargo itself (cargo metadata, for
// the target being built), so a crate added or dropped is picked up without
// anyone keeping a list, and the text comes from each crate's own licence
// files. Nothing in it depends on the date or the machine, so the same
// lockfiles and target always give the same file.
//   node scripts/notices.ts                          this machine's target
//   node scripts/notices.ts x86_64-pc-windows-msvc   one or more others
// It prints the crates whose licence is not one of the usual permissive ones,
// for a person to look at.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { requestedTriples, ROOT, SERVER_DIR, TAURI_DIR } from "./build-companion.ts"

export const NOTICES_FILE: string = path.join(ROOT, "dist", "THIRD_PARTY_NOTICES.txt")

/** The two programs in the app, and what the notices call them. */
const PROGRAMS: readonly { label: string; dir: string }[] = [
  { label: "companion", dir: SERVER_DIR },
  { label: "app", dir: TAURI_DIR }
]

/** Licences that ask for no more than keeping their text, which this file does. */
const PERMISSIVE = /^(MIT|MIT-0|Apache-2\.0|Apache-2\.0 WITH LLVM-exception|BSD-2-Clause|BSD-3-Clause|0BSD|ISC|Zlib|Unicode-3\.0|Unicode-DFS-2016)$/

// The parts of `cargo metadata --format-version 1` read here.
interface MetadataPackage {
  id: string
  name: string
  version: string
  license: string | null
  license_file: string | null
  source: string | null
  manifest_path: string
  targets: { kind: string[] }[]
}
interface MetadataNode {
  id: string
  deps: { pkg: string; dep_kinds: { kind: string | null }[] }[]
}
interface Metadata {
  packages: MetadataPackage[]
  resolve: { root: string | null; nodes: MetadataNode[] }
}

export interface Crate {
  /** "tokio 1.48.0" */
  id: string
  /** The SPDX expression from its Cargo.toml, if it has one. */
  declared: string | null
  /** Its folder in the registry source. */
  dir: string
  /** Which programs link it: "companion", "app". */
  programs: string[]
}

/** The crates linked into the program in `dir` when built for `triple`:
    everything reached from it through normal dependencies. Build scripts'
    and tests' dependencies are not in the program, nor are procedural
    macros, which run in the compiler. */
function linkedCrates(dir: string, triple: string): MetadataPackage[] {
  const text = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", triple], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 256 * 1048576
  })
  const metadata = JSON.parse(text) as Metadata
  const root = metadata.resolve.root
  if (!root) throw new Error(`cargo metadata named no root package in ${dir}`)
  const packages = new Map(metadata.packages.map((p) => [p.id, p]))
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]))
  const isMacro = (id: string): boolean => packages.get(id)?.targets.some((t) => t.kind.includes("proc-macro")) ?? false

  const seen = new Set<string>([root])
  const queue = [root]
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const dep of nodes.get(id)?.deps ?? []) {
      const normal = dep.dep_kinds.some((k) => k.kind === null)
      if (!normal || seen.has(dep.pkg) || isMacro(dep.pkg)) continue
      seen.add(dep.pkg)
      queue.push(dep.pkg)
    }
  }
  seen.delete(root)
  // Only what comes from somewhere else: a crate of this repository is Punchboard's own.
  return [...seen].map((id) => packages.get(id)).filter((p): p is MetadataPackage => p !== undefined && p.source !== null)
}

/** Every third-party crate in the app built for these targets, sorted by name. */
export function shippedCrates(triples: readonly string[]): Crate[] {
  const crates = new Map<string, Crate>()
  for (const program of PROGRAMS) {
    for (const triple of triples) {
      for (const p of linkedCrates(program.dir, triple)) {
        const id = `${p.name} ${p.version}`
        const crate = crates.get(id) ?? { id, declared: p.license, dir: path.dirname(p.manifest_path), programs: [] }
        if (!crate.programs.includes(program.label)) crate.programs.push(program.label)
        crates.set(id, crate)
      }
    }
  }
  return [...crates.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Whether an SPDX expression can be met with permissive licences alone:
    of every "A OR B" a permissive one can be picked, and every part joined
    by AND must be. Older crates write OR as "/". */
export function isPermissive(declared: string | null): boolean {
  if (!declared) return false
  return declared
    .replace(/[()]/g, "")
    .split(/\s+AND\s+/)
    .every((part) => part.split(/\s+OR\s+|\s*\/\s*/).some((licence) => PERMISSIVE.test(licence.trim())))
}

/** The licence files in a crate's folder, as { name, text }. */
function licenceFiles(dir: string): { name: string; text: string }[] {
  return fs
    .readdirSync(dir)
    .filter((name) => /^(licen[cs]e|copying|notice|unlicense)(\b|[._-]|$)/i.test(name) && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8").replace(/\r\n/g, "\n").trim() }))
    .filter((file) => file.text.length > 0)
}

/** Writes the notices for the app built for `triples`; returns the crates. */
export function writeNotices(triples: readonly string[]): Crate[] {
  const crates = shippedCrates(triples)
  const rule = "=".repeat(78)

  // Most crates carry the very same Apache-2.0 and MIT texts: each distinct
  // text is printed once, under the crates it came with.
  const texts = new Map<string, string[]>()
  const without: Crate[] = []
  for (const crate of crates) {
    const files = licenceFiles(crate.dir)
    if (!files.length) without.push(crate)
    for (const file of files) {
      const owners = texts.get(file.text) ?? []
      owners.push(`${crate.id} (${file.name})`)
      texts.set(file.text, owners)
    }
  }

  const header =
    "Punchboard's desktop app is two programs: the companion (punchboard-server),\n" +
    "which serves the decks and runs their buttons, and the app itself (the\n" +
    "window and the menu-bar icon). They include the open source Rust crates\n" +
    "listed below, each with the licence it declares and the program it is in.\n" +
    "The texts of those licences follow the list. Both programs also include\n" +
    "the Rust standard library (MIT OR Apache-2.0). The Control Center's tour is\n" +
    "driver.js, whose MIT licence heads public/js/tour.js.\n\n"
  const list = crates.map((c) => `${c.id}  (${c.declared ?? "no licence declared"})  [${c.programs.join(", ")}]`).join("\n")
  const missing = without.length
    ? `\n\nThese crates have no licence file of their own; what they declare is in the list above:\n${without.map((c) => `${c.id}`).join("\n")}`
    : ""
  const body = [...texts.entries()].map(([text, owners]) => `${rule}\n${owners.join("\n")}\n${rule}\n\n${text}\n`).join("\n")

  fs.mkdirSync(path.dirname(NOTICES_FILE), { recursive: true })
  fs.writeFileSync(NOTICES_FILE, `${header}${list}${missing}\n\n${body}`)
  return crates
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const triples = requestedTriples(process.argv.slice(2))
  const crates = writeNotices(triples)
  console.log(`Wrote ${path.relative(ROOT, NOTICES_FILE)} (${crates.length} crates, for ${triples.join(", ")})`)
  const flagged = crates.filter((c) => !isPermissive(c.declared))
  if (flagged.length) {
    console.log(`To look at: ${flagged.length} with a licence that is not MIT, Apache-2.0, BSD, ISC, Zlib or Unicode:`)
    for (const c of flagged) console.log(`  ${c.id}  (${c.declared ?? "no licence declared"})  [${c.programs.join(", ")}]`)
  }
}
