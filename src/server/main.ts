// Punchboard companion: serves the Control Center to this computer and the
// deck to paired tablets, and runs their button presses.
//
// Who may call what:
//   public  pages, and claiming a pairing code
//   deck    a paired device with a signed request (auth.ts), or this computer
//   local   this computer only: editing decks, settings, sounds, pairing
// Every request must also name this server in its Host header and, when it
// changes something, come from this server's own origin. That stops other
// web pages and DNS rebinding from driving the companion through a browser.
import fs from "node:fs"
import http from "node:http"
import type { ServerResponse } from "node:http"
import path from "node:path"
import QRCode from "qrcode"
import open from "open"
import qrcodeTerminal from "qrcode-terminal"
import type {
  ObsIssue,
  ObsDetectResponse,
  AppsResponse,
  ClaimResponse, DevicesResponse, ErrorResponse, GlyphResponse, GoogleIconsResponse, HelloResponse, LevelsResponse,
  NewCodeResponse, Ok, PairInfo, PressResponse, SaveLibraryResponse, SettingsResponse, SettingsSaved, SignedFields,
  SoundsChanged, SoundsResponse, StatusResponse
} from "../shared/api.ts"
import { isHexColor } from "../shared/colors.ts"
import { faderLevelKey, isLibraryShape, normalizeLibrary } from "../shared/model.ts"
import { isThemeId } from "../shared/themes.ts"
import { LIMITS } from "../shared/actions.ts"
import { prepareSteps, runSteps } from "./actions.ts"
import { listApps } from "./apps.ts"
import { createObsLink } from "./obs.ts"
import { readLocalObs } from "./obs-config.ts"
import { createPlayer } from "./player.ts"
import { AuthError, createAuth } from "./auth.ts"
import type { Device } from "./auth.ts"
import { loadConfig, saveConfig } from "./config.ts"
import { createLive } from "./events.ts"
import { createGoogleIcons } from "./google-icons.ts"
import { HttpError, JSON_LIMIT, SECURITY_HEADERS, errorText, jsonBody, rawBody, sendJson, staticFile } from "./http.ts"
import type { Request } from "./http.ts"
import { createLibraryStore } from "./library.ts"
import { getLocalIPv4, ownHostnames } from "./net.ts"
import { createSoundStore, isAudio } from "./sounds.ts"
import type { AudioType } from "./sounds.ts"
import { readLevel, writeLevel } from "./volume.ts"
import type { VolumeContext } from "./volume.ts"
import { claimPort } from "./port.ts"
import { DATA_DIR, migrateLegacyData, paths } from "./paths.ts"

const PUBLIC_DIR = paths.public
// Libraries carry custom icons as data URIs, so they can be large.
const LIBRARY_LIMIT = 24 * 1024 * 1024

const log = (message: string): void => console.log(`[punchboard] ${message}`)

// ------------------------------------------------------------------ state

migrateLegacyData(log)
const config = loadConfig(paths.config, log)
/** PUNCHBOARD_PORT overrides the saved port for this run only (used by tests). */
const PORT_OVERRIDE = Number(process.env.PUNCHBOARD_PORT) || 0
/** The port actually listened on, settled at start-up (see claimPort). */
let PORT = PORT_OVERRIDE || config.port
const writeConfig = (): void => saveConfig(paths.config, config)
// A fader drag sends several levels a second; the file only needs the last.
let configTimer: NodeJS.Timeout | undefined
const writeConfigSoon = (): void => {
  clearTimeout(configTimer)
  configTimer = setTimeout(writeConfig, 400)
}

const library = createLibraryStore(paths.library, log)
const auth = createAuth({ file: paths.devices, log })
const sounds = createSoundStore(paths.sounds)
sounds.ensureDefaults()
// The page bundles' modification times name the build. When they change
// (an update, or a rebuild while developing) every open page finds out.
const BUNDLES = ["deck.js", "designer.js", "pair.js"].map((name) => path.join(PUBLIC_DIR, "js", name))
function currentBuild(): string {
  return BUNDLES.map((file) => {
    try { return Math.round(fs.statSync(file).mtimeMs).toString(36) } catch { return "0" }
  }).join(".")
}
let build = currentBuild()
setInterval(() => {
  const next = currentBuild()
  if (next === build) return
  build = next
  log("The pages were updated; open decks reload themselves.")
  live.broadcast()
}, 5000).unref()

// Sounds play from this process. A sound whose length could not be read
// from its file learns it from a full play (afplay adds ~0.7 s of its own
// start-up, so this is only the fallback).
const player = createPlayer({
  helper: path.join(paths.helpers, "mac-player.js"),
  volume: () => config.soundVolume,
  log,
  onEnded: (slot, ranMs) => {
    if (ranMs !== null && sounds.durationMs(slot) === null && sounds.setDuration(slot, ranMs)) live.soundsChanged()
    live.soundEnded(slot)
  }
})
const live = createLive({
  accent: () => config.theme.accent,
  theme: () => config.theme.name,
  libraryRev: library.revision,
  build: () => build,
  obs: () => obs.status(),
  obsIssue: () => obsIssue(),
  soundDuration: (slot) => sounds.durationMs(slot),
  soundFile: (slot) => sounds.file(slot).file
}, player, config.soundVolume)
// Meters are only read for OBS inputs that a fader on a connected page shows.
const obs = createObsLink({
  config,
  log,
  onStatus: () => live.broadcast(),
  onMeters: (levels) => live.broadcastMeters(levels),
  wantedInputs: () => {
    const wanted = new Set<string>()
    if (!live.hasListeners()) return wanted
    for (const profile of library.get().profiles) {
      for (const button of profile.buttons) {
        if (button.control === "fader" && button.fader.target === "obs_input" && button.fader.inputName) wanted.add(button.fader.inputName)
      }
    }
    return wanted
  }
})
/** Points the OBS link at an OBS on this computer, from its own settings. */
function applyLocalObs(local: ReturnType<typeof readLocalObs>): boolean {
  config.obs.address = `ws://127.0.0.1:${local.port}`
  config.obs.password = local.password
  config.obs.source = "auto"
  writeConfig()
  obs.reset()
  return true
}

const isLocalObsAddress = (address: string): boolean => /^wss?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(address)

/** Why OBS is not connected. For an OBS on this computer, its own settings
    tell a switched-off server apart from a closed OBS. */
function obsIssue(): ObsIssue {
  const issue = obs.issue()
  if (obs.status() === "connected" || issue === "wrong-password" || !isLocalObsAddress(config.obs.address)) return issue
  const local = readLocalObs()
  return local.found && !local.enabled ? "server-off" : issue
}

// Settings typed in by hand that match this computer's OBS are really OBS's
// own, so they follow OBS from now on.
if (config.obs.source === "manual" && isLocalObsAddress(config.obs.address)) {
  const local = readLocalObs()
  if (local.found && config.obs.password === local.password) config.obs.source = "auto"
}

// Unless someone typed their own settings, follow OBS's: a new password or
// port in OBS is picked up on the next start without anyone noticing.
if (config.obs.source === "auto") {
  const local = readLocalObs()
  if (local.found && (config.obs.password !== local.password || config.obs.address !== `ws://127.0.0.1:${local.port}`)) {
    config.obs.address = `ws://127.0.0.1:${local.port}`
    config.obs.password = local.password
    writeConfig()
    log("Using OBS's WebSocket settings from this computer.")
  }
}

const googleIcons = createGoogleIcons(paths.cache)
const volumeContext: VolumeContext = { config, obs, saveConfig: writeConfigSoon, setSoundVolume: (level) => player.setVolume(level) }

// ------------------------------------------------------------------ access

// Host names change when the wifi does, so they are refreshed every few
// seconds rather than fixed at start-up.
let hostCache = { at: 0, names: new Set<string>() }
function hostnames(): Set<string> {
  if (Date.now() - hostCache.at > 5000) hostCache = { at: Date.now(), names: ownHostnames() }
  return hostCache.names
}

// Only loopback is trusted as "this computer". Anything reaching the server by
// its network address, even from this machine, has to pair like a tablet.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
const isLocal = (req: Request): boolean => LOOPBACK.has(req.socket.remoteAddress ?? "")

function hostAllowed(req: Request): boolean {
  const match = String(req.headers.host ?? "").toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  if (!match?.[1]) return false
  return hostnames().has(match[1]) && Number(match[2] ?? 80) === PORT
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host ?? "").toLowerCase()
  } catch {
    return false
  }
}

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name]
  return typeof value === "string" ? value : undefined
}

/** The paired device a request is signed by, or null for this computer. */
async function requireDeck(req: Request, url: URL): Promise<Device | null> {
  if (isLocal(req)) return null
  const query = url.searchParams
  // EventSource cannot send headers, so the stream is signed in its address.
  const signed: Partial<SignedFields> = url.pathname === "/api/events"
    ? { device: query.get("d") ?? undefined, time: query.get("t") ?? undefined, nonce: query.get("n") ?? undefined, signature: query.get("s") ?? undefined }
    : { device: header(req, "x-punchboard-device"), time: header(req, "x-punchboard-time"), nonce: header(req, "x-punchboard-nonce"), signature: header(req, "x-punchboard-signature") }
  const method = req.method ?? "GET"
  const body = method === "GET" || method === "HEAD" ? "" : (await rawBody(req, JSON_LIMIT)).toString("utf8")
  try {
    return auth.verify(signed, method, url.pathname, body, req.socket.remoteAddress)
  } catch (error) {
    if (error instanceof AuthError) throw new HttpError(401, error.message, { code: error.code, serverTime: Date.now() })
    throw error
  }
}

// ------------------------------------------------------------------ helpers

const deckUrl = (): string => `http://${getLocalIPv4()}:${PORT}`
// The code travels in the hash, which browsers never send to a server or put
// in a Referer.
const pairUrl = (): string => `${deckUrl()}/deck#pair=${auth.currentCode().code}`

function deviceName(req: Request): string {
  const agent = String(req.headers["user-agent"] ?? "")
  if (/iPad|Macintosh.*Mobile/.test(agent)) return "iPad"
  if (/iPhone/.test(agent)) return "iPhone"
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? "Android phone" : "Android tablet"
  if (/Windows/.test(agent)) return "Windows browser"
  return "Browser"
}

const audioType = (value: string): AudioType | null => (value === "audio/wav" ? "audio/wav" : value === "audio/mpeg" || value === "audio/mp3" ? "audio/mpeg" : null)

// ------------------------------------------------------------------ routes

type Access = "public" | "deck" | "local"

interface Context {
  req: Request
  res: ServerResponse
  url: URL
  params: readonly (string | undefined)[]
  device: Device | null
}

/** A handler returns the response body, or undefined when it answered itself. */
interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE"
  pattern: string | RegExp
  access: Access
  handler: (context: Context) => unknown
}

/** Declares a route; `T` is the response body type from src/shared/api.ts. */
function route<T>(method: Route["method"], pattern: string | RegExp, access: Access, handler: (context: Context) => T | Promise<T>): Route {
  return { method, pattern, access, handler }
}

const routes: Route[] = [
  // --- pairing
  // Public on purpose: the clock for signatures, and colours for the pairing screen.
  route<HelloResponse>("GET", "/api/hello", "public", () => ({ serverTime: Date.now(), accent: config.theme.accent, theme: config.theme.name })),
  route<ClaimResponse>("POST", "/api/pair/claim", "public", async ({ req }) => {
    const data = await jsonBody(req)
    try {
      const device = auth.claim(data.code, typeof data.name === "string" && data.name ? data.name : deviceName(req), req.socket.remoteAddress)
      return { device: { id: device.id, secret: device.secret, name: device.name }, serverTime: Date.now() }
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(error.code === "locked" ? 429 : 400, error.message, { code: error.code })
      throw error
    }
  }),
  route<PairInfo>("GET", "/api/pair", "local", () => {
    const { code, expiresAt } = auth.currentCode()
    return { deckUrl: deckUrl(), pairUrl: pairUrl(), code, expiresAt, devices: auth.list() }
  }),
  route<NewCodeResponse>("POST", "/api/pair/new-code", "local", () => {
    const { code, expiresAt } = auth.newCode()
    return { code, expiresAt, pairUrl: pairUrl() }
  }),
  route<void>("GET", "/api/pair-qr.svg", "local", async ({ res }) => {
    const qr = await QRCode.toString(pairUrl(), { type: "svg", errorCorrectionLevel: "M", margin: 1 })
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "image/svg+xml", "Cache-Control": "no-store" })
    res.end(qr)
  }),
  route<DevicesResponse>("DELETE", /^\/api\/devices\/(dev_[0-9a-f]+)$/, "local", ({ params }) => {
    const id = params[1] ?? ""
    if (!auth.remove(id)) throw new HttpError(404, "That device is not paired.")
    live.disconnectDevice(id)
    return { ok: true, devices: auth.list() }
  }),

  // --- live state
  route<void>("GET", "/api/events", "deck", ({ req, res, device }) => {
    live.openStream(req, res, device?.id ?? "")
  }),
  route<StatusResponse>("GET", "/api/status", "deck", () => ({ ok: true, ...live.snapshot() })),

  // --- the deck library
  route<void>("GET", "/api/library", "deck", ({ res }) => {
    sendJson(res, 200, library.get(), { "X-Library-Rev": String(library.revision()) })
  }),
  route<SaveLibraryResponse>("PUT", "/api/library", "local", async ({ req, url }) => {
    const data = await jsonBody(req, LIBRARY_LIMIT)
    if (!isLibraryShape(data)) throw new HttpError(400, "That is not a valid deck library.")
    const baseRev = url.searchParams.get("rev")
    if (baseRev !== null && Number(baseRev) !== library.revision()) {
      throw new HttpError(409, "This deck was changed in another window. Reloading the latest version.", { libraryRev: library.revision() })
    }
    const libraryRev = library.save(normalizeLibrary(data))
    live.broadcast()
    return { ok: true, libraryRev }
  }),

  // --- settings
  route<SettingsResponse>("GET", "/api/settings", "deck", () => ({
    accent: config.theme.accent,
    theme: config.theme.name,
    obsAddress: config.obs.address,
    obsConfigured: Boolean(config.obs.password),
    obsSource: config.obs.source,
    platform: process.platform
  })),
  route<SettingsSaved>("PUT", "/api/settings", "local", async ({ req }) => {
    const data = await jsonBody(req)
    if (data.accent && !isHexColor(data.accent)) throw new HttpError(400, "Choose a six-digit colour.")
    if (data.theme !== undefined && !isThemeId(data.theme)) throw new HttpError(400, "That theme does not exist.")
    if (isHexColor(data.accent)) config.theme.accent = data.accent
    if (isThemeId(data.theme)) config.theme.name = data.theme
    const obsBefore = `${config.obs.address}\n${config.obs.password}`
    if (typeof data.obsAddress === "string" || typeof data.obsPassword === "string") config.obs.source = "manual"
    if (typeof data.obsAddress === "string" && data.obsAddress.length < 160) config.obs.address = data.obsAddress
    if (typeof data.obsPassword === "string" && data.obsPassword.length < 500) config.obs.password = data.obsPassword
    if (`${config.obs.address}\n${config.obs.password}` !== obsBefore) obs.reset()
    writeConfig()
    live.broadcast()
    return { ok: true, accent: config.theme.accent, theme: config.theme.name }
  }),

  // --- pressing: the server runs the saved button, never steps from the request
  route<PressResponse>("POST", "/api/press", "deck", async ({ req }) => {
    const data = await jsonBody(req)
    const button = library.findButton(data.profileId, data.buttonId)
    if (!button) throw new HttpError(404, "That button no longer exists. The deck will refresh.")
    if (button.control === "fader") throw new HttpError(400, "That is a fader; drag it instead.")
    const steps = prepareSteps(button)
    let result
    try {
      result = await runSteps(steps, { config, obs, onSound: live.toggleSound })
    } catch (error) {
      throw new HttpError(400, errorText(error))
    }
    if (typeof result.active === "boolean") live.setToggle(`${String(data.profileId)}:${String(data.buttonId)}`, result.active)
    const response: PressResponse = { ok: true, tabletUrl: result.tabletUrl }
    if (typeof result.active === "boolean") response.active = result.active
    if (steps.length > 1) response.message = `Ran ${steps.length} steps`
    return response
  }),

  // --- faders, also looked up from the saved deck
  route<LevelsResponse>("POST", "/api/volume", "deck", async ({ req }) => {
    const data = await jsonBody(req)
    const button = library.findButton(data.profileId, data.buttonId)
    if (!button || button.control !== "fader") throw new HttpError(404, "That fader no longer exists.")
    try {
      live.levels[faderLevelKey(button.fader)] = await writeLevel(button.fader, data.level, volumeContext)
    } catch (error) {
      throw new HttpError(400, errorText(error))
    }
    live.broadcast()
    return { ok: true, levels: live.levels }
  }),
  // Reads the real levels (OBS, the computer) for every fader in a profile.
  route<LevelsResponse>("POST", "/api/volume/sync", "deck", async ({ req }) => {
    const data = await jsonBody(req)
    await Promise.all(library.faders(data.profileId).map(async (button) => {
      try {
        live.levels[faderLevelKey(button.fader)] = await readLevel(button.fader, volumeContext)
      } catch { /* an unreachable source keeps its last known level */ }
    }))
    live.broadcast()
    return { ok: true, levels: live.levels }
  }),

  // --- sounds
  route<SoundsResponse>("GET", "/api/sounds", "local", () => ({ slots: sounds.slots() })),
  route<SoundsChanged>("PUT", /^\/api\/sounds\/([1-8])$/, "local", async ({ req, params }) => {
    const type = audioType(String(req.headers["content-type"] ?? "").split(";")[0] ?? "")
    const data = await rawBody(req, LIMITS.maxSoundBytes)
    if (!type || !isAudio(data, type)) throw new HttpError(400, "That file is not a readable WAV or MP3.")
    sounds.saveUpload(Number(params[1]), type, data, req.headers["x-sound-name"])
    live.soundsChanged()
    return { ok: true, slots: sounds.slots() }
  }),
  // Puts a slot back to the generated tone it shipped with.
  route<SoundsChanged>("DELETE", /^\/api\/sounds\/([1-8])$/, "local", ({ params }) => {
    if (!sounds.revert(Number(params[1]))) throw new HttpError(400, "That slot already holds the built-in tone.")
    live.soundsChanged()
    return { ok: true, slots: sounds.slots() }
  }),
  route<void>("GET", /^\/api\/sounds\/([1-8])\/file$/, "local", ({ res, params }) => staticFile(res, sounds.file(Number(params[1])).file)),
  // The audio tab reports a sound that finished on its own.
  // The Control Center learns an MP3's length when it plays it; WAVs are read from their header.
  // Previews play the same way a deck press does, through this computer's speakers.
  route<Ok>("POST", /^\/api\/sounds\/([1-8])\/preview$/, "local", ({ params }) => {
    live.toggleSound(Number(params[1]))
    return { ok: true }
  }),
  route<Ok>("POST", "/api/sounds/stop", "deck", () => {
    live.stopAllSounds()
    return { ok: true }
  }),

  route<AppsResponse>("GET", "/api/apps", "local", () => ({ apps: listApps() })),

  // Takes over OBS's own settings from this computer; nothing to copy.
  route<ObsDetectResponse>("POST", "/api/obs/detect", "local", () => {
    const local = readLocalObs()
    const applied = local.found && applyLocalObs(local)
    return { found: local.found, enabled: local.enabled, port: local.port, applied }
  }),

  // --- Google icons, browsed from the Control Center only
  route<GoogleIconsResponse>("GET", "/api/icons/google", "local", async () => {
    try {
      return { icons: await googleIcons.loadCatalog() }
    } catch (error) {
      throw new HttpError(502, errorText(error))
    }
  }),
  route<GlyphResponse>("GET", "/api/icons/google/glyph", "local", async ({ url }) => {
    const params = url.searchParams
    try {
      return await googleIcons.loadGlyph(params.get("name") ?? "", params.get("style") ?? "outlined", params.get("fill") === "1")
    } catch (error) {
      throw new HttpError(400, errorText(error))
    }
  }),

  route<void>("POST", "/api/shutdown", "local", ({ res }) => {
    sendJson(res, 200, { ok: true } satisfies Ok)
    res.once("finish", shutdown)
  })
]

function matchRoute(method: string, pathname: string): { route: Route; params: readonly (string | undefined)[] } | null {
  for (const candidate of routes) {
    if (candidate.method !== method) continue
    if (typeof candidate.pattern === "string") {
      if (candidate.pattern === pathname) return { route: candidate, params: [pathname] }
      continue
    }
    const match = pathname.match(candidate.pattern)
    if (match) return { route: candidate, params: [...match] }
  }
  return null
}

const PAGES: Record<string, string> = { "/": "deck.html", "/deck": "deck.html", "/designer": "designer.html", "/pair": "pair.html" }

async function handle(req: Request, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  const method = req.method ?? "GET"
  if (!hostAllowed(req)) throw new HttpError(403, "Open Punchboard by this computer's address, as printed when the companion started.")
  if (method !== "GET" && method !== "HEAD" && !originAllowed(req)) throw new HttpError(403, "Requests from other sites are refused.")

  if (url.pathname.startsWith("/api/")) {
    const found = matchRoute(method, url.pathname)
    if (!found) throw new HttpError(404, "Not found")
    if (found.route.access === "local" && !isLocal(req)) {
      throw new HttpError(403, `That is only available on the computer running the companion, at http://localhost:${PORT}.`)
    }
    const device = found.route.access === "deck" ? await requireDeck(req, url) : null
    const body = await found.route.handler({ req, res, url, params: found.params, device })
    if (body !== undefined && !res.headersSent) sendJson(res, 200, body)
    return
  }

  const file = path.resolve(PUBLIC_DIR, PAGES[url.pathname] ?? url.pathname.replace(/^\/+/, ""))
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, "Forbidden")
  staticFile(res, file)
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (res.headersSent) return
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...error.extra } satisfies ErrorResponse)
    log(`Request failed: ${errorText(error)}`)
    sendJson(res, 500, { error: errorText(error) || "Something went wrong" } satisfies ErrorResponse)
  })
})

function announce(): void {
  const control = `http://localhost:${PORT}/designer`
  const pair = `http://localhost:${PORT}/pair`
  const link = (url: string): string => `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`
  console.log("\n  Punchboard is ready\n")
  console.log(`  Control Center:  ${link(control)}`)
  console.log(`  Pair a device:   ${link(pair)}`)
  console.log(`  Your data:       ${DATA_DIR}\n`)
  qrcodeTerminal.generate(pairUrl(), { small: true }, (code) => console.log(code))
  console.log(`  Scan with a tablet on the same wifi, or open ${deckUrl()} on it and enter code ${auth.currentCode().code}.\n`)
}

/** Brings the Control Center up in the default browser, so starting Punchboard
    is one double-click. PUNCHBOARD_NO_OPEN=1 turns it off (tests, servers). */
function openControlCenter(port: number): void {
  if (process.env.PUNCHBOARD_NO_OPEN === "1") return
  open(`http://localhost:${port}/designer`).catch(() => { /* the printed link still works */ })
}

// The desktop app runs the companion as a child process: it reads the port
// from this line and asks for a clean exit by writing "quit" to stdin.
const DESKTOP = process.env.PUNCHBOARD_DESKTOP === "1"
function desktopReady(port: number): void {
  if (DESKTOP) console.log(`PUNCHBOARD_READY ${port}`)
}
if (DESKTOP) {
  let input = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    input += chunk
    if (input.includes("quit")) shutdown()
  })
  // The app went away without saying so: follow it.
  process.stdin.on("end", () => shutdown())
}

/** Stops sounds and OBS, saves what is pending, closes streams, exits. */
function shutdown(): void {
  player.dispose()
  obs.stop()
  auth.flush()
  live.closeAll()
  server.close()
  setTimeout(() => process.exit(0), 200).unref()
}

async function start(): Promise<void> {
  const outcome = await claimPort(server, PORT)
  if (outcome.kind === "already-running") {
    desktopReady(outcome.port)
    console.log(`\n  Punchboard is already running at http://localhost:${outcome.port}/designer`)
    console.log("  Opening it instead of starting a second copy.\n")
    openControlCenter(outcome.port)
    process.exit(0)
  }
  if (outcome.kind === "no-free-port") {
    console.error(`\n  Ports ${PORT} to ${PORT + 20} are all taken by other programs, so Punchboard cannot start.`)
    console.error("  Close one of them, or set a different \"port\" in config.json.\n")
    process.exit(1)
  }
  if (outcome.moved) {
    console.log(`\n  Port ${PORT} is taken by another program, so Punchboard is using ${outcome.port} instead.`)
    // Remembered, so the address (and every tablet's pairing) stays put from now on.
    if (!PORT_OVERRIDE) {
      config.port = outcome.port
      writeConfig()
      console.log("  Paired tablets need to open the new address and pair once more; after that it stays fixed.")
    }
  }
  PORT = outcome.port
  announce()
  obs.start()
  desktopReady(PORT)
  openControlCenter(PORT)
}

start().catch((error: unknown) => {
  console.error(`  Punchboard could not start: ${errorText(error)}`)
  process.exit(1)
})

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
