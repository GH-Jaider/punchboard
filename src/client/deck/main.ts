// The tablet deck: a full-screen control surface served by the companion.
// Boot order: sync the clock (and colours), pair if needed, then load the
// library and connect to live state.
import type { HelloResponse, SettingsResponse } from "../../shared/api.ts"
import { applyAccent, applyTheme, byId } from "../common/dom.ts"
import { errorMessage } from "../common/http.ts"
import { loadLanguage } from "../common/i18n.ts"
import { api, fetchHello, hasDevice, loadDevice, syncClock, UnpairedError, whenUnpaired } from "./api.ts"
import { relayoutIfResized, renderGrid, scaleTiles, watchGridSize } from "./grid.ts"
import { initHapticsToggle } from "./haptics.ts"
import { initImmersive } from "./immersive.ts"
import { initWakeLock } from "./wake.ts"
import { connect, loadLibrary } from "./live.ts"
import { claim, initPairing, showPairing, takeHashCode } from "./pairing.ts"
import { setOnline, toast, whenChromeChanges } from "./ui.ts"

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

function boot(hello: Promise<HelloResponse>): void {
  whenUnpaired(() => showPairing())
  initPairing(start)
  initImmersive()
  initWakeLock()
  initHapticsToggle(byId<HTMLButtonElement>("haptics-btn"), renderGrid)

  // The offline banner comes and goes above the grid: lay the tiles out again
  // (ResizeObserver does it too where there is one, for any other change).
  whenChromeChanges(() => window.setTimeout(relayoutIfResized, 0))
  watchGridSize()

  // Only the measurements change on resize, so tiles are not rebuilt.
  let resizeTimer: number | undefined
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(scaleTiles, 120)
  })
  window.addEventListener("orientationchange", () => setTimeout(scaleTiles, 250))

  loadDevice()
  const hashCode = takeHashCode()
  syncClock(hello)
    .catch(() => {})
    .then(() => {
      if (hashCode && !hasDevice()) return claim(hashCode)
      start()
      return undefined
    })
}

// The hello says which language to speak; nothing is drawn until its file
// is in, so the deck never flashes English first. A deck that cannot reach
// the companion goes on in English, from the page itself.
const hello = fetchHello()
loadLanguage(hello.catch(() => null)).then(() => boot(hello), () => boot(hello))
