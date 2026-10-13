// The Stop button in the top bar: shows what the companion is playing (sounds
// play from the companion itself, so nothing here has to be open or focused)
// and stops it all on click.
import type { Ok, SoundPlayback } from "../../shared/api.ts"
import { t } from "../../shared/i18n.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { onLanguageChange } from "../common/i18n.ts"
import { toast } from "./hub.ts"
import { formatDuration } from "./sounds.ts"

/** This tab runs on the companion's computer, so Date.now() is its clock. */
let current: Record<string, SoundPlayback> = {}
let ticker: number | undefined

function nowPlayingText(): string {
  const slots = Object.keys(current)
  if (slots.length !== 1) return t("designer.soundOutput.stopMany", { count: slots.length })
  const slot = slots[0]!
  const entry = current[slot]
  if (!entry || entry.durationMs === null) return t("designer.soundOutput.stopOne", { slot })
  const left = Math.max(0, entry.startedAt + entry.durationMs - Date.now())
  return t("designer.soundOutput.stopOneLeft", { slot, left: formatDuration(left) })
}

export function renderNowPlaying(playback: Record<string, SoundPlayback>): void {
  current = playback
  const active = Object.keys(current).length > 0
  byId("now-playing").hidden = !active
  byId("now-playing-text").textContent = active ? nowPlayingText() : t("designer.soundOutput.stop")
  if (active && ticker === undefined) {
    ticker = window.setInterval(() => { byId("now-playing-text").textContent = nowPlayingText() }, 250)
  } else if (!active && ticker !== undefined) {
    window.clearInterval(ticker)
    ticker = undefined
  }
}

export function bindSoundOutput(): void {
  byId("now-playing").addEventListener("click", () => {
    request<Ok>("/api/sounds/stop", { method: "POST" }).catch((error: unknown) => toast(errorMessage(error), true))
  })
  onLanguageChange(() => renderNowPlaying(current))
}
