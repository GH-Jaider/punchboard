// The pairing window and the count of connected devices in the top bar.
import { byId } from "../common/dom.ts"
import { createPairingView } from "../common/pairing-ui.ts"
import { toast } from "./hub.ts"

/** Called from the live-state handler on every snapshot. */
export function showDeviceCount(count: number): void {
  const button = byId("pair-btn")
  byId("pair-count").textContent = count === 0 ? "No devices" : count === 1 ? "1 device" : `${count} devices`
  button.classList.toggle("has-devices", count > 0)
}

export function bindPairing(): void {
  const dialog = byId<HTMLDialogElement>("dlg-pair")
  const view = createPairingView({
    qrFrame: byId("pair-qr-frame"),
    qrImage: byId<HTMLImageElement>("pair-qr-image"),
    code: byId("pair-code"),
    expiry: byId("pair-expiry"),
    address: byId("pair-address"),
    newCode: byId<HTMLButtonElement>("pair-new-code"),
    devices: byId("pair-devices")
  }, toast)

  byId("pair-btn").addEventListener("click", () => {
    dialog.showModal()
    view.start()
  })
  // Closing from the button, the backdrop or Escape all end here.
  dialog.addEventListener("close", () => view.stop())
}
