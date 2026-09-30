// The deck's live state, shared by its modules. Plain module-level values:
// the deck is one page with one of everything.
import type { SoundPlayback } from "../../shared/api.ts"
import type { Button, Library, Profile } from "../../shared/types.ts"

export const state = {
  library: null as Library | null,
  activeId: null as string | null,
  libraryRev: -1,
  /** OBS on/off states by toggleKey(). */
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
  return library.profiles.find((profile) => profile.id === state.activeId) ?? library.profiles[0] ?? null
}

export const toggleKey = (button: Button): string => `${state.activeId}:${button.id}`
