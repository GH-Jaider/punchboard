// The deck file and the model: damaged and too-new files are never replaced
// by the starter decks, a failed write changes nothing, saves need a
// revision, and repeated ids, slots and odd values are repaired. Also the
// links people type.
//   node tests/library.test.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checker, JSON_TYPE, startCompanion } from "./companion.mjs"
import { normalizeLibrary } from "../src/shared/model.ts"
import { iconSvg, safeGlyph } from "../src/shared/icons.ts"
import { webAddress } from "../src/shared/links.ts"
import { writeJsonAtomic } from "../src/server/store.ts"

const { check, tally } = checker()

const deck = (name, buttons = []) => ({ id: name.toLowerCase(), name, columns: 4, rows: 3, buttons })
const press = (id, slot, steps = [{ id: `s_${id}`, type: "none", delayMs: 0 }]) => ({ id, slot, label: id, icon: "zap", color: "accent", control: "press", steps })
const mine = { version: 1, activeProfileId: "mine", profiles: [deck("Mine", [press("a", 0)])] }

const companions = []
async function withCompanion(options, run) {
  const companion = startCompanion(options)
  companions.push(companion)
  try {
    await companion.ready
    await run(companion)
  } finally {
    await companion.stop()
    companion.cleanup()
  }
}
const notice = (response) => decodeURIComponent(response.headers["x-library-notice"] ?? "")
const names = (library) => library.profiles.map((p) => p.name).join(",")
const decksDir = (companion) => path.join(companion.dataDir, "decks")

function unitChecks() {
  // --- repairs
  const repaired = normalizeLibrary({
    version: 1, activeProfileId: "one",
    profiles: [
      deck("One", [press("x", 0), press("x", 1), press("y", 1), press("z", 2)]),
      { ...deck("One"), name: "Copy", buttons: [press("x", 0)] }
    ]
  })
  const ids = repaired.profiles.flatMap((p) => p.buttons.map((b) => b.id))
  check("Repeated deck ids are made unique", repaired.profiles[0].id === "one" && repaired.profiles[1].id !== "one", JSON.stringify(repaired.profiles.map((p) => p.id)))
  check("Repeated button ids are made unique, across decks too", new Set(ids).size === ids.length && ids[0] === "x", JSON.stringify(ids))
  const slots = repaired.profiles[0].buttons.map((b) => b.slot)
  check("Two buttons in one slot: the later one moves to a free slot", JSON.stringify(slots) === "[0,1,3,2]", JSON.stringify(slots))
  const full = normalizeLibrary({ version: 1, activeProfileId: "f", profiles: [{ ...deck("F"), columns: 2, rows: 1, buttons: [press("p", 0), press("q", 1), press("r", 1)] }] })
  check("With the grid full, it is parked past the grid", full.profiles[0].buttons[2].slot === 2, JSON.stringify(full.profiles[0].buttons.map((b) => b.slot)))
  const again = normalizeLibrary(repaired)
  check("A repaired deck stays as it is", JSON.stringify(again) === JSON.stringify(repaired), "changed on the second pass")

  // --- values
  const button = (fields) => normalizeLibrary({ version: 1, activeProfileId: "d", profiles: [deck("D", [{ ...press("b", 0), ...fields }])] }).profiles[0].buttons[0]
  check("An icon named \"constructor\" falls back to the default", button({ icon: "constructor" }).icon === "radio" && button({ icon: "__proto__" }).icon === "radio" && button({ icon: "mic" }).icon === "mic", button({ icon: "constructor" }).icon)
  check("iconSvg ignores inherited names", iconSvg("constructor") === iconSvg("radio") && iconSvg("toString") === iconSvg("radio"), "")
  check("Glyph names are lowercased, not stripped", safeGlyph({ name: "Mic_Off", viewBox: "0 0 24 24", paths: ["M0 0L1 1"] })?.name === "mic_off", JSON.stringify(safeGlyph({ name: "Mic_Off", viewBox: "0 0 24 24", paths: ["M0 0L1 1"] })))
  const stepOf = (fields) => button({ steps: [{ id: "s", delayMs: 0, ...fields }] }).steps[0]
  check("Sound 8.9 is sound 8", stepOf({ type: "play_sound", soundId: 8.9 }).soundId === 8 && stepOf({ type: "play_sound", soundId: 9 }).soundId === undefined && stepOf({ type: "play_sound", soundId: 0.5 }).soundId === undefined, JSON.stringify(stepOf({ type: "play_sound", soundId: 8.9 })))
  check("Key combinations are stored in their canonical form", stepOf({ type: "hotkey", keys: "Shift + CTRL+K" }).keys === "ctrl+shift+k" && stepOf({ type: "hotkey", keys: "ctrl+nope" }).keys === undefined, stepOf({ type: "hotkey", keys: "Shift + CTRL+K" }).keys)
  const icon = (bytes) => `data:image/png;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`
  check("A picture within the size limit is kept", button({ iconData: icon(700 * 1024) }).iconData !== undefined, "dropped")
  check("A picture over the size limit is dropped", button({ iconData: icon(2 * 1024 * 1024) }).iconData === undefined, "kept")
  const speed = (value) => normalizeLibrary({ version: 1, activeProfileId: "t", profiles: [{ ...deck("T"), trackpad: { speed: value } }] }).profiles[0].trackpad.speed
  check("A missing trackpad speed is the default, not the minimum", speed(null) === 1.5 && speed("") === 1.5 && speed(undefined) === 1.5 && speed(2) === 2 && speed("2.5") === 2.5 && speed(0) === 0.5, JSON.stringify([speed(null), speed(""), speed(2), speed(0)]))

  // --- links
  const cases = [
    ["twitch.tv/x", "https://twitch.tv/x"],
    ["https://example.com/a", "https://example.com/a"],
    ["192.168.1.5:8080", "http://192.168.1.5:8080/"],
    ["nas.local:8080", "http://nas.local:8080/"],
    ["localhost:8787/deck", "http://localhost:8787/deck"],
    ["nas", "http://nas/"],
    ["nas:5000", "http://nas:5000/"],
    ["mailto:a@b.com", null],
    ["tel:123", null],
    ["javascript:alert(1)", null],
    ["file:///etc/passwd", null],
    ["ftp://x.com", null],
    ["data:text/html,hi", null],
    ["", null]
  ]
  for (const [typed, expected] of cases) {
    const got = webAddress(typed)
    check(`Link "${typed}" -> ${expected}`, got === expected, String(got))
  }

  // --- a failed write leaves no temp file behind
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-store-"))
  const target = path.join(dir, "taken")
  fs.mkdirSync(path.join(target, "inside"), { recursive: true })
  let threw = false
  try { writeJsonAtomic(target, { a: 1 }, { backup: false }) } catch { threw = true }
  check("A write that cannot be renamed into place throws and removes its temp file", threw && fs.readdirSync(dir).join(",") === "taken", fs.readdirSync(dir).join(","))
  fs.rmSync(dir, { recursive: true, force: true })
}

async function main() {
  unitChecks()
  const bootedAt = Date.now()

  // --- a damaged file: an empty deck, not the starters, and a clear message
  await withCompanion({ files: { "decks/library.json": "{ this is not json" } }, async (companion) => {
    const r = await companion.request({ path: "/api/library" })
    check("A damaged deck file starts an empty deck, not the starter decks", r.status === 200 && names(r.json) === "My deck" && r.json.profiles[0].buttons.length === 0, names(r.json))
    const aside = fs.readdirSync(decksDir(companion)).find((name) => name.startsWith("library.json.corrupt-"))
    check("The damaged file is kept aside", Boolean(aside) && fs.readFileSync(path.join(decksDir(companion), aside), "utf8") === "{ this is not json", fs.readdirSync(decksDir(companion)).join(","))
    check("The Control Center is told where it went", notice(r).includes(`set aside as decks${path.sep}${aside}`) && /decks\/backups/.test(notice(r)), notice(r))
    check("The log says where it went too", companion.log().includes(aside ?? "?") && !/profiles\/backups/.test(companion.log()), companion.log())
    const rev = r.headers["x-library-rev"]
    const saved = await companion.request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: JSON.stringify(mine) })
    const after = await companion.request({ path: "/api/library" })
    check("Saving clears the notice", saved.status === 200 && after.headers["x-library-notice"] === undefined, saved.text)
  })

  // --- an empty file is damaged too
  await withCompanion({ files: { "decks/library.json": "" } }, async (companion) => {
    const r = await companion.request({ path: "/api/library" })
    check("An empty deck file is not mistaken for a first start", names(r.json) === "My deck" && /set aside/.test(notice(r)), `${names(r.json)} ${notice(r)}`)
  })

  // --- damaged, with a good previous save
  await withCompanion({ files: { "decks/library.json": "garbage", "decks/library.json.bak": JSON.stringify(mine) } }, async (companion) => {
    const r = await companion.request({ path: "/api/library" })
    check("A damaged file with a good previous save restores that save", names(r.json) === "Mine" && /previous save was restored/.test(notice(r)), `${names(r.json)} ${notice(r)}`)
  })

  // --- a file from a newer Punchboard is never replaced
  const newer = JSON.stringify({ version: 2, activeProfileId: "x", decks: [{ id: "x", stuff: "from the future" }] })
  await withCompanion({ files: { "decks/library.json": newer } }, async (companion) => {
    const file = path.join(decksDir(companion), "library.json")
    const r = await companion.request({ path: "/api/library" })
    check("A newer deck file is explained, not called damaged", /newer version of Punchboard/.test(notice(r)) && !/damaged/.test(notice(r)), notice(r))
    const rev = r.headers["x-library-rev"]
    const saved = await companion.request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: JSON.stringify(mine) })
    check("Saving over a newer deck file is refused", saved.status === 423 && /newer version/.test(saved.json?.error ?? ""), saved.text)
    check("The newer file is left exactly as it was", fs.readFileSync(file, "utf8") === newer && !fs.readdirSync(decksDir(companion)).some((name) => /corrupt|tmp/.test(name)), fs.readdirSync(decksDir(companion)).join(","))
  })

  // --- revisions, and a write that fails
  await withCompanion({}, async (companion) => {
    const r = await companion.request({ path: "/api/library" })
    check("A first start gets the starter decks", names(r.json) === "Streaming,Music,Shortcuts,Trackpad" && r.headers["x-library-notice"] === undefined, names(r.json))
    const rev = Number(r.headers["x-library-rev"])
    check("The revision starts from the clock, so it differs after a restart", rev >= bootedAt, String(rev))
    let saved = await companion.request({ method: "PUT", path: "/api/library", headers: JSON_TYPE, body: JSON.stringify(mine) })
    check("A save without a revision is refused", saved.status === 428, saved.text)
    saved = await companion.request({ method: "PUT", path: "/api/library?rev=1", headers: JSON_TYPE, body: JSON.stringify(mine) })
    check("A save from an old revision is a conflict", saved.status === 409, saved.text)

    // Duplicates sent by a client are repaired on the way in.
    const dupes = { version: 1, activeProfileId: "mine", profiles: [deck("Mine", [press("a", 0), press("a", 0)]), deck("Mine")] }
    saved = await companion.request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: JSON.stringify(dupes) })
    const stored = JSON.parse(fs.readFileSync(path.join(decksDir(companion), "library.json"), "utf8"))
    const buttons = stored.profiles[0].buttons
    check("A saved deck with repeated ids and slots is repaired", saved.status === 200 && stored.profiles[0].id !== stored.profiles[1].id && buttons[0].id !== buttons[1].id && buttons[0].slot !== buttons[1].slot, JSON.stringify(stored.profiles.map((p) => [p.id, p.buttons.map((b) => [b.id, b.slot])])))

    // A folder where library.json goes makes the write fail on every system
    // (Windows ignores a read-only folder).
    const before = await companion.request({ path: "/api/library" })
    const file = path.join(decksDir(companion), "library.json")
    fs.renameSync(file, `${file}.keep`)
    fs.mkdirSync(file)
    saved = await companion.request({ method: "PUT", path: `/api/library?rev=${before.headers["x-library-rev"]}`, headers: JSON_TYPE, body: JSON.stringify(mine) })
    const afterFail = await companion.request({ path: "/api/library" })
    fs.rmdirSync(file)
    fs.renameSync(`${file}.keep`, file)
    check("A save that cannot be written says so", saved.status === 500 && /could not be saved/.test(saved.json?.error ?? ""), saved.text)
    check("A failed write keeps the decks devices see", afterFail.text === before.text, names(afterFail.json))
    check("A failed write keeps the revision", afterFail.headers["x-library-rev"] === before.headers["x-library-rev"], `${before.headers["x-library-rev"]} -> ${afterFail.headers["x-library-rev"]}`)
    saved = await companion.request({ method: "PUT", path: `/api/library?rev=${before.headers["x-library-rev"]}`, headers: JSON_TYPE, body: JSON.stringify(mine) })
    check("Once the folder is writable again, the same save goes through", saved.status === 200 && names((await companion.request({ path: "/api/library" })).json) === "Mine", saved.text)
  })
}

main()
  .catch((error) => { console.error(error); tally.fail++ })
  .finally(async () => {
    for (const companion of companions) {
      await companion.stop()
      companion.cleanup()
    }
    console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
    process.exit(tally.fail ? 1 : 0)
  })
