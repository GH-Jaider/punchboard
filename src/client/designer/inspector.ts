// The inspector for the selected button. It is built once per selection and
// edits then update it in place, so focus and scroll position survive typing.
import { BUTTON_COLORS } from "../../shared/colors.ts"
import { iconMarkup } from "../../shared/icons.ts"
import { withControl } from "../../shared/model.ts"
import type { Button } from "../../shared/types.ts"
import { applyTileColor, byId, el, svg } from "../common/dom.ts"
import { confirmAction } from "./dialogs.ts"
import { faderField } from "./fader-editor.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { openIconPicker, readIcon } from "./icon-picker.ts"
import { activeProfile, replaceButton, selectedButton, store, touch } from "./state.ts"
import { renderSteps, stepsField } from "./steps.ts"

const inspectorEl = byId("inspector")

function renderEmpty(): void {
  const empty = el("div", "empty-inspector")
  empty.innerHTML = `<div class="big">${svg(UI_ICONS.grid, 28)}</div><div><strong>Nothing selected</strong></div>`
  empty.appendChild(el("div", "subtle", "Click a tile to edit it, or a dashed slot to add one."))
  inspectorEl.appendChild(empty)
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
  inspectorEl.innerHTML = ""
  const button = selectedButton()
  if (!button) return renderEmpty()

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
  body.appendChild(deleteZone(button))

  renderSteps(button)
}

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

function deleteZone(button: Button): HTMLElement {
  const zone = el("div", "danger-zone")
  const remove = el("button", "btn danger wide", "Delete this button")
  remove.type = "button"
  remove.onclick = async () => {
    const yes = await confirmAction({
      title: "Delete this button?",
      text: `“${button.label || "Untitled"}” will be removed from ${activeProfile().name}.`,
      confirm: "Delete button"
    })
    if (!yes) return
    const profile = activeProfile()
    profile.buttons = profile.buttons.filter((item) => item.id !== button.id)
    store.selectedSlot = null
    touch()
    view.renderAll()
  }
  zone.appendChild(remove)
  return zone
}
