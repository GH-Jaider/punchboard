// Ready-made decks, so Punchboard does something the moment a device pairs:
// a fresh install starts with them, and the Control Center's + offers them
// again. They only use what exists on any computer: OBS's default inputs
// (Mic/Aux and Desktop Audio), the built-in sounds, music keys and everyday
// shortcuts, with Cmd on a Mac and Ctrl elsewhere.
import { t } from "./i18n.ts"
import { DEFAULT_TRACKPAD, makeStep, nextId } from "./model.ts"
import { STARTER_GLYPHS } from "./starter-glyphs.ts"
import type { ActionType, Button, ButtonColorId, Fader, Profile, Step } from "./types.ts"

export type StarterId = "streaming" | "music" | "shortcuts" | "trackpad"

export interface StarterMeta { label: string; hint: string }

/** A starter's entry in the + menu, read in the page's language. */
const starterMeta = (id: StarterId): StarterMeta => ({
  get label() { return t(`shared.starter.${id}.label`) },
  get hint() { return t(`shared.starter.${id}.hint`) }
})

export const STARTERS: Readonly<Record<StarterId, StarterMeta>> = {
  streaming: starterMeta("streaming"),
  music: starterMeta("music"),
  shortcuts: starterMeta("shortcuts"),
  trackpad: starterMeta("trackpad")
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
      return deck(t("shared.starter.streaming.name"), 4, 3, [
        press(0, t("shared.starter.streaming.button.goLive"), "sensors", "red", [["obs_start_stop_stream"]]),
        press(1, t("shared.starter.streaming.button.record"), "fiber_manual_record", "rose", [["obs_toggle_record"]], "stop_circle"),
        press(2, t("shared.starter.streaming.button.clipIt"), "replay", "pink", [["obs_save_replay"]]),
        press(3, t("shared.starter.streaming.button.cameraOut"), "video_camera_front", "violet", [["obs_toggle_virtualcam"]]),
        // Lit while muted: the crossed-out icon says so too.
        press(4, t("shared.starter.streaming.button.muteMic"), "mic", "orange", [["obs_toggle_mute", { sourceName: MIC }]], "mic_off"),
        press(5, t("shared.starter.streaming.button.muteDesktop"), "volume_up", "amber", [["obs_toggle_mute", { sourceName: DESKTOP }]], "volume_off"),
        fader(6, t("shared.starter.streaming.button.mic"), "mic", "green", { target: "obs_input", inputName: MIC }),
        fader(7, t("shared.starter.streaming.button.desktop"), "speaker", "cyan", { target: "obs_input", inputName: DESKTOP }),
        press(8, t("shared.starter.streaming.button.airhorn"), "campaign", "yellow", [["play_sound", { soundId: 1 }]]),
        press(9, t("shared.starter.streaming.button.cheer"), "celebration", "lime", [["play_sound", { soundId: 2 }]]),
        press(10, t("shared.starter.streaming.button.stopSounds"), "stop_circle", "slate", [["stop_sounds"]]),
        press(11, t("shared.starter.streaming.button.studioGo"), "switch_video", "blue", [["obs_studio_transition"]])
      ])
    case "music":
      return deck(t("shared.starter.music.name"), 3, 2, [
        press(0, t("shared.starter.music.button.previous"), "skip_previous", "mint", [["media_key", { mediaKey: "previous" }]]),
        press(1, t("shared.starter.music.button.play"), "play_pause", "green", [["media_key", { mediaKey: "play_pause" }]]),
        press(2, t("shared.starter.music.button.next"), "skip_next", "mint", [["media_key", { mediaKey: "next" }]]),
        fader(3, t("shared.starter.music.button.volume"), "volume_up", "cyan", { target: "system", inputName: "" }),
        fader(4, t("shared.starter.music.button.sounds"), "graphic_eq", "lime", { target: "sounds", inputName: "" }),
        press(5, t("shared.starter.music.button.stopSounds"), "stop_circle", "slate", [["stop_sounds"]])
      ])
    case "shortcuts": {
      const cmd = mac ? "meta" : "ctrl"
      const keys = (combo: string): StepSpec[] => [["hotkey", { keys: combo }]]
      return deck(t("shared.starter.shortcuts.name"), 4, 3, [
        press(0, t("shared.starter.shortcuts.button.copy"), "content_copy", "blue", keys(`${cmd}+c`)),
        press(1, t("shared.starter.shortcuts.button.paste"), "content_paste", "blue", keys(`${cmd}+v`)),
        press(2, t("shared.starter.shortcuts.button.cut"), "content_cut", "blue", keys(`${cmd}+x`)),
        press(3, t("shared.starter.shortcuts.button.selectAll"), "select_all", "indigo", keys(`${cmd}+a`)),
        press(4, t("shared.starter.shortcuts.button.undo"), "undo", "orange", keys(`${cmd}+z`)),
        press(5, t("shared.starter.shortcuts.button.redo"), "redo", "orange", keys(mac ? "shift+meta+z" : "ctrl+y")),
        press(6, t("shared.starter.shortcuts.button.save"), "save", "green", keys(`${cmd}+s`)),
        press(7, t("shared.starter.shortcuts.button.find"), "search", "violet", keys(`${cmd}+f`)),
        press(8, t("shared.starter.shortcuts.button.newTab"), "tab", "cyan", keys(`${cmd}+t`)),
        press(9, t("shared.starter.shortcuts.button.closeTab"), "tab_close", "rose", keys(`${cmd}+w`)),
        press(10, t("shared.starter.shortcuts.button.reopenTab"), "history", "cyan", keys(mac ? "shift+meta+t" : "ctrl+shift+t")),
        mac
          ? press(11, t("shared.starter.shortcuts.button.screenshot"), "screenshot_region", "slate", keys("shift+meta+4"))
          : press(11, t("shared.starter.shortcuts.button.print"), "print", "slate", keys("ctrl+p"))
      ])
    }
    case "trackpad":
      return { ...deck(t("shared.starter.trackpad.name"), 4, 3, []), trackpad: { ...DEFAULT_TRACKPAD } }
  }
}

/** What a fresh install starts with. */
export function starterLibrary(mac: boolean): { activeProfileId: string; profiles: Profile[] } {
  const profiles = STARTER_IDS.map((id) => starterDeck(id, mac))
  return { activeProfileId: profiles[0]!.id, profiles }
}
