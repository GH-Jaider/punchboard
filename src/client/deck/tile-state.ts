// Live on/off state on a tile: OBS toggles, and a single "Play a sound",
// which is lit while its sound plays.
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
  tile.classList.toggle("is-on", on)
  tile.classList.toggle("is-playing", on && Boolean(soundSlotOf(button)))
  tile.setAttribute("aria-pressed", String(on))
}
