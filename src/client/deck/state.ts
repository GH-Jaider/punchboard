// The deck's live state, shared by its modules. Plain module-level values:
// the deck is one page with one of everything.
import type { SoundPlayback } from "../../shared/api.ts"
import { buttonStateKey, shownProfiles } from "../../shared/model.ts"
import type { Button, Library, Profile } from "../../shared/types.ts"

export const state = {
  library: null as Library | null,
  activeId: null as string | null,
  libraryRev: -1,
  /** Live on/off states by stateKeyOf(), shared by every button on the same thing. */
  toggles: {} as Record<string, boolean>,
  /** Press keys awaiting a reply, so a push cannot stomp them. */
  inflight: {} as Record<string, boolean>,
  /** Sound slots playing on the computer right now. */
  playing: [] as number[],
  /** When each playing sound started and how long it is, by slot. */
  playback: {} as Record<string, SoundPlayback>,
  /** Fader levels by target key, 0..1. */
  levels: {} as Record<string, number>,
  /** Fader ids under a finger, so a push cannot yank them. */
  dragging: {} as Record<string, boolean>
}

export function activeProfile(): Profile | null {
  const library = state.library
  if (!library) return null
  // A hidden deck can still be the one showing: a "Go to another deck" button opened it.
  return library.profiles.find((profile) => profile.id === state.activeId) ?? shownProfiles(library)[0] ?? null
}

/** The live state a button shows, or a key of its own for buttons without one. */
export const toggleKey = (button: Button): string => buttonStateKey(button) ?? `button:${button.id}`

/** Records a state the way the companion does: one live scene at a time. */
export function setToggle(key: string, value: boolean): void {
  if (value && key.indexOf("scene:") === 0) {
    for (const other of Object.keys(state.toggles)) if (other.indexOf("scene:") === 0) state.toggles[other] = false
  }
  state.toggles[key] = value
}
