// Ko-fi: a cup next to the version, always there, and a note shown once, the
// first time the Control Center opens. The companion remembers that the note
// was shown (config.json), so a cleared browser does not bring it back.
import type { SettingsResponse, SettingsSaved } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { request } from "../common/http.ts"

export const KOFI_URL = "https://ko-fi.com/hit_here"

function closeNote(): void {
  byId("support-note").hidden = true
}

export function showSupportNote(settings: SettingsResponse): void {
  if (!settings.supportNote) return
  // Remembered as soon as it shows: "only once" holds even if the window is
  // simply closed. A failed save just means it may show once more.
  request<SettingsSaved>("/api/settings", { method: "PUT", json: { supportShown: true } }).catch(() => { /* shown again next time */ })
  // A moment after opening, so it does not compete with the page appearing.
  setTimeout(() => { byId("support-note").hidden = false }, 1500)
}

export function bindSupport(): void {
  byId<HTMLAnchorElement>("kofi-link").href = KOFI_URL
  byId<HTMLAnchorElement>("support-go").href = KOFI_URL
  byId("support-go").addEventListener("click", closeNote)
  byId("support-close").addEventListener("click", closeNote)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("support-note").hidden) closeNote()
  })
}
