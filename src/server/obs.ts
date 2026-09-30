// The link to OBS Studio: one connection, brought up as soon as OBS is
// configured, re-tried when it drops, and carrying live audio meters for the
// inputs that decks are showing.
import OBSWebSocket, { EventSubscription } from "obs-websocket-js"
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
  let attempt = 0
  let retryTimer: NodeJS.Timeout | undefined
  let stopped = false
  let announcedOutage = false
  let lastMeterAt = 0
  let pendingLevels: Record<string, number> = {}
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

  function onMeterEvent(event: { inputs: unknown }): void {
    const wanted = options.wantedInputs()
    if (!wanted.size) return
    Object.assign(pendingLevels, readMeters(event.inputs, wanted))
    const now = Date.now()
    if (now - lastMeterAt < METER_INTERVAL_MS) return
    lastMeterAt = now
    const levels = pendingLevels
    pendingLevels = {}
    if (Object.keys(levels).length) options.onMeters(levels)
  }

  /** The connected client, connecting first if needed. Throws a message meant for the deck. */
  function connect(): Promise<OBSWebSocket> {
    if (client) return Promise.resolve(client)
    if (connecting) return connecting
    const address = options.config.obs.address
    if (!address) return Promise.reject(new Error("Add the OBS WebSocket address in the Control Center first."))
    const socket = new OBSWebSocket()
    connecting = socket
      .connect(address, options.config.obs.password || undefined, { eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters })
      .then(() => {
        client = socket
        connecting = null
        attempt = 0
        announcedOutage = false
        issue = null
        socket.on("InputVolumeMeters", onMeterEvent)
        socket.once("ConnectionClosed", () => {
          if (client !== socket) return
          client = null
          options.log("OBS closed the connection; will reconnect when it is back.")
          options.onStatus()
          scheduleRetry()
        })
        options.log(`Connected to OBS at ${address}.`)
        options.onConnected(socket)
        options.onStatus()
        return socket
      })
      .catch((error: unknown) => {
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
    const old = client
    client = null
    connecting = null
    if (old) old.disconnect().catch(() => { /* already gone */ })
    options.onStatus()
    start()
  }

  function stop(): void {
    stopped = true
    clearTimeout(retryTimer)
    if (client) client.disconnect().catch(() => { /* closing anyway */ })
    client = null
  }

  return { connect, status, issue: (): ObsIssue => (client ? null : issue), start, reset, stop }
}
