// Punchboard's pointer on macOS, for trackpad decks. Run by the companion as
//   osascript -l JavaScript mac-pointer.js
// and kept alive: one command per line on stdin, as fast as fingers move.
//
//   m <dx> <dy>     move the cursor by that many points (drags while the button is down)
//   s <dx> <dy>     scroll by that many pixels
//   c left|right    click where the cursor is (a quick second left click is a double click)
//   d / u           press / release the left button, for dragging
//   k <code> <flags>  press a key (macOS key code) with modifier flags, for gestures
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
ObjC.bindFunction("CGEventSetSource", ["void", ["void *", "void *"]])
ObjC.bindFunction("CGPreflightPostEventAccess", ["bool", []])
ObjC.bindFunction("CGRequestPostEventAccess", ["bool", []])

var HID = 0
var MOVED = 5, LEFT_DOWN = 1, LEFT_UP = 2, RIGHT_DOWN = 3, RIGHT_UP = 4, LEFT_DRAGGED = 6
var CLICK_STATE = 1
var DOUBLE_CLICK_MS = 400
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
var lastClickAt = 0
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
  $.CGEventPost(HID, sourced($.CGEventCreateScrollWheelEvent2(null, 0, 2, Math.round(dy), Math.round(dx), 0)))
}

function click(which) {
  var point = here()
  // A move to where the cursor already is: the window under it is the one
  // macOS hands the press to, even if nothing has moved since it started.
  post(MOVED, point, 0, 0)
  if (which === "right") {
    post(RIGHT_DOWN, point, 1, 1)
    delay(CLICK_HOLD_S)
    post(RIGHT_UP, point, 1, 1)
    return
  }
  var now = Date.now()
  clickCount = now - lastClickAt < DOUBLE_CLICK_MS ? clickCount + 1 : 1
  lastClickAt = now
  post(LEFT_DOWN, point, 0, clickCount)
  delay(CLICK_HOLD_S)
  post(LEFT_UP, point, 0, clickCount)
}

/** A shortcut such as Ctrl+Up (Mission Control): key down and up with its modifiers held. */
function key(code, flags) {
  var down = sourced($.CGEventCreateKeyboardEvent(null, code, true))
  $.CGEventSetFlags(down, flags)
  $.CGEventPost(HID, down)
  var up = sourced($.CGEventCreateKeyboardEvent(null, code, false))
  $.CGEventSetFlags(up, flags)
  $.CGEventPost(HID, up)
}

function handle(line) {
  var parts = line.split(" ")
  var cmd = parts[0]
  if (cmd === "m") return move(Number(parts[1]) || 0, Number(parts[2]) || 0)
  if (cmd === "s") return scroll(Number(parts[1]) || 0, Number(parts[2]) || 0)
  if (cmd === "c") return click(parts[1])
  if (cmd === "k") return key(Number(parts[1]) || 0, Number(parts[2]) || 0)
  if (cmd === "d") { leftDown = true; return post(LEFT_DOWN, here(), 0, 1) }
  if (cmd === "u") { leftDown = false; return post(LEFT_UP, here(), 0, 1) }
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
