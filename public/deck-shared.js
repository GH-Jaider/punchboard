/* Shared vocabulary for the Control Center and the tablet deck.
   Deliberately plain ES2019 + hex colors: the whole point of this product is
   the old tablet in your drawer, and oklch()/color-mix()/container-queries all
   need a 2022-or-newer browser. Anything derived from a colour is computed in
   JS instead, so an iPad on an old Safari still renders correctly. */

/* ---------------------------------------------------------------- colours */

function clamp255(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function parseHex(hex) {
  var value = String(hex || "").trim().replace(/^#/, "")
  if (value.length === 3) value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2]
  if (!/^[0-9a-f]{6}$/i.test(value)) return null
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16)
  }
}

function withAlpha(hex, alpha) {
  var rgb = parseHex(hex) || { r: 95, g: 208, b: 214 }
  return "rgba(" + rgb.r + "," + rgb.g + "," + rgb.b + "," + alpha + ")"
}

function mixHex(hex, towardHex, amount) {
  var a = parseHex(hex) || { r: 0, g: 0, b: 0 }
  var b = parseHex(towardHex) || { r: 0, g: 0, b: 0 }
  return "rgb(" +
    clamp255(a.r + (b.r - a.r) * amount) + "," +
    clamp255(a.g + (b.g - a.g) * amount) + "," +
    clamp255(a.b + (b.b - a.b) * amount) + ")"
}

/* Relative luminance, so text on a user-chosen accent stays readable.
   The old build hardcoded dark ink on the accent button: pick a dark
   interface colour there and the label vanished. */
function relativeLuminance(hex) {
  var rgb = parseHex(hex) || { r: 95, g: 208, b: 214 }
  var channel = function (value) {
    var c = value / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

function readableInk(hex) {
  return relativeLuminance(hex) > 0.42 ? "#08100f" : "#ffffff"
}

/* Publishes every accent-derived token at once. Called on both pages so the
   interface colour is a single source of truth. */
function applyAccent(hex, root) {
  var accent = parseHex(hex) ? hex : "#5fd0d6"
  var style = (root || document.documentElement).style
  style.setProperty("--accent", accent)
  style.setProperty("--accent-ink", readableInk(accent))
  style.setProperty("--accent-line", withAlpha(accent, 0.45))
  style.setProperty("--accent-soft", withAlpha(accent, 0.14))
  style.setProperty("--accent-softer", withAlpha(accent, 0.07))
  style.setProperty("--accent-glow", withAlpha(accent, 0.28))
  style.setProperty("--accent-dim", mixHex(accent, "#0a0c0f", 0.55))
  return accent
}

/* Paints one tile's colour-derived custom properties. */
function applyTileColor(element, colorId) {
  var hex = colorValue(colorId)
  element.style.setProperty("--tile-color", hex)
  element.style.setProperty("--tile-ink", readableInk(hex))
  element.style.setProperty("--tile-soft", withAlpha(hex, 0.16))
  element.style.setProperty("--tile-line", withAlpha(hex, 0.45))
  element.style.setProperty("--tile-glow", withAlpha(hex, 0.3))
  element.style.setProperty("--tile-dim", mixHex(hex, "#0b0b0b", 0.55))
}

/* ----------------------------------------------------------------- themes */

/* Each theme is a set of CSS overrides keyed on html[data-theme] (themes.css).
   `bg` feeds the browser's theme-color so the chrome matches. */
var THEMES = [
  { id: "studio", label: "Studio", hint: "Dark and soft. The original look.", bg: "#0d0e11" },
  { id: "hardware", label: "Hardware", hint: "Light chassis, physical keys.", bg: "#e4e2dc" },
  { id: "broadcast", label: "Broadcast", hint: "Switcher console, hard edges.", bg: "#0b0b0b" }
]
var DEFAULT_THEME = "studio"
var THEME_STORAGE_KEY = "punchboard-theme"

function themeById(id) {
  for (var i = 0; i < THEMES.length; i += 1) {
    if (THEMES[i].id === id) return THEMES[i]
  }
  return null
}

/* Remembered locally as well, so the inline script in each page's <head> can
   paint the right theme before the settings request comes back. */
function applyTheme(id) {
  var theme = themeById(id) || themeById(DEFAULT_THEME)
  var root = document.documentElement
  if (root.getAttribute("data-theme") === theme.id) return theme.id
  /* Without this, every button fades between the two palettes at its own
     transition speed and the page smears for a moment. */
  root.setAttribute("data-theme-switching", "")
  root.setAttribute("data-theme", theme.id)
  setTimeout(function () { root.removeAttribute("data-theme-switching") }, 60)
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", theme.bg)
  try { localStorage.setItem(THEME_STORAGE_KEY, theme.id) } catch (e) {}
  return theme.id
}

/* ---------------------------------------------------------------- actions */

/* Every action carries a human hint. The old build put bare labels in a
   <select> with no way to know what "Open in tablet browser" even did. */
var ACTION_META = {
  obs_scene: { label: "Switch scene", group: "OBS", hint: "Make an OBS scene the live program scene." },
  obs_toggle_source: { label: "Show / hide source", group: "OBS", hint: "Toggle one source's visibility inside a scene." },
  obs_toggle_mute: { label: "Mute / unmute input", group: "OBS", hint: "Toggle mute on a single OBS audio input." },
  obs_start_stop_stream: { label: "Start / stop stream", group: "OBS", hint: "Go live, or end the stream if it is already running." },
  obs_toggle_record: { label: "Start / stop recording", group: "OBS", hint: "Begin recording, or stop and save the current take." },
  open_url: { label: "Open link on computer", group: "This computer", hint: "Opens in the default browser on the machine running the companion." },
  launch_app: { label: "Launch an app", group: "This computer", hint: "Starts an application on the machine running the companion." },
  play_sound: { label: "Play a sound", group: "This computer", hint: "Plays through the computer's audio output, not the tablet's." },
  hotkey: { label: "Keyboard shortcut", group: "This computer", hint: "Needs an OS-approved helper, so it is not available yet." },
  browser_tile: { label: "Open link on the tablet", group: "This tablet", hint: "Opens a site in the tablet's own browser, for chat or a dashboard." },
  none: { label: "Do nothing", group: "Other", hint: "A spacer or a label-only tile." }
}

var ACTION_GROUPS = ["OBS", "This computer", "This tablet", "Other"]

/* Actions whose on/off state the companion reports back, so the tile can show
   what is happening right now rather than only that it was tapped. */
var STATEFUL_ACTIONS = ["obs_toggle_mute", "obs_start_stop_stream", "obs_toggle_record", "obs_toggle_source"]

/* The fields each action needs, so the inspector and the step editor can build
   themselves from one table instead of a chain of ifs. */
var ACTION_FIELDS = {
  obs_scene: [{ key: "sceneName", label: "Scene name", placeholder: "Exact OBS scene name" }],
  obs_toggle_source: [
    { key: "sceneName", label: "Scene name", placeholder: "Exact OBS scene name" },
    { key: "sourceName", label: "Source name", placeholder: "Exact OBS source name" }
  ],
  obs_toggle_mute: [{ key: "sourceName", label: "Input name", placeholder: "Exact OBS input name" }],
  open_url: [{ key: "url", label: "Link", placeholder: "https://example.com" }],
  browser_tile: [{ key: "url", label: "Link", placeholder: "https://example.com" }],
  launch_app: [{ key: "appPath", label: "Application", placeholder: "/Applications/OBS.app" }]
}

/* A button is either pressed (it runs `steps`) or a fader (it sets a level).
   Faders drag on the deck; `fader.target` says what they control. */
var FADER_TARGETS = {
  obs_input: { label: "OBS input volume", hint: "The volume of one OBS audio source, on the same curve as OBS's own mixer." },
  sounds: { label: "Punchboard sounds volume", hint: "How loud Play a sound buttons are on this computer." },
  system: { label: "This computer's volume", hint: "The main output volume. macOS only for now." }
}

/* Two faders on the same target share one level. The server uses this too. */
function faderLevelKey(fader) {
  if (!fader) return ""
  return fader.target === "obs_input" ? "obs:" + (fader.inputName || "") : fader.target
}

/* One-line description of a step, for the collapsed step list. */
function stepSummary(step) {
  if (!step) return "Empty step"
  var meta = ACTION_META[step.type] || ACTION_META.none
  var detail = step.sceneName || step.sourceName || step.url || step.appPath ||
    (step.type === "play_sound" ? "Sound " + (step.soundId || 1) : "")
  return detail ? meta.label + " · " + detail : meta.label
}

/* ----------------------------------------------------------------- colours */

var BUTTON_COLORS = [
  { id: "accent", label: "Aqua", value: "#5fd0d6" },
  { id: "blue", label: "Blue", value: "#69a9ff" },
  { id: "indigo", label: "Indigo", value: "#8095ff" },
  { id: "violet", label: "Violet", value: "#b18cd9" },
  { id: "pink", label: "Pink", value: "#e982bd" },
  { id: "rose", label: "Rose", value: "#e8778c" },
  { id: "red", label: "Red", value: "#f06d6d" },
  { id: "orange", label: "Orange", value: "#ed9a55" },
  { id: "amber", label: "Amber", value: "#e0b95c" },
  { id: "yellow", label: "Yellow", value: "#f2d85b" },
  { id: "lime", label: "Lime", value: "#9ed36a" },
  { id: "green", label: "Green", value: "#56c596" },
  { id: "mint", label: "Mint", value: "#63d6b6" },
  { id: "cyan", label: "Cyan", value: "#38c7e8" },
  { id: "slate", label: "Slate", value: "#93a2ad" },
  { id: "white", label: "White", value: "#eaf1f8" }
]

function colorValue(id) {
  for (var i = 0; i < BUTTON_COLORS.length; i += 1) {
    if (BUTTON_COLORS[i].id === id) return BUTTON_COLORS[i].value
  }
  return BUTTON_COLORS[0].value
}

/* ------------------------------------------------------------------- icons */

var DEFAULT_ICON = "radio"

/* Grouped so the picker can offer categories instead of one flat scroll. */
var ICON_GROUPS = [
  { name: "Streaming", ids: ["radio", "video", "camera", "clapperboard", "monitor", "cast", "record", "stop", "play", "pause", "scissors", "layers"] },
  { name: "Audio", ids: ["mic", "mic-off", "volume", "volume-off", "music", "headphones", "sliders"] },
  { name: "Alerts", ids: ["bell", "zap", "star", "heart", "flame", "sparkle", "flag", "gift"] },
  { name: "Chat", ids: ["message", "users", "hash", "thumbs-up", "smile"] },
  { name: "System", ids: ["globe", "link", "folder", "save", "terminal", "command", "keyboard", "power", "settings", "refresh", "timer", "lock", "eye", "eye-off", "plus", "grid"] }
]

var ICONS = {
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  video: '<path d="m16 8 5-3v14l-5-3"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  clapperboard: '<path d="m20.2 6-8.5 3.7L3.2 6"/><path d="M3 8v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8"/><path d="M7.5 4.2 4 5.7"/><path d="M14 3 10.5 4.5"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  cast: '<path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"/><path d="M2 12a9 9 0 0 1 8 8"/><path d="M2 16a5 5 0 0 1 4 4"/><circle cx="3" cy="20" r="1"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M8.1 8.1 20 20"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>',
  "mic-off": '<path d="M15 9V5a3 3 0 0 0-5.7-1.3"/><path d="M9 9v5a3 3 0 0 0 5.1 2.1"/><path d="M5 10a7 7 0 0 0 10.6 6M19 10v1"/><path d="M12 19v3M2 2l20 20"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/>',
  "volume-off": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="m16 9 5 6M21 9l-5 6"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  flame: '<path d="M12 2c3 4 6 6.5 6 11a6 6 0 0 1-12 0c0-2 1-3.5 2-5 .5 1.5 1.5 2 2.5 2C9 8 10 4.5 12 2Z"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 13h18"/><path d="M12 8S10 3 7.5 3a2.5 2.5 0 0 0 0 5M12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  "thumbs-up": '<path d="M7 10v12H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"/><path d="M7 10l4-8a3 3 0 0 1 3 3v5h5a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.6 22H7"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14a4.5 4.5 0 0 0 8 0"/><path d="M9 9h.01M15 9h.01"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M8 3v5h7M8 21v-6h8v6"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  command: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 3-3"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h12M6 17h.01M18 17h.01"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.8 1.17V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 7.3 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 3 14.6a1.65 1.65 0 0 0-1.51-1H1a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 2.6 8.3a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 7 3.7 1.65 1.65 0 0 0 8 2.19V2a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 20.3 8.3V9a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.4 3.3M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a9.9 9.9 0 0 0 4-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
}

/* Google icons (Material Symbols) are stored in the deck as vector paths.
   They come from a backup file as much as from Google, so only a viewBox of
   four numbers and path data made of path commands ever reach the page. */
var GLYPH_VIEWBOX = /^-?[0-9.]+ -?[0-9.]+ [0-9.]+ [0-9.]+$/
var GLYPH_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-eE]{1,20000}$/

function safeGlyph(glyph) {
  if (!glyph || typeof glyph !== "object") return null
  if (typeof glyph.viewBox !== "string" || !GLYPH_VIEWBOX.test(glyph.viewBox)) return null
  if (!Array.isArray(glyph.paths) || !glyph.paths.length || glyph.paths.length > 8) return null
  for (var i = 0; i < glyph.paths.length; i += 1) {
    if (typeof glyph.paths[i] !== "string" || !GLYPH_PATH.test(glyph.paths[i])) return null
  }
  return {
    source: "google",
    name: String(glyph.name || "").replace(/[^a-z0-9_]/g, "").slice(0, 64),
    style: glyph.style === "rounded" || glyph.style === "sharp" ? glyph.style : "outlined",
    fill: Boolean(glyph.fill),
    viewBox: glyph.viewBox,
    paths: glyph.paths.slice()
  }
}

function glyphSvg(glyph) {
  var paths = ""
  for (var i = 0; i < glyph.paths.length; i += 1) paths += '<path d="' + glyph.paths[i] + '"/>'
  return '<svg viewBox="' + glyph.viewBox + '" fill="currentColor" aria-hidden="true" focusable="false">' + paths + "</svg>"
}

function iconSvg(id) {
  var glyph = ICONS[id] || ICONS[DEFAULT_ICON]
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + glyph + "</svg>"
}

function iconMarkup(button) {
  if (button.iconData && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(button.iconData)) {
    return '<img src="' + button.iconData + '" alt="">'
  }
  var glyph = safeGlyph(button.glyph)
  if (glyph) return glyphSvg(glyph)
  return iconSvg(button.icon)
}

/* -------------------------------------------------------------- the model */

var idCounter = 0
function nextId(prefix) {
  idCounter += 1
  return prefix + "_" + Date.now().toString(36) + "_" + idCounter
}

function createStep(type) {
  return { id: nextId("step"), type: type || "none", delayMs: 0 }
}

function createEmptyButton(slot) {
  return {
    id: nextId("btn"),
    slot: slot,
    label: "",
    icon: DEFAULT_ICON,
    color: "accent",
    steps: [createStep("none")]
  }
}

function createEmptyProfile(name) {
  return {
    id: nextId("profile"),
    name: name,
    columns: 4,
    rows: 3,
    buttons: [],
    updatedAt: new Date().toISOString()
  }
}

/* Older decks stored a single `action` object per button. Macro chaining needs
   a list, so every read normalises to `steps` and the legacy field is dropped
   once it has been folded in. */
function normalizeButton(button) {
  var next = Object.assign({}, button)
  if (!Array.isArray(next.steps) || !next.steps.length) {
    var legacy = next.action || { type: "none" }
    next.steps = [Object.assign({ id: nextId("step") }, legacy)]
  }
  next.steps = next.steps.map(function (step) {
    var copy = Object.assign({ id: nextId("step"), type: "none", delayMs: 0 }, step)
    copy.type = ACTION_META[copy.type] ? copy.type : "none"
    copy.delayMs = Math.max(0, Math.min(60000, Number(copy.delayMs) || 0))
    return copy
  })
  delete next.action
  if (next.control === "fader") {
    var fader = next.fader || {}
    next.fader = {
      target: FADER_TARGETS[fader.target] ? fader.target : "sounds",
      inputName: typeof fader.inputName === "string" ? fader.inputName : ""
    }
  } else {
    next.control = "press"
    delete next.fader
  }
  if (typeof next.label !== "string") next.label = ""
  if (!next.icon) next.icon = DEFAULT_ICON
  if (next.glyph) next.glyph = safeGlyph(next.glyph)
  if (!next.glyph) delete next.glyph
  if (!next.color) next.color = "accent"
  return next
}

function normalizeLibrary(library) {
  var next = Object.assign({ version: 1 }, library)
  next.profiles = (Array.isArray(next.profiles) ? next.profiles : []).map(function (profile) {
    var copy = Object.assign({}, profile)
    copy.columns = Math.max(2, Math.min(8, Number(copy.columns) || 4))
    copy.rows = Math.max(1, Math.min(6, Number(copy.rows) || 3))
    copy.buttons = (Array.isArray(copy.buttons) ? copy.buttons : []).map(normalizeButton)
    return copy
  })
  if (!next.profiles.length) next.profiles = [createEmptyProfile("My deck")]
  var known = next.profiles.some(function (p) { return p.id === next.activeProfileId })
  if (!known) next.activeProfileId = next.profiles[0].id
  return next
}

/* A button is "parked" when its slot sits outside the current grid. The old
   build hid these silently; both surfaces now report them instead. */
function parkedButtons(profile) {
  var capacity = profile.rows * profile.columns
  return profile.buttons.filter(function (button) { return button.slot >= capacity })
}

function isConfigured(button) {
  if (button.control === "fader") return button.fader.target !== "obs_input" || Boolean(button.fader.inputName)
  return button.steps.some(function (step) { return step.type !== "none" })
}

/* The sound slot a single-step "Play a sound" button toggles, or 0. Those
   buttons light up while their sound plays. */
function soundSlotOf(button) {
  if (button.control === "fader" || button.steps.length !== 1 || button.steps[0].type !== "play_sound") return 0
  return Math.max(1, Math.min(8, Number(button.steps[0].soundId) || 1))
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizeLibrary: normalizeLibrary, normalizeButton: normalizeButton, ACTION_META: ACTION_META, STATEFUL_ACTIONS: STATEFUL_ACTIONS, FADER_TARGETS: FADER_TARGETS, faderLevelKey: faderLevelKey, safeGlyph: safeGlyph, THEMES: THEMES, DEFAULT_THEME: DEFAULT_THEME }
}
