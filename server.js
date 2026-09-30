#!/usr/bin/env node
// Punchboard: serves the Control Center to this computer and the
// deck to paired tablets, and runs their button presses.
//
// Who may call what:
//   public  pages, and claiming a pairing code
//   deck    a paired device with a signed request (lib/auth.js), or this computer
//   local   this computer only: editing decks, settings, sounds, pairing
// Every request must also name this server in its Host header and, when it
// changes something, come from this server's own origin. That stops other
// web pages and DNS rebinding from driving the companion through a browser.
const http = require("http")
const fs = require("fs")
const path = require("path")
const QRCode = require("qrcode")
const qrcodeTerminal = require("qrcode-terminal")
const { getLocalIPv4, ownHostnames } = require("./lib/net")
const { ensureDefaultSounds, restoreDefaultSound } = require("./lib/sounds")
const { runSteps, resetObsClient } = require("./lib/actions")
const { levelKey, readLevel, writeLevel } = require("./lib/volume")
const { createGoogleIcons } = require("./lib/google-icons")
const { createAuth, AuthError } = require("./lib/auth")
const { writeJsonAtomic, readJsonSafe, snapshotDaily } = require("./lib/store")
const { normalizeLibrary, THEMES, DEFAULT_THEME } = require("./public/deck-shared.js")

const ROOT = __dirname
const PUBLIC_DIR = path.join(ROOT, "public")
const SOUNDS_DIR = path.join(ROOT, "sounds")
const DATA_DIR = path.join(ROOT, "data")
const CONFIG_PATH = path.join(ROOT, "config.json")
const SOUNDS_CONFIG_PATH = path.join(SOUNDS_DIR, "sounds.json")

const ACTION_TYPES = new Set(["hotkey", "launch_app", "open_url", "obs_scene", "obs_toggle_source", "obs_toggle_mute", "obs_start_stop_stream", "obs_toggle_record", "play_sound", "browser_tile", "none"])
const DEFAULTS = { port: 8787, profileFile: "./profiles/current-profile.json", theme: { name: DEFAULT_THEME, accent: "#5fd0d6", accentPreset: "custom" }, soundVolume: 1, obs: { address: "ws://127.0.0.1:4455", password: "" } }
// Libraries carry custom icons as data URIs, so they can be large.
const LIBRARY_LIMIT = 24 * 1024 * 1024
const JSON_LIMIT = 256 * 1024
const AUDIO_LIMIT = 8 * 1024 * 1024

const log = (message) => console.log(`[punchboard] ${message}`)

// ------------------------------------------------------------------ state

function loadConfig() {
  let raw = {}
  try {
    raw = readJsonSafe(CONFIG_PATH, (data) => data && typeof data === "object").data || {}
  } catch (error) {
    log(`${error.message} Starting with default settings.`)
  }
  return { ...DEFAULTS, ...raw, theme: { ...DEFAULTS.theme, ...raw.theme }, obs: { ...DEFAULTS.obs, ...raw.obs } }
}
const config = loadConfig()
const PROFILE_PATH = path.resolve(ROOT, config.profileFile)

const validAccent = (value) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
const validTheme = (value) => THEMES.some((theme) => theme.id === value)
const validLibrary = (value) => value && value.version === 1 && typeof value.activeProfileId === "string" && Array.isArray(value.profiles)

// The library lives in memory and is written through to disk atomically. A
// file that will not parse is set aside and never overwritten.
function loadLibrary() {
  try {
    const { data, source, aside } = readJsonSafe(PROFILE_PATH, validLibrary)
    if (source === "backup") {
      log(`The deck file was damaged, so the previous save was restored. The damaged copy is kept as ${path.basename(aside)}.`)
      // Put the recovered deck back on disk now, not at the next edit.
      writeJsonAtomic(PROFILE_PATH, data, { backup: false })
    }
    if (data) return normalizeLibrary(data)
  } catch (error) {
    log(`${error.message} Starting with an empty deck; restore a backup from the Control Center or profiles/backups.`)
  }
  const fresh = normalizeLibrary({ version: 1, activeProfileId: "", profiles: [] })
  writeLibrary(fresh)
  return fresh
}
function writeLibrary(next) {
  snapshotDaily(PROFILE_PATH)
  writeJsonAtomic(PROFILE_PATH, next)
}
let library = loadLibrary()
// Bumped on every write. Decks refetch when it changes, and the Control
// Center sends the revision it edited so two windows cannot overwrite each other.
let libraryRev = 1

function writeConfig() { writeJsonAtomic(CONFIG_PATH, config) }
// A fader drag sends several levels a second; the file only needs the last.
let configTimer = null
function writeConfigSoon() { clearTimeout(configTimer); configTimer = setTimeout(writeConfig, 400) }

const auth = createAuth({ file: path.join(DATA_DIR, "devices.json"), log })

const toggleStates = new Map()
// Sound playback is a toggle the server owns. One Control Center tab is the
// audio output: it plays what it is told, reports when a sound ends, and a
// second press on the same sound stops it instead of stacking another copy.
const playingSounds = new Set()
const soundCommands = [] // the last few { id, slot, action }, newest last
let soundSeq = 0
const audioOutputs = new Map() // tab id -> stream; the newest tab plays
// Fader levels by target (see lib/volume.js), 0..1, so every deck agrees.
const levels = { sounds: config.soundVolume }
let soundsRev = 1
const listeners = new Map() // stream -> device id, or "" for this computer

// ----------------------------------------------------------------- sounds

function readSoundMap() {
  try { return readJsonSafe(SOUNDS_CONFIG_PATH, (data) => data && typeof data === "object").data || {} } catch { return {} }
}
function writeSoundMap(map) { writeJsonAtomic(SOUNDS_CONFIG_PATH, map) }

// Earlier versions stored just the extension as a bare string. Both shapes are
// read; only the richer one is written.
function soundEntry(slot) {
  const raw = readSoundMap()[slot]
  if (!raw) return null
  if (typeof raw === "string") return { ext: raw === "mp3" ? "mp3" : "wav", name: "" }
  return { ext: raw.ext === "mp3" ? "mp3" : "wav", name: typeof raw.name === "string" ? raw.name : "", uploadedAt: raw.uploadedAt }
}
function soundFile(slot) {
  const entry = soundEntry(slot)
  const ext = entry ? entry.ext : "wav"
  return { file: path.join(SOUNDS_DIR, `sound-${slot}.${ext}`), ext }
}
// Only ever shown back to the user; the file on disk is always sound-N.ext.
function safeName(value) { return String(value || "").replace(/[^\w .()[\]-]/g, "").slice(0, 80) }

function soundSlots() {
  return Array.from({ length: 8 }, (_, index) => {
    const slot = index + 1
    const entry = soundEntry(slot)
    const target = soundFile(slot)
    const stat = fs.existsSync(target.file) ? fs.statSync(target.file) : null
    return {
      slot,
      exists: Boolean(stat),
      custom: Boolean(entry),
      name: entry && entry.name ? entry.name : "",
      format: target.ext.toUpperCase(),
      bytes: stat ? stat.size : 0,
      updatedAt: stat ? stat.mtime.toISOString() : null
    }
  })
}

function isAudio(data, type) {
  if (type === "audio/wav") return data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WAVE"
  if (type === "audio/mpeg") return data.subarray(0, 3).toString() === "ID3" || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  return false
}

function audioOutputId() {
  let newest = null
  for (const id of audioOutputs.keys()) newest = id
  return newest
}

function sendSoundCommand(slot, action) {
  soundSeq += 1
  soundCommands.push({ id: soundSeq, slot, action })
  if (soundCommands.length > 20) soundCommands.shift()
  if (action === "play") playingSounds.add(slot)
  else playingSounds.delete(slot)
  broadcast()
}

function toggleSound(slot) {
  if (!audioOutputId()) throw new Error("Open the Control Center on this computer to play sounds.")
  sendSoundCommand(slot, playingSounds.has(slot) ? "stop" : "play")
}

ensureDefaultSounds(SOUNDS_DIR, Object.keys(readSoundMap()).map(Number))

// ------------------------------------------------------------------- push

function snapshot() {
  return {
    libraryRev,
    soundsRev,
    toggles: Object.fromEntries(toggleStates),
    soundCommands,
    playing: [...playingSounds],
    audioOutput: audioOutputId(),
    levels,
    accent: config.theme.accent,
    theme: config.theme.name
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`
  for (const res of listeners.keys()) {
    try { res.write(payload) } catch { listeners.delete(res) }
  }
}

function openEventStream(req, res, { deviceId = "", audioId = "" }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  })
  res.write("retry: 2000\n\n")
  listeners.set(res, deviceId)
  if (audioId) {
    // Re-adding moves it to the end, so a reloaded tab becomes the output again.
    audioOutputs.delete(audioId)
    audioOutputs.set(audioId, res)
    broadcast()
  } else {
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
  }
  // A comment frame keeps intermediaries and sleeping wifi from dropping it.
  const beat = setInterval(() => { try { res.write(": beat\n\n") } catch {} }, 20000)
  const close = () => {
    clearInterval(beat)
    listeners.delete(res)
    if (!audioId || audioOutputs.get(audioId) !== res) return
    const wasPlaying = audioOutputId() === audioId
    audioOutputs.delete(audioId)
    // Its audio died with the tab, so nothing is playing any more.
    if (wasPlaying) playingSounds.clear()
    broadcast()
  }
  req.on("close", close)
  req.on("error", close)
}

// Ends a revoked device's live streams, so it notices straight away.
function disconnectDevice(deviceId) {
  for (const [res, owner] of listeners) {
    if (owner === deviceId) { try { res.end() } catch {} listeners.delete(res) }
  }
}

// ------------------------------------------------------------------- http

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store", ...headers })
  res.end(data)
}

const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".png": "image/png" }

function staticFile(res, file) {
  fs.readFile(file, (error, data) => {
    if (error) return sendJson(res, 404, { error: "Not found" })
    const type = STATIC_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": data.length, "Cache-Control": "no-cache" })
    res.end(data)
  })
}

// The raw body is read once and kept, because a signature covers the exact
// bytes that were sent.
function rawBody(req, limit) {
  if (req.rawBody) return Promise.resolve(req.rawBody)
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new HttpError(413, "That request is too large.")); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on("end", () => { req.rawBody = Buffer.concat(chunks); resolve(req.rawBody) })
    req.on("error", reject)
  })
}

// JSON bodies must say so. A cross-site form can only send text/plain or
// form encodings, so this alone refuses forged form posts.
async function jsonBody(req, limit = JSON_LIMIT) {
  if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) throw new HttpError(415, "Send JSON with Content-Type: application/json.")
  const raw = await rawBody(req, limit)
  if (!raw.length) return {}
  try { return JSON.parse(raw.toString("utf8")) } catch { throw new HttpError(400, "That request is not valid JSON.") }
}

// Host names change when the wifi does, so they are refreshed every few
// seconds rather than fixed at start-up.
let hostCache = { at: 0, names: new Set() }
function hostnames() {
  if (Date.now() - hostCache.at > 5000) hostCache = { at: Date.now(), names: ownHostnames() }
  return hostCache.names
}

// Only loopback is trusted as "this computer". Anything reaching the server by
// its network address, even from this machine, has to pair like a tablet.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])
function isLocal(req) { return LOOPBACK.has(req.socket.remoteAddress || "") }

function hostAllowed(req) {
  const host = String(req.headers.host || "").toLowerCase()
  const match = host.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/)
  if (!match) return false
  return hostnames().has(match[1]) && Number(match[2] || 80) === Number(config.port)
}

function originAllowed(req) {
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host.toLowerCase() === String(req.headers.host || "").toLowerCase() } catch { return false }
}

// Returns the paired device a request is signed by, or null for this computer.
async function requireDeck(req, url) {
  if (isLocal(req)) return null
  const fromQuery = url.pathname === "/api/events" // EventSource cannot send headers
  const signed = fromQuery
    ? { device: url.searchParams.get("d"), time: url.searchParams.get("t"), nonce: url.searchParams.get("n"), signature: url.searchParams.get("s") }
    : { device: req.headers["x-punchboard-device"], time: req.headers["x-punchboard-time"], nonce: req.headers["x-punchboard-nonce"], signature: req.headers["x-punchboard-signature"] }
  const body = ["GET", "HEAD"].includes(req.method) ? "" : (await rawBody(req, JSON_LIMIT)).toString("utf8")
  try {
    return auth.verify(signed, req.method, url.pathname, body, req.socket.remoteAddress)
  } catch (error) {
    if (error instanceof AuthError) throw new HttpError(401, error.message, { code: error.code, serverTime: Date.now() })
    throw error
  }
}

// ----------------------------------------------------------------- routes

function deckUrl() { return `http://${getLocalIPv4()}:${config.port}` }
// The code travels in the hash, which browsers never send to a server or
// put in a Referer.
function pairUrl() { return `${deckUrl()}/deck#pair=${auth.currentCode().code}` }

function findButton(profileId, buttonId) {
  const profile = library.profiles.find((item) => item.id === profileId)
  return (profile && profile.buttons.find((item) => item.id === buttonId)) || null
}

function tabletUrl(value) {
  try {
    const destination = new URL(value)
    return ["http:", "https:"].includes(destination.protocol) ? destination.href : null
  } catch {
    return null
  }
}

// Validates a saved button's steps before they run.
function readSteps(button) {
  const raw = button.steps.length ? button.steps : [{ type: "none" }]
  if (raw.length > 12) throw new HttpError(400, "A macro can hold at most 12 steps.")
  return raw.map((step) => {
    if (!step || !ACTION_TYPES.has(step.type)) throw new HttpError(400, "That button contains an action this companion does not know.")
    const copy = { ...step, delayMs: Math.max(0, Math.min(60000, Number(step.delayMs) || 0)) }
    if (copy.type === "browser_tile") {
      copy.tabletUrl = tabletUrl(copy.url)
      if (!copy.tabletUrl) throw new HttpError(400, "Add a valid http or https address for the tablet link.")
    }
    return copy
  })
}

const volumeContext = { config, saveConfig: writeConfigSoon }
const googleIcons = createGoogleIcons(path.join(ROOT, "cache"))

function deviceName(req) {
  const agent = String(req.headers["user-agent"] || "")
  if (/iPad|Macintosh.*Mobile/.test(agent)) return "iPad"
  if (/iPhone/.test(agent)) return "iPhone"
  if (/Android/.test(agent)) return /Mobile/.test(agent) ? "Android phone" : "Android tablet"
  if (/Windows/.test(agent)) return "Windows browser"
  return "Browser"
}

const routes = [
  // --- pairing
  // Public on purpose: the clock for signatures, and colours for the pairing screen.
  ["GET", "/api/hello", "public", () => ({ serverTime: Date.now(), accent: config.theme.accent, theme: config.theme.name })],
  ["POST", "/api/pair/claim", "public", async ({ req }) => {
    const data = await jsonBody(req)
    try {
      const device = auth.claim(data.code, data.name || deviceName(req), req.socket.remoteAddress)
      return { device: { id: device.id, secret: device.secret, name: device.name }, serverTime: Date.now() }
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(error.code === "locked" ? 429 : 400, error.message, { code: error.code })
      throw error
    }
  }],
  ["GET", "/api/pair", "local", () => {
    const { code, expiresAt } = auth.currentCode()
    return { deckUrl: deckUrl(), pairUrl: pairUrl(), code, expiresAt, devices: auth.list() }
  }],
  ["POST", "/api/pair/new-code", "local", () => {
    const { code, expiresAt } = auth.newCode()
    return { code, expiresAt, pairUrl: pairUrl() }
  }],
  ["GET", "/api/pair-qr.svg", "local", async ({ res }) => {
    const svg = await QRCode.toString(pairUrl(), { type: "svg", errorCorrectionLevel: "M", margin: 1 })
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "image/svg+xml", "Cache-Control": "no-store" })
    res.end(svg)
  }],
  ["DELETE", /^\/api\/devices\/(dev_[0-9a-f]+)$/, "local", ({ params }) => {
    if (!auth.remove(params[1])) throw new HttpError(404, "That device is not paired.")
    disconnectDevice(params[1])
    return { ok: true, devices: auth.list() }
  }],

  // --- live state
  ["GET", "/api/events", "deck", ({ req, res, url, device }) => {
    // Only a tab on this computer can be the audio output.
    const audioId = device ? "" : String(url.searchParams.get("audio") || "").slice(0, 64)
    openEventStream(req, res, { deviceId: device ? device.id : "", audioId })
  }],
  ["GET", "/api/status", "deck", () => ({ ok: true, ...snapshot() })],

  // --- the deck library
  ["GET", "/api/library", "deck", ({ res }) => {
    sendJson(res, 200, library, { "X-Library-Rev": String(libraryRev) })
  }],
  ["PUT", "/api/library", "local", async ({ req, url }) => {
    const data = await jsonBody(req, LIBRARY_LIMIT)
    if (!validLibrary(data)) throw new HttpError(400, "That is not a valid deck library.")
    const baseRev = url.searchParams.get("rev")
    if (baseRev !== null && Number(baseRev) !== libraryRev) {
      throw new HttpError(409, "This deck was changed in another window. Reloading the latest version.", { libraryRev })
    }
    library = normalizeLibrary(data)
    writeLibrary(library)
    libraryRev += 1
    broadcast()
    return { ok: true, libraryRev }
  }],

  // --- settings
  ["GET", "/api/settings", "deck", () => ({ accent: config.theme.accent, theme: config.theme.name, obsAddress: config.obs.address, obsConfigured: Boolean(config.obs.password), platform: process.platform })],
  ["PUT", "/api/settings", "local", async ({ req }) => {
    const data = await jsonBody(req)
    if (data.accent && !validAccent(data.accent)) throw new HttpError(400, "Choose a six-digit colour.")
    if (data.theme !== undefined && !validTheme(data.theme)) throw new HttpError(400, "That theme does not exist.")
    if (data.accent) config.theme.accent = data.accent
    if (data.theme) config.theme.name = data.theme
    const obsBefore = `${config.obs.address}\n${config.obs.password}`
    if (typeof data.obsAddress === "string" && data.obsAddress.length < 160) config.obs.address = data.obsAddress
    if (typeof data.obsPassword === "string" && data.obsPassword.length < 500) config.obs.password = data.obsPassword
    if (`${config.obs.address}\n${config.obs.password}` !== obsBefore) resetObsClient()
    writeConfig()
    broadcast()
    return { ok: true, accent: config.theme.accent, theme: config.theme.name }
  }],

  // --- pressing: the server runs the saved button, never steps from the request
  ["POST", "/api/press", "deck", async ({ req }) => {
    const data = await jsonBody(req)
    const button = findButton(data.profileId, data.buttonId)
    if (!button) throw new HttpError(404, "That button no longer exists. The deck will refresh.")
    if (button.control === "fader") throw new HttpError(400, "That is a fader; drag it instead.")
    const steps = readSteps(button)
    let result
    try {
      result = await runSteps(steps, { log, config, soundsDir: SOUNDS_DIR, onSound: toggleSound })
    } catch (error) {
      throw new HttpError(400, error.message)
    }
    if (typeof result.active === "boolean") {
      // Written when it turns off too, so a tile can never latch on for good.
      toggleStates.set(`${data.profileId}:${data.buttonId}`, result.active)
      broadcast()
    }
    return { ok: true, active: result.active, tabletUrl: result.tabletUrl, message: steps.length > 1 ? `Ran ${steps.length} steps` : undefined }
  }],

  // --- faders, also looked up from the saved deck
  ["POST", "/api/volume", "deck", async ({ req }) => {
    const data = await jsonBody(req)
    const button = findButton(data.profileId, data.buttonId)
    if (!button || button.control !== "fader") throw new HttpError(404, "That fader no longer exists.")
    try {
      levels[levelKey(button.fader)] = await writeLevel(button.fader, data.level, volumeContext)
    } catch (error) {
      throw new HttpError(400, error.message)
    }
    broadcast()
    return { ok: true, levels }
  }],
  // Reads the real levels (OBS, the computer) for every fader in a profile.
  ["POST", "/api/volume/sync", "deck", async ({ req }) => {
    const data = await jsonBody(req)
    const profile = library.profiles.find((item) => item.id === data.profileId)
    const faders = profile ? profile.buttons.filter((button) => button.control === "fader") : []
    await Promise.all(faders.map(async (button) => {
      try { levels[levelKey(button.fader)] = await readLevel(button.fader, volumeContext) } catch {}
    }))
    broadcast()
    return { ok: true, levels }
  }],

  // --- sounds
  ["GET", "/api/sounds", "local", () => ({ slots: soundSlots() })],
  ["PUT", /^\/api\/sounds\/([1-8])$/, "local", async ({ req, params }) => {
    const type = String(req.headers["content-type"] || "").split(";")[0]
    const data = await rawBody(req, AUDIO_LIMIT)
    if (!["audio/wav", "audio/mpeg", "audio/mp3"].includes(type) || !isAudio(data, type === "audio/mp3" ? "audio/mpeg" : type)) {
      throw new HttpError(400, "That file is not a readable WAV or MP3.")
    }
    const slot = Number(params[1])
    const ext = type === "audio/wav" ? "wav" : "mp3"
    // Drop the other extension so a WAV never shadows an MP3 in the same slot.
    const other = path.join(SOUNDS_DIR, `sound-${slot}.${ext === "wav" ? "mp3" : "wav"}`)
    if (fs.existsSync(other)) fs.unlinkSync(other)
    fs.writeFileSync(path.join(SOUNDS_DIR, `sound-${slot}.${ext}`), data)
    const map = readSoundMap()
    map[slot] = { ext, name: safeName(req.headers["x-sound-name"]), uploadedAt: new Date().toISOString() }
    writeSoundMap(map)
    soundsRev += 1
    broadcast()
    return { ok: true, slots: soundSlots() }
  }],
  // Puts a slot back to the generated tone it shipped with.
  ["DELETE", /^\/api\/sounds\/([1-8])$/, "local", ({ params }) => {
    const slot = Number(params[1])
    const map = readSoundMap()
    if (!map[slot]) throw new HttpError(400, "That slot already holds the built-in tone.")
    const current = soundFile(slot).file
    if (fs.existsSync(current)) fs.unlinkSync(current)
    delete map[slot]
    writeSoundMap(map)
    restoreDefaultSound(SOUNDS_DIR, slot)
    soundsRev += 1
    broadcast()
    return { ok: true, slots: soundSlots() }
  }],
  ["GET", /^\/api\/sounds\/([1-8])\/file$/, "local", ({ res, params }) => staticFile(res, soundFile(Number(params[1])).file)],
  // The audio tab reports a sound that finished on its own.
  ["POST", "/api/sounds/ended", "local", async ({ req }) => {
    const data = await jsonBody(req)
    if (playingSounds.delete(Number(data.slot))) broadcast()
    return { ok: true }
  }],
  ["POST", "/api/sounds/stop", "deck", () => {
    for (const slot of [...playingSounds]) sendSoundCommand(slot, "stop")
    return { ok: true }
  }],

  // --- Google icons, browsed from the Control Center only
  ["GET", "/api/icons/google", "local", async () => {
    try { return { icons: await googleIcons.loadCatalog() } } catch (error) { throw new HttpError(502, error.message) }
  }],
  ["GET", "/api/icons/google/glyph", "local", async ({ url }) => {
    const params = url.searchParams
    try {
      return await googleIcons.loadGlyph(params.get("name") || "", params.get("style") || "outlined", params.get("fill") === "1")
    } catch (error) {
      throw new HttpError(400, error.message)
    }
  }],

  ["POST", "/api/shutdown", "local", ({ res }) => {
    sendJson(res, 200, { ok: true })
    res.once("finish", () => {
      auth.flush()
      for (const listener of listeners.keys()) { try { listener.end() } catch {} }
      server.close(() => process.exit(0))
    })
  }]
]

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, access, handler] of routes) {
    if (routeMethod !== method) continue
    const params = typeof pattern === "string" ? (pattern === pathname ? [pathname] : null) : pathname.match(pattern)
    if (params) return { access, handler, params }
  }
  return null
}

const PAGES = { "/": "deck.html", "/deck": "deck.html", "/designer": "designer.html", "/pair": "pair.html" }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  try {
    if (!hostAllowed(req)) throw new HttpError(403, "Open Punchboard by this computer's address, as printed when the companion started.")
    if (!["GET", "HEAD"].includes(req.method) && !originAllowed(req)) throw new HttpError(403, "Requests from other sites are refused.")

    if (url.pathname.startsWith("/api/")) {
      const route = matchRoute(req.method, url.pathname)
      if (!route) throw new HttpError(404, "Not found")
      if (route.access === "local" && !isLocal(req)) throw new HttpError(403, `That is only available on the computer running the companion, at http://localhost:${config.port}.`)
      const device = route.access === "deck" ? await requireDeck(req, url) : null
      const result = await route.handler({ req, res, url, params: route.params, device })
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result)
      return
    }

    const file = path.resolve(PUBLIC_DIR, PAGES[url.pathname] || url.pathname.replace(/^\/+/, ""))
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, "Forbidden")
    staticFile(res, file)
  } catch (error) {
    if (res.headersSent) return
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...error.extra })
    log(`Request failed: ${error.message}`)
    sendJson(res, 500, { error: error.message || "Something went wrong" })
  }
})

server.listen(config.port, () => {
  const control = `http://localhost:${config.port}/designer`
  const pair = `http://localhost:${config.port}/pair`
  const link = (url) => `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`
  console.log("\n  Punchboard is ready\n")
  console.log(`  Control Center:  ${link(control)}`)
  console.log(`  Pair a tablet:   ${link(pair)}\n`)
  qrcodeTerminal.generate(pairUrl(), { small: true }, (code) => console.log(code))
  console.log(`  Scan with a tablet on the same wifi, or open ${deckUrl()} on it and enter code ${auth.currentCode().code}.\n`)
})

process.on("SIGINT", () => { auth.flush(); process.exit(0) })
