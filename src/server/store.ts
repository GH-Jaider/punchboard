// Crash-safe JSON files.
//
// Every write goes to a temporary file that is flushed to disk and then
// renamed over the original, so a crash or power cut mid-write leaves either
// the old file or the new one, never half of each. The previous good version
// is kept as <name>.bak, and a file that will not parse is moved aside rather
// than overwritten.
import fs from "node:fs"
import path from "node:path"

export function writeJsonAtomic(file: string, data: unknown, { backup = true }: { backup?: boolean } = {}): void {
  const text = JSON.stringify(data, null, 2) + "\n"
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  const handle = fs.openSync(temp, "w", 0o600)
  try {
    fs.writeSync(handle, text)
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  if (backup && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  fs.renameSync(temp, file)
}

export type ReadResult<T> =
  | { data: null; source: "missing" }
  | { data: T; source: "file" }
  | { data: T; source: "backup"; aside: string }

/** An unreadable file and its backup; the damaged file has been moved to `aside`. */
export class UnreadableFileError extends Error {
  readonly aside: string
  constructor(message: string, aside: string) {
    super(message)
    this.aside = aside
  }
}

/** Reads a JSON file, falling back to its backup. Throws only if neither can be
    used, after moving the damaged file aside so nothing later overwrites it. */
export function readJsonSafe<T>(file: string, isValid: (data: unknown) => data is T): ReadResult<T> {
  const attempt = (candidate: string): T => {
    const data: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"))
    if (!isValid(data)) throw new Error("unexpected shape")
    return data
  }
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.bak`)) return { data: null, source: "missing" }
  try {
    return { data: attempt(file), source: "file" }
  } catch (error) {
    const aside = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
    if (fs.existsSync(file)) fs.renameSync(file, aside)
    try {
      return { data: attempt(`${file}.bak`), source: "backup", aside }
    } catch {
      const reason = error instanceof Error ? error.message : String(error)
      throw new UnreadableFileError(`${path.basename(file)} could not be read (${reason}). It was kept as ${path.basename(aside)}.`, aside)
    }
  }
}

/** One snapshot per day in <dir>/backups, keeping the newest `keep`, so a bad
    edit or restore can always be walked back a few days. */
export function snapshotDaily(file: string, keep = 14): void {
  if (!fs.existsSync(file)) return
  const dir = path.join(path.dirname(file), "backups")
  const stamp = new Date().toISOString().slice(0, 10)
  const target = path.join(dir, `${path.basename(file, ".json")}-${stamp}.json`)
  if (fs.existsSync(target)) return
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(file, target)
  const old = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse().slice(keep)
  for (const name of old) fs.unlinkSync(path.join(dir, name))
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
