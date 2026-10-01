// The OBS link under stress, against fake OBSes that misbehave: settings
// changed while an attempt is out, an OBS that never greets, a request OBS
// never answers, events for things no deck shows, bursts of meters and of
// scene edits.
//   node tests/obs.test.mjs
import http from "node:http"
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"
import { startFakeObs } from "./fake-obs.mjs"

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A: answers late, the old settings. B: a healthy OBS, the new settings.
// C: accepts the connection and never says a word.
const slow = await startFakeObs({ helloDelayMs: 1500 })
const good = await startFakeObs()
const mute = await startFakeObs({ helloDelayMs: null })
const address = (fake) => `ws://${LAN}:${fake.port}`
// LAN addresses, never 127.0.0.1: a local address makes the companion prefer
// the settings of a real OBS on this computer, if there is one.
const companion = startCompanion({ config: { obs: { address: address(slow), password: "", source: "manual" } } })
const request = companion.request

const step = (type, fields = {}) => ({ id: `s_${type}_${Math.random().toString(36).slice(2)}`, type, delayMs: 0, ...fields })
const press = (id, steps, slot) => ({ id, slot, label: id, icon: "bolt", color: "accent", control: "press", steps })
const library = {
  version: 1,
  activeProfileId: "main",
  profiles: [{
    id: "main", name: "Main", columns: 4, rows: 2,
    buttons: [
      press("intro", [step("obs_scene", { sceneName: "Intro" })], 0),
      press("mainScene", [step("obs_scene", { sceneName: "Main" })], 1),
      press("mic", [step("obs_toggle_mute", { sourceName: "Mic" })], 2),
      press("cam", [step("obs_toggle_source", { sceneName: "Main", sourceName: "Camera" })], 3),
      { id: "micFader", slot: 4, label: "Mic", icon: "tune", color: "accent", control: "fader", fader: { target: "obs_input", inputName: "Mic" }, steps: [] }
    ]
  }]
}

const status = async () => (await request({ path: "/api/status" })).json
const pressButton = (buttonId) => request({ method: "POST", path: "/api/press", headers: JSON_TYPE, body: JSON.stringify({ profileId: "main", buttonId }) })
const putSettings = (body) => request({ method: "PUT", path: "/api/settings", headers: JSON_TYPE, body: JSON.stringify(body) })

async function until(what, test, ms = 4000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await status()
    if (test(last)) return last
    await wait(50)
  }
  throw new Error(`Timed out waiting for ${what}: ${last?.obs} ${JSON.stringify(last?.toggles)} ${JSON.stringify(last?.levels)}`)
}

/** Follows the live stream like a deck: snapshots and meter events. */
function listen() {
  const frames = { snapshots: 0, meters: [] }
  const req = http.get({ host: "127.0.0.1", port: companion.port, path: "/api/events", headers: { Host: `127.0.0.1:${companion.port}` } }, (res) => {
    let buffer = ""
    res.on("data", (chunk) => {
      buffer += chunk
      let end
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split("\n").find((line) => line.startsWith("data: "))
        if (!data) continue
        if (frame.startsWith("event: meters")) frames.meters.push(JSON.parse(data.slice(6)).levels)
        else frames.snapshots += 1
      }
    })
  })
  req.on("error", () => {})
  return { frames, close: () => req.destroy() }
}

async function main() {
  if (!LAN) throw new Error("No LAN address on this machine.")
  await companion.ready
  const saved = await request({ method: "PUT", path: "/api/library", headers: JSON_TYPE, body: JSON.stringify(library) })
  check("Test deck saves", saved.status === 200, saved.text)

  // --- new settings while the old attempt is still out
  await wait(200)
  check("The first attempt is waiting on the slow OBS", slow.clients() === 1 && (await status()).obs !== "connected", `clients ${slow.clients()}`)
  let r = await putSettings({ obsAddress: address(good) })
  check("New OBS address saves", r.status === 200, r.text)
  await until("the new OBS", (x) => x.obs === "connected")
  await wait(1800) // past the slow OBS's greeting
  let s = await status()
  check("The old attempt does not take over when it finishes", s.obs === "connected" && slow.clients() === 0 && good.clients() === 1, `slow ${slow.clients()} good ${good.clients()} ${s.obs}`)
  r = await pressButton("intro")
  check("Presses go to the new OBS", r.status === 200 && good.obs.currentScene === "Intro" && !slow.obs.calls.includes("SetCurrentProgramScene"), r.text)
  check("The link says it connected only to the new OBS", !companion.log().includes(`Connected to OBS at ${address(slow)}`), companion.log())
  await pressButton("mainScene")

  // --- address checks
  r = await putSettings({ obsAddress: "192.168.1.20:4455" })
  check("An address without ws:// is refused, with a hint", r.status === 400 && /ws:\/\//.test(r.json?.error ?? ""), r.text)
  r = await putSettings({ obsAddress: "ws:// spaced" })
  check("An address with no computer is refused", r.status === 400, r.text)
  let settings = (await request({ path: "/api/settings" })).json
  check("A refused address changes nothing", settings.obsAddress === address(good) && settings.obsSource === "manual", JSON.stringify(settings))
  r = await putSettings({ obsAddress: `  ${address(good)}\n` })
  settings = (await request({ path: "/api/settings" })).json
  s = await status()
  check("An address is saved trimmed, and the same address keeps the link", r.status === 200 && settings.obsAddress === address(good) && s.obs === "connected", JSON.stringify(settings))

  // --- only what the decks show
  s = await until("initial states", (x) => x.toggles["scene:Main"] === true && x.toggles["source:Main\nCamera"] === true && x.levels["obs:Mic"] === 1)
  const stream = listen()
  await wait(300)
  const before = stream.frames.snapshots
  for (let i = 0; i < 20; i += 1) {
    good.emit("InputVolumeChanged", { inputName: "Desktop Audio", inputVolumeMul: i / 20, inputVolumeDb: 0 })
    good.emit("InputMuteStateChanged", { inputName: "Desktop Audio", inputMuted: i % 2 === 0 })
    good.emit("SourceFilterEnableStateChanged", { sourceName: "Mic", filterName: "Voice Changer", filterEnabled: i % 2 === 0 })
  }
  await wait(300)
  s = await status()
  check("Events for inputs and filters no deck shows are not kept", !("mute:Desktop Audio" in s.toggles) && !("filter:Mic\nVoice Changer" in s.toggles) && !("obs:Desktop Audio" in s.levels), JSON.stringify([s.toggles, s.levels]))
  check("…nor sent to the decks", stream.frames.snapshots === before, `${stream.frames.snapshots - before} snapshots`)
  good.emit("InputMuteStateChanged", { inputName: "Mic", inputMuted: true })
  await until("the mic muted in OBS", (x) => x.toggles["mute:Mic"] === true)
  check("Events for what a deck shows still arrive", stream.frames.snapshots > before, "no snapshot")
  good.emit("InputMuteStateChanged", { inputName: "Mic", inputMuted: false })

  good.obs.currentScene = "BRB"
  good.emit("CurrentProgramSceneChanged", { sceneName: "BRB" })
  s = await until("the scene button to go off", (x) => x.toggles["scene:Main"] === false)
  check("Going to a scene no button shows turns the scene buttons off", !("scene:BRB" in s.toggles) && s.toggles["scene:Intro"] !== true, JSON.stringify(s.toggles))
  good.obs.currentScene = "Main"
  good.emit("CurrentProgramSceneChanged", { sceneName: "Main" })
  await until("the Main scene", (x) => x.toggles["scene:Main"] === true)

  // --- meters: the end of a burst is sent too
  const meter = (mul) => good.emit("InputVolumeMeters", { inputs: [{ inputName: "Mic", inputLevelsMul: [[mul, mul, mul]] }, { inputName: "Desktop Audio", inputLevelsMul: [[1, 1, 1]] }] })
  await wait(150)
  meter(1)
  await wait(10)
  meter(0)
  await wait(250)
  const lastMeters = stream.frames.meters.at(-1)
  check("The last meter values of a burst reach the decks", lastMeters?.["obs:Mic"] === 0 && stream.frames.meters.length >= 2, JSON.stringify(stream.frames.meters))
  check("Meters only carry inputs a fader shows", stream.frames.meters.every((levels) => !("obs:Desktop Audio" in levels)), JSON.stringify(stream.frames.meters))
  stream.close()

  // --- scene edits: one read for a burst, and events win over a slow read
  await wait(300)
  let reads = good.obs.calls.filter((call) => call === "GetCurrentProgramScene").length
  for (let i = 0; i < 12; i += 1) good.emit("SceneItemCreated", { sceneName: "Main", sourceName: `x${i}`, sceneItemId: 100 + i, sceneItemIndex: i })
  await wait(500)
  reads = good.obs.calls.filter((call) => call === "GetCurrentProgramScene").length - reads
  check("A burst of scene edits is read back once", reads === 1, `${reads} reads`)

  good.obs.delays.GetInputMute = 500
  good.emit("SceneItemRemoved", { sceneName: "Main", sourceName: "x0", sceneItemId: 100 })
  await wait(250) // the read is out, its answer (not muted) on the way
  good.obs.inputs.Mic.muted = true
  good.emit("InputMuteStateChanged", { inputName: "Mic", inputMuted: true })
  await wait(700)
  s = await status()
  check("A slow read does not undo a newer change from OBS", s.toggles["mute:Mic"] === true, JSON.stringify(s.toggles))
  delete good.obs.delays.GetInputMute

  // --- a renamed source does not stay lit
  good.obs.scenes.Main[0].source = "Webcam"
  good.emit("InputNameChanged", { oldInputName: "Camera", inputName: "Webcam" })
  s = await until("the renamed source to go off", (x) => x.toggles["source:Main\nCamera"] === false)
  check("A source OBS no longer has shows as off", s.toggles["source:Main\nCamera"] === false, JSON.stringify(s.toggles))
  good.obs.scenes.Main[0].source = "Camera"

  // --- a request OBS never answers
  good.obs.stalled.add("SetCurrentProgramScene")
  let started = Date.now()
  r = await pressButton("intro")
  let took = Date.now() - started
  s = await status()
  check("A press OBS never answers fails in seconds, with a reason", r.status === 400 && took < 7000 && /did not answer/i.test(r.json?.error ?? ""), `${took} ms ${r.text}`)
  check("…and the link is dropped", s.obs !== "connected" && good.clients() === 0, `${s.obs} clients ${good.clients()}`)
  good.obs.stalled.clear()
  s = await until("the link to come back", (x) => x.obs === "connected", 6000)
  r = await pressButton("intro")
  check("The link comes back and presses work again", r.status === 200 && good.obs.currentScene === "Intro", r.text)

  // --- an OBS that never greets
  r = await putSettings({ obsAddress: address(mute) })
  s = await until("the old link to go", (x) => x.obs !== "connected")
  check("OBS fader levels clear when OBS goes away", !Object.keys(s.levels).some((key) => key.startsWith("obs:")), JSON.stringify(s.levels))
  started = Date.now()
  r = await pressButton("intro")
  took = Date.now() - started
  check("A press against an OBS that never answers fails within the connect timeout", r.status === 400 && took < 8000 && /did not answer/i.test(r.json?.error ?? ""), `${took} ms ${r.text}`)
  s = await status()
  check("The link reports OBS unreachable", s.obs === "disconnected" && s.obsIssue === "unreachable", `${s.obs} ${s.obsIssue}`)
  check("The silent connection is closed, not left open", mute.clients() <= 1, `clients ${mute.clients()}`)
}

main()
  .catch((error) => { console.error(error); tally.fail++ })
  .finally(async () => {
    await companion.stop()
    for (const fake of [slow, good, mute]) await fake.close().catch(() => {})
    companion.cleanup()
    console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
    process.exit(tally.fail ? 1 : 0)
  })
