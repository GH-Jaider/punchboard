// Where things live. The app's own files (pages, helpers) are read-only and
// get replaced by every update; everything the user makes lives in a data
// folder of its own, so an update can never take a deck, a sound or a
// pairing with it.
//
//   macOS    ~/Library/Application Support/Punchboard
//   Windows  %APPDATA%\Punchboard
//   Linux    $XDG_CONFIG_HOME/punchboard (or ~/.config/punchboard)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** The app's files: public/ and the helpers. The desktop app points this at its resources. */
export const APP_DIR = process.env.PUNCHBOARD_APP_DIR ?? fileURLToPath(new URL("../../", import.meta.url))

export function defaultDataDir(): string {
  const home = os.homedir()
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Punchboard")
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Punchboard")
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "punchboard")
}

/** PUNCHBOARD_DATA_DIR overrides it (tests, a portable copy). */
export const DATA_DIR = process.env.PUNCHBOARD_DATA_DIR ?? defaultDataDir()

export const paths = {
  public: path.join(APP_DIR, "public"),
  helpers: path.join(APP_DIR, "src", "server", "helpers"),
  config: path.join(DATA_DIR, "config.json"),
  library: path.join(DATA_DIR, "decks", "library.json"),
  sounds: path.join(DATA_DIR, "sounds"),
  devices: path.join(DATA_DIR, "devices.json"),
  cache: path.join(DATA_DIR, "cache"),
  /** Recordings from trackpad decks in debug mode, for the touchpad tests. */
  traces: path.join(DATA_DIR, "trackpad-traces")
}

/** Where earlier versions kept the same things, inside the app folder. */
const LEGACY = {
  config: path.join(APP_DIR, "config.json"),
  library: path.join(APP_DIR, "profiles", "current-profile.json"),
  sounds: path.join(APP_DIR, "sounds"),
  devices: path.join(APP_DIR, "data", "devices.json")
}

function copyInto(from: string, to: string): boolean {
  if (!fs.existsSync(from) || fs.existsSync(to)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true })
  return true
}

/** Copies data from the app folder into the data folder, once, before
    anything reads it. The old copies stay where they were, so nothing is lost
    if something goes wrong; the data folder wins from then on. */
export function migrateLegacyData(log: (message: string) => void): void {
  if (path.resolve(DATA_DIR) === path.resolve(APP_DIR)) return
  // A data folder chosen on purpose (tests, a portable copy) starts as it is.
  if (process.env.PUNCHBOARD_DATA_DIR) return
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const moved: string[] = []
  if (copyInto(LEGACY.config, paths.config)) moved.push("settings")
  if (copyInto(LEGACY.library, paths.library)) moved.push("decks")
  if (copyInto(LEGACY.devices, paths.devices)) moved.push("paired devices")
  // Only the user's own sounds need to travel; built-in tones are regenerated.
  if (!fs.existsSync(paths.sounds) && fs.existsSync(path.join(LEGACY.sounds, "sounds.json"))) {
    fs.mkdirSync(paths.sounds, { recursive: true })
    for (const name of fs.readdirSync(LEGACY.sounds)) {
      if (/^sound-[1-8]\.(wav|mp3)$|^sounds\.json$/.test(name)) fs.copyFileSync(path.join(LEGACY.sounds, name), path.join(paths.sounds, name))
    }
    moved.push("sounds")
  }
  if (moved.length) log(`Moved your ${moved.join(", ")} to ${DATA_DIR}. The copies in the app folder are no longer used.`)
}
