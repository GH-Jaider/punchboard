// Punchboard's sound player on macOS. Run by the companion as
//   osascript -l JavaScript mac-player.js
// and kept alive: it takes one JSON command per line on stdin and answers
// with one JSON event per line on stdout. AVAudioPlayer starts a sound at
// once, changes its volume while it plays and says when it is done, none
// of which afplay can do.
//
// Commands:  {"cmd":"play","slot":1,"file":"/path.wav","volume":0.5}
//            {"cmd":"stop","slot":1}   {"cmd":"stopall"}   {"cmd":"volume","volume":0.5}   {"cmd":"quit"}
// Events:    {"event":"ready"}  {"event":"started","slot":1}  {"event":"ended","slot":1}
//            {"event":"error","slot":1,"message":"..."}
ObjC.import("stdlib")
ObjC.import("Foundation")
ObjC.import("AVFoundation")

var players = {}
var volume = 1
var stdin = $.NSFileHandle.fileHandleWithStandardInput
var stdout = $.NSFileHandle.fileHandleWithStandardOutput
var pending = ""

function send(event) {
  var line = $.NSString.alloc.initWithUTF8String(JSON.stringify(event) + "\n")
  stdout.writeData(line.dataUsingEncoding($.NSUTF8StringEncoding))
}

function slotOf(player) {
  for (var slot in players) if (players[slot].isEqual(player)) return Number(slot)
  return null
}

function stop(slot) {
  var player = players[slot]
  if (!player) return
  delete players[slot]
  player.stop
  send({ event: "ended", slot: slot })
}

function play(slot, file, level) {
  stop(slot)
  var error = Ref()
  var url = $.NSURL.fileURLWithPath(file)
  var player = $.AVAudioPlayer.alloc.initWithContentsOfURLError(url, error)
  if (player.isNil()) {
    send({ event: "error", slot: slot, message: "That file could not be opened as audio." })
    return
  }
  player.delegate = handler
  player.volume = level
  players[slot] = player
  if (!player.play) {
    delete players[slot]
    send({ event: "error", slot: slot, message: "Playback did not start." })
    return
  }
  send({ event: "started", slot: slot })
}

// A volume is a number within 0..1; anything else is not a volume at all.
function level(value) {
  return typeof value === "number" && isFinite(value) ? Math.max(0, Math.min(1, value)) : null
}

function handle(command) {
  if (command.cmd === "play") return play(Number(command.slot), String(command.file), level(command.volume) === null ? volume : level(command.volume))
  if (command.cmd === "stop") return stop(Number(command.slot))
  if (command.cmd === "stopall") { for (var slot in players) stop(Number(slot)); return }
  if (command.cmd === "quit") $.exit(0)
  if (command.cmd === "volume") {
    if (level(command.volume) === null) return
    volume = level(command.volume)
    for (var each in players) players[each].volume = volume
  }
}

// Both stdin and the players' "finished" callbacks arrive through the run
// loop, so the helper never blocks on either.
// Registered classes are reached through $, not the return value.
ObjC.registerSubclass({
  name: "PunchboardPlayer",
  protocols: ["AVAudioPlayerDelegate"],
  methods: {
    "onData:": {
      types: ["void", ["id"]],
      implementation: function (note) {
        var data = note.userInfo.objectForKey("NSFileHandleNotificationDataItem")
        if (Number(data.length) === 0) $.exit(0) // the companion closed the pipe
        pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))
        var lines = pending.split("\n")
        pending = lines.pop()
        lines.forEach(function (line) {
          if (!line.trim()) return
          try { handle(JSON.parse(line)) } catch (e) { send({ event: "error", message: String(e) }) }
        })
        stdin.readInBackgroundAndNotify
      }
    },
    "audioPlayerDidFinishPlaying:successfully:": {
      types: ["void", ["id", "bool"]],
      implementation: function (player, ok) {
        var slot = slotOf(player)
        if (slot === null) return
        delete players[slot]
        send({ event: "ended", slot: slot })
      }
    },
    "audioPlayerDecodeErrorDidOccur:error:": {
      types: ["void", ["id", "id"]],
      implementation: function (player, error) {
        var slot = slotOf(player)
        if (slot === null) return
        delete players[slot]
        send({ event: "error", slot: slot, message: "The file could not be decoded." })
      }
    }
  }
})

var handler = $.PunchboardPlayer.alloc.init
$.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(handler, "onData:", "NSFileHandleReadCompletionNotification", stdin)
stdin.readInBackgroundAndNotify
send({ event: "ready" })
$.NSRunLoop.mainRunLoop.run
