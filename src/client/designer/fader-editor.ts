// The inspector section for a volume fader: what it controls, and which OBS input.
import { FADER_TARGETS, isFaderTarget } from "../../shared/actions.ts"
import type { FaderButton, FaderTarget } from "../../shared/types.ts"
import { el } from "../common/dom.ts"
import { view } from "./hub.ts"
import { obsNameField } from "./obs-names.ts"
import { touch } from "./state.ts"

const TARGETS = Object.keys(FADER_TARGETS) as FaderTarget[]

export function faderField(button: FaderButton): HTMLElement {
  const field = el("div", "field")
  const label = el("label", null, "Controls")
  const select = document.createElement("select")
  label.htmlFor = select.id = "fader-target"
  for (const target of TARGETS) select.add(new Option(FADER_TARGETS[target].label, target, false, target === button.fader.target))
  select.addEventListener("change", () => {
    if (!isFaderTarget(select.value)) return
    button.fader.target = select.value
    touch()
    view.refreshTile(button)
    view.renderInspector()
  })
  field.appendChild(label)
  field.appendChild(select)
  field.appendChild(el("p", "field-help", FADER_TARGETS[button.fader.target].hint))

  if (button.fader.target === "obs_input") {
    field.appendChild(obsNameField({
      id: "fader-input",
      label: "Audio input",
      placeholder: "Exact OBS input name, e.g. Mic/Aux",
      pick: "audioInput",
      value: () => button.fader.inputName,
      context: () => ({}),
      onChange: (value) => {
        button.fader.inputName = value
        touch()
        view.refreshTile(button)
      }
    }))
  }
  field.appendChild(el("p", "inline-note", "On the deck, drag up or down anywhere on the tile to change the level."))
  return field
}
