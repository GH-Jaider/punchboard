// The applications installed on this computer, for the "Launch an app" picker.
// macOS: .app bundles in the usual folders, one level of subfolders included
// (suites such as DaVinci Resolve keep theirs in one). Windows: the Start
// Menu's shortcuts, which is what the Start Menu itself lists.
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

function windowsApps(): AppEntry[] {
  const programs = "Microsoft/Windows/Start Menu/Programs"
  const roots = [
    path.join(process.env.ProgramData ?? "C:\\ProgramData", programs),
    path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), programs)
  ]
  const found = new Map<string, AppEntry>()
  const visit = (dir: string, depth: number): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 3) visit(full, depth + 1)
        continue
      }
      if (!/\.lnk$/i.test(entry.name)) continue
      const name = entry.name.replace(/\.lnk$/i, "")
      // Uninstallers and readmes live beside the real shortcuts.
      if (/uninstall|readme|help|website|documentation/i.test(name)) continue
      if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, path: full })
    }
  }
  for (const root of roots) visit(root, 0)
  return [...found.values()]
}

export function listApps(): AppEntry[] {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.apps
  const apps = process.platform === "darwin" ? macApps() : process.platform === "win32" ? windowsApps() : []
  apps.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  cache = { at: Date.now(), apps }
  return apps
}
