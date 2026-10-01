// The applications installed on this computer, for the "Launch an app" picker.
// macOS: .app bundles in the usual folders, one level of subfolders included
// (suites such as DaVinci Resolve keep theirs in one). Windows: the Start
// Menu's shortcuts, which is what the Start Menu itself lists, and the
// .url ones that start an app (games from Steam or Epic) rather than open a
// web page.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AppEntry } from "../shared/api.ts"

const TTL_MS = 60000
let cache: { at: number; apps: AppEntry[] } | null = null

function macApps(): AppEntry[] {
  const roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(os.homedir(), "Applications")]
  const found = new Map<string, AppEntry>()
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith(".app")) {
        if (!found.has(full)) found.set(full, { name: entry.name.slice(0, -4), path: full })
      } else if (entry.isDirectory() && depth < 1) {
        visit(full, depth + 1)
      }
    }
  }
  for (const root of roots) visit(root, 0)
  return [...found.values()]
}

// Uninstallers, readmes and links to the maker's site live beside the real
// shortcuts. Whole words only, so "Helpdesk", "Hotspot Helper" or "Manual
// Focus" stay; "help" only as the last word ("VLC Help"), since a name that
// starts with it ("Help Desk Pro") is as likely an app as not.
const NOT_APPS: readonly RegExp[] = [
  /\buninstall(er)?\b/i, /\bread ?me\b/i, /\brelease notes\b/i, /\bweb ?site\b/i, /\bon the web\b/i,
  /\bdocumentation\b/i, /\buser'?s? (guide|manual)\b/i, /(^|\s)help$/i
]

/** Whether a Start Menu entry's name looks like an app, exposed for tests. */
export const isAppName = (name: string): boolean => !NOT_APPS.some((pattern) => pattern.test(name))

/** For an Internet Shortcut (.url), whether it starts an app: a game
    library's steam://rungameid/... does, a web page or a file does not
    (those are links, and "Open a link" is the step for them). */
export function urlShortcutStartsApp(content: string): boolean {
  const match = /^\s*URL\s*=\s*([a-z][a-z0-9+.-]*):/im.exec(content)
  if (!match) return false
  return !/^(https?|ftp|file|mailto|about|javascript|data)$/i.test(match[1] ?? "")
}

/** The Start Menu's shortcuts under `roots`, exposed for tests. One entry
    per name: the same app is often in both the machine's and the user's
    Start Menu, and a .lnk wins over a .url of the same name. */
export function windowsApps(roots: string[] = windowsStartMenus()): AppEntry[] {
  const found = new Map<string, AppEntry>()
  const fromUrl = new Set<string>()
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 3) visit(full, depth + 1)
        continue
      }
      const kind = /\.(lnk|url)$/i.exec(entry.name)
      if (!kind) continue
      const name = entry.name.slice(0, -4).trim()
      if (!name || !isAppName(name)) continue
      const isUrl = kind[1]!.toLowerCase() === "url"
      const key = name.toLowerCase()
      if (found.has(key) && (isUrl || !fromUrl.has(key))) continue
      if (isUrl) {
        let content = ""
        try { content = fs.readFileSync(full, "utf8") } catch { continue }
        if (!urlShortcutStartsApp(content)) continue
        fromUrl.add(key)
      } else {
        fromUrl.delete(key)
      }
      found.set(key, { name, path: full })
    }
  }
  for (const root of roots) visit(root, 0)
  return [...found.values()]
}

function windowsStartMenus(): string[] {
  const programs = "Microsoft/Windows/Start Menu/Programs"
  return [
    path.join(process.env.ProgramData ?? "C:\\ProgramData", programs),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), programs)
  ]
}

export function listApps(): AppEntry[] {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.apps
  const apps = process.platform === "darwin" ? macApps() : process.platform === "win32" ? windowsApps() : []
  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  cache = { at: Date.now(), apps }
  return apps
}
