// Shared by the browser tests: a headless Chrome of their own, driven over the
// DevTools protocol with the `ws` package, so no browser automation library is
// needed. Each Chrome gets a throwaway profile and is closed afterwards.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"

const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
]

export function findChrome() {
  return CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate)) ?? null
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Starts Chrome and opens one page; resolves to a small driver for it. A
    cold CI machine can take a while to start Chrome the first time, so it
    waits up to 45 s and tries once more with a fresh Chrome. */
export async function launchChrome(options = {}) {
  try {
    return await launchOnce(options)
  } catch (error) {
    if (!/DevTools port/.test(String(error))) throw error
    return launchOnce(options)
  }
}

async function launchOnce({ width = 1440, height = 900 } = {}) {
  const binary = findChrome()
  if (!binary) throw new Error("Chrome was not found (set CHROME_PATH).")
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-chrome-"))
  // Port 0: Chrome picks a free port and writes it to DevToolsActivePort, so
  // two test runs (or another Chrome) never end up sharing one.
  const child = spawn(binary, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--window-size=${width},${height}`, "about:blank"
  ], { stdio: "ignore" })

  let target = null
  const giveUp = Date.now() + 45000
  while (!target && Date.now() < giveUp) {
    await delay(100)
    try {
      const port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0])
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      target = list.find((entry) => entry.type === "page") ?? null
    } catch { /* not up yet */ }
  }
  if (!target) {
    child.kill()
    throw new Error("Chrome did not open its DevTools port.")
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject) })
  let nextId = 1
  const pending = new Map()
  const listeners = []
  socket.on("message", (data) => {
    const message = JSON.parse(String(data))
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    } else if (message.method) {
      for (const listener of listeners) listener(message)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

  await send("Page.enable")
  await send("Runtime.enable")
  const errors = []
  listeners.push((message) => {
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  })

  /** The window size; `mobile` also lays the page out like a phone browser (meta viewport, zoomed out to fit). */
  async function setSize(w, h, mobile = false) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile })
  }
  await setSize(width, height)

  /** Evaluates an expression (or async function body via `async () => …`) in the page. */
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }

  async function goto(url) {
    const loaded = new Promise((resolve) => listeners.push(function once(message) {
      if (message.method === "Page.loadEventFired") {
        listeners.splice(listeners.indexOf(once), 1)
        resolve()
      }
    }))
    await send("Page.navigate", { url })
    await loaded
  }

  /** Waits until `expression` is truthy in the page. */
  async function waitFor(expression, timeoutMs = 5000) {
    const until = Date.now() + timeoutMs
    for (;;) {
      const value = await evaluate(expression).catch(() => false)
      if (value) return value
      if (Date.now() > until) throw new Error(`Timed out waiting for ${expression}`)
      await delay(40)
    }
  }

  async function screenshot(file) {
    const shot = await send("Page.captureScreenshot", { format: "png" })
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"))
  }

  /** A real key press, so the page's keydown handlers see it as the user would. */
  async function press(key, { code = key, modifiers = 0, keyCode = 0 } = {}) {
    const base = { key, code, modifiers, windowsVirtualKeyCode: keyCode }
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base })
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }

  async function close() {
    try { socket.close() } catch { /* already closed */ }
    child.kill()
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)))
    // Windows can hold the profile a moment after Chrome exits; it is in the temp folder anyway.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* left for the system to clear */ }
  }

  /** Calls `listener(params)` for every DevTools event named `method`. */
  function on(method, listener) {
    listeners.push((message) => { if (message.method === method) listener(message.params) })
  }

  return { send, evaluate, goto, waitFor, screenshot, press, setSize, close, on, errors }
}
