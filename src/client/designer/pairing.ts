// The pairing window and the count of connected devices in the top bar.
import { t } from "../../shared/i18n.ts"
import { byId } from "../common/dom.ts"
import { onLanguageChange } from "../common/i18n.ts"
import { createPairingView } from "../common/pairing-ui.ts"
import { toast } from "./hub.ts"

/** Called from the live-state handler on every snapshot. */
export function showDeviceCount(count: number): void {
  const button = byId("pair-btn")
  shownCount = count
  byId("pair-count").textContent = count === 0 ? t("designer.pairing.noDevices") : t("designer.pairing.devices", { count })
  button.classList.toggle("has-devices", count > 0)
}

let shownCount = 0

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
  onLanguageChange(() => {
    showDeviceCount(shownCount)
    // An open window draws its address, countdown and devices again in the new words.
    if (dialog.open) {
      view.stop()
      view.start()
    }
  })
}
