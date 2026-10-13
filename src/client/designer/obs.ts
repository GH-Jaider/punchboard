// The OBS window. Punchboard reads OBS's own settings when OBS is on this
// computer, so normally the only step is switching on OBS's WebSocket
// server; the manual fields mirror OBS's Show Connect Info window.
import type { ObsDetectResponse, ObsIssue, ObsLink, SettingsResponse, SettingsSaved } from "../../shared/api.ts"
import { t } from "../../shared/i18n.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { keyedAttribute, onLanguageChange } from "../common/i18n.ts"
import { toast } from "./hub.ts"

let link: ObsLink = "unset"
let issue: ObsIssue = null

const input = (id: string): HTMLInputElement => byId<HTMLInputElement>(id)

function showStatus(): void {
  const box = byId("obs-status")
  let title: string
  let help: string
  if (link === "connected") {
    title = t("designer.obs.connectedTitle")
    help = t("designer.obs.connectedHelp")
  } else if (issue === "server-off") {
    title = t("designer.obs.serverOffTitle")
    help = t("designer.obs.turnOn")
  } else if (link === "disconnected" && issue === "wrong-password") {
    title = t("designer.obs.wrongPasswordTitle")
    help = t("designer.obs.wrongPasswordHelp")
  } else if (link === "disconnected") {
    title = t("designer.obs.waitingTitle")
    help = t("designer.obs.waitingHelp")
  } else {
    title = t("designer.obs.unsetTitle")
    help = t("designer.obs.unsetHelp")
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
  // A word or two that fits the rail in every theme (Hardware's uppercase mono
  // is the widest); the tooltip and the OBS window say it in full.
  chip.textContent = t(status === "connected" ? "designer.obs.chipReady" : why === "wrong-password" ? "designer.obs.chipPassword" : why === "server-off" ? "designer.obs.chipTurnOn" : status === "disconnected" ? "designer.obs.chipWaiting" : "designer.obs.chipSetUp")
  chip.className = `state-chip ${status === "connected" ? "ready" : why === "wrong-password" ? "error" : "warning"}`
  showStatus()
  chip.title = byId("obs-status-title").textContent ?? ""
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
  keyedAttribute(input("obs-password"), "placeholder", settings.obsConfigured ? "designer.obs.passwordSaved" : "designer.obs.passwordFromOBS")
  // Typed-in settings live in the manual section; keep it open for them.
  byId<HTMLDetailsElement>("obs-manual").open = settings.obsSource === "manual"
}

async function findObs(): Promise<void> {
  const button = byId<HTMLButtonElement>("obs-find")
  button.disabled = true
  try {
    const found = await request<ObsDetectResponse>("/api/obs/detect", { method: "POST" })
    if (!found.found) {
      toast(t("designer.obs.notFound"), true)
      byId<HTMLDetailsElement>("obs-manual").open = true
    } else if (!found.enabled) {
      toast(t("designer.obs.foundOff"))
    } else {
      toast(t("designer.obs.foundConnecting"))
    }
    input("obs-host").value = "127.0.0.1"
    input("obs-port").value = String(found.port)
    input("obs-password").value = ""
    keyedAttribute(input("obs-password"), "placeholder", "designer.obs.passwordTaken")
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
  onLanguageChange(() => showObsLink(link, issue))

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
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return toast(t("designer.obs.badPort"), true)
    }
    const json: { obsAddress: string; obsPassword?: string } = { obsAddress: `ws://${host}:${port}` }
    const password = input("obs-password").value
    if (password) json.obsPassword = password
    try {
      await request<SettingsSaved>("/api/settings", { method: "PUT", json })
      input("obs-password").value = ""
      keyedAttribute(input("obs-password"), "placeholder", "designer.obs.passwordSaved")
      toast(t("designer.obs.saved"))
    } catch (error) {
      toast(errorMessage(error), true)
    }
  })
}
