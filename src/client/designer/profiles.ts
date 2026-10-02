// The profile rail: listing decks, switching between them, putting them in
// order (drag, or Alt+arrows), showing or hiding them on devices (the eye) and
// adding one, empty or ready-made. Devices show the tabs in this order.
// Renaming, duplicating and deleting live in the inspector's deck panel.
import { isMacLike } from "../../shared/keys.ts"
import { createEmptyProfile } from "../../shared/model.ts"
import { STARTER_IDS, STARTERS, starterDeck } from "../../shared/starter-decks.ts"
import type { Profile } from "../../shared/types.ts"
import { byId, el } from "../common/dom.ts"
import { view } from "./hub.ts"
import { library, queueSave, store, touch } from "./state.ts"

const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-2.2 3.1M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>'

/** The eye on a deck's row: a hidden deck is kept here but gets no tab on
    devices; a Go to another deck button can still open it, like a folder. */
function eyeButton(profile: Profile): HTMLButtonElement {
  const eye = el("button", "profile-eye")
  eye.type = "button"
  eye.innerHTML = profile.hidden ? EYE_OFF : EYE
  const tip = profile.hidden
    ? `${profile.name} is hidden on devices. A Go to another deck button can still open it. Click to show it.`
    : `${profile.name} is shown on devices. Click to hide it there (it is kept here).`
  eye.title = tip
  eye.setAttribute("aria-label", profile.hidden ? `Show ${profile.name} on devices` : `Hide ${profile.name} on devices`)
  eye.setAttribute("aria-pressed", String(!profile.hidden))
  eye.onclick = () => {
    if (profile.hidden) delete profile.hidden
    else profile.hidden = true
    touch()
    renderProfiles()
    // Keep focus on this deck's eye, now redrawn.
    const items = byId("profile-list").querySelectorAll<HTMLElement>(".profile-item")
    for (let i = 0; i < items.length; i++) {
      const again = items[i]
      if (again && again.getAttribute("data-id") === profile.id) {
        const button = again.querySelector<HTMLElement>(".profile-eye")
        if (button) button.focus()
      }
    }
  }
  return eye
}

/** The deck being dragged, by its place in the list. */
let dragFrom: number | null = null

function clearDropMarks(): void {
  const marked = byId("profile-list").querySelectorAll(".drop-before, .drop-after")
  for (let i = 0; i < marked.length; i++) {
    const item = marked[i]
    if (item) item.classList.remove("drop-before", "drop-after")
  }
}

/** Moves the deck at `from` so it ends up at `to`, and keeps focus on it. */
function moveDeck(from: number, to: number): void {
  const profiles = library().profiles
  if (from === to || to < 0 || to >= profiles.length) return
  const moved = profiles.splice(from, 1)[0]
  if (!moved) return
  profiles.splice(to, 0, moved)
  touch()
  renderProfiles()
  const row = byId("profile-list").querySelectorAll<HTMLElement>(".profile-row")[to]
  if (row) row.focus()
}

/** Dropped on the top half of a row, the deck goes before it; bottom half, after. */
function dropsAfter(item: HTMLElement, event: DragEvent): boolean {
  const box = item.getBoundingClientRect()
  return event.clientY > box.top + box.height / 2
}

export function renderProfiles(): void {
  const list = byId("profile-list")
  list.innerHTML = ""
  library().profiles.forEach((profile, index) => {
    const active = profile.id === store.activeId
    const item = el("div", `profile-item${profile.hidden ? " is-hidden" : ""}`)
    item.setAttribute("data-id", profile.id)
    const row = el("button", `profile-row${active ? " active" : ""}${profile.hidden ? " is-hidden" : ""}`)
    row.type = "button"
    row.setAttribute("aria-pressed", String(active))
    row.appendChild(el("strong", null, profile.name))
    const count = profile.buttons.length
    const detail = profile.trackpad ? "Trackpad" : `${count}${count === 1 ? " button · " : " buttons · "}${profile.columns}×${profile.rows}`
    row.appendChild(el("small", null, profile.hidden ? `Hidden · ${detail}` : detail))
    row.onclick = () => {
      store.activeId = profile.id
      store.selectedSlot = null
      queueSave()
      view.renderAll()
    }
    // Alt+arrows: the keyboard way to reorder, as Alt+arrows moves buttons.
    row.addEventListener("keydown", (event) => {
      if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
      event.preventDefault()
      event.stopPropagation()
      moveDeck(index, index + (event.key === "ArrowUp" ? -1 : 1))
    })

    item.draggable = true
    item.addEventListener("dragstart", (event) => {
      dragFrom = index
      item.classList.add("dragging")
      if (!event.dataTransfer) return
      event.dataTransfer.effectAllowed = "move"
      // Firefox refuses to start a drag without a payload.
      try { event.dataTransfer.setData("text/plain", profile.name) } catch { /* ignored */ }
    })
    item.addEventListener("dragend", () => {
      dragFrom = null
      item.classList.remove("dragging")
      clearDropMarks()
    })
    item.addEventListener("dragover", (event) => {
      if (dragFrom === null) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      const after = dropsAfter(item, event)
      clearDropMarks()
      if (index !== dragFrom) item.classList.add(after ? "drop-after" : "drop-before")
    })
    item.addEventListener("drop", (event) => {
      event.preventDefault()
      clearDropMarks()
      if (dragFrom === null) return
      const from = dragFrom
      dragFrom = null
      let to = dropsAfter(item, event) ? index + 1 : index
      // Taking the deck out first shifts everything after it up by one.
      if (from < to) to -= 1
      moveDeck(from, to)
    })

    item.appendChild(row)
    item.appendChild(eyeButton(profile))
    list.appendChild(item)
  })
}

/** Adds a deck and shows it, with its name ready to be typed over. */
function addDeck(profile: Profile): void {
  library().profiles.push(profile)
  store.activeId = profile.id
  store.selectedSlot = null
  touch()
  view.renderAll()
  const name = document.getElementById("deck-name")
  if (name instanceof HTMLInputElement) {
    name.focus()
    name.select()
  }
}

let menu: HTMLElement | null = null

function closeMenu(): void {
  if (!menu) return
  menu.remove()
  menu = null
  byId("new-profile").setAttribute("aria-expanded", "false")
}

/** + offers an empty deck or one of the ready-made ones. */
function openMenu(anchor: HTMLElement): void {
  const list = el("div", "add-menu")
  list.setAttribute("role", "menu")
  const option = (title: string, hint: string, make: () => Profile): void => {
    const item = el("button", "add-menu-item")
    item.type = "button"
    item.setAttribute("role", "menuitem")
    item.appendChild(el("strong", null, title))
    item.appendChild(el("span", null, hint))
    item.onclick = () => {
      closeMenu()
      addDeck(make())
    }
    list.appendChild(item)
  }
  option("Empty deck", "Start from nothing", () => createEmptyProfile("New deck"))
  for (const id of STARTER_IDS) option(STARTERS[id].label, STARTERS[id].hint, () => starterDeck(id, isMacLike()))
  const box = anchor.getBoundingClientRect()
  list.style.top = `${Math.round(box.bottom + 6)}px`
  list.style.left = `${Math.round(box.left)}px`
  document.body.appendChild(list)
  menu = list
  anchor.setAttribute("aria-expanded", "true")
  const first = list.querySelector("button")
  if (first) first.focus()
}

export function bindProfiles(): void {
  const button = byId("new-profile")
  button.setAttribute("aria-haspopup", "menu")
  button.addEventListener("click", (event) => {
    event.stopPropagation()
    if (menu) closeMenu()
    else openMenu(button)
  })
  document.addEventListener("click", (event) => {
    if (menu && !menu.contains(event.target as Node)) closeMenu()
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu()
  })
}
