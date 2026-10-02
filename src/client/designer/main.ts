// The Control Center: builds decks on this computer and serves as its sound
// output. This file wires the modules together and loads the first state.
import type { Ok, SettingsResponse } from "../../shared/api.ts"
import { byId } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { bindAppearance, setTheme, showAccent } from "./appearance.ts"
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
import { bindDialogChrome } from "./dialogs.ts"

function renderAll(): void {
  renderProfiles()
  renderGrid()
  renderInspector()
  byId("profile-title").textContent = activeProfile().name
}

Object.assign(view, { renderAll, renderGrid, renderProfiles, renderInspector, renderSteps, refreshTile, syncOnIcon, select })

bindGrid()
bindProfiles()
bindIconPicker()
bindAppPicker()
bindSounds()
bindSoundOutput()
bindAppearance()
bindObs()
bindPairing()

// The desktop app's "Pair a device…" opens /designer#pair.
function openPairingFromHash(): void {
  if (location.hash !== "#pair") return
  history.replaceState(null, "", location.pathname)
  byId("pair-btn").click()
}
window.addEventListener("hashchange", openPairingFromHash)
openPairingFromHash()
bindSession()
bindSupport()
bindSaving()
bindDialogChrome()

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
    showAccent(settings.accent)
    setTheme(settings.theme)
    showObsSettings(settings)
    showIntroIfNew()
    showSupportNote(settings)

    setSaveState("", "Saved · decks in sync")
    renderAll()
    void loadSounds()
    watchEvents()
  } catch (error) {
    setSaveState("error", "Could not load")
    toast(errorMessage(error), true)
  }
}

void start()
