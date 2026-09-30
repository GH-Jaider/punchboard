// Paired devices and request signatures.
//
// A deck pairs once with a short-lived code (shown as a QR on this computer)
// and receives its own secret. After that the secret never crosses the
// network: each request is signed with HMAC-SHA256 over the method, path,
// time, a one-off nonce and the body hash (see src/shared/sign.ts). Stale
// times and reused nonces are refused, so a request captured on the wifi
// cannot be replayed. Removing a device revokes it at once.
import crypto from "node:crypto"
import type { DeviceInfo, SignedFields } from "../shared/api.ts"
import { canonical } from "../shared/sign.ts"
import { isObject, readJsonSafe, writeJsonAtomic } from "./store.ts"

const CODE_TTL_MS = 10 * 60 * 1000
const CLOCK_WINDOW_MS = 2 * 60 * 1000
const MAX_FAILED_CLAIMS = 8
const CLAIM_LOCK_MS = 60 * 1000

export type AuthErrorCode = "unpaired" | "clock" | "replay" | "bad_signature" | "bad_code" | "locked"

export class AuthError extends Error {
  readonly code: AuthErrorCode
  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export interface Device extends DeviceInfo {
  secret: string
}

export interface PairingCode {
  code: string
  expiresAt: number
}

interface DevicesFile {
  version: 1
  devices: Device[]
}

const isDevice = (value: unknown): value is Device =>
  isObject(value) && typeof value.id === "string" && typeof value.secret === "string" && typeof value.name === "string" &&
  typeof value.createdAt === "string" && typeof value.lastSeen === "string"

const isDevicesFile = (value: unknown): value is DevicesFile => isObject(value) && Array.isArray(value.devices)

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export type Auth = ReturnType<typeof createAuth>

export function createAuth({ file, log }: { file: string; log: (message: string) => void }) {
  const loaded = readJsonSafe(file, isDevicesFile)
  if (loaded.source === "backup") log(`devices file was damaged; restored the backup (damaged copy kept as ${loaded.aside}).`)
  const devices = new Map<string, Device>((loaded.data?.devices ?? []).filter(isDevice).map((device) => [device.id, device]))

  let pairing: PairingCode | null = null
  let failedClaims = 0
  let claimsLockedUntil = 0
  const nonces = new Map<string, number>()
  let saveTimer: NodeJS.Timeout | null = null

  function save(): void {
    writeJsonAtomic(file, { version: 1, devices: [...devices.values()] } satisfies DevicesFile)
  }
  // lastSeen changes on every request; the file only needs it now and then.
  function saveSoon(): void {
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; save() }, 30000)
  }

  function newCode(): PairingCode {
    pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, "0"), expiresAt: Date.now() + CODE_TTL_MS }
    failedClaims = 0
    return pairing
  }

  function currentCode(): PairingCode {
    if (!pairing || Date.now() > pairing.expiresAt) return newCode()
    return pairing
  }

  function claim(code: unknown, name: string, ip: string | undefined): Device {
    if (Date.now() < claimsLockedUntil) throw new AuthError("locked", "Too many wrong codes. Wait a minute, then use the new code on the computer.")
    const active = currentCode()
    const given = String(code)
    if (!/^\d{6}$/.test(given) || !sameText(given, active.code)) {
      failedClaims += 1
      if (failedClaims >= MAX_FAILED_CLAIMS) {
        // Guessing gets a fresh code and a pause, so six digits stay out of reach.
        claimsLockedUntil = Date.now() + CLAIM_LOCK_MS
        newCode()
        log("Pairing locked for a minute after repeated wrong codes.")
      }
      throw new AuthError("bad_code", "That code is not right, or it has expired. Check the code on the computer.")
    }
    const now = new Date().toISOString()
    const device: Device = {
      id: `dev_${crypto.randomBytes(6).toString("hex")}`,
      secret: crypto.randomBytes(32).toString("hex"),
      name: name.replace(/[^\w .'()-]/g, "").slice(0, 40) || "Deck",
      createdAt: now,
      lastSeen: now
    }
    if (ip) device.ip = ip
    devices.set(device.id, device)
    save()
    log(`Paired a new device: ${device.name} (${ip ?? "unknown address"}).`)
    return device
  }

  /** Returns the device that signed the request, or throws AuthError. */
  function verify(signed: Partial<SignedFields>, method: string, path: string, body: string, ip: string | undefined): Device {
    const device = devices.get(String(signed.device ?? ""))
    if (!device) throw new AuthError("unpaired", "This deck is not paired with the companion.")
    const time = Number(signed.time)
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > CLOCK_WINDOW_MS) throw new AuthError("clock", "The request is too old. Check the tablet's clock.")
    const nonce = String(signed.nonce ?? "")
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new AuthError("bad_signature", "The request is not signed.")
    const expected = crypto.createHmac("sha256", Buffer.from(device.secret, "utf8"))
      .update(canonical(method, path, time, nonce, body), "utf8")
      .digest("hex")
    if (!sameText(expected, String(signed.signature ?? ""))) throw new AuthError("bad_signature", "The request signature does not match.")
    const key = `${device.id}:${nonce}`
    if (nonces.has(key)) throw new AuthError("replay", "That request was already used.")
    nonces.set(key, time + CLOCK_WINDOW_MS * 2)
    if (nonces.size > 5000) for (const [entry, expiry] of nonces) if (expiry < Date.now()) nonces.delete(entry)
    device.lastSeen = new Date().toISOString()
    if (ip) device.ip = ip
    saveSoon()
    return device
  }

  function list(): DeviceInfo[] {
    return [...devices.values()].map(({ id, name, createdAt, lastSeen, ip }) => (ip ? { id, name, createdAt, lastSeen, ip } : { id, name, createdAt, lastSeen }))
  }

  function remove(id: string): boolean {
    const existed = devices.delete(id)
    if (existed) save()
    return existed
  }

  function flush(): void {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      save()
    }
  }

  return { currentCode, newCode, claim, verify, list, remove, flush }
}
