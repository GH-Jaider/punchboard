// The 48 built-in icons: stroke paths on a 24x24 grid, drawn in the text colour.

export const DEFAULT_ICON = "radio"

/** Grouped so the picker can offer categories instead of one flat scroll. */
export const ICON_GROUPS: ReadonlyArray<{ name: string; ids: readonly string[] }> = [
  { name: "Streaming", ids: ["radio", "video", "camera", "clapperboard", "monitor", "cast", "record", "stop", "play", "pause", "scissors", "layers"] },
  { name: "Audio", ids: ["mic", "mic-off", "volume", "volume-off", "music", "headphones", "sliders"] },
  { name: "Alerts", ids: ["bell", "zap", "star", "heart", "flame", "sparkle", "flag", "gift"] },
  { name: "Chat", ids: ["message", "users", "hash", "thumbs-up", "smile"] },
  { name: "System", ids: ["globe", "link", "folder", "save", "terminal", "command", "keyboard", "power", "settings", "refresh", "timer", "lock", "eye", "eye-off", "plus", "grid"] }
]

export const ICONS: Readonly<Record<string, string>> = {
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
