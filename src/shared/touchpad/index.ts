// A touchpad made of a touch screen: frames of fingers in, what they meant
// out. Pure and clockless, so it runs the same in the deck, in Node and on
// a recorded trace.
//
//   const pad = createTouchpad({ speed: 1.5, naturalScroll: true })
//   pad.frame({ time, contacts: [{ id, x, y }, …] })  →  events
//   pad.tick(now)                                     →  events (timeouts, momentum)
export { createTouchpad } from "./engine.ts"
export { TUNING } from "./tuning.ts"
export { isTouchFrame, isTouchpadEvent, summarize, TRACE_LIMITS } from "./trace.ts"
export type { TouchpadTrace } from "./trace.ts"
export type {
  Button,
  Direction,
  GestureState,
  PinchPhase,
  ScrollPhase,
  TapState,
  Touchpad,
  TouchContact,
  TouchFrame,
  TouchpadEvent,
  TouchpadState
} from "./types.ts"
