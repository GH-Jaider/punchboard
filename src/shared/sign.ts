// Request signing shared by the deck (which signs) and the server (which
// checks). A deck holds a secret it got once, at pairing, and signs every
// request with HMAC-SHA256 over the method, path, time, a one-off nonce and
// the body's hash. The secret itself never crosses the network again.
//
// SHA-256 and HMAC are written out here because crypto.subtle only exists on
// HTTPS pages, and a deck is served over plain HTTP on the local network.
import type { SignedFields } from "./api.ts"

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const

/** UTF-8, encoding a lone surrogate as U+FFFD exactly as Node's Buffer does. */
function utf8Bytes(input: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i += 1
      } else {
        code = 0xfffd
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd
    }
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return bytes
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

function sha256(bytes: readonly number[]): number[] {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const length = bytes.length
  const data = bytes.slice()
  data.push(0x80)
  while (data.length % 64 !== 56) data.push(0)
  const high = Math.floor(length / 0x20000000)
  const low = (length * 8) >>> 0
  data.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255)
  data.push((low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255)

  const W = new Array<number>(64).fill(0)
  const at = (i: number): number => data[i] ?? 0
  for (let block = 0; block < data.length; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      const j = block + t * 4
      W[t] = (at(j) << 24) | (at(j + 1) << 16) | (at(j + 2) << 8) | at(j + 3)
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = W[t - 15]!
      const w2 = W[t - 2]!
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!
    for (let t = 0; t < 64; t += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t]! + W[t]!) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0
      d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    const add = [a, b, c, d, e, f, g, h]
    for (let k = 0; k < 8; k += 1) H[k] = (H[k]! + add[k]!) | 0
  }
  const out: number[] = []
  for (const word of H) out.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255)
  return out
}

function hmac(keyBytes: readonly number[], messageBytes: readonly number[]): number[] {
  const key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes.slice()
  while (key.length < 64) key.push(0)
  const inner = key.map((byte) => byte ^ 0x36)
  const outer = key.map((byte) => byte ^ 0x5c)
  return sha256(outer.concat(sha256(inner.concat(messageBytes))))
}

const hex = (bytes: readonly number[]): string => bytes.map((byte) => (byte < 16 ? "0" : "") + byte.toString(16)).join("")

export const sha256Hex = (input: string): string => hex(sha256(utf8Bytes(input)))
export const hmacHex = (secret: string, input: string): string => hex(hmac(utf8Bytes(secret), utf8Bytes(input)))

/** The exact string both sides sign. */
export function canonical(method: string, path: string, time: number | string, nonce: string, body: string): string {
  return `${method.toUpperCase()}\n${path}\n${time}\n${nonce}\n${sha256Hex(body || "")}`
}

export interface SigningKey { id: string; secret: string }

/** Signature fields for one request. `time` is the server's clock as the caller estimates it. */
export function signRequest(key: SigningKey, method: string, path: string, body: string, time: number, nonce: string): SignedFields {
  return {
    device: key.id,
    time: String(time),
    nonce,
    signature: hmacHex(key.secret, canonical(method, path, time, nonce, body))
  }
}
