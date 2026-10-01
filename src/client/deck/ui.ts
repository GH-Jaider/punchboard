// Small bits of page chrome: the toast, haptics and the connection status.
import { byId, createToast } from "../common/dom.ts"

export const toast = createToast(byId("toast"), 2400)

export const isOffline = (): boolean => document.body.classList.contains("is-offline")
export const needsPairing = (): boolean => document.body.classList.contains("needs-pairing")

export function setOnline(online: boolean): void {
  document.body.classList.toggle("is-offline", !online)
  byId("link-status").className = `link-status${online ? "" : " is-offline"}`
  byId("link-text").textContent = online ? "Connected" : "Companion offline"
}
