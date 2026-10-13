// Finds English left behind in the code: string literals in src/client,
// src/shared and src/server that read like interface text, and text in the
// HTML pages that has no data-i18n key. Practical, not perfect: it looks
// for sentences ("Choose the OBS scene first.") and for single words in
// the places interface text goes (textContent, labels, toasts, titles).
// What it rightly ignores is listed in ALLOWED below, with the reason.
//   node tests/i18n-literals.mjs [folder or file…]   lists what it finds
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

/** Calls whose text is for the terminal or companion.log, which stay English. */
const LOG_CALLS = /(?:^|[^\w.])(?:log|options\.log|console\.(?:log|error|warn|info)|note|warn|logLine)\s*\($/

/** Literals that look like text but are not interface text, by file. Each
    entry is [file (relative, "*" for any), pattern, why]. */
export const ALLOWED = [
  ["*", /^Punchboard$|^OBS$|^Ko-fi$|^Spotify$|^Music$/, "product and app names stay as they are"],
  ["src/client/common/dom.ts", /^Missing #/, "a programming error: the page lacks an element the code needs"],
  ["src/client/designer/state.ts", /^The deck has not loaded yet\.$/, "a programming error, never shown: nothing renders before the deck loads"],
  ["src/server/main.ts", /^\\n {2}Punchboard is ready|^ {2}(Control Center|Pair a device|Your data|Scan with|Punchboard is already|Opening it|Ports |Close one|Port |Paired tablets|Punchboard stopped|Punchboard could not)/, "the terminal banner at start-up stays English, like the log"],
  ["src/server/main.ts", /^HTTP\/1\.1 /, "a raw HTTP status line"],
  ["src/server/main.ts", /^(iPad|iPhone|Android phone|Android tablet|Windows browser|Browser)$/, "never: deviceName() is translated; kept here only if a test lists it"],
  ["src/server/keys.ts", /System Events|key code|ArgumentException|not allowed to post events|Add-Type/, "AppleScript, JXA and C# sent to the system, not shown"],
  ["src/server/pointer.ts", /Add-Type|\[PunchboardPointer\]|Exception/, "the PowerShell helper's own code"],
  ["src/server/player.ts", /Add-Type|PresentationCore/, "the PowerShell player's own code"],
  ["src/server/win-volume.ts", /Add-Type|Exception/, "the PowerShell volume helper's own code"],
  ["src/server/launch.ts", /Add-Type|Start Menu/, "the PowerShell launcher's own code and a Windows folder name"],
  ["src/server/apps.ts", /Start Menu|Programs/, "Windows folder names"],
  ["src/server/google-icons.ts", /^HTTP \{x\}$/, "an HTTP status, wrapped in a translated message"],
  ["src/server/actions.ts", /^Unknown action \{x\}$/, "a programming error: every action type is handled"],
  ["src/server/obs-config.ts", /Application Support/, "a folder name"],
  ["src/server/powershell.ts", /At line|CategoryInfo/, "PowerShell's own wording, matched to be removed"],
  ["src/shared/touchpad/trace.ts", /.*/, "debug traces for the touchpad tests"]
]

const WORD = "[A-Za-zÀ-ɏ'’]"
const SENTENCE = new RegExp(`^[^A-Za-z]*[A-Z]${WORD}*[^\\n]*\\s${WORD}{2,}`)
const ENDS_LIKE_TEXT = /[.!?…:]$/
/** Places a single word is interface text: el(tag, class, "Text"), textContent = "Text", label: "Text"… */
const TEXT_SPOT = /(?:textContent\s*=|innerText\s*=|label\s*:|hint\s*:|title\s*:|placeholder\s*=|title\s*=|toast\(|new Option\(|setAttribute\(\s*["'](?:aria-label|title|placeholder|alt)["']\s*,|el\(\s*["'][a-z0-9]+["']\s*,\s*[^,()]*,)\s*$/

function isAllowed(file, text) {
  return ALLOWED.some((entry) => (entry[0] === "*" || entry[0] === file) && entry[1].test(text))
}

/** Every string and template literal in a TypeScript file, with where it starts. */
export function literals(source) {
  const found = []
  let i = 0
  let lastSignificant = ""
  const n = source.length
  const regexAllowedAfter = /[(,=:[!&|?{};+\-*%<>~^]$|(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1
      continue
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let text = ""
      while (j < n && source[j] !== c) {
        if (source[j] === "\\") { text += source[j] + (source[j + 1] ?? ""); j += 2; continue }
        if (source[j] === "\n") break
        text += source[j]
        j += 1
      }
      found.push({ start: i, text: unescape(text) })
      i = j + 1
      lastSignificant = "x"
      continue
    }
    if (c === "`") {
      // A template: its ${…} parts become {x}, and literals inside them are read too.
      let j = i + 1
      let text = ""
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\") { text += source[j] + (source[j + 1] ?? ""); j += 2; continue }
        if (source[j] === "$" && source[j + 1] === "{") {
          let depth = 1
          let k = j + 2
          while (k < n && depth > 0) {
            if (source[k] === "{") depth += 1
            else if (source[k] === "}") depth -= 1
            else if (source[k] === '"' || source[k] === "'" || source[k] === "`") {
              const inner = literals(source.slice(k, findClose(source, k) + 1))
              for (const literal of inner) found.push({ start: k + literal.start, text: literal.text })
              k = findClose(source, k)
            }
            k += 1
          }
          text += "{x}"
          j = k
          continue
        }
        text += source[j]
        j += 1
      }
      found.push({ start: i, text: unescape(text), template: true })
      i = j + 1
      lastSignificant = "x"
      continue
    }
    if (c === "/") {
      const before = source.slice(Math.max(0, i - 12), i).replace(/\s+$/, "")
      if (!before || regexAllowedAfter.test(before)) {
        // A regular expression: skipped whole, classes and all.
        let j = i + 1
        let inClass = false
        while (j < n && source[j] !== "\n") {
          if (source[j] === "\\") { j += 2; continue }
          if (source[j] === "[") inClass = true
          else if (source[j] === "]") inClass = false
          else if (source[j] === "/" && !inClass) break
          j += 1
        }
        i = j + 1
        continue
      }
    }
    if (!/\s/.test(c)) lastSignificant = c
    i += 1
  }
  void lastSignificant
  return found
}

function findClose(source, start) {
  const quote = source[start]
  let j = start + 1
  while (j < source.length && source[j] !== quote) {
    if (source[j] === "\\") j += 1
    j += 1
  }
  return j
}

const unescape = (text) => text.replace(/\\n/g, "\n").replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\(.)/g, "$1")

/** Whether a literal reads as interface text in its place. */
function looksLikeText(text, before) {
  // "${name} is not open" reads as text too: a value stands in for a word.
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\{x\}/g, "Xx").trim()
  if (!plain || plain.indexOf("\n") !== -1 && plain.split("\n").length > 3) return false
  // A key, a class list, a URL, a path, a selector, a CSS value.
  if (/^[a-z0-9_.:-]+$/.test(plain) || /^(https?:|\/|#|\.|\[)/.test(plain)) return false
  if (SENTENCE.test(plain) && (plain.split(/\s+/).length >= 3 || ENDS_LIKE_TEXT.test(plain) || TEXT_SPOT.test(before))) return true
  // One capitalised word where text goes ("Pair", "Saved").
  return TEXT_SPOT.test(before) && /^[A-Z][a-z]{2,}/.test(plain) && !/^[A-Z][a-zA-Z]+[A-Z]/.test(plain)
}

/** The call a literal sits in, read backwards to its unclosed "(". */
function callBefore(source, start) {
  let depth = 0
  for (let i = start - 1; i >= 0 && start - i < 4000; i -= 1) {
    const c = source[i]
    if (c === ")" || c === "]" || c === "}") depth += 1
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) return c === "(" ? source.slice(Math.max(0, i - 40), i + 1) : ""
      depth -= 1
    } else if (c === "\n" && depth === 0 && /[;{}]\s*$/.test(source.slice(Math.max(0, i - 3), i))) return ""
  }
  return ""
}

export function scanSource(file, source) {
  const hits = []
  for (const literal of literals(source)) {
    const before = source.slice(Math.max(0, literal.start - 80), literal.start)
    if (!looksLikeText(literal.text, before)) continue
    if (LOG_CALLS.test(callBefore(source, literal.start))) continue
    if (isAllowed(file, literal.text)) continue
    const line = source.slice(0, literal.start).split("\n").length
    hits.push({ file, line, text: literal.text })
  }
  return hits
}

// ------------------------------------------------------------------ HTML

const VOID = new Set(["meta", "link", "input", "img", "br", "hr", "source", "area", "base", "col", "embed", "track", "wbr"])
const SKIP_CONTENT = new Set(["script", "style", "svg"])
const ATTRS = ["placeholder", "title", "aria-label", "alt"]

/** Text and attributes in a page that have no data-i18n key. */
export function scanHtml(file, html) {
  const hits = []
  const stack = []
  const pattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g
  let match
  const lineOf = (index) => html.slice(0, index).split("\n").length
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith("<!--")) continue
    if (match[4] !== undefined) {
      const text = match[4].replace(/&[a-z#0-9]+;/g, " ").trim()
      if (!/[A-Za-z]{2,}/.test(text)) continue
      if (stack.some((entry) => SKIP_CONTENT.has(entry.tag) || entry.rich)) continue
      const parent = stack[stack.length - 1]
      if (parent && parent.keyed) continue
      if (isAllowed(file, text)) continue
      hits.push({ file, line: lineOf(match.index), text })
      continue
    }
    const closing = match[1] === "/"
    const tag = match[2].toLowerCase()
    const attrs = match[3]
    if (closing) {
      const at = stack.map((entry) => entry.tag).lastIndexOf(tag)
      if (at !== -1) stack.length = at
      continue
    }
    if (!stack.some((entry) => SKIP_CONTENT.has(entry.tag))) {
      for (const name of ATTRS) {
        const value = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
        if (value && /[A-Za-z]{2,}/.test(value[1]) && !new RegExp(`data-i18n-${name}=`).test(attrs) && !isAllowed(file, value[1])) {
          hits.push({ file, line: lineOf(match.index), text: `${name}="${value[1]}"` })
        }
      }
    }
    if (VOID.has(tag) || attrs.trim().endsWith("/")) continue
    stack.push({ tag, keyed: /\sdata-i18n=/.test(attrs), rich: /\sdata-i18n-html=/.test(attrs) })
  }
  return hits
}

// ------------------------------------------------------------------ files

const SOURCE_FOLDERS = ["src/client", "src/shared", "src/server"]
const PAGES = ["public/deck.html", "public/designer.html", "public/pair.html"]

function walk(folder) {
  const out = []
  for (const entry of fs.readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
    const relative = path.join(folder, entry.name)
    if (entry.isDirectory()) out.push(...walk(relative))
    else if (/\.ts$/.test(entry.name)) out.push(relative)
  }
  return out
}

/** Everything left to translate under the given folders or files (all of it by default). */
export function scan(targets = SOURCE_FOLDERS.concat(PAGES)) {
  const hits = []
  for (const target of targets) {
    const full = path.join(ROOT, target)
    const files = fs.statSync(full).isDirectory() ? walk(target) : [target]
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8")
      hits.push(...(file.endsWith(".html") ? scanHtml(file, text) : scanSource(file, text)))
    }
  }
  return hits
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const targets = process.argv.slice(2)
  const hits = scan(targets.length ? targets : undefined)
  for (const hit of hits) console.log(`${hit.file}:${hit.line}  ${JSON.stringify(hit.text)}`)
  console.log(`${hits.length} left`)
}
