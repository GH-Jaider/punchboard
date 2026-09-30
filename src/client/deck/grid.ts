// Rendering the deck. It fills the screen, and a slot means the same thing on
// every device: the designed grid is honoured exactly and tiles resize
// instead of re-flowing, because muscle memory is the product here.
import { stepSummary } from "../../shared/actions.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { isStateful } from "../../shared/model.ts"
import type { Button, PressButton } from "../../shared/types.ts"
import { applyTileColor, byId, el } from "../common/dom.ts"
import { faderMarkup, syncFaders } from "./faders.ts"
import { press } from "./press.ts"
import { activeProfile, state } from "./state.ts"
import { paintState } from "./tile-state.ts"
import { toast } from "./ui.ts"

export const gridEl = byId("grid")
const profilesEl = byId("profiles")

const TILE_MIN = 56 // preferred smallest row height
const TOUCH_MIN = 44 // hard floor: below this a target is unusable
const MAX_ASPECT = 2 // tallest a tile may get relative to its width

export function renderProfiles(): void {
  const library = state.library
  profilesEl.innerHTML = ""
  // One profile is not a choice, so the row stays out of the way.
  if (!library || library.profiles.length < 2) return
  for (const profile of library.profiles) {
    const tab = el("button", profile.id === state.activeId ? "active" : "", profile.name)
    tab.type = "button"
    tab.setAttribute("aria-pressed", String(profile.id === state.activeId))
    tab.onclick = () => {
      state.activeId = profile.id
      renderProfiles()
      renderGrid()
      syncFaders()
    }
    profilesEl.appendChild(tab)
  }
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

  const columns = profile.columns
  const rows = profile.rows
  const gap = width / columns < 92 ? 6 : 10
  gridEl.style.setProperty("--deck-gap", `${gap}px`)

  const colWidth = (width - gap * (columns - 1)) / columns
  const roomPerRow = (height - gap * (rows - 1)) / rows

  let rowHeight = Math.min(roomPerRow, colWidth * MAX_ASPECT)
  if (rowHeight < TILE_MIN) {
    // Tight fit: shrink towards the touch floor before scrolling, because a
    // deck you have to scroll is a broken deck.
    rowHeight = Math.max(TOUCH_MIN, Math.min(TILE_MIN, roomPerRow))
  }
  rowHeight = Math.floor(rowHeight)
  const scrolls = rows * rowHeight + gap * (rows - 1) > height + 1

  gridEl.style.gridTemplateRows = `repeat(${rows},${rowHeight}px)`
  // Start when it overflows (the first rows stay put), centre when the aspect
  // cap left slack, stretch otherwise.
  gridEl.style.alignContent = scrolls ? "start" : rowHeight < roomPerRow - 1 ? "center" : "stretch"
  gridEl.style.overflowY = scrolls ? "auto" : "hidden"

  const icon = Math.max(22, Math.min(76, Math.round(Math.min(colWidth, rowHeight) * 0.42)))
  // Label size follows the width, because that is what a label runs along.
  const font = Math.max(10, Math.min(19, Math.round(colWidth * 0.15)))
  gridEl.style.setProperty("--tile-ico", `${icon}px`)
  gridEl.style.setProperty("--tile-fs", `${font}px`)

  // Under this the label and the icon crowd each other out.
  const showLabel = rowHeight >= 62
  const labels = gridEl.querySelectorAll<HTMLElement>(".tile-label")
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]
    if (label) label.style.display = showLabel ? "" : "none"
  }

  suggestLandscape(colWidth)
}

// A wide deck on a portrait phone is always cramped; say so once.
let hintShown = false
function suggestLandscape(colWidth: number): void {
  if (hintShown || colWidth >= 86) return
  if (window.innerWidth > window.innerHeight) return
  hintShown = true
  toast("Turn the phone sideways for bigger buttons.")
}
