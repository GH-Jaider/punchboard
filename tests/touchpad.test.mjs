// The touchpad engine, without a browser: scripted fingers go in, the events
// that come out are checked. Three parts: scenarios (one tap is one click, a
// bounce is still one click, …), seeded random sequences that must keep the
// engine's invariants, and recorded traces replayed from touchpad-traces/.
//   node tests/touchpad.test.mjs
//   FUZZ_RUNS=20000 node tests/touchpad.test.mjs   more random sequences
//   FUZZ_SEED=1234 node tests/touchpad.test.mjs    replay one failing sequence
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createTouchpad, summarize, TUNING } from "../src/shared/touchpad/index.ts"
import { checker } from "./companion.mjs"

const { check, tally } = checker()
const SETTINGS = { speed: 1.5, naturalScroll: true }
const c = (id, x, y) => ({ id, x, y })

/** A scripted device: frames and ticks feed one engine, events pile up. */
function device(settings = SETTINGS) {
  const pad = createTouchpad(settings)
  const events = []
  let now = 0
  const api = {
    pad,
    events,
    time: () => now,
    frame(time, contacts) {
      now = time
      events.push(...pad.frame({ time, contacts }))
      return api
    },
    /** One tick at exactly this time, for checking when a timeout fires. */
    tick(time) {
      now = Math.max(now, time)
      events.push(...pad.tick(time))
      return api
    },
    /** Time passes with ticks every 16 ms, as the deck's frame loop would. */
    wait(ms) {
      const until = now + ms
      for (let t = now + 16; t < until; t += 16) events.push(...pad.tick(t))
      now = until
      events.push(...pad.tick(until))
      return api
    },
    /** Moves every contact by (dx, dy) in total over `steps` frames. */
    slide(contacts, dx, dy, steps = 10, stepMs = 16) {
      for (let i = 1; i <= steps; i += 1) {
        now += stepMs
        const moved = contacts.map((p) => c(p.id, p.x + (dx * i) / steps, p.y + (dy * i) / steps))
        events.push(...pad.frame({ time: now, contacts: moved }))
      }
      return contacts.map((p) => c(p.id, p.x + dx, p.y + dy))
    },
    take() {
      return events.splice(0)
    },
    summary() {
      return summarize(api.take())
    }
  }
  return api
}

const count = (events, test) => events.filter(test).length
const isClick = (button) => (events) => {
  let clicks = 0
  for (let i = 0; i + 1 < events.length; i += 1) {
    const a = events[i]
    const b = events[i + 1]
    if (a.type === "button" && a.button === button && a.state === "down" && b.type === "button" && b.button === button && b.state === "up") clicks += 1
  }
  return clicks
}
const leftClicks = isClick("left")
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------- scenarios

function scenarios() {
  // A tap presses at once and releases when the drag time has run out, so a
  // finger coming back in time can drag with the same press (libinput's model).
  let d = device()
  d.frame(0, [c(1, 100, 100)]).frame(60, []).tick(60 + TUNING.debounceMs)
  check("A tap presses the button as soon as the lift is sure, and holds it", same(d.summary(), ["left down"]) && d.pad.state().tap === "tapped", JSON.stringify(d.pad.state()))
  d.tick(60 + TUNING.dragMs - 1)
  check("The press is held while a finger may still come back", d.take().length === 0 && d.pad.needsTick(), "")
  d.tick(60 + TUNING.dragMs)
  check("Tap on nothing, then nothing: the button is released when the drag time runs out", same(d.summary(), ["left up"]), "")
  d.wait(800)
  check("Nothing is pending after a tap", d.take().length === 0 && !d.pad.needsTick() && d.pad.state().tap === "idle", JSON.stringify(d.pad.state()))
  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(60, []).wait(800)
  let events = d.take()
  check("A tap is exactly one click", leftClicks(events) === 1 && events.length === 2, JSON.stringify(summarize(events)))

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(10, []).frame(30, [c(2, 103, 101)]).frame(120, []).wait(800)
  check("A finger that bounces on landing is one click", same(d.summary(), ["click left"]), "")
  d.frame(2000, [c(1, 100, 100)]).frame(2070, []).frame(2090, [c(2, 104, 98)]).frame(2110, []).wait(800)
  check("A finger that bounces on lifting is one click", same(d.summary(), ["click left"]), "")
  d.frame(4000, [c(1, 100, 100)]).frame(4070, [])
  d.frame(4070 + TUNING.debounceMs + 1, [c(2, 100, 100)]).frame(4070 + TUNING.debounceMs + 60, []).wait(800)
  check("A second finger just outside the bounce window is a double tap", same(d.summary(), ["click left", "click left"]), "")

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(70, []).frame(160, [c(2, 100, 100)])
  check("The first tap of a double tap presses; the second finger landing sends nothing yet", same(d.summary(), ["left down"]) && d.pad.state().tap === "drag_or_tap", d.pad.state().tap)
  d.frame(230, []).tick(230 + TUNING.debounceMs)
  events = d.take()
  check("The second tap releases, then clicks at once: up, down, up", same(events.map((e) => `${e.button} ${e.state}`), ["left up", "left down", "left up"]) && d.pad.state().tap === "idle", JSON.stringify(events))
  d.wait(800)
  check("Nothing follows a double tap", d.take().length === 0 && !d.pad.needsTick(), "")
  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(70, []).frame(160, [c(2, 100, 100)]).frame(230, []).wait(800)
  events = d.take()
  check("A double tap is two clicks", leftClicks(events) === 2 && events.length === 4, JSON.stringify(summarize(events)))
  d.frame(2000, [c(1, 100, 100)]).frame(2070, []).frame(2160, [c(2, 100, 100)]).frame(2230, []).frame(2320, [c(3, 100, 100)]).frame(2390, []).wait(800)
  check("A triple tap is three clicks", leftClicks(d.take()) === 3, "")

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(70, []).frame(160, [c(2, 100, 100)])
  const pressed = d.take()
  d.slide([c(2, 100, 100)], 60, 0)
  const dragged = d.take()
  d.frame(d.time() + 16, []).wait(800)
  const dropped = d.take()
  check("Tap and drag: the tap presses, and nothing clicks before the drag", same(summarize(pressed), ["left down"]), JSON.stringify(summarize(pressed)))
  check("The returning finger drags with that press: moves, no second down", same(summarize(dragged), ["move"]) && dragged.filter((e) => e.type === "move").reduce((sum, e) => sum + e.dx, 0) > 40, JSON.stringify(summarize(dragged)))
  check("Lifting drops it: the one release", same(summarize(dropped), ["left up"]), JSON.stringify(summarize(dropped)))
  events = pressed.concat(dragged, dropped)
  check("Tap and drag is exactly one down and one up", count(events, (e) => e.type === "button" && e.state === "down") === 1 && count(events, (e) => e.type === "button" && e.state === "up") === 1, JSON.stringify(summarize(events)))

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(70, []).frame(160, [c(2, 100, 100)]).wait(TUNING.tapMs + 40)
  check("A finger resting after a tap drags with its press", same(d.summary(), ["left down"]) && d.pad.state().tap === "dragging", d.pad.state().tap)
  d.frame(d.time(), [c(2, 100, 100)]).frame(d.time() + 16, [])
  d.frame(d.time() + 20, [c(3, 101, 100)])
  const bouncedDrag = d.slide([c(3, 101, 100)], 40, 0)
  d.frame(d.time() + 16, []).wait(800)
  events = d.take()
  check("A bounce mid-drag keeps the button held", same(summarize(events), ["move", "left up"]) && bouncedDrag.length === 1, JSON.stringify(summarize(events)))

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(60, []).frame(200, [c(2, 100, 300)]).frame(220, [c(2, 100, 300), c(3, 160, 300)])
  events = d.take()
  check("Two fingers landing after a tap end its click", same(events.map((e) => `${e.button} ${e.state}`), ["left down", "left up"]), JSON.stringify(events))
  const two = d.slide([c(2, 100, 300), c(3, 160, 300)], 0, -100)
  d.frame(d.time() + 16, two).frame(d.time() + 16, []).wait(800)
  events = d.take()
  check("…and scroll, with no button left down", same(summarize(events).slice(0, 2), ["scroll", "scroll end"]) && count(events, (e) => e.type === "button") === 0, JSON.stringify(summarize(events)))

  d = device()
  d.frame(0, [c(1, 100, 100), c(2, 160, 100)]).frame(60, []).wait(800)
  check("A two-finger tap is a right click", same(d.summary(), ["click right"]), "")
  d.frame(2000, [c(1, 100, 100)]).frame(2040, [c(1, 100, 100), c(2, 160, 100)]).frame(2100, [c(2, 160, 100)]).frame(2130, []).wait(800)
  check("Two fingers landing 40 ms apart, lifting 30 ms apart: a right click", same(d.summary(), ["click right"]), "")
  d.frame(4000, [c(1, 100, 100)]).frame(4040, [c(1, 100, 100), c(2, 160, 100)]).frame(4100, [c(1, 100, 100)]).wait(400)
  d.frame(d.time(), []).wait(800)
  check("A finger tapping beside a resting one clicks nothing", d.summary().length === 0, "")

  d = device()
  d.frame(0, [c(1, 100, 100), c(2, 150, 100), c(3, 200, 100)]).frame(60, []).wait(800)
  check("A three-finger tap", same(d.summary(), ["tap 3"]), "")
  d.frame(2000, [c(1, 100, 100)]).frame(2020, [c(1, 100, 100), c(2, 150, 100)]).frame(2045, [c(1, 100, 100), c(2, 150, 100), c(3, 200, 100)])
  d.frame(2100, [c(2, 150, 100), c(3, 200, 100)]).frame(2115, [c(3, 200, 100)]).frame(2130, []).wait(800)
  check("Three fingers landing and lifting one by one still tap", same(d.summary(), ["tap 3"]), "")

  for (const natural of [true, false]) {
    d = device({ speed: 1.5, naturalScroll: natural })
    let pair = [c(1, 100, 300), c(2, 160, 300)]
    d.frame(0, pair)
    pair = d.slide(pair, 0, -100, 10)
    d.frame(d.time() + 200, pair).frame(d.time() + 16, []).wait(800)
    events = d.take()
    const scrolled = events.filter((e) => e.type === "scroll" && e.phase !== "end").reduce((sum, e) => sum + e.dy, 0)
    check(`Two fingers up scroll ${natural ? "the content up (natural)" : "the wheel up (classic)"}`, same(summarize(events), ["scroll", "scroll end"]) && (natural ? scrolled < -80 : scrolled > 80), `${scrolled} ${JSON.stringify(summarize(events))}`)
    check("No click after scrolling", leftClicks(events) === 0 && count(events, (e) => e.type === "move") === 0, "")
  }

  d = device()
  let pair = [c(1, 100, 300), c(2, 160, 300)]
  d.frame(0, pair)
  pair = d.slide(pair, 0, -200, 8)
  d.frame(d.time() + 8, []).wait(1500)
  events = d.take()
  const momentum = events.filter((e) => e.type === "scroll" && e.phase === "momentum")
  check("A flick keeps scrolling after the fingers lift", momentum.length > 10 && momentum.every((e) => e.dy < 0) && Math.abs(momentum[0].dy) > Math.abs(momentum[momentum.length - 1].dy), momentum.length)
  check("Momentum runs out on its own", !d.pad.needsTick() && !d.pad.state().momentum, "")
  d.frame(5000, pair)
  d.slide(pair, 0, -200, 8)
  d.frame(d.time() + 8, [])
  d.wait(50)
  d.frame(d.time(), [c(3, 300, 300)])
  const before = count(d.take(), (e) => e.phase === "momentum")
  d.frame(d.time() + 60, []).wait(600)
  events = d.take()
  check("A new finger stops the momentum", before > 0 && count(events, (e) => e.phase === "momentum") === 0 && !d.pad.state().momentum, "")
  check("The stopping finger, lifted quickly, is a click", same(summarize(events), ["click left"]), JSON.stringify(summarize(events)))
  d.frame(8000, pair)
  const slow = d.slide(pair, 0, -60, 20, 33)
  d.frame(d.time() + 100, slow).frame(d.time() + 16, []).wait(1000)
  check("A slow scroll has no momentum", count(d.take(), (e) => e.phase === "momentum") === 0, "")

  d = device()
  pair = [c(1, 150, 300), c(2, 250, 300)]
  d.frame(0, pair)
  for (let i = 1; i <= 10; i += 1) d.frame(i * 16, [c(1, 150 - i * 8, 300), c(2, 250 + i * 8, 300)])
  d.frame(200, []).wait(800)
  events = d.take()
  let scale = events.filter((e) => e.type === "pinch").reduce((total, e) => total * e.scale, 1)
  check("Spreading two fingers is a pinch out", same(summarize(events), ["pinch", "pinch end"]) && scale > 2 && scale < 3, `${scale}`)
  d.frame(2000, [c(1, 50, 300), c(2, 350, 300)])
  for (let i = 1; i <= 10; i += 1) d.frame(2000 + i * 16, [c(1, 50 + i * 10, 300), c(2, 350 - i * 10, 300)])
  d.frame(2200, []).wait(800)
  events = d.take()
  scale = events.filter((e) => e.type === "pinch").reduce((total, e) => total * e.scale, 1)
  check("Closing two fingers is a pinch in", same(summarize(events), ["pinch", "pinch end"]) && scale < 0.5, `${scale}`)
  check("No scroll during a pinch", count(events, (e) => e.type === "scroll") === 0, "")
  d.frame(4000, [c(1, 150, 300), c(2, 250, 300)])
  for (let i = 1; i <= 10; i += 1) d.frame(4000 + i * 16, [c(1, 150, 300), c(2, 250 + i * 6, 300)])
  d.frame(4200, []).wait(800)
  check("One finger still, the other moving away: a pinch", same(d.summary(), ["pinch", "pinch end"]), "")
  d.frame(6000, [c(1, 150, 300), c(2, 250, 300)])
  for (let i = 1; i <= 10; i += 1) d.frame(6000 + i * 16, [c(1, 150, 300 - i * 6), c(2, 250, 300 - (i > 2 ? (i - 2) * 6 : 0))])
  d.frame(6200, []).wait(800)
  check("One finger lagging at the start of a scroll: still a scroll", same(d.summary().slice(0, 2), ["scroll", "scroll end"]), "")

  // Pinches as hands really make them, which were being taken for scrolls.
  d = device()
  d.frame(8000, [c(1, 200, 420), c(2, 320, 200)])
  for (let i = 1; i <= 14; i += 1) d.frame(8000 + i * 16, [c(1, 200 + i * 0.3, 420 - i * 0.2), c(2, 320, 200 + i * 9)])
  d.frame(8300, []).wait(800)
  check("Thumb still below, index above it moving straight down: a pinch, not a scroll", same(d.summary(), ["pinch", "pinch end"]), JSON.stringify(d.events))
  d = device()
  d.frame(0, [c(1, 300, 200), c(2, 300, 400)])
  for (let i = 1; i <= 12; i += 1) d.frame(i * 16, [c(1, 300, 200 + i * 8), c(2, 300, 400 + i * 2)])
  d.frame(300, []).wait(800)
  check("Both fingers going down, the top one faster: a pinch, not a scroll down", same(d.summary(), ["pinch", "pinch end"]), JSON.stringify(summarize(d.events)))
  d = device()
  d.frame(0, [c(1, 200, 300), c(2, 300, 300)])
  for (let i = 1; i <= 4; i += 1) d.frame(i * 16, [c(1, 200, 300 + i * 5), c(2, 300, 300 + i * 5)])
  for (let i = 1; i <= 12; i += 1) d.frame(64 + i * 16, [c(1, 200 - i * 6, 320), c(2, 300 + i * 6, 320)])
  d.frame(400, []).wait(800)
  events = summarize(d.take())
  check("A scroll that turns into spreading fingers becomes a pinch", same(events, ["scroll", "scroll end", "pinch", "pinch end"]), JSON.stringify(events))
  d = device()
  d.frame(0, [c(1, 300, 150), c(2, 420, 150), c(3, 360, 420)])
  for (let i = 1; i <= 14; i += 1) d.frame(i * 16, [c(1, 300 + i * 2, 150 + i * 12), c(2, 420 - i * 2, 150 + i * 12), c(3, 360, 420)])
  d.frame(300, []).wait(800)
  check("Three fingers closing: no swipe, so no App Exposé", same(d.summary(), []), JSON.stringify(d.events))

  const spreadOut = (n, dx, dy, s = 1) => {
    const base = [[-60, -40], [60, -40], [-60, 40], [60, 40]].slice(0, n)
    return base.map((p, i) => c(i + 1, 450 + dx + p[0] * s, 300 + dy + p[1] * s))
  }
  for (const fingers of [3, 4]) {
    for (const dir of [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]]) {
      d = device()
      d.frame(0, spreadOut(fingers, 0, 0))
      for (let i = 1; i <= 15; i += 1) d.frame(i * 16, spreadOut(fingers, dir[1] * i * 12, dir[2] * i * 12))
      d.frame(300, []).wait(800)
      check(`${fingers} fingers ${dir[0]}: one swipe`, same(d.summary(), [`swipe ${fingers} ${dir[0]}`]), JSON.stringify(d.events))
    }
  }
  d = device()
  d.frame(0, spreadOut(3, 0, 0)).frame(20, spreadOut(2, 0, 0).concat([c(3, 400, 340)]))
  for (let i = 1; i <= 12; i += 1) d.frame(20 + i * 16, spreadOut(2, 0, -i * 12).concat([c(3, 400, 340 - i * 12)]))
  d.frame(300, spreadOut(2, 0, -144)).frame(330, []).wait(800)
  check("Fingers joining and leaving a swipe one at a time: still one swipe", same(d.summary(), ["swipe 3 up"]), "")

  d = device()
  d.frame(0, spreadOut(4, 0, 0))
  for (let i = 1; i <= 10; i += 1) d.frame(i * 16, spreadOut(4, 0, 0, 1 + i * 0.08))
  d.frame(200, []).wait(800)
  check("Four fingers spreading", same(d.summary(), ["fingers 4 spread"]), "")
  d.frame(2000, spreadOut(4, 0, 0, 1.5))
  for (let i = 1; i <= 10; i += 1) d.frame(2000 + i * 16, spreadOut(4, 0, 0, 1.5 - i * 0.06))
  d.frame(2200, []).wait(800)
  check("Four fingers pinching", same(d.summary(), ["fingers 4 pinch"]), "")

  d = device()
  d.frame(0, [c(1, 100, 100)])
  for (let i = 1; i <= 30; i += 1) d.frame(i * 33, [c(1, 100 + i, 100)])
  d.frame(1100, []).wait(800)
  events = d.take()
  const slowTotal = events.filter((e) => e.type === "move").reduce((sum, e) => sum + e.dx, 0)
  check("A slow one-finger move moves the cursor and clicks nothing", same(summarize(events), ["move"]) && slowTotal > 10, JSON.stringify(summarize(events)))
  d.frame(3000, [c(1, 100, 100)])
  for (let i = 1; i <= 6; i += 1) d.frame(3000 + i * 16, [c(1, 100 + i * 40, 100)])
  d.frame(3100, []).wait(800)
  const fastTotal = d.take().filter((e) => e.type === "move").reduce((sum, e) => sum + e.dx, 0)
  check("A flick goes further per finger pixel than a slow move", fastTotal / 240 > slowTotal / 30 * 1.5, `${fastTotal / 240} vs ${slowTotal / 30}`)

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(70, []).frame(160, [c(2, 100, 100)])
  d.slide([c(2, 100, 100)], 60, 0)
  d.take()
  events = d.pad.cancel(d.time())
  check("Cancelling mid-drag releases the button", same(summarize(events), ["left up"]) && d.pad.state().tap === "idle", JSON.stringify(events))
  d.frame(2000, [c(1, 100, 100)])
  events = d.pad.cancel(2030)
  d.wait(800)
  check("Cancelling mid-tap clicks nothing", events.length === 0 && d.take().length === 0, "")
  d.frame(3000, [c(1, 100, 100)]).frame(3060, []).tick(3060 + TUNING.debounceMs)
  d.take()
  events = d.pad.cancel(3200)
  d.wait(800)
  check("Cancelling while a tap's press is held releases it", same(summarize(events), ["left up"]) && d.take().length === 0 && d.pad.state().tap === "idle", JSON.stringify(events))
  d.frame(4000, [c(1, 100, 100)]).frame(4070, []).frame(4160, [c(2, 100, 100)])
  d.slide([c(2, 100, 100)], 60, 0)
  d.take()
  events = d.pad.frame({ time: d.time() + 16, contacts: [], cancelled: true })
  d.frame(d.time() + 200, [c(2, 300, 300)]).frame(d.time() + 60, []).wait(800)
  check("A cancelled frame is a cancel, and the next touch starts afresh", same(summarize(events), ["left up"]) && same(d.summary(), ["click left"]), JSON.stringify(events))

  d = device()
  d.frame(0, [c(1, 100, 100)]).frame(60, []).wait(400)
  d.frame(d.time(), [c(1, 100, 100)]).frame(d.time() + 60, []).wait(800)
  check("A touch id used again for a later tap is a second tap", same(d.summary(), ["click left", "click left"]), "")

  d = device()
  pair = [c(1, 100, 300), c(2, 160, 300)]
  d.frame(0, pair)
  pair = d.slide(pair, 0, -60, 6)
  d.frame(d.time() + 16, [pair[1]])
  d.slide([pair[1]], 40, 0, 12)
  d.frame(d.time() + 16, []).wait(800)
  events = d.take()
  check("The finger left behind after a scroll moves the cursor, without clicking", leftClicks(events) === 0 && count(events, (e) => e.type === "move") > 0 && summarize(events)[0] === "scroll", JSON.stringify(summarize(events)))

  const script = (dev) => {
    dev.frame(0, [c(1, 100, 100)]).frame(60, []).frame(90, [c(2, 100, 100)])
    dev.slide([c(2, 100, 100)], 50, 20)
    dev.frame(dev.time() + 16, []).wait(500)
    return dev.take()
  }
  check("The same script gives the same events twice", same(script(device()), script(device())), "")
}

// --------------------------------------------------------------------- fuzz

/** mulberry32: small, seeded, good enough to replay a failure. */
function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Builds one random sequence of gestures as frames; each frame also says
    which gesture it belongs to and whether that gesture is a single tap. */
function randomScript(random) {
  const frames = []
  const int = (low, high) => low + Math.floor(random() * (high - low + 1))
  const pick = (list) => list[int(0, list.length - 1)]
  let now = 0
  let nextId = 1
  const jitter = (px) => (random() * 2 - 1) * px
  const push = (contacts, gesture) => frames.push({ time: now, contacts: contacts.map((p) => c(p.id, p.x, p.y)), gesture })
  const gap = () => { now += int(6, 34) }

  const finger = (x, y) => ({ id: nextId++, x, y })
  const landed = (n, spread = int(40, 120)) => {
    const list = []
    for (let i = 0; i < n; i += 1) list.push(finger(300 + i * spread + jitter(10), 300 + jitter(30)))
    return list
  }
  const bounce = (contact, gesture) => {
    // The finger leaves and lands straight back, close by.
    push([], gesture)
    now += int(4, TUNING.debounceMs - 10)
    return { id: nextId++, x: contact.x + jitter(6), y: contact.y + jitter(6) }
  }

  const tap = (gesture, withBounce) => {
    let f = landed(1)[0]
    const start = now
    push([f], gesture)
    const total = int(15, 160)
    let bounced = false
    while (now - start < total) {
      gap()
      if (withBounce && !bounced && random() < 0.7) {
        f = bounce(f, gesture)
        bounced = true
      }
      f = { id: f.id, x: f.x + jitter(2), y: f.y + jitter(2) }
      push([f], gesture)
    }
    gap()
    push([], gesture)
  }
  const moveAll = (list, dx, dy, steps, gesture, stepMs = () => int(8, 34)) => {
    let current = list
    for (let i = 1; i <= steps; i += 1) {
      now += stepMs()
      current = current.map((p, k) => ({ id: p.id, x: p.x + dx(k) / steps + jitter(1.5), y: p.y + dy(k) / steps + jitter(1.5) }))
      push(current, gesture)
    }
    return current
  }
  const stagger = (list, gesture) => {
    // Fingers land one by one, a few ms apart.
    for (let i = 1; i <= list.length; i += 1) {
      push(list.slice(0, i), gesture)
      if (i < list.length) now += int(0, 60)
    }
    return list
  }
  const lift = (list, gesture) => {
    let rest = list.slice()
    while (rest.length) {
      now += int(0, 40)
      rest = rest.slice(1)
      push(rest, gesture)
    }
  }

  const kinds = ["tap", "bounceTap", "doubleTap", "tapDrag", "twoTap", "threeTap", "scroll", "pinch", "swipe", "four", "hold", "garbage", "pause"]
  const gestures = int(1, 6)
  for (let g = 0; g < gestures; g += 1) {
    const kind = pick(kinds)
    const gesture = { kind, index: g }
    // Gestures follow each other closely half the time, and stand alone the other half.
    now += random() < 0.5 ? int(0, 350) : int(900, 1500)
    switch (kind) {
      case "tap": tap(gesture, false); break
      case "bounceTap": tap(gesture, true); break
      case "doubleTap": tap(gesture, false); now += int(30, 250); tap(gesture, random() < 0.3); break
      case "tapDrag": {
        tap(gesture, false)
        now += int(20, 280)
        let f = landed(1)
        push(f, gesture)
        if (random() < 0.5) now += int(0, 400)
        f = moveAll(f, () => jitter(200), () => jitter(200), int(1, 20), gesture)
        if (random() < 0.4) {
          f = [bounce(f[0], gesture)]
          push(f, gesture)
          f = moveAll(f, () => jitter(100), () => jitter(100), int(1, 8), gesture)
        }
        gap()
        push([], gesture)
        break
      }
      case "twoTap": lift(stagger(landed(2), gesture), gesture); break
      case "threeTap": lift(stagger(landed(3), gesture), gesture); break
      case "scroll": {
        let f = stagger(landed(2), gesture)
        const dx = jitter(300)
        const dy = jitter(300)
        f = moveAll(f, () => dx, () => dy, int(2, 30), gesture)
        if (random() < 0.3) now += int(100, 400)
        lift(f, gesture)
        break
      }
      case "pinch": {
        let f = stagger(landed(2), gesture)
        const stretch = jitter(150)
        f = moveAll(f, (k) => (k === 0 ? -stretch : stretch), () => 0, int(2, 20), gesture)
        lift(f, gesture)
        break
      }
      case "swipe": {
        const n = pick([3, 4])
        let f = stagger(landed(n, int(40, 80)), gesture)
        const dx = jitter(250)
        const dy = jitter(250)
        f = moveAll(f, () => dx, () => dy, int(2, 25), gesture)
        lift(f, gesture)
        break
      }
      case "four": {
        // Four fingers in a row spread from, or close on, their middle.
        let f = stagger(landed(4, 60), gesture)
        const s = random() < 0.5 ? 1.6 : 0.5
        f = moveAll(f, (k) => (k - 1.5) * 60 * (s - 1), () => 0, int(4, 20), gesture)
        lift(f, gesture)
        break
      }
      case "hold": {
        const f = stagger(landed(int(1, 4)), gesture)
        moveAll(f, () => 0, () => 0, int(1, 40), gesture, () => int(16, 60))
        lift(f, gesture)
        break
      }
      case "garbage": {
        const steps = int(1, 30)
        for (let i = 0; i < steps; i += 1) {
          const list = []
          const n = int(0, 6)
          for (let k = 0; k < n; k += 1) list.push({ id: int(0, 6), x: random() * 1000, y: random() * 700 })
          const unique = list.filter((p, k) => list.findIndex((q) => q.id === p.id) === k)
          now += int(0, 50)
          push(unique, gesture)
        }
        now += int(0, 20)
        push([], gesture)
        break
      }
      case "pause": now += int(0, 800); push([], gesture); break
      default: throw new Error(kind)
    }
  }
  return frames
}

/** Runs one script through a fresh engine and checks the invariants. Returns
    the first problem, or null. */
function fuzzOne(seed) {
  const random = prng(seed)
  const settings = { speed: 0.5 + random() * 2.5, naturalScroll: random() < 0.5 }
  const frames = randomScript(random)
  const pad = createTouchpad(settings)
  const events = []
  let held = { left: false, right: false, middle: false }
  let scrollActive = false
  let pinchActive = false
  let session = 0
  let swipesInSession = 0
  let fingersDown = 0
  /** When the last finger lifted, while none is down; null while one is. */
  let zeroSince = null
  // A tap's press waits dragMs for a finger to come back; after that, with
  // nothing on the surface, the button must be up. Lifts are sure debounceMs
  // late and ticks come up to 38 ms apart.
  const HELD_LIMIT = TUNING.dragMs + TUNING.debounceMs + 40
  let problem = null
  const fail = (message) => { if (!problem) problem = message }

  const observe = (list, gesture, at) => {
    if (held.left && zeroSince !== null && at - zeroSince > HELD_LIMIT) fail(`the left button was still held ${at - zeroSince} ms after the last finger lifted`)
    for (const event of list) {
      events.push({ event, gesture })
      for (const key of Object.keys(event)) {
        const value = event[key]
        if (typeof value === "number" && !Number.isFinite(value)) fail(`${key} is ${value} in ${JSON.stringify(event)}`)
      }
      if (event.type === "button") {
        if (event.state === "down" && held[event.button]) fail(`${event.button} pressed twice`)
        if (event.state === "up" && !held[event.button]) fail(`${event.button} released without a press`)
        held[event.button] = event.state === "down"
      } else if (event.type === "scroll") {
        if (event.phase === "begin") { if (scrollActive) fail("scroll began twice"); scrollActive = true }
        if (event.phase === "change" && !scrollActive) fail("scroll changed without beginning")
        if (event.phase === "end") { if (!scrollActive) fail("scroll ended without beginning"); scrollActive = false }
        if (pinchActive && event.phase !== "momentum") fail("scroll during a pinch")
        if (event.phase === "momentum" && fingersDown > 0) fail("momentum with a finger down")
      } else if (event.type === "pinch") {
        if (event.phase === "begin") { if (pinchActive) fail("pinch began twice"); pinchActive = true }
        if (event.phase === "change" && !pinchActive) fail("pinch changed without beginning")
        if (event.phase === "end") { if (!pinchActive) fail("pinch ended without beginning"); pinchActive = false }
        if (scrollActive) fail("pinch during a scroll")
      } else if (event.type === "swipe" || event.type === "fingers") {
        swipesInSession += 1
        if (swipesInSession > 1) fail(`a second ${event.type} in one touch`)
      }
    }
  }

  let time = 0
  let current = null
  for (const frame of frames) {
    // Ticks arrive between frames as the deck's frame loop would, unevenly;
    // what they emit belongs to the gesture that just ended.
    while (time + 8 < frame.time) {
      time += 8 + Math.floor(random() * 30)
      if (time < frame.time) observe(pad.tick(time), current, time)
    }
    current = frame.gesture
    time = frame.time
    if (fingersDown === 0 && frame.contacts.length > 0) { session += 1; swipesInSession = 0 }
    fingersDown = frame.contacts.length
    if (fingersDown === 0) { if (zeroSince === null) zeroSince = time } else zeroSince = null
    observe(pad.frame(frame), frame.gesture, time)
    if (problem) return { problem, frames, events }
  }
  for (let i = 0; i < 2500; i += 16) observe(pad.tick(time + i), current, time + i)
  if (held.left || held.right || held.middle) fail("a button is still held after everything lifted")
  if (scrollActive || pinchActive) fail("a scroll or pinch is still open after everything lifted")
  if (pad.needsTick()) fail("something is still pending after everything lifted")
  const state = pad.state()
  if (state.tap !== "idle" || state.gesture !== "none" || state.fingers !== 0) fail(`not idle at the end: ${JSON.stringify(state)}`)

  // A lone single tap, with or without a bounce, is one click at most; a clean
  // one is exactly one, its down at the lift and its up from a tick after.
  // "Lone" means nothing else near it in time.
  const byGesture = new Map()
  for (const frame of frames) {
    const list = byGesture.get(frame.gesture) ?? []
    list.push(frame)
    byGesture.set(frame.gesture, list)
  }
  for (const [gesture, list] of byGesture) {
    if (gesture.kind !== "tap" && gesture.kind !== "bounceTap") continue
    const first = list[0].time
    const last = list[list.length - 1].time
    const before = frames.filter((f) => f.gesture !== gesture && f.time < first).map((f) => f.time)
    const after = frames.filter((f) => f.gesture !== gesture && f.time > last).map((f) => f.time)
    const lone = (!before.length || first - Math.max(...before) > 800) && (!after.length || Math.min(...after) - last > 800)
    if (!lone) continue
    const own = events.filter((e) => e.gesture === gesture).map((e) => e.event)
    const clicks = leftClicks(own)
    if (clicks > 1) fail(`a lone ${gesture.kind} produced ${clicks} clicks`)
    const moved = list.some((f) => f.contacts.length && Math.abs(f.contacts[0].x - list[0].contacts[0].x) + Math.abs(f.contacts[0].y - list[0].contacts[0].y) > TUNING.tapMovePx / 2)
    if (gesture.kind === "tap" && !moved && last - first < TUNING.tapMs - 40) {
      if (clicks !== 1) fail(`a lone clean tap produced ${clicks} clicks`)
      const buttons = own.filter((e) => e.type === "button").map((e) => `${e.button} ${e.state}`)
      if (!same(buttons, ["left down", "left up"])) fail(`a lone clean tap sent ${JSON.stringify(buttons)}`)
    }
  }
  return problem ? { problem, frames, events } : null
}

function fuzz() {
  const runs = Number(process.env.FUZZ_RUNS) || 3000
  const only = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null
  let failures = 0
  let ran = 0
  for (let i = 0; i < (only === null ? runs : 1); i += 1) {
    const seed = only === null ? 1000 + i : only
    ran += 1
    const result = fuzzOne(seed)
    if (only !== null && result) {
      for (const frame of result.frames) console.log(`  ${frame.time}  ${frame.gesture.kind}#${frame.gesture.index}  ${frame.contacts.map((p) => `${p.id}@${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(" ") || "-"}`)
      for (const entry of result.events) console.log(`  -> ${entry.gesture ? `${entry.gesture.kind}#${entry.gesture.index}` : "end"}  ${JSON.stringify(entry.event)}`)
    }
    if (!result) continue
    failures += 1
    if (failures <= 5) {
      console.log(`  seed ${seed}: ${result.problem}`)
      console.log(`  replay with FUZZ_SEED=${seed}; events: ${JSON.stringify(summarize(result.events.map((e) => e.event)))}`)
    }
  }
  check(`Random sequences keep the invariants (${ran} runs)`, failures === 0, `${failures} failed`)
}

// ------------------------------------------------------------------- traces

function traces() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "touchpad-traces")
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort() : []
  check("There are recorded traces to replay", files.length > 0, dir)
  for (const name of files) {
    let trace
    try {
      trace = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
    } catch (error) {
      check(`Trace ${name} is readable`, false, String(error))
      continue
    }
    const pad = createTouchpad(trace.settings)
    const events = []
    let time = trace.frames.length ? trace.frames[0].time : 0
    for (const frame of trace.frames) {
      for (let t = time + 16; t < frame.time; t += 16) events.push(...pad.tick(t))
      time = frame.time
      events.push(...pad.frame(frame))
    }
    for (let t = 16; t <= 2500; t += 16) events.push(...pad.tick(time + t))
    const got = summarize(events)
    check(`Trace ${name} replays as expected`, same(got, trace.expected), `got ${JSON.stringify(got)}, expected ${JSON.stringify(trace.expected)}`)
  }
}

scenarios()
fuzz()
traces()
console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
