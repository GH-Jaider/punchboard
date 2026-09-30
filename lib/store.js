// Crash-safe JSON files.
//
// Every write goes to a temporary file that is flushed to disk and then
// renamed over the original, so a crash or power cut mid-write leaves either
// the old file or the new one, never half of each. The previous good version
// is kept as <name>.bak, and a file that will not parse is moved aside rather
// than overwritten.
const fs = require("fs")
const path = require("path")

function writeJsonAtomic(file, data, { backup = true } = {}) {
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

// Returns { data, source } where source is "file", "backup" or "missing".
// Throws only if neither the file nor its backup can be used, after moving the
// damaged file aside so nothing later overwrites it.
function readJsonSafe(file, isValid = () => true) {
  const attempt = (candidate) => {
    const data = JSON.parse(fs.readFileSync(candidate, "utf8"))
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
      const failure = new Error(`${path.basename(file)} could not be read (${error.message}). It was kept as ${path.basename(aside)}.`)
      failure.aside = aside
      throw failure
    }
  }
}

// One snapshot per day in <dir>/backups, keeping the newest `keep`. A restore
// from a file or a bad edit can always be walked back a few days.
function snapshotDaily(file, keep = 14) {
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

module.exports = { writeJsonAtomic, readJsonSafe, snapshotDaily }
