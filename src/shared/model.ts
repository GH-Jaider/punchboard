// Creating, reading and repairing decks. Anything read from disk, a backup
// file or the network goes through normalizeLibrary(), which turns unknown
// input into a valid Library or fills in safe defaults.
import { isActionType, isFaderTarget, isMediaKey, isSetMode, LIMITS } from "./actions.ts"
import { isButtonColor } from "./colors.ts"
import { DEFAULT_FADER_GLYPH, DEFAULT_PRESS_GLYPH } from "./default-glyphs.ts"
import { DEFAULT_ICON, isIconId, isSafeIconData, safeGlyph } from "./icons.ts"
import { comboToString, parseCombo } from "./keys.ts"
import type { ActionType, Button, Fader, FaderButton, Library, PressButton, Profile, Step, TrackpadSettings } from "./types.ts"

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
  // "toggle" is the default, so it is left out rather than stored.
  const set = isSetMode(fields.set) && fields.set !== "toggle" ? fields.set : undefined
  switch (type) {
    case "obs_scene": return { id, delayMs, type, sceneName: text(fields.sceneName) }
    case "obs_toggle_source": return { id, delayMs, type, sceneName: text(fields.sceneName), sourceName: text(fields.sourceName), set }
    case "obs_toggle_mute": return { id, delayMs, type, sourceName: text(fields.sourceName), set }
    case "obs_start_stop_stream": return { id, delayMs, type, set }
    case "obs_toggle_record": return { id, delayMs, type, set }
    case "obs_toggle_filter": return { id, delayMs, type, sourceName: text(fields.sourceName), filterName: text(fields.filterName), set }
    case "obs_toggle_virtualcam": return { id, delayMs, type, set }
    case "obs_save_replay": return { id, delayMs, type }
    case "obs_studio_transition": return { id, delayMs, type }
    case "open_url": return { id, delayMs, type, url: text(fields.url) }
    case "browser_tile": return { id, delayMs, type, url: text(fields.url) }
    case "launch_app": return { id, delayMs, type, appPath: text(fields.appPath), appName: text(fields.appName) }
    case "play_sound": {
      const soundId = Math.floor(Number(fields.soundId))
      return { id, delayMs, type, soundId: soundId >= 1 && soundId <= LIMITS.soundSlots ? soundId : undefined }
    }
    case "hotkey": {
      // Stored in the one canonical spelling ("ctrl+shift+k"), whatever order it came in.
      const combo = parseCombo(fields.keys)
      return { id, delayMs, type, keys: combo ? comboToString(combo) : undefined }
    }
    case "media_key": return { id, delayMs, type, mediaKey: isMediaKey(fields.mediaKey) ? fields.mediaKey : "play_pause" }
    case "stop_sounds": return { id, delayMs, type }
    case "go_to_deck": return { id, delayMs, type, profileId: text(fields.profileId) }
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

/** The longest image data URI kept: LIMITS.maxIconBytes of image, base64-encoded, plus its prefix. */
const MAX_ICON_DATA_LENGTH = Math.ceil(LIMITS.maxIconBytes / 3) * 4 + 64

export function normalizeButton(raw: unknown): Button {
  const fields = isRecord(raw) ? raw : {}
  // Older decks stored a single `action` per button; macros need a list.
  const rawSteps = Array.isArray(fields.steps) && fields.steps.length ? fields.steps : [fields.action ?? { type: "none" }]
  const base = {
    id: text(fields.id) || nextId("btn"),
    slot: Math.max(0, Math.floor(Number(fields.slot) || 0)),
    label: text(fields.label) ?? "",
    icon: isIconId(fields.icon) ? fields.icon : DEFAULT_ICON,
    color: isButtonColor(fields.color) ? fields.color : "accent" as const,
    steps: rawSteps.slice(0, LIMITS.maxSteps).map(normalizeStep)
  }
  const extras: Pick<Button, "iconData" | "glyph" | "onGlyph" | "offSteps"> = {}
  if (Array.isArray(fields.offSteps)) extras.offSteps = fields.offSteps.slice(0, LIMITS.maxSteps).map(normalizeStep)
  if (isSafeIconData(fields.iconData) && fields.iconData.length <= MAX_ICON_DATA_LENGTH) extras.iconData = fields.iconData
  const glyph = safeGlyph(fields.glyph)
  if (glyph) extras.glyph = glyph
  const onGlyph = safeGlyph(fields.onGlyph)
  if (onGlyph) extras.onGlyph = onGlyph

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
  if (button.offSteps) press.offSteps = button.offSteps
  if (button.onGlyph) press.onGlyph = button.onGlyph
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
  if (isRecord(fields.trackpad)) profile.trackpad = normalizeTrackpad(fields.trackpad)
  if (fields.hidden === true) profile.hidden = true
  return profile
}

/** The decks devices offer as tabs: every deck not switched off. */
export const shownProfiles = (library: Library): Profile[] => library.profiles.filter((profile) => !profile.hidden)

export const TRACKPAD_SPEED = { min: 0.5, max: 3 } as const
export const DEFAULT_TRACKPAD: TrackpadSettings = { speed: 1.5, naturalScroll: true, pinchZoom: "gesture" }

export function normalizeTrackpad(raw: unknown): TrackpadSettings {
  const fields = isRecord(raw) ? raw : {}
  // Only a number counts: Number(null) and Number("") are 0, which is not a speed anyone chose.
  const given = fields.speed
  const speed = typeof given === "number" || (typeof given === "string" && given.trim() !== "") ? Number(given) : NaN
  return {
    speed: Number.isFinite(speed) ? clamp(speed, TRACKPAD_SPEED.min, TRACKPAD_SPEED.max) : DEFAULT_TRACKPAD.speed,
    naturalScroll: typeof fields.naturalScroll === "boolean" ? fields.naturalScroll : DEFAULT_TRACKPAD.naturalScroll,
    pinchZoom: fields.pinchZoom === "keys" ? "keys" : "gesture"
  }
}

// ------------------------------------------------------------------ library

/** The minimum shape a file needs before it is worth normalizing as a deck. */
export function isLibraryShape(value: unknown): value is { version: 1; activeProfileId: string; profiles: unknown[] } {
  return isRecord(value) && value.version === 1 && typeof value.activeProfileId === "string" && Array.isArray(value.profiles)
}

const hasOwn = (object: object, key: string | number): boolean => Object.prototype.hasOwnProperty.call(object, key)

/** Makes every deck id and every button id unique, and gives every button a
    slot of its own. A hand-edited file, an old bug or a merged backup can
    repeat them, and a repeated one can never be pressed or edited: the first
    one found always wins. The later one gets a new id, and the first free
    slot, which is past the grid when the grid is full (the Control Center
    offers those back). */
function repairIds(profiles: Profile[]): void {
  const profileIds: Record<string, true> = {}
  // Across decks too: a two-state macro keeps its on/off by button id.
  const buttonIds: Record<string, true> = {}
  for (const profile of profiles) {
    if (hasOwn(profileIds, profile.id)) profile.id = nextId("profile")
    profileIds[profile.id] = true
    const slots: Record<number, true> = {}
    const moved: Button[] = []
    for (const button of profile.buttons) {
      if (hasOwn(buttonIds, button.id)) button.id = nextId("btn")
      buttonIds[button.id] = true
      if (hasOwn(slots, button.slot)) moved.push(button)
      else slots[button.slot] = true
    }
    let free = 0
    for (const button of moved) {
      while (hasOwn(slots, free)) free += 1
      button.slot = free
      slots[free] = true
    }
  }
}

export function normalizeLibrary(raw: unknown): Library {
  const fields = isRecord(raw) ? raw : {}
  const profiles = (Array.isArray(fields.profiles) ? fields.profiles : []).map(normalizeProfile)
  if (!profiles.length) profiles.push(createEmptyProfile("My deck"))
  repairIds(profiles)
  const requested = text(fields.activeProfileId)
  const activeProfileId = profiles.some((profile) => profile.id === requested) ? requested! : profiles[0]!.id
  return { version: 1, activeProfileId, profiles }
}

// ---------------------------------------------------------------- questions

/** Buttons whose slot sits outside the grid after it was shrunk. */
export const parkedButtons = (profile: Profile): Button[] => profile.buttons.filter((button) => button.slot >= profile.rows * profile.columns)

export function isConfigured(button: Button): boolean {
  if (button.control === "fader") return button.fader.target !== "obs_input" || Boolean(button.fader.inputName)
  return button.steps.some((step) => step.type !== "none") || Boolean(button.offSteps?.some((step) => step.type !== "none"))
}

/** The sound slot a single-step "Play a sound" button toggles, or 0. Those light up while playing. */
export function soundSlotOf(button: Button): number {
  const only = button.steps[0]
  if (button.control === "fader" || isSwitch(button) || button.steps.length !== 1 || !only || only.type !== "play_sound") return 0
  return clamp(Number(only.soundId) || 1, 1, LIMITS.soundSlots)
}

/** The name of the live state a step reads or changes, shared by every
    button that touches the same thing: two buttons muting one mic light up
    together, whichever deck they are on. Null for steps without one. */
export function stateKeyOf(step: Step): string | null {
  switch (step.type) {
    case "obs_scene": return step.sceneName ? `scene:${step.sceneName}` : null
    case "obs_toggle_mute": return step.sourceName ? `mute:${step.sourceName}` : null
    case "obs_toggle_source": return step.sceneName && step.sourceName ? `source:${step.sceneName}\n${step.sourceName}` : null
    case "obs_toggle_filter": return step.sourceName && step.filterName ? `filter:${step.sourceName}\n${step.filterName}` : null
    case "obs_start_stop_stream": return "stream"
    case "obs_toggle_record": return "record"
    case "obs_toggle_virtualcam": return "virtualcam"
    case "obs_save_replay": return "replaybuffer"
    default: return null
  }
}

/** Whether a button is a two-state macro: press for `steps`, press again for `offSteps`. */
export const isSwitch = (button: Button): boolean => button.control === "press" && Array.isArray(button.offSteps)

/** The state a button shows, or null: a two-state macro shows its own on/off,
    a single step the state it acts on. A plain macro has no one state to show. */
export function buttonStateKey(button: Button): string | null {
  if (button.control === "fader") return null
  if (isSwitch(button)) return `switch:${button.id}`
  const only = button.steps[0]
  if (button.steps.length !== 1 || !only) return null
  return stateKeyOf(only)
}

/** Whether the deck can show this button's live on/off state. */
export function isStateful(button: Button): boolean {
  return Boolean(soundSlotOf(button)) || buttonStateKey(button) !== null
}

/** Two faders on the same target share one level; this is its key everywhere. */
export const faderLevelKey = (fader: Fader): string => (fader.target === "obs_input" ? `obs:${fader.inputName}` : fader.target)
