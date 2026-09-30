// The canvas: the grid of tiles as the tablet shows it, drag and drop,
// keyboard moves, grid size, and the notice for buttons left outside the grid.
import { FADER_TARGETS, LIMITS, stepSummary } from "../../shared/actions.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { createEmptyButton, isConfigured, parkedButtons } from "../../shared/model.ts"
import type { Button } from "../../shared/types.ts"
import { applyTileColor, byId, el, svg } from "../common/dom.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { activeProfile, store, touch } from "./state.ts"

const gridEl = byId("grid")
let dragFrom: number | null = null

/** Faders and macros say so on the tile, so they are spotted at a glance. */
function tileBadge(button: Button): string {
  if (button.control === "fader") return "Fader"
  return button.steps.length > 1 ? `${button.steps.length} steps` : ""
}

function describeButton(button: Button): string {
  if (!isConfigured(button)) return "no action yet"
  if (button.control === "fader") return FADER_TARGETS[button.fader.target].label
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
  store.selectedSlot = toSlot
  touch()
  renderGrid()
}

export function renderGrid(): void {
  const profile = activeProfile()
  gridEl.innerHTML = ""
  gridEl.style.gridTemplateColumns = `repeat(${profile.columns},minmax(0,1fr))`

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
  renderParked()
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
  body.appendChild(el("span", null, `Shrinking the grid left ${one ? "it" : "them"} parked. Nothing was deleted — grow the grid back, or move ${one ? "it" : "them"} into the free slots.`))

  const actions = el("div", "notice-actions")
  const grow = el("button", "btn", "Grow the grid to fit")
  grow.type = "button"
  grow.onclick = () => {
    const needed = parked.reduce((most, button) => Math.max(most, button.slot + 1), 0)
    const rows = Math.min(LIMITS.rows.max, Math.ceil(needed / profile.columns))
    profile.rows = rows
    byId<HTMLInputElement>("rows").value = String(rows)
    touch()
    renderGrid()
    view.renderProfiles()
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
    renderGrid()
    view.renderProfiles()
    toast(moved ? `Moved ${moved} into free slots.` : "No free slots — make the grid bigger first.")
  }
  actions.appendChild(grow)
  actions.appendChild(pull)
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

function setGridSize(key: "columns" | "rows", raw: string): void {
  const profile = activeProfile()
  const range = LIMITS[key]
  const value = Math.max(range.min, Math.min(range.max, Number(raw) || range.min))
  profile[key] = value
  byId<HTMLInputElement>(key === "columns" ? "cols" : "rows").value = String(value)
  touch()
  renderGrid()
  view.renderProfiles()
}

export function bindGrid(): void {
  const cols = byId<HTMLInputElement>("cols")
  const rows = byId<HTMLInputElement>("rows")
  cols.addEventListener("change", () => setGridSize("columns", cols.value))
  rows.addEventListener("change", () => setGridSize("rows", rows.value))

  // Alt+Arrow moves the selected button, because drag and drop is mouse-only.
  document.addEventListener("keydown", (event) => {
    if (!event.altKey || store.selectedSlot === null) return
    const profile = activeProfile()
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -profile.columns, ArrowDown: profile.columns }
    const delta = deltas[event.key]
    if (delta === undefined) return
    const target = store.selectedSlot + delta
    if (target < 0 || target >= profile.rows * profile.columns) return
    event.preventDefault()
    moveButton(store.selectedSlot, target)
  })
}
