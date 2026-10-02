// App volume faders: the model keeps an app key safe, the Windows bridge
// carries the audio-session code, writes go one at a time per app, the Mac
// scripts never start an app, polling broadcasts only changes, and the
// routes refuse what they must. Every volume here belongs to a stand-in: a
// fake "powershell" (off Windows) and a fake "osascript" (off Windows) answer
// from a file, so no real app's volume, nor the computer's, is ever touched,
// and Music and Spotify are never started. On Windows the routes only meet an
// app that does not exist, which changes nothing.
//   node tests/app-volume.test.mjs
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { appDisplayName, faderLevelKey, isConfigured, normalizeAppKey, normalizeButton, normalizeLibrary } from "../src/shared/model.ts"
import { latestWins, latestWinsPerKey } from "../src/server/latest-wins.ts"
import { BRIDGE, parseAppList } from "../src/server/win-volume.ts"
import { AppNotPlayingError, MAC_APPS, macVolumeScript } from "../src/server/app-volume.ts"
import { createAppLevels } from "../src/server/app-levels.ts"
import { createLive } from "../src/server/events.ts"
import { findChrome, launchChrome } from "./chrome.mjs"
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-app-volume-"))
const savedPath = process.env.PATH

// ------------------------------------------------------------------ model

{
  const fader = (fields) => normalizeButton({ id: "f", slot: 0, label: "", control: "fader", steps: [], fader: fields }).fader
  const chrome = fader({ target: "app", app: "  Chrome.EXE ", appName: " Google\nChrome  " })
  check("An app key is trimmed, lower-cased and loses .exe", chrome.app === "chrome", JSON.stringify(chrome))
  check("An app name becomes one clean line", chrome.appName === "Google Chrome", JSON.stringify(chrome))
  check("App faders keep their target", chrome.target === "app", JSON.stringify(chrome))
  for (const [what, app] of [["a path", "..\\evil"], ["quotes", "a\"b"], ["a line break", "a\nb"], ["nothing", "  "], ["a number", 7], ["65 letters", "a".repeat(65)], ["a leading dot", ".hidden"]]) {
    const result = fader({ target: "app", app, appName: "Something" })
    check(`An app key with ${what} is dropped, and its name with it`, result.app === undefined && result.appName === undefined, JSON.stringify(result))
  }
  check("Spaces, dots, dashes and digits are kept", normalizeAppKey("Battle.net Launcher-2") === "battle.net launcher-2", normalizeAppKey("Battle.net Launcher-2"))
  const old = fader({ target: "system", inputName: "" })
  check("An old fader comes back as it was, without app fields", JSON.stringify(old) === JSON.stringify({ target: "system", inputName: "" }), JSON.stringify(old))
  check("An unknown target still falls back to the sounds fader", fader({ target: "app_x" }).target === "sounds", JSON.stringify(fader({ target: "app_x" })))
  check("An app fader's level key is its own", faderLevelKey(chrome) === "app:chrome" && faderLevelKey({ target: "obs_input", inputName: "chrome" }) === "obs:chrome", faderLevelKey(chrome))
  const library = normalizeLibrary({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: [
    { id: "a", slot: 0, control: "fader", fader: { target: "app" }, steps: [] },
    { id: "b", slot: 1, control: "fader", fader: { target: "app", app: "spotify" }, steps: [] }
  ] }] })
  const [unset, spotify] = library.profiles[0].buttons
  check("An app fader without an app is not configured yet", !isConfigured(unset) && isConfigured(spotify), `${isConfigured(unset)} ${isConfigured(spotify)}`)
  check("An app without a saved name is named from its key", appDisplayName(spotify.fader) === "Spotify" && appDisplayName(chrome) === "Google Chrome", appDisplayName(spotify.fader))
}

// -------------------------------------------------------- the Windows bridge

for (const part of ["IAudioSessionManager2", "IAudioSessionEnumerator", "IAudioSessionControl2", "ISimpleAudioVolume", "GetProcessId", "IsSystemSoundsSession", "EnumAudioEndpoints", "FileDescription", "app-get ", "app-set ", "list ", "InvariantCulture"]) {
  check(`The Windows bridge has ${part}`, BRIDGE.includes(part), "missing")
}
check("The bridge leaves out the system sounds session", /IsSystemSoundsSession\(\) == 0\) continue/.test(BRIDGE), "no skip")
check("The bridge leaves out Punchboard's own processes", /skip\.Contains\(session\.Pid\)/.test(BRIDGE) && /ParentProcessId/.test(BRIDGE), "no skip")
check("The bridge sets every session of the app, not just the first", /foreach \(var session in Sessions\(\)\) \{\s*if \(session\.Key != key\) continue;\s*Marshal\.ThrowExceptionForHR\(session\.Volume\.SetMasterVolume/.test(BRIDGE), "no loop")
check("The bridge's list is plain ASCII JSON", /c > '~'/.test(BRIDGE), "no escaping")
const parsed = parseAppList('[{"key":"chrome","name":"Google Chrome","level":0.5},{"key":"x"},{"name":"no key"},7,{"key":"caf\\u00e9","name":"Caf\\u00e9 \\"Bar\\"","level":"2"}]')
check("A list from the bridge is read entry by entry", JSON.stringify(parsed) === JSON.stringify([{ key: "chrome", name: "Google Chrome", level: 0.5 }, { key: "x", name: "x", level: 0 }, { key: "café", name: "Café \"Bar\"", level: 1 }]), JSON.stringify(parsed))
check("A list that is not JSON is an error in words", (() => { try { parseAppList("oops"); return false } catch (error) { return /could not be read/.test(error.message) } })(), "no error")

// ------------------------------------------------ one write at a time, per app

{
  const order = []
  const running = {}
  let overlapSameApp = false
  let together = false
  const set = latestWinsPerKey(async (key, level) => {
    running[key] = (running[key] ?? 0) + 1
    if (running[key] > 1) overlapSameApp = true
    if (Object.values(running).filter(Boolean).length > 1) together = true
    order.push(`${key}:${level}`)
    await wait(40)
    running[key] -= 1
    return level
  })
  await Promise.all([set("chrome", 0.1), set("chrome", 0.2), set("spotify", 0.7), set("chrome", 0.3), set("chrome", 0.4), set("spotify", 0.8)])
  await wait(150)
  const chrome = order.filter((item) => item.startsWith("chrome")).join(",")
  const spotify = order.filter((item) => item.startsWith("spotify")).join(",")
  check("One app's writes never overlap, and its newest level is set last", !overlapSameApp && chrome === "chrome:0.1,chrome:0.4", `${order.join(",")} overlap ${overlapSameApp}`)
  check("Two apps' writes do not wait for each other", together && spotify === "spotify:0.7,spotify:0.8", order.join(","))
  const single = latestWins(async (level) => level * 2)
  check("latestWins still answers with what the write returned", (await single(0.25)) === 0.5, "wrong answer")
}

// ---------------------------------------------------------- the Mac scripts

{
  for (const key of Object.keys(MAC_APPS)) {
    for (const level of [null, 0.42]) {
      const script = macVolumeScript(MAC_APPS[key].id, level)
      const lines = script.split("\n")
      const guard = lines.findIndex((line) => /application id appId is running/.test(line))
      const firstTell = lines.findIndex((line) => /^tell /.test(line))
      check(`The ${MAC_APPS[key].name} ${level === null ? "read" : "write"} script asks "is running" before sending anything`,
        guard >= 0 && firstTell > guard && lines.some((line) => line === "if not isOpen then return \"closed\"") && !/\b(activate|launch|run|open)\b/.test(script),
        script)
    }
  }
  check("A write script sets the app's volume 0..100", /set its «class pVol» to 42$/m.test(macVolumeScript("com.spotify.client", 0.42)), macVolumeScript("com.spotify.client", 0.42))
  check("A read script sets nothing", !/set its/.test(macVolumeScript("com.spotify.client", null)), macVolumeScript("com.spotify.client", null))
  check("Mac apps are found by bundle id", MAC_APPS.music.id === "com.apple.Music" && MAC_APPS.spotify.id === "com.spotify.client", JSON.stringify(MAC_APPS))
}

// -------------------------------------------------------------- stand-ins

const bin = path.join(tmp, "bin")
fs.mkdirSync(bin)
const winState = path.join(tmp, "win-state.json")
const winLog = path.join(tmp, "win.log")
const macState = path.join(tmp, "mac-state.json")
const macLog = path.join(tmp, "mac.log")

// A stand-in "powershell" speaking the bridge's protocol over a file of app
// levels. Sets are slow (80 ms), so writes pile up behind one in flight.
fs.writeFileSync(path.join(bin, "powershell"), `#!${process.execPath}
const fs = require("node:fs")
const state = ${JSON.stringify(winState)}
const log = ${JSON.stringify(winLog)}
process.stdout.write("ready\\n")
let pending = ""
process.stdin.on("data", (chunk) => {
  pending += chunk
  const lines = pending.split("\\n")
  pending = lines.pop()
  for (const line of lines) {
    const at = line.indexOf(" ")
    const id = line.slice(0, at)
    const command = line.slice(at + 1)
    fs.appendFileSync(log, command + "\\n")
    const apps = JSON.parse(fs.readFileSync(state, "utf8"))
    if (command.startsWith("list ")) {
      const list = Object.keys(apps).filter((key) => key !== "punchboard").map((key) => ({ key, name: apps[key].name, level: apps[key].level }))
      // Escaped the way the bridge does: plain ASCII.
      const json = JSON.stringify(list).replace(/[\\u007f-\\uffff]/g, (c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
      process.stdout.write(id + " ok " + json + "\\n")
    } else if (command.startsWith("app-get ")) {
      const app = apps[command.slice(8)]
      process.stdout.write(id + " ok " + (app ? String(app.level) : "none") + "\\n")
    } else if (command.startsWith("app-set ")) {
      const rest = command.slice(8)
      const level = Number(rest.slice(0, rest.indexOf(" ")))
      const key = rest.slice(rest.indexOf(" ") + 1)
      setTimeout(() => {
        const now = JSON.parse(fs.readFileSync(state, "utf8"))
        if (!now[key]) return process.stdout.write(id + " ok none\\n")
        now[key].level = level
        fs.writeFileSync(state, JSON.stringify(now))
        process.stdout.write(id + " ok " + level + "\\n")
      }, 80)
    } else {
      process.stdout.write(id + " error The stand-in only knows app commands.\\n")
    }
  }
})
`, { mode: 0o755 })

// A stand-in "osascript" that runs nothing: it reads which app the script
// names and what it sets, and answers from a file of apps, honouring the
// script's own "is running" guard.
fs.writeFileSync(path.join(bin, "osascript"), `#!${process.execPath}
const fs = require("node:fs")
const script = process.argv[process.argv.indexOf("-e") + 1] || ""
fs.appendFileSync(${JSON.stringify(macLog)}, JSON.stringify(script) + "\\n")
const id = (/set appId to "([^"]+)"/.exec(script) || [])[1]
const apps = JSON.parse(fs.readFileSync(${JSON.stringify(macState)}, "utf8"))
const app = apps[id]
if (!/application id appId is running/.test(script)) { process.stderr.write("no guard"); process.exit(2) }
if (!app || !app.running) { process.stdout.write("closed\\n"); process.exit(0) }
if (app.refuse) { process.stderr.write("execution error: Not authorized to send Apple events to " + id + ". (-1743)\\n"); process.exit(1) }
const set = /set its «class pVol» to (\\d+)/.exec(script)
if (set) { app.volume = Number(set[1]); fs.writeFileSync(${JSON.stringify(macState)}, JSON.stringify(apps)) }
process.stdout.write(String(app.volume) + "\\n")
`, { mode: 0o755 })

const writeWin = (apps) => fs.writeFileSync(winState, JSON.stringify(apps))
const writeMac = (apps) => fs.writeFileSync(macState, JSON.stringify(apps))
const failed = (promise) => promise.then(() => null, (error) => error)

if (process.platform !== "win32") {
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`
  const found = execFileSync("/usr/bin/which", ["powershell", "osascript"], { encoding: "utf8" }).trim().split("\n")
  if (!found.every((file) => file.startsWith(bin))) {
    check("The stand-ins are found first on PATH", false, found.join(", "))
  } else {
    const { appVolumeFor } = await import("../src/server/app-volume.ts")
    const { stopWindowsVolume } = await import("../src/server/win-volume.ts")

    // --- Windows, through the stand-in bridge
    writeWin({ chrome: { name: "Google Chrome", level: 0.25 }, spotify: { name: "Spotify Ä", level: 1 }, punchboard: { name: "Punchboard", level: 1 } })
    fs.writeFileSync(winLog, "")
    const windows = appVolumeFor("win32")
    const list = await windows.list()
    check("Windows: the list has every app with a session, by name, with its level", JSON.stringify(list.apps) === JSON.stringify([
      { key: "chrome", name: "Google Chrome", running: true, level: 0.25 },
      { key: "spotify", name: "Spotify Ä", running: true, level: 1 }
    ]) && list.platform === "win32", JSON.stringify(list))
    check("Windows: the list leaves out the companion's own processes", /^list \d+$/m.test(fs.readFileSync(winLog, "utf8")) && fs.readFileSync(winLog, "utf8").includes(`list ${process.pid}`), fs.readFileSync(winLog, "utf8"))
    check("Windows: a level set reads back", (await windows.write("chrome", "Google Chrome", 0.6)) === 0.6 && (await windows.read("chrome")) === 0.6, fs.readFileSync(winState, "utf8"))
    const missing = await failed(windows.write("discord", "Discord", 0.5))
    check("Windows: a write to an app with no audio session says so, kindly", missing instanceof AppNotPlayingError && missing.message === "Discord is not making any sound on this computer right now. Open it and play something first.", String(missing))
    check("Windows: an app with no audio session reads as unknown", (await windows.read("discord")) === null, "not null")
    fs.writeFileSync(winLog, "")
    const writes = await Promise.all([0.1, 0.2, 0.3, 0.4].map((level) => windows.write("chrome", "Google Chrome", level)))
    await wait(250)
    const sets = fs.readFileSync(winLog, "utf8").trim().split("\n")
    check("Windows: a drag's levels are coalesced, newest last", sets.join("|") === "app-set 0.100 chrome|app-set 0.400 chrome" && JSON.parse(fs.readFileSync(winState, "utf8")).chrome.level === 0.4, `${sets.join("|")} answered ${writes.join(",")}`)
    writeWin({})
    const empty = await windows.list()
    check("Windows: no app playing gives an empty list with a hint", empty.apps.length === 0 && /No app is playing/.test(empty.note ?? ""), JSON.stringify(empty))
    stopWindowsVolume()

    // --- macOS, through the stand-in osascript
    writeMac({ "com.spotify.client": { running: true, volume: 30 }, "com.apple.Music": { running: false, volume: 70 } })
    fs.writeFileSync(macLog, "")
    const mac = appVolumeFor("darwin")
    const macList = await mac.list()
    check("Mac: the list offers Music and Spotify, and which is running", JSON.stringify(macList.apps) === JSON.stringify([
      { key: "music", name: "Music", running: false, level: null },
      { key: "spotify", name: "Spotify", running: true, level: 0.3 }
    ]) && /only Music and Spotify/.test(macList.note ?? ""), JSON.stringify(macList))
    check("Mac: a level set reads back", (await mac.write("spotify", "Spotify", 0.55)) === 0.55 && (await mac.read("spotify")) === 0.55, fs.readFileSync(macState, "utf8"))
    const closed = await failed(mac.write("music", "Music", 0.5))
    check("Mac: a write to a closed app says so, kindly", closed instanceof AppNotPlayingError && closed.message === "Music is not open on this computer right now. Open it first, then try again.", String(closed))
    check("Mac: a closed app's volume is left alone", JSON.parse(fs.readFileSync(macState, "utf8"))["com.apple.Music"].volume === 70, fs.readFileSync(macState, "utf8"))
    check("Mac: a closed app reads as unknown", (await mac.read("music")) === null, "not null")
    const other = await failed(mac.write("chrome", "Chrome", 0.5))
    check("Mac: any other app is refused with the reason", other && /only Music and Spotify/.test(other.message), String(other))
    writeMac({ "com.spotify.client": { running: true, volume: 30, refuse: true } })
    const refused = await failed(mac.write("spotify", "Spotify", 0.5))
    check("Mac: a missing Automation permission is explained", refused && /Privacy & Security › Automation/.test(refused.message), String(refused))
    writeMac({ "com.spotify.client": { running: true, volume: 30 } })
    fs.writeFileSync(macLog, "")
    await Promise.all([0.1, 0.2, 0.3, 0.9].map((level) => mac.write("spotify", "Spotify", level)))
    await wait(400)
    const macSets = fs.readFileSync(macLog, "utf8").trim().split("\n").map((line) => (/to (\d+)\\n/.exec(line) || [])[1]).filter(Boolean)
    check("Mac: a drag's levels are coalesced, newest last", macSets.join(",") === "10,90" && JSON.parse(fs.readFileSync(macState, "utf8"))["com.spotify.client"].volume === 90, macSets.join(","))
    const everyScript = fs.readFileSync(macLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    check("Mac: every script sent asks \"is running\" first", everyScript.length > 0 && everyScript.every((script) => script.indexOf("is running") < script.indexOf("tell ")), everyScript.join("\n---\n"))

    // --- elsewhere
    const linux = appVolumeFor("linux")
    const linuxList = await linux.list()
    check("Linux: an empty list with a note", linuxList.apps.length === 0 && /Windows and macOS only/.test(linuxList.note ?? ""), JSON.stringify(linuxList))
    check("Linux: a write is refused in words", /Windows and macOS only/.test(String(await failed(linux.write("x", "X", 0.5)))), "no refusal")
  }
  process.env.PATH = savedPath
}

// ---------------------------------------------------------------- polling

{
  // A live state with one device's stream open on a stand-in response.
  const frames = []
  const res = { writeHead() {}, write(text) { if (text.startsWith("data:")) frames.push(JSON.parse(text.slice(5))) }, end() {} }
  const handlers = {}
  const req = { on(event, handler) { handlers[event] = handler } }
  const player = { playing: () => [] }
  let appLevels = null
  const live = createLive({
    accent: () => "#000000", theme: () => "studio", libraryRev: () => 1, build: () => "b", obs: () => "disconnected", obsIssue: () => null,
    soundDuration: () => null, soundFile: () => "", devicesChanged: () => appLevels?.update()
  }, player, 1)
  let library = normalizeLibrary({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: [
    { id: "a", slot: 0, control: "fader", fader: { target: "app", app: "spotify" }, steps: [] },
    { id: "b", slot: 1, control: "fader", fader: { target: "app", app: "chrome" }, steps: [] },
    { id: "c", slot: 2, control: "fader", fader: { target: "app", app: "chrome" }, steps: [] }
  ] }] })
  const levels = { spotify: 0.5, chrome: 0.2 }
  const reads = []
  let slowRead = 0
  let reading = null
  appLevels = createAppLevels({
    library: () => library,
    watched: () => live.hasDevices(),
    read: async (key) => {
      reads.push(key)
      // The level is taken now; a slow read answers it late, as a busy system would.
      const value = key in levels ? levels[key] : null
      if (slowRead) {
        reading = key
        await wait(slowRead)
        reading = null
      }
      return value
    },
    setLevels: live.setLevels,
    dropLevels: live.dropLevels,
    intervalMs: 60
  })
  appLevels.update()
  await wait(150)
  check("Polling: nothing is read while no device is connected", reads.length === 0 && !appLevels.active(), reads.join(","))
  live.openStream(req, res, "dev_1")
  await wait(30)
  const first = frames.length
  check("Polling: a device connecting starts it, reading each app once a round", reads.slice(0, 2).join(",") === "spotify,chrome" && live.levels["app:spotify"] === 0.5 && live.levels["app:chrome"] === 0.2, `${reads.join(",")} ${JSON.stringify(live.levels)}`)
  await wait(250)
  check("Polling: rounds that find nothing new broadcast nothing", frames.length === first && reads.length >= 6, `${frames.length - first} extra frames after ${reads.length} reads`)
  levels.spotify = 0.8
  await wait(120)
  check("Polling: a change made outside Punchboard goes out once", frames.length === first + 1 && frames.at(-1).levels["app:spotify"] === 0.8, `${frames.length - first} frames, ${JSON.stringify(frames.at(-1)?.levels)}`)
  delete levels.chrome
  await wait(120)
  check("Polling: an app that closes reads as unknown on the decks", frames.length === first + 2 && !("app:chrome" in frames.at(-1).levels), JSON.stringify(frames.at(-1)?.levels))
  // A deck write lands while a slow round is reading: the round's older level must not undo it.
  slowRead = 100
  const until = Date.now() + 2000
  while (reading !== "spotify" && Date.now() < until) await wait(5)
  // What /api/volume does: stamp the key, set the app, record the level.
  appLevels.noteWrite("app:spotify")
  levels.spotify = 0.3
  live.setLevels({ "app:spotify": 0.3 })
  const writeFrame = frames.length
  await wait(300)
  slowRead = 0
  check("Polling: a round never undoes a deck write made while it read",
    live.levels["app:spotify"] === 0.3 && frames.slice(writeFrame).every((frame) => frame.levels["app:spotify"] === 0.3),
    frames.slice(writeFrame - 1).map((frame) => frame.levels["app:spotify"]).join(","))
  await wait(150)
  library = normalizeLibrary({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: [] }] })
  appLevels.update()
  await wait(150)
  const afterLibrary = reads.length
  await wait(200)
  check("Polling: it stops when no fader needs it", reads.length === afterLibrary && !appLevels.active(), `${reads.length - afterLibrary} more reads`)
  library = normalizeLibrary({ version: 1, activeProfileId: "p", profiles: [{ id: "p", name: "P", buttons: [{ id: "a", slot: 0, control: "fader", fader: { target: "app", app: "spotify" }, steps: [] }] }] })
  appLevels.update()
  await wait(100)
  check("Polling: it starts again with a new app fader", reads.length > afterLibrary && appLevels.active(), `${reads.length - afterLibrary} reads`)
  handlers.close()
  await wait(150)
  const afterClose = reads.length
  await wait(200)
  check("Polling: it stops when the last device leaves", reads.length === afterClose && !appLevels.active(), `${reads.length - afterClose} more reads`)
  appLevels.stop()
}

// ------------------------------------------------- the companion's routes

if (process.platform !== "win32") process.env.PATH = `${bin}${path.delimiter}${savedPath}`
writeMac({ "com.spotify.client": { running: true, volume: 30 }, "com.apple.Music": { running: false, volume: 70 } })
const NO_SUCH_APP = "punchboard-test-no-such-app"
const library = {
  version: 1,
  activeProfileId: "main",
  profiles: [{
    id: "main", name: "Main", columns: 4, rows: 3,
    buttons: [
      { id: "spotifyFader", slot: 0, label: "Spotify", icon: "tune", color: "accent", control: "fader", fader: { target: "app", app: "spotify", appName: "Spotify" }, steps: [] },
      { id: "musicFader", slot: 1, label: "Music", icon: "tune", color: "accent", control: "fader", fader: { target: "app", app: "music", appName: "Music" }, steps: [] },
      { id: "missingFader", slot: 2, label: "Nothing", icon: "tune", color: "accent", control: "fader", fader: { target: "app", app: NO_SUCH_APP, appName: "Test App" }, steps: [] },
      { id: "unsetFader", slot: 3, label: "Unset", icon: "tune", color: "accent", control: "fader", fader: { target: "app" }, steps: [] }
    ]
  }]
}
/** The inspector's app picker in a headless Chrome, against the stand-in
    osascript: Music and Spotify offered, a pick saved and the label following. */
async function controlCenter(port) {
  const chrome = await launchChrome({ width: 1440, height: 900 })
  try {
    await chrome.goto(`http://127.0.0.1:${port}/designer`)
    await chrome.waitFor(`document.getElementById("save-text").textContent.startsWith("Saved")`)
    await chrome.evaluate(`(() => { const tile = document.querySelector('.tile[data-slot="0"]'); tile.focus(); tile.click() })()`)
    await chrome.waitFor(`(document.getElementById("fader-app")?.options.length ?? 0) > 2`)
    const shown = await chrome.evaluate(`(() => {
      const select = document.getElementById("fader-app")
      return { target: document.getElementById("fader-target").value, value: select.value, options: [...select.options].map((o) => o.textContent),
        help: select.closest(".field").querySelector(".field-help").textContent, typed: document.getElementById("fader-app-typed").closest(".app-volume-row").hidden }
    })()`)
    check("Control Center: an app fader shows App volume and its app", shown.target === "app" && shown.value === "spotify", JSON.stringify(shown))
    check("Control Center: Music and Spotify are offered, Music as not running", JSON.stringify(shown.options) === '["Choose an app…","Music (not running)","Spotify"]', JSON.stringify(shown.options))
    check("Control Center: the Mac help says why only those two", shown.help.startsWith("macOS has no per-app volume, so only Music and Spotify can be controlled."), shown.help)
    check("Control Center: no typed process name on a Mac", shown.typed === true, JSON.stringify(shown))
    await chrome.evaluate(`(() => { const select = document.getElementById("fader-app"); select.value = "music"; select.dispatchEvent(new Event("change")) })()`)
    await chrome.waitFor(`document.getElementById("save-text").textContent.startsWith("Saved")`, 8000)
    await wait(300)
    const button = (await request({ path: "/api/library" })).json.profiles[0].buttons[0]
    check("Control Center: picking an app saves it, and the label follows the app", button.fader.app === "music" && button.fader.appName === "Music" && button.label === "Music", JSON.stringify(button))
    check("Control Center: no script errors", chrome.errors.length === 0, chrome.errors.join("\n"))
  } finally {
    await chrome.close()
  }
}

const companion = startCompanion()
const request = companion.request
const setLevel = (buttonId, level) => request({ method: "POST", path: "/api/volume", headers: JSON_TYPE, body: JSON.stringify(level === undefined ? { profileId: "main", buttonId } : { profileId: "main", buttonId, level }) })
const macVolumes = () => JSON.parse(fs.readFileSync(macState, "utf8"))

try {
  await companion.ready
  const rev = (await request({ path: "/api/library" })).headers["x-library-rev"]
  const saved = await request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: JSON.stringify(library) })
  check("Routes: the app fader deck saves", saved.status === 200, saved.text)
  const stored = (await request({ path: "/api/library" })).json
  check("Routes: app faders are stored with their app", stored.profiles[0].buttons[0].fader.app === "spotify" && stored.profiles[0].buttons[3].fader.app === undefined, JSON.stringify(stored.profiles[0].buttons.map((button) => button.fader)))

  fs.writeFileSync(macLog, "")
  for (const [what, level] of [["missing", undefined], ["null", null], ["text", "loud"], ["a number in a string", "0.5"], ["true", true]]) {
    const r = await setLevel("spotifyFader", level)
    check(`Routes: an app fader refuses a level that is ${what}`, r.status === 400, `${r.status} ${r.text}`)
  }
  check("Routes: a refused level never reaches the app", !fs.readFileSync(macLog, "utf8").includes("set its"), fs.readFileSync(macLog, "utf8"))
  let r = await setLevel("unsetFader", 0.5)
  check("Routes: an app fader with no app asks for one", r.status === 400 && r.json?.error === "Choose the app first.", r.text)

  r = await request({ path: "/api/apps/audio" })
  check("Routes: the app list answers this computer", r.status === 200 && Array.isArray(r.json?.apps) && r.json.platform === process.platform, r.text)
  if (LAN) {
    const remote = await request({ host: LAN, path: "/api/apps/audio" })
    check("Routes: the app list is refused to another device", remote.status === 403, `${remote.status} ${remote.text}`)
  }

  if (process.platform === "darwin") {
    check("Routes (Mac): Music and Spotify are listed, with which is running", JSON.stringify(r.json.apps.map((app) => [app.key, app.running])) === '[["music",false],["spotify",true]]', r.text)
    r = await setLevel("spotifyFader", 0.5)
    check("Routes (Mac): a Spotify fader sets Spotify's volume", r.status === 200 && r.json.levels["app:spotify"] === 0.5 && macVolumes()["com.spotify.client"].volume === 50, `${r.text} ${JSON.stringify(macVolumes())}`)
    r = await setLevel("musicFader", 0.5)
    check("Routes (Mac): a write to closed Music fails with the friendly message", r.status === 400 && r.json?.error === "Music is not open on this computer right now. Open it first, then try again." && macVolumes()["com.apple.Music"].volume === 70, r.text)
    r = await request({ method: "POST", path: "/api/volume/sync", headers: JSON_TYPE, body: JSON.stringify({ profileId: "main" }) })
    check("Routes (Mac): syncing reads Spotify's level and leaves closed Music unknown", r.status === 200 && r.json.levels["app:spotify"] === 0.5 && !("app:music" in r.json.levels), r.text)
    if (findChrome()) await controlCenter(await companion.ready)
    else console.log("SKIP  the Control Center's app picker: Chrome is not installed (set CHROME_PATH)")
  } else if (process.platform === "win32") {
    // The real bridge, asked about an app that cannot exist: nothing changes.
    r = await setLevel("missingFader", 0.5)
    check("Routes (Windows): a write to an app with no audio session fails with the friendly message", r.status === 400 && r.json?.error === "Test App is not making any sound on this computer right now. Open it and play something first.", r.text)
  } else {
    check("Routes (elsewhere): the list is empty, with a note", r.json.apps.length === 0 && /Windows and macOS only/.test(r.json.note ?? ""), r.text)
    r = await setLevel("missingFader", 0.5)
    check("Routes (elsewhere): a write is refused in words", r.status === 400 && /Windows and macOS only/.test(r.json?.error ?? ""), r.text)
  }
  await companion.stop()
} catch (error) {
  check("The app volume checks ran to the end", false, error?.stack || String(error))
  await companion.stop()
} finally {
  process.env.PATH = savedPath
  companion.cleanup()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
