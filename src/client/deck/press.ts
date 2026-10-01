// Pressing a button. Only ids travel: the companion runs the button as saved
// on the computer.
import type { PressRequest, PressResponse } from "../../shared/api.ts"
import { webAddress } from "../../shared/links.ts"
import { isConfigured, isSwitch } from "../../shared/model.ts"
import type { PressButton } from "../../shared/types.ts"
import { errorMessage } from "../common/http.ts"
import { api, OfflineError, UnpairedError } from "./api.ts"
import { showDeck } from "./grid.ts"
import { setToggle, state, toggleKey } from "./state.ts"
import { paintState } from "./tile-state.ts"
import { haptic } from "./haptics.ts"
import { isOffline, toast } from "./ui.ts"

export function press(button: PressButton, tile: HTMLElement): void {
  if (isOffline()) {
    toast("Companion offline — nothing was sent.", true)
    return
  }
  haptic("tap")
  tile.classList.add("pressed")
  setTimeout(() => tile.classList.remove("pressed"), 160)

  if (!isConfigured(button)) {
    toast("This button has no action yet.")
    return
  }

  // "Open link on the tablet" has to open inside the tap itself, or the popup
  // blocker eats it. A lone link opens straight away; a macro gets a window
  // now and its address when the companion replies.
  // A lone step of these runs on this device alone; a two-state macro always asks the companion.
  const only = isSwitch(button) ? undefined : button.steps[0]
  // Changing decks happens on this device alone; the companion is not needed.
  if (button.steps.length === 1 && only && only.type === "go_to_deck") {
    goToDeck(only.profileId ?? null)
    return
  }
  if (button.steps.length === 1 && only && only.type === "browser_tile") {
    const address = webAddress(only.url)
    if (address) window.open(address, "_blank", "noopener")
    else toast("This button's link is not a web address.", true)
    return
  }
  const allSteps = button.steps.concat(button.offSteps ?? [])
  const linkWindow = allSteps.some((step) => step.type === "browser_tile") ? window.open("", "_blank") : null
  // Opened blank so the popup blocker allows it, which rules out "noopener"
  // (that returns no window to send on). Cut the link back to the deck by hand.
  if (linkWindow) {
    try { linkWindow.opener = null } catch { /* not allowed: harmless */ }
  }

  const key = toggleKey(button)
  state.inflight[key] = true
  tile.classList.add("is-busy")

  const body: PressRequest = { buttonId: button.id, profileId: state.activeId ?? "" }
  api<PressResponse>("/api/press", { method: "POST", json: body })
    .then((result) => {
      tile.classList.remove("is-busy", "is-error")
      if (linkWindow) {
        if (result.tabletUrl) linkWindow.location.href = result.tabletUrl
        else linkWindow.close()
      }
      if (typeof result.active === "boolean") {
        setToggle(key, result.active)
        paintState(tile, button)
      }
      if (result.message) toast(result.message)
      if (result.deckId !== undefined && result.deckId !== null) goToDeck(result.deckId)
    })
    .catch((error: unknown) => {
      if (linkWindow) linkWindow.close()
      tile.classList.remove("is-busy")
      if (error instanceof UnpairedError) return
      tile.classList.add("is-error")
      setTimeout(() => tile.classList.remove("is-error"), 1600)
      haptic("error")
      // Unreachable: the deck has gone offline already (live.ts); say it plainly.
      toast(error instanceof OfflineError ? "Can't reach the companion. Check that it is running and on the same wifi." : errorMessage(error), true)
    })
    .then(() => { delete state.inflight[key] })
}

function goToDeck(profileId: string | null): void {
  if (!profileId) {
    toast("Choose which deck this button opens, in the Control Center.")
    return
  }
  if (!showDeck(profileId, true)) toast("That deck no longer exists.", true)
}
