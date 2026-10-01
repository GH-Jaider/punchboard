// The library being edited, the current selection, and autosave.
//
// Edits mutate the in-memory library and queue a write. Every save carries the
// revision it was edited from, so two windows can never silently overwrite
// each other's work.
import type { LibraryResponse, SaveLibraryResponse } from "../../shared/api.ts"
import { nameDecksWith } from "../../shared/actions.ts"
import { normalizeLibrary } from "../../shared/model.ts"
import type { Button, Library, Profile } from "../../shared/types.ts"
import { byId } from "../common/dom.ts"
import { ApiError, errorMessage, readJson } from "../common/http.ts"
import { toast, view } from "./hub.ts"
import { clearUndo } from "./undo.ts"

interface Store {
  library: Library | null
  activeId: string
  selectedSlot: number | null
  libraryRev: number | null
  saving: boolean
}

export const store: Store = { library: null, activeId: "", selectedSlot: null, libraryRev: null, saving: false }

// "Go to another deck" steps show the deck's current name.
nameDecksWith((id) => store.library?.profiles.find((profile) => profile.id === id)?.name)

let saveTimer: number | null = null

export function library(): Library {
  if (!store.library) throw new Error("The deck has not loaded yet.")
  return store.library
}

export function activeProfile(): Profile {
  const loaded = library()
  return loaded.profiles.find((profile) => profile.id === store.activeId) ?? loaded.profiles[0]!
}

export function selectedButton(): Button | null {
  if (store.selectedSlot === null || !store.library) return null
  return activeProfile().buttons.find((button) => button.slot === store.selectedSlot) ?? null
}

/** Swaps one button object for another in the active profile, e.g. after a type change. */
export function replaceButton(previous: Button, next: Button): void {
  const buttons = activeProfile().buttons
  const index = buttons.indexOf(previous)
  if (index !== -1) buttons[index] = next
}

// ------------------------------------------------------------------ saving
//
// One save is in flight at a time. Edits made meanwhile wait for it and go
// out in the next one, so a save never carries a revision that is already
// stale. A failed save keeps its edits, says so on the chip, and tries again
// with a growing pause (or at once from the chip's Retry).

export type SaveMode = "" | "saving" | "error"

const SAVE_DELAY_MS = 500
const RETRY_FIRST_MS = 2000
const RETRY_MAX_MS = 30000
/** Browsers cap the bodies of all keepalive requests in flight at 64 KiB. */
const KEEPALIVE_LIMIT = 60 * 1024

/** Edits this window has not handed to the companion yet. */
let dirty = false
let retryTimer: number | null = null
let failures = 0
/** The page is hidden or closing: saves go out at once, kept alive if small enough. */
let leaving = false

export function setSaveState(mode: SaveMode, message: string): void {
  byId("save-chip").className = `save-chip${mode ? ` is-${mode}` : ""}`
  byId("save-text").textContent = message
  byId("save-retry").hidden = mode !== "error" || !dirty
}

function clearSaveTimers(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  if (retryTimer !== null) window.clearTimeout(retryTimer)
  saveTimer = null
  retryTimer = null
}

export function queueSave(): void {
  dirty = true
  if (retryTimer !== null) {
    // Still failing: the retry already waiting carries this edit too.
    setSaveState("error", "Not saved")
    return
  }
  setSaveState("saving", "Saving")
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  if (leaving) return void save()
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void save()
  }, SAVE_DELAY_MS)
}

/** Whether this window holds edits the companion has not stored yet. */
export const unsavedEdits = (): boolean => dirty || store.saving || saveTimer !== null

/** Saves straight away instead of after the pause (the chip's Retry). */
export function saveNow(): void {
  if (!dirty) return
  clearSaveTimers()
  void save()
}

// `open` tracks which step card is expanded: inspector state, not deck data.
const libraryBody = (loaded: Library): string => JSON.stringify(loaded, (key, value: unknown) => (key === "open" ? undefined : value))
const fitsKeepalive = (body: string): boolean => new Blob([body]).size <= KEEPALIVE_LIMIT

async function save(): Promise<void> {
  if (!store.library || !dirty) return
  // The edit stays dirty and goes out when the save in flight is done.
  if (store.saving) return
  store.library.activeProfileId = store.activeId
  const body = libraryBody(store.library)
  dirty = false
  store.saving = true
  try {
    // A keepalive request outlives the page, so an edit made just before the
    // window closes still lands. Browsers refuse keepalive bodies over 64 KiB;
    // a bigger library (custom images) goes as a normal request instead, and
    // closing the page then asks first (see bindSaving), so it has time to land.
    const keepalive = leaving && fitsKeepalive(body)
    const response = await fetch(`/api/library?rev=${store.libraryRev}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive
    })
    const result = await readJson<SaveLibraryResponse>(response)
    store.saving = false
    store.libraryRev = result.libraryRev
    failures = 0
    if (dirty) {
      // More edits arrived while this one was on its way; their timer (if
      // still running) sends them, otherwise they go now.
      if (saveTimer === null && retryTimer === null) void save()
      return
    }
    setSaveState("", "Saved · decks in sync")
  } catch (error) {
    store.saving = false
    if (error instanceof ApiError && error.status === 409) {
      // Another window saved first. Theirs is on disk, so take it rather than
      // overwrite it; this window's unsaved edit is the one lost.
      clearSaveTimers()
      dirty = false
      failures = 0
      void reloadLibrary("This deck was changed in another window, so it was reloaded. Redo your last change.")
      return
    }
    // Keep the edits (and any made meanwhile). A dropped connection or a busy
    // companion is tried again, a little later each time; a refusal (a 4xx)
    // would only be refused again, so that waits for the chip's Retry.
    dirty = true
    failures += 1
    clearSaveTimers()
    const status = error instanceof ApiError ? error.status : 0
    if (status === 0 || status >= 500 || status === 408 || status === 429) {
      const wait = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * Math.pow(2, failures - 1))
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        void save()
      }, wait)
    }
    setSaveState("error", "Not saved")
    // Once per outage; the chip keeps saying so after the toast has gone.
    if (failures === 1) toast(`Not saved: ${errorMessage(error)}`, true)
  }
}

/** The page is being hidden or closed: send what the save pause is holding
    back now, or the last half-second of edits would be lost with the window. */
function flushOnLeave(): void {
  leaving = true
  if (!dirty) return
  clearSaveTimers()
  void save()
}

export function bindSaving(): void {
  byId("save-retry").addEventListener("click", saveNow)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushOnLeave()
    else leaving = false
  })
  window.addEventListener("pagehide", flushOnLeave)
  window.addEventListener("pageshow", () => { leaving = false })
  // Normally the keepalive save on pagehide covers a close. When it cannot
  // (saves are failing, an edit is queued behind a save in flight, or the
  // library is too big for keepalive), the save starts now and the browser
  // asks before leaving, which gives it time to land.
  window.addEventListener("beforeunload", (event) => {
    if (!store.library || !dirty) return
    if (failures === 0 && !store.saving && fitsKeepalive(libraryBody(store.library))) return
    if (dirty && !store.saving) saveNow()
    event.preventDefault()
    event.returnValue = ""
  })
}

/** Marks the active profile as edited and queues a save. */
export function touch(): void {
  if (store.library) activeProfile().updatedAt = new Date().toISOString()
  queueSave()
}

// ------------------------------------------------------------------ loading

/** Loads the library and remembers its revision for the next save. */
export async function fetchLibrary(): Promise<Library> {
  const response = await fetch("/api/library")
  if (!response.ok) throw new Error("Could not load the deck.")
  store.libraryRev = Number(response.headers.get("X-Library-Rev")) || null
  showNotice(response.headers.get("X-Library-Notice"))
  return normalizeLibrary((await response.json()) as LibraryResponse)
}

let noticeShown = false

/** Says once per window that the decks file was damaged or is from a newer Punchboard. */
function showNotice(header: string | null): void {
  if (!header || noticeShown) return
  noticeShown = true
  let message = header
  try {
    message = decodeURIComponent(header)
  } catch { /* shown as it came */ }
  // An action keeps the toast up long enough to read.
  toast(message, true, { label: "OK", onClick: () => {} })
}

/** Picks up a newer library from elsewhere, keeping the selection where it still exists. */
export async function reloadLibrary(message?: string): Promise<void> {
  try {
    const next = await fetchLibrary()
    store.library = next
    // Undo entries hold the old library's objects; run now, they would
    // report success and change nothing.
    clearUndo()
    if (!next.profiles.some((profile) => profile.id === store.activeId)) store.activeId = next.activeProfileId
    if (!selectedButton()) store.selectedSlot = null
    setSaveState("", "Saved · decks in sync")
    view.renderAll()
    if (message) toast(message)
  } catch (error) {
    toast(errorMessage(error), true)
  }
}
