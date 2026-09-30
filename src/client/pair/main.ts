// The standalone pairing page on the computer. The Control Center has the
// same view in a window; this page exists because the terminal prints its link.
import type { SettingsResponse } from "../../shared/api.ts"
import { applyAccent, applyTheme, byId, createToast } from "../common/dom.ts"
import { request } from "../common/http.ts"
import { createPairingView } from "../common/pairing-ui.ts"

const toast = createToast(byId("toast"))

request<SettingsResponse>("/api/settings")
  .then((settings) => {
    applyTheme(settings.theme)
    applyAccent(settings.accent)
  })
  .catch(() => {})

createPairingView({
  qrFrame: byId("qr-frame"),
  qrImage: byId<HTMLImageElement>("qr-image"),
  code: byId("pair-code"),
  expiry: byId("pair-expiry"),
  address: byId<HTMLAnchorElement>("deck-url"),
  newCode: byId<HTMLButtonElement>("new-code"),
  devices: byId("device-list")
}, toast).start()
