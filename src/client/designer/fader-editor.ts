// The inspector section for a volume fader: what it controls, and which OBS
// input or which app.
import { FADER_TARGETS, isFaderTarget } from "../../shared/actions.ts"
import type { AudioApp, AudioAppsResponse } from "../../shared/api.ts"
import { t } from "../../shared/i18n.ts"
import { appDisplayName, normalizeAppKey } from "../../shared/model.ts"
import type { FaderButton, FaderTarget } from "../../shared/types.ts"
import { el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast, view } from "./hub.ts"
import { obsNameField } from "./obs-names.ts"
import { touch } from "./state.ts"

const TARGETS = Object.keys(FADER_TARGETS) as FaderTarget[]

export function faderField(button: FaderButton): HTMLElement {
  const field = el("div", "field")
  const label = el("label", null, t("designer.fader.controls"))
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
  // The app fader's help depends on the system, and comes with its picker.
  if (button.fader.target !== "app") field.appendChild(el("p", "field-help", FADER_TARGETS[button.fader.target].hint))

  if (button.fader.target === "obs_input") {
    field.appendChild(obsNameField({
      id: "fader-input",
      label: t("designer.fader.audioInput"),
      placeholder: t("designer.fader.audioInputPlaceholder"),
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
  if (button.fader.target === "app") field.appendChild(appField(button))
  field.appendChild(el("p", "inline-note", t("designer.fader.dragHint")))
  return field
}

// ------------------------------------------------------------- app volume

/** How long a list of apps is reused before the picker asks again by itself. */
const FRESH_MS = 5000

let audio: AudioAppsResponse | null = null
let fetchedAt = 0
let loading: Promise<AudioAppsResponse> | null = null

function loadApps(force: boolean): Promise<AudioAppsResponse> {
  if (loading) return loading
  if (audio && !force && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve(audio)
  loading = request<AudioAppsResponse>("/api/apps/audio")
    .then((next) => {
      audio = next
      fetchedAt = Date.now()
      return next
    })
    .then((next) => {
      loading = null
      return next
    }, (error: unknown) => {
      loading = null
      throw error
    })
  return loading
}

/** What can be offered on the companion's system, or null where nothing can. */
function platformHelp(platform: string): string | null {
  if (platform === "win32") return t("designer.fader.helpWindows")
  if (platform === "darwin") return t("designer.fader.helpMac")
  return null
}

/** Points the fader at an app, and names the button after it while the
    label is empty or still the previous app's name. */
function chooseApp(button: FaderButton, key: string, name: string): void {
  const previous = button.fader.app ? appDisplayName(button.fader) : ""
  button.fader.app = key
  button.fader.appName = name
  if (!button.label.trim() || button.label === previous) {
    button.label = name.slice(0, 28)
    const input = document.getElementById("label-input")
    if (input instanceof HTMLInputElement) input.value = button.label
  }
  touch()
  view.refreshTile(button)
}

function appField(button: FaderButton): HTMLElement {
  const field = el("div", "field")
  const label = el("label", null, t("designer.fader.app"))
  const row = el("div", "app-volume-row")
  const select = document.createElement("select")
  label.htmlFor = select.id = "fader-app"
  const refresh = el("button", "btn", t("designer.fader.refresh"))
  refresh.type = "button"
  row.appendChild(select)
  row.appendChild(refresh)
  field.appendChild(label)
  field.appendChild(row)
  const help = el("p", "field-help", t("designer.fader.lookingForApps"))
  field.appendChild(help)
  // Typing a process name is for Windows, where any app can be controlled.
  const typed = el("div", "app-volume-row")
  typed.hidden = true
  const typedInput = document.createElement("input")
  typedInput.type = "text"
  typedInput.id = "fader-app-typed"
  typedInput.spellcheck = false
  typedInput.autocomplete = "off"
  typedInput.placeholder = t("designer.fader.processPlaceholder")
  typedInput.setAttribute("aria-label", t("designer.fader.processName"))
  const use = el("button", "btn", t("designer.fader.use"))
  use.type = "button"
  typed.appendChild(typedInput)
  typed.appendChild(use)
  field.appendChild(typed)

  /** The options: what the companion found, then the saved app if it is not among them. */
  function draw(list: AudioApp[] | null): void {
    select.innerHTML = ""
    const saved = button.fader.app
    const apps = list ?? []
    select.add(new Option(list === null ? t("designer.fader.lookingForApps") : apps.length ? t("designer.fader.chooseApp") : t("designer.fader.noApp"), ""))
    for (const app of apps) select.add(new Option(app.running ? app.name : t("designer.fader.notRunning", { name: app.name }), app.key))
    if (saved && !apps.some((app) => app.key === saved)) select.add(new Option(t("designer.fader.notRunning", { name: appDisplayName(button.fader) }), saved))
    select.value = saved ?? ""
  }

  function show(response: AudioAppsResponse): void {
    draw(response.apps)
    help.textContent = platformHelp(response.platform) ?? response.note ?? ""
    // A note that adds something, like "No app is playing sound right now."
    if (response.note && response.note !== help.textContent) help.textContent += ` ${response.note}`
    typed.hidden = response.platform !== "win32"
    select.disabled = response.platform !== "win32" && response.platform !== "darwin"
  }

  function load(force: boolean): void {
    if (force) refresh.disabled = true
    loadApps(force).then((response) => {
      refresh.disabled = false
      show(response)
    }, (error: unknown) => {
      refresh.disabled = false
      draw([])
      help.textContent = errorMessage(error)
    })
  }

  select.addEventListener("change", () => {
    const key = select.value
    if (!key) return
    const found = (audio ? audio.apps : []).filter((app) => app.key === key)[0]
    chooseApp(button, key, found ? found.name : appDisplayName(button.fader))
  })
  refresh.addEventListener("click", () => load(true))
  const useTyped = (): void => {
    const key = normalizeAppKey(typedInput.value)
    if (!key) {
      toast(t("designer.fader.typeProcess"), true)
      return
    }
    const found = (audio ? audio.apps : []).filter((app) => app.key === key)[0]
    // A typed name is shown as typed, with a capital, until the app is seen.
    chooseApp(button, key, found ? found.name : key.charAt(0).toUpperCase() + key.slice(1))
    typedInput.value = ""
    draw(audio ? audio.apps : [])
  }
  use.addEventListener("click", useTyped)
  typedInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault()
      useTyped()
    }
  })

  if (audio) show(audio)
  else draw(null)
  load(false)
  return field
}
