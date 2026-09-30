// The OBS connection panel.
import type { ObsLink, SettingsResponse, SettingsSaved } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"

const READY_HELP = "Saved. Start OBS before pressing an OBS button."
const SETUP_HELP = "Only needed for OBS buttons. In OBS open Tools › WebSocket Server Settings, enable the server, then copy its address and password here."

function setObsState(configured: boolean, message: string, isError = false): void {
  const chip = byId("obs-state")
  chip.textContent = isError ? "Problem" : configured ? "Connected" : "Not set up"
  chip.className = `state-chip ${isError ? "error" : configured ? "ready" : "warning"}`
  byId("obs-help").textContent = message
}

/** The live link, from every snapshot. It arrives right after a save too,
    so it always has the last word over setObsState. */
export function showObsLink(status: ObsLink): void {
  const chip = byId("obs-state")
  chip.textContent = status === "connected" ? "Connected" : status === "disconnected" ? "Not running" : "Not set up"
  chip.className = `state-chip ${status === "connected" ? "ready" : "warning"}`
}

export function showObsSettings(settings: SettingsResponse): void {
  byId<HTMLInputElement>("obs-address").value = settings.obsAddress || ""
  setObsState(settings.obsConfigured, settings.obsConfigured ? READY_HELP : SETUP_HELP)
}

export function bindObs(): void {
  const dialog = byId<HTMLDialogElement>("dlg-obs")
  byId("obs-toggle").addEventListener("click", () => dialog.showModal())

  byId("obs-save").addEventListener("click", async () => {
    const address = byId<HTMLInputElement>("obs-address").value.trim()
    const password = byId<HTMLInputElement>("obs-password").value
    try {
      await request<SettingsSaved>("/api/settings", { method: "PUT", json: { obsAddress: address, obsPassword: password } })
      const configured = Boolean(address && password)
      setObsState(configured, configured ? READY_HELP : "Add both the address and the password, then save again.")
      toast("OBS connection saved.")
    } catch (error) {
      setObsState(false, "Could not save. Check the address, then try again.", true)
      toast(errorMessage(error), true)
    }
  })
}
