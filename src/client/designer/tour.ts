// The guided tour: seven short popovers over the real Control Center, run by
// driver.js. It starts by itself once, the first time the Control Center
// opens (remembered in config.json as tourShown, like the Ko-fi note), and
// the "?" in the app bar plays it again at any time.
//
// It only shows things: the highlighted element cannot be clicked, so a
// dialog never opens on top of it. A step whose element is missing or hidden
// (a narrow window, a deck with nothing in it) is left out before the tour
// starts, so "3 of 7" always counts what is really shown.
import type { Config, Driver, DriveStep, PopoverDOM } from "driver.js"
import type { SettingsResponse, SettingsSaved } from "../../shared/api.ts"
import { t } from "../../shared/i18n.ts"
import { byId, el, svg } from "../common/dom.ts"
import { request } from "../common/http.ts"
import { onLanguageChange, richHtml } from "../common/i18n.ts"
import { deselect } from "./grid.ts"
import { UI_ICONS, view } from "./hub.ts"
import { activeProfile, store } from "./state.ts"
import { closeNote } from "./support.ts"

/** driver.js, from its own bundle (src/client/vendor/driver.ts). Missing only
    if that script failed to load: then there is simply no tour. */
const makeDriver = (): ((config: Config) => Driver) | undefined =>
  (window as unknown as { punchboardDriver?: (config: Config) => Driver }).punchboardDriver

let tour: Driver | null = null
/** Run once when the tour that started by itself ends (the Ko-fi note waits for it). */
let afterFirst: Array<() => void> = []
let firstDue = false

/** What the tour changed and puts back when it ends. */
interface Saved {
  focus: Element | null
  selection: number | null
  selectedByTour: boolean
  introHidden: boolean
}
let saved: Saved | null = null

/** Shown and taking up room: not display:none, not in a hidden parent, not zero-sized. */
function visible(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)) return false
  return getComputedStyle(element).visibility !== "hidden"
}

const prefersLessMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

/** The step's text from the locale file, escaped, with its <strong>/<kbd> kept. */
function popover(name: string): { title: string; description: string } {
  return { title: richHtml(t(`designer.tour.${name}Title`)), description: richHtml(t(`designer.tour.${name}Text`)) }
}

/** Selects the deck's first button for the inspector step, so the panel shows
    a button's real controls rather than the deck's. */
function selectFirstButton(): void {
  if (!saved || store.selectedSlot !== null) return
  const buttons = activeProfile().buttons.slice().sort((a, b) => a.slot - b.slot)
  const first = buttons[0]
  if (!first || !document.querySelector(`.tile[data-slot="${first.slot}"]`)) return
  view.select(first.slot)
  saved.selectedByTour = true
}

function restoreSelection(): void {
  if (!saved || !saved.selectedByTour) return
  saved.selectedByTour = false
  if (saved.selection === null) deselect()
  else view.select(saved.selection)
}

/** The steps whose elements are on the page right now. */
function buildSteps(): DriveStep[] {
  const steps: DriveStep[] = [{ popover: popover("welcome") }]
  const add = (selector: string, name: string, extra?: Partial<DriveStep>): void => {
    const element = document.querySelector(selector)
    if (!visible(element)) return
    const step: DriveStep = { element, popover: popover(name) }
    steps.push(extra ? Object.assign(step, extra) : step)
  }
  add("#rail-decks", "decks")
  add("#tablet-frame", "grid")
  add("#inspector", "inspector", { onHighlightStarted: selectFirstButton, onDeselected: restoreSelection })
  add("#pair-btn", "pair")
  add(".rail-setup", "setup")
  // The last step always shows: on the "?" when it is there, else centred.
  const help = document.getElementById("tour-btn")
  steps.push(visible(help) ? { element: help, popover: popover("done") } : { popover: popover("done") })
  return steps
}

/** Gives driver.js's popover the app's own buttons and words. */
function dressPopover(dom: PopoverDOM, current: Driver): void {
  dom.wrapper.setAttribute("aria-modal", "true")
  // The app's buttons, so each theme styles them as it styles every other.
  // driver.js's own class would reset them; its click handling uses the
  // next/prev classes, which stay.
  for (const button of [dom.previousButton, dom.nextButton]) button.classList.remove("driver-popover-footer-btn")
  dom.previousButton.className += " btn"
  dom.nextButton.className += " btn primary"
  // Nothing to go back to on the first step: no button rather than a dead one.
  if (dom.previousButton.disabled) dom.previousButton.style.display = "none"
  dom.closeButton.innerHTML = svg(UI_ICONS.x)
  dom.closeButton.className += " icon-btn"
  dom.closeButton.setAttribute("aria-label", t("designer.tour.close"))
  dom.closeButton.title = t("designer.tour.close")
  // "3 of 7" reads as a small heading above the title.
  dom.wrapper.insertBefore(dom.progress, dom.title)
  if (!current.isLastStep()) {
    const skip = el("button", "btn ghost tour-skip", t("designer.tour.skip"))
    skip.type = "button"
    skip.addEventListener("click", () => closeTour())
    dom.footer.insertBefore(skip, dom.footer.firstChild)
  }
  // driver.js focuses the first control (the ×); Next is what a keyboard wants.
  setTimeout(() => {
    if (dom.wrapper.isConnected) dom.nextButton.focus()
  }, 0)
}

/** Puts back what the tour changed, and lets the Ko-fi note have its turn. */
function finish(): void {
  const was = saved
  if (was) {
    restoreSelection()
    const intro = document.getElementById("intro-card")
    if (intro) intro.hidden = was.introHidden
    if (was.focus instanceof HTMLElement && was.focus.isConnected && was.focus !== document.body) was.focus.focus()
  }
  saved = null
  tour = null
  const waiting = afterFirst
  afterFirst = []
  for (const then of waiting) then()
}

/** Every way out (Done, Skip, ×, Esc, a click on the dimmed page, a new
    language) ends here. driver.js's own onDestroyed is not used: it is
    skipped when the tour is closed before its first step has finished
    animating in, which would leave the tour half-open. */
export function closeTour(): void {
  const current = tour
  tour = null
  if (current) current.destroy()
  finish()
}

export function startTour(): void {
  const driver = makeDriver()
  if (tour || !store.library || !driver) return
  closeNote()
  const intro = document.getElementById("intro-card")
  saved = { focus: document.activeElement, selection: store.selectedSlot, selectedByTour: false, introHidden: intro ? intro.hidden === true : true }
  // The older tips card says the same in fewer words; it waits while the tour talks.
  if (intro) intro.hidden = true
  const motion = !prefersLessMotion()
  const config: Config = {
    steps: buildSteps(),
    animate: motion,
    smoothScroll: motion,
    showProgress: true,
    // {current} and {total} are the locale file's; driver.js fills its own {{…}}.
    progressText: richHtml(t("designer.tour.progress", { current: "{{current}}", total: "{{total}}" })),
    nextBtnText: richHtml(t("designer.tour.next")),
    prevBtnText: richHtml(t("designer.tour.back")),
    doneBtnText: richHtml(t("designer.tour.done")),
    overlayColor: "var(--tour-overlay)",
    overlayOpacity: 1,
    stagePadding: 6,
    // The theme's own corners: round in Studio, square in Broadcast.
    stageRadius: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--r-md")) || 0,
    popoverClass: "pb-tour",
    popoverOffset: 8,
    disableActiveInteraction: true,
    allowClose: true,
    onPopoverRender: (dom, opts) => dressPopover(dom, opts.driver),
    // Asked to close: closeTour() does it (destroy() does not ask again).
    onDestroyStarted: () => closeTour()
  }
  tour = driver(config)
  tour.drive()
}

/** Starts the tour by itself if it has never been shown; true when it will.
    It is remembered at once, so closing the window mid-tour does not bring
    it back. */
export function offerTour(settings: SettingsResponse): boolean {
  if (!settings.tourNote) return false
  firstDue = true
  request<SettingsSaved>("/api/settings", { method: "PUT", json: { tourShown: true } }).catch(() => { /* shown again next time */ })
  const begin = (): void => {
    // Not over a dialog (the desktop app can open Pair a device straight away).
    if (document.querySelector("dialog[open]")) {
      setTimeout(begin, 500)
      return
    }
    firstDue = false
    startTour()
    // No tour after all (driver.js did not load): nothing should wait for it.
    if (!tour) finish()
  }
  // A moment after the page has drawn, so the tour does not compete with it.
  setTimeout(begin, 900)
  return true
}

/** Runs `then` once the tour that started by itself has ended. */
export function afterFirstTour(then: () => void): void {
  if (!firstDue && !tour) then()
  else afterFirst.push(then)
}

export function bindTour(): void {
  byId("tour-btn").addEventListener("click", () => startTour())
  // Its texts are drawn once per step; a new language simply ends it.
  onLanguageChange(() => { if (tour) closeTour() })
}
