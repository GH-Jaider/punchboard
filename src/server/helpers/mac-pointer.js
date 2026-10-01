// Punchboard's pointer on macOS, for trackpad decks. Run by the companion as
//   osascript -l JavaScript mac-pointer.js
// and kept alive: one command per line on stdin, as fast as fingers move.
//
//   m <dx> <dy>     move the cursor by that many points (drags while the button is down)
//   s <dx> <dy>     scroll by that many pixels
//   c left|right    click where the cursor is
//   d / u           press / release the left button: a tap (its release comes
//                   later) or a drag (moves in between). A left press soon after
//                   the last one, at the same spot, is the second click of a
//                   double click, whichever of c and d made either.
//   k <code> <flags>  press a key (macOS key code) with modifier flags, for gestures
//   p <phase> <mag>   a pinch as a trackpad makes it: phase 1 began, 2 changed,
//                   4 ended; mag the magnification since the last one
//   q               quit
//
// Needs the Accessibility permission, like key combinations. Errors go to
// stdout as {"error": "..."}.
ObjC.import("stdlib")
ObjC.import("Cocoa")
ObjC.import("CoreGraphics")

// These take or return a CGEventRef that the bridge does not type, so they
// are bound by hand; void * accepts every event the bridge makes too.
ObjC.bindFunction("CGEventCreateScrollWheelEvent2", ["void *", ["void *", "int", "int", "int", "int", "int"]])
ObjC.bindFunction("CGEventPost", ["void", ["int", "void *"]])
ObjC.bindFunction("CGEventSetIntegerValueField", ["void", ["void *", "int", "long"]])
ObjC.bindFunction("CGEventSetFlags", ["void", ["void *", "long"]])
ObjC.bindFunction("CGEventSourceCreate", ["void *", ["int"]])
ObjC.bindFunction("CGEventSetType", ["void", ["void *", "int"]])
ObjC.bindFunction("CGEventSetDoubleValueField", ["void", ["void *", "int", "double"]])
ObjC.bindFunction("CGEventSetSource", ["void", ["void *", "void *"]])
ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []])
ObjC.bindFunction("CGRequestPostEventAccess", ["bool", []])

var HID = 0
var MOVED = 5, LEFT_DOWN = 1, LEFT_UP = 2, RIGHT_DOWN = 3, RIGHT_UP = 4, LEFT_DRAGGED = 6
var CLICK_STATE = 1
/** A left press this soon after the last one, and this close to it, is the
    next click of the same series: the second is a double click. */
var DOUBLE_CLICK_MS = 400
var DOUBLE_CLICK_PX = 6
/** How long a click holds the button. A press and release at the same instant
    is sometimes dropped (Chrome is known to), and no finger clicks that fast. */
var CLICK_HOLD_S = 0.02

// Every event carries the hardware's own event source, so macOS treats it as
// part of the same input as the real trackpad and keyboard. Without one, the
// first clicks after starting were ignored until the real trackpad was used.
var HID_SYSTEM_STATE = 1
var source = $.CGEventSourceCreate(HID_SYSTEM_STATE)

function sourced(event) {
  $.CGEventSetSource(event, source)
  return event
}

var stdin = $.NSFileHandle.fileHandleWithStandardInput
var stdout = $.NSFileHandle.fileHandleWithStandardOutput
var leftDown = false
var lastDownAt = 0
var lastDownPoint = { x: 0, y: 0 }
var clickCount = 1
var screens = []
var screensAt = 0

function report(message) {
  var line = $.NSString.alloc.initWithUTF8String(JSON.stringify({ error: message }) + "\n")
  stdout.writeData(line.dataUsingEncoding($.NSUTF8StringEncoding))
}

/** Every display in CoreGraphics coordinates (origin top left of the main one). */
function displays() {
  var now = Date.now()
  if (now - screensAt < 2000 && screens.length) return screens
  var list = $.NSScreen.screens.js
  var mainHeight = list.length ? list[0].frame.size.height : 0
  screens = list.map(function (screen) {
    var frame = screen.frame
    return { x: frame.origin.x, y: mainHeight - frame.origin.y - frame.size.height, w: frame.size.width, h: frame.size.height }
  })
  screensAt = now
  return screens
}

function inside(point, rect) {
  return point.x >= rect.x && point.x < rect.x + rect.w && point.y >= rect.y && point.y < rect.y + rect.h
}

/** Keeps the cursor on a screen: it may cross onto another display, never off all of them. */
function clampPoint(from, to) {
  var list = displays()
  for (var i = 0; i < list.length; i++) if (inside(to, list[i])) return to
  var home = list[0]
  for (var j = 0; j < list.length; j++) if (inside(from, list[j])) home = list[j]
  if (!home) return to
  return { x: Math.max(home.x, Math.min(home.x + home.w - 1, to.x)), y: Math.max(home.y, Math.min(home.y + home.h - 1, to.y)) }
}

function here() {
  return $.CGEventGetLocation($.CGEventCreate(null))
}

function post(type, point, button, clicks) {
  var event = sourced($.CGEventCreateMouseEvent(null, type, point, button))
  // No modifier rides along: a shortcut must never turn a click into a ⌘-click.
  $.CGEventSetFlags(event, 0)
  if (clicks) $.CGEventSetIntegerValueField(event, CLICK_STATE, clicks)
  $.CGEventPost(HID, event)
}

function move(dx, dy) {
  var from = here()
  var to = clampPoint(from, { x: from.x + dx, y: from.y + dy })
  post(leftDown ? LEFT_DRAGGED : MOVED, to, 0, 0)
}

function scroll(dx, dy) {
  // Pixel units, vertical then horizontal; positive is up and left.
  var event = sourced($.CGEventCreateScrollWheelEvent2(null, 0, 2, Math.round(dy), Math.round(dx), 0))
  $.CGEventSetFlags(event, 0)
  $.CGEventPost(HID, event)
}

/** Presses the left button at the cursor, counting clicks the way macOS does
    for a mouse: a press soon after the last one, in the same place, is the
    next click of it, and its release carries the same count. The count is
    kept here rather than in click() alone because a deck sends a tap as a
    press whose release follows later (a finger may come back to drag with
    it), and a double tap as that release and then a click: the second press
    must read as the double click whichever command made the first. */
function leftPress(point) {
  var now = Date.now()
  var near = Math.abs(point.x - lastDownPoint.x) <= DOUBLE_CLICK_PX && Math.abs(point.y - lastDownPoint.y) <= DOUBLE_CLICK_PX
  clickCount = now - lastDownAt < DOUBLE_CLICK_MS && near ? clickCount + 1 : 1
  lastDownAt = now
  lastDownPoint = point
  leftDown = true
  post(LEFT_DOWN, point, 0, clickCount)
}

function leftRelease(point) {
  leftDown = false
  post(LEFT_UP, point, 0, clickCount)
}

/** Where the cursor is, after a move to that very spot: the window under it
    is the one macOS hands the press to, even if nothing has moved since it
    started. */
function pressPoint() {
  var point = here()
  post(MOVED, point, 0, 0)
  return point
}

function click(which) {
  var point = pressPoint()
  if (which === "right") {
    post(RIGHT_DOWN, point, 1, 1)
    delay(CLICK_HOLD_S)
    post(RIGHT_UP, point, 1, 1)
    return
  }
  leftPress(point)
  delay(CLICK_HOLD_S)
  leftRelease(point)
}

// Modifier keys, pressed as keys rather than only named in a flag: macOS
// tracks their state for the hardware's event source, and a modifier that is
// never released stays down for every click after it (a pinch's ⌘+ left
// every tap a ⌘-click). fn is only a flag on arrow keys, never pressed.
var MODIFIERS = [
  { flag: 0x40000, code: 59 }, // control
  { flag: 0x80000, code: 58 }, // option
  { flag: 0x20000, code: 56 }, // shift
  { flag: 0x100000, code: 55 } // command
]
var FN = 0x800000

function keyEvent(code, down, flags) {
  var event = sourced($.CGEventCreateKeyboardEvent(null, code, down))
  $.CGEventSetFlags(event, flags)
  $.CGEventPost(HID, event)
}

/** A shortcut such as Ctrl+Up (Mission Control), typed the way a keyboard
    does: modifiers down, the key, then the modifiers up again in reverse. */
function key(code, flags) {
  var held = 0
  var pressed = []
  for (var i = 0; i < MODIFIERS.length; i++) {
    var modifier = MODIFIERS[i]
    if (!(flags & modifier.flag)) continue
    held |= modifier.flag
    keyEvent(modifier.code, true, held)
    pressed.push(modifier)
  }
  keyEvent(code, true, held | (flags & FN))
  keyEvent(code, false, held | (flags & FN))
  for (var j = pressed.length - 1; j >= 0; j--) {
    held &= ~pressed[j].flag
    keyEvent(pressed[j].code, false, held)
  }
}

// A trackpad pinch is a "gesture" event (type 29) of the magnify kind. Apple
// does not document how to make one; these field numbers are how macOS stores
// it, and the system reads the result back as an ordinary magnify event, the
// kind apps zoom maps, photos and pages with.
var GESTURE = 29
var GESTURE_FLAGS = 0x100
var FIELD_GESTURE_KIND = 110
var FIELD_MAGNIFICATION = 113
var FIELD_PHASE = 132
var KIND_MAGNIFY = 8

function pinch(phase, magnification) {
  var event = sourced($.CGEventCreate(null))
  $.CGEventSetType(event, GESTURE)
  $.CGEventSetFlags(event, GESTURE_FLAGS)
  $.CGEventSetIntegerValueField(event, FIELD_GESTURE_KIND, KIND_MAGNIFY)
  $.CGEventSetDoubleValueField(event, FIELD_MAGNIFICATION, magnification)
  $.CGEventSetIntegerValueField(event, FIELD_PHASE, phase)
  $.CGEventPost(HID, event)
}

function handle(line) {
  var parts = line.split(" ")
  var cmd = parts[0]
  if (cmd === "m") return move(Number(parts[1]) || 0, Number(parts[2]) || 0)
  if (cmd === "s") return scroll(Number(parts[1]) || 0, Number(parts[2]) || 0)
  if (cmd === "c") return click(parts[1])
  if (cmd === "k") return key(Number(parts[1]) || 0, Number(parts[2]) || 0)
  if (cmd === "p") return pinch(Number(parts[1]) || 2, Number(parts[2]) || 0)
  if (cmd === "d") return leftPress(pressPoint())
  if (cmd === "u") return leftRelease(here())
  if (cmd === "q") $.exit(0)
}

if (!$.CGPreflightPostEventAccess()) {
  $.CGRequestPostEventAccess()
  report("not allowed to post events")
}

var pending = ""
for (;;) {
  var data = stdin.availableData
  if (data.length === 0) $.exit(0)
  pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  var lines = pending.split("\n")
  pending = lines.pop()
  for (var k = 0; k < lines.length; k++) {
    if (!lines[k]) continue
    try { handle(lines[k]) } catch (error) { report(String(error)) }
  }
}
