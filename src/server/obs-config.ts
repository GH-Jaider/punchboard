// Reads OBS's own WebSocket settings from its config folder, so Punchboard
// can connect to an OBS on this computer without anyone copying a password.
// OBS 28+ keeps them in plugin_config/obs-websocket/config.json.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ObsDetected } from "../shared/api.ts"

function configFile(): string {
  const home = os.homedir()
  const tail = path.join("obs-studio", "plugin_config", "obs-websocket", "config.json")
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", tail)
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), tail)
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), tail)
}

export interface LocalObs extends ObsDetected {
  /** Empty when OBS does not ask for one. */
  password: string
}

/** OBS's settings on this computer, or found: false when OBS was never set up here. */
export function readLocalObs(): LocalObs {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Record<string, unknown>
    const port = Number(raw.server_port) || 4455
    const auth = raw.auth_required !== false
    return {
      found: true,
      enabled: raw.server_enabled === true,
      port,
      password: auth && typeof raw.server_password === "string" ? raw.server_password : ""
    }
  } catch {
    return { found: false, enabled: false, port: 4455, password: "" }
  }
}
