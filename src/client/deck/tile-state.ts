// Live on/off state on a tile: OBS toggles, and a single "Play a sound",
// which is lit while its sound plays.
import { iconMarkup } from "../../shared/icons.ts"
import { soundSlotOf } from "../../shared/model.ts"
import type { Button } from "../../shared/types.ts"
import { state, toggleKey } from "./state.ts"

export function isOn(button: Button): boolean {
  const slot = soundSlotOf(button)
  if (slot) return state.playing.indexOf(slot) !== -1
  return Boolean(state.toggles[toggleKey(button)])
}

export function paintState(tile: HTMLElement, button: Button): void {
  const on = isOn(button)
  // A button with an icon for its on state swaps it, only when the state changes.
  if (button.onGlyph && tile.getAttribute("data-icon-on") !== String(on)) {
    tile.setAttribute("data-icon-on", String(on))
    const icon = tile.querySelector(".tile-icon")
    if (icon) icon.innerHTML = on ? iconMarkup({ icon: button.icon, iconData: null, glyph: button.onGlyph }) : iconMarkup(button)
  }
  tile.classList.toggle("is-on", on)
  tile.classList.toggle("is-playing", on && Boolean(soundSlotOf(button)))
  tile.setAttribute("aria-pressed", String(on))
}
