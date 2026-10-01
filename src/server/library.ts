// The deck library, kept in memory and written through to disk atomically.
// A file that will not parse is set aside and never overwritten, and each
// save carries a revision so two Control Center windows cannot clobber
// each other.
//
// A file written by a newer Punchboard (a higher "version") is not damaged,
// just not understood: it is left exactly as it is and this Punchboard runs
// read-only with an empty deck, saying so, until it is updated. Replacing it
// would lose decks the moment someone downgrades.
import fs from "node:fs"
import path from "node:path"
import { isLibraryShape, normalizeLibrary } from "../shared/model.ts"
import { starterLibrary } from "../shared/starter-decks.ts"
import type { Button, FaderButton, Library } from "../shared/types.ts"
import { errorText, HttpError } from "./http.ts"
import { isObject, readJsonSafe, snapshotDaily, UnreadableFileError, writeJsonAtomic } from "./store.ts"

export type LibraryStore = ReturnType<typeof createLibraryStore>

const emptyLibrary = (): Library => normalizeLibrary({ version: 1, activeProfileId: "", profiles: [] })

export function createLibraryStore(file: string, log: (message: string) => void) {
  /** Why saving is refused, when the file on disk must not be replaced. */
  let readOnly: string | null = null
  /** A problem found with the file at start-up, for the Control Center to
      show. The next successful save clears it. */
  let notice: string | null = null

  /** A path as the person finds it in the data folder, e.g. "decks/library.json.corrupt-…". */
  const shown = (target: string): string => path.join(path.basename(path.dirname(target)), path.basename(target))

  function write(next: Library): void {
    try {
      snapshotDaily(file)
    } catch (error) {
      // A missed snapshot is no reason to lose the save itself.
      log(`Could not take today's deck snapshot: ${errorText(error)}`)
    }
    writeJsonAtomic(file, next)
  }

  /** The format version of a deck file from a newer Punchboard, or null. */
  function newerVersion(): number | null {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (isObject(data) && typeof data.version === "number" && data.version > 1) return data.version
    } catch { /* missing or damaged: readJsonSafe deals with it */ }
    return null
  }

  function load(): Library {
    // Decided before reading: a damaged file is moved aside while it is read,
    // after which it would look like a first start.
    const firstStart = !fs.existsSync(file) && !fs.existsSync(`${file}.bak`)
    const newer = newerVersion()
    if (newer !== null) {
      readOnly = `Your decks file (${shown(file)}) was saved by a newer version of Punchboard (format ${newer}). It was left untouched; update Punchboard to use those decks. Until then, changes here cannot be saved.`
      notice = readOnly
      log(readOnly)
      return emptyLibrary()
    }
    try {
      const result = readJsonSafe(file, isLibraryShape)
      if (result.source === "backup") {
        notice = fs.existsSync(result.aside)
          ? `Your decks file was damaged, so the previous save was restored. The damaged copy was set aside as ${shown(result.aside)}.`
          : "Your decks file was missing, so the previous save was restored."
        log(notice)
        // Put the recovered deck back on disk now, not at the next edit.
        try {
          writeJsonAtomic(file, result.data, { backup: false })
        } catch (error) {
          log(`Could not write the recovered deck back: ${errorText(error)}`)
        }
      }
      if (result.data) return normalizeLibrary(result.data)
    } catch (error) {
      const aside = error instanceof UnreadableFileError && fs.existsSync(error.aside) ? shown(error.aside) : null
      notice = aside
        ? `Your decks file was damaged and was set aside as ${aside}, so Punchboard started with an empty deck. Restore it from a file you saved with Back up, or from a daily snapshot in decks/backups.`
        : "Your decks file could not be read, so Punchboard started with an empty deck. Restore it from a file you saved with Back up, or from a daily snapshot in decks/backups."
      log(`${errorText(error)} ${notice}`)
    }
    // A first start gets the starter decks, so a device does something the
    // moment it pairs. A file that was there but could not be read gets an
    // empty deck instead: its owner had decks of their own.
    const fresh = firstStart ? normalizeLibrary({ version: 1, ...starterLibrary(process.platform === "darwin") }) : emptyLibrary()
    try {
      write(fresh)
    } catch (error) {
      log(`Could not write the deck file: ${errorText(error)}`)
    }
    return fresh
  }

  let library = load()
  /** Bumped on every write. Decks refetch when it changes. It starts from the
      clock so a window left open across a restart can never match it by chance. */
  let revision = Date.now()

  return {
    get: (): Library => library,
    revision: (): number => revision,
    /** A start-up problem with the deck file worth telling the person about, or null. */
    notice: (): string | null => notice,
    /** Replaces the library. Returns the new revision. The file is written
        first, so a failed write leaves both memory and disk as they were. */
    save(next: Library): number {
      if (readOnly) throw new HttpError(423, readOnly)
      try {
        write(next)
      } catch (error) {
        throw new HttpError(500, `The decks could not be saved, so nothing changed: ${errorText(error)}`)
      }
      library = next
      revision += 1
      notice = null
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
