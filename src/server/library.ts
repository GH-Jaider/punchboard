// The deck library, kept in memory and written through to disk atomically.
// A file that will not parse is set aside and never overwritten, and each
// save carries a revision so two Control Center windows cannot clobber
// each other.
import fs from "node:fs"
import path from "node:path"
import { isLibraryShape, normalizeLibrary } from "../shared/model.ts"
import { starterLibrary } from "../shared/starter-decks.ts"
import type { Button, FaderButton, Library } from "../shared/types.ts"
import { errorText } from "./http.ts"
import { readJsonSafe, snapshotDaily, writeJsonAtomic } from "./store.ts"

export type LibraryStore = ReturnType<typeof createLibraryStore>

export function createLibraryStore(file: string, log: (message: string) => void) {
  function write(next: Library): void {
    snapshotDaily(file)
    writeJsonAtomic(file, next)
  }

  function load(): Library {
    try {
      const result = readJsonSafe(file, isLibraryShape)
      if (result.source === "backup") {
        log(`The deck file was damaged, so the previous save was restored. The damaged copy is kept as ${path.basename(result.aside)}.`)
        // Put the recovered deck back on disk now, not at the next edit.
        writeJsonAtomic(file, result.data, { backup: false })
      }
      if (result.data) return normalizeLibrary(result.data)
    } catch (error) {
      log(`${errorText(error)} Starting with an empty deck; restore a backup from the Control Center or profiles/backups.`)
    }
    // A first start gets the starter decks, so a device does something the
    // moment it pairs. A file that was there but could not be read gets an
    // empty deck instead: its owner had decks of their own.
    const firstStart = !fs.existsSync(file)
    const fresh = normalizeLibrary({ version: 1, ...(firstStart ? starterLibrary(process.platform === "darwin") : { activeProfileId: "", profiles: [] }) })
    write(fresh)
    return fresh
  }

  let library = load()
  /** Bumped on every write. Decks refetch when it changes. */
  let revision = 1

  return {
    get: (): Library => library,
    revision: (): number => revision,
    /** Replaces the library. Returns the new revision. */
    save(next: Library): number {
      library = next
      write(library)
      revision += 1
      return revision
    },
    findButton(profileId: unknown, buttonId: unknown): Button | null {
      const profile = library.profiles.find((item) => item.id === profileId)
      return profile?.buttons.find((item) => item.id === buttonId) ?? null
    },
    faders(profileId: unknown): FaderButton[] {
      const profile = library.profiles.find((item) => item.id === profileId)
      return profile ? profile.buttons.filter((button): button is FaderButton => button.control === "fader") : []
    }
  }
}
