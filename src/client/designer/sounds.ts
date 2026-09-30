// The eight sound slots: listing, previewing, replacing and restoring them.
import { LIMITS } from "../../shared/actions.ts"
import type { SoundsChanged, SoundSlot, SoundsResponse } from "../../shared/api.ts"
import { byId, el, svg } from "../common/dom.ts"
import { errorMessage, request } from "../common/http.ts"
import { confirmAction } from "./dialogs.ts"
import { toast, UI_ICONS, view } from "./hub.ts"
import { selectedButton } from "./state.ts"

let slots: SoundSlot[] = []

/** Playback state shared with the deck's sound output (sound-output.ts). */
export const playback = {
  /** Browsers only allow audio after the page has been clicked once. */
  unlocked: false,
  volume: 1
}

/** A per-slot cache key: previewing twice reuses the download, an upload busts it. */
export function soundVersion(slot: number): string {
  const info = slots.find((item) => item.slot === slot)
  return encodeURIComponent(info?.updatedAt ?? "0")
}

export const soundUrl = (slot: number): string => `/api/sounds/${slot}/file?v=${soundVersion(slot)}`

/** Labels say whether a slot holds your file or the shipped tone. */
export function soundSlotLabel(slot: number): string {
  const info = slots.find((item) => item.slot === slot)
  if (!info) return `Sound ${slot}`
  return `Sound ${slot}${info.custom ? ` · ${info.name || "your file"}` : " · built-in tone"}`
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
    chip.textContent = custom ? `${custom} of ${LIMITS.soundSlots} replaced` : `${LIMITS.soundSlots} built-in tones`
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

// One preview at a time; a second click on the playing button stops it.
let currentAudio: HTMLAudioElement | null = null
let currentButton: HTMLElement | null = null

function stopPreview(): void {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.currentTime = 0
  }
  if (currentButton) {
    currentButton.innerHTML = svg(UI_ICONS.play)
    currentButton.title = "Preview on this computer"
  }
  currentAudio = null
  currentButton = null
}

export function playSlot(slot: number, trigger: HTMLElement): void {
  const sameButton = currentButton === trigger
  stopPreview()
  if (sameButton) return

  const audio = new Audio(soundUrl(slot))
  audio.volume = playback.volume
  currentAudio = audio
  currentButton = trigger
  trigger.innerHTML = svg(UI_ICONS.stop)
  trigger.title = "Stop"
  audio.addEventListener("ended", () => {
    if (currentAudio === audio) stopPreview()
  })
  audio.addEventListener("error", () => {
    if (currentAudio !== audio) return
    stopPreview()
    toast(`Sound ${slot} could not be played.`, true)
  })
  audio.play().then(() => { playback.unlocked = true }).catch(() => {
    stopPreview()
    toast("Your browser blocked playback. Click Preview once more to allow it.", true)
  })
}

/** Applies a new sounds volume to the preview that is playing, if any. */
export function setPreviewVolume(volume: number): void {
  if (currentAudio) currentAudio.volume = volume
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
    meta.appendChild(el("small", null, info.exists ? `${info.format} · ${prettyBytes(info.bytes)}` : "Missing"))
    row.appendChild(meta)

    const tools = el("div", "tools")
    const play = el("button", "icon-btn")
    play.type = "button"
    play.innerHTML = svg(UI_ICONS.play)
    play.title = "Preview on this computer"
    play.setAttribute("aria-label", `Preview sound ${info.slot}`)
    play.onclick = () => playSlot(info.slot, play)
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
}

export function bindSounds(): void {
  const toggle = byId("sounds-toggle")
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true"
    toggle.setAttribute("aria-expanded", String(!open))
    byId("sounds-body").hidden = open
  })
  document.addEventListener("pointerdown", () => { playback.unlocked = true }, { once: true })
}
