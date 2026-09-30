// The "Keys" field of a Key combination step: click it, press the keys, and
// the combination is recorded from the physical keys pressed.
import { stepSummary } from "../../shared/actions.ts"
import { KEY_NAMES, MODIFIERS, comboFromEvent, comboToString, formatCombo, isMacLike, modifierLabel, parseCombo } from "../../shared/keys.ts"
import type { Modifier } from "../../shared/keys.ts"
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
  field.appendChild(builder(step, record))
  field.appendChild(el("p", "field-help", "Goes to whatever is in front on this computer, so global hotkeys like OBS's work best. macOS asks for permission the first time."))
  show()
  return field
}

/** Modifier toggles and a key list, for combinations the browser never
    sees because the system takes them first (⌘⇧4 on a Mac, for one). */
function builder(step: HotkeyStep, record: (keys: string | undefined) => void): HTMLElement {
  const mac = isMacLike()
  const wrap = el("div")
  const toggle = el("button", "text-btn", "Can't press it here? Build it")
  toggle.type = "button"
  const panel = el("div", "key-builder")
  panel.hidden = true

  const mods = new Map<Modifier, HTMLButtonElement>()
  for (const modifier of MODIFIERS) {
    const button = el("button", "btn key-mod", modifierLabel(modifier, mac))
    button.type = "button"
    button.setAttribute("aria-pressed", "false")
    button.title = modifier === "meta" ? (mac ? "Command" : "Windows key") : modifier === "alt" ? (mac ? "Option" : "Alt") : modifier === "ctrl" ? "Control" : "Shift"
    button.onclick = () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"))
      compose()
    }
    mods.set(modifier, button)
    panel.appendChild(button)
  }
  const keySelect = el("select")
  keySelect.setAttribute("aria-label", "Key")
  keySelect.add(new Option("Key…", ""))
  for (const name of KEY_NAMES) keySelect.add(new Option(formatCombo(name, mac), name))
  keySelect.onchange = compose
  panel.appendChild(keySelect)

  function compose(): void {
    const key = keySelect.value
    if (!key) return
    const modifiers: Modifier[] = []
    for (const modifier of MODIFIERS) if (mods.get(modifier)?.getAttribute("aria-pressed") === "true") modifiers.push(modifier)
    record(comboToString({ modifiers, key }))
  }

  function sync(): void {
    const combo = parseCombo(step.keys)
    for (const modifier of MODIFIERS) mods.get(modifier)?.setAttribute("aria-pressed", String(Boolean(combo && combo.modifiers.indexOf(modifier) !== -1)))
    keySelect.value = combo ? combo.key : ""
  }

  toggle.onclick = () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) sync()
  }
  wrap.appendChild(toggle)
  wrap.appendChild(panel)
  return wrap
}
