// Writes the live files of tests/fixtures/auth: sign-hash.json and
// sign-request.json, what the code shared with the browser answers for
// hashes and signatures (src/shared/sign.ts). The Rust companion's copy
// (server/src/sign.rs) reads them in its tests and must give the same
// answers. The folder's other files are frozen records of the Node companion
// (tests/fixtures/README.md) and are left as they are.
//   node tests/fixtures/make-auth.ts        (npm run fixtures runs them all)
//
// Each file is a list of { input, output } cases. "Random" numbers follow a
// formula, so running this twice writes the same files.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { canonical, hmacHex, sha256Hex, signRequest } from "../../src/shared/sign.ts"

interface Case { input: unknown; output: unknown }

const ROOT = path.resolve(import.meta.dirname, "../..")
const OUT = path.join(ROOT, "tests/fixtures/auth")

/** The moment the requests are signed at. */
const NOW = 1750000000000

const written: Array<[string, number]> = []

function write(name: string, cases: Case[]): void {
  const text = `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`
  // A character JavaScript cut in half cannot be read by Rust at all.
  if (/\\ud[89a-f][0-9a-f]{2}/i.test(text.replace(/\\\\/g, ""))) throw new Error(`${name} holds half a character`)
  fs.writeFileSync(path.join(OUT, name), text)
  written.push([name, cases.length])
}

/** Numbers that repeat on every run, where "any number" is wanted. */
function sequence(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}


// ------------------------------------------------------------------ signing

const TEXTS: string[] = [
  "", "a", "abc", "{}", '{"profileId":"profile_default","buttonId":"btn_1"}',
  "x".repeat(55), "x".repeat(56), "x".repeat(57), "x".repeat(63), "x".repeat(64), "x".repeat(65), "x".repeat(119), "x".repeat(120),
  "x".repeat(128), "y".repeat(1000), "z".repeat(5000),
  "é", "ñandú", "日本語のボタン", "emoji 😀 here", "😀".repeat(16), "\u0000", "line\nbreak\r\n\ttab", " leading and trailing ",
  "İstanbul ǅ ſ ß", "   ﻿", '{"label":"Teléfono Android","note":"çа va"}', "߿ࠀ￿\u{10000}\u{10ffff}"
]

const SECRETS: string[] = [
  "", "k", "secret", "0".repeat(64), "a1b2c3d4".repeat(8), "f".repeat(63), "f".repeat(65), "s".repeat(128), "clé secrète 🔑", "\u0000"
]

function hashes(): void {
  const cases: Case[] = []
  for (const text of TEXTS) {
    for (const secret of SECRETS.slice(0, text.length % 3 === 0 ? SECRETS.length : 4)) {
      cases.push({ input: { secret, text }, output: { sha256: sha256Hex(text), hmac: hmacHex(secret, text) } })
    }
  }
  // Against Node's own, so a mistake in the hand-written SHA-256 would show here.
  for (const entry of cases) {
    const { secret, text } = entry.input as { secret: string; text: string }
    const { sha256, hmac } = entry.output as { sha256: string; hmac: string }
    if (sha256 !== crypto.createHash("sha256").update(text, "utf8").digest("hex")) throw new Error("sha256Hex disagrees with node:crypto")
    if (hmac !== crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update(text, "utf8").digest("hex")) throw new Error("hmacHex disagrees with node:crypto")
  }
  write("sign-hash.json", cases)
}

const METHODS = ["GET", "POST", "PUT", "DELETE", "get", "post", "Patch", "options", "straße"]
const PATHS = [
  "/api/library", "/api/press", "/api/status", "/api/events", "/api/pointer", "/api/devices/dev_0a1b2c3d4e5f", "/", "",
  "/api/sounds/café.mp3", "/api/sounds/%E2%9C%93", "/デッキ/1", "/api/library?rev=12", "/a b/c", "/emoji/😀"
]
const TIMES = [
  NOW, NOW + 1, NOW - 119999, 0, 1, 1e12, 1750000000000.5, 1e21, 1.5e21, 123456789012345680000, -1, -1750000000000, 0.1, 5e-7, 4102444800000
]

function requests(): void {
  const cases: Case[] = []
  const random = sequence(20260101)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
  const nonce = (): string => {
    const length = 16 + Math.floor(random() * 49)
    let text = ""
    for (let at = 0; at < length; at += 1) text += Math.floor(random() * 16).toString(16)
    return text
  }
  const add = (id: string, secret: string, method: string, pathname: string, body: string, time: number, n: string): void => {
    cases.push({
      input: { id, secret, method, path: pathname, body, time, nonce: n },
      output: { canonical: canonical(method, pathname, time, n, body), signed: signRequest({ id, secret }, method, pathname, body, time, n) }
    })
  }
  // Each value on its own, then mixed.
  for (const method of METHODS) add("dev_0a1b2c3d4e5f", SECRETS[3]!, method, "/api/press", "{}", NOW, "00112233445566778899aabbccddeeff")
  for (const pathname of PATHS) add("dev_0a1b2c3d4e5f", SECRETS[3]!, "GET", pathname, "", NOW, "00112233445566778899aabbccddeeff")
  for (const body of TEXTS) add("dev_0a1b2c3d4e5f", SECRETS[3]!, "POST", "/api/press", body, NOW, "00112233445566778899aabbccddeeff")
  for (const time of TIMES) add("dev_0a1b2c3d4e5f", SECRETS[3]!, "GET", "/api/status", "", time, "00112233445566778899aabbccddeeff")
  for (const secret of SECRETS) add("dev_0a1b2c3d4e5f", secret, "GET", "/api/status", "", NOW, "00112233445566778899aabbccddeeff")
  for (const n of ["", "0", "not hex", "ABCDEF0123456789", "f".repeat(64), "ñ"]) add("dev_0a1b2c3d4e5f", SECRETS[3]!, "GET", "/api/status", "", NOW, n)
  for (let at = 0; at < 180; at += 1) {
    add(pick(["dev_0a1b2c3d4e5f", "dev_ffffffffffff", "", "tablet de José"]), pick(SECRETS), pick(METHODS), pick(PATHS), pick(TEXTS), pick(TIMES), nonce())
  }
  write("sign-request.json", cases)
}

// ---------------------------------------------------------------------- run

fs.mkdirSync(OUT, { recursive: true })
hashes()
requests()

for (const [name, count] of written) console.log(`${String(count).padStart(6)}  ${name}`)
console.log(`${written.reduce((sum, entry) => sum + entry[1], 0)} cases in ${written.length} files`)
