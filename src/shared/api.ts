// Every request and response body the companion speaks. The server and the
// clients both type against these, so a changed field breaks the build on
// both sides instead of at runtime.
import type { Glyph, Library, ThemeId } from "./types.ts"

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

export interface SoundCommand {
  id: number
  slot: number
  action: "play" | "stop"
}

/** A sound the companion has told its audio output to play. Decks draw the
    progress themselves from these two numbers and their server-clock offset. */
export interface SoundPlayback {
  /** Server time (ms) when playback was ordered. */
  startedAt: number
  /** Null until the sound's length is known (see SoundSlot.durationMs). */
  durationMs: number | null
}

export type ObsLink = "unset" | "disconnected" | "connected"

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
  toggles: Record<string, boolean>
  soundCommands: SoundCommand[]
  playing: number[]
  /** The Control Center tab currently playing sounds, if any. */
  audioOutput: string | null
  levels: Record<string, number>
  /** Sounds playing right now, by slot number. */
  playback: Record<string, SoundPlayback>
  /** Whether the companion is talking to OBS at the moment. */
  obs: ObsLink
  /** Paired devices with a live connection right now. */
  tablets: number
  /** Identifies the page code the companion serves; a deck that loaded an
      older build reloads itself when this changes. */
  build: string
  accent: string
  theme: ThemeId
}

export interface StatusResponse extends Snapshot { ok: true }

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
  /** Length in ms: read from the file for WAV, learned from playback for MP3, null until then. */
  durationMs: number | null
}

/** The Control Center reports an MP3's length once it has played it. */
export interface SoundDurationRequest {
  durationMs: number
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
