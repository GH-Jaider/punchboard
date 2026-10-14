// The Control Center's first-run tour in a real (headless) Chrome: it starts
// by itself once, walks the real elements, can be skipped or closed with
// Esc, plays again from the "?", leaves out what is not on the page, waits
// before the Ko-fi note, and speaks Spanish. Each companion is its own, with
// OBS pointed at a closed port. Skipped when no Chrome is installed.
//   node tests/tour.test.mjs
import fs from "node:fs"
import path from "node:path"
import { findChrome, launchChrome } from "./chrome.mjs"
import { checker, startCompanion } from "./companion.mjs"

if (!findChrome()) {
  console.log("SKIP  tour tests: Chrome is not installed (set CHROME_PATH)")
  process.exit(0)
}

const { check, tally } = checker()
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const OBS_OFF = { address: "ws://127.0.0.1:1", password: "", source: "manual" }
const read = (code) => JSON.parse(fs.readFileSync(new URL(`../public/locales/${code}.json`, import.meta.url), "utf8")).messages
const en = read("en")
const es = read("es")
const STEPS = ["", "rail-decks", "tablet-frame", "inspector", "pair-btn", "rail-setup", "tour-btn"]

const chrome = await launchChrome({ width: 1440, height: 900 })
const { evaluate, waitFor, press } = chrome
const companions = []

/** What the open tour shows: its count, title, buttons and the highlighted element. */
const shown = () => evaluate(`(() => {
  const pop = document.querySelector(".driver-popover")
  if (!pop) return null
  const lit = document.querySelector(".driver-active-element")
  const text = (selector) => { const node = pop.querySelector(selector); return node && node.style.display !== "none" ? node.textContent : null }
  const rect = pop.getBoundingClientRect()
  return {
    progress: text(".driver-popover-progress-text"),
    title: text(".driver-popover-title"),
    next: text(".driver-popover-next-btn"),
    back: text(".driver-popover-prev-btn"),
    skip: text(".tour-skip"),
    lit: lit ? (lit.id || lit.classList[0]) : "",
    focus: document.activeElement === pop.querySelector(".driver-popover-next-btn"),
    inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5
  }
})()`)
const progressIs = (value) => waitFor(`document.querySelector(".driver-popover-progress-text")?.textContent === ${JSON.stringify(value)}`)
const tourGone = () => waitFor(`!document.querySelector(".driver-popover") && !document.body.classList.contains("driver-active")`)
const noteShown = () => evaluate(`!document.getElementById("support-note").hidden`)
const next = () => evaluate(`document.querySelector(".driver-popover-next-btn").click()`)

async function companion(config) {
  const started = startCompanion({ config: { obs: OBS_OFF, ...config } })
  companions.push(started)
  const port = await started.ready
  return { ...started, url: `http://127.0.0.1:${port}/designer` }
}
const settings = async (c) => (await c.request({ path: "/api/settings" })).json

async function part(name, run) {
  try {
    await run()
  } catch (error) {
    check(`${name}: ran to the end`, false, error.message)
  }
}

// ------------------------------------------------------------- first run

const fresh = await companion({})
await part("first run", async () => {
  await chrome.goto(fresh.url)
  await waitFor(`document.querySelector(".driver-popover")`, 6000)
  let step = await shown()
  check("the tour starts by itself on the first open", step.progress === "1 of 7" && step.title === en["designer.tour.welcomeTitle"], JSON.stringify(step))
  check("the welcome step is centred, on nothing", step.lit === "driver-dummy-element" || step.lit === "", step.lit)
  check("Next has the focus", step.focus, "focus is elsewhere")
  check("no Back on the first step, but a Skip", step.back === null && step.skip === en["designer.tour.skip"], JSON.stringify(step))
  const remembered = await settings(fresh)
  const stored = JSON.parse(fs.readFileSync(path.join(fresh.dataDir, "config.json"), "utf8"))
  check("it is remembered as soon as it starts", remembered.tourNote === false && stored.tourShown === true, JSON.stringify({ tourNote: remembered.tourNote, stored: stored.tourShown }))
  check("the Ko-fi note waits, and is not yet marked as shown", !(await noteShown()) && remembered.supportNote === true, JSON.stringify({ note: await noteShown(), supportNote: remembered.supportNote }))

  const before = await evaluate(`document.querySelector("#inspector h2").textContent`)
  const lit = []
  for (let index = 2; index <= 7; index += 1) {
    // One step by keyboard, the rest by the button.
    if (index === 3) {
      await wait(500)
      await press("ArrowRight", { keyCode: 39 })
    } else {
      await next()
    }
    await progressIs(`${index} of 7`)
    await wait(450)
    step = await shown()
    lit.push(step.lit)
    if (index === 4) {
      const inspector = await evaluate(`({ head: document.querySelector("#inspector h2").textContent, selected: Boolean(document.querySelector('.tile.selected[data-slot="0"]')) })`)
      check("the inspector step shows the first button's settings", inspector.head === "Button 1" && inspector.selected, JSON.stringify(inspector))
    }
    if (index === 5) {
      check("after it, the selection is put back", (await evaluate(`document.querySelector("#inspector h2").textContent`)) === before && !(await evaluate(`Boolean(document.querySelector(".tile.selected"))`)), await evaluate(`document.querySelector("#inspector h2").textContent`))
    }
  }
  check("each step lights its own element", JSON.stringify(lit) === JSON.stringify(STEPS.slice(1)), JSON.stringify(lit))
  check("the last step says Done and offers no Skip", step.next === en["designer.tour.done"] && step.skip === null && step.back === en["designer.tour.back"], JSON.stringify(step))
  await press("ArrowLeft", { keyCode: 37 })
  await progressIs("6 of 7")
  check("the left arrow goes back", true, "")
  // driver.js ignores the arrows while a step is still moving in.
  await wait(500)
  await press("ArrowRight", { keyCode: 39 })
  await progressIs("7 of 7")
  check("the Ko-fi note still waits on the last step", !(await noteShown()), "it showed during the tour")
  await next()
  await tourGone()
  check("Done ends the tour", true, "")
  await waitFor(`!document.getElementById("support-note").hidden`, 4000)
  check("then the Ko-fi note shows", true, "")
  check("and it is marked as shown", (await settings(fresh)).supportNote === false, "supportNote still true")
})

await part("reload", async () => {
  await chrome.goto(fresh.url)
  await waitFor(`document.getElementById("save-text").textContent.startsWith("Saved")`)
  await wait(2500)
  check("after a reload the tour does not start again", !(await evaluate(`Boolean(document.querySelector(".driver-popover"))`)), "it started")
  check("nor does the Ko-fi note", !(await noteShown()), "it showed")
  const help = await evaluate(`(() => { const b = document.getElementById("tour-btn"); return { label: b.getAttribute("aria-label"), title: b.title } })()`)
  check("the ? is labelled", help.label === en["designer.page.appbar.tour"] && help.title === en["designer.page.appbar.tour"], JSON.stringify(help))
})

await part("replay", async () => {
  await evaluate(`document.getElementById("tour-btn").focus(); document.getElementById("tour-btn").click()`)
  await progressIs("1 of 7")
  check("the ? plays the tour again", true, "")
  await next()
  await progressIs("2 of 7")
  // At once, while the step is still moving in: it must close all the same.
  await press("Escape", { keyCode: 27 })
  await tourGone()
  check("Esc closes it, even mid-animation", true, "")
  check("and the focus goes back to the ?", await evaluate(`document.activeElement === document.getElementById("tour-btn")`), await evaluate(`document.activeElement && document.activeElement.id`))

  await evaluate(`document.getElementById("tour-btn").click()`)
  await progressIs("1 of 7")
  await evaluate(`document.querySelector(".tour-skip").click()`)
  await tourGone()
  check("Skip closes it", true, "")
})

await part("missing element", async () => {
  await evaluate(`document.querySelector(".rail-setup").style.display = "none"`)
  await evaluate(`document.getElementById("tour-btn").click()`)
  await progressIs("1 of 6")
  const lit = []
  for (let index = 2; index <= 6; index += 1) {
    await next()
    await progressIs(`${index} of 6`)
    lit.push((await shown()).lit)
  }
  check("a hidden element's step is left out, and the count says so", !lit.includes("rail-setup") && lit[lit.length - 1] === "tour-btn", JSON.stringify(lit))
  await next()
  await tourGone()
  await evaluate(`document.querySelector(".rail-setup").style.display = ""`)
})

await part("reduced motion", async () => {
  await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] })
  await evaluate(`document.getElementById("tour-btn").click()`)
  await progressIs("1 of 7")
  check("with reduced motion nothing fades in", !(await evaluate(`document.body.classList.contains("driver-fade")`)), "the driver-fade class is set")
  for (let index = 2; index <= 7; index += 1) {
    await next()
    await progressIs(`${index} of 7`)
  }
  check("and every step still shows", (await shown()).lit === "tour-btn", "")
  await next()
  await tourGone()
  await chrome.send("Emulation.setEmulatedMedia", { features: [] })
})

await part("phone width", async () => {
  await chrome.setSize(390, 844, true)
  await chrome.goto(fresh.url)
  await waitFor(`document.getElementById("save-text").textContent.startsWith("Saved")`)
  await evaluate(`document.getElementById("tour-btn").click()`)
  await progressIs("1 of 7")
  const outside = []
  for (let index = 1; index <= 7; index += 1) {
    if (index > 1) {
      await next()
      await progressIs(`${index} of 7`)
    }
    await wait(500)
    const step = await shown()
    if (!step.inside) outside.push(index)
  }
  check("on a phone every step's popover stays on screen", outside.length === 0, `steps ${outside.join(", ")}`)
  check("and the page does not scroll sideways", (await evaluate(`document.documentElement.scrollWidth`)) <= 390, `${await evaluate(`document.documentElement.scrollWidth`)}px`)
  await press("Escape", { keyCode: 27 })
  await tourGone()
  await chrome.setSize(1440, 900)
})

// ------------------------------------------------------ the tour seen before

await part("tour already shown", async () => {
  const seen = await companion({ tourShown: true })
  await chrome.goto(seen.url)
  await waitFor(`!document.getElementById("support-note").hidden`, 4000)
  check("when the tour was shown before, the Ko-fi note shows as it always did", !(await evaluate(`Boolean(document.querySelector(".driver-popover"))`)), "a tour started")
})

// ---------------------------------------------------------------- Spanish

await part("Spanish", async () => {
  const spanish = await companion({ language: "es", supportShown: true })
  await chrome.goto(spanish.url)
  await waitFor(`document.querySelector(".driver-popover")`, 6000)
  let step = await shown()
  check("in Spanish the tour speaks Spanish", step.title === es["designer.tour.welcomeTitle"] && step.progress === "1 de 7" && step.next === es["designer.tour.next"] && step.skip === es["designer.tour.skip"], JSON.stringify(step))
  check("the close button is labelled in Spanish", (await evaluate(`document.querySelector(".driver-popover-close-btn").getAttribute("aria-label")`)) === es["designer.tour.close"], "")
  await next()
  await progressIs("2 de 7")
  step = await shown()
  check("Back is Spanish too", step.back === es["designer.tour.back"], JSON.stringify(step))
  check("the ? is labelled in Spanish", (await evaluate(`document.getElementById("tour-btn").getAttribute("aria-label")`)) === es["designer.page.appbar.tour"], "")
  await evaluate(`document.querySelector(".driver-popover-close-btn").click()`)
  await tourGone()
  await wait(2000)
  check("with the Ko-fi note already shown, nothing follows the tour", !(await noteShown()), "the note showed")
})

check("no script errors", chrome.errors.length === 0, chrome.errors.join("\n"))

await chrome.close()
for (const c of companions) {
  await c.stop()
  c.cleanup()
}
console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
