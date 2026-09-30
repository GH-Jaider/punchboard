// The tablet deck: a full-screen control surface served by the companion.
// Boot order: sync the clock (and colours), pair if needed, then load the
// library and connect to live state.
import type { SettingsResponse } from "../../shared/api.ts"
import { applyAccent, applyTheme } from "../common/dom.ts"
import { errorMessage } from "../common/http.ts"
import { api, hasDevice, loadDevice, syncClock, UnpairedError, whenUnpaired } from "./api.ts"
import { scaleTiles } from "./grid.ts"
import { initImmersive } from "./immersive.ts"
import { connect, loadLibrary } from "./live.ts"
import { claim, initPairing, showPairing, takeHashCode } from "./pairing.ts"
import { setOnline, toast } from "./ui.ts"

function start(): void {
  api<SettingsResponse>("/api/settings")
    .then((settings) => {
      applyAccent(settings.accent)
      applyTheme(settings.theme)
    })
    .catch(() => {})

  loadLibrary()
    .then(() => {
      setOnline(true)
      connect()
    })
    .catch((error: unknown) => {
      if (error instanceof UnpairedError) return
      setOnline(false)
      toast(errorMessage(error), true)
      connect()
    })
}

whenUnpaired(() => showPairing())
initPairing(start)
initImmersive()

// Only the measurements change on resize, so tiles are not rebuilt.
let resizeTimer: number | undefined
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(scaleTiles, 120)
})
window.addEventListener("orientationchange", () => setTimeout(scaleTiles, 250))

loadDevice()
const hashCode = takeHashCode()
syncClock()
  .catch(() => {})
  .then(() => {
    if (hashCode && !hasDevice()) return claim(hashCode)
    start()
    return undefined
  })
