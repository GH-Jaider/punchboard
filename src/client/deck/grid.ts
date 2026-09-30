// Rendering the deck. It fills the screen, and a slot means the same thing on
// every device: the designed grid is honoured exactly and tiles resize
// instead of re-flowing, because muscle memory is the product here.
import { stepSummary } from "../../shared/actions.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { layoutGrid } from "../../shared/layout.ts"
import { isStateful, soundSlotOf } from "../../shared/model.ts"
import type { Button, PressButton } from "../../shared/types.ts"
import { applyTileColor, byId, el } from "../common/dom.ts"
import { faderMarkup, syncFaders } from "./faders.ts"
import { repaintIndicators } from "./indicators.ts"
import { press } from "./press.ts"
import { activeProfile, state } from "./state.ts"
import { paintState } from "./tile-state.ts"
import { toast } from "./ui.ts"

export const gridEl = byId("grid")
const profilesEl = byId("profiles")


export function renderProfiles(): void {
  const library = state.library
  profilesEl.innerHTML = ""
  // One profile is not a choice, so the row stays out of the way.
  if (!library || library.profiles.length < 2) return
  for (const profile of library.profiles) {
    const tab = el("button", profile.id === state.activeId ? "active" : "", profile.name)
    tab.type = "button"
    tab.setAttribute("aria-pressed", String(profile.id === state.activeId))
    tab.onclick = () => { showDeck(profile.id) }
    profilesEl.appendChild(tab)
  }
}

/** Shows one of the decks; false when there is no such deck. */
export function showDeck(profileId: string): boolean {
  const library = state.library
  if (!library || !library.profiles.some((profile) => profile.id === profileId)) return false
  state.activeId = profileId
  renderProfiles()
  renderGrid()
  syncFaders()
  return true
}

function describe(button: Button): string {
  if (button.steps.length > 1) return `${button.steps.length}-step macro`
  return stepSummary(button.steps[0])
}

function pressTile(button: PressButton): HTMLElement {
  const tile = el("button", "tile")
  tile.type = "button"
  tile.setAttribute("data-button-id", button.id)
  applyTileColor(tile, button.color)

  const icon = el("span", "tile-icon")
  icon.innerHTML = iconMarkup(button)
  tile.appendChild(icon)
  const slot = soundSlotOf(button)
  if (slot) {
    // Progress and time left while this sound plays (indicators.ts).
    tile.setAttribute("data-sound-slot", String(slot))
    const progress = el("span", "sound-progress")
    progress.appendChild(el("span", "sound-progress-fill"))
    tile.appendChild(progress)
    tile.appendChild(el("span", "sound-time"))
  }
  if (button.label) tile.appendChild(el("span", "tile-label", button.label))

  if (isStateful(button)) paintState(tile, button)
  // Screen readers get the action, not just the label.
  tile.setAttribute("aria-label", button.label || describe(button))
  tile.addEventListener("click", () => press(button, tile))
  return tile
}

const EMPTY_DECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' +
  "<div><strong>This deck is empty.</strong><br>Open the Control Center on your computer and add some buttons.</div>"

export function renderGrid(): void {
  if (!state.library) return
  const profile = activeProfile()
  gridEl.innerHTML = ""

  if (!profile || !profile.buttons.length) {
    const empty = el("div", "deck-empty")
    empty.innerHTML = EMPTY_DECK
    gridEl.style.display = "block"
    gridEl.appendChild(empty)
    return
  }

  gridEl.style.display = "grid"
  // A literal string on purpose: repeat(var(--n), …) misbehaves on older Safari.
  gridEl.style.gridTemplateColumns = `repeat(${profile.columns},minmax(0,1fr))`

  const bySlot = new Map<number, Button>()
  for (const button of profile.buttons) bySlot.set(button.slot, button)

  const total = profile.rows * profile.columns
  for (let slot = 0; slot < total; slot += 1) {
    const button = bySlot.get(slot)
    if (!button) {
      const blank = el("div", "slot-empty")
      blank.setAttribute("aria-hidden", "true")
      gridEl.appendChild(blank)
      continue
    }
    gridEl.appendChild(button.control === "fader" ? faderMarkup(button) : pressTile(button))
  }
  scaleTiles()
  repaintIndicators()
}

/* Sizes the rows, then the tile contents, from the real box. Rows grow to
   fill the space until a tile would get taller than MAX_ASPECT, then stop and
   the grid centres itself, so a wide deck on a portrait phone does not turn
   every label into "Brows / er". Container queries would be tidier but need
   Safari 16, and this deck runs on whatever tablet was in the drawer. */
export function scaleTiles(): void {
  const profile = activeProfile()
  if (!profile || !gridEl.querySelector(".tile")) return

  // Measure with the previous row heights cleared, or this measures the grid
  // it just sized rather than the space available for it.
  gridEl.style.gridTemplateRows = ""
  gridEl.style.alignContent = ""

  const width = gridEl.clientWidth
  const height = gridEl.clientHeight
  if (!width || !height) return

  const layout = layoutGrid({ width, height, columns: profile.columns, rows: profile.rows })
  gridEl.style.setProperty("--deck-gap", `${layout.gap}px`)
  gridEl.style.gridTemplateRows = `repeat(${profile.rows},${layout.rowHeight}px)`
  gridEl.style.alignContent = layout.alignContent
  gridEl.style.overflowY = layout.scrolls ? "auto" : "hidden"
  gridEl.style.setProperty("--tile-ico", `${layout.iconSize}px`)
  gridEl.style.setProperty("--tile-fs", `${layout.fontSize}px`)

  const labels = gridEl.querySelectorAll<HTMLElement>(".tile-label")
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]
    if (label) label.style.display = layout.showLabel ? "" : "none"
  }

  suggestLandscape(layout.colWidth)
}

// A wide deck on a portrait phone is always cramped; say so once.
let hintShown = false
function suggestLandscape(colWidth: number): void {
  if (hintShown || colWidth >= 86) return
  if (window.innerWidth > window.innerHeight) return
  hintShown = true
  toast("Turn the phone sideways for bigger buttons.")
}
