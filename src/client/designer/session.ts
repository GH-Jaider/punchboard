// Backup, restore, stopping the companion, and the first-run intro card.
import type { Ok } from "../../shared/api.ts"
import { isLibraryShape, normalizeLibrary } from "../../shared/model.ts"
import { byId, storage } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { confirmAction } from "./dialogs.ts"
import { toast, view } from "./hub.ts"
import { library, store, touch } from "./state.ts"
import { clearUndo, recordUndo } from "./undo.ts"

const INTRO_KEY = "punchboard-intro-seen"

function exportBackup(): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(library(), null, 2)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = "punchboard-backup.json"
  link.click()
  URL.revokeObjectURL(url)
  toast("Backup downloaded.")
}

/** Restoring replaces everything, so it asks first and can be undone after. */
async function importBackup(file: File): Promise<void> {
  let next: unknown
  try {
    next = JSON.parse(await file.text())
  } catch {
    next = null
  }
  if (!isLibraryShape(next)) return toast("That file is not a Punchboard backup.", true)
  const yes = await confirmAction({
    title: "Replace this deck?",
    text: `Restoring will replace all ${library().profiles.length} deck(s) on this computer with the ${next.profiles.length} in the file.`,
    confirm: "Replace everything"
  })
  if (!yes) return
  const previous = store.library
  const previousActive = store.activeId
  store.library = normalizeLibrary(next)
  store.activeId = store.library.activeProfileId
  store.selectedSlot = null
  // Earlier entries point into the library just replaced. Undoing the restore
  // itself still works: it puts that whole library back.
  clearUndo()
  if (previous) {
    recordUndo("Restored from file", () => {
      store.library = previous
      store.activeId = previousActive
      store.selectedSlot = null
    })
  }
  touch()
  view.renderAll()
}

async function shutdown(): Promise<void> {
  const yes = await confirmAction({
    title: "Stop the companion?",
    text: "Every paired device will show as offline until you start it again from your computer.",
    confirm: "Stop companion"
  })
  if (!yes) return
  try {
    await request<Ok>("/api/shutdown", { method: "POST" })
    document.body.innerHTML = '<div class="empty-inspector" style="padding:80px 20px"><strong>The companion has stopped.</strong><div class="subtle">Start it again on your computer when you are ready.</div></div>'
  } catch (error) {
    toast(errorMessage(error), true)
  }
}

/** Shows the three-step guide to anyone who has not built anything yet. */
export function showIntroIfNew(): void {
  const hasButtons = library().profiles.some((profile) => profile.buttons.length > 0)
  byId("intro-card").hidden = storage.get(INTRO_KEY) === "1" || hasButtons
}

export function bindSession(): void {
  byId("export-btn").addEventListener("click", exportBackup)
  const input = byId<HTMLInputElement>("import-input")
  byId("import-btn").addEventListener("click", () => input.click())
  input.addEventListener("change", () => {
    const file = input.files?.[0]
    input.value = ""
    if (file) void importBackup(file)
  })
  byId("shutdown-btn").addEventListener("click", () => void shutdown())
  byId("intro-dismiss").addEventListener("click", () => {
    byId("intro-card").hidden = true
    storage.set(INTRO_KEY, "1")
  })
}
