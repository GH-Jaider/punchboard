// The deck's signed client. A paired deck keeps its id and secret in local
// storage and signs every request with them (shared/sign.ts). The secret was
// sent once, at pairing, and never again.
import type { DeviceCredentials, HelloResponse } from "../../shared/api.ts"
import { signRequest } from "../../shared/sign.ts"
import type { SignedFields } from "../../shared/api.ts"
import { applyAccent, applyTheme, storage } from "../common/dom.ts"
import { ApiError, readJson } from "../common/http.ts"

const DEVICE_KEY = "punchboard-device"

let device: DeviceCredentials | null = null
/** Server clock minus ours, so signatures are on time. */
let clockOffset = 0
let onUnpaired: () => void = () => {}

/** Thrown when the companion no longer knows this deck; the pairing screen is already up. */
export class UnpairedError extends Error {
  constructor() {
    super("This deck needs to be paired.")
  }
}

export function loadDevice(): DeviceCredentials | null {
  try {
    const stored = JSON.parse(storage.get(DEVICE_KEY) ?? "null") as Partial<DeviceCredentials> | null
    device = stored && stored.id && stored.secret ? { id: stored.id, secret: stored.secret, name: stored.name ?? "" } : null
  } catch {
    device = null
  }
  return device
}

export function saveDevice(next: DeviceCredentials | null): void {
  device = next
  if (next) storage.set(DEVICE_KEY, JSON.stringify(next))
  else storage.remove(DEVICE_KEY)
}

export const hasDevice = (): boolean => device !== null

export function setServerTime(serverTime: number): void {
  clockOffset = serverTime - Date.now()
}

/** Called when a request finds this deck unpaired. */
export function whenUnpaired(handler: () => void): void {
  onUnpaired = handler
}

const serverNow = (): number => Math.round(Date.now() + clockOffset)

function nonce(): string {
  const bytes: number[] = []
  if (window.crypto && typeof window.crypto.getRandomValues === "function") {
    const buffer = new Uint8Array(16)
    window.crypto.getRandomValues(buffer)
    for (let i = 0; i < buffer.length; i += 1) bytes.push(buffer[i] ?? 0)
  } else {
    for (let i = 0; i < 16; i += 1) bytes.push(Math.floor(Math.random() * 256))
  }
  return bytes.map((byte) => (byte < 16 ? "0" : "") + byte.toString(16)).join("")
}

function sign(method: string, path: string, body: string): SignedFields | null {
  return device ? signRequest(device, method, path, body, serverNow(), nonce()) : null
}

/** Syncs the clock and paints the companion's colours, even before pairing. */
export async function syncClock(): Promise<void> {
  const hello = await readJson<HelloResponse>(await fetch("/api/hello"))
  setServerTime(hello.serverTime)
  applyAccent(hello.accent)
  applyTheme(hello.theme)
}

export interface DeckRequest {
  method?: "GET" | "POST"
  json?: unknown
}

/** A signed JSON request. A clock or replay refusal is retried once with a
    fresh signature; "unpaired" means the pairing was removed on the computer. */
export async function api<T>(url: string, options: DeckRequest = {}, retried = false): Promise<T> {
  const method = options.method ?? "GET"
  const body = options.json === undefined ? "" : JSON.stringify(options.json)
  const headers: Record<string, string> = {}
  if (body) headers["Content-Type"] = "application/json"
  const signed = sign(method, url.split("?")[0] ?? url, body)
  if (signed) {
    headers["X-Punchboard-Device"] = signed.device
    headers["X-Punchboard-Time"] = signed.time
    headers["X-Punchboard-Nonce"] = signed.nonce
    headers["X-Punchboard-Signature"] = signed.signature
  }
  const response = await fetch(url, { method, headers, body: body || undefined })
  try {
    return await readJson<T>(response)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) throw error
    const code = error.body.code
    const serverTime = error.body.serverTime
    if (serverTime) setServerTime(serverTime)
    if ((code === "clock" || code === "replay") && !retried) return api<T>(url, options, true)
    if (code === "unpaired" || !device) {
      saveDevice(null)
      onUnpaired()
      throw new UnpairedError()
    }
    throw error
  }
}

/** EventSource cannot send headers, so the stream is signed in its address. */
export function eventsUrl(): string {
  const signed = sign("GET", "/api/events", "")
  if (!signed) return "/api/events"
  return `/api/events?d=${encodeURIComponent(signed.device)}&t=${signed.time}&n=${signed.nonce}&s=${signed.signature}`
}
