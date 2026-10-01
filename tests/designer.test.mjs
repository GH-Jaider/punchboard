// The Control Center in a real (headless) Chrome: undo, the keyboard, saving
// and the narrow layouts. Runs against a companion of its own with OBS pointed
// at a closed port, so nothing on this computer is touched. Each section starts
// from the starter decks again. Skipped when no Chrome is installed.
//   node tests/designer.test.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findChrome, launchChrome } from "./chrome.mjs"
import { checker, JSON_TYPE, startCompanion } from "./companion.mjs"

if (!findChrome()) {
  console.log("SKIP  designer tests: Chrome is not installed (set CHROME_PATH)")
  process.exit(0)
}

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const companion = startCompanion({ config: { obs: { address: "ws://127.0.0.1:1", password: "", source: "manual" } } })
const { request } = companion
const port = await companion.ready
const chrome = await launchChrome({ width: 1440, height: 900 })
const { evaluate, waitFor, press } = chrome
const pngFile = path.join(os.tmpdir(), `punchboard-icon-${process.pid}.png`)
fs.writeFileSync(pngFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"))

// Saves can be made to fail on purpose, to check the retry.
let failSaves = false
let failed = 0
chrome.on("Fetch.requestPaused", (params) => {
  if (failSaves) {
    failed += 1
    void chrome.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" })
  } else {
    void chrome.send("Fetch.continueRequest", { requestId: params.requestId })
  }
})
await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/library?rev=*", requestStage: "Request" }] })

async function library() {
  const response = await request({ path: "/api/library" })
  return { data: response.json, rev: Number(response.headers["x-library-rev"]) }
}
async function putLibrary(data) {
  const rev = (await library()).rev
  return request({ method: "PUT", path: `/api/library?rev=${rev}`, headers: JSON_TYPE, body: JSON.stringify(data) })
}
const pristine = (await library()).data
const streaming = (data) => data.profiles.find((profile) => profile.name === "Streaming")
const savedDeck = async () => streaming((await library()).data)
const saved = () => waitFor(`document.getElementById("save-text").textContent.startsWith("Saved")`)
const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`)

async function open() {
  await chrome.goto(`http://127.0.0.1:${port}/designer`)
  await saved()
}
async function selectTile(slot) {
  await evaluate(`(() => { const tile = document.querySelector('.tile[data-slot="${slot}"]'); tile.focus(); tile.click() })()`)
}
async function typeLabel(value) {
  await evaluate(`(() => { const input = document.getElementById("label-input"); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event("input")) })()`)
}

const isMac = await evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`)
const COMMAND = isMac ? 4 : 2
const undoKey = () => press("z", { code: "KeyZ", modifiers: COMMAND, keyCode: 90 })
const deleteKey = () => press("Delete", { keyCode: 46 })

/** Runs one part on a fresh copy of the starter decks; a throw fails just that part. */
async function section(name, run, { width = 1440, height = 900, mobile = false } = {}) {
  try {
    failSaves = false
    await chrome.goto("about:blank")
    await putLibrary(pristine)
    await chrome.setSize(width, height, mobile)
    await open()
    await run()
  } catch (error) {
    check(`${name}: ran to the end`, false, error.message)
  }
}

await section("undo on a full grid", async () => {
  await selectTile(0)
  await deleteKey()
  await waitFor(`!document.querySelector('.tile[data-slot="0"]')`)
  await evaluate(`document.querySelector('.slot-wrap[data-slot="0"] .add-slot').click()`)
  await undoKey()
  await saved()
  const deck = await savedDeck()
  const slots = deck.buttons.map((button) => button.slot)
  check("undo on a full grid adds a row", deck.rows === 4, `rows ${deck.rows}`)
  check("undo on a full grid gives the button its own slot", new Set(slots).size === slots.length && slots.includes(12), JSON.stringify(slots))
  check("the restored button is drawn", (await text('.tile[data-slot="12"] .tile-label')) === "Go live", "no tile in slot 13")
})

await section("undo after a reload", async () => {
  await selectTile(0)
  await deleteKey()
  await saved()
  const current = (await library()).data
  current.profiles[1].name = "Music (other window)"
  const put = await putLibrary(current)
  check("another window saves", put.status === 200, put.text)
  await waitFor(`document.getElementById("toast").textContent.includes("another window")`)
  check("the reload hides the undo toast's button", await evaluate(`!document.querySelector("#toast .toast-action")`), "an Undo button is still offered")
  await undoKey()
  check("after a reload, undo has nothing stale to run", (await text("#toast")) === "Nothing to undo.", await text("#toast"))
  await wait(700)
  check("and the library is left alone", !(await savedDeck()).buttons.some((button) => button.label === "Go live"), "the deleted button came back")
})

await section("moving the selected button", async () => {
  await selectTile(1)
  check("the inspector shows the selected button", (await text("#inspector h2")) === "Button 2", await text("#inspector h2"))
  await press("ArrowRight", { modifiers: 1, keyCode: 39 })
  check("Alt+Right moves the inspector with the button", (await text("#inspector h2")) === "Button 3", await text("#inspector h2"))
  // Dragging another button makes it the selection; the inspector follows.
  await evaluate(`(() => {
    document.querySelector('.tile[data-slot="5"]').dispatchEvent(new DragEvent("dragstart", { bubbles: true }))
    document.querySelector('.slot-wrap[data-slot="6"]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true }))
  })()`)
  check("a drag moves the inspector to the dragged button", (await text("#inspector h2")) === "Button 7", await text("#inspector h2"))
  await evaluate(`[...document.querySelectorAll("#inspector .inspector-actions .btn")].find((b) => b.textContent === "Delete").click()`)
  await saved()
  const labels = (await savedDeck()).buttons.map((button) => button.label)
  check("the inspector's Delete deletes the dragged button", !labels.includes("Mute desktop") && labels.includes("Mic"), JSON.stringify(labels))
})

await section("Delete key and focus", async () => {
  await selectTile(2)
  await evaluate(`document.querySelector("#inspector .swatch").focus()`)
  await deleteKey()
  await press("Backspace", { keyCode: 8 })
  check("Delete on a swatch keeps the button", await evaluate(`Boolean(document.querySelector('.tile[data-slot="2"]'))`), "it was deleted")
  await evaluate(`document.querySelector("#inspector .step-head").focus()`)
  await deleteKey()
  check("Delete on a step header keeps the button", await evaluate(`Boolean(document.querySelector('.tile[data-slot="2"]'))`), "it was deleted")
  await selectTile(2)
  await deleteKey()
  check("Delete on the tile still deletes it", await evaluate(`!document.querySelector('.tile[data-slot="2"]')`), "it is still there")
})

await section("While on icon", async () => {
  await selectTile(4)
  check("a mute button offers a While on icon", await evaluate(`Boolean(document.querySelector("#inspector .on-icon"))`), "")
  const setType = (type) => evaluate(`(() => { const s = document.querySelector("#steps-host select"); s.value = "${type}"; s.dispatchEvent(new Event("change")) })()`)
  await setType("hotkey")
  check("a step that cannot light the button hides While on", await evaluate(`!document.querySelector("#inspector .on-icon")`), "still shown")
  await setType("obs_toggle_record")
  check("a step that can shows it again", await evaluate(`Boolean(document.querySelector("#inspector .on-icon"))`), "not shown")
  await saved()
  check("the second icon is kept meanwhile", (await savedDeck()).buttons.find((b) => b.slot === 4)?.onGlyph?.name === "mic_off", "onGlyph was dropped")
})

await section("custom image over an icon", async () => {
  await selectTile(4)
  const input = await chrome.send("Runtime.evaluate", { expression: `document.getElementById("icon-file")` })
  await chrome.send("DOM.setFileInputFiles", { files: [pngFile], objectId: input.result.objectId })
  await waitFor(`document.querySelector('[aria-label="Remove the custom image"]')`)
  await saved()
  const button = (await savedDeck()).buttons.find((b) => b.slot === 4)
  check("an uploaded image keeps the icon", Boolean(button.iconData) && button.glyph?.name === "mic", JSON.stringify(button.glyph))
  await evaluate(`document.querySelector('[aria-label="Remove the custom image"]').click()`)
  check("removing the image brings the icon back", (await text("#inspector .icon-trigger strong")) === "mic", await text("#inspector .icon-trigger strong"))
})

await section("failed saves", async () => {
  failSaves = true
  await selectTile(3)
  await typeLabel("Cam")
  await waitFor(`document.getElementById("save-text").textContent === "Not saved"`)
  check("a failed save shows Retry", await evaluate(`document.getElementById("save-retry") && !document.getElementById("save-retry").hidden`), "no Retry")
  const before = failed
  await wait(2300)
  check("it retries by itself", failed > before, `${failed - before} retries`)
  failSaves = false
  await evaluate(`document.getElementById("save-retry").click()`)
  await saved()
  check("Retry saves the edit", (await savedDeck()).buttons.some((b) => b.label === "Cam"), "not saved")
  check("and hides itself", await evaluate(`document.getElementById("save-retry").hidden`), "")
  failSaves = true
  await typeLabel("Camera")
  await waitFor(`document.getElementById("save-text").textContent === "Not saved"`)
  failSaves = false
  await saved()
  check("a retry succeeds once the companion answers", (await savedDeck()).buttons.some((b) => b.label === "Camera"), "the retry never landed")
})

await section("closing within the save pause", async () => {
  await selectTile(3)
  await typeLabel("Last edit")
  await chrome.goto("about:blank")
  let landed = false
  for (let attempt = 0; attempt < 20 && !landed; attempt += 1) {
    landed = (await savedDeck()).buttons.some((b) => b.label === "Last edit")
    if (!landed) await wait(100)
  }
  check("an edit made just before closing is saved", landed, "lost")
})

await section("hiding a library too big for keepalive", async () => {
  // ~100 KB of custom image: over the 64 KiB keepalive limit, so the save goes
  // as a normal request the moment the page is hidden.
  const big = JSON.parse(JSON.stringify(pristine))
  streaming(big).buttons[0].iconData = `data:image/png;base64,iVBORw0KGgo${"A".repeat(100000)}`
  check("a big library is accepted", (await putLibrary(big)).status === 200, "")
  await open()
  await selectTile(3)
  await typeLabel("Hidden edit")
  await evaluate(`Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange"))`)
  await wait(150)
  check("hiding the page saves at once", (await savedDeck()).buttons.some((b) => b.label === "Hidden edit"), "not saved within 150 ms")
})

await section("OBS port", async () => {
  await evaluate(`document.getElementById("obs-toggle").click(); document.getElementById("obs-manual").open = true; document.getElementById("obs-port").value = "70000"; document.getElementById("obs-save").click()`)
  await wait(300)
  const settings = await request({ path: "/api/settings" })
  check("a port above 65535 is refused", settings.json.obsAddress === "ws://127.0.0.1:1" && (await text("#toast")).includes("65535"), `${settings.json.obsAddress} · ${await text("#toast")}`)
})

await section("1024×600", async () => {
  for (const theme of ["studio", "hardware", "broadcast"]) {
    await evaluate(`document.documentElement.setAttribute("data-theme", "${theme}")`)
    const clipped = await evaluate(`[...document.querySelectorAll(".setup-item .state-chip")].filter((c) => c.scrollWidth > c.clientWidth).map((c) => c.textContent)`)
    check(`setup chips fit in ${theme}`, clipped.length === 0, clipped.join(", "))
  }
  const size = await evaluate(`document.getElementById("grid").dataset.size`)
  check("small tiles get a smaller badge", size === "compact" || size === "tiny", String(size))
}, { width: 1024, height: 600 })

await section("parked notice", async () => {
  // Hardware's uppercase mono buttons are the widest.
  await evaluate(`document.documentElement.setAttribute("data-theme", "hardware")`)
  await evaluate(`document.querySelector("[aria-label='Fewer columns']").click(); document.querySelector("[aria-label='Fewer columns']").click()`)
  await waitFor(`document.querySelector("#parked-notice .notice")`)
  const overflow = await evaluate(`(() => {
    const column = document.querySelector(".canvas-col")
    const right = column.getBoundingClientRect().right - parseFloat(getComputedStyle(column).paddingRight)
    return [...document.querySelectorAll("#parked-notice .notice, #parked-notice .btn")].some((b) => b.getBoundingClientRect().right > right + 0.5)
  })()`)
  check("the parked notice keeps its buttons inside", !overflow, "a button overflows")
  await saved()
}, { width: 1000, height: 800 })

await section("stacked columns", async () => {
  const stacked = await evaluate(`(() => {
    const rect = (id) => document.getElementById(id).getBoundingClientRect()
    const frame = rect("tablet-frame"), title = document.querySelector(".canvas-head").getBoundingClientRect(), hint = rect("stage-hint"), inspector = rect("inspector")
    return { stage: rect("stage").height, overlap: frame.top < title.bottom || frame.bottom > hint.top || frame.bottom > inspector.top }
  })()`)
  check("stacked, the stage has a real height", stacked.stage > 300, `${stacked.stage}px`)
  check("stacked, the frame overlaps nothing", !stacked.overlap, "")
}, { width: 800, height: 900 })

await section("phone width", async () => {
  const width = await evaluate(`document.documentElement.scrollWidth`)
  check("a phone-width window does not scroll sideways", width <= 390, `${width}px wide`)
  for (const [opener, dialog] of [["pair-btn", "dlg-pair"], ["appearance-btn", "dlg-appearance"], ["obs-toggle", "dlg-obs"]]) {
    await evaluate(`document.getElementById("${opener}").click()`)
    const box = await evaluate(`(() => { const r = document.getElementById("${dialog}").getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } })()`)
    check(`${dialog} fits a phone screen`, box.left >= 0 && box.right <= 390 && box.top >= 0 && box.bottom <= 844, JSON.stringify(box))
    await evaluate(`document.getElementById("${dialog}").close()`)
  }
}, { width: 390, height: 844, mobile: true })

check("no script errors", chrome.errors.length === 0, chrome.errors.join("\n"))

await chrome.close()
await companion.stop()
companion.cleanup()
fs.rmSync(pngFile, { force: true })

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
