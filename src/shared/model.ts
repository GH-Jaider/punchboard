// Creating, reading and repairing decks. Anything read from disk, a backup
// file or the network goes through normalizeLibrary(), which turns unknown
// input into a valid Library or fills in safe defaults.
import { isActionType, isFaderTarget, LIMITS, STATEFUL_ACTIONS } from "./actions.ts"
import { isButtonColorId } from "./colors.ts"
import { DEFAULT_FADER_GLYPH, DEFAULT_PRESS_GLYPH } from "./default-glyphs.ts"
import { DEFAULT_ICON, isSafeIconData, safeGlyph } from "./icons.ts"
import { parseCombo } from "./keys.ts"
import type { ActionType, Button, Fader, FaderButton, Library, PressButton, Profile, Step } from "./types.ts"

type UnknownRecord = Record<string, unknown>
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

// ---------------------------------------------------------------------- ids

let idCounter = 0
export function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`
}

// -------------------------------------------------------------------- steps

export const clampDelay = (value: unknown): number => clamp(Number(value) || 0, 0, LIMITS.maxDelayMs)

/** Builds a step of one type, keeping only the fields that type uses. */
export function makeStep(type: ActionType, fields: UnknownRecord = {}): Step {
  const id = text(fields.id) || nextId("step")
  const delayMs = clampDelay(fields.delayMs)
  switch (type) {
    case "obs_scene": return { id, delayMs, type, sceneName: text(fields.sceneName) }
    case "obs_toggle_source": return { id, delayMs, type, sceneName: text(fields.sceneName), sourceName: text(fields.sourceName) }
    case "obs_toggle_mute": return { id, delayMs, type, sourceName: text(fields.sourceName) }
    case "obs_start_stop_stream": return { id, delayMs, type }
    case "obs_toggle_record": return { id, delayMs, type }
    case "open_url": return { id, delayMs, type, url: text(fields.url) }
    case "browser_tile": return { id, delayMs, type, url: text(fields.url) }
    case "launch_app": return { id, delayMs, type, appPath: text(fields.appPath), appName: text(fields.appName) }
    case "play_sound": {
      const soundId = Number(fields.soundId)
      return { id, delayMs, type, soundId: soundId >= 1 && soundId <= LIMITS.soundSlots ? Math.floor(soundId) : undefined }
    }
    case "hotkey": return { id, delayMs, type, keys: parseCombo(fields.keys) ? String(fields.keys).toLowerCase() : undefined }
    case "none": return { id, delayMs, type }
  }
}

export const createStep = (type: ActionType = "none"): Step => makeStep(type)

export function normalizeStep(raw: unknown): Step {
  const fields = isRecord(raw) ? raw : {}
  return makeStep(isActionType(fields.type) ? fields.type : "none", fields)
}

/** Changes a step's action, keeping its id and delay and dropping fields that no longer apply. */
export const retypeStep = (step: Step, type: ActionType): Step => makeStep(type, { id: step.id, delayMs: step.delayMs })

// ------------------------------------------------------------------ buttons

function normalizeFader(raw: unknown): Fader {
  const fields = isRecord(raw) ? raw : {}
  return { target: isFaderTarget(fields.target) ? fields.target : "sounds", inputName: text(fields.inputName) ?? "" }
}

export function normalizeButton(raw: unknown): Button {
  const fields = isRecord(raw) ? raw : {}
  // Older decks stored a single `action` per button; macros need a list.
  const rawSteps = Array.isArray(fields.steps) && fields.steps.length ? fields.steps : [fields.action ?? { type: "none" }]
  const base = {
    id: text(fields.id) || nextId("btn"),
    slot: Math.max(0, Math.floor(Number(fields.slot) || 0)),
    label: text(fields.label) ?? "",
    icon: text(fields.icon) || DEFAULT_ICON,
    color: isButtonColorId(fields.color) ? fields.color : "accent" as const,
    steps: rawSteps.slice(0, LIMITS.maxSteps).map(normalizeStep)
  }
  const extras: Pick<Button, "iconData" | "glyph"> = {}
  if (isSafeIconData(fields.iconData)) extras.iconData = fields.iconData
  const glyph = safeGlyph(fields.glyph)
  if (glyph) extras.glyph = glyph

  if (fields.control === "fader") return { ...base, ...extras, control: "fader", fader: normalizeFader(fields.fader) }
  return { ...base, ...extras, control: "press" }
}

export function createEmptyButton(slot: number): PressButton {
  return { id: nextId("btn"), slot, label: "", icon: DEFAULT_ICON, color: "accent", control: "press", glyph: DEFAULT_PRESS_GLYPH, steps: [createStep("none")] }
}

/** Whether the button still shows the icon it was created with. */
const hasDefaultIcon = (button: Button): boolean =>
  !button.iconData && (!button.glyph ? button.icon === DEFAULT_ICON : button.glyph.name === DEFAULT_PRESS_GLYPH.name || button.glyph.name === DEFAULT_FADER_GLYPH.name)

/** The same button as a fader or a press button. Steps are kept either way. */
export function withControl(button: Button, control: Button["control"]): Button {
  if (control === "fader") {
    const fader: FaderButton = { ...button, control: "fader", fader: button.control === "fader" ? button.fader : { target: "sounds", inputName: "" } }
    if (hasDefaultIcon(button)) fader.glyph = DEFAULT_FADER_GLYPH
    return fader
  }
  // Built field by field so the fader settings cannot ride along.
  const press: PressButton = { id: button.id, slot: button.slot, label: button.label, icon: button.icon, color: button.color, steps: button.steps, control: "press" }
  if (button.iconData !== undefined) press.iconData = button.iconData
  if (button.glyph) press.glyph = hasDefaultIcon(button) ? DEFAULT_PRESS_GLYPH : button.glyph
  return press
}

// ----------------------------------------------------------------- profiles

export function createEmptyProfile(name: string): Profile {
  return { id: nextId("profile"), name, columns: 4, rows: 3, buttons: [], updatedAt: new Date().toISOString() }
}

function normalizeProfile(raw: unknown): Profile {
  const fields = isRecord(raw) ? raw : {}
  const profile: Profile = {
    id: text(fields.id) || nextId("profile"),
    name: text(fields.name) || "My deck",
    columns: clamp(Math.floor(Number(fields.columns)) || 4, LIMITS.columns.min, LIMITS.columns.max),
    rows: clamp(Math.floor(Number(fields.rows)) || 3, LIMITS.rows.min, LIMITS.rows.max),
    buttons: (Array.isArray(fields.buttons) ? fields.buttons : []).map(normalizeButton)
  }
  const updatedAt = text(fields.updatedAt)
  if (updatedAt) profile.updatedAt = updatedAt
  return profile
}

// ------------------------------------------------------------------ library

/** The minimum shape a file needs before it is worth normalizing as a deck. */
export function isLibraryShape(value: unknown): value is { version: 1; activeProfileId: string; profiles: unknown[] } {
  return isRecord(value) && value.version === 1 && typeof value.activeProfileId === "string" && Array.isArray(value.profiles)
}

export function normalizeLibrary(raw: unknown): Library {
  const fields = isRecord(raw) ? raw : {}
  const profiles = (Array.isArray(fields.profiles) ? fields.profiles : []).map(normalizeProfile)
  if (!profiles.length) profiles.push(createEmptyProfile("My deck"))
  const requested = text(fields.activeProfileId)
  const activeProfileId = profiles.some((profile) => profile.id === requested) ? requested! : profiles[0]!.id
  return { version: 1, activeProfileId, profiles }
}

// ---------------------------------------------------------------- questions

/** Buttons whose slot sits outside the grid after it was shrunk. */
export const parkedButtons = (profile: Profile): Button[] => profile.buttons.filter((button) => button.slot >= profile.rows * profile.columns)

export function isConfigured(button: Button): boolean {
  if (button.control === "fader") return button.fader.target !== "obs_input" || Boolean(button.fader.inputName)
  return button.steps.some((step) => step.type !== "none")
}

/** The sound slot a single-step "Play a sound" button toggles, or 0. Those light up while playing. */
export function soundSlotOf(button: Button): number {
  const only = button.steps[0]
  if (button.control === "fader" || button.steps.length !== 1 || !only || only.type !== "play_sound") return 0
  return clamp(Number(only.soundId) || 1, 1, LIMITS.soundSlots)
}

/** Whether the deck can show this button's live on/off state. */
export function isStateful(button: Button): boolean {
  if (button.control === "fader") return false
  if (soundSlotOf(button)) return true
  const only = button.steps[0]
  return button.steps.length === 1 && only !== undefined && STATEFUL_ACTIONS.includes(only.type)
}

/** Two faders on the same target share one level; this is its key everywhere. */
export const faderLevelKey = (fader: Fader): string => (fader.target === "obs_input" ? `obs:${fader.inputName}` : fader.target)
