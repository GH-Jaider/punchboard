// Signs Punchboard.app with one self-made certificate that never changes.
//
// It does not remove macOS's "unidentified developer" step (that needs an
// Apple Developer ID), but every build carries the same identity, and the
// app's designated requirement names that certificate, so macOS treats an
// update as the same app and keeps its permissions (Accessibility, for key
// combinations) instead of silently dropping them.
//
// Signing uses rcodesign (cargo install apple-codesign), which signs straight
// from the certificate file: no keychain, no trust settings, no password
// dialogs, and the same on a CI machine.
//
//   ~/.punchboard-signing/certificate.p12 (+ certificate-password), never committed.
//   In CI, MAC_CERT_P12 (base64) and MAC_CERT_PASSWORD recreate them.
//
//   node scripts/mac-signing.mjs setup           create the certificate once
//   node scripts/mac-signing.mjs sign <App.app>  sign an app bundle
//   node scripts/mac-signing.mjs export          print the secrets for CI
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const IDENTITY_NAME = "Punchboard Self-Signed"
const BUNDLE_ID = "app.punchboard.desktop"
const DIR = process.env.PUNCHBOARD_SIGNING_DIR ?? path.join(os.homedir(), ".punchboard-signing")
const P12 = path.join(DIR, "certificate.p12")
const P12_PASSWORD_FILE = path.join(DIR, "certificate-password")
const CERT_PEM = path.join(DIR, "certificate.pem")

const run = (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

function rcodesign() {
  const local = path.join(os.homedir(), ".cargo", "bin", "rcodesign")
  return fs.existsSync(local) ? local : "rcodesign"
}

function setup() {
  if (fs.existsSync(P12) && fs.existsSync(CERT_PEM)) {
    console.log(`Signing is already set up in ${DIR}`)
    return
  }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  if (process.env.MAC_CERT_P12 && process.env.MAC_CERT_PASSWORD) {
    // CI: the same certificate, handed over as secrets.
    fs.writeFileSync(P12, Buffer.from(process.env.MAC_CERT_P12, "base64"), { mode: 0o600 })
    fs.writeFileSync(P12_PASSWORD_FILE, process.env.MAC_CERT_PASSWORD, { mode: 0o600 })
    const read = ["pkcs12", "-in", P12, "-nokeys", "-clcerts", "-passin", `pass:${process.env.MAC_CERT_PASSWORD}`, "-out", CERT_PEM]
    // OpenSSL 3 needs -legacy for this p12; LibreSSL (macOS's own) has no such flag.
    try { run("openssl", [...read, "-legacy"]) } catch { run("openssl", read) }
    console.log("Signing certificate restored from CI secrets.")
    return
  }
  if (process.env.CI) {
    // A new certificate would sign this build as a different app: every
    // user's Accessibility permission would silently stop applying after the
    // update. Missing or misnamed secrets must stop the release instead.
    throw new Error("MAC_CERT_P12 and MAC_CERT_PASSWORD are not set. In CI the release must be signed with the existing certificate (node scripts/mac-signing.mjs export prints them); refusing to create a new one.")
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-cert-"))
  const key = path.join(tmp, "key.pem")
  const password = crypto.randomBytes(24).toString("hex")
  run("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "7300", "-nodes",
    "-keyout", key, "-out", CERT_PEM, "-subj", `/CN=${IDENTITY_NAME}`,
    "-addext", "basicConstraints=critical,CA:false",
    "-addext", "keyUsage=critical,digitalSignature",
    "-addext", "extendedKeyUsage=critical,codeSigning"])
  run("openssl", ["pkcs12", "-export", "-legacy", "-inkey", key, "-in", CERT_PEM, "-name", IDENTITY_NAME, "-out", P12, "-passout", `pass:${password}`])
  fs.chmodSync(P12, 0o600)
  fs.writeFileSync(P12_PASSWORD_FILE, password, { mode: 0o600 })
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`Created the signing certificate "${IDENTITY_NAME}" in ${DIR}. Keep that folder: every future build must be signed with it.`)
}

export const signingAvailable = () => fs.existsSync(P12) && fs.existsSync(P12_PASSWORD_FILE) && fs.existsSync(CERT_PEM)

/** "Signed by this certificate and called Punchboard", in the binary form
    macOS stores. This, not the per-build hash, is what permissions follow. */
function designatedRequirement(tmp) {
  const der = execFileSync("openssl", ["x509", "-in", CERT_PEM, "-outform", "DER"])
  const leaf = crypto.createHash("sha1").update(der).digest("hex").toUpperCase()
  const out = path.join(tmp, "requirement.bin")
  // One requirement, not a "designated =>" set: rcodesign files it as the designated one.
  run("csreq", ["-r", `=identifier "${BUNDLE_ID}" and certificate leaf = H"${leaf}"`, "-b", out])
  return out
}

export function signApp(app) {
  if (!signingAvailable()) throw new Error(`No signing certificate in ${DIR}; run: node scripts/mac-signing.mjs setup`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-sign-"))
  try {
    execFileSync(rcodesign(), [
      "sign",
      "--p12-file", P12,
      "--p12-password-file", P12_PASSWORD_FILE,
      "--code-requirements-path", designatedRequirement(tmp),
      app
    ], { stdio: ["ignore", "pipe", "inherit"] })
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  run("codesign", ["--verify", "--deep", "--strict", app])
  return execFileSync("codesign", ["--display", "--requirements", "-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n").pop()
}

function exportSecrets() {
  if (!fs.existsSync(P12)) throw new Error("Nothing to export; run setup first.")
  console.log(`MAC_CERT_P12=${fs.readFileSync(P12).toString("base64")}`)
  console.log(`MAC_CERT_PASSWORD=${fs.readFileSync(P12_PASSWORD_FILE, "utf8")}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2]
  if (command === "setup") setup()
  else if (command === "sign") console.log(signApp(process.argv[3]))
  else if (command === "export") exportSecrets()
  else console.log("usage: node scripts/mac-signing.mjs setup | sign <App.app> | export")
}
