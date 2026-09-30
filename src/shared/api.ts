// Every request and response body the companion speaks. The server and the
// clients both type against these, so a changed field breaks the build on
// both sides instead of at runtime.
import type { TouchFrame, TouchpadEvent } from "./touchpad/types.ts"
import type { Glyph, Library, ThemeId, TrackpadSettings } from "./types.ts"

export interface ErrorResponse {
  error: string
  /** Why a signed request was refused: "unpaired", "clock", "replay", "bad_signature", "bad_code", "locked". */
  code?: string
  /** Sent with 401s so a deck can correct its clock. */
  serverTime?: number
  /** Sent with a 409 save conflict. */
  libraryRev?: number
}

export interface Ok { ok: true }

// ---------------------------------------------------------------- pairing

export interface HelloResponse {
  serverTime: number
  accent: string
  theme: ThemeId
}

export interface DeviceCredentials {
  id: string
  secret: string
  name: string
}

export interface ClaimRequest {
  code: string
  name?: string
}

export interface ClaimResponse {
  device: DeviceCredentials
  serverTime: number
}

export interface DeviceInfo {
  id: string
  name: string
  createdAt: string
  lastSeen: string
  ip?: string
}

export interface PairInfo {
  deckUrl: string
  pairUrl: string
  code: string
  expiresAt: number
  devices: DeviceInfo[]
}

export interface NewCodeResponse {
  code: string
  expiresAt: number
  pairUrl: string
}

export interface DevicesResponse extends Ok {
  devices: DeviceInfo[]
}

/** The four signature fields, sent as X-Punchboard-* headers or d/t/n/s query params. */
export interface SignedFields {
  device: string
  time: string
  nonce: string
  signature: string
}

// ------------------------------------------------------------- live state

/** A sound the companion is playing. Decks draw the progress themselves
    from these two numbers and their server-clock offset. */
export interface SoundPlayback {
  /** Server time (ms) when playback was ordered. */
  startedAt: number
  /** Null until the sound's length is known (see SoundSlot.durationMs). */
  durationMs: number | null
}

export type ObsLink = "unset" | "disconnected" | "connected"

/** Why the link is down, when it is: nothing answered, OBS's WebSocket server
    is switched off (read from OBS's settings on this computer), or OBS
    refused the password. */
export type ObsIssue = "unreachable" | "server-off" | "wrong-password" | null

/** What Punchboard found in OBS's own settings on this computer. */
export interface ObsDetected {
  found: boolean
  /** Whether OBS's WebSocket server is switched on. */
  enabled: boolean
  port: number
}

export interface ObsDetectResponse extends ObsDetected {
  /** The settings were taken over and the link restarted. */
  applied: boolean
}

/** Names read from OBS for the Control Center's pickers, in OBS's own order.
    Empty lists and connected: false when OBS is not connected. */
export interface ObsNames {
  connected: boolean
  scenes: string[]
  /** Source names in each scene, by scene name. */
  sceneItems: Record<string, string[]>
  /** Inputs that carry audio: the ones mute and faders can act on. */
  audioInputs: string[]
  /** Filter names by source or scene name; sources without filters are left out. */
  filters: Record<string, string[]>
}

/** Live audio levels, sent as the SSE event "meters" at up to 15 Hz while a
    connected deck shows a fader for that input. Keyed by faderLevelKey
    ("obs:<input name>"); values are meter positions 0..1 on OBS's -60..0 dB
    scale, not raw gain. */
export interface MetersEvent {
  levels: Record<string, number>
}

/** What every connected page receives on /api/events and /api/status. */
export interface Snapshot {
  libraryRev: number
  soundsRev: number
  /** Live on/off states by stateKeyOf() ("mute:Mic", "scene:Intro", "stream"…). */
  toggles: Record<string, boolean>
  /** Slots playing on this computer right now. */
  playing: number[]
  levels: Record<string, number>
  /** Sounds playing right now, by slot number. */
  playback: Record<string, SoundPlayback>
  /** Whether the companion is talking to OBS at the moment. */
  obs: ObsLink
  obsIssue: ObsIssue
  /** Paired devices with a live connection right now. */
  tablets: number
  /** Identifies the page code the companion serves; a deck that loaded an
      older build reloads itself when this changes. */
  build: string
  accent: string
  theme: ThemeId
}

export interface StatusResponse extends Snapshot { ok: true }

// --------------------------------------------------------------- trackpad

/** What a trackpad deck sends over /api/pointer, one JSON array per message:
    ["m", dx, dy] move, ["s", dx, dy] scroll (pixels, positive up and left),
    ["c", "left" | "right"] click, ["d"] / ["u"] left button down / up,
    ["z", ±1] one pinch-zoom step (1 is in), ["g", fingers, gesture] a
    three- or four-finger gesture, which the companion turns into this
    system's own shortcut. */
export type PointerMessage =
  | ["m", number, number]
  | ["s", number, number]
  | ["c", "left" | "right"]
  | ["d"]
  | ["u"]
  | ["z", 1 | -1]
  | ["g", 3 | 4, SwipeGesture]

/** A three- or four-finger gesture, named for what the fingers did. */
export type SwipeGesture = "up" | "down" | "left" | "right" | "tap" | "pinch" | "spread"

/** What the companion may send back on the same socket. */
export interface PointerNotice {
  error: string
}

/** What a trackpad deck in debug mode (#trackpad-debug) sends to keep a
    recording: its last 30 s of fingers and what the engine made of them. The
    companion writes it in the shape tests/touchpad-traces replays. */
export interface TraceUpload {
  settings: TrackpadSettings
  frames: TouchFrame[]
  events: TouchpadEvent[]
  userAgent?: string
}

export interface TraceSaved extends Ok {
  /** The file's name inside the data folder's trackpad-traces. */
  file: string
}

// ---------------------------------------------------------------- library

export type LibraryResponse = Library

export interface SaveLibraryResponse extends Ok {
  libraryRev: number
}

// --------------------------------------------------------------- settings

export interface SettingsResponse {
  accent: string
  theme: ThemeId
  obsAddress: string
  obsConfigured: boolean
  /** "auto": taken from OBS's settings on this computer; "manual": typed in. */
  obsSource: "auto" | "manual"
  platform: string
}

export interface SettingsUpdate {
  accent?: string
  theme?: ThemeId
  obsAddress?: string
  obsPassword?: string
}

export interface SettingsSaved extends Ok {
  accent: string
  theme: ThemeId
}

// ---------------------------------------------------------- press + faders

export interface PressRequest {
  profileId: string
  buttonId: string
}

export interface PressResponse extends Ok {
  active?: boolean
  tabletUrl?: string | null
  /** A "Go to another deck" step: the deck the pressing device should show. */
  deckId?: string | null
  message?: string
}

export interface VolumeRequest extends PressRequest {
  level: number
}

export interface VolumeSyncRequest {
  profileId: string
}

export interface LevelsResponse extends Ok {
  levels: Record<string, number>
}

// ------------------------------------------------------------------ sounds

export interface SoundSlot {
  slot: number
  exists: boolean
  custom: boolean
  name: string
  format: "WAV" | "MP3"
  bytes: number
  updatedAt: string | null
  /** Length in ms: read from the file for WAV, learned from the first full play for MP3, null until then. */
  durationMs: number | null
}

export interface SoundsResponse {
  slots: SoundSlot[]
}

export interface SoundsChanged extends Ok {
  slots: SoundSlot[]
}

export interface SoundEndedRequest {
  slot: number
}

// ------------------------------------------------------------ applications

/** An application the companion can launch, as the picker lists it. */
export interface AppEntry {
  name: string
  path: string
}

export interface AppsResponse {
  apps: AppEntry[]
}

// ------------------------------------------------------------ Google icons

/** A catalog entry, kept short because the catalog has thousands. */
export interface GoogleIconEntry {
  /** name */
  n: string
  /** tags, space separated, lower case */
  t: string
  /** first category */
  c: string
}

export interface GoogleIconsResponse {
  icons: GoogleIconEntry[]
}

export type GlyphResponse = Glyph
