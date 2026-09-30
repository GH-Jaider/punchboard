// The profile rail: listing, switching, creating, renaming and deleting decks.
import { createEmptyProfile } from "../../shared/model.ts"
import { byId, el } from "../common/dom.ts"
import { ask, confirmAction } from "./dialogs.ts"
import { view } from "./hub.ts"
import { activeProfile, library, queueSave, store, touch } from "./state.ts"

export function renderProfiles(): void {
  const list = byId("profile-list")
  list.innerHTML = ""
  const loaded = library()
  for (const profile of loaded.profiles) {
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
  byId<HTMLButtonElement>("delete-profile").disabled = loaded.profiles.length < 2
}

export function bindProfiles(): void {
  byId("new-profile").addEventListener("click", async () => {
    const name = await ask({ title: "New profile", label: "Profile name", value: "", confirm: "Create" })
    if (!name) return
    const profile = createEmptyProfile(name)
    library().profiles.push(profile)
    store.activeId = profile.id
    store.selectedSlot = null
    touch()
    view.renderAll()
  })

  byId("rename-profile").addEventListener("click", async () => {
    const profile = activeProfile()
    const name = await ask({ title: "Rename profile", label: "Profile name", value: profile.name })
    if (!name) return
    profile.name = name
    touch()
    view.renderAll()
  })

  byId("delete-profile").addEventListener("click", async () => {
    const loaded = library()
    if (loaded.profiles.length < 2) return
    const profile = activeProfile()
    const yes = await confirmAction({
      title: `Delete “${profile.name}”?`,
      text: `Its ${profile.buttons.length} button(s) will be removed. This cannot be undone.`,
      confirm: "Delete profile"
    })
    if (!yes) return
    loaded.profiles = loaded.profiles.filter((item) => item.id !== profile.id)
    store.activeId = loaded.profiles[0]!.id
    store.selectedSlot = null
    touch()
    view.renderAll()
  })
}
