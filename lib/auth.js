// Paired devices and request signatures.
//
// A deck pairs once with a short-lived code (shown as a QR on this computer)
// and receives its own secret. After that the secret never crosses the
// network: each request is signed with HMAC-SHA256 over the method, path,
// time, a one-off nonce and the body hash (see public/sign.js). Stale times
// and reused nonces are refused, so a request captured on the wifi cannot be
// replayed. Removing a device revokes it at once.
const crypto = require("crypto")
const { writeJsonAtomic, readJsonSafe } = require("./store")
const { canonical } = require("../public/sign.js")

const CODE_TTL_MS = 10 * 60 * 1000
const CLOCK_WINDOW_MS = 2 * 60 * 1000
const MAX_FAILED_CLAIMS = 8
const CLAIM_LOCK_MS = 60 * 1000

class AuthError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const sha256Hex = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex")

function sameHex(a, b) {
  const left = Buffer.from(String(a), "utf8")
  const right = Buffer.from(String(b), "utf8")
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function createAuth({ file, log }) {
  const loaded = readJsonSafe(file, (data) => data && Array.isArray(data.devices))
  if (loaded.source === "backup") log(`devices file was damaged; restored the backup (damaged copy kept as ${loaded.aside}).`)
  const devices = new Map(((loaded.data && loaded.data.devices) || []).map((device) => [device.id, device]))

  let pairing = null
  let failedClaims = 0
  let claimsLockedUntil = 0
  const nonces = new Map()
  let saveTimer = null

  function save() {
    writeJsonAtomic(file, { version: 1, devices: [...devices.values()] })
  }
  // lastSeen changes on every request; the file only needs it now and then.
  function saveSoon() {
    if (saveTimer) return
    saveTimer = setTimeout(() => { saveTimer = null; save() }, 30000)
  }

  function newCode() {
    pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, "0"), expiresAt: Date.now() + CODE_TTL_MS }
    failedClaims = 0
    return pairing
  }

  function currentCode() {
    if (!pairing || Date.now() > pairing.expiresAt) newCode()
    return pairing
  }

  function claim(code, name, ip) {
    if (Date.now() < claimsLockedUntil) throw new AuthError("locked", "Too many wrong codes. Wait a minute, then use the new code on the computer.")
    const active = currentCode()
    if (!/^\d{6}$/.test(String(code)) || !sameHex(code, active.code)) {
      failedClaims += 1
      if (failedClaims >= MAX_FAILED_CLAIMS) {
        // Guessing gets a fresh code and a pause, so six digits stay out of reach.
        claimsLockedUntil = Date.now() + CLAIM_LOCK_MS
        newCode()
        log("Pairing locked for a minute after repeated wrong codes.")
      }
      throw new AuthError("bad_code", "That code is not right, or it has expired. Check the code on the computer.")
    }
    const device = {
      id: `dev_${crypto.randomBytes(6).toString("hex")}`,
      secret: crypto.randomBytes(32).toString("hex"),
      name: String(name || "Deck").replace(/[^\w .'()-]/g, "").slice(0, 40) || "Deck",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      ip
    }
    devices.set(device.id, device)
    save()
    log(`Paired a new device: ${device.name} (${ip}).`)
    return device
  }

  // `signed` = { device, time, nonce, signature }. Returns the device or throws.
  function verify(signed, method, path, body, ip) {
    const device = devices.get(String(signed.device || ""))
    if (!device) throw new AuthError("unpaired", "This deck is not paired with the companion.")
    const time = Number(signed.time)
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > CLOCK_WINDOW_MS) throw new AuthError("clock", "The request is too old. Check the tablet's clock.")
    const nonce = String(signed.nonce || "")
    if (!/^[0-9a-f]{16,64}$/.test(nonce)) throw new AuthError("bad_signature", "The request is not signed.")
    const expected = crypto.createHmac("sha256", Buffer.from(device.secret, "utf8"))
      .update(canonical(method, path, time, nonce, body), "utf8")
      .digest("hex")
    if (!sameHex(expected, signed.signature || "")) throw new AuthError("bad_signature", "The request signature does not match.")
    const key = `${device.id}:${nonce}`
    if (nonces.has(key)) throw new AuthError("replay", "That request was already used.")
    nonces.set(key, time + CLOCK_WINDOW_MS * 2)
    if (nonces.size > 5000) for (const [entry, expiry] of nonces) if (expiry < Date.now()) nonces.delete(entry)
    device.lastSeen = new Date().toISOString()
    device.ip = ip
    saveSoon()
    return device
  }

  function list() {
    return [...devices.values()].map(({ id, name, createdAt, lastSeen, ip }) => ({ id, name, createdAt, lastSeen, ip }))
  }

  function remove(id) {
    const existed = devices.delete(id)
    if (existed) save()
    return existed
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; save() }
  }

  return { currentCode, newCode, claim, verify, list, remove, flush, sha256Hex }
}

module.exports = { createAuth, AuthError, sha256Hex }
