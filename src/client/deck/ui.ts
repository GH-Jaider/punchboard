// Small bits of page chrome: the toast, one-time hints and the connection status.
import { byId, el, storage } from "../common/dom.ts"
import type { Toast, ToastAction } from "../common/dom.ts"

const toastEl = byId("toast")
const TOAST_MS = 2400
const ACTION_MS = 6000
/** A hint is a paragraph, not a word: it stays long enough to read. */
const HINT_MS = 9000
/** A beat between one toast leaving and a waiting hint arriving. */
const PAUSE_MS = 350

interface Hint { key: string; message: string }

/** Hints waiting their turn, and the one on screen. */
const hints: Hint[] = []
let showing: Hint | null = null
let timer: number | undefined

function hide(): void { toastEl.className = "toast" }

function after(ms: number, then: () => void): void {
  window.clearTimeout(timer)
  timer = window.setTimeout(then, ms)
}

function paint(message: string, isError: boolean, action: ToastAction | undefined, onAction: () => void): void {
  toastEl.textContent = message
  if (action) {
    const button = el("button", "toast-action", action.label)
    button.type = "button"
    button.onclick = () => {
      hide()
      action.onClick()
      onAction()
    }
    toastEl.appendChild(button)
  }
  toastEl.className = `toast show${isError ? " is-error" : ""}${action ? " has-action" : ""}`
}

/** Marks a hint as seen for good: it was dismissed, or stayed up its full time. */
function seen(hint: Hint): void {
  storage.set(hint.key, "1")
  if (showing === hint) showing = null
}

function nextHint(): void {
  let next = hints.shift()
  while (next && storage.get(next.key)) next = hints.shift()
  if (!next) return
  const hint = next
  showing = hint
  paint(hint.message, false, { label: "Got it", onClick: () => seen(hint) }, () => after(PAUSE_MS, nextHint))
  after(HINT_MS, () => {
    seen(hint)
    hide()
    after(PAUSE_MS, nextHint)
  })
}

/** One toast at a time. A toast that arrives over a hint replaces it, and the
    hint comes back once the toast has gone, so it is never lost unseen. */
export const toast: Toast = (message, isError = false, action) => {
  if (showing) {
    hints.unshift(showing)
    showing = null
  }
  paint(message, isError, action, () => after(PAUSE_MS, nextHint))
  after(action ? ACTION_MS : TOAST_MS, () => {
    hide()
    after(PAUSE_MS, nextHint)
  })
}

/** A tip shown once per device, under its own storage key. It only counts as
    shown once it was actually seen: dismissed, or left up its full time. */
export function hint(key: string, message: string): void {
  if (storage.get(key) || (showing && showing.key === key) || hints.some((queued) => queued.key === key)) return
  hints.push({ key, message })
  if (!showing && toastEl.className.indexOf("show") === -1) nextHint()
}

export const isOffline = (): boolean => document.body.classList.contains("is-offline")
export const needsPairing = (): boolean => document.body.classList.contains("needs-pairing")

/** Told when the page chrome above the grid changes size (the offline
    banner), so the tiles can be laid out again. */
let onChromeChange: () => void = () => {}
export function whenChromeChanges(handler: () => void): void {
  onChromeChange = handler
}

export function setOnline(online: boolean): void {
  const changed = isOffline() === online
  document.body.classList.toggle("is-offline", !online)
  byId("link-status").className = `link-status${online ? "" : " is-offline"}`
  byId("link-text").textContent = online ? "Connected" : "Companion offline"
  if (changed) onChromeChange()
}
