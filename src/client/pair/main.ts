// The pairing page on the computer: the QR and code a tablet pairs with, and
// the list of paired devices.
import type { DeviceInfo, DevicesResponse, NewCodeResponse, PairInfo, SettingsResponse } from "../../shared/api.ts"
import { applyAccent, applyTheme, byId, createToast, el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"

const toast = createToast(byId("toast"))
const deckLink = byId<HTMLAnchorElement>("deck-url")
const qrImage = byId<HTMLImageElement>("qr-image")
let expiresAt = 0

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 2) return "just now"
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

function renderDevices(devices: DeviceInfo[]): void {
  const host = byId("device-list")
  host.innerHTML = ""
  if (!devices.length) {
    host.appendChild(el("p", "field-help", "No devices yet. Scan the code above with a tablet to add one."))
    return
  }
  for (const device of devices) {
    const row = el("div", "device-row")
    const text = el("div")
    text.appendChild(el("strong", null, device.name))
    const where = device.ip ? ` · ${device.ip.replace(/^::ffff:/, "")}` : ""
    text.appendChild(el("small", null, `Paired ${ago(device.createdAt)} · last seen ${ago(device.lastSeen)}${where}`))

    const remove = el("button", "btn danger", "Remove")
    remove.type = "button"
    remove.onclick = () => {
      remove.disabled = true
      request<DevicesResponse>(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" })
        .then((data) => {
          renderDevices(data.devices)
          toast(`${device.name} was removed. It will need to pair again.`)
        })
        .catch((error: unknown) => {
          remove.disabled = false
          toast(errorMessage(error), true)
        })
    }
    row.appendChild(text)
    row.appendChild(remove)
    host.appendChild(row)
  }
}

function showCode(data: { code: string; expiresAt: number }): void {
  byId("pair-code").textContent = `${data.code.slice(0, 3)} ${data.code.slice(3)}`
  expiresAt = data.expiresAt
  // The QR carries the code too, so it is refreshed with it.
  qrImage.src = `/api/pair-qr.svg?v=${data.code}`
}

async function load(): Promise<void> {
  try {
    const data = await request<PairInfo>("/api/pair")
    deckLink.href = data.deckUrl
    deckLink.textContent = data.deckUrl
    showCode(data)
    renderDevices(data.devices)
  } catch (error) {
    deckLink.removeAttribute("href")
    deckLink.textContent = errorMessage(error)
  }
}

// Counts down, and fetches the next code the moment this one lapses.
setInterval(() => {
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  byId("pair-expiry").textContent = expiresAt ? `Changes in ${Math.floor(left / 60)}:${`0${left % 60}`.slice(-2)}` : ""
  if (expiresAt && left === 0) {
    expiresAt = 0
    void load()
  }
}, 1000)

// Picks up a tablet that pairs while this page is open.
setInterval(() => {
  request<PairInfo>("/api/pair").then((data) => renderDevices(data.devices)).catch(() => {})
}, 5000)

byId("new-code").addEventListener("click", () => {
  request<NewCodeResponse>("/api/pair/new-code", { method: "POST" })
    .then((data) => {
      showCode(data)
      toast("New code ready. The old one no longer works.")
    })
    .catch((error: unknown) => toast(errorMessage(error), true))
})

request<SettingsResponse>("/api/settings")
  .then((settings) => {
    applyTheme(settings.theme)
    applyAccent(settings.accent)
  })
  .catch(() => {})

// A broken-image icon is no help if the QR fails; say what to do instead.
qrImage.addEventListener("error", () => {
  const frame = byId("qr-frame")
  frame.className = "qr-frame is-error"
  frame.textContent = "The QR code could not be generated. Open the address below on the tablet and type the code."
})

void load()
