// Keeps the screen on while the deck is open, where the browser allows it.
// The wake lock lapses whenever the page is hidden and, on iOS, is only
// granted after a touch, so it is asked for again on both.
import { storage } from "../common/dom.ts"
import { toast } from "./ui.ts"

interface WakeLockSentinel {
  release(): Promise<void>
  addEventListener(type: "release", listener: () => void): void
}
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> } }

const HINT_KEY = "punchboard-sleep-hint"
let sentinel: WakeLockSentinel | null = null

function acquire(): void {
  const nav = navigator as WakeLockNavigator
  if (!nav.wakeLock || sentinel || document.visibilityState !== "visible") return
  nav.wakeLock.request("screen").then((lock) => {
    sentinel = lock
    lock.addEventListener("release", () => { sentinel = null })
  }).catch(() => { /* not granted yet: the next touch asks again */ })
}

export function initWakeLock(): void {
  const nav = navigator as WakeLockNavigator
  if (!nav.wakeLock) {
    // Older iPads: nothing a page can do; the setting is the answer.
    if (!storage.get(HINT_KEY)) {
      storage.set(HINT_KEY, "1")
      toast("This browser cannot keep the screen on. Set Auto-Lock to Never while you stream.", false, { label: "Got it", onClick: () => { /* dismissed */ } })
    }
    return
  }
  acquire()
  document.addEventListener("touchstart", acquire, { passive: true })
  document.addEventListener("click", acquire)
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") acquire() })
}
