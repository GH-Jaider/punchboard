// The eight sound slots: listing, previewing, replacing and restoring them.
import { LIMITS } from "../../shared/actions.ts"
import type { Ok, SoundsChanged, SoundSlot, SoundsResponse } from "../../shared/api.ts"
import { byId, el, svg } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { confirmAction } from "./dialogs.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { selectedButton } from "./state.ts"

let slots: SoundSlot[] = []
/** Slots the companion is playing right now, from the live state. */
let playingNow: number[] = []

/** Labels say whether a slot holds your file or the shipped tone. */
export function soundSlotLabel(slot: number): string {
  const info = slots.find((item) => item.slot === slot)
  if (!info) return `Sound ${slot}`
  return `Sound ${slot}${info.custom ? ` · ${info.name || "your file"}` : " · built-in tone"}`
}

/** "0:26" for a track, "0.4 s" for a short tone that would otherwise show as 0:00. */
export function formatDuration(ms: number): string {
  if (ms < 10000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function prettyBytes(bytes: number): string {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export async function loadSounds(): Promise<void> {
  try {
    const data = await request<SoundsResponse>("/api/sounds")
    slots = data.slots
    renderSoundList()
    const custom = slots.filter((slot) => slot.custom).length
    const chip = byId("sounds-state")
    chip.textContent = custom ? `${custom} custom` : "Built-in"
    chip.title = custom ? `${custom} of the ${LIMITS.soundSlots} slots hold your own sounds` : `All ${LIMITS.soundSlots} slots hold the built-in tones`
    chip.className = `state-chip ${custom ? "ready" : "warning"}`
  } catch {
    // The panel simply stays empty.
  }
}

function slotsChanged(next: SoundSlot[]): void {
  slots = next
  renderSoundList()
  void loadSounds()
  // Keeps the step editor's slot labels in step with the new name.
  const button = selectedButton()
  if (button) view.renderSteps(button)
}

// ---------------------------------------------------------------- previews

/** A preview plays through the companion, exactly like a deck press; a
    second click stops it. The button's icon follows the live state. */
export function playSlot(slot: number): void {
  request<Ok>(`/api/sounds/${slot}/preview`, { method: "POST" }).catch((error: unknown) => toast(errorMessage(error), true))
}

export function showPlaying(playing: number[]): void {
  playingNow = playing
  const buttons = byId("sound-list").querySelectorAll<HTMLElement>("[data-preview-slot]")
  for (let i = 0; i < buttons.length; i += 1) {
    const button = buttons[i]
    if (!button) continue
    const on = playing.indexOf(Number(button.getAttribute("data-preview-slot"))) !== -1
    button.innerHTML = svg(on ? UI_ICONS.stop : UI_ICONS.play)
    button.title = on ? "Stop" : "Preview on this computer"
  }
}

// ----------------------------------------------------------------- uploads

const WAV_TYPES = ["audio/wav", "audio/x-wav", "audio/wave"]

export async function uploadSound(slot: number, file: File, row: HTMLElement | null): Promise<void> {
  if (file.size > LIMITS.maxSoundBytes) return toast("Keep sounds under 8 MB.", true)
  const given = file.type === "audio/mp3" ? "audio/mpeg" : file.type
  if (!WAV_TYPES.includes(given) && given !== "audio/mpeg") return toast("Choose a WAV or MP3 file.", true)
  const type = WAV_TYPES.includes(given) ? "audio/wav" : given

  row?.classList.add("is-busy")
  try {
    const result = await request<SoundsChanged>(`/api/sounds/${slot}`, {
      method: "PUT",
      headers: { "Content-Type": type, "X-Sound-Name": file.name.replace(/[^\w .()[\]-]/g, "") },
      body: file
    })
    slotsChanged(result.slots)
    toast(`Sound ${slot} replaced.`)
  } catch (error) {
    row?.classList.remove("is-busy")
    toast(errorMessage(error), true)
  }
}

async function revertSound(slot: number): Promise<void> {
  const yes = await confirmAction({
    title: "Restore the built-in tone?",
    text: `Your uploaded file for Sound ${slot} will be deleted and the original tone put back.`,
    confirm: "Restore tone"
  })
  if (!yes) return
  try {
    const result = await request<SoundsChanged>(`/api/sounds/${slot}`, { method: "DELETE" })
    slotsChanged(result.slots)
    toast(`Sound ${slot} is back to its built-in tone.`)
  } catch (error) {
    toast(errorMessage(error), true)
  }
}

/** A hidden file input plus its visible label button, for WAV/MP3 uploads. */
export function audioFilePicker(id: string, title: string, onFile: (file: File) => void): { input: HTMLInputElement; label: HTMLLabelElement } {
  const picker = document.createElement("input")
  picker.type = "file"
  picker.accept = "audio/wav,audio/mpeg,.wav,.mp3"
  picker.className = "visually-hidden"
  picker.id = id
  picker.addEventListener("change", () => {
    const file = picker.files?.[0]
    if (file) onFile(file)
    picker.value = ""
  })
  const label = el("label", "icon-btn")
  label.htmlFor = id
  label.innerHTML = svg(UI_ICONS.upload)
  label.title = title
  return { input: picker, label }
}

function renderSoundList(): void {
  const host = byId("sound-list")
  host.innerHTML = ""

  for (const info of slots) {
    const row = el("div", `sound-slot${info.custom ? " is-custom" : ""}`)
    row.appendChild(el("span", "num", String(info.slot)))

    const meta = el("div", "meta")
    meta.appendChild(el("strong", null, info.custom ? info.name || "Your file" : `Built-in tone ${info.slot}`))
    const details = [info.format, prettyBytes(info.bytes)]
    if (info.durationMs !== null) details.push(formatDuration(info.durationMs))
    meta.appendChild(el("small", null, info.exists ? details.join(" · ") : "Missing"))
    row.appendChild(meta)

    const tools = el("div", "tools")
    const play = el("button", "icon-btn")
    play.type = "button"
    play.setAttribute("data-preview-slot", String(info.slot))
    play.setAttribute("aria-label", `Preview sound ${info.slot}`)
    play.onclick = () => playSlot(info.slot)
    tools.appendChild(play)

    const upload = audioFilePicker(`sound-file-${info.slot}`, "Replace with a WAV or MP3", (file) => void uploadSound(info.slot, file, row))
    tools.appendChild(upload.input)
    tools.appendChild(upload.label)

    if (info.custom) {
      const revert = el("button", "icon-btn danger")
      revert.type = "button"
      revert.innerHTML = svg(UI_ICONS.revert)
      revert.title = "Restore the built-in tone"
      revert.setAttribute("aria-label", `Restore built-in tone for sound ${info.slot}`)
      revert.onclick = () => void revertSound(info.slot)
      tools.appendChild(revert)
    }

    row.appendChild(tools)
    host.appendChild(row)
  }
  showPlaying(playingNow)
}

export function bindSounds(): void {
  const dialog = byId<HTMLDialogElement>("dlg-sounds")
  byId("sounds-toggle").addEventListener("click", () => dialog.showModal())
}
