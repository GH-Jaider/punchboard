// Links people type, turned into addresses browsers open. "twitch.tv/x" and
// "192.168.1.7:8787" are fine; https:// is added when it is missing (http://
// for an address on the home network). Only http and https ever come out, so
// a link can never run anything else.

/** Schemes whose addresses are digits ("tel:123"), which would otherwise read as a host and a port. */
const NUMBER_SCHEMES = ["tel", "sms", "mms", "fax", "callto", "facetime", "facetime-audio", "sip", "sips"]

/** The address to open for a typed link, or null when it is not a web address. */
export function webAddress(value: string | undefined | null): string | null {
  const text = (value ?? "").trim()
  if (!text || /\s/.test(text)) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  // Another scheme (file://, ftp://) is refused outright, not rewritten.
  if (hasScheme && !/^https?:\/\//i.test(text)) return null
  if (!hasScheme) {
    // "mailto:a@b.com" and "javascript:…" have no // either. Only a host and
    // a port ("nas.local:8080", "localhost:8787/x") may look like that.
    const colon = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(text)
    if (colon) {
      const port = /^\d{1,5}(?:[/?#].*)?$/.test(colon[2]!)
      if (!port || NUMBER_SCHEMES.indexOf(colon[1]!.toLowerCase()) !== -1) return null
    }
  }
  try {
    const url = new URL(hasScheme ? text : `https://${text}`)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    // A host is the least a link needs; "https://" alone parses but goes nowhere.
    if (!url.hostname) return null
    // Nothing on a home network speaks https: a bare LAN address gets http.
    if (!hasScheme && isLocalHost(url.hostname)) url.protocol = "http:"
    return url.href
  } catch {
    return null
  }
}

/** localhost, a name ending in .local, a single-label name ("nas"), or an IP address. */
const isLocalHost = (hostname: string): boolean =>
  hostname.indexOf(".") === -1 || /\.local$/i.test(hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^\[/.test(hostname)
