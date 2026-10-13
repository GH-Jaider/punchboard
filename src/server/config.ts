// Settings stored in config.json next to the app.
import { isHexColor } from "../shared/colors.ts"
import { DEFAULT_THEME, isThemeId } from "../shared/themes.ts"
import type { ThemeId } from "../shared/types.ts"
import { isObject, readJsonSafe, writeJsonAtomic } from "./store.ts"

export interface Config {
  port: number
  theme: { name: ThemeId; accent: string; accentPreset: string }
  soundVolume: number
  /** source "auto" follows OBS's own settings on this computer; "manual" was typed in. */
  obs: { address: string; password: string; source: "auto" | "manual" }
  /** The one-time Ko-fi note has been shown in the Control Center. */
  supportShown: boolean
  /** "auto" speaks each device's own language; a code ("es") one for all.
      Only the shape is checked here: a code with no file speaks as auto does. */
  language: string
}

const DEFAULTS: Config = {
  port: 8787,
  theme: { name: DEFAULT_THEME, accent: "#5fd0d6", accentPreset: "custom" },
  soundVolume: 1,
  obs: { address: "ws://127.0.0.1:4455", password: "", source: "auto" },
  supportShown: false,
  language: "auto"
}

const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback)

/** "auto", or something shaped like a language code ("es", "pt-BR"). */
export const isLanguageCode = (value: unknown): value is string =>
  typeof value === "string" && /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(value)

export function loadConfig(file: string, log: (message: string) => void): Config {
  let raw: Record<string, unknown> = {}
  try {
    raw = readJsonSafe(file, isObject).data ?? {}
  } catch (error) {
    log(`${error instanceof Error ? error.message : String(error)} Starting with default settings.`)
  }
  const theme = isObject(raw.theme) ? raw.theme : {}
  const obs = isObject(raw.obs) ? raw.obs : {}
  // Only a real number counts: Number(null) would be 0, a muted fader.
  const soundVolume = typeof raw.soundVolume === "number" ? raw.soundVolume : NaN
  return {
    port: Number(raw.port) || DEFAULTS.port,
    theme: {
      name: isThemeId(theme.name) ? theme.name : DEFAULTS.theme.name,
      accent: isHexColor(theme.accent) ? theme.accent : DEFAULTS.theme.accent,
      accentPreset: str(theme.accentPreset, DEFAULTS.theme.accentPreset)
    },
    soundVolume: Number.isFinite(soundVolume) ? Math.max(0, Math.min(1, soundVolume)) : DEFAULTS.soundVolume,
    obs: {
      address: str(obs.address, "").trim() || DEFAULTS.obs.address,
      password: str(obs.password, DEFAULTS.obs.password),
      // A password typed before this setting existed counts as manual.
      source: obs.source === "manual" || (obs.source !== "auto" && str(obs.password, "") !== "") ? "manual" : "auto"
    },
    supportShown: raw.supportShown === true,
    language: isLanguageCode(raw.language) ? raw.language : DEFAULTS.language
  }
}

export function saveConfig(file: string, config: Config): void {
  writeJsonAtomic(file, config)
}
