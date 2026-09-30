// In-page dialogs that follow the theme, in place of prompt() and confirm().
import { byId } from "../common/dom.ts"

export interface AskOptions {
  title: string
  label?: string
  value?: string
  confirm?: string
  maxLength?: number
}

/** Resolves to the trimmed text, or null when cancelled. */
export function ask(options: AskOptions): Promise<string | null> {
  const dialog = byId<HTMLDialogElement>("dlg-ask")
  byId("ask-title").textContent = options.title
  byId("ask-label").textContent = options.label ?? options.title
  byId("ask-ok").textContent = options.confirm ?? "Save"
  const input = byId<HTMLInputElement>("ask-input")
  input.value = options.value ?? ""
  input.maxLength = options.maxLength ?? 60
  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === "ok" ? input.value.trim() : null)
    dialog.showModal()
    input.select()
  })
}

export interface ConfirmOptions {
  title: string
  text: string
  confirm?: string
  /** A non-destructive confirmation gets the primary style instead of danger. */
  safe?: boolean
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>("dlg-confirm")
  byId("confirm-title").textContent = options.title
  byId("confirm-text").textContent = options.text
  const ok = byId("confirm-ok")
  ok.textContent = options.confirm ?? "Delete"
  ok.className = options.safe ? "btn primary" : "btn danger"
  return new Promise((resolve) => {
    dialog.onclose = () => resolve(dialog.returnValue === "ok")
    dialog.showModal()
  })
}
