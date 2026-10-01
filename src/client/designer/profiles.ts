// The profile rail: listing decks, switching between them and adding one,
// empty or ready-made. Renaming, duplicating and deleting live in the
// inspector's deck panel.
import { isMacLike } from "../../shared/keys.ts"
import { createEmptyProfile } from "../../shared/model.ts"
import { STARTER_IDS, STARTERS, starterDeck } from "../../shared/starter-decks.ts"
import type { Profile } from "../../shared/types.ts"
import { byId, el } from "../common/dom.ts"
import { view } from "./hub.ts"
import { library, queueSave, store, touch } from "./state.ts"

export function renderProfiles(): void {
  const list = byId("profile-list")
  list.innerHTML = ""
  for (const profile of library().profiles) {
    const active = profile.id === store.activeId
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
    list.appendChild(row)
  }
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
