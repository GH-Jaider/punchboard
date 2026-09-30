// The "Keys" field of a Key combination step: click it, press the keys, and
// the combination is recorded from the physical keys pressed.
import { stepSummary } from "../../shared/actions.ts"
import { comboFromEvent, formatCombo, isMacLike } from "../../shared/keys.ts"
import type { HotkeyStep } from "../../shared/types.ts"
import { el, svg } from "../common/dom.ts"
import { UI_ICONS } from "./hub.ts"
import { touch } from "./state.ts"

const IDLE_HINT = "Click here, then press the keys"
const RECORDING_HINT = "Press the keys…"

/** Builds the field; `title` is the step's collapsed heading, kept in step. */
export function keysField(step: HotkeyStep, title: HTMLElement): HTMLElement {
  const field = el("div", "field")
  const label = el("label", null, "Keys")
  const row = el("div", "key-recorder")

  const input = el("input", "key-recorder-input")
  input.type = "text"
  input.readOnly = true
  input.autocomplete = "off"
  input.spellcheck = false
  label.htmlFor = input.id = `step-keys-${step.id}`

  const clear = el("button", "icon-btn")
  clear.type = "button"
  clear.innerHTML = svg(UI_ICONS.x)
  clear.title = "Clear"
  clear.setAttribute("aria-label", "Clear the key combination")

  const show = (): void => {
    const text = formatCombo(step.keys, isMacLike())
    input.value = text
    input.placeholder = document.activeElement === input ? RECORDING_HINT : IDLE_HINT
    clear.hidden = !text
  }

  const record = (keys: string | undefined): void => {
    step.keys = keys
    title.textContent = stepSummary(step)
    show()
    touch()
  }

  input.addEventListener("focus", () => { row.classList.add("is-recording"); show() })
  input.addEventListener("blur", () => { row.classList.remove("is-recording"); show() })
  input.addEventListener("keydown", (event) => {
    event.preventDefault()
    const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    // Bare Escape leaves the field and bare Backspace clears it; with a
    // modifier held they are keys like any other.
    if (bare && event.code === "Escape") return input.blur()
    if (bare && (event.code === "Backspace" || event.code === "Delete")) return record(undefined)
    const combo = comboFromEvent(event)
    if (combo) record(combo)
  })
  clear.addEventListener("click", () => { record(undefined); input.focus() })

  row.appendChild(input)
  row.appendChild(clear)
  field.appendChild(label)
  field.appendChild(row)
  field.appendChild(el("p", "field-help", "Goes to whatever is in front on this computer, so global hotkeys like OBS's work best. macOS asks for permission the first time."))
  show()
  return field
}
