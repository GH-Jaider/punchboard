// The Control Center: builds decks on this computer and serves as its sound
// output. This file wires the modules together and loads the first state.
import type { HelloResponse, Ok, SettingsResponse } from "../../shared/api.ts"
import { t } from "../../shared/i18n.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { loadLanguage, noteLanguages, onLanguageChange } from "../common/i18n.ts"
import { bindAppearance, setTheme, showAccent, showLanguage } from "./appearance.ts"
import { watchEvents } from "./events.ts"
import { bindGrid, refreshTile, renderGrid, select } from "./grid.ts"
import { toast, view } from "./hub.ts"
import { bindAppPicker } from "./app-picker.ts"
import { bindIconPicker } from "./icon-picker.ts"
import { renderInspector, syncOnIcon } from "./inspector.ts"
import { bindObs, showObsSettings } from "./obs.ts"
import { bindPairing } from "./pairing.ts"
import { bindProfiles, renderProfiles } from "./profiles.ts"
import { bindSession, showIntroIfNew } from "./session.ts"
import { bindSupport, showSupportNote } from "./support.ts"
import { bindSoundOutput } from "./sound-output.ts"
import { bindSounds, loadSounds } from "./sounds.ts"
import { activeProfile, bindSaving, fetchLibrary, setSaveState, store } from "./state.ts"
import { renderSteps } from "./steps.ts"
import { afterFirstTour, bindTour, offerTour } from "./tour.ts"
import { bindDialogChrome } from "./dialogs.ts"

function renderAll(): void {
  renderProfiles()
  renderGrid()
  renderInspector()
  byId("profile-title").textContent = activeProfile().name
}

Object.assign(view, { renderAll, renderGrid, renderProfiles, renderInspector, renderSteps, refreshTile, syncOnIcon, select })

// The desktop app's "Pair a device…" opens /designer#pair.
function openPairingFromHash(): void {
  if (location.hash !== "#pair") return
  history.replaceState(null, "", location.pathname)
  byId("pair-btn").click()
}

function bindAll(): void {
  bindGrid()
  bindProfiles()
  bindIconPicker()
  bindAppPicker()
  bindSounds()
  bindSoundOutput()
  bindAppearance()
  bindObs()
  bindPairing()

  window.addEventListener("hashchange", openPairingFromHash)
  openPairingFromHash()
  bindSession()
  bindSupport()
  bindTour()
  bindSaving()
  bindDialogChrome()
  // A new language redraws what is on screen; dialogs draw their text as they open.
  onLanguageChange(() => {
    if (store.library) renderAll()
  })
}

async function start(): Promise<void> {
  try {
    const loaded = await Promise.all([fetchLibrary(), request<SettingsResponse>("/api/settings")])
    const library = loaded[0]
    const settings = loaded[1]
    store.library = library
    store.activeId = library.activeProfileId

    byId("app-version").textContent = settings.version === "dev" ? "dev" : `v${settings.version}`
    // The desktop app's window opens no tabs: the deck opens in the computer's browser.
    if (settings.desktop) {
      byId("open-deck").addEventListener("click", (event) => {
        event.preventDefault()
        request<Ok>("/api/open-deck", { method: "POST" }).catch((error: unknown) => toast(errorMessage(error), true))
      })
    }
    noteLanguages(settings.language)
    showAccent(settings.accent)
    setTheme(settings.theme)
    void showLanguage()
    showObsSettings(settings)
    showIntroIfNew()

    setSaveState("", t("designer.save.inSync"))
    renderAll()
    // First the tour, then the Ko-fi note, never both at once.
    const touring = offerTour(settings)
    showSupportNote(settings, touring ? afterFirstTour : undefined)
    void loadSounds()
    watchEvents()
  } catch (error) {
    setSaveState("error", t("designer.save.couldNotLoad"))
    toast(errorMessage(error), true)
  }
}

// Nothing is drawn until the language file is in, so the page never flashes
// English first; the HTML's own English stays if it cannot be fetched.
const ready = (): void => {
  bindAll()
  void start()
}
loadLanguage(request<HelloResponse>("/api/hello").catch(() => null)).then(ready, ready)
