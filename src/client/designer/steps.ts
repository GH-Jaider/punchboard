// The macro editor: a button's steps, each with its action, fields and delay.
// It re-renders on its own, so editing a macro never disturbs the fields above.
import { ACTION_FIELDS, ACTION_GROUPS, ACTION_META, ACTION_TYPES, isActionType, LIMITS, stepSummary, stepText } from "../../shared/actions.ts"
import { clampDelay, createStep, retypeStep } from "../../shared/model.ts"
import type { Button, SoundStep, Step, StepTextField } from "../../shared/types.ts"
import { el, svg } from "../common/dom.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { audioFilePicker, playSlot, soundSlotLabel, uploadSound } from "./sounds.ts"
import { touch } from "./state.ts"
import { recordUndo } from "./undo.ts"
import { keysField } from "./key-recorder.ts"

const STEPS_HOST_ID = "steps-host"

/** Sets a text field only on step types that have it, per ACTION_FIELDS. */
function setStepText(step: Step, key: StepTextField, value: string): void {
  if (!ACTION_FIELDS[step.type]?.some((spec) => spec.key === key)) return
  ;(step as Partial<Record<StepTextField, string>>)[key] = value
}

function swapSteps(button: Button, a: number, b: number): void {
  const first = button.steps[a]
  const second = button.steps[b]
  if (!first || !second) return
  button.steps[a] = second
  button.steps[b] = first
  touch()
  renderSteps(button)
}

/** The macro section of the inspector: heading, step list host and add button. */
export function stepsField(button: Button): HTMLElement {
  const field = el("div", "field")
  const head = el("div")
  head.style.cssText = "display:flex;align-items:center;gap:8px"
  head.appendChild(el("span", "field-label", "What it does"))
  const spacer = el("span")
  spacer.style.flex = "1 1 auto"
  head.appendChild(spacer)
  head.appendChild(el("span", "subtle", button.steps.length > 1 ? `${button.steps.length} steps, in order` : ""))
  field.appendChild(head)

  const host = el("div", "steps")
  host.id = STEPS_HOST_ID
  field.appendChild(host)

  const add = el("button", "step-add")
  add.type = "button"
  add.innerHTML = `${svg(UI_ICONS.plus, 14)}<span>Add another step</span>`
  add.onclick = () => {
    if (button.steps.length >= LIMITS.maxSteps) return toast(`A macro can hold at most ${LIMITS.maxSteps} steps.`)
    button.steps.push(createStep("none"))
    touch()
    view.refreshTile(button)
    renderSteps(button)
  }
  field.appendChild(add)
  return field
}

export function renderSteps(button: Button): void {
  const host = document.getElementById(STEPS_HOST_ID)
  if (!host) return
  host.innerHTML = ""
  button.steps.forEach((step, index) => host.appendChild(stepCard(button, step, index)))
}

function stepCard(button: Button, step: Step, index: number): HTMLElement {
  const card = el("div", `step${step.open ? " is-open" : ""}`)

  const head = el("button", "step-head")
  head.type = "button"
  head.setAttribute("aria-expanded", String(Boolean(step.open)))
  head.appendChild(el("span", "step-index", String(index + 1)))
  const title = el("span", `step-title${step.type === "none" ? " none" : ""}`, stepSummary(step))
  head.appendChild(title)
  if (step.delayMs) head.appendChild(el("span", "step-delay-tag", `+${step.delayMs}ms`))
  head.onclick = () => {
    step.open = !step.open
    renderSteps(button)
  }
  card.appendChild(head)

  const body = el("div", "step-body")
  body.hidden = !step.open

  // Action picker, grouped, with a plain-language hint.
  const typeField = el("div", "field")
  const typeLabel = el("label", null, "Action")
  const select = document.createElement("select")
  typeLabel.htmlFor = select.id = `step-type-${step.id}`
  for (const groupName of ACTION_GROUPS) {
    const group = document.createElement("optgroup")
    group.label = groupName
    for (const type of ACTION_TYPES) {
      if (ACTION_META[type].group === groupName) group.appendChild(new Option(ACTION_META[type].label, type, false, type === step.type))
    }
    if (group.children.length) select.appendChild(group)
  }
  select.addEventListener("change", () => {
    if (!isActionType(select.value)) return
    // Keeps the id, delay and open state; drops fields that no longer apply.
    const next = retypeStep(step, select.value)
    next.open = step.open
    button.steps[index] = next
    touch()
    view.refreshTile(button)
    renderSteps(button)
  })
  typeField.appendChild(typeLabel)
  typeField.appendChild(select)
  typeField.appendChild(el("p", "field-help", ACTION_META[step.type].hint))
  body.appendChild(typeField)

  if (step.type === "hotkey") body.appendChild(keysField(step, title))

  // The fields this action needs, from one table.
  for (const spec of ACTION_FIELDS[step.type] ?? []) {
    const field = el("div", "field")
    const label = el("label", null, spec.label)
    const input = document.createElement("input")
    input.type = "text"
    input.spellcheck = false
    label.htmlFor = input.id = `step-${spec.key}-${step.id}`
    input.value = stepText(step, spec.key) ?? ""
    input.placeholder = spec.placeholder
    input.addEventListener("input", () => {
      setStepText(step, spec.key, input.value)
      title.textContent = stepSummary(step)
      touch()
    })
    field.appendChild(label)
    field.appendChild(input)
    body.appendChild(field)
  }

  if (step.type === "play_sound") body.appendChild(soundField(step, title))

  // The per-step delay is what makes a list of actions a macro.
  const delayField = el("div", "field")
  const delayLabel = el("label", null, index === 0 ? "Wait before this step" : "Wait after the previous step")
  const delayInput = document.createElement("input")
  delayInput.type = "number"
  delayInput.min = "0"
  delayInput.max = String(LIMITS.maxDelayMs)
  delayInput.step = "50"
  delayLabel.htmlFor = delayInput.id = `step-delay-${step.id}`
  delayInput.value = String(step.delayMs || 0)
  delayInput.addEventListener("input", () => {
    step.delayMs = clampDelay(delayInput.value)
    touch()
  })
  delayField.appendChild(delayLabel)
  delayField.appendChild(delayInput)
  delayField.appendChild(el("p", "field-help", "Milliseconds. 0 fires immediately."))
  body.appendChild(delayField)

  if (button.steps.length > 1) body.appendChild(reorderRow(button, index))

  card.appendChild(body)
  return card
}

function reorderRow(button: Button, index: number): HTMLElement {
  const row = el("div")
  row.style.cssText = "display:flex;gap:8px;align-items:center"
  const up = el("button", "icon-btn")
  up.type = "button"
  up.innerHTML = svg(UI_ICONS.up)
  up.setAttribute("aria-label", "Move this step earlier")
  up.disabled = index === 0
  up.onclick = () => swapSteps(button, index, index - 1)
  const down = el("button", "icon-btn")
  down.type = "button"
  down.innerHTML = svg(UI_ICONS.down)
  down.setAttribute("aria-label", "Move this step later")
  down.disabled = index === button.steps.length - 1
  down.onclick = () => swapSteps(button, index, index + 1)
  const grow = el("span")
  grow.style.flex = "1 1 auto"
  const drop = el("button", "btn ghost danger-text", "Remove step")
  drop.type = "button"
  drop.onclick = () => {
    const removed = button.steps.splice(index, 1)[0]
    if (!removed) return
    recordUndo("Step removed", () => {
      button.steps.splice(Math.min(index, button.steps.length), 0, removed)
    })
    touch()
    view.refreshTile(button)
    view.renderInspector()
  }
  row.appendChild(up)
  row.appendChild(down)
  row.appendChild(grow)
  row.appendChild(drop)
  return row
}

function soundField(step: SoundStep, title: HTMLElement): HTMLElement {
  const field = el("div", "field")
  const label = el("label", null, "Sound slot")
  const row = el("div")
  row.style.cssText = "display:flex;gap:8px;align-items:center"

  const select = document.createElement("select")
  label.htmlFor = select.id = `step-sound-${step.id}`
  for (let slot = 1; slot <= LIMITS.soundSlots; slot += 1) select.add(new Option(soundSlotLabel(slot), String(slot)))
  select.value = String(step.soundId ?? 1)
  select.addEventListener("change", () => {
    step.soundId = Number(select.value)
    title.textContent = stepSummary(step)
    touch()
  })
  row.appendChild(select)

  const preview = el("button", "icon-btn")
  preview.type = "button"
  preview.innerHTML = svg(UI_ICONS.play)
  preview.title = "Preview on this computer"
  preview.setAttribute("aria-label", "Preview this sound")
  preview.onclick = () => playSlot(Number(select.value), preview)
  row.appendChild(preview)

  // Uploads straight into the slot this step uses.
  const upload = audioFilePicker(`step-sound-file-${step.id}`, "Replace this slot with a WAV or MP3", (file) => void uploadSound(Number(select.value), file, null))
  row.appendChild(upload.input)
  row.appendChild(upload.label)

  field.appendChild(label)
  field.appendChild(row)
  field.appendChild(el("p", "field-help", "WAV or MP3, up to 8 MB. Plays through this computer's speakers — the tablet never downloads the file."))
  return field
}
