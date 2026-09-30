// The library being edited, the current selection, and autosave.
//
// Edits mutate the in-memory library and queue a write. Every save carries the
// revision it was edited from, so two windows can never silently overwrite
// each other's work.
import type { LibraryResponse, SaveLibraryResponse } from "../../shared/api.ts"
import { normalizeLibrary } from "../../shared/model.ts"
import type { Button, Library, Profile } from "../../shared/types.ts"
import { byId } from "../common/dom.ts"
import { ApiError, errorMessage, request } from "../common/http.ts"
import { toast, view } from "./hub.ts"

interface Store {
  library: Library | null
  activeId: string
  selectedSlot: number | null
  libraryRev: number | null
  saving: boolean
}

export const store: Store = { library: null, activeId: "", selectedSlot: null, libraryRev: null, saving: false }

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

export type SaveMode = "" | "saving" | "error"

export function setSaveState(mode: SaveMode, message: string): void {
  byId("save-chip").className = `save-chip${mode ? ` is-${mode}` : ""}`
  byId("save-text").textContent = message
}

export function queueSave(): void {
  setSaveState("saving", "Saving")
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void save()
  }, 500)
}

export const saveTimerPending = (): boolean => saveTimer !== null

async function save(): Promise<void> {
  if (!store.library) return
  store.library.activeProfileId = store.activeId
  store.saving = true
  try {
    const result = await request<SaveLibraryResponse>(`/api/library?rev=${store.libraryRev}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      // `open` tracks which step card is expanded: inspector state, not deck data.
      body: JSON.stringify(store.library, (key, value: unknown) => (key === "open" ? undefined : value))
    })
    store.saving = false
    store.libraryRev = result.libraryRev
    setSaveState("", "Saved · decks in sync")
  } catch (error) {
    store.saving = false
    if (error instanceof ApiError && error.status === 409) {
      // Another window saved first. Theirs is on disk, so take it rather than
      // overwrite it; this window's unsaved edit is the one lost.
      if (saveTimer !== null) window.clearTimeout(saveTimer)
      saveTimer = null
      void reloadLibrary("This deck was changed in another window, so it was reloaded. Redo your last change.")
      return
    }
    setSaveState("error", "Not saved")
    toast(errorMessage(error), true)
  }
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
  return normalizeLibrary((await response.json()) as LibraryResponse)
}

/** Picks up a newer library from elsewhere, keeping the selection where it still exists. */
export async function reloadLibrary(message?: string): Promise<void> {
  try {
    const next = await fetchLibrary()
    store.library = next
    if (!next.profiles.some((profile) => profile.id === store.activeId)) store.activeId = next.activeProfileId
    if (!selectedButton()) store.selectedSlot = null
    setSaveState("", "Saved · decks in sync")
    view.renderAll()
    if (message) toast(message)
  } catch (error) {
    toast(errorMessage(error), true)
  }
}
