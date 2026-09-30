// Links people type, turned into addresses browsers open. "twitch.tv/x" and
// "192.168.1.7:8787" are fine; https:// is added when it is missing. Only
// http and https ever come out, so a link can never run anything else.

/** The address to open for a typed link, or null when it is not a web address. */
export function webAddress(value: string | undefined | null): string | null {
  const text = (value ?? "").trim()
  if (!text || /\s/.test(text)) return null
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  // Another scheme (file://, ftp://) is refused outright, not rewritten.
  if (hasScheme && !/^https?:\/\//i.test(text)) return null
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

const isLocalHost = (hostname: string): boolean =>
  hostname === "localhost" || /\.local$/i.test(hostname) || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^\[/.test(hostname)
