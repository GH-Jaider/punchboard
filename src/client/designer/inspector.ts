// The inspector: the selected button's settings, or the deck's own when
// nothing is selected. It is built once per selection and edits then update
// it in place, so focus and scroll position survive typing.
import { LIMITS } from "../../shared/actions.ts"
import { BUTTON_COLORS } from "../../shared/colors.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { DEFAULT_TRACKPAD, nextId, TRACKPAD_SPEED, withControl } from "../../shared/model.ts"
import type { Button, Profile } from "../../shared/types.ts"
import { applyTileColor, byId, el, svg } from "../common/dom.ts"
import { faderField } from "./fader-editor.ts"
import { deleteButton, duplicateButton, freeSlotCount, setGridSize } from "./grid.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { openIconPicker, readIcon } from "./icon-picker.ts"
import { activeProfile, library, replaceButton, selectedButton, store, touch } from "./state.ts"
import { renderSteps, stepsField } from "./steps.ts"
import { recordUndo } from "./undo.ts"

const inspectorEl = byId("inspector")

/** The first-run tips card is static HTML that moves into the deck panel
    while that is shown, and back out before the panel is rebuilt. */
function parkIntro(): void {
  const intro = document.getElementById("intro-card")
  const parking = document.getElementById("intro-parking")
  if (intro && parking && intro.parentElement !== parking) parking.appendChild(intro)
}

/** Switching Button ↔ Volume fader replaces the button object, then redraws. */
function setControl(button: Button, control: Button["control"]): void {
  if (button.control === control) return
  const next = withControl(button, control)
  replaceButton(button, next)
  touch()
  view.refreshTile(next)
  renderInspector()
}

export function renderInspector(): void {
  parkIntro()
  inspectorEl.innerHTML = ""
  const button = selectedButton()
  if (!button) return renderDeckPanel()

  const head = el("div", "panel-head")
  head.appendChild(el("h2", null, `Button ${button.slot + 1}`))
  head.appendChild(el("span", "spacer"))
  const closeButton = el("button", "icon-btn")
  closeButton.type = "button"
  closeButton.setAttribute("aria-label", "Deselect")
  closeButton.innerHTML = svg(UI_ICONS.x)
  closeButton.onclick = () => {
    store.selectedSlot = null
    view.renderGrid()
    renderInspector()
  }
  head.appendChild(closeButton)
  inspectorEl.appendChild(head)

  const body = el("div", "inspector-body")
  inspectorEl.appendChild(body)

  body.appendChild(labelField(button))
  body.appendChild(kindField(button))
  const iconTrigger = el("button", "icon-trigger")
  body.appendChild(colorField(button, iconTrigger))
  body.appendChild(iconField(button, iconTrigger))
  body.appendChild(button.control === "fader" ? faderField(button) : stepsField(button))
  body.appendChild(buttonActions(button))

  renderSteps(button)
}

// ---------------------------------------------------------------- deck

function renderDeckPanel(): void {
  const profile = activeProfile()

  const head = el("div", "panel-head")
  head.appendChild(el("h2", null, "Deck"))
  inspectorEl.appendChild(head)

  const body = el("div", "inspector-body")
  inspectorEl.appendChild(body)

  body.appendChild(byId("intro-card"))
  body.appendChild(nameField(profile))
  body.appendChild(deckTypeField(profile))
  if (profile.trackpad) {
    body.appendChild(trackpadFields(profile))
    body.appendChild(deckActions(profile))
    return
  }

  const size = el("div", "field")
  size.appendChild(el("span", "field-label", "Grid size"))
  const stat = el("p", "deck-stat")
  const refreshStat = (): void => {
    const count = profile.buttons.length
    const free = freeSlotCount(profile)
    stat.textContent = `${count}${count === 1 ? " button" : " buttons"} · ${free}${free === 1 ? " free slot" : " free slots"}`
  }
  size.appendChild(stepper("Columns", "columns", profile, refreshStat))
  size.appendChild(stepper("Rows", "rows", profile, refreshStat))
  size.appendChild(stat)
  refreshStat()
  body.appendChild(size)

  body.appendChild(deckActions(profile))
}

/** Buttons, or one big trackpad. A deck's buttons are kept while it is a trackpad. */
function deckTypeField(profile: Profile): HTMLElement {
  const field = el("div", "field")
  field.appendChild(el("span", "field-label", "Type"))
  const kinds = el("div", "segmented")
  kinds.setAttribute("role", "group")
  kinds.setAttribute("aria-label", "Deck type")
  const choices: ReadonlyArray<{ trackpad: boolean; text: string }> = [
    { trackpad: false, text: "Buttons" },
    { trackpad: true, text: "Trackpad" }
  ]
  for (const choice of choices) {
    const option = el("button", null, choice.text)
    option.type = "button"
    option.setAttribute("aria-pressed", String(Boolean(profile.trackpad) === choice.trackpad))
    option.onclick = () => {
      if (Boolean(profile.trackpad) === choice.trackpad) return
      if (choice.trackpad) profile.trackpad = { ...DEFAULT_TRACKPAD }
      else delete profile.trackpad
      store.selectedSlot = null
      touch()
      view.renderAll()
    }
    kinds.appendChild(option)
  }
  field.appendChild(kinds)
  field.appendChild(el("p", "field-help", profile.trackpad
    ? "The whole deck moves this computer's mouse. Its buttons are kept, in case you switch back."
    : "A grid of buttons and faders."))
  return field
}

function trackpadFields(profile: Profile): HTMLElement {
  const settings = profile.trackpad!
  const field = el("div", "field")

  const speedLabel = el("label", null, "Cursor speed")
  const speed = document.createElement("input")
  speed.type = "range"
  speed.min = String(TRACKPAD_SPEED.min)
  speed.max = String(TRACKPAD_SPEED.max)
  speed.step = "0.1"
  speed.value = String(settings.speed)
  speedLabel.htmlFor = speed.id = "trackpad-speed"
  speed.addEventListener("input", () => {
    settings.speed = Number(speed.value)
    touch()
  })
  field.appendChild(speedLabel)
  field.appendChild(speed)

  const natural = el("label", "steps-switch")
  const box = document.createElement("input")
  box.type = "checkbox"
  box.checked = settings.naturalScroll
  box.addEventListener("change", () => {
    settings.naturalScroll = box.checked
    touch()
  })
  natural.appendChild(box)
  const words = el("span")
  words.appendChild(el("strong", null, "Natural scrolling"))
  words.appendChild(el("span", "field-help", "The page follows your fingers, as on a Mac trackpad or a phone. Off: the classic mouse wheel direction."))
  natural.appendChild(words)
  field.appendChild(natural)

  const zoomLabel = el("label", null, "Pinch to zoom")
  const zoom = document.createElement("select")
  zoomLabel.htmlFor = zoom.id = "trackpad-zoom"
  zoom.add(new Option("Like a trackpad: maps, photos, pages zoom smoothly", "gesture"))
  zoom.add(new Option("Page zoom (⌘ + / ⌘ −), for apps that ignore it", "keys"))
  zoom.value = settings.pinchZoom
  zoom.addEventListener("change", () => {
    settings.pinchZoom = zoom.value === "keys" ? "keys" : "gesture"
    touch()
  })
  field.appendChild(zoomLabel)
  field.appendChild(zoom)

  const gestures = el("ul", "gesture-list")
  const rows: ReadonlyArray<[string, string]> = [
    ["One finger", "move the cursor"],
    ["Tap · two-finger tap", "click · right-click"],
    ["Tap, then touch and hold", "drag; lift to drop"],
    ["Two fingers", "scroll, with momentum"],
    ["Pinch", "zoom in or out"],
    ["Three fingers up · down", "Mission Control · App Exposé (Windows: Task View · desktop)"],
    ["Three fingers left · right", "next or previous desktop (Windows: switch apps)"],
    ["Three-finger tap", "Look Up (Windows: Search)"],
    ["Four fingers", "like three; spread for the desktop, pinch for your apps"]
  ]
  for (const row of rows) {
    const item = el("li")
    item.appendChild(el("strong", null, row[0]))
    item.appendChild(el("span", null, row[1]))
    gestures.appendChild(item)
  }
  field.appendChild(gestures)
  field.appendChild(el("p", "field-help", "On a Mac this uses the same Accessibility permission as key combinations."))
  return field
}

function nameField(profile: Profile): HTMLElement {
  const field = el("div", "field label-field")
  const label = el("label", null, "Name")
  label.htmlFor = "deck-name"
  const input = document.createElement("input")
  input.type = "text"
  input.id = "deck-name"
  input.value = profile.name
  input.placeholder = "Streaming"
  input.maxLength = 40
  input.autocomplete = "off"
  input.addEventListener("input", () => {
    profile.name = input.value.trim() || "Untitled deck"
    byId("profile-title").textContent = profile.name
    view.renderProfiles()
    touch()
  })
  field.appendChild(label)
  field.appendChild(input)
  return field
}

/** A −/+ control for one grid dimension, clamped to the deck's limits. */
function stepper(text: string, key: "columns" | "rows", profile: Profile, onChange: () => void): HTMLElement {
  const range = LIMITS[key]
  const row = el("div", "stepper-row")
  row.appendChild(el("span", "stepper-label", text))
  const group = el("div", "stepper")
  group.setAttribute("role", "group")
  group.setAttribute("aria-label", text)
  const value = el("output", "stepper-value", String(profile[key]))
  value.setAttribute("aria-live", "polite")
  const make = (delta: number, name: string): HTMLButtonElement => {
    const control = el("button", "icon-btn")
    control.type = "button"
    control.textContent = delta < 0 ? "−" : "+"
    control.setAttribute("aria-label", name)
    control.onclick = () => {
      setGridSize(key, profile[key] + delta)
      value.textContent = String(profile[key])
      less.disabled = profile[key] <= range.min
      more.disabled = profile[key] >= range.max
      onChange()
    }
    return control
  }
  const less = make(-1, `Fewer ${key}`)
  const more = make(1, `More ${key}`)
  less.disabled = profile[key] <= range.min
  more.disabled = profile[key] >= range.max
  group.appendChild(less)
  group.appendChild(value)
  group.appendChild(more)
  row.appendChild(group)
  return row
}

function deckActions(profile: Profile): HTMLElement {
  const row = el("div", "inspector-actions")
  const duplicate = el("button", "btn", "Duplicate deck")
  duplicate.type = "button"
  duplicate.onclick = () => duplicateProfile(profile)
  const remove = el("button", "btn danger-text", "Delete deck")
  remove.type = "button"
  remove.disabled = library().profiles.length < 2
  remove.title = remove.disabled ? "The last deck cannot be deleted" : ""
  remove.onclick = () => deleteProfile(profile)
  row.appendChild(duplicate)
  row.appendChild(remove)
  return row
}

/** A copy with fresh ids everywhere, so the two decks never share state. */
function duplicateProfile(profile: Profile): void {
  const loaded = library()
  const copy = JSON.parse(JSON.stringify(profile, (key, value: unknown) => (key === "open" ? undefined : value))) as Profile
  copy.id = nextId("profile")
  copy.name = `${profile.name} copy`
  copy.updatedAt = new Date().toISOString()
  for (const button of copy.buttons) {
    button.id = nextId("btn")
    for (const step of button.steps) step.id = nextId("step")
    for (const step of button.offSteps ?? []) step.id = nextId("step")
  }
  loaded.profiles.splice(loaded.profiles.indexOf(profile) + 1, 0, copy)
  store.activeId = copy.id
  store.selectedSlot = null
  touch()
  view.renderAll()
  toast(`Made “${copy.name}”.`)
}

/** Deletes straight away; the toast (and ⌘Z) puts the deck back where it was. */
function deleteProfile(profile: Profile): void {
  const loaded = library()
  const index = loaded.profiles.indexOf(profile)
  if (index === -1 || loaded.profiles.length < 2) return
  loaded.profiles.splice(index, 1)
  store.activeId = loaded.profiles[Math.min(index, loaded.profiles.length - 1)]!.id
  store.selectedSlot = null
  recordUndo("Deck deleted", () => {
    const current = library()
    current.profiles.splice(Math.min(index, current.profiles.length), 0, profile)
    store.activeId = profile.id
    store.selectedSlot = null
  })
  touch()
  view.renderAll()
}

// -------------------------------------------------------------- button

function labelField(button: Button): HTMLElement {
  const field = el("div", "field label-field")
  const label = el("label", null, "Label")
  label.htmlFor = "label-input"
  const input = document.createElement("input")
  input.type = "text"
  input.id = "label-input"
  input.value = button.label
  input.placeholder = "Go Live"
  input.maxLength = 28
  input.addEventListener("input", () => {
    button.label = input.value
    view.refreshTile(button)
    touch()
  })
  field.appendChild(label)
  field.appendChild(input)
  return field
}

function kindField(button: Button): HTMLElement {
  const field = el("div", "field")
  field.appendChild(el("span", "field-label", "Type"))
  const kinds = el("div", "segmented")
  kinds.setAttribute("role", "group")
  kinds.setAttribute("aria-label", "Button type")
  const choices: ReadonlyArray<{ control: Button["control"]; text: string }> = [
    { control: "press", text: "Button" },
    { control: "fader", text: "Volume fader" }
  ]
  for (const choice of choices) {
    const option = el("button", null, choice.text)
    option.type = "button"
    option.setAttribute("aria-pressed", String(button.control === choice.control))
    option.onclick = () => setControl(button, choice.control)
    kinds.appendChild(option)
  }
  field.appendChild(kinds)
  return field
}

function colorField(button: Button, iconTrigger: HTMLElement): HTMLElement {
  const field = el("div", "field")
  field.appendChild(el("span", "field-label", "Colour"))
  const swatches = el("div", "swatch-grid")
  for (const color of BUTTON_COLORS) {
    const swatch = el("button", "swatch")
    swatch.type = "button"
    swatch.style.background = color.value
    swatch.title = color.label
    swatch.setAttribute("aria-label", color.label)
    swatch.setAttribute("aria-pressed", String(color.id === button.color))
    swatch.onclick = () => {
      button.color = color.id
      swatches.querySelectorAll(".swatch").forEach((other) => other.setAttribute("aria-pressed", "false"))
      swatch.setAttribute("aria-pressed", "true")
      applyTileColor(iconTrigger, button.color)
      view.refreshTile(button)
      touch()
    }
    swatches.appendChild(swatch)
  }
  field.appendChild(swatches)
  return field
}

function iconField(button: Button, trigger: HTMLButtonElement): HTMLElement {
  const field = el("div", "field")
  field.appendChild(el("span", "field-label", "Icon"))
  trigger.type = "button"
  applyTileColor(trigger, button.color)
  const preview = el("span", "preview")
  preview.innerHTML = iconMarkup(button)
  const names = el("div", "names")
  names.appendChild(el("strong", null, button.iconData ? "Custom image" : button.glyph ? button.glyph.name.replace(/_/g, " ") : button.icon))
  names.appendChild(el("small", null, button.iconData
    ? "Tap to use an icon instead"
    : button.glyph ? `${button.glyph.style}${button.glyph.fill ? ", filled" : ""} · tap to change` : "Tap to choose an icon"))
  trigger.appendChild(preview)
  trigger.appendChild(names)
  trigger.onclick = () => openIconPicker(button)
  field.appendChild(trigger)

  // The custom upload sits under the icon it replaces.
  const upload = el("div", "upload-row")
  const fileInput = document.createElement("input")
  fileInput.type = "file"
  fileInput.id = "icon-file"
  fileInput.className = "visually-hidden"
  fileInput.accept = "image/png,image/jpeg,image/webp,image/svg+xml,.svg"
  const fileLabel = el("label", "btn", button.iconData ? "Replace image" : "Upload image")
  fileLabel.htmlFor = "icon-file"
  const fileName = el("span", "name", button.iconData ? "Custom image in use" : "PNG, JPG, WebP or SVG · max 750 KB")
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0]
    if (!file) return
    const data = await readIcon(file)
    if (!data) return
    button.iconData = data
    delete button.glyph
    touch()
    view.refreshTile(button)
    renderInspector()
    toast("Custom icon saved in this deck.")
  })
  upload.appendChild(fileInput)
  upload.appendChild(fileLabel)
  upload.appendChild(fileName)
  if (button.iconData) {
    const clear = el("button", "icon-btn danger")
    clear.type = "button"
    clear.setAttribute("aria-label", "Remove the custom image")
    clear.innerHTML = svg(UI_ICONS.x)
    clear.onclick = () => {
      button.iconData = null
      touch()
      view.refreshTile(button)
      renderInspector()
    }
    upload.appendChild(clear)
  }
  field.appendChild(upload)
  return field
}

function buttonActions(button: Button): HTMLElement {
  const row = el("div", "inspector-actions")
  const duplicate = el("button", "btn", "Duplicate")
  duplicate.type = "button"
  duplicate.onclick = () => duplicateButton(button)
  const remove = el("button", "btn danger-text", "Delete")
  remove.type = "button"
  remove.onclick = () => deleteButton(button)
  row.appendChild(duplicate)
  row.appendChild(remove)
  return row
}
