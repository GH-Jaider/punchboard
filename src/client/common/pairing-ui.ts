// The pairing view: QR, code, countdown and the paired-device list. Shared by
// the Control Center's pairing window and the standalone /pair page, which
// exists because the terminal prints its link.
import type { DeviceInfo, DevicesResponse, NewCodeResponse, PairInfo } from "../../shared/api.ts"
import { el } from "./dom.ts"
import { errorMessage, request } from "./http.ts"

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (minutes < 2) return "just now"
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} hours ago`
  return `${Math.round(hours / 24)} days ago`
}

/** "123456" → "123 456", the way people read a code out. */
export const formatCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`

export function countdownText(expiresAt: number): string {
  if (!expiresAt) return ""
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  return `Changes in ${Math.floor(left / 60)}:${`0${left % 60}`.slice(-2)}`
}

export type Toast = (message: string, isError?: boolean) => void

export function renderDevices(host: HTMLElement, devices: DeviceInfo[], onRemove: (device: DeviceInfo, button: HTMLButtonElement) => void): void {
  host.innerHTML = ""
  if (!devices.length) {
    host.appendChild(el("p", "field-help", "No devices yet. Scan the code with a tablet to add one."))
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
    remove.onclick = () => onRemove(device, remove)
    row.appendChild(text)
    row.appendChild(remove)
    host.appendChild(row)
  }
}

export interface PairingElements {
  qrFrame: HTMLElement
  qrImage: HTMLImageElement
  code: HTMLElement
  expiry: HTMLElement
  address: HTMLElement
  newCode: HTMLButtonElement
  devices: HTMLElement
}

export interface PairingView {
  /** Loads once and starts the countdown and the device poll. */
  start(): void
  /** Stops both timers; a closed window must not keep polling. */
  stop(): void
}

export function createPairingView(elements: PairingElements, toast: Toast): PairingView {
  let expiresAt = 0
  let tick: number | undefined
  let poll: number | undefined
  let shownCode = ""

  function showCode(data: { code: string; expiresAt: number }): void {
    shownCode = data.code
    elements.code.textContent = formatCode(data.code)
    expiresAt = data.expiresAt
    elements.expiry.textContent = countdownText(expiresAt)
    // The QR carries the code too, so it is refreshed with it.
    elements.qrImage.src = `/api/pair-qr.svg?v=${data.code}`
  }

  function removeDevice(device: DeviceInfo, button: HTMLButtonElement): void {
    button.disabled = true
    request<DevicesResponse>(`/api/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" })
      .then((data) => {
        renderDevices(elements.devices, data.devices, removeDevice)
        toast(`${device.name} was removed. It will need to pair again.`)
      })
      .catch((error: unknown) => {
        button.disabled = false
        toast(errorMessage(error), true)
      })
  }

  async function load(): Promise<void> {
    try {
      const data = await request<PairInfo>("/api/pair")
      elements.address.textContent = data.deckUrl
      if (elements.address instanceof HTMLAnchorElement) elements.address.href = data.deckUrl
      showCode(data)
      renderDevices(elements.devices, data.devices, removeDevice)
    } catch (error) {
      elements.address.textContent = errorMessage(error)
    }
  }

  elements.newCode.addEventListener("click", () => {
    request<NewCodeResponse>("/api/pair/new-code", { method: "POST" })
      .then((data) => {
        showCode(data)
        toast("New code ready. The old one no longer works.")
      })
      .catch((error: unknown) => toast(errorMessage(error), true))
  })

  // A broken-image icon is no help if the QR fails; say what to do instead.
  elements.qrImage.addEventListener("error", () => {
    elements.qrFrame.className = "qr-frame is-error"
    elements.qrFrame.textContent = "The QR code could not be generated. Open the address on the tablet and type the code."
  })

  return {
    start(): void {
      this.stop()
      void load()
      // Counts down, and fetches the next code the moment this one lapses.
      tick = window.setInterval(() => {
        elements.expiry.textContent = countdownText(expiresAt)
        if (expiresAt && expiresAt - Date.now() <= 0) {
          expiresAt = 0
          void load()
        }
      }, 1000)
      // Picks up a tablet that pairs while this is open, and the code that
      // replaces the one it used: a code pairs one device only.
      poll = window.setInterval(() => {
        request<PairInfo>("/api/pair").then((data) => {
          if (data.code !== shownCode) showCode(data)
          renderDevices(elements.devices, data.devices, removeDevice)
        }).catch(() => {})
      }, 2000)
    },
    stop(): void {
      window.clearInterval(tick)
      window.clearInterval(poll)
      tick = undefined
      poll = undefined
    }
  }
}
