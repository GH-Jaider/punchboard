// Undo for the destructive edits, in place of "Are you sure?" dialogs. Each
// entry knows how to put its data back; the toast offers to run it, and ⌘Z
// runs the latest.
import { byId } from "../common/dom.ts"
import { toast, view } from "./hub.ts"
import { touch } from "./state.ts"

interface UndoEntry {
  label: string
  restore: () => void
}

const MAX_ENTRIES = 20
const stack: UndoEntry[] = []

function apply(entry: UndoEntry): void {
  const index = stack.indexOf(entry)
  // Forgotten since (the deck was reloaded or restored): its objects are gone.
  if (index === -1) return toast("That can no longer be undone.")
  stack.splice(index, 1)
  entry.restore()
  touch()
  view.renderAll()
}

/** Remembers how to undo an edit that just happened and offers it in a toast.
    The toast undoes that edit specifically, even if others followed. */
export function recordUndo(label: string, restore: () => void): void {
  const entry: UndoEntry = { label, restore }
  stack.push(entry)
  if (stack.length > MAX_ENTRIES) stack.shift()
  toast(label, false, { label: "Undo", onClick: () => apply(entry) })
}

/** Forgets every entry, and hides a toast still offering one. For when the
    library is replaced wholesale and the entries would restore into objects
    nobody sees any more. */
export function clearUndo(): void {
  stack.length = 0
  const element = byId("toast")
  if (element.classList.contains("has-action") && element.querySelector(".toast-action")?.textContent === "Undo") {
    element.className = "toast"
  }
}

/** ⌘Z: undoes the most recent edit that can be undone. */
export function undoLast(): void {
  const entry = stack[stack.length - 1]
  if (!entry) return toast("Nothing to undo.")
  apply(entry)
  toast(`Undid: ${entry.label.toLowerCase()}`)
}
