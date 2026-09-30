// The OBS window. Punchboard reads OBS's own settings when OBS is on this
// computer, so normally the only step is switching on OBS's WebSocket
// server; the manual fields mirror OBS's Show Connect Info window.
import type { ObsDetectResponse, ObsIssue, ObsLink, SettingsResponse, SettingsSaved } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"

const TURN_ON = "In OBS open Tools › WebSocket Server Settings and tick Enable WebSocket server. Punchboard connects by itself as soon as you do."

let link: ObsLink = "unset"
let issue: ObsIssue = null

const input = (id: string): HTMLInputElement => byId<HTMLInputElement>(id)

function showStatus(): void {
  const box = byId("obs-status")
  let title: string
  let help: string
  if (link === "connected") {
    title = "Connected to OBS"
    help = "OBS buttons and faders are ready."
  } else if (issue === "server-off") {
    title = "Found OBS: switch on its WebSocket server"
    help = TURN_ON
  } else if (link === "disconnected" && issue === "wrong-password") {
    title = "OBS refused the password"
    help = "If OBS is on this computer, click Find OBS again. Otherwise paste the password from Show Connect Info below."
  } else if (link === "disconnected") {
    title = "Waiting for OBS"
    help = `Open OBS if it is closed. ${TURN_ON}`
  } else {
    title = "Not set up"
    help = "Only needed for OBS buttons and faders. If OBS is on this computer, click Find OBS."
  }
  byId("obs-status-title").textContent = title
  byId("obs-help").textContent = help
  box.className = `obs-status${link === "connected" ? " is-ready" : issue === "wrong-password" ? " is-error" : ""}`
}

/** The live link, from every snapshot: the rail chip and the window's status. */
export function showObsLink(status: ObsLink, why: ObsIssue): void {
  link = status
  issue = why
  const chip = byId("obs-state")
  chip.textContent = status === "connected" ? "Connected" : why === "wrong-password" ? "Wrong password" : why === "server-off" ? "Server off" : status === "disconnected" ? "Not running" : "Not set up"
  chip.className = `state-chip ${status === "connected" ? "ready" : why === "wrong-password" ? "error" : "warning"}`
  showStatus()
}

/** "ws://host:port", "obsws://host:port/password" (OBS's connect link) or a bare host. */
function parseConnect(text: string): { host: string; port: string; password: string | null } | null {
  const match = /^(?:obsws|wss?):\/\/([^:/\s]+)(?::(\d+))?(?:\/(\S*))?$/i.exec(text.trim())
  if (!match) return null
  let password: string | null = null
  if (match[3]) {
    try { password = decodeURIComponent(match[3]) } catch { password = match[3] }
  }
  return { host: match[1] ?? "", port: match[2] ?? "", password }
}

function fillFrom(text: string): boolean {
  const parsed = parseConnect(text)
  if (!parsed) return false
  input("obs-host").value = parsed.host
  if (parsed.port) input("obs-port").value = parsed.port
  if (parsed.password !== null) input("obs-password").value = parsed.password
  return true
}

export function showObsSettings(settings: SettingsResponse): void {
  const parsed = parseConnect(settings.obsAddress || "")
  input("obs-host").value = parsed ? parsed.host : ""
  input("obs-port").value = parsed ? parsed.port : ""
  input("obs-password").placeholder = settings.obsConfigured ? "Saved (paste to replace)" : "From Show Connect Info"
  // Typed-in settings live in the manual section; keep it open for them.
  byId<HTMLDetailsElement>("obs-manual").open = settings.obsSource === "manual"
}

async function findObs(): Promise<void> {
  const button = byId<HTMLButtonElement>("obs-find")
  button.disabled = true
  try {
    const found = await request<ObsDetectResponse>("/api/obs/detect", { method: "POST" })
    if (!found.found) {
      toast("OBS isn't set up on this computer yet. Open OBS once, or enter it by hand below.", true)
      byId<HTMLDetailsElement>("obs-manual").open = true
    } else if (!found.enabled) {
      toast("Found OBS. One step left: switch on its WebSocket server.")
    } else {
      toast("Found OBS. Connecting…")
    }
    input("obs-host").value = "127.0.0.1"
    input("obs-port").value = String(found.port)
    input("obs-password").value = ""
    input("obs-password").placeholder = "Taken from OBS"
  } catch (error) {
    toast(errorMessage(error), true)
  } finally {
    button.disabled = false
  }
}

export function bindObs(): void {
  const dialog = byId<HTMLDialogElement>("dlg-obs")
  byId("obs-toggle").addEventListener("click", () => dialog.showModal())
  byId("obs-find").addEventListener("click", () => void findObs())

  // Pasting OBS's whole connect link into any field fills all three.
  for (const id of ["obs-host", "obs-port", "obs-password"]) {
    input(id).addEventListener("paste", (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text") ?? ""
      if (fillFrom(text)) event.preventDefault()
    })
  }

  byId("obs-save").addEventListener("click", async () => {
    const host = input("obs-host").value.trim() || "127.0.0.1"
    const port = input("obs-port").value.trim() || "4455"
    if (!/^\d{1,5}$/.test(port)) return toast("The server port is a number, like 4455.", true)
    const json: { obsAddress: string; obsPassword?: string } = { obsAddress: `ws://${host}:${port}` }
    const password = input("obs-password").value
    if (password) json.obsPassword = password
    try {
      await request<SettingsSaved>("/api/settings", { method: "PUT", json })
      input("obs-password").value = ""
      input("obs-password").placeholder = "Saved (paste to replace)"
      toast("OBS connection saved. Connecting…")
    } catch (error) {
      toast(errorMessage(error), true)
    }
  })
}
