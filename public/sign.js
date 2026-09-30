/* Request signing for paired decks.

   Each paired deck holds a secret it received once, at pairing. It never
   sends that secret again: every request carries an HMAC-SHA256 signature
   over the method, the path, a timestamp, a one-off nonce and a hash of the
   body. The companion checks the signature, rejects anything outside a
   two-minute window, and remembers nonces so a captured request cannot be
   replayed.

   Written by hand in ES5 because crypto.subtle only exists on HTTPS pages,
   and a deck is served over plain HTTP on the local network. The server
   computes the same canonical string in lib/auth.js. */

var PunchboardSign = (function () {
  "use strict"

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]

  /* UTF-8, with a lone surrogate encoded as U+FFFD exactly as Node's Buffer
     does, so both sides always hash the same bytes. */
  function utf8Bytes(text) {
    var input = String(text)
    var bytes = []
    for (var i = 0; i < input.length; i += 1) {
      var code = input.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        var next = input.charCodeAt(i + 1)
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

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)) }

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    var length = bytes.length
    var data = bytes.slice()
    data.push(0x80)
    while (data.length % 64 !== 56) data.push(0)
    var high = Math.floor(length / 0x20000000)
    var low = (length * 8) >>> 0
    data.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255)
    data.push((low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255)

    var W = new Array(64)
    for (var block = 0; block < data.length; block += 64) {
      for (var t = 0; t < 16; t += 1) {
        var j = block + t * 4
        W[t] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]
      }
      for (t = 16; t < 64; t += 1) {
        var s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3)
        var s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10)
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
      for (t = 0; t < 64; t += 1) {
        var t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0
        var t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
        h = g; g = f; f = e; e = (d + t1) | 0
        d = c; c = b; b = a; a = (t1 + t2) | 0
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0
    }

    var out = []
    for (var k = 0; k < 8; k += 1) out.push((H[k] >>> 24) & 255, (H[k] >>> 16) & 255, (H[k] >>> 8) & 255, H[k] & 255)
    return out
  }

  function hmac(keyBytes, messageBytes) {
    var key = keyBytes.length > 64 ? sha256(keyBytes) : keyBytes.slice()
    while (key.length < 64) key.push(0)
    var inner = new Array(64)
    var outer = new Array(64)
    for (var i = 0; i < 64; i += 1) {
      inner[i] = key[i] ^ 0x36
      outer[i] = key[i] ^ 0x5c
    }
    return sha256(outer.concat(sha256(inner.concat(messageBytes))))
  }

  function hex(bytes) {
    var out = ""
    for (var i = 0; i < bytes.length; i += 1) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16)
    return out
  }

  function sha256Hex(text) { return hex(sha256(utf8Bytes(text))) }

  function hmacHex(secret, text) { return hex(hmac(utf8Bytes(secret), utf8Bytes(text))) }

  function nonce() {
    var bytes = []
    var cryptoObject = typeof window !== "undefined" && (window.crypto || window.msCrypto)
    if (cryptoObject && cryptoObject.getRandomValues) {
      var buffer = new Uint8Array(16)
      cryptoObject.getRandomValues(buffer)
      for (var i = 0; i < 16; i += 1) bytes.push(buffer[i])
    } else {
      for (var j = 0; j < 16; j += 1) bytes.push(Math.floor(Math.random() * 256))
    }
    return hex(bytes)
  }

  /* The exact string both sides sign. Keep in step with lib/auth.js. */
  function canonical(method, path, time, once, body) {
    return String(method).toUpperCase() + "\n" + path + "\n" + time + "\n" + once + "\n" + sha256Hex(body || "")
  }

  /* Signature fields for one request. `time` is the server's clock, as the
     caller has estimated it. */
  function sign(device, method, path, body, time) {
    var once = nonce()
    return {
      device: device.id,
      time: String(time),
      nonce: once,
      signature: hmacHex(device.secret, canonical(method, path, time, once, body))
    }
  }

  return { sha256Hex: sha256Hex, hmacHex: hmacHex, canonical: canonical, sign: sign }
})()

if (typeof module !== "undefined" && module.exports) module.exports = PunchboardSign
