// Writes tests/fixtures/auth/*.json: what the TypeScript companion answers for
// pairing and signatures (src/shared/sign.ts, src/server/auth.ts), the deck
// library store (src/server/library.ts) and Google's icons
// (src/server/google-icons.ts). The Rust companion's copies (server/src/sign.rs,
// auth.rs, library.rs, google_icons.rs) read these files in their tests and
// must give the same answers and write the same bytes.
//   node tests/fixtures/make-auth.ts
//
// Each file is a list of { input, output } cases. The clock is fixed and moved
// by hand, "random" numbers follow a formula Rust repeats, and Google is never
// asked: its answers are written here by hand, in the shapes the code expects.
// Running this twice writes the same files.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mock } from "node:test"
import { AuthError, createAuth } from "../../src/server/auth.ts"
import type { Auth, Device } from "../../src/server/auth.ts"
import { createGoogleIcons } from "../../src/server/google-icons.ts"
import { HttpError } from "../../src/server/http.ts"
import { english, translator, UserError } from "../../src/server/i18n.ts"
import type { Text } from "../../src/server/i18n.ts"
import { createLibraryStore } from "../../src/server/library.ts"
import type { SignedFields } from "../../src/shared/api.ts"
import { setTranslator } from "../../src/shared/i18n.ts"
import { nextId, normalizeLibrary } from "../../src/shared/model.ts"
import { canonical, hmacHex, sha256Hex, signRequest } from "../../src/shared/sign.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { name?: string; input: unknown; output: unknown; [extra: string]: unknown }

const ROOT = path.resolve(import.meta.dirname, "../..")
const OUT = path.join(ROOT, "tests/fixtures/auth")

/** The moment every case starts at. */
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

const tempDirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-fixtures-"))
  tempDirs.push(dir)
  return dir
}

const readOrNull = (file: string): string | null => {
  try { return fs.readFileSync(file, "utf8") } catch { return null }
}

// ------------------------------------------------------------ a fixed world

/** How many random numbers have been asked for since the case began. */
let asked = 0

// The formulas server/src/auth.rs repeats in its test world.
mock.method(crypto, "randomInt", ((_min: number, max: number): number => {
  asked += 1
  return (asked * 2654435761) % max
}) as typeof crypto.randomInt)
mock.method(crypto, "randomBytes", ((size: number): Buffer => {
  asked += 1
  const bytes = Buffer.alloc(size)
  for (let at = 0; at < size; at += 1) bytes[at] = (asked * 131 + at * 29 + 7) & 255
  return bytes
}) as typeof crypto.randomBytes)

/** Starts the clock (and the timers, which only move with it) at a moment. */
function startWorld(now: number): void {
  mock.timers.reset()
  mock.timers.enable({ apis: ["Date", "setTimeout"], now })
  asked = 0
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

// ---------------------------------------------------------- pairing, by steps

type Step = { op: string; [field: string]: Json | undefined }

const refusal = (error: unknown): Json => {
  if (error instanceof AuthError) return { error: error.code, key: error.text.key }
  throw error
}

/** The fields of a device Rust answers with (a file may hold more). */
function deviceJson(device: Device): Json {
  const out: { [key: string]: Json } = { id: device.id, secret: device.secret, name: device.name, createdAt: device.createdAt, lastSeen: device.lastSeen }
  if (device.ip) out.ip = device.ip
  return out
}

/** One companion's pairing, driven step by step; every step and its answer is kept. */
class Session {
  readonly file: string
  readonly steps: Step[] = []
  readonly answers: Json[] = []
  readonly logs: string[] = []
  auth: Auth

  /** Throws when the file there cannot be read, as the companion would at its start. */
  constructor(file: string) {
    this.file = file
    this.auth = this.open()
  }

  open(): Auth {
    return createAuth({ file: this.file, log: (message) => { this.logs.push(message) } })
  }

  private did<T extends Json>(step: Step, answer: T): T {
    this.steps.push(step)
    this.answers.push(answer)
    return answer
  }

  advance(ms: number): void {
    mock.timers.tick(ms)
    this.did({ op: "advance", ms }, null)
  }

  currentCode(): string {
    const { code, expiresAt } = this.auth.currentCode()
    return this.did({ op: "currentCode" }, { code, expiresAt }).code
  }

  newCode(): string {
    const { code, expiresAt } = this.auth.newCode()
    return this.did({ op: "newCode" }, { code, expiresAt }).code
  }

  /** The device, or null when the claim was refused. */
  claim(code: Json, name: string, ip: string | null): Device | null {
    let device: Device | null = null
    let answer: Json
    try {
      device = this.auth.claim(code, name, ip ?? undefined)
      answer = { device: deviceJson(device) }
    } catch (error) {
      answer = refusal(error)
    }
    this.did({ op: "claim", code, name, ip }, answer)
    // A copy: the companion keeps changing its own.
    return device ? { ...device } : null
  }

  verify(signed: Partial<SignedFields>, method: string, pathname: string, body: string, ip: string | null = null): Json {
    let answer: Json
    try {
      answer = { device: deviceJson(this.auth.verify(signed, method, pathname, body, ip ?? undefined)) }
    } catch (error) {
      answer = refusal(error)
    }
    return this.did({ op: "verify", signed: { ...signed }, method, path: pathname, body, ip }, answer)
  }

  has(id: string): void { this.did({ op: "has", id }, this.auth.has(id)) }
  list(): void { this.did({ op: "list" }, this.auth.list().map((device) => ({ ...device }))) }
  remove(id: string): void { this.did({ op: "remove", id }, this.auth.remove(id)) }
  flush(): void { this.auth.flush(); this.did({ op: "flush" }, null) }
  readFile(): void { this.did({ op: "file" }, readOrNull(this.file)) }
  readBak(): void { this.did({ op: "bak" }, readOrNull(`${this.file}.bak`)) }
  readLogs(): void { this.did({ op: "logs" }, this.logs.splice(0)) }
  reopen(): void { this.auth = this.open(); this.did({ op: "reopen" }, null) }
}

interface Start { file?: string; bak?: string; now?: number }

/** A case: a devices.json to start from, and what a session then did. */
function scenario(name: string, start: Start, run: (session: Session) => void): Case {
  const now = start.now ?? NOW
  startWorld(now)
  const input = { file: start.file ?? null, bak: start.bak ?? null, now }
  const file = path.join(tempDir(), "devices.json")
  if (start.file !== undefined) fs.writeFileSync(file, start.file)
  if (start.bak !== undefined) fs.writeFileSync(`${file}.bak`, start.bak)
  let session: Session
  try {
    session = new Session(file)
  } catch {
    return { name, input: { ...input, steps: [] }, output: { opened: false } }
  }
  // The first line names the damaged copy by its whole path and the time.
  const startLog = session.logs.splice(0).map((line) => line.split(" (damaged copy")[0]!)
  run(session)
  // Nothing may be left waiting for a later case's clock.
  session.auth.flush()
  return { name, input: { ...input, steps: session.steps }, output: { opened: true, startLog, steps: session.answers } }
}

const wrong = (code: string): string => String((Number(code) + 1) % 1000000).padStart(6, "0")

function claims(): void {
  const cases: Case[] = []

  cases.push(scenario("a code pairs once", {}, (s) => {
    const code = s.currentCode()
    s.claim(code, "Test iPad", "192.168.1.20")
    s.claim(code, "Second iPad", "192.168.1.21")
    s.currentCode()
    s.list()
    s.readFile()
    s.readLogs()
  }))

  cases.push(scenario("addresses of every kind", {}, (s) => {
    for (const ip of [null, "", "::ffff:192.168.1.5", "::FFFF:10.0.0.9", "fd00:1:2:3::9", "::1", "127.0.0.1", "fe80::1%en0"]) {
      s.claim(s.currentCode(), "Deck", ip)
    }
    s.list()
    s.readFile()
    s.readLogs()
  }))

  cases.push(scenario("eight wrong codes lock one address for a minute", {}, (s) => {
    const code = s.currentCode()
    for (let i = 0; i < 9; i += 1) s.claim(wrong(code), "Unit", "10.0.0.66")
    s.currentCode()
    s.claim(code, "Unit", "10.0.0.66")
    s.advance(59999)
    s.claim(code, "Unit", "10.0.0.66")
    s.claim(wrong(code), "Unit", "10.0.0.7")
    s.advance(1)
    // The lock is over, and the count starts again.
    for (let i = 0; i < 7; i += 1) s.claim(wrong(code), "Unit", "10.0.0.66")
    s.claim(code, "Unit", "10.0.0.66")
    s.readLogs()
  }))

  cases.push(scenario("a lock that ran out locks again after eight more", {}, (s) => {
    const code = s.currentCode()
    for (let i = 0; i < 8; i += 1) s.claim(wrong(code), "Unit", "10.0.0.66")
    s.advance(60000)
    for (let i = 0; i < 9; i += 1) s.claim(wrong(s.currentCode()), "Unit", "10.0.0.66")
    s.advance(60001)
    s.claim(s.currentCode(), "Unit", "10.0.0.66")
    s.readLogs()
  }))

  cases.push(scenario("a whole IPv6 /64 counts as one address", {}, (s) => {
    const code = s.currentCode()
    for (let i = 0; i < 9; i += 1) s.claim(wrong(code), "Unit", `fd00:1:2:3::${(i + 1).toString(16)}`)
    s.claim(code, "Unit", "fd00:1:2:3:ffff::9")
    s.claim(code, "Unit", "FD00:0001:0002:0003:1:2:3:4")
    s.claim(code, "Unit", "fd00:1:2:4::1")
    s.readLogs()
  }))

  cases.push(scenario("an address without a name is one address too", {}, (s) => {
    const code = s.currentCode()
    for (let i = 0; i < 9; i += 1) s.claim(wrong(code), "Unit", i % 2 ? null : "")
    s.claim(code, "Unit", "10.0.0.1")
    s.readLogs()
  }))

  cases.push(scenario("many addresses guessing together get the code replaced", {}, (s) => {
    const code = s.currentCode()
    for (let address = 1; address <= 4; address += 1) {
      for (let i = 0; i < 7; i += 1) s.claim(wrong(code), "Unit", `10.1.0.${address}`)
      s.currentCode()
    }
    s.claim(code, "Unit", "10.2.0.1")
    s.claim(s.currentCode(), "Unit", "10.2.0.1")
    s.readLogs()
  }))

  cases.push(scenario("a new code starts the count of guesses again", {}, (s) => {
    const code = s.currentCode()
    for (let i = 0; i < 23; i += 1) s.claim(wrong(code), "Unit", `10.1.${i}.1`)
    const next = s.newCode()
    for (let i = 0; i < 23; i += 1) s.claim(wrong(next), "Unit", `10.2.${i}.1`)
    s.currentCode()
    s.claim(wrong(next), "Unit", "10.3.0.1")
    s.currentCode()
    s.readLogs()
  }))

  cases.push(scenario("a code lasts ten minutes", {}, (s) => {
    const code = s.currentCode()
    s.advance(600000)
    s.currentCode()
    s.advance(1)
    s.claim(code, "Late", "10.0.0.2")
    const next = s.currentCode()
    s.advance(599999)
    s.claim(next, "In time", "10.0.0.2")
    s.advance(700000)
    // Claiming is what notices the code ran out.
    s.claim("000000", "Unit", "10.0.0.3")
    s.currentCode()
  }))

  cases.push(scenario("codes of every shape", {}, (s) => {
    const shapes = (code: string): Json[] => [
      null, true, false, "", " ", `${code} `, ` ${code}`, `${code}\n`, `${code}0`, code.slice(1), `+${code.slice(1)}`, { code }, [], [code, code],
      "１２３４５６", "١٢٣٤٥٦", "abcdef", 1e21, -1, 0.5, { length: 6 }
    ]
    let at = 0
    for (const shape of shapes(s.currentCode())) {
      // Each from its own address, so none is locked; the code is replaced along the way.
      at += 1
      s.claim(shape, "Unit", `10.4.${at}.1`)
    }
    // String(code) reads these as the digits.
    let code = s.currentCode()
    s.claim([code], "A list of one", "10.5.0.1")
    code = s.currentCode()
    s.claim(Number(code) >= 100000 ? Number(code) : code, "A number", "10.5.0.2")
    code = s.currentCode()
    s.claim([[code]], "A list in a list", "10.5.0.3")
  }))

  cases.push(scenario("pairing clears that address's wrong codes", {}, (s) => {
    const code = s.currentCode()
    for (let i = 0; i < 7; i += 1) s.claim(wrong(code), "Unit", "10.0.0.5")
    s.claim(code, "Unit", "10.0.0.5")
    const next = s.currentCode()
    for (let i = 0; i < 7; i += 1) s.claim(wrong(next), "Unit", "10.0.0.5")
    s.claim(next, "Unit", "10.0.0.5")
  }))

  cases.push(scenario("past a thousand addresses the unlocked ones are forgotten", {}, (s) => {
    const first = s.currentCode()
    for (let i = 0; i < 7; i += 1) s.claim(wrong(first), "Unit", "10.9.9.9")
    for (let i = 0; i < 8; i += 1) s.claim(wrong(s.currentCode()), "Unit", "10.9.9.8")
    for (let i = 0; i < 1000; i += 1) s.claim("abc", "Unit", `10.${100 + Math.floor(i / 250)}.${i % 250}.1`)
    // Seven wrong codes forgotten: seven more still do not lock it.
    for (let i = 0; i < 7; i += 1) s.claim(wrong(s.currentCode()), "Unit", "10.9.9.9")
    s.claim(s.currentCode(), "Unit", "10.9.9.9")
    // The locked one was kept.
    s.claim(s.currentCode(), "Unit", "10.9.9.8")
    s.readLogs()
  }))

  write("auth-claim.json", cases)
}

const NAMES: string[] = [
  "Test iPad", "", " ", "Teléfono Android", "iPad de José (sala)", "Jai's Tablet", "tablet-2_b.local", "<script>alert(1)</script>", "a/b\\c:d*e?f\"g",
  "日本語のタブレット", "Планшет №5", "😀 emoji 😀", "😀", "tab\tand\nnewline", "x".repeat(40), "x".repeat(41), "y".repeat(200), `${"é".repeat(39)}zz`,
  "½ ² ٣ Ⅷ", "é combining", "zero​width", "under_score", "semi;colon, comma", "@#$%^&*+=[]{}|~`", "ǅ ʰ ª", " nbsp", "Ünïcödé ñ",
  `${"z".repeat(38)}😀ab`, "…", "a  b"
]

function names(): void {
  const cases: Case[] = []
  startWorld(NOW)
  const dir = tempDir()
  const auth = createAuth({ file: path.join(dir, "devices.json"), log: () => {} })
  for (const name of NAMES) {
    cases.push({ input: name, output: auth.claim(auth.currentCode().code, name, "10.0.0.2").name })
  }
  write("auth-name.json", cases)
}

const ADDRESSES: Array<string | null> = [
  null, "", "192.168.1.20", "10.0.0.66", "::ffff:192.168.1.5", "::FFFF:10.0.0.9", "::ffff:", "::1", "::", "fd00:1:2:3::9", "fd00:1:2:3:ffff::9",
  "FD00:0001:0002:0003:1:2:3:4", "fd00:0:0:0::1", "2001:db8::", "2001:0db8:0000:0000:0000:ff00:0042:8329", "2001:db8:0:0:1::1", "fe80::1%en0",
  "1::", "::2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8", "1:2:3", "a:b", ":", ":::", "1::2::3", "0000:0000:0000:0000::", "00a0:000b:c000:0::1", "::ffff:fd00:1:2:3::9",
  "not an address", "ffff::ffff", "[::1]", "0:00:000:0000::", "::ffff:1:2", "1:2:3:4:5:6:7:8:9:10"
]

/** The address a lockout applies to is only ever said in the log, once it locks. */
function claimants(): void {
  const cases: Case[] = []
  for (const ip of ADDRESSES) {
    startWorld(NOW)
    const logs: string[] = []
    const auth = createAuth({ file: path.join(tempDir(), "devices.json"), log: (message) => { logs.push(message) } })
    for (let i = 0; i < 8; i += 1) {
      try { auth.claim("nope", "Unit", ip ?? undefined) } catch { /* refused, as meant */ }
    }
    const said = /^Pairing locked for a minute for (.*) after repeated wrong codes\.$/s.exec(logs[0] ?? "")
    if (!said) throw new Error(`no lock for ${String(ip)}`)
    cases.push({ input: ip, output: said[1] === "an unknown address" ? "" : said[1]! })
  }
  write("auth-claimant.json", cases)
}

const NONCE = "00112233445566778899aabbccddeeff"
let nonces = 0
const freshNonce = (): string => { nonces += 1; return nonces.toString(16).padStart(32, "0") }

function verifying(): void {
  const cases: Case[] = []
  nonces = 0
  const pair = (s: Session, name = "Test iPad"): Device => {
    const device = s.claim(s.currentCode(), name, "192.168.1.20")
    if (!device) throw new Error("not paired")
    return device
  }
  const sign = (device: Device, method: string, pathname: string, body = "", time = Date.now(), nonce = freshNonce()): SignedFields =>
    signRequest(device, method, pathname, body, time, nonce)

  cases.push(scenario("good, replayed and tampered requests", {}, (s) => {
    const device = pair(s)
    s.verify(sign(device, "GET", "/api/library"), "GET", "/api/library", "", "192.168.1.20")
    const replayed = sign(device, "GET", "/api/status")
    s.verify(replayed, "GET", "/api/status", "")
    s.verify(replayed, "GET", "/api/status", "")
    const body = JSON.stringify({ profileId: "profile_default", buttonId: "nope" })
    const signed = sign(device, "POST", "/api/press", body)
    s.verify(signed, "POST", "/api/press", body.replace("nope", "btn_1"))
    s.verify(signed, "POST", "/api/other", body)
    s.verify(signed, "PUT", "/api/press", body)
    s.verify({ ...signed, nonce: freshNonce() }, "POST", "/api/press", body)
    s.verify({ ...signed, time: String(Number(signed.time) + 1) }, "POST", "/api/press", body)
    // None of those used the nonce up.
    s.verify(signed, "post", "/api/press", body, "192.168.1.77")
    s.verify(signed, "POST", "/api/press", body)
    s.list()
  }))

  cases.push(scenario("old and future times", {}, (s) => {
    const device = pair(s)
    for (const offset of [-600000, -120001, -120000, -119999, 0, 119999, 120000, 120001, 600000]) {
      s.verify(sign(device, "GET", "/api/status", "", NOW + offset), "GET", "/api/status", "")
    }
    // The same request, as the clock moves past it.
    const signed = sign(device, "GET", "/api/status")
    s.advance(120000)
    s.verify(signed, "GET", "/api/status", "")
    s.verify(signed, "GET", "/api/status", "")
    const late = sign(device, "GET", "/api/status", "", NOW)
    s.advance(1)
    s.verify(late, "GET", "/api/status", "")
    // A nonce is remembered longer than its request could be sent again.
    s.advance(300000)
    s.verify({ ...sign(device, "GET", "/api/status"), nonce: signed.nonce }, "GET", "/api/status", "")
    s.verify(sign(device, "GET", "/api/status", "", Date.now(), signed.nonce), "GET", "/api/status", "")
  }))

  cases.push(scenario("times written oddly", {}, (s) => {
    const device = pair(s)
    const at = (time: string, signedTime = NOW): void => {
      s.verify({ ...sign(device, "GET", "/api/status", "", signedTime), time }, "GET", "/api/status", "")
    }
    for (const time of ["soon", "", " ", "NaN", "Infinity", "-Infinity", "1750000000000abc", "１７５００００００００００００"]) at(time)
    for (const time of [` ${NOW} `, "1.75e12", "1750000000000.0", `0x${NOW.toString(16)}`, `+${NOW}`, "1750000000000.5", `0b${NOW.toString(2)}`]) at(time)
    at("1750000000000.5", 1750000000000.5)
    const missing: Partial<SignedFields> = sign(device, "GET", "/api/status")
    delete missing.time
    s.verify(missing, "GET", "/api/status", "")
  }))

  cases.push(scenario("fields missing or misshapen", {}, (s) => {
    const device = pair(s)
    const good = (): SignedFields => sign(device, "POST", "/api/press", "{}")
    const send = (signed: Partial<SignedFields>): void => { s.verify(signed, "POST", "/api/press", "{}") }
    send({})
    send({ device: device.id })
    send({ device: device.id, time: String(NOW) })
    send({ device: device.id, time: String(NOW), nonce: NONCE })
    send({ device: device.id, time: "soon", nonce: "n", signature: "s" })
    send({ device: device.id, time: String(NOW), nonce: "n", signature: "s" })
    send({ device: device.id, time: String(NOW), nonce: NONCE, signature: "s" })
    send({ ...good(), device: "dev_000000000000" })
    send({ ...good(), device: "" })
    send({ ...good(), device: device.id.toUpperCase() })
    send({ ...good(), device: ` ${device.id}` })
    for (const nonce of ["0".repeat(15), "0".repeat(65), "ABCDEF0123456789", "0123456789abcdeg", "0123456789abcdef\n", " 0123456789abcdef"]) {
      send(signRequest(device, "POST", "/api/press", "{}", NOW, nonce))
    }
    for (const nonce of ["0".repeat(16), "f".repeat(64)]) send(signRequest(device, "POST", "/api/press", "{}", NOW, nonce))
    const upper = good()
    send({ ...upper, signature: upper.signature.toUpperCase() })
    send({ ...upper, signature: `${upper.signature} ` })
    send({ ...upper, signature: upper.signature.slice(0, 63) })
    send({ ...upper, signature: "" })
    send(upper)
    send(signRequest({ id: device.id, secret: "0".repeat(64) }, "POST", "/api/press", "{}", NOW, freshNonce()))
  }))

  cases.push(scenario("bodies and paths in other alphabets", {}, (s) => {
    const device = pair(s, "Teléfono Android")
    for (const body of TEXTS.filter((text) => text.length < 2000)) {
      s.verify(sign(device, "POST", "/api/press", body), "POST", "/api/press", body)
    }
    for (const pathname of PATHS) s.verify(sign(device, "GET", pathname), "GET", pathname, "")
    for (const method of METHODS) s.verify(sign(device, method, "/api/press", "{}"), method.toUpperCase(), "/api/press", "{}")
    s.verify(sign(device, "GET", "/api/sounds/café.mp3"), "GET", "/api/sounds/café.mp3", "")
  }))

  cases.push(scenario("two devices, and one removed", {}, (s) => {
    const first = pair(s, "First")
    const second = pair(s, "Second")
    const shared = freshNonce()
    // A nonce belongs to its device.
    s.verify(sign(first, "GET", "/api/status", "", NOW, shared), "GET", "/api/status", "")
    s.verify(sign(second, "GET", "/api/status", "", NOW, shared), "GET", "/api/status", "")
    s.verify({ ...sign(first, "GET", "/api/status"), device: second.id }, "GET", "/api/status", "")
    s.has(first.id)
    s.remove(first.id)
    s.remove(first.id)
    s.has(first.id)
    s.verify(sign(first, "GET", "/api/library"), "GET", "/api/library", "")
    s.verify(sign(second, "GET", "/api/library"), "GET", "/api/library", "", "::ffff:192.168.1.30")
    s.list()
  }))

  write("auth-verify.json", cases)
}

function devices(): void {
  const cases: Case[] = []
  const stored = (list: Json[], extra: { [key: string]: Json } = {}): string => `${JSON.stringify({ version: 1, devices: list, ...extra }, null, 2)}\n`
  const one = { id: "dev_0a1b2c3d4e5f", secret: "ab".repeat(32), name: "Kitchen tablet", createdAt: "2025-01-02T03:04:05.678Z", lastSeen: "2025-05-06T07:08:09.012Z", ip: "192.168.1.40" }
  const two = { id: "dev_ffffffffffff", secret: "cd".repeat(32), name: "Teléfono Android", createdAt: "2025-02-02T00:00:00.000Z", lastSeen: "2025-02-02T00:00:00.000Z" }
  const use = (s: Session, device: { id: string; secret: string }, ip: string | null = null): void => {
    s.verify(signRequest(device, "GET", "/api/status", "", Date.now(), freshNonce()), "GET", "/api/status", "", ip)
  }

  cases.push(scenario("the file after pairing, with and without an address", {}, (s) => {
    s.readFile()
    s.claim(s.currentCode(), "Test iPad", "192.168.1.20")
    s.readFile()
    s.readBak()
    s.advance(1500)
    s.claim(s.currentCode(), "Teléfono Android", null)
    s.claim(s.currentCode(), "<b>Tablet</b> “de” José", "fd00:1:2:3::9")
    s.readFile()
    s.readBak()
    s.list()
    s.reopen()
    s.list()
  }))

  cases.push(scenario("lastSeen is written half a minute later", { file: stored([one, two]) }, (s) => {
    s.list()
    s.advance(5000)
    use(s, one)
    s.advance(10000)
    use(s, two, "192.168.1.41")
    s.advance(19999)
    s.readFile()
    s.advance(1)
    s.readFile()
    s.readBak()
    // And again, from the next request on.
    s.advance(1000)
    use(s, one, "192.168.1.99")
    s.advance(30000)
    s.readFile()
  }))

  cases.push(scenario("flush writes what was waiting", { file: stored([one, two]) }, (s) => {
    s.flush()
    s.readBak()
    s.advance(7000)
    use(s, two)
    s.flush()
    s.readFile()
    s.advance(60000)
    s.readBak()
    use(s, one)
    s.flush()
    // What Node wrote, read again.
    s.reopen()
    s.list()
    s.advance(30000)
    s.readFile()
  }))

  cases.push(scenario("removing writes at once", { file: stored([one, two]) }, (s) => {
    s.remove("dev_nobody")
    s.readBak()
    s.remove(one.id)
    s.readFile()
    s.readBak()
    s.claim(s.currentCode(), "New", "10.0.0.2")
    s.remove(two.id)
    s.readFile()
    s.list()
  }))

  cases.push(scenario("a file edited by hand keeps what it held", {
    file: JSON.stringify({
      devices: [
        { lastSeen: "2025-05-06T07:08:09.012Z", note: "the kitchen one", name: "Kitchen tablet", id: one.id, createdAt: one.createdAt, secret: one.secret, 7: "seven", tags: ["a", { b: 1.5 }] },
        { id: "dev_nosecret", name: "No secret", createdAt: "x", lastSeen: "y" },
        { id: 5, secret: "s", name: "Number id", createdAt: "x", lastSeen: "y" },
        { id: "dev_nullname", secret: "s", name: null, createdAt: "x", lastSeen: "y" },
        "not a device", null, [], 12,
        { ...two, name: "", createdAt: "not a date", lastSeen: "" },
        { id: "", secret: "", name: "Nameless", createdAt: "", lastSeen: "" }
      ],
      version: 9,
      comment: "kept until the next save"
    })
  }, (s) => {
    s.list()
    s.has(one.id)
    s.has("dev_nosecret")
    s.has("")
    use(s, one, "192.168.1.50")
    use(s, two)
    use(s, { id: "", secret: "" })
    s.flush()
    s.readFile()
    s.reopen()
    s.list()
  }))

  cases.push(scenario("two devices with one id", {
    file: stored([one, two, { ...one, name: "The later one", secret: "ef".repeat(32) }])
  }, (s) => {
    s.list()
    use(s, one)
    use(s, { id: one.id, secret: "ef".repeat(32) })
    s.flush()
    s.readFile()
  }))

  cases.push(scenario("an empty list", { file: stored([]) }, (s) => {
    s.list()
    s.flush()
    s.readFile()
    s.readBak()
    s.remove("dev_nobody")
    s.claim(s.currentCode(), "First", "10.0.0.2")
    s.readFile()
    s.readBak()
  }))

  cases.push(scenario("a damaged file with a good previous save", { file: "{ this is not json", bak: stored([one]) }, (s) => {
    s.list()
    s.readFile()
    use(s, one)
    s.flush()
    s.readFile()
    s.readBak()
  }))
  cases.push(scenario("a missing file with a previous save", { bak: stored([two]) }, (s) => {
    s.list()
    s.readFile()
    s.claim(s.currentCode(), "Another", null)
    s.readFile()
    s.readBak()
  }))
  cases.push(scenario("a damaged file and no previous save", { file: "{ this is not json" }, () => {}))
  cases.push(scenario("an empty file", { file: "" }, () => {}))
  cases.push(scenario("a file that is a list", { file: "[]" }, () => {}))
  cases.push(scenario("a file whose devices are not a list", { file: '{"version":1,"devices":{}}' }, () => {}))
  cases.push(scenario("a damaged file and a damaged previous save", { file: "nope", bak: "{}" }, () => {}))
  cases.push(scenario("devices of the wrong shape only", { file: '{"devices":[1,"two",{"id":"x"}]}' }, (s) => {
    s.list()
    s.readFile()
    s.claim(s.currentCode(), "First", "10.0.0.2")
    s.readFile()
  }))

  write("auth-devices.json", cases)
}

// ---------------------------------------------------------------- the library

/** The same text whenever it is made: the damaged copy and the day's snapshot
    are named by the clock, and Rust's is the real one. */
const timeless = (text: string): string =>
  text.replace(/\.corrupt-[0-9TZ-]+/g, ".corrupt-*").replace(/\\/g, "/").replace(/^backups\/library-\d{4}-\d\d-\d\d\.json$/, "backups/library-DATE.json")

function filesIn(dir: string): { [name: string]: string } {
  const found: Array<[string, string]> = []
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(full)
      else found.push([timeless(path.relative(dir, full)), fs.readFileSync(full, "utf8")])
    }
  }
  walk(dir)
  return Object.fromEntries(found.sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

function noticeJson(notice: Text | null): Json {
  if (!notice) return null
  const vars: { [name: string]: Json } = {}
  for (const [name, value] of Object.entries(notice.vars ?? {})) {
    vars[name] = typeof value === "string" ? timeless(value) : typeof value === "number" ? value : value.key
  }
  return { key: notice.key, vars, worded: timeless(english(notice)) }
}

type LibraryStep = { op: "save"; library: Json } | { op: "block" } | { op: "unblock" } | { op: "state" }

interface LibraryStart {
  files?: { [name: string]: string }
  mac?: boolean
  words?: "en" | "es"
  steps?: LibraryStep[]
}

const deck = (name: string, buttons: Json[] = []): { [key: string]: Json } => ({ id: name.toLowerCase(), name, columns: 4, rows: 3, buttons })
const press = (id: string, slot: number): Json => ({ id, slot, label: id, icon: "zap", color: "accent", control: "press", steps: [{ id: `s_${id}`, type: "none", delayMs: 0 }] })
const mine: Json = { version: 1, activeProfileId: "mine", profiles: [deck("Mine", [press("a", 0)])] }

function libraryCase(name: string, start: LibraryStart): Case {
  const words = start.words ?? "en"
  const mac = start.mac ?? true
  const steps = start.steps ?? []
  startWorld(NOW)
  const decks = path.join(tempDir(), "decks")
  fs.mkdirSync(decks)
  const files = start.files ?? {}
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(decks, file), text)
  const file = path.join(decks, "library.json")

  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: mac ? "darwin" : "linux", configurable: true })
  setTranslator(words, translator(words))
  // Asking makes an id, which is counted: Rust starts after it.
  const ids = { now: Date.now(), counter: Number(nextId("probe").split("_")[2]) }
  const logs: string[] = []
  try {
    const store = createLibraryStore(file, (message) => { logs.push(message) })
    const state = (): { [key: string]: Json } => ({
      library: JSON.parse(JSON.stringify(store.get())) as Json,
      revision: store.revision(),
      notice: noticeJson(store.notice()),
      files: filesIn(decks)
    })
    const output: { [key: string]: Json } = { ...state(), logLines: logs.length }
    const answers: Json[] = []
    for (const step of steps) {
      if (step.op === "save") {
        try {
          answers.push({ revision: store.save(normalizeLibrary(step.library)) })
        } catch (error) {
          if (!(error instanceof HttpError)) throw error
          answers.push({ status: error.status, key: error.text?.key ?? null })
        }
      } else if (step.op === "block") {
        fs.renameSync(file, path.join(decks, "library.json.keep"))
        fs.mkdirSync(file)
        answers.push(null)
      } else if (step.op === "unblock") {
        fs.rmdirSync(file)
        fs.renameSync(path.join(decks, "library.json.keep"), file)
        answers.push(null)
      } else {
        answers.push(state())
      }
    }
    return { name, input: { files, mac, words, now: NOW, steps }, ids, output: { ...output, steps: answers } }
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform)
    setTranslator("en", translator("en"))
  }
}

function libraries(): void {
  const cases: Case[] = []
  const text = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`
  const save = (library: Json): LibraryStep => ({ op: "save", library })
  const state: LibraryStep = { op: "state" }
  const other: Json = { version: 1, activeProfileId: "other", profiles: [deck("Mine", [press("a", 0)]), deck("Other", [press("b", 2), press("c", 5)])] }
  const fader: Json = { id: "f", slot: 1, label: "Volumen", icon: "zap", color: "accent", control: "fader", fader: { target: "system" }, steps: [] }
  const repeated: Json = { version: 1, activeProfileId: "mine", profiles: [deck("Mine", [press("a", 0), press("a", 0), fader]), deck("Mine")] }

  for (const words of ["en", "es"] as const) {
    for (const mac of [true, false]) {
      cases.push(libraryCase(`a first start, ${words}, ${mac ? "a Mac" : "not a Mac"}`, { words, mac }))
    }
  }
  cases.push(libraryCase("a first start, then saves", { steps: [save(mine), state, save(other), state, save(repeated), state] }))
  cases.push(libraryCase("a deck file as the companion wrote it", { files: { "library.json": text(other) }, steps: [state, save(mine), state] }))
  cases.push(libraryCase("a deck file written on one line, with a previous save", {
    files: { "library.json": JSON.stringify(mine), "library.json.bak": "older" }, steps: [save(other), state]
  }))
  cases.push(libraryCase("a deck file that needs repairs", { files: { "library.json": text(repeated) }, steps: [state] }))
  cases.push(libraryCase("a deck file with no decks", { files: { "library.json": '{"version":1,"activeProfileId":"","profiles":[]}' }, words: "es", steps: [state] }))
  cases.push(libraryCase("a deck file with more in it than a deck", {
    files: { "library.json": JSON.stringify({ version: 1.0, activeProfileId: "x", profiles: [{ id: "x", name: "  Odd  ", columns: 99, rows: 0, buttons: [{ slot: "3" }, 7], extra: true }], extra: [1, 2] }) },
    steps: [state]
  }))
  cases.push(libraryCase("a damaged file", { files: { "library.json": "{ this is not json" }, steps: [state, save(mine), state] }))
  cases.push(libraryCase("a damaged file, in Spanish", { files: { "library.json": "{ this is not json" }, words: "es" }))
  cases.push(libraryCase("an empty file", { files: { "library.json": "" } }))
  cases.push(libraryCase("a file of the wrong shape", { files: { "library.json": '{"version":1,"activeProfileId":"x"}' } }))
  cases.push(libraryCase("a file that is a list", { files: { "library.json": "[1,2,3]" } }))
  cases.push(libraryCase("a version written as text", { files: { "library.json": '{"version":"2","activeProfileId":"x","profiles":[]}' } }))
  cases.push(libraryCase("a version of zero", { files: { "library.json": '{"version":0,"activeProfileId":"x","profiles":[]}' } }))
  cases.push(libraryCase("a damaged file with a good previous save", {
    files: { "library.json": "garbage", "library.json.bak": JSON.stringify(mine) }, steps: [state, save(other), state]
  }))
  cases.push(libraryCase("a missing file with a good previous save", { files: { "library.json.bak": text(other) }, steps: [state] }))
  cases.push(libraryCase("a missing file with a damaged previous save", { files: { "library.json.bak": "garbage" }, steps: [state, save(mine), state] }))
  cases.push(libraryCase("a damaged file with a damaged previous save", { files: { "library.json": "garbage", "library.json.bak": "{}" }, steps: [state] }))
  const newer = JSON.stringify({ version: 2, activeProfileId: "x", decks: [{ id: "x", stuff: "from the future" }] })
  cases.push(libraryCase("a file from a newer Punchboard", { files: { "library.json": newer }, steps: [save(mine), state] }))
  cases.push(libraryCase("a file from a newer Punchboard, in Spanish", { files: { "library.json": newer, "library.json.bak": JSON.stringify(mine) }, words: "es", steps: [save(mine), state] }))
  cases.push(libraryCase("a newer format with a fraction", { files: { "library.json": '{"version":3.5}' }, steps: [state] }))
  cases.push(libraryCase("a newer format, very large", { files: { "library.json": '{"version":1e21,"profiles":[]}' }, steps: [state] }))
  cases.push(libraryCase("a format just past this one", { files: { "library.json": '{"version":1.0000001,"activeProfileId":"x","profiles":[]}' }, steps: [state] }))
  cases.push(libraryCase("a save that cannot be written", {
    steps: [save(mine), { op: "block" }, save(other), state, { op: "unblock" }, state, save(other), state]
  }))

  write("library.json", cases)
}

// ------------------------------------------------------------ Google's icons

interface Answer { status: number; body: string }

let answer: Answer | null = null
let askedUrls: string[] = []

/** Google, played by hand: it answers what the case says, or is unreachable. */
const fakeFetch: typeof fetch = async (input) => {
  askedUrls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  if (!answer) throw new TypeError("fetch failed")
  return new Response(answer.body, { status: answer.status })
}

function failure(error: unknown): Json {
  if (!(error instanceof UserError)) return { thrown: true }
  const vars: { [name: string]: Json } = {}
  for (const [name, value] of Object.entries(error.text.vars ?? {})) {
    // A reason is JavaScript's own wording, unless it is an HTTP status.
    if (typeof value === "object") vars[name] = value.key
    else vars[name] = name === "reason" && !(typeof value === "string" && value.startsWith("HTTP ")) ? "*" : value
  }
  return { error: error.text.key, vars }
}

/** The catalog as fonts.google.com/metadata/icons answers it, cut down to a few icons. */
const icon = (name: string, popularity: number, categories: string[], tags: string[]): Json => ({
  name, version: 248, popularity, codepoint: 59574, unsupported_families: ["Material Icons", "Material Icons Outlined"], categories, tags, sizes_px: [20, 24, 40, 48]
})
const catalogBody = (icons: Json, prefix = ")]}'\n"): string => prefix + JSON.stringify({
  host: "fonts.gstatic.com",
  asset_url_pattern: "/s/i/{family}/{icon}/v{version}/{asset}",
  families: ["Material Icons", "Material Icons Outlined", "Material Symbols Outlined", "Material Symbols Rounded", "Material Symbols Sharp"],
  icons
}, null, 2)

const SAMPLE: Json[] = [
  icon("search", 28991, ["Actions"], ["filter", "find", "glass", "look", "magnify", "magnifying", "search", "see"]),
  icon("home", 70219, ["Common actions"], ["address", "app", "building", "components", "design", "estate", "home", "homepage", "house", "interface", "layout", "place", "real", "residence", "residential", "screen", "shelter", "site", "structure", "ui", "unit", "ux", "website", "window"]),
  icon("mic_off", 5270, ["Audio&Video", "Communicate"], ["Audio", "Disabled", "MIC", "Off", "slash"]),
  icon("10k", 331, ["Audio&Video"], ["10000", "10K", "alphabet"]),
  icon("settings", 70219, ["Common actions"], ["application", "change", "details", "gear"]),
  icon("close", 70219, ["Common actions"], []),
  icon("emoji_İ", 12, ["Social"], ["İstanbul", "ΣΑΣ", "STRASSE", "Ǆ", "日本語"])
]

async function catalogs(): Promise<void> {
  const cases: Case[] = []
  const MONTH = 30 * 24 * 60 * 60 * 1000
  const cacheOf = (fetchedAt: Json, icons: Json): string => JSON.stringify({ fetchedAt, icons })
  const kept: Json = [{ n: "kept", t: "from the last copy", c: "Cache" }]

  const run = async (name: string, input: { cache?: string; fetch: Answer | null; blocked?: boolean; now?: number }): Promise<void> => {
    const now = input.now ?? NOW
    startWorld(now)
    const cacheDir = path.join(tempDir(), "cache")
    const file = path.join(cacheDir, "material-symbols.json")
    if (input.cache !== undefined) {
      fs.mkdirSync(cacheDir)
      fs.writeFileSync(file, input.cache)
    }
    if (input.blocked) fs.writeFileSync(cacheDir, "in the way")
    answer = input.fetch
    askedUrls = []
    const icons = createGoogleIcons(cacheDir)
    const load = async (): Promise<Json> => {
      try {
        return { icons: JSON.parse(JSON.stringify(await icons.loadCatalog())) as Json }
      } catch (error) {
        return failure(error)
      }
    }
    const result = await load()
    const asked = [...askedUrls]
    const stored = readOrNull(file)
    const again = await load()
    cases.push({
      name,
      input: { cache: input.cache ?? null, fetch: input.fetch, blocked: input.blocked ?? false, now },
      output: { result, asked, file: stored, again, askedAgain: askedUrls.length }
    })
  }
  const body = async (name: string, text: string): Promise<void> => run(name, { fetch: { status: 200, body: text } })
  const icons = async (name: string, list: Json): Promise<void> => body(name, catalogBody(list))

  await icons("the catalog as Google sends it", SAMPLE)
  await body("without the prefix", catalogBody(SAMPLE, ""))
  await body("the prefix and no line break", catalogBody(SAMPLE, ")]}'"))
  await body("the prefix and much white space", catalogBody(SAMPLE, ")]}'\r\n\t  ﻿ \n"))
  await body("white space before the prefix", catalogBody(SAMPLE, " )]}'\n"))
  await body("the prefix twice", catalogBody(SAMPLE, ")]}')]}'\n"))
  await body("on one line", `)]}'\n${JSON.stringify({ icons: SAMPLE })}`)
  await body("no icons at all", ")]}'\n{\"host\":\"fonts.gstatic.com\"}")
  await body("icons that are not a list", ")]}'\n{\"icons\":{\"0\":{\"name\":\"x\"}}}")
  await body("a list where the catalog should be", ")]}'\n[{\"name\":\"x\"}]")
  await body("null", ")]}'\nnull")
  await body("not JSON", ")]}'\n<html>Sorry</html>")
  await body("nothing", "")
  await body("only the prefix", ")]}'\n")
  await icons("an empty list", [])
  await icons("things that are not icons", [null, 5, "home", [], {}, { name: 5 }, { name: null }, { name: "kept" }, { Name: "x" }, [{ name: "inside" }]])
  await icons("popularity of every kind", [
    { name: "none" }, { name: "null", popularity: null }, { name: "zero", popularity: 0 }, { name: "minus", popularity: -3 }, { name: "half", popularity: 0.5 },
    { name: "text", popularity: "7" }, { name: "yes", popularity: true }, { name: "big", popularity: 1e21 }, { name: "list", popularity: [3] }, { name: "blank", popularity: "" },
    { name: "tie_a", popularity: 2 }, { name: "tie_b", popularity: 2 }, { name: "tie_c", popularity: 2 }, { name: "last", popularity: -1e9 }
  ])
  await icons("ties keep Google's order", Array.from({ length: 40 }, (_, at): Json => ({ name: `icon_${at}`, popularity: at % 3 })))
  await icons("tags of every kind", [
    { name: "none" }, { name: "null", tags: null }, { name: "empty", tags: [] }, { name: "one", tags: ["Solo"] },
    { name: "sixteen", tags: Array.from({ length: 16 }, (_, at) => `T${at}`) }, { name: "seventeen", tags: Array.from({ length: 17 }, (_, at) => `T${at}`) },
    { name: "mixed", tags: ["A", 1, 2.5, null, true, false, ["x", "Y", null], { z: 1 }, "", " spaced  out ", 1e21] },
    { name: "letters", tags: ["İstanbul", "ΣΑΣ", "ΌΣΟΣ", "STRASSE", "Ǆ", "日本語", "ÀÉÎÕÜ", "😀"] }
  ])
  await icons("tags that are text", [{ name: "home", tags: ["a"] }, { name: "odd", tags: "search find" }])
  await icons("tags that are a number", [{ name: "odd", tags: 5 }])
  await icons("tags that are an object", [{ name: "odd", tags: { 0: "a" } }])
  await icons("tags that are true", [{ name: "odd", tags: true }])
  await icons("categories of every kind", [
    { name: "none" }, { name: "null", categories: null }, { name: "empty", categories: [] }, { name: "two", categories: ["First", "Second"] },
    { name: "null_first", categories: [null, "Second"] }, { name: "number", categories: [5] }, { name: "zero", categories: [0] }, { name: "no", categories: [false] },
    { name: "blank", categories: [""] }, { name: "list", categories: [["a", "b"]] }, { name: "object", categories: [{ a: 1 }] },
    { name: "text", categories: "Actions" }, { name: "no_text", categories: "" }, { name: "a_number", categories: 7 }, { name: "yes", categories: true },
    { name: "keyed", categories: { 0: "Zeroth", 1: "First" } }, { name: "keyed_null", categories: { 0: null } }, { name: "unkeyed", categories: { a: 1 } }
  ])
  await icons("the same name twice", [icon("home", 1, ["A"], ["one"]), icon("home", 2, ["B"], ["two"])])

  for (const status of [201, 299, 300, 302, 400, 403, 404, 429, 500, 503]) {
    await run(`Google answers ${status}`, { fetch: { status, body: catalogBody(SAMPLE) } })
  }
  await run("Google cannot be reached", { fetch: null })
  await run("the cache folder cannot be made", { fetch: { status: 200, body: catalogBody(SAMPLE) }, blocked: true })

  const good: Answer = { status: 200, body: catalogBody(SAMPLE) }
  await run("a copy from today", { cache: cacheOf(NOW, kept), fetch: good })
  await run("a copy a moment short of thirty days", { cache: cacheOf(NOW - MONTH + 1, kept), fetch: good })
  await run("a copy thirty days old", { cache: cacheOf(NOW - MONTH, kept), fetch: good })
  await run("an old copy, refreshed", { cache: cacheOf(NOW - 2 * MONTH, kept), fetch: good })
  await run("an old copy and no Google", { cache: cacheOf(NOW - 2 * MONTH, kept), fetch: null })
  await run("an old copy and Google answering 503", { cache: cacheOf(NOW - 2 * MONTH, kept), fetch: { status: 503, body: "busy" } })
  await run("an old copy and Google answering nonsense", { cache: cacheOf(NOW - 2 * MONTH, kept), fetch: { status: 200, body: "<html>" } })
  await run("an old copy and tags that are text", { cache: cacheOf(0, kept), fetch: { status: 200, body: catalogBody([{ name: "odd", tags: "x" }]) } })
  await run("an old copy and an empty catalog", { cache: cacheOf(0, kept), fetch: { status: 200, body: ")]}'\n{}" } })
  await run("a copy from the future", { cache: cacheOf(NOW + MONTH, kept), fetch: good })
  await run("a copy with a fraction of a millisecond", { cache: cacheOf(NOW - MONTH + 0.5, kept), fetch: good })
  await run("a copy holding anything", { cache: cacheOf(NOW, [1, "two", null, { n: 3 }, [4]]), fetch: good })
  await run("a copy written with spaces", { cache: `{\n  "icons": [],\n  "fetchedAt": ${NOW},\n  "more": true\n}\n`, fetch: good })
  await run("a copy that is damaged", { cache: "{ not json", fetch: good })
  await run("a copy that is damaged and no Google", { cache: "{ not json", fetch: null })
  await run("a copy whose time is text", { cache: cacheOf(String(NOW), kept), fetch: null })
  await run("a copy whose icons are not a list", { cache: cacheOf(NOW, { n: "x" }), fetch: good })
  await run("a copy that is empty", { cache: "", fetch: { status: 500, body: "" } })

  write("google-catalog.json", cases)
}

async function glyphs(): Promise<void> {
  const cases: Case[] = []
  const D = "M480-120v-80h280v-560H480v-80h280q33 0 56.500 23.500T840-760v560q0 33-23.500 56.500T760-120H480Zm-80-160-55-58 102-102H120v-80h327L345-622l55-58 200 200-200 200Z"
  const svg = (inside: string, attributes = 'xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e8eaed"'): string => `<svg ${attributes}>${inside}</svg>`
  const good = svg(`<path d="${D}"/>`)

  const run = async (name: string, input: { name: string; style: string; fill: boolean; fetch: Answer | null }): Promise<void> => {
    startWorld(NOW)
    answer = input.fetch
    askedUrls = []
    const icons = createGoogleIcons(path.join(tempDir(), "cache"))
    const load = async (): Promise<Json> => {
      try {
        return { glyph: JSON.parse(JSON.stringify(await icons.loadGlyph(input.name, input.style, input.fill))) as Json }
      } catch (error) {
        return failure(error)
      }
    }
    const result = await load()
    const asked = [...askedUrls]
    const again = await load()
    cases.push({ name, input, output: { result, asked, again, askedAgain: askedUrls.length } })
  }
  const shape = async (name: string, text: string): Promise<void> => run(name, { name: "login", style: "outlined", fill: false, fetch: { status: 200, body: text } })

  for (const style of ["outlined", "rounded", "sharp"]) {
    for (const fill of [false, true]) await run(`login, ${style}${fill ? ", filled" : ""}`, { name: "login", style, fill, fetch: { status: 200, body: good } })
  }
  for (const name of ["10k", "mic_off", "a", "a".repeat(64)]) await run(`the name ${name.slice(0, 12)}`, { name, style: "outlined", fill: false, fetch: { status: 200, body: good } })
  for (const name of ["", "Mic", "mic-off", "mic off", "mic/off", "../x", "mic\n", "micó", "a".repeat(65), "１０k"]) {
    await run(`not a name: ${JSON.stringify(name.slice(0, 12))}`, { name, style: "outlined", fill: false, fetch: { status: 200, body: good } })
  }
  for (const style of ["", "Outlined", "filled", "two-tone", "outlined ", "sharp\n"]) {
    await run(`not a style: ${JSON.stringify(style)}`, { name: "login", style, fill: false, fetch: { status: 200, body: good } })
  }
  await run("a bad name and a bad style", { name: "Nope", style: "nope", fill: true, fetch: { status: 200, body: good } })
  for (const status of [201, 299, 300, 302, 400, 403, 404, 429, 500, 503]) {
    await run(`Google answers ${status}`, { name: "login", style: "sharp", fill: true, fetch: { status, body: good } })
  }
  await run("Google cannot be reached", { name: "login", style: "outlined", fill: false, fetch: null })

  await shape("two paths", svg(`<path d="M0 0h24v24H0z" fill="none"/><path d="${D}"/>`))
  await shape("eight paths", svg('<path d="M1 1L2 2"/>'.repeat(8)))
  await shape("nine paths", svg('<path d="M1 1L2 2"/>'.repeat(9)))
  await shape("no path", svg('<circle cx="12" cy="12" r="10"/>'))
  await shape("nothing", "")
  await shape("not an SVG", "<html><body>Not found</body></html>")
  await shape("attributes before d", svg('<path fill="none" stroke-width="2" d="M3 3h18"/>'))
  await shape("an id that is d", svg('<path id="d" d="M4 4h16"/>'))
  await shape("an attribute that ends in d", svg('<path data-d="M0 0" d="M5 5h14"/>'))
  await shape("only an attribute that ends in d", svg('<path id="M6 6h12"/>'))
  await shape("no space before d", svg('<path id="p"d="M7 7h10"/>'))
  await shape("a line break before d", svg('<path\n\td="M8 8h8"\n/>'))
  await shape("a tab before d", svg('<path\td="M9 9h6"/>'))
  await shape("a no-break space before d", svg('<path d="M9 9h5"/>'))
  await shape("d twice", svg('<path d="M1 1h1" d="M2 2h2"/>'))
  await shape("d empty, then d", svg('<path d="" d="M2 2h3"/>'))
  await shape("d, then d empty", svg('<path d="M1 1h4" d=""/>'))
  await shape("d empty", svg('<path d=""/>'))
  await shape("d in single quotes", svg("<path d='M1 1h5'/>"))
  await shape("spaces around the equals sign", svg('<path d = "M1 1h6"/>'))
  await shape("D in capitals", svg('<path D="M1 1h7"/>'))
  await shape("a tag that only starts like path", svg('<pathology d="M1 1h8"/>'))
  await shape("a greater-than sign in an attribute", svg('<path title="a>b" d="M1 1h9"/>'))
  await shape("a greater-than sign in d", svg('<path d="M1 1>2"/>'))
  await shape("d never closed", svg('<path d="M1 1h10/>'))
  await shape("d never closed, then a good path", `${svg('<path d="M1 1h10/>')}<path d="M2 2h1"/>`)
  await shape("a path cut off, then a path", svg('<path <path d="M3 3h1"/>'))
  await shape("a path inside a comment", svg('<!-- <path d="M0 0h1"/> --><path d="M4 4h1"/>'))
  await shape("letters a deck cannot draw", svg('<path d="M1 1 url(javascript:alert(1))"/>'))
  await shape("one good path and one that cannot be drawn", svg('<path d="M1 1h1"/><path d="<script>"/>'))
  await shape("exponents and commas", svg('<path d="M1e1,2.5-3 4E-2zA1 1 0 0 1 5 5"/>'))
  await shape("no viewBox", svg(`<path d="${D}"/>`, 'xmlns="http://www.w3.org/2000/svg"'))
  await shape("an empty viewBox", svg(`<path d="${D}"/>`, 'viewBox=""'))
  await shape("an empty viewBox, then a good one", svg(`<g viewBox="0 0 24 24"><path d="${D}"/></g>`, 'viewBox=""'))
  await shape("two viewBoxes", svg(`<g viewBox="0 0 48 48"><path d="${D}"/></g>`, 'viewBox="0 0 24 24"'))
  await shape("a viewBox of words", svg(`<path d="${D}"/>`, 'viewBox="javascript:alert(1)"'))
  await shape("a viewBox in single quotes", svg(`<path d="${D}"/>`, "viewBox='0 0 24 24'"))
  await shape("viewbox in small letters", svg(`<path d="${D}"/>`, 'viewbox="0 0 24 24"'))
  await shape("a viewBox with commas and fractions", svg(`<path d="${D}"/>`, 'viewBox="0,0,24.5,24.5"'))
  await shape("a viewBox never closed", `<svg viewBox="0 0 24 24><path d=${D}/>`)
  await shape("a title in another alphabet", svg(`<title>Iniciar sesión · ログイン 😀</title><path d="${D}"/>`))

  write("google-glyph.json", cases)
}

// ---------------------------------------------------------------------- run

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })

const realFetch = globalThis.fetch
globalThis.fetch = fakeFetch
try {
  hashes()
  requests()
  claims()
  names()
  claimants()
  verifying()
  devices()
  libraries()
  await catalogs()
  await glyphs()
} finally {
  globalThis.fetch = realFetch
  mock.timers.reset()
  mock.restoreAll()
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
}

for (const [name, count] of written) console.log(`${String(count).padStart(6)}  ${name}`)
console.log(`${written.reduce((sum, entry) => sum + entry[1], 0)} cases in ${written.length} files`)
