// Ready-made decks, so Punchboard does something the moment a device pairs:
// a fresh install starts with them, and the Control Center's + offers them
// again. They only use what exists on any computer: OBS's default inputs
// (Mic/Aux and Desktop Audio), the built-in sounds, music keys and everyday
// shortcuts, with Cmd on a Mac and Ctrl elsewhere.
import { DEFAULT_TRACKPAD, makeStep, nextId } from "./model.ts"
import { STARTER_GLYPHS } from "./starter-glyphs.ts"
import type { ActionType, Button, ButtonColorId, Fader, Profile, Step } from "./types.ts"

export type StarterId = "streaming" | "music" | "shortcuts" | "trackpad"

export interface StarterMeta { label: string; hint: string }

export const STARTERS: Readonly<Record<StarterId, StarterMeta>> = {
  streaming: { label: "Streaming", hint: "Go live, record, clip, mute the mic, sounds and OBS faders" },
  music: { label: "Music", hint: "Play, pause, skip and the computer's volume" },
  shortcuts: { label: "Shortcuts", hint: "Copy, paste, undo, save, tabs and more" },
  trackpad: { label: "Trackpad", hint: "The whole screen moves the computer's mouse" }
}

export const STARTER_IDS = Object.keys(STARTERS) as StarterId[]

/** OBS names its default audio inputs these on every new install. */
const MIC = "Mic/Aux"
const DESKTOP = "Desktop Audio"

type StepSpec = [ActionType, Record<string, unknown>?]

function press(slot: number, label: string, icon: string, color: ButtonColorId, steps: StepSpec[], onIcon?: string): Button {
  const button: Button = {
    id: nextId("btn"),
    slot,
    label,
    icon: "zap",
    color,
    control: "press",
    steps: steps.map((spec): Step => makeStep(spec[0], spec[1] ?? {}))
  }
  const glyph = STARTER_GLYPHS[icon]
  if (glyph) button.glyph = glyph
  const onGlyph = onIcon ? STARTER_GLYPHS[onIcon] : undefined
  if (onGlyph) button.onGlyph = onGlyph
  return button
}

function fader(slot: number, label: string, icon: string, color: ButtonColorId, target: Fader): Button {
  const button: Button = { id: nextId("btn"), slot, label, icon: "zap", color, control: "fader", fader: target, steps: [makeStep("none")] }
  const glyph = STARTER_GLYPHS[icon]
  if (glyph) button.glyph = glyph
  return button
}

function deck(name: string, columns: number, rows: number, buttons: Button[]): Profile {
  return { id: nextId("profile"), name, columns, rows, buttons, updatedAt: new Date().toISOString() }
}

/** One starter deck. `mac` picks Cmd or Ctrl for the shortcuts. */
export function starterDeck(id: StarterId, mac: boolean): Profile {
  switch (id) {
    case "streaming":
      return deck("Streaming", 4, 3, [
        press(0, "Go live", "sensors", "red", [["obs_start_stop_stream"]]),
        press(1, "Record", "fiber_manual_record", "rose", [["obs_toggle_record"]], "stop_circle"),
        press(2, "Clip it", "replay", "pink", [["obs_save_replay"]]),
        press(3, "Camera out", "video_camera_front", "violet", [["obs_toggle_virtualcam"]]),
        // Lit while muted: the crossed-out icon says so too.
        press(4, "Mute mic", "mic", "orange", [["obs_toggle_mute", { sourceName: MIC }]], "mic_off"),
        press(5, "Mute desktop", "volume_up", "amber", [["obs_toggle_mute", { sourceName: DESKTOP }]], "volume_off"),
        fader(6, "Mic", "mic", "green", { target: "obs_input", inputName: MIC }),
        fader(7, "Desktop", "speaker", "cyan", { target: "obs_input", inputName: DESKTOP }),
        press(8, "Airhorn", "campaign", "yellow", [["play_sound", { soundId: 1 }]]),
        press(9, "Cheer", "celebration", "lime", [["play_sound", { soundId: 2 }]]),
        press(10, "Stop sounds", "stop_circle", "slate", [["stop_sounds"]]),
        press(11, "Studio: go", "switch_video", "blue", [["obs_studio_transition"]])
      ])
    case "music":
      return deck("Music", 3, 2, [
        press(0, "Previous", "skip_previous", "mint", [["media_key", { mediaKey: "previous" }]]),
        press(1, "Play", "play_pause", "green", [["media_key", { mediaKey: "play_pause" }]]),
        press(2, "Next", "skip_next", "mint", [["media_key", { mediaKey: "next" }]]),
        fader(3, "Volume", "volume_up", "cyan", { target: "system", inputName: "" }),
        fader(4, "Sounds", "graphic_eq", "lime", { target: "sounds", inputName: "" }),
        press(5, "Stop sounds", "stop_circle", "slate", [["stop_sounds"]])
      ])
    case "shortcuts": {
      const cmd = mac ? "meta" : "ctrl"
      const keys = (combo: string): StepSpec[] => [["hotkey", { keys: combo }]]
      return deck("Shortcuts", 4, 3, [
        press(0, "Copy", "content_copy", "blue", keys(`${cmd}+c`)),
        press(1, "Paste", "content_paste", "blue", keys(`${cmd}+v`)),
        press(2, "Cut", "content_cut", "blue", keys(`${cmd}+x`)),
        press(3, "Select all", "select_all", "indigo", keys(`${cmd}+a`)),
        press(4, "Undo", "undo", "orange", keys(`${cmd}+z`)),
        press(5, "Redo", "redo", "orange", keys(mac ? "shift+meta+z" : "ctrl+y")),
        press(6, "Save", "save", "green", keys(`${cmd}+s`)),
        press(7, "Find", "search", "violet", keys(`${cmd}+f`)),
        press(8, "New tab", "tab", "cyan", keys(`${cmd}+t`)),
        press(9, "Close tab", "tab_close", "rose", keys(`${cmd}+w`)),
        press(10, "Reopen tab", "history", "cyan", keys(mac ? "shift+meta+t" : "ctrl+shift+t")),
        mac
          ? press(11, "Screenshot", "screenshot_region", "slate", keys("shift+meta+4"))
          : press(11, "Print", "print", "slate", keys("ctrl+p"))
      ])
    }
    case "trackpad":
      return { ...deck("Trackpad", 4, 3, []), trackpad: { ...DEFAULT_TRACKPAD } }
  }
}

/** What a fresh install starts with. */
export function starterLibrary(mac: boolean): { activeProfileId: string; profiles: Profile[] } {
  const profiles = STARTER_IDS.map((id) => starterDeck(id, mac))
  return { activeProfileId: profiles[0]!.id, profiles }
}
