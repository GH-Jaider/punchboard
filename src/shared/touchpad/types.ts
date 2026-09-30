// What goes into the touchpad engine and what comes out. Plain data only:
// the engine never sees the DOM, a clock or the network, so the same code
// runs in the deck, in the tests and on a recorded trace.
import type { TrackpadSettings } from "../types.ts"

/** One finger on the surface, in CSS pixels of the device's screen. */
export interface TouchContact {
  id: number
  x: number
  y: number
}

/** Every finger on the surface at one moment. The time is in ms on whatever
    clock the caller uses, as long as ticks use the same one. */
export interface TouchFrame {
  time: number
  contacts: TouchContact[]
  /** The touches were taken away (the system took them for itself) rather
      than lifted: no finger is on the surface, and nothing gets clicked. */
  cancelled?: boolean
}

export type Button = "left" | "right" | "middle"
export type Direction = "up" | "down" | "left" | "right"
export type ScrollPhase = "begin" | "change" | "end" | "momentum"
export type PinchPhase = "begin" | "change" | "end"

/** What the fingers meant. Moves and scrolls are already scaled by the
    settings (cursor speed, natural scrolling) and may be fractions; a click
    is a "down" followed at once by an "up" of the same button. Scroll
    "momentum" events arrive from ticks after the fingers have lifted. A
    pinch's scale is the factor since the previous pinch event. */
export type TouchpadEvent =
  | { type: "move"; dx: number; dy: number }
  | { type: "button"; button: Button; state: "down" | "up" }
  | { type: "scroll"; phase: ScrollPhase; dx: number; dy: number }
  | { type: "pinch"; phase: PinchPhase; scale: number }
  | { type: "swipe"; fingers: 3 | 4; direction: Direction }
  | { type: "fingers"; fingers: 4; gesture: "spread" | "pinch" }
  | { type: "tap"; fingers: 3 }

/** The tap machine's states; see tap.ts for what each one means. */
export type TapState =
  | "idle"
  | "touch"
  | "hold"
  | "touch2"
  | "touch2_hold"
  | "touch2_release"
  | "touch3"
  | "touch3_hold"
  | "touch3_release"
  | "touch3_release2"
  | "tapped"
  | "drag_or_tap"
  | "dragging"
  | "dragging2"
  | "dead"

/** What the fingers that are down are doing; see gestures.ts. */
export type GestureState = "none" | "undecided" | "pointer" | "drag" | "scroll" | "pinch" | "done"

/** A snapshot for the debug overlay and the tests. */
export interface TouchpadState {
  tap: TapState
  gesture: GestureState
  /** Fingers on the surface right now. */
  fingers: number
  momentum: boolean
}

export interface Touchpad {
  /** All the fingers on the surface right now. Returns what they meant. A
      cancelled frame is the same as cancel(). */
  frame(frame: TouchFrame): TouchpadEvent[]
  /** Time passing with nothing touching: fires timeouts and coasts scroll momentum. */
  tick(now: number): TouchpadEvent[]
  /** The touches were taken away (cancelled, or the surface went away): drop
      everything without clicking, releasing a held button first. */
  cancel(now: number): TouchpadEvent[]
  setSettings(settings: TrackpadSettings): void
  /** Whether a timeout or momentum is pending, so the caller knows to keep ticking. */
  needsTick(): boolean
  state(): TouchpadState
}
