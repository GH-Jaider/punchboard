// Rendering the deck. It fills the screen, and a slot means the same thing on
// every device: the designed grid is honoured exactly and tiles resize
// instead of re-flowing, because muscle memory is the product here.
import { stepSummary } from "../../shared/actions.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { layoutGrid } from "../../shared/layout.ts"
import { isStateful, isSwitch, shownProfiles, soundSlotOf } from "../../shared/model.ts"
import type { Button, PressButton } from "../../shared/types.ts"
import { applyTileColor, byId, el } from "../common/dom.ts"
import { faderMarkup, syncFaders } from "./faders.ts"
import { repaintIndicators } from "./indicators.ts"
import { tapSwitch, tapsThroughSwitch } from "./haptics.ts"
import { press } from "./press.ts"
import { activeProfile, state } from "./state.ts"
import { paintState } from "./tile-state.ts"
import { hideTrackpad, showTrackpad } from "./trackpad.ts"
import { toast } from "./ui.ts"

export const gridEl = byId("grid")
const profilesEl = byId("profiles")


export function renderProfiles(): void {
  const library = state.library
  profilesEl.innerHTML = ""
  // One deck is not a choice, so the row stays out of the way. Hidden decks
  // get no tab; a button can still open them.
  const shown = library ? shownProfiles(library) : []
  if (shown.length < 2) return
  for (const profile of shown) {
    const tab = el("button", profile.id === state.activeId ? "active" : "", profile.name)
    tab.type = "button"
    tab.setAttribute("aria-pressed", String(profile.id === state.activeId))
    tab.onclick = () => { showDeck(profile.id) }
    profilesEl.appendChild(tab)
  }
  revealActiveTab()
}

/* A deck opened by a button may have its tab scrolled out of sight. Done by
   hand: scrollIntoView with options is Safari 14+, and without them it would
   scroll the page too. */
function revealActiveTab(): void {
  const tab = profilesEl.querySelector<HTMLElement>("button.active")
  if (!tab || profilesEl.scrollWidth <= profilesEl.clientWidth) return
  const left = tab.offsetLeft - profilesEl.offsetLeft
  const right = left + tab.offsetWidth
  if (left < profilesEl.scrollLeft) profilesEl.scrollLeft = Math.max(0, left - 12)
  else if (right > profilesEl.scrollLeft + profilesEl.clientWidth) profilesEl.scrollLeft = right - profilesEl.clientWidth + 12
}

/** The hidden deck a "Go to another deck" button opened, kept through reloads. */
let viaButton: string | null = null
export const openedByButton = (profileId: string): boolean => viaButton === profileId

/** Shows one of the decks; false when there is no such deck. */
export function showDeck(profileId: string, byButton = false): boolean {
  const library = state.library
  if (!library || !library.profiles.some((profile) => profile.id === profileId)) return false
  viaButton = byButton ? profileId : null
  state.activeId = profileId
  renderProfiles()
  renderGrid()
  syncFaders()
  return true
}

function describe(button: Button): string {
  if (isSwitch(button)) return "On / off macro"
  if (button.steps.length > 1) return `${button.steps.length}-step macro`
  return stepSummary(button.steps[0])
}

function pressTile(button: PressButton): HTMLElement {
  // On an iPhone the button is a label over an invisible switch, so the tap
  // that presses it also flips the switch and iOS ticks (haptics.ts). A switch
  // cannot sit inside a <button>.
  const throughSwitch = tapsThroughSwitch()
  const tile = el(throughSwitch ? "label" : "button", "tile")
  if (tile instanceof HTMLButtonElement) tile.type = "button"
  else tile.setAttribute("role", "button")
  if (throughSwitch) {
    tile.appendChild(tapSwitch())
    // A label is not focusable or keyboard-operable the way a button is.
    tile.tabIndex = 0
    tile.addEventListener("keydown", (keyEvent: Event) => {
      const event = keyEvent as KeyboardEvent
      if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return
      event.preventDefault()
      if (!event.repeat) press(button, tile)
    })
  }
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
  tile.addEventListener("click", (event: Event) => {
    // A click on the label itself (label.click(), assistive tech) is passed
    // on to its switch and comes back up from there: press once, not twice.
    if (throughSwitch && event.target === tile) return
    press(button, tile)
  })
  return tile
}

const EMPTY_DECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' +
  "<div><strong>This deck is empty.</strong><br>Open the Control Center on your computer and add some buttons.</div>"

export function renderGrid(): void {
  if (!state.library) return
  const profile = activeProfile()
  hideTrackpad()
  gridEl.innerHTML = ""

  if (profile && profile.trackpad) {
    showTrackpad(profile, gridEl)
    return
  }

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

  // The grid's padding is only room for rings at the edges (style.css).
  const box = window.getComputedStyle(gridEl)
  const padX = (parseFloat(box.paddingLeft) || 0) + (parseFloat(box.paddingRight) || 0)
  const padY = (parseFloat(box.paddingTop) || 0) + (parseFloat(box.paddingBottom) || 0)
  const width = gridEl.clientWidth - padX
  const height = gridEl.clientHeight - padY
  if (width <= 0 || height <= 0) return
  lastSize = `${gridEl.clientWidth}x${gridEl.clientHeight}`

  const layout = layoutGrid({ width, height, columns: profile.columns, rows: profile.rows })
  gridEl.style.setProperty("--deck-gap", `${layout.gap}px`)
  gridEl.style.gridTemplateRows = `repeat(${profile.rows},${layout.rowHeight}px)`
  gridEl.style.alignContent = layout.alignContent
  gridEl.style.overflowY = layout.scrolls ? "auto" : "hidden"
  gridEl.style.setProperty("--tile-ico", `${layout.iconSize}px`)
  gridEl.style.setProperty("--tile-fs", `${layout.fontSize}px`)
  // Small tiles: corner readouts shrink so they keep clear of the icon.
  gridEl.classList.toggle("is-compact", layout.colWidth < 96 || layout.rowHeight < 76)

  fitLabels(layout.showLabel)
  suggestLandscape(layout.colWidth)
}

/* Shows only whole lines of a label. A label squeezed by its tile used to
   show the top of a second line cut through the middle; this measures the
   room each label actually got and clamps it to the lines that fit, or
   hides it when not even one does. Reads all, then writes all. */
function fitLabels(show: boolean): void {
  const labels = gridEl.querySelectorAll<HTMLElement>(".tile-label")
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]
    if (!label) continue
    label.style.display = show ? "" : "none"
    label.style.removeProperty("-webkit-line-clamp")
  }
  if (!show) return
  const fits: number[] = []
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]
    if (!label) { fits.push(-1); continue }
    const style = window.getComputedStyle(label)
    const fontSize = parseFloat(style.fontSize) || 13
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2
    const clamp = parseInt(style.getPropertyValue("-webkit-line-clamp"), 10) || 2
    const room = label.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0)
    const lines = Math.floor((room + 1) / lineHeight)
    fits.push(lines >= clamp ? -1 : lines)
  }
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i]
    const lines = fits[i]
    if (!label || lines === undefined || lines < 0) continue
    if (lines < 1) label.style.display = "none"
    else label.style.setProperty("-webkit-line-clamp", String(lines))
  }
}

/* Re-lays the tiles out when the grid's box changes for any reason: the
   offline banner, the tab row, the bar, the window. ResizeObserver where
   there is one (Safari 13.1+, Chrome 64+); elsewhere the callers ask. */
let lastSize = ""
export function relayoutIfResized(): void {
  if (`${gridEl.clientWidth}x${gridEl.clientHeight}` !== lastSize) scaleTiles()
}

type ResizeObserverLike = new (callback: () => void) => { observe(target: Element): void }

export function watchGridSize(): void {
  const Observer = (window as Window & { ResizeObserver?: ResizeObserverLike }).ResizeObserver
  if (typeof Observer !== "function") return
  let frame = 0
  new Observer(() => {
    window.cancelAnimationFrame(frame)
    frame = window.requestAnimationFrame(relayoutIfResized)
  }).observe(gridEl)
}

// A wide deck on a portrait phone is always cramped; say so once.
let hintShown = false
function suggestLandscape(colWidth: number): void {
  if (hintShown || colWidth >= 86) return
  if (window.innerWidth > window.innerHeight) return
  hintShown = true
  toast("Turn the phone sideways for bigger buttons.")
}
