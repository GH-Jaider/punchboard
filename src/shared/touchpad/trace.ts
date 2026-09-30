// Recorded traces: the frames a device saw and what the engine made of them,
// as a JSON file the tests replay. The deck records them in its debug mode
// (#trackpad-debug) and the companion writes them; a developer then edits
// `expected` to say what should have happened.
import type { TrackpadSettings } from "../types.ts"
import type { TouchFrame, TouchpadEvent } from "./types.ts"

export interface TouchpadTrace {
  version: 1
  recordedAt: string
  /** The device's browser, since bounces and timing differ between them. */
  userAgent?: string
  settings: TrackpadSettings
  frames: TouchFrame[]
  /** What the device's engine emitted, kept for reference. */
  events: TouchpadEvent[]
  /** The summary the replay must produce; starts as the summary of `events`. */
  expected: string[]
}

/** Trace frames are held to these, since a device sends them. */
export const TRACE_LIMITS = { frames: 6000, contacts: 10, events: 20000 } as const

/** One line per meaningful thing: runs of moves, scrolls and pinches fold
    into one entry, and a button down followed at once by its up is a click. */
export function summarize(events: TouchpadEvent[]): string[] {
  const lines: string[] = []
  const push = (line: string, foldable: boolean): void => {
    if (foldable && lines[lines.length - 1] === line) return
    lines.push(line)
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!
    switch (event.type) {
      case "move":
        push("move", true)
        break
      case "button": {
        const next = events[i + 1]
        if (event.state === "down" && next && next.type === "button" && next.button === event.button && next.state === "up") {
          push(`click ${event.button}`, false)
          i += 1
        } else {
          push(`${event.button} ${event.state}`, false)
        }
        break
      }
      case "scroll":
        if (event.phase === "end") push("scroll end", false)
        else if (event.phase === "momentum") push("momentum", true)
        else push("scroll", true)
        break
      case "pinch":
        push(event.phase === "end" ? "pinch end" : "pinch", event.phase !== "end")
        break
      case "swipe":
        push(`swipe ${event.fingers} ${event.direction}`, false)
        break
      case "fingers":
        push(`fingers ${event.fingers} ${event.gesture}`, false)
        break
      case "tap":
        push(`tap ${event.fingers}`, false)
        break
      default:
        push(`unknown ${String((event as { type: unknown }).type)}`, false)
    }
  }
  return lines
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === "number" && isFinite(value)

export function isTouchFrame(value: unknown): value is TouchFrame {
  if (!isRecord(value) || !finite(value.time) || !Array.isArray(value.contacts) || value.contacts.length > TRACE_LIMITS.contacts) return false
  if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") return false
  for (let i = 0; i < value.contacts.length; i += 1) {
    const contact: unknown = value.contacts[i]
    if (!isRecord(contact) || !finite(contact.id) || !finite(contact.x) || !finite(contact.y)) return false
  }
  return true
}

const BUTTONS = ["left", "right", "middle"]
const DIRECTIONS = ["up", "down", "left", "right"]

export function isTouchpadEvent(value: unknown): value is TouchpadEvent {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "move": return finite(value.dx) && finite(value.dy)
    case "button": return BUTTONS.indexOf(String(value.button)) >= 0 && (value.state === "down" || value.state === "up")
    case "scroll": return ["begin", "change", "end", "momentum"].indexOf(String(value.phase)) >= 0 && finite(value.dx) && finite(value.dy)
    case "pinch": return ["begin", "change", "end"].indexOf(String(value.phase)) >= 0 && finite(value.scale)
    case "swipe": return (value.fingers === 3 || value.fingers === 4) && DIRECTIONS.indexOf(String(value.direction)) >= 0
    case "fingers": return value.fingers === 4 && (value.gesture === "spread" || value.gesture === "pinch")
    case "tap": return value.fingers === 3
    default: return false
  }
}
