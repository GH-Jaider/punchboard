// The link to OBS Studio: one connection, brought up as soon as OBS is
// configured, re-tried when it drops, and carrying live audio meters for the
// inputs that decks are showing.
import OBSWebSocket, { EventSubscription } from "obs-websocket-js"
import type { OBSRequestTypes, OBSResponseTypes } from "obs-websocket-js"
import type { ObsIssue, ObsLink as LinkStatus } from "../shared/api.ts"
import type { Config } from "./config.ts"
import { errorText } from "./http.ts"

export interface ObsLinkOptions {
  config: Config
  log: (message: string) => void
  /** Called whenever the link comes up or goes down. */
  onStatus: () => void
  /** Called with meter positions (0..1) keyed "obs:<input>", at most ~15 Hz. */
  onMeters: (levels: Record<string, number>) => void
  /** Input names whose meters anyone is looking at right now. */
  wantedInputs: () => Set<string>
  /** Each fresh connection, for following OBS's events. */
  onConnected: (socket: OBSWebSocket) => void
}

export type ObsLink = ReturnType<typeof createObsLink>

// Retries stay quick (OBS is usually on this computer, and trying is cheap),
// so the link comes up a few seconds after OBS or its server does.
const RETRY_MS = [2000, 3000, 5000]
const METER_INTERVAL_MS = 66
// Every press, fader and picker waits on the link, so nothing may wait on it
// for long: a host that accepts the connection but never speaks (or a remote
// OBS asleep) fails the attempt, and a request OBS never answers is a link
// that is no longer worth trusting. OBS answers in milliseconds when well.
export const CONNECT_TIMEOUT_MS = 6000
export const REQUEST_TIMEOUT_MS = 5000

/** Each live socket's way back to its link, for a request that timed out. */
const onStuck = new WeakMap<OBSWebSocket, (requestType: string) => void>()

/** Closes a socket without waiting for the peer: `ws` gives a silent peer 30 s
    to answer a close, and a socket that is being dropped has nothing to say. */
function hardClose(socket: OBSWebSocket): void {
  socket.disconnect().catch(() => { /* already gone */ })
  // The underlying `ws` socket is not part of obs-websocket-js's public API.
  const raw = (socket as unknown as { socket?: { terminate?: () => void } }).socket
  try { raw?.terminate?.() } catch { /* already closed */ }
}

/** Every OBS request goes through here, so none can hang a press, a fader or
    a macro: past REQUEST_TIMEOUT_MS the link is dropped and re-tried. */
export function obsCall<Type extends keyof OBSRequestTypes>(
  obs: OBSWebSocket,
  requestType: Type,
  requestData?: OBSRequestTypes[Type]
): Promise<OBSResponseTypes[Type]> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // The link forgets the socket first, so the close is not reported as OBS's.
      onStuck.get(obs)?.(requestType)
      hardClose(obs)
      reject(new Error(`OBS did not answer (${requestType}) within ${REQUEST_TIMEOUT_MS / 1000} seconds, so Punchboard is reconnecting to it. If OBS is frozen, restart it.`))
    }, REQUEST_TIMEOUT_MS)
  })
  return Promise.race([obs.call(requestType, requestData), timeout]).finally(() => clearTimeout(timer))
}

/** OBS's mixer runs -60 dB at the bottom to 0 dB at the top. */
export function meterPosition(mul: number): number {
  if (!(mul > 0)) return 0
  const db = 20 * Math.log10(mul)
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

interface MeterInput { inputName?: unknown; inputLevelsMul?: unknown }

/** Reads one meter event into positions, keeping only the inputs wanted. */
export function readMeters(inputs: unknown, wanted: Set<string>): Record<string, number> {
  const levels: Record<string, number> = {}
  if (!Array.isArray(inputs)) return levels
  for (const raw of inputs as MeterInput[]) {
    const name = typeof raw.inputName === "string" ? raw.inputName : null
    if (!name || !wanted.has(name)) continue
    // Per channel: [magnitude, peak, input peak]; the loudest channel's peak is what a meter shows.
    let peak = 0
    if (Array.isArray(raw.inputLevelsMul)) {
      for (const channel of raw.inputLevelsMul as unknown[]) {
        const value = Array.isArray(channel) ? Number(channel[1]) : 0
        if (value > peak) peak = value
      }
    }
    levels[`obs:${name}`] = meterPosition(peak)
  }
  return levels
}

export function createObsLink(options: ObsLinkOptions) {
  let client: OBSWebSocket | null = null
  let connecting: Promise<OBSWebSocket> | null = null
  /** The socket of the attempt in flight, so a reset can abandon it. */
  let pending: OBSWebSocket | null = null
  /** Bumped by every attempt, reset and stop: an attempt that finds it moved
      on is stale (other settings, or Punchboard closing) and must not touch
      the link when it settles. */
  let generation = 0
  let attempt = 0
  let retryTimer: NodeJS.Timeout | undefined
  let stopped = false
  let announcedOutage = false
  let lastMeterAt = 0
  let pendingLevels: Record<string, number> = {}
  let meterTimer: NodeJS.Timeout | undefined
  let issue: ObsIssue = null

  const configured = (): boolean => Boolean(options.config.obs.address)

  function status(): LinkStatus {
    if (client) return "connected"
    return configured() ? "disconnected" : "unset"
  }

  function scheduleRetry(): void {
    if (stopped || !configured()) return
    clearTimeout(retryTimer)
    const delay = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 30000
    attempt += 1
    retryTimer = setTimeout(() => { connect().catch(() => { /* logged once per outage */ }) }, delay)
  }

  function flushMeters(): void {
    clearTimeout(meterTimer)
    meterTimer = undefined
    lastMeterAt = Date.now()
    const levels = pendingLevels
    pendingLevels = {}
    if (Object.keys(levels).length) options.onMeters(levels)
  }

  function onMeterEvent(event: { inputs: unknown }): void {
    const wanted = options.wantedInputs()
    if (!wanted.size) return
    Object.assign(pendingLevels, readMeters(event.inputs, wanted))
    const since = Date.now() - lastMeterAt
    if (since >= METER_INTERVAL_MS) return flushMeters()
    // Inside the window: send what is pending when it ends, so the last
    // values of a burst (a voice stopping) still reach the decks.
    meterTimer ??= setTimeout(flushMeters, METER_INTERVAL_MS - since)
  }

  /** The live link stopped answering or closed: forget it and try again. */
  function drop(socket: OBSWebSocket, message: string): void {
    if (client !== socket) return
    client = null
    clearTimeout(meterTimer)
    meterTimer = undefined
    pendingLevels = {}
    options.log(message)
    options.onStatus()
    scheduleRetry()
  }

  /** The connected client, connecting first if needed. Throws a message meant for the deck. */
  function connect(): Promise<OBSWebSocket> {
    if (client) return Promise.resolve(client)
    if (connecting) return connecting
    if (stopped) return Promise.reject(new Error("Punchboard is closing."))
    const address = options.config.obs.address
    if (!address) return Promise.reject(new Error("Add the OBS WebSocket address in the Control Center first."))
    const socket = new OBSWebSocket()
    const mine = ++generation
    const current = (): boolean => generation === mine
    pending = socket
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`OBS did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds`), { code: "timeout" })), CONNECT_TIMEOUT_MS)
    })
    const handshake = socket.connect(address, options.config.obs.password || undefined, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters })
    connecting = Promise.race([handshake, timedOut])
      .finally(() => clearTimeout(timer))
      .then(() => {
        // Settings changed (or Punchboard is closing) while this attempt was
        // out: it connected to the old OBS, so it closes, and whoever was
        // waiting on it gets the current attempt instead.
        if (!current()) {
          hardClose(socket)
          return connect()
        }
        pending = null
        client = socket
        connecting = null
        attempt = 0
        announcedOutage = false
        issue = null
        onStuck.set(socket, (requestType) => drop(socket, `OBS did not answer ${requestType} in time; reconnecting.`))
        socket.on("InputVolumeMeters", onMeterEvent)
        socket.once("ConnectionClosed", () => drop(socket, "OBS closed the connection; will reconnect when it is back."))
        options.log(`Connected to OBS at ${address}.`)
        options.onConnected(socket)
        options.onStatus()
        return socket
      }, (error: unknown) => {
        // A timed-out handshake may still be going; it must not finish later.
        hardClose(socket)
        if (!current()) return connect()
        pending = null
        connecting = null
        // 4009 is OBS refusing the password; anything else means nothing answered.
        const next: ObsIssue = (error as { code?: unknown }).code === 4009 ? "wrong-password" : "unreachable"
        if (next !== issue) {
          issue = next
          options.onStatus()
        }
        if (!announcedOutage) {
          announcedOutage = true
          options.log(`OBS is not reachable at ${address}; will keep trying quietly.`)
        }
        scheduleRetry()
        throw new Error(issue === "wrong-password"
          ? "OBS refused the password. Open OBS Studio in Punchboard and find OBS again, or paste the new password."
          : `Could not reach OBS at ${address}. Start OBS and switch on its WebSocket server (Tools › WebSocket Server Settings). (${errorText(error)})`)
      })
    return connecting
  }

  /** Abandons the attempt in flight, if any: its socket closes and, being
      stale, it leaves the link alone when it settles. */
  function abandonAttempt(): void {
    generation += 1
    connecting = null
    if (pending) hardClose(pending)
    pending = null
  }

  /** Connects if OBS is configured; failures retry in the background. */
  function start(): void {
    stopped = false
    if (configured()) connect().catch(() => { /* retrying */ })
  }

  /** After the address or password changes: drop the old link, start a new one. */
  function reset(): void {
    clearTimeout(retryTimer)
    attempt = 0
    announcedOutage = false
    issue = null
    abandonAttempt()
    const old = client
    client = null
    clearTimeout(meterTimer)
    meterTimer = undefined
    pendingLevels = {}
    if (old) hardClose(old)
    options.onStatus()
    start()
  }

  function stop(): void {
    stopped = true
    clearTimeout(retryTimer)
    clearTimeout(meterTimer)
    abandonAttempt()
    if (client) client.disconnect().catch(() => { /* closing anyway */ })
    client = null
  }

  return { connect, status, issue: (): ObsIssue => (client ? null : issue), start, reset, stop }
}
