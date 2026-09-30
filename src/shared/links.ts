// Links people type, turned into addresses browsers open. "twitch.tv/x" and
// "192.168.1.7:8787" are fine; https:// is added when it is missing. Only
// http and https ever come out, so a link can never run anything else.

/** The address to open for a typed link, or null when it is not a web address. */
export function webAddress(value: string | undefined | null): string | null {
  const text = (value ?? "").trim()
  if (!text || /\s/.test(text)) return null
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    // A host is the least a link needs; "https://" alone parses but goes nowhere.
    if (!url.hostname) return null
    return url.href
  } catch {
    return null
  }
}
