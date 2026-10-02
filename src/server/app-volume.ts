// One application's volume, for "App volume" faders.
//   Windows: the real per-app mixer, through the Core Audio bridge in
//            win-volume.ts. Any app with an audio session can be set.
//   macOS:   there is no public per-app volume, so only apps with a volume of
//            their own that scripts can set: Music and Spotify, through
//            osascript. An app that is not running is never started: every
//            script asks "is running" first and stops there if not.
//   Other:   nothing to offer.
// A level that cannot be read (the app is closed, or silent on Windows) is
// null, which the decks show as "–". Writes go one at a time per app, newest
// level first, like the computer's own volume.
import { execFile } from "node:child_process"
import type { AudioApp, AudioAppsResponse } from "../shared/api.ts"
import { latestWinsPerKey } from "./latest-wins.ts"
import { listWindowsAudioApps, readWindowsAppVolume, writeWindowsAppVolume } from "./win-volume.ts"

/** A write to an app that cannot take one right now: closed, or (Windows)
    not playing through the mixer. Its level is unknown from then on. */
export class AppNotPlayingError extends Error {}

/** The Mac apps whose volume a script can set, by key. Scripts find them by
    bundle id: by name, AppleScript can settle on another app whose name is
    close when the one asked for is not installed. */
export const MAC_APPS: Readonly<Record<string, { name: string; id: string }>> = {
  music: { name: "Music", id: "com.apple.Music" },
  spotify: { name: "Spotify", id: "com.spotify.client" }
}

export const MAC_ONLY_NOTE = "macOS has no per-app volume, so only Music and Spotify can be controlled."
const OTHER_NOTE = "App volume can be controlled on Windows and macOS only."

/** Volumes read back from the system can be a hair off what was set (0.5 as
    0.50000006); three places are all a fader shows, and keep a poll from
    reporting a change that is not one. */
export const roundLevel = (level: number): number => Math.round(Math.max(0, Math.min(1, level)) * 1000) / 1000

/** The AppleScript that reads (level null) or sets (0..1) a Mac app's volume
    and answers its volume 0..100, or "closed" when the app is not running.
    Asking "is running" never starts an app, and nothing is sent to it unless
    the answer is yes. The bundle id is held in a variable and the property
    is named by its raw code («class pVol», "sound volume" in both Music's and
    Spotify's dictionaries), so compiling the script never looks for the app:
    one that is not installed fails the "is running" question at run time,
    which counts as not running. "its" makes it the app's property; without a
    dictionary a bare «class pVol» compiles as a constant that cannot be set. */
export function macVolumeScript(bundleId: string, level: number | null): string {
  const lines = [
    `set appId to ${JSON.stringify(bundleId)}`,
    "try",
    "  set isOpen to (application id appId is running)",
    "on error",
    "  return \"closed\"",
    "end try",
    "if not isOpen then return \"closed\""
  ]
  if (level !== null) lines.push(`tell application id appId to set its «class pVol» to ${Math.round(Math.max(0, Math.min(1, level)) * 100)}`)
  lines.push("tell application id appId to return its «class pVol»")
  return lines.join("\n")
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Longer than for the computer's volume: the first time, macOS asks
    // whether Punchboard may control the app, and the script waits on that.
    execFile("osascript", ["-e", script], { timeout: 8000 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout).trim())
      reject(new Error(String(stderr).trim() || error.message))
    })
  })
}

/** What osascript's failure means to a person. */
function macError(appName: string, error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error)
  if (/-1743|not authori[sz]ed/i.test(text)) {
    return new Error(`macOS did not let Punchboard control ${appName}. Allow it in System Settings › Privacy & Security › Automation.`)
  }
  return new Error(`Could not reach ${appName}. (${text.replace(/\s+/g, " ").slice(0, 200)})`)
}

/** A Mac app's answer: its level 0..1, or null when it is not running. */
async function runMacScript(app: { name: string; id: string }, level: number | null): Promise<number | null> {
  let answer: string
  try {
    answer = await osascript(macVolumeScript(app.id, level))
  } catch (error) {
    throw macError(app.name, error)
  }
  if (answer === "closed") return null
  // An empty answer is not 0: Number("") would read it as silence.
  const value = answer === "" ? NaN : Number(answer)
  if (!Number.isFinite(value)) throw new Error(`${app.name} answered with something that is not a volume.`)
  return roundLevel(value / 100)
}

/** The level a write answers with: the one asked for. A write that arrives
    while another is in flight shares that one's promise, whose answer is the
    older level; the newest is set right after it, and the decks should show
    it rather than jump back. A refusal (the app closed) still comes through. */
const answered = (level: number): number => roundLevel(level)

export interface AppVolume {
  /** Whether app volumes can change on their own here, so polling them is worth it. */
  live: boolean
  /** The apps a fader can be pointed at right now. */
  list: () => Promise<AudioAppsResponse>
  /** An app's level, or null while it cannot be read. */
  read: (key: string) => Promise<number | null>
  /** Sets an app's level and answers the level it now has. `name` is how the
      error names it ("Google Chrome"). */
  write: (key: string, name: string, level: number) => Promise<number>
}

function windowsAppVolume(): AppVolume {
  const write = latestWinsPerKey(writeWindowsAppVolume)
  return {
    live: true,
    list: async () => {
      const apps: AudioApp[] = (await listWindowsAudioApps()).map((app) => ({ key: app.key, name: app.name, running: true, level: roundLevel(app.level) }))
      apps.sort((a, b) => a.name.localeCompare(b.name))
      const response: AudioAppsResponse = { platform: "win32", apps }
      if (!apps.length) response.note = "No app is playing sound right now. Open one and play something, then refresh."
      return response
    },
    read: async (key) => {
      const level = await readWindowsAppVolume(key)
      return level === null ? null : roundLevel(level)
    },
    write: async (key, name, level) => {
      const now = await write(key, level)
      if (now === null) throw new AppNotPlayingError(`${name} is not making any sound on this computer right now. Open it and play something first.`)
      return answered(level)
    }
  }
}

function macAppVolume(): AppVolume {
  const appOf = (key: string): { name: string; id: string } => {
    const app = Object.prototype.hasOwnProperty.call(MAC_APPS, key) ? MAC_APPS[key] : undefined
    if (!app) throw new Error(MAC_ONLY_NOTE)
    return app
  }
  const write = latestWinsPerKey((key, level) => runMacScript(appOf(key), level))
  return {
    live: true,
    list: async () => {
      const apps = await Promise.all(Object.keys(MAC_APPS).map(async (key): Promise<AudioApp> => {
        const app = appOf(key)
        try {
          const level = await runMacScript(app, null)
          return { key, name: app.name, running: level !== null, level }
        } catch {
          // Only a running app gets as far as being asked (and refusing,
          // without the Automation permission): it is open, its level unknown.
          return { key, name: app.name, running: true, level: null }
        }
      }))
      return { platform: "darwin", apps, note: MAC_ONLY_NOTE }
    },
    read: (key) => runMacScript(appOf(key), null),
    write: async (key, name, level) => {
      const now = await write(key, level)
      if (now === null) throw new AppNotPlayingError(`${name} is not open on this computer right now. Open it first, then try again.`)
      return answered(level)
    }
  }
}

function otherAppVolume(platform: string): AppVolume {
  return {
    live: false,
    list: async () => ({ platform, apps: [], note: OTHER_NOTE }),
    read: async () => null,
    write: async () => { throw new Error(OTHER_NOTE) }
  }
}

/** The app volume of one system. Tests ask for another system's here. */
export function appVolumeFor(platform: string): AppVolume {
  if (platform === "win32") return windowsAppVolume()
  if (platform === "darwin") return macAppVolume()
  return otherAppVolume(platform)
}

export const appVolume = appVolumeFor(process.platform)
