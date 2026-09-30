// Finding a port to listen on.
//
// Paired tablets are tied to the exact address, port included (a browser keeps
// storage per origin), so the port should almost never change. When the
// preferred one is busy there are two different cases: Punchboard is already
// running there (someone double-clicked the starter twice), or another program
// took it. Only the second one moves to a new port.
import type { Server } from "node:http"
import type { HelloResponse } from "../shared/api.ts"

/** Listens on `port`, resolving false instead of failing when it is taken. */
export function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off("listening", onListening)
      if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve(false)
      else reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve(true)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port)
  })
}

/** Whether a Punchboard companion is already answering on this port. */
export async function isPunchboardOn(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/hello`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const hello = (await response.json()) as Partial<HelloResponse>
    return typeof hello.serverTime === "number" && typeof hello.theme === "string"
  } catch {
    return false
  }
}

export type PortOutcome =
  | { kind: "listening"; port: number; moved: boolean }
  | { kind: "already-running"; port: number }
  | { kind: "no-free-port" }

/** Takes the preferred port, or the next free one within `range`. */
export async function claimPort(server: Server, preferred: number, range = 20): Promise<PortOutcome> {
  if (await tryListen(server, preferred)) return { kind: "listening", port: preferred, moved: false }
  if (await isPunchboardOn(preferred)) return { kind: "already-running", port: preferred }
  for (let port = preferred + 1; port <= preferred + range; port += 1) {
    if (await tryListen(server, port)) return { kind: "listening", port, moved: true }
  }
  return { kind: "no-free-port" }
}
