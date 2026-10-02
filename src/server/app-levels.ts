// App volumes change outside Punchboard (Spotify's own slider, the Windows
// mixer, an app that closes) and nothing reports it, so while a device shows
// decks and the library has app faders, their levels are read every few
// seconds. Only changes go out: live.setLevels and dropLevels broadcast only
// when a level really moved. With no device connected, or no app fader,
// nothing is read at all.
import type { Library } from "../shared/types.ts"

export interface AppLevelsOptions {
  library: () => Library
  /** Whether anyone is looking: a device is connected. */
  watched: () => boolean
  /** An app's level, null while it cannot be read (closed, silent). */
  read: (key: string) => Promise<number | null>
  setLevels: (changes: Record<string, number>) => void
  dropLevels: (keys: string[]) => void
  intervalMs?: number
}

export type AppLevels = ReturnType<typeof createAppLevels>

export const APP_POLL_MS = 2500

export function createAppLevels(options: AppLevelsOptions) {
  const interval = options.intervalMs ?? APP_POLL_MS
  let timer: NodeJS.Timeout | undefined
  let polling = false
  let stopped = false
  // A read takes a moment; a deck write that lands meanwhile is newer than
  // what it read, and must not be undone by it. Writes stamp their key, and a
  // poll skips any key stamped after it started (as obs-state.ts does).
  let tick = 0
  const writtenAt = new Map<string, number>()
  let keysFor: Library | null = null
  let keys: string[] = []

  /** Every app an app fader points at, worked out again when the library is replaced. */
  function appKeys(): string[] {
    const library = options.library()
    if (keysFor === library) return keys
    const found = new Set<string>()
    for (const profile of library.profiles) {
      for (const button of profile.buttons) {
        if (button.control === "fader" && button.fader.target === "app" && button.fader.app) found.add(button.fader.app)
      }
    }
    keys = [...found]
    keysFor = library
    return keys
  }

  const needed = (): boolean => !stopped && options.watched() && appKeys().length > 0

  async function poll(): Promise<void> {
    const startedAt = tick
    const levels: Record<string, number> = {}
    const gone: string[] = []
    // One app after another: on Windows they share one helper anyway.
    for (const key of appKeys()) {
      let level: number | null
      try {
        level = await options.read(key)
      } catch {
        // The helper failed: what the decks show stays until it answers again.
        continue
      }
      const levelKey = `app:${key}`
      if ((writtenAt.get(levelKey) ?? 0) > startedAt) continue
      if (level === null) gone.push(levelKey)
      else levels[levelKey] = level
    }
    if (stopped) return
    options.setLevels(levels)
    if (gone.length) options.dropLevels(gone)
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      timer = undefined
      polling = true
      poll().catch(() => { /* the next round tries again */ }).finally(() => {
        polling = false
        if (needed()) schedule(interval)
      })
    }, delayMs)
    timer.unref()
  }

  /** Starts or stops polling as devices come and go and the library changes. */
  function update(): void {
    if (!needed()) {
      clearTimeout(timer)
      timer = undefined
      return
    }
    // A round in progress schedules the next itself.
    if (!timer && !polling) schedule(0)
  }

  /** A deck just set this level: a poll already reading has an older one. */
  function noteWrite(levelKey: string): void {
    tick += 1
    writtenAt.set(levelKey, tick)
  }

  function stop(): void {
    stopped = true
    clearTimeout(timer)
    timer = undefined
  }

  /** Whether a round is waiting or running, for tests. */
  const active = (): boolean => Boolean(timer) || polling

  return { update, noteWrite, stop, active }
}
