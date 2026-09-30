// Pickers for OBS names. With OBS connected, scenes, sources, audio inputs and
// filters are chosen from what OBS really has, so a typo can no longer break
// a button in the middle of a stream. Without OBS they fall back to typing.
import type { ObsPick } from "../../shared/actions.ts"
import type { ObsLink, ObsNames } from "../../shared/api.ts"
import { el } from "../common/dom.ts"
import { request } from "../common/http.ts"

/** How long a read of OBS's names is reused before asking again. */
const FRESH_MS = 5000

let names: ObsNames | null = null
let fetchedAt = 0
let loading: Promise<void> | null = null
let link: ObsLink | null = null
/** Every picker on screen redraws itself when new names arrive. */
const mounted = new Set<() => void>()

function redrawAll(): void {
  for (const redraw of [...mounted]) redraw()
}

function load(): void {
  if (loading || Date.now() - fetchedAt < FRESH_MS) return
  loading = request<ObsNames>("/api/obs/names")
    .then((next) => {
      const changed = JSON.stringify(next) !== JSON.stringify(names)
      names = next
      fetchedAt = Date.now()
      if (changed) redrawAll()
    })
    .catch(() => { fetchedAt = Date.now() })
    .then(() => { loading = null })
}

/** From every snapshot: OBS coming or going changes what can be picked. */
export function noteObsLink(status: ObsLink): void {
  if (status === link) return
  link = status
  fetchedAt = 0
  if (mounted.size) load()
}

export interface PickContext {
  sceneName?: string
  sourceName?: string
}

/** What a picker offers, or null when OBS is not there to ask. */
export function pickOptions(pick: ObsPick, context: PickContext): string[] | null {
  if (!names || !names.connected) return null
  switch (pick) {
    case "scene": return names.scenes
    case "sceneItem": return context.sceneName ? names.sceneItems[context.sceneName] ?? [] : []
    case "audioInput": return names.audioInputs
    case "filterSource": return Object.keys(names.filters)
    case "filter": return context.sourceName ? names.filters[context.sourceName] ?? [] : []
  }
}

const NEEDS: Partial<Record<ObsPick, string>> = { sceneItem: "Choose the scene first", filter: "Choose the source first" }
const EMPTY: Record<ObsPick, string> = {
  scene: "OBS has no scenes",
  sceneItem: "This scene has no sources",
  audioInput: "OBS has no audio inputs",
  filterSource: "No source in OBS has filters yet",
  filter: "This source has no filters"
}

export interface NameFieldOptions {
  id: string
  label: string
  placeholder: string
  pick: ObsPick
  value: () => string
  context: () => PickContext
  onChange: (value: string) => void
}

/** A labelled field: a list from OBS when it is connected, a text box when not. */
export function obsNameField(options: NameFieldOptions): HTMLElement {
  const field = el("div", "field")
  const label = el("label", null, options.label)
  field.appendChild(label)
  let control: HTMLElement | null = null
  let help: HTMLElement | null = null

  function draw(): void {
    // Never swap a control out from under someone using it.
    if (control && document.activeElement === control) return
    const list = pickOptions(options.pick, options.context())
    const value = options.value()
    let next: HTMLElement
    if (list === null) {
      const input = document.createElement("input")
      input.type = "text"
      input.spellcheck = false
      input.value = value
      input.placeholder = options.placeholder
      input.addEventListener("input", () => options.onChange(input.value))
      next = input
    } else {
      const select = document.createElement("select")
      const context = options.context()
      const waiting = (options.pick === "sceneItem" && !context.sceneName) || (options.pick === "filter" && !context.sourceName)
      select.add(new Option(waiting ? NEEDS[options.pick] ?? "Choose…" : list.length ? "Choose…" : EMPTY[options.pick], ""))
      for (const name of list) select.add(new Option(name, name))
      // A saved name OBS does not have (renamed, deleted, or OBS on another scene collection).
      if (value && list.indexOf(value) === -1) select.add(new Option(`${value} (not found in OBS)`, value))
      select.value = value
      select.disabled = waiting || (!list.length && !value)
      select.addEventListener("change", () => options.onChange(select.value))
      next = select
    }
    next.id = options.id
    label.htmlFor = options.id
    if (control) field.replaceChild(next, control)
    else field.appendChild(next)
    control = next

    const note = list === null ? "Connect OBS to choose from a list instead of typing the exact name." : ""
    if (note && !help) {
      help = el("p", "field-help", note)
      field.appendChild(help)
    } else if (!note && help) {
      field.removeChild(help)
      help = null
    }
  }

  const redraw = (): void => {
    if (!field.isConnected) {
      mounted.delete(redraw)
      return
    }
    draw()
  }
  mounted.add(redraw)
  draw()
  load()
  return field
}
