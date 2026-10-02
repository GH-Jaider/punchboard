// The canvas: a tablet-shaped preview holding the grid of tiles, drag and
// drop, the keyboard shortcuts, and the notice for buttons left outside the
// grid. Deleting, duplicating and resizing live here too, so the inspector
// and the keyboard share one implementation.
import { FADER_TARGETS, LIMITS, stepSummary } from "../../shared/actions.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { layoutGrid } from "../../shared/layout.ts"
import { createEmptyButton, isConfigured, isSwitch, nextId, parkedButtons } from "../../shared/model.ts"
import type { Button, Profile } from "../../shared/types.ts"
import { applyTileColor, byId, el, svg } from "../common/dom.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { activeProfile, store, touch } from "./state.ts"
import { recordUndo, undoLast } from "./undo.ts"

const gridEl = byId("grid")
const stageEl = byId("stage")
const frameEl = byId("tablet-frame")
let dragFrom: number | null = null

/** Faders and macros say so on the tile, so they are spotted at a glance. */
function tileBadge(button: Button): string {
  if (button.control === "fader") return "Fader"
  if (isSwitch(button)) return "On / off"
  return button.steps.length > 1 ? `${button.steps.length} steps` : ""
}

function describeButton(button: Button): string {
  if (!isConfigured(button)) return "no action yet"
  if (button.control === "fader") return FADER_TARGETS[button.fader.target].label
  if (isSwitch(button)) return "two-state macro"
  return stepSummary(button.steps[0])
}

function tileNode(button: Button): HTMLButtonElement {
  const tile = el("button", "tile")
  tile.type = "button"
  tile.draggable = true
  tile.dataset.slot = String(button.slot)
  applyTileColor(tile, button.color)
  if (!isConfigured(button)) tile.classList.add("unconfigured")
  if (button.slot === store.selectedSlot) tile.classList.add("selected")

  const badgeText = tileBadge(button)
  if (badgeText) tile.appendChild(el("span", "step-count", badgeText))

  const icon = el("span", "tile-icon")
  icon.innerHTML = iconMarkup(button)
  tile.appendChild(icon)
  tile.appendChild(el("span", `tile-label${button.label ? "" : " is-empty"}`, button.label || "Untitled"))

  tile.setAttribute("aria-label", `${button.label || "Untitled"} — ${describeButton(button)}`)
  tile.onclick = () => select(button.slot)

  tile.addEventListener("dragstart", (event) => {
    dragFrom = button.slot
    tile.classList.add("dragging")
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = "move"
    // Firefox refuses to start a drag without a payload.
    try { event.dataTransfer.setData("text/plain", String(button.slot)) } catch { /* ignored */ }
  })
  tile.addEventListener("dragend", () => {
    dragFrom = null
    tile.classList.remove("dragging")
    clearDropTargets()
  })
  return tile
}

function addSlotNode(slot: number): HTMLButtonElement {
  const add = el("button", "add-slot")
  add.type = "button"
  add.innerHTML = svg(UI_ICONS.plus, 20)
  add.setAttribute("aria-label", `Add a button in slot ${slot + 1}`)
  add.onclick = () => {
    activeProfile().buttons.push(createEmptyButton(slot))
    touch()
    select(slot)
    renderGrid()
    view.renderProfiles()
  }
  return add
}

function clearDropTargets(): void {
  gridEl.querySelectorAll(".drop-target").forEach((marked) => marked.classList.remove("drop-target"))
}

/** Moves a button to another slot; an occupied slot swaps, so nothing is overwritten. */
export function moveButton(fromSlot: number, toSlot: number): void {
  if (fromSlot === toSlot) return
  const buttons = activeProfile().buttons
  const source = buttons.find((button) => button.slot === fromSlot)
  const target = buttons.find((button) => button.slot === toSlot)
  if (!source) return
  source.slot = toSlot
  if (target) target.slot = fromSlot
  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.classList.contains("tile")
  store.selectedSlot = toSlot
  touch()
  renderGrid()
  // The moved button stays selected, so the inspector (its slot number, and
  // its Delete and Duplicate) has to follow it.
  view.renderInspector()
  if (hadFocus) gridEl.querySelector<HTMLElement>(`.tile[data-slot="${toSlot}"]`)?.focus()
}

// ------------------------------------------------------------- editing

/** The first free slot at or after `from`, wrapping round; null when the grid is full. */
export function freeSlot(profile: Profile, from: number): number | null {
  const capacity = profile.rows * profile.columns
  const taken = new Set(profile.buttons.map((button) => button.slot))
  for (let offset = 0; offset < capacity; offset += 1) {
    const slot = (from + offset) % capacity
    if (!taken.has(slot)) return slot
  }
  return null
}

/** Removes a button straight away; the toast (and ⌘Z) can put it back. */
export function deleteButton(button: Button): void {
  const profile = activeProfile()
  const index = profile.buttons.indexOf(button)
  if (index === -1) return
  profile.buttons.splice(index, 1)
  store.selectedSlot = null
  recordUndo("Button deleted", () => {
    // Its slot may have been taken meanwhile; then it goes to the nearest free
    // one, and on a full grid to the first slot of a new row. At the row limit
    // it goes just past the grid, where the parked notice offers it back.
    if (profile.buttons.some((other) => other.slot === button.slot)) {
      const slot = freeSlot(profile, button.slot)
      if (slot !== null) {
        button.slot = slot
      } else {
        const taken = new Set(profile.buttons.map((other) => other.slot))
        let spare = profile.rows * profile.columns
        while (taken.has(spare)) spare += 1
        profile.rows = Math.min(LIMITS.rows.max, Math.max(profile.rows, Math.floor(spare / profile.columns) + 1))
        button.slot = spare
      }
    }
    profile.buttons.splice(Math.min(index, profile.buttons.length), 0, button)
    store.activeId = profile.id
    store.selectedSlot = button.slot
  })
  touch()
  view.renderAll()
}

/** A copy in the next free slot, with fresh ids so the two never share state. */
export function duplicateButton(button: Button): void {
  const profile = activeProfile()
  const slot = freeSlot(profile, button.slot + 1)
  if (slot === null) return toast("The grid is full. Add a row or a column first.")
  const copy = JSON.parse(JSON.stringify(button, (key, value: unknown) => (key === "open" ? undefined : value))) as Button
  copy.id = nextId("btn")
  copy.slot = slot
  for (const step of copy.steps) step.id = nextId("step")
  for (const step of copy.offSteps ?? []) step.id = nextId("step")
  profile.buttons.push(copy)
  touch()
  store.selectedSlot = slot
  renderGrid()
  view.renderProfiles()
  view.renderInspector()
}

/** Resizes the grid; buttons outside it are parked, never deleted. */
export function setGridSize(key: "columns" | "rows", value: number): void {
  const profile = activeProfile()
  const range = LIMITS[key]
  const next = Math.max(range.min, Math.min(range.max, Math.round(value) || range.min))
  if (next === profile[key]) return
  profile[key] = next
  touch()
  renderGrid()
  view.renderProfiles()
}

// ------------------------------------------------------------- drawing

export function renderGrid(): void {
  const profile = activeProfile()
  gridEl.innerHTML = ""

  if (profile.trackpad) {
    // The deck itself is the trackpad; nothing to arrange here.
    const preview = el("div", "trackpad-preview")
    preview.appendChild(el("strong", null, "Trackpad"))
    preview.appendChild(el("span", null, "On your devices this deck is one big trackpad for this computer's mouse, like a Magic Trackpad."))
    gridEl.appendChild(preview)
    layoutStage()
    byId("parked-notice").innerHTML = ""
    return
  }

  const bySlot = new Map<number, Button>()
  for (const button of profile.buttons) bySlot.set(button.slot, button)

  const total = profile.rows * profile.columns
  for (let slot = 0; slot < total; slot += 1) {
    const wrap = el("div", "slot-wrap")
    wrap.dataset.slot = String(slot)
    const button = bySlot.get(slot)
    wrap.appendChild(button ? tileNode(button) : addSlotNode(slot))

    wrap.addEventListener("dragover", (event) => {
      if (dragFrom === null) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      if (slot !== dragFrom) wrap.classList.add("drop-target")
    })
    wrap.addEventListener("dragleave", () => wrap.classList.remove("drop-target"))
    wrap.addEventListener("drop", (event) => {
      event.preventDefault()
      wrap.classList.remove("drop-target")
      if (dragFrom === null) return
      moveButton(dragFrom, slot)
      dragFrom = null
    })

    gridEl.appendChild(wrap)
  }
  layoutStage()
  renderParked()
}

/** Sizes the grid inside the tablet frame with the same maths the tablet
    uses on its screen, so the preview shows the deck the way it will look. */
/** An iPad's grid area in landscape (its screen minus the deck bar). */
const FRAME_ASPECT = 1154 / 750
/** A phone held upright, its screen minus the deck bar: where a deck with more
    rows than columns is meant to be used. */
const PORTRAIT_ASPECT = 390 / 700
const FRAME_MAX_WIDTH = 920
const FRAME_MIN_HEIGHT = 240
/** Matches style.css's breakpoint where the three columns stack. */
const STACKED_QUERY = "(max-width: 980px)"
/** How much of the window's height the frame may take when stacked. */
const STACKED_HEIGHT = 0.7

export function layoutStage(): void {
  const profile = activeProfile()
  // Side by side, the stage is whatever room the column leaves. Stacked (a
  // narrow window), the page scrolls and that room is unbounded, so the frame
  // gets most of the window's height and the stage takes the frame's.
  const stacked = window.matchMedia(STACKED_QUERY).matches
  stageEl.style.height = ""
  // The frame keeps the tablet's proportions and fits whatever room the
  // stage has, so a one-row deck never leaves a frame taller than the window.
  const roomWidth = Math.min(stageEl.clientWidth, FRAME_MAX_WIDTH)
  const roomHeight = Math.max(FRAME_MIN_HEIGHT, stacked ? Math.round(window.innerHeight * STACKED_HEIGHT) : stageEl.clientHeight)
  if (!roomWidth || !roomHeight) return
  // A tall deck is previewed on an upright phone, a wide one on a tablet on its side.
  const portrait = !profile.trackpad && profile.rows > profile.columns
  const aspect = portrait ? PORTRAIT_ASPECT : FRAME_ASPECT
  frameEl.classList.toggle("is-portrait", portrait)
  let frameWidth = roomWidth
  let frameHeight = Math.round(frameWidth / aspect)
  if (frameHeight > roomHeight) {
    frameHeight = roomHeight
    frameWidth = Math.round(frameHeight * aspect)
  }
  frameEl.style.width = `${frameWidth}px`
  frameEl.style.height = `${frameHeight}px`
  if (stacked) {
    const style = window.getComputedStyle(stageEl)
    stageEl.style.height = `${frameHeight + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)}px`
  }

  if (profile.trackpad) {
    gridEl.style.gridTemplateColumns = "1fr"
    gridEl.style.gridTemplateRows = "1fr"
    gridEl.style.alignContent = "stretch"
    return
  }

  const width = gridEl.clientWidth
  const height = gridEl.clientHeight
  if (!width || !height) return
  const layout = layoutGrid({ width, height, columns: profile.columns, rows: profile.rows })
  gridEl.style.gap = `${layout.gap}px`
  gridEl.style.gridTemplateColumns = `repeat(${profile.columns},minmax(0,1fr))`
  gridEl.style.gridTemplateRows = `repeat(${profile.rows},${layout.rowHeight}px)`
  gridEl.style.alignContent = layout.alignContent
  // Hidden overflow would clip the selection ring on the outer tiles.
  gridEl.style.overflowY = layout.scrolls ? "auto" : "visible"
  gridEl.style.setProperty("--tile-ico", `${layout.iconSize}px`)
  gridEl.style.setProperty("--tile-fs", `${layout.fontSize}px`)
  // Small tiles get a smaller badge, the smallest none, so "Fader" or
  // "On / off" never sits on the icon or the colour strip.
  const tiny = layout.rowHeight < 52 || layout.colWidth < 64
  const compact = layout.rowHeight < 76 || layout.colWidth < 104
  gridEl.dataset.size = tiny ? "tiny" : compact ? "compact" : ""
  gridEl.querySelectorAll<HTMLElement>(".tile-label").forEach((label) => {
    label.style.display = layout.showLabel ? "" : "none"
  })
}

/** Refreshes one tile's visible bits, so typing a label never rebuilds the grid under the cursor. */
export function refreshTile(button: Button): void {
  const tile = gridEl.querySelector<HTMLElement>(`.tile[data-slot="${button.slot}"]`)
  if (!tile) return renderGrid()
  applyTileColor(tile, button.color)
  tile.classList.toggle("unconfigured", !isConfigured(button))
  const icon = tile.querySelector(".tile-icon")
  if (icon) icon.innerHTML = iconMarkup(button)
  const label = tile.querySelector(".tile-label")
  if (label) {
    label.textContent = button.label || "Untitled"
    label.classList.toggle("is-empty", !button.label)
  }
  let badge = tile.querySelector(".step-count")
  const badgeText = tileBadge(button)
  if (badgeText) {
    if (!badge) {
      badge = el("span", "step-count")
      tile.insertBefore(badge, tile.firstChild)
    }
    badge.textContent = badgeText
  } else if (badge) {
    badge.remove()
  }
}

/** Buttons stranded outside a shrunk grid are reported, never hidden or deleted. */
function renderParked(): void {
  const host = byId("parked-notice")
  host.innerHTML = ""
  const profile = activeProfile()
  const parked = parkedButtons(profile)
  if (!parked.length) return
  const one = parked.length === 1

  const notice = el("div", "notice")
  notice.innerHTML = `<span class="notice-icon">${svg(UI_ICONS.alert)}</span>`
  const body = el("div")
  body.style.flex = "1 1 auto"
  body.appendChild(el("strong", null, `${parked.length}${one ? " button is" : " buttons are"} outside this grid`))
  body.appendChild(el("span", null, `Shrinking the grid left ${one ? "it" : "them"} parked. Nothing was deleted — grow the grid back, move ${one ? "it" : "them"} into the free slots, or delete ${one ? "it" : "them"}.`))

  const actions = el("div", "notice-actions")
  const grow = el("button", "btn", "Grow the grid to fit")
  grow.type = "button"
  grow.onclick = () => {
    const needed = parked.reduce((most, button) => Math.max(most, button.slot + 1), 0)
    profile.rows = Math.min(LIMITS.rows.max, Math.ceil(needed / profile.columns))
    touch()
    view.renderAll()
    if (parkedButtons(profile).length) toast("Grid is at its maximum, so some buttons are still parked.")
  }
  const pull = el("button", "btn", "Move into free slots")
  pull.type = "button"
  pull.onclick = () => {
    const capacity = profile.rows * profile.columns
    const taken = new Set(profile.buttons.filter((button) => button.slot < capacity).map((button) => button.slot))
    let moved = 0
    for (const button of parked) {
      for (let slot = 0; slot < capacity; slot += 1) {
        if (taken.has(slot)) continue
        button.slot = slot
        taken.add(slot)
        moved += 1
        break
      }
    }
    touch()
    view.renderAll()
    toast(moved ? `Moved ${moved} into free slots.` : "No free slots — make the grid bigger first.")
  }
  // For when the smaller grid is the point: they go, with an undo.
  const drop = el("button", "btn ghost danger-text", one ? "Delete it" : "Delete them")
  drop.type = "button"
  drop.onclick = () => {
    const removed = parked.slice()
    profile.buttons = profile.buttons.filter((button) => removed.indexOf(button) === -1)
    recordUndo(`${removed.length}${removed.length === 1 ? " parked button" : " parked buttons"} deleted`, () => {
      for (const button of removed) profile.buttons.push(button)
    })
    touch()
    view.renderAll()
  }
  actions.appendChild(grow)
  actions.appendChild(pull)
  actions.appendChild(drop)
  body.appendChild(actions)
  notice.appendChild(body)
  host.appendChild(notice)
}

export function select(slot: number): void {
  store.selectedSlot = slot
  gridEl.querySelectorAll<HTMLElement>(".tile").forEach((tile) => {
    tile.classList.toggle("selected", Number(tile.dataset.slot) === slot)
  })
  view.renderInspector()
}

export function deselect(): void {
  if (store.selectedSlot === null) return
  store.selectedSlot = null
  gridEl.querySelectorAll<HTMLElement>(".tile.selected").forEach((tile) => tile.classList.remove("selected"))
  view.renderInspector()
}

// ----------------------------------------------------------- keyboard

const isMac = /Mac|iPhone|iPad/.test(navigator.platform)

/** Whether a key press belongs to a text field or an open dialog, not the canvas. */
function typingElsewhere(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null
  if (target && target.closest("input, textarea, select, [contenteditable=\"true\"]")) return true
  return document.querySelector("dialog[open]") !== null
}

/** Whether a key press is aimed at the deck: focus on nothing in particular,
    on a tile, or on the canvas around them. Delete pressed on a step header,
    a swatch or any other control in the inspector must not delete the button. */
function focusOnCanvas(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null
  if (!target || target === document.body || target === document.documentElement) return true
  if (target.closest(".tile")) return true
  return target.closest(".canvas-col") !== null && target.closest("button, a, input, select, textarea, summary, label, [tabindex]") === null
}

function onKeyDown(event: KeyboardEvent): void {
  if (typingElsewhere(event)) return
  const command = isMac ? event.metaKey : event.ctrlKey
  const selected = store.selectedSlot === null ? null : activeProfile().buttons.find((button) => button.slot === store.selectedSlot) ?? null

  if (command && event.key.toLowerCase() === "z" && !event.shiftKey) {
    event.preventDefault()
    return undoLast()
  }
  if (command && event.key.toLowerCase() === "d") {
    if (!selected) return
    event.preventDefault()
    return duplicateButton(selected)
  }
  if ((event.key === "Delete" || event.key === "Backspace") && selected && focusOnCanvas(event)) {
    event.preventDefault()
    return deleteButton(selected)
  }
  if (event.key === "Escape") return deselect()

  // Alt+Arrow moves the selected button, because drag and drop is mouse-only.
  // Only on the canvas: on a deck in the rail, Alt+arrows reorders decks.
  if (!event.altKey || store.selectedSlot === null || !focusOnCanvas(event)) return
  const profile = activeProfile()
  const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -profile.columns, ArrowDown: profile.columns }
  const delta = deltas[event.key]
  if (delta === undefined) return
  const target = store.selectedSlot + delta
  if (target < 0 || target >= profile.rows * profile.columns) return
  event.preventDefault()
  moveButton(store.selectedSlot, target)
}

export function bindGrid(): void {
  document.addEventListener("keydown", onKeyDown)

  const modifier = isMac ? "⌘" : "Ctrl+"
  byId("stage-hint").textContent = `Drag to move · Alt+arrows move · ${modifier}D duplicate · ${modifier}Z undo`

  // Only the measurements change on resize, so the tiles are not rebuilt.
  let resizeTimer: number | null = null
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer)
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null
      if (store.library) layoutStage()
    }, 120)
  })
}

/** How many of the grid's slots are still free (parked buttons do not count). */
export function freeSlotCount(profile: Profile): number {
  const capacity = profile.rows * profile.columns
  const inside = profile.buttons.filter((button) => button.slot < capacity).length
  return Math.max(0, capacity - inside)
}
