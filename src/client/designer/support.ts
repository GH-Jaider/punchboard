// Ko-fi: a cup next to the version, always there, and a note shown once, the
// first time the Control Center opens, pointing at that cup. The companion
// remembers that the note was shown (config.json), so a cleared browser does
// not bring it back. On a first run it waits for the tour (tour.ts) to end.
import type { Ok, SettingsResponse, SettingsSaved } from "../../shared/api.ts"
import { SUPPORT_URL } from "../../shared/links.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"

let desktop = false

export function closeNote(): void {
  byId("support-note").hidden = true
  window.removeEventListener("resize", placeNote)
}

/** Under the cup, its arrow pointing up at it, kept inside the window. */
function placeNote(): void {
  const note = byId("support-note")
  const cup = byId("kofi-link").getBoundingClientRect()
  const margin = 12
  const left = Math.max(margin, Math.min(cup.left - 16, window.innerWidth - note.offsetWidth - margin))
  note.style.top = `${Math.round(cup.bottom + 10)}px`
  note.style.left = `${Math.round(left)}px`
  // The arrow stays on the cup even when the note is pushed in from an edge.
  note.style.setProperty("--arrow-left", `${Math.round(cup.left + cup.width / 2 - left - 7)}px`)
}

/** The desktop app's window opens no tabs: the companion opens the browser. */
function openSupport(event: Event): void {
  if (!desktop) return
  event.preventDefault()
  request<Ok>("/api/open-support", { method: "POST" }).catch((error: unknown) => toast(errorMessage(error), true))
}

/** driver.js marks the page while a tour is open; the note never sits on top of one. */
const tourOpen = (): boolean => document.body.classList.contains("driver-active")

function revealNote(): void {
  if (tourOpen()) {
    setTimeout(revealNote, 500)
    return
  }
  byId("support-note").hidden = false
  placeNote()
  window.addEventListener("resize", placeNote)
}

/** Shows the note if it is still due, a moment after the page opens. On a
    first run `wait` holds it until the tour has ended: it is remembered only
    once it really shows, so a window closed mid-tour still gets it next time. */
export function showSupportNote(settings: SettingsResponse, wait?: (then: () => void) => void): void {
  desktop = settings.desktop
  if (!settings.supportNote) return
  const show = (): void => {
    // Remembered as soon as it shows: "only once" holds even if the window is
    // simply closed. A failed save just means it may show once more.
    request<SettingsSaved>("/api/settings", { method: "PUT", json: { supportShown: true } }).catch(() => { /* shown again next time */ })
    // A moment after opening (or after the tour), so it does not compete with what just happened.
    setTimeout(revealNote, wait ? 700 : 1500)
  }
  if (wait) wait(show)
  else show()
}

export function bindSupport(): void {
  const cup = byId<HTMLAnchorElement>("kofi-link")
  const go = byId<HTMLAnchorElement>("support-go")
  cup.href = SUPPORT_URL
  go.href = SUPPORT_URL
  cup.addEventListener("click", openSupport)
  go.addEventListener("click", (event) => {
    openSupport(event)
    closeNote()
  })
  byId("support-close").addEventListener("click", closeNote)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("support-note").hidden) closeNote()
  })
}
