// One volume write at a time, newest level first. A drag posts every ~90 ms
// and each write takes about as long, so writes run side by side would
// finish in any order and could leave an older level set.

/** Runs one write at a time; while one is in flight only the newest level
    waits, and goes next. Callers that arrive meanwhile share the write in
    flight. */
export function latestWins<T>(write: (level: number) => Promise<T>): (level: number) => Promise<T> {
  let inFlight: Promise<T> | null = null
  let next: number | null = null
  const run = (level: number): Promise<T> => {
    if (inFlight) {
      next = level
      return inFlight
    }
    inFlight = write(level).finally(() => {
      inFlight = null
      if (next !== null) {
        const queued = next
        next = null
        run(queued).catch(() => { /* reported by the next caller */ })
      }
    })
    return inFlight
  }
  return run
}

/** latestWins for each key on its own: two apps' faders dragged together
    never wait for each other, while one app's levels still go one at a time. */
export function latestWinsPerKey<T>(write: (key: string, level: number) => Promise<T>): (key: string, level: number) => Promise<T> {
  const writers = new Map<string, (level: number) => Promise<T>>()
  return (key, level) => {
    let writer = writers.get(key)
    if (!writer) {
      writer = latestWins((queued) => write(key, queued))
      writers.set(key, writer)
    }
    return writer(level)
  }
}
