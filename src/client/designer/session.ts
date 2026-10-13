// Backup, restore, stopping the companion, and the first-run intro card.
import type { Ok } from "../../shared/api.ts"
import { isLibraryShape, normalizeLibrary } from "../../shared/model.ts"
import { t } from "../../shared/i18n.ts"
import { byId, el, storage } from "../common/dom.ts"
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
  toast(t("designer.session.backupDone"))
}

/** Restoring replaces everything, so it asks first and can be undone after. */
async function importBackup(file: File): Promise<void> {
  let next: unknown
  try {
    next = JSON.parse(await file.text())
  } catch {
    next = null
  }
  if (!isLibraryShape(next)) return toast(t("designer.session.notBackup"), true)
  const yes = await confirmAction({
    title: t("designer.session.restoreTitle"),
    text: t("designer.session.restoreText", { current: library().profiles.length, incoming: next.profiles.length }),
    confirm: t("designer.session.restoreConfirm")
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
    recordUndo(t("designer.session.restored"), () => {
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
    title: t("designer.session.stopTitle"),
    text: t("designer.session.stopText"),
    confirm: t("designer.session.stopConfirm")
  })
  if (!yes) return
  try {
    await request<Ok>("/api/shutdown", { method: "POST" })
    const box = el("div", "empty-inspector")
    box.style.padding = "80px 20px"
    box.appendChild(el("strong", null, t("designer.session.stopped")))
    box.appendChild(el("div", "subtle", t("designer.session.stoppedHint")))
    document.body.innerHTML = ""
    document.body.appendChild(box)
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
