// App volume faders: the model keeps an app key safe, and the companion's
// routes refuse what they must and set what they should. Every volume here
// belongs to a stand-in: the companion answers from files in its test folder
// (server/src/test_system.rs), so no real app's volume, nor the computer's,
// is ever touched, and Music and Spotify are never started. What the
// companion does inside (the Mac scripts, one write at a time per app,
// polling) is tested in server/src/audio.
//   node tests/app-volume.test.mjs
import "./english.mjs"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { appDisplayName, faderLevelKey, isConfigured, normalizeAppKey, normalizeButton, normalizeLibrary } from "../src/shared/model.ts"
import { findChrome, launchChrome } from "./chrome.mjs"
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-app-volume-"))



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

// -------------------------------------------------------------- stand-ins

// The companion runs no osascript and touches no mixer here: it answers from
// these files in its test folder (server/src/test_system.rs). Music and
// Spotify on a Mac, and what would have been sent to them:
const macState = path.join(tmp, "mac-apps.json")
const macLog = path.join(tmp, "osascript.jsonl")
// The mixer on Windows and Linux, and every change asked of it:
const mixerState = path.join(tmp, "volume.json")
const mixerLog = path.join(tmp, "volume.jsonl")

const writeMac = (apps) => fs.writeFileSync(macState, JSON.stringify(apps))
const writeMixer = (apps) => fs.writeFileSync(mixerState, JSON.stringify({ main: 0.5, apps }))
const mixer = () => JSON.parse(fs.readFileSync(mixerState, "utf8")).apps
const mixerAsked = () => (fs.existsSync(mixerLog) ? fs.readFileSync(mixerLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [])

// ------------------------------------------------- the companion's routes

writeMac({ "com.spotify.client": { running: true, volume: 30 }, "com.apple.Music": { running: false, volume: 70 } })
writeMixer({ spotify: { name: "Spotify", level: 0.3 } })
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
    Music and Spotify: both offered, a pick saved and the label following. */
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

// The first-run tour would cover the Control Center; it has its own tests.
const companion = startCompanion({ config: { tourShown: true }, env: { PUNCHBOARD_TEST_SYSTEM: tmp } })
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
  } else if (process.platform === "linux") {
    // The sound server's mixer, as volume.json has it: Spotify is playing, the test app is not.
    check("Routes (Linux): the refused levels never reached the mixer", mixerAsked().length === 0, JSON.stringify(mixerAsked()))
    check("Routes (Linux): the apps playing sound are listed by name, with their level", JSON.stringify(r.json.apps) === '[{"key":"spotify","name":"Spotify","running":true,"level":0.3}]' && !/only/.test(r.json.note ?? ""), r.text)
    r = await setLevel("spotifyFader", 0.5)
    check("Routes (Linux): a Spotify fader sets Spotify's volume", r.status === 200 && r.json.levels["app:spotify"] === 0.5 && mixer().spotify.level === 0.5, `${r.text} ${JSON.stringify(mixer())}`)
    r = await setLevel("missingFader", 0.5)
    check("Routes (Linux): a write to an app that is not playing fails with the friendly message, and nothing is set", r.status === 400 && r.json?.error === "Test App is not making any sound on this computer right now. Open it and play something first." && JSON.stringify(mixer()) === '{"spotify":{"name":"Spotify","level":0.5}}', `${r.text} ${JSON.stringify(mixer())}`)
  }
  await companion.stop()
} catch (error) {
  check("The app volume checks ran to the end", false, error?.stack || String(error))
  await companion.stop()
} finally {
  companion.cleanup()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
