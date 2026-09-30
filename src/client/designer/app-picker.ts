// The "Application" field of a Launch an app step: a searchable list of what
// is installed on the computer, with a typed path as the fallback.
import { stepSummary } from "../../shared/actions.ts"
import type { AppEntry, AppsResponse } from "../../shared/api.ts"
import type { LaunchAppStep } from "../../shared/types.ts"
import { byId, el } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { toast } from "./hub.ts"
import { touch } from "./state.ts"

interface Target {
  step: LaunchAppStep
  title: HTMLElement
  trigger: HTMLElement
}

let apps: AppEntry[] | null = null
let target: Target | null = null

const dialog = (): HTMLDialogElement => byId<HTMLDialogElement>("dlg-apps")
const search = (): HTMLInputElement => byId<HTMLInputElement>("app-search")
const pathInput = (): HTMLInputElement => byId<HTMLInputElement>("app-path")

/** The name shown for a step: the picked app, or the last part of a typed path. */
function appLabel(step: LaunchAppStep): string {
  if (step.appName) return step.appName
  const file = (step.appPath ?? "").split(/[\\/]/).filter(Boolean).pop() ?? ""
  return file.replace(/\.(app|lnk|exe)$/i, "")
}

function fillTrigger(trigger: HTMLElement, step: LaunchAppStep): void {
  trigger.innerHTML = ""
  const name = appLabel(step)
  trigger.appendChild(el("strong", null, name || "Choose an application"))
  trigger.appendChild(el("small", null, step.appPath ? step.appPath : "Tap to pick one from this computer"))
}

export function appField(step: LaunchAppStep, title: HTMLElement): HTMLElement {
  const field = el("div", "field")
  field.appendChild(el("span", "field-label", "Application"))
  const trigger = el("button", "app-trigger")
  trigger.type = "button"
  fillTrigger(trigger, step)
  trigger.onclick = () => openAppPicker({ step, title, trigger })
  field.appendChild(trigger)
  return field
}

function choose(appPath: string, appName: string): void {
  if (!target) return
  target.step.appPath = appPath
  target.step.appName = appName
  target.title.textContent = stepSummary(target.step)
  fillTrigger(target.trigger, target.step)
  touch()
  dialog().close()
}

function draw(): void {
  const host = byId("app-list")
  host.innerHTML = ""
  if (!apps) {
    host.appendChild(el("p", "field-help", "Looking for applications…"))
    request<AppsResponse>("/api/apps").then((data) => {
      apps = data.apps
      if (dialog().open) draw()
    }).catch((error: unknown) => {
      host.innerHTML = ""
      host.appendChild(el("p", "field-help", errorMessage(error)))
    })
    return
  }
  const query = search().value.trim().toLowerCase()
  const matches = apps.filter((app) => !query || app.name.toLowerCase().includes(query))
  for (const app of matches) {
    const row = el("button", "app-row")
    row.type = "button"
    row.setAttribute("aria-pressed", String(app.path === target?.step.appPath))
    row.appendChild(el("strong", null, app.name))
    row.appendChild(el("small", null, app.path))
    row.onclick = () => choose(app.path, app.name)
    host.appendChild(row)
  }
  if (!matches.length) host.appendChild(el("p", "field-help", query ? `No application matches “${query}”.` : "No applications were found. Type a path below instead."))
}

function openAppPicker(next: Target): void {
  target = next
  search().value = ""
  pathInput().value = next.step.appPath ?? ""
  draw()
  dialog().showModal()
  search().focus()
}

export function bindAppPicker(): void {
  search().addEventListener("input", draw)
  byId("app-path-use").addEventListener("click", () => {
    const value = pathInput().value.trim()
    if (!value) return toast("Type the application's path first.", true)
    const file = value.split(/[\\/]/).filter(Boolean).pop() ?? value
    choose(value, file.replace(/\.(app|lnk|exe)$/i, ""))
  })
}
