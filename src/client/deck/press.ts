// Pressing a button. Only ids travel: the companion runs the button as saved
// on the computer.
import type { PressRequest, PressResponse } from "../../shared/api.ts"
import { webAddress } from "../../shared/links.ts"
import { isConfigured } from "../../shared/model.ts"
import type { PressButton } from "../../shared/types.ts"
import { errorMessage } from "../common/http.ts"
import { api, UnpairedError } from "./api.ts"
import { state, toggleKey } from "./state.ts"
import { paintState } from "./tile-state.ts"
import { buzz, isOffline, toast } from "./ui.ts"

export function press(button: PressButton, tile: HTMLElement): void {
  if (isOffline()) {
    toast("Companion offline — nothing was sent.", true)
    return
  }
  buzz(12)
  tile.classList.add("pressed")
  setTimeout(() => tile.classList.remove("pressed"), 160)

  if (!isConfigured(button)) {
    toast("This button has no action yet.")
    return
  }

  // "Open link on the tablet" has to open inside the tap itself, or the popup
  // blocker eats it. A lone link opens straight away; a macro gets a window
  // now and its address when the companion replies.
  const only = button.steps[0]
  if (button.steps.length === 1 && only && only.type === "browser_tile") {
    const address = webAddress(only.url)
    if (address) window.open(address, "_blank", "noopener")
    else toast("This button's link is not a web address.", true)
    return
  }
  const linkWindow = button.steps.some((step) => step.type === "browser_tile") ? window.open("", "_blank") : null

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
        state.toggles[key] = result.active
        paintState(tile, button)
      }
      if (result.message) toast(result.message)
    })
    .catch((error: unknown) => {
      if (linkWindow) linkWindow.close()
      tile.classList.remove("is-busy")
      if (error instanceof UnpairedError) return
      tile.classList.add("is-error")
      setTimeout(() => tile.classList.remove("is-error"), 1600)
      buzz([8, 60, 8])
      toast(errorMessage(error), true)
    })
    .then(() => { delete state.inflight[key] })
}
