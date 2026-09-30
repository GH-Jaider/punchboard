// End-to-end checks for buttons and faders against a fake OBS: pickers get
// OBS's real names, tiles follow changes made in OBS itself, buttons on the
// same thing share one state, and a failing macro says which step failed.
//   node tests/actions.test.mjs
import { checker, JSON_TYPE, LAN, startCompanion } from "./companion.mjs"
import { startFakeObs } from "./fake-obs.mjs"

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const fake = await startFakeObs()
// The LAN address, not 127.0.0.1: a local address makes the companion prefer
// the settings of a real OBS on this computer, if there is one.
const companion = startCompanion({ config: { obs: { address: `ws://${LAN}:${fake.port}`, password: "", source: "manual" } } })
const request = companion.request

const step = (type, fields = {}) => ({ id: `s_${type}_${Math.random().toString(36).slice(2)}`, type, delayMs: 0, ...fields })
const press = (id, steps, slot) => ({ id, slot, label: id, icon: "bolt", color: "accent", control: "press", steps })

const library = {
  version: 1,
  activeProfileId: "main",
  profiles: [
    {
      id: "main", name: "Main", columns: 4, rows: 3,
      buttons: [
        press("intro", [step("obs_scene", { sceneName: "Intro" })], 0),
        press("mainScene", [step("obs_scene", { sceneName: "Main" })], 1),
        press("mic", [step("obs_toggle_mute", { sourceName: "Mic" })], 2),
        press("cam", [step("obs_toggle_source", { sceneName: "Main", sourceName: "Camera" })], 3),
        press("blur", [step("obs_toggle_filter", { sourceName: "Camera", filterName: "Blur" })], 4),
        press("vcam", [step("obs_toggle_virtualcam")], 5),
        press("replay", [step("obs_save_replay")], 6),
        press("studio", [step("obs_studio_transition")], 7),
        press("broken", [step("stop_sounds"), step("obs_scene", { sceneName: "Nope" }), step("obs_toggle_virtualcam")], 8),
        press("toMusic", [step("stop_sounds"), step("go_to_deck", { profileId: "music" })], 9),
        { ...press("break", [step("obs_scene", { sceneName: "BRB" }), step("obs_toggle_mute", { sourceName: "Mic", set: "on" })], 11),
          offSteps: [step("obs_scene", { sceneName: "Main" }), step("obs_toggle_mute", { sourceName: "Mic", set: "off" })] },
        { id: "micFader", slot: 10, label: "Mic", icon: "tune", color: "accent", control: "fader", fader: { target: "obs_input", inputName: "Mic" }, steps: [] }
      ]
    },
    { id: "music", name: "Music", columns: 4, rows: 3, buttons: [press("mic2", [step("obs_toggle_mute", { sourceName: "Mic" })], 0)] }
  ]
}

const status = async () => (await request({ path: "/api/status" })).json
const pressButton = (buttonId, profileId = "main") =>
  request({ method: "POST", path: "/api/press", headers: JSON_TYPE, body: JSON.stringify({ profileId, buttonId }) })

async function until(what, test, ms = 4000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = await status()
    if (test(last)) return last
    await wait(80)
  }
  throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last?.toggles)} ${JSON.stringify(last?.levels)}`)
}

async function main() {
  if (!LAN) throw new Error("No LAN address on this machine.")
  await companion.ready
  await until("the OBS link", (s) => s.obs === "connected")
  // A first start comes with the starter decks, every button complete.
  const first = (await request({ path: "/api/library" })).json
  check("A fresh install starts with the starter decks", first.profiles.map((p) => p.name).join(",") === "Streaming,Music,Shortcuts,Trackpad", first.profiles.map((p) => p.name).join(","))
  const buttons = first.profiles.flatMap((p) => p.buttons)
  const broken = buttons.filter((b) => !b.glyph || (b.control === "press" && b.steps.some((st) => st.type === "none" || (st.type === "hotkey" && !st.keys))))
  check("Every starter button has an icon and a working action", buttons.length === 30 && broken.length === 0, JSON.stringify(broken.map((b) => b.label)))
  check("The trackpad starter is a trackpad deck", Boolean(first.profiles[3]?.trackpad), JSON.stringify(first.profiles[3]))
  const saved = await request({ method: "PUT", path: "/api/library", headers: JSON_TYPE, body: JSON.stringify(library) })
  check("Deck with every new action saves", saved.status === 200, saved.text)

  // --- names for the pickers
  const names = (await request({ path: "/api/obs/names" })).json
  check("Scenes listed in OBS's own order", JSON.stringify(names.scenes) === '["Intro","Main","BRB"]', JSON.stringify(names.scenes))
  check("Sources listed per scene, top first", JSON.stringify(names.sceneItems.Main) === '["Mic","Camera"]', JSON.stringify(names.sceneItems))
  check("Only inputs with audio offered for mute and faders", JSON.stringify(names.audioInputs) === '["Mic","Desktop Audio"]', JSON.stringify(names.audioInputs))
  check("Filters listed per source", JSON.stringify(names.filters) === '{"Mic":["Voice Changer"],"Camera":["Blur"]}', JSON.stringify(names.filters))

  // --- the state OBS is in, read at connection
  let s = await until("initial states", (x) => x.toggles["scene:Main"] === true && x.toggles["source:Main\nCamera"] === true && x.levels["obs:Mic"] === 1)
  check("Live scene lit from the start", s.toggles["scene:Main"] === true, JSON.stringify(s.toggles))
  check("Visible source lit from the start", s.toggles["source:Main\nCamera"] === true, JSON.stringify(s.toggles))
  check("Mute, filter, stream read as off", s.toggles["mute:Mic"] === false && s.toggles["filter:Camera\nBlur"] === false && s.toggles.stream === false, JSON.stringify(s.toggles))
  check("Fader starts at OBS's volume", s.levels["obs:Mic"] === 1, JSON.stringify(s.levels))

  // --- pressing
  let r = await pressButton("intro")
  s = await status()
  check("Switching scene lights the new one and clears the old", r.status === 200 && s.toggles["scene:Intro"] === true && s.toggles["scene:Main"] === false, JSON.stringify(s.toggles))
  r = await pressButton("blur")
  check("Filter button turns the filter on in OBS", r.json?.active === true && fake.obs.inputs.Camera.filters.Blur === true, r.text)
  r = await pressButton("vcam")
  check("Virtual camera starts", r.json?.active === true && fake.obs.outputs.virtualcam === true, r.text)
  r = await pressButton("cam")
  s = await status()
  check("Hiding a source turns its tile off", r.json?.active === false && s.toggles["source:Main\nCamera"] === false, r.text)

  // --- changes made in OBS itself
  fake.obs.inputs.Mic.muted = true
  fake.emit("InputMuteStateChanged", { inputName: "Mic", inputMuted: true })
  s = await until("the mute from OBS", (x) => x.toggles["mute:Mic"] === true)
  check("Muting in OBS lights the mic button", s.toggles["mute:Mic"] === true, JSON.stringify(s.toggles))
  r = await pressButton("mic2", "music")
  s = await status()
  check("A second button on the same mic, on another deck, shares the state", r.json?.active === false && s.toggles["mute:Mic"] === false, `${r.text} ${JSON.stringify(s.toggles)}`)
  fake.obs.currentScene = "BRB"
  fake.emit("CurrentProgramSceneChanged", { sceneName: "BRB" })
  s = await until("the scene from OBS", (x) => x.toggles["scene:BRB"] === true)
  check("Changing scene in OBS moves the light", s.toggles["scene:Intro"] === false, JSON.stringify(s.toggles))
  fake.emit("InputVolumeChanged", { inputName: "Mic", inputVolumeMul: 0.125, inputVolumeDb: -18 })
  s = await until("the volume from OBS", (x) => Math.abs((x.levels["obs:Mic"] ?? 0) - 0.5) < 0.001)
  check("Moving OBS's mixer fader moves the deck fader", Math.abs(s.levels["obs:Mic"] - 0.5) < 0.001, JSON.stringify(s.levels))
  fake.emit("StreamStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED" })
  s = await until("the stream from OBS", (x) => x.toggles.stream === true)
  check("Going live from OBS lights stream buttons", s.toggles.stream === true, JSON.stringify(s.toggles))

  // --- a two-state macro, with steps that set rather than flip
  const saved2 = (await request({ path: "/api/library" })).json
  check("A second list survives saving", saved2.profiles[0].buttons.find((b) => b.id === "break")?.offSteps?.length === 2, "offSteps lost")
  fake.obs.inputs.Mic.muted = true
  fake.emit("InputMuteStateChanged", { inputName: "Mic", inputMuted: true })
  await until("the mic muted in OBS", (x) => x.toggles["mute:Mic"] === true)
  r = await pressButton("break")
  s = await status()
  check("First press runs the first list and lights the button", r.json?.active === true && s.toggles["switch:break"] === true && fake.obs.currentScene === "BRB", `${r.text} ${JSON.stringify(s.toggles)}`)
  check("\"Mute\" keeps a muted mic muted instead of flipping it", fake.obs.inputs.Mic.muted === true, "the mic was unmuted")
  r = await pressButton("break")
  s = await status()
  check("Second press runs the second list and turns the button off", r.json?.active === false && s.toggles["switch:break"] === false && fake.obs.currentScene === "Main", `${r.text} ${JSON.stringify(s.toggles)}`)
  check("\"Unmute\" unmutes", fake.obs.inputs.Mic.muted === false, "still muted")
  r = await pressButton("break")
  check("Third press runs the first list again", r.json?.active === true && fake.obs.currentScene === "BRB", r.text)

  // --- helpful failures
  r = await pressButton("replay")
  check("Save replay explains a stopped buffer", r.status === 400 && /replay buffer is off/i.test(r.json?.error ?? ""), r.text)
  fake.obs.outputs.replay = true
  fake.emit("ReplayBufferStateChanged", { outputActive: true, outputState: "" })
  await until("the replay buffer", (x) => x.toggles.replaybuffer === true)
  r = await pressButton("replay")
  check("Save replay saves once the buffer runs", r.status === 200 && fake.obs.calls.includes("SaveReplayBuffer"), r.text)
  r = await pressButton("studio")
  check("Studio transition explains Studio Mode is off", r.status === 400 && /Studio Mode is off/.test(r.json?.error ?? ""), r.text)
  const before = fake.obs.outputs.virtualcam
  r = await pressButton("broken")
  check("A failing macro names the step", r.status === 400 && /^Step 2 of 3 \(Switch scene\)/.test(r.json?.error ?? ""), r.text)
  check("Steps after a failure do not run", fake.obs.outputs.virtualcam === before, "virtual camera toggled")

  // --- deck switching
  r = await pressButton("toMusic")
  check("Go to another deck tells the device which deck", r.status === 200 && r.json?.deckId === "music", r.text)

  // --- OBS going away
  await fake.close()
  s = await until("the link to drop", (x) => x.obs !== "connected")
  check("OBS states clear when OBS closes, so nothing stays falsely lit", Object.keys(s.toggles).every((key) => key.startsWith("switch:")), JSON.stringify(s.toggles))
  check("A two-state macro remembers it is on", s.toggles["switch:break"] === true, JSON.stringify(s.toggles))
  const empty = (await request({ path: "/api/obs/names" })).json
  check("Pickers fall back to typing without OBS", empty.connected === false && empty.scenes.length === 0, JSON.stringify(empty))
}

main()
  .catch((error) => { console.error(error); tally.fail++ })
  .finally(async () => {
    await companion.stop()
    await fake.close().catch(() => {})
    companion.cleanup()
    console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
    process.exit(tally.fail ? 1 : 0)
  })
