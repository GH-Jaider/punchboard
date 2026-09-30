// The profile rail: listing decks, switching between them and adding one.
// Renaming, duplicating and deleting live in the inspector's deck panel.
import { createEmptyProfile } from "../../shared/model.ts"
import { byId, el } from "../common/dom.ts"
import { view } from "./hub.ts"
import { library, queueSave, store, touch } from "./state.ts"

export function renderProfiles(): void {
  const list = byId("profile-list")
  list.innerHTML = ""
  for (const profile of library().profiles) {
    const active = profile.id === store.activeId
    const row = el("button", `profile-row${active ? " active" : ""}`)
    row.type = "button"
    row.setAttribute("aria-pressed", String(active))
    row.appendChild(el("strong", null, profile.name))
    const count = profile.buttons.length
    row.appendChild(el("small", null, `${count}${count === 1 ? " button · " : " buttons · "}${profile.columns}×${profile.rows}`))
    row.onclick = () => {
      store.activeId = profile.id
      store.selectedSlot = null
      queueSave()
      view.renderAll()
    }
    list.appendChild(row)
  }
}

export function bindProfiles(): void {
  // A new deck appears at once, with its name ready to be typed over.
  byId("new-profile").addEventListener("click", () => {
    const profile = createEmptyProfile("New deck")
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
  })
}
