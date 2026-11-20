// Finds English left behind in the code: string literals in src/client and
// src/shared (TypeScript) and in the companion, server/src (Rust), that read
// like interface text, and text in the HTML pages that has no data-i18n key.
// Practical, not perfect: it looks for sentences ("Choose the OBS scene
// first.") and for single words in the places interface text goes
// (textContent, labels, toasts, titles). In the companion, what a person is
// shown is a locale key handed to say(); its tests (#[cfg(test)]) are not
// read. What it rightly ignores is listed in ALLOWED below, with the reason.
//   node tests/i18n-literals.mjs [folder or file…]   lists what it finds
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// fileURLToPath, not .pathname: on Windows the pathname is "/D:/…", which
// path.resolve turns into "D:\D:\…".
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** Calls whose text is for the terminal or companion.log, which stay English. */
const LOG_CALLS = /(?:^|[^\w.])(?:log|options\.log|console\.(?:log|error|warn|info)|note|warn|logLine)\s*\($/

/** The companion's sources (Rust). */
const COMPANION = "server/src"

/** Literals that look like text but are not interface text, by file. Each
    entry is [file (relative, "*" for any), pattern, why]. */
export const ALLOWED = [
  ["*", /^Punchboard$|^OBS$|^Ko-fi$|^Spotify$|^Music$/, "product and app names stay as they are"],
  ["*", /^(\{x\}\s*[·—|]\s*)+\{x\}$/, "separators joining texts that are already translated"],
  ["*", /^#[0-9a-f]{6}$/i, "a colour value, such as the accent's hex code"],
  ["src/client/common/dom.ts", /^Missing #/, "a programming error: the page lacks an element the code needs"],
  ["src/client/designer/state.ts", /^The deck has not loaded yet\.$/, "a programming error, never shown: nothing renders before the deck loads"],
  [`${COMPANION}/i18n.rs`, /^Could not read the languages folder |^Skipped the language file |^No text for "/, "log lines: warn_once() writes each to the log, once"],
  [`${COMPANION}/obs/link.rs`, /^OBS did not answer \{x\} in time; reconnecting\.$|^OBS closed the connection; will reconnect when it is back\.$/, "log lines: drop_client() passes them to the log"],
  [`${COMPANION}/store.rs`, /could not be read \(\{x\}\)\. It was kept as|^E(NOENT|ACCES): /, "only reaches the log, when the decks or settings file is loaded"],
  [`${COMPANION}/pointer/mod.rs`, /^Trackpad: not /, "the log's half of a problem: the deck is told through a server.trackpad.* or server.pointer.* key"],
  [`${COMPANION}/server.rs`, /^Space limit exceeded$|^Max payload size exceeded$/, "the socket library's own wording, matched, and a log line"],
  [`${COMPANION}/server.rs`, /^Port \{x\} is not a port|^The server stopped\.$/, "start-up failures, printed in the terminal, which stays English like the log"],
  [`${COMPANION}/port.rs`, /^Port \{x\} is not a port/, "a start-up failure, printed in the terminal, which stays English like the log"],
  // The next six are reasons, not sentences of their own: each is shown in
  // parentheses inside a translated message ("Could not set the volume.
  // ({reason})") and written to the log, as the system's own error text is.
  [`${COMPANION}/audio/system_linux.rs`, /^The sound server |^No sound server was found/, "a technical reason from the sound server's side, shown inside a translated message"],
  [`${COMPANION}/audio/system_mac.rs`, /Core Audio error|^There is no (default )?output device|^The output's volume could not be|^Command failed: osascript/, "a technical reason from Core Audio or osascript, shown inside a translated message"],
  [`${COMPANION}/keys/linux.rs`, /^The X server has no XTEST extension\.$|^X11 has no keycode for key \{x\}\.$/, "a technical reason from X11, shown inside a translated message"],
  [`${COMPANION}/keys/mac.rs`, /music key event/, "a technical reason from Quartz, shown inside a translated message"],
  [`${COMPANION}/obs/client.rs`, /^OBS answered without a request status$/, "a broken answer from OBS, shown as OBS's own errors are"],
  [`${COMPANION}/obs/state.rs`, /^OBS sent no \{x\}$/, "a broken answer from OBS, shown as OBS's own errors are"],
  ["*", /^(\{x\}\s*)+$/, "nothing but values: a protocol line or a join, no words of its own"],
  ["src/shared/touchpad/trace.ts", /.*/, "debug traces for the touchpad tests"],
  ["src/shared/actions.ts", /^(OBS|This computer|On the deck|Other)$/, "ActionGroup ids; people see them through actionGroupLabel()"],
  ["src/client/deck/trackpad.ts", /^\{x\} · \{x\}\{x\}$|^idle · none$/, "the touchpad engine's state, shown only in #trackpad-debug"]
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

/** Whether a literal reads as interface text in its place. `spot` says where
    a single word is interface text (the TypeScript's places by default). */
function looksLikeText(text, before, spot = TEXT_SPOT) {
  // "${name} is not open" reads as text too: a value stands in for a word.
  const plain = text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\{x\}/g, "Xx").trim()
  if (!plain || plain.indexOf("\n") !== -1 && plain.split("\n").length > 3) return false
  // A key, a class list, a URL, a path, a selector, a CSS value.
  if (/^[a-z0-9_.:-]+$/.test(plain) || /^(https?:|\/|#|\.|\[)/.test(plain)) return false
  if (SENTENCE.test(plain) && (plain.split(/\s+/).length >= 3 || ENDS_LIKE_TEXT.test(plain) || spot.test(before))) return true
  // One capitalised word where text goes ("Pair", "Saved").
  return spot.test(before) && /^[A-Z][a-z]{2,}/.test(plain) && !/^[A-Z][a-zA-Z]+[A-Z]/.test(plain)
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

// ------------------------------------------------------------------ Rust

/** Calls whose text is for the terminal or companion.log, which stay English. */
const RUST_LOG_CALLS = /(?:(?:^|[^\w])(?:log|note|warn|log_line|print_line)|\.log\)?|\b(?:println|eprintln|print|eprint)!)\s*\($/
/** Calls whose text is for whoever reads the code: it is shown to nobody
    unless the program is wrong (and then it is in the log, in English). */
const RUST_PROGRAMMER_CALLS = /(?:\b(?:panic|unreachable|unimplemented|todo|assert|assert_eq|assert_ne|debug_assert|debug_assert_eq)!|\.expect(?:_err)?)\s*\($/
/** Places a single word would be interface text in the companion: none.
    What a person reads there is always a sentence. */
const RUST_TEXT_SPOT = /(?!)/

/** Every string literal in a Rust file outside its tests, with where it
    starts. A format string's {…} parts become {x}. */
export function rustLiterals(source) {
  const found = []
  const n = source.length
  let i = 0
  let depth = 0
  // #[cfg(test)] was just read: the item it heads (a module, a function) is test code.
  let testPending = false
  // The brace depth outside the test item being skipped, or -1.
  let testDepth = -1
  const ident = /[A-Za-z0-9_]/
  const formatParts = (text) => text.replace(/\{\{/g, "\u0001").replace(/\}\}/g, "\u0002").replace(/\{[^{}]*\}/g, "{x}").replace(/\u0001/g, "{").replace(/\u0002/g, "}")
  const push = (start, text) => { if (testDepth === -1 && !testPending) found.push({ start, text: formatParts(text) }) }
  /** The end of the plain string that opens at `at` (its closing quote), and its text. */
  const readString = (at) => {
    let j = at + 1
    let text = ""
    while (j < n && source[j] !== '"') {
      if (source[j] === "\\") {
        const next = source[j + 1]
        if (next === "\n" || next === "\r") {
          // A line ending after a backslash: it and the next line's indent are not in the text.
          j += 1
          while (j < n && /\s/.test(source[j])) j += 1
          continue
        }
        if (next === "u" && source[j + 2] === "{") {
          const close = source.indexOf("}", j)
          text += String.fromCodePoint(parseInt(source.slice(j + 3, close), 16) || 0x20)
          j = close + 1
          continue
        }
        text += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next === "0" ? "\0" : next ?? ""
        j += 2
        continue
      }
      text += source[j]
      j += 1
    }
    return { end: j, text }
  }
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1
      continue
    }
    if (c === "/" && next === "*") {
      // Block comments nest.
      let open = 1
      i += 2
      while (i < n && open > 0) {
        if (source[i] === "/" && source[i + 1] === "*") { open += 1; i += 2 } else if (source[i] === "*" && source[i + 1] === "/") { open -= 1; i += 2 } else i += 1
      }
      continue
    }
    if (c === "#" && (next === "[" || (next === "!" && source[i + 2] === "["))) {
      // An attribute: its strings (#[ignore = "…"], #[cfg(target_os = "…")]) are not text.
      let j = source.indexOf("[", i) + 1
      let open = 1
      const start = j
      while (j < n && open > 0) {
        if (source[j] === '"') j = readString(j).end
        else if (source[j] === "[") open += 1
        else if (source[j] === "]") open -= 1
        j += 1
      }
      if (testDepth === -1 && /^cfg\((?:test|all\(test\b|any\(test\b)/.test(source.slice(start, j - 1).replace(/\s+/g, ""))) testPending = true
      i = j
      continue
    }
    if (c === "'") {
      // A character ('a', '\n', '\u{1f39b}') or a lifetime ('a, 'static).
      if (next === "\\") {
        i = source.indexOf("'", i + 3) + 1 || n
        continue
      }
      const close = source.indexOf("'", i + 1)
      if (close !== -1 && close - i <= 3 && [...source.slice(i + 1, close)].length === 1) { i = close + 1; continue }
      i += 1
      continue
    }
    if (c === "r" && (next === '"' || next === "#") && !(i > 0 && ident.test(source[i - 1]) && source[i - 1] !== "b")) {
      // A raw string: r"…", r#"…"#.
      let j = i + 1
      let hashes = 0
      while (source[j] === "#") { hashes += 1; j += 1 }
      if (source[j] === '"') {
        const closing = `"${"#".repeat(hashes)}`
        const end = source.indexOf(closing, j + 1)
        push(i, source.slice(j + 1, end === -1 ? n : end))
        i = end === -1 ? n : end + closing.length
        continue
      }
    }
    if (c === '"') {
      const read = readString(i)
      push(i, read.text)
      i = read.end + 1
      continue
    }
    if (c === "{") {
      if (testPending) { testPending = false; testDepth = depth }
      depth += 1
    } else if (c === "}") {
      depth -= 1
      if (depth === testDepth) testDepth = -1
    } else if (c === ";" && testPending) {
      // #[cfg(test)] on a line of its own (mod testing; use …;): nothing to skip here.
      testPending = false
    }
    i += 1
  }
  return found
}

/** The calls a literal sits in, innermost first: what precedes each unclosed "(". */
function rustCallsBefore(source, start) {
  const calls = []
  let depth = 0
  for (let i = start - 1; i >= 0 && start - i < 4000; i -= 1) {
    const c = source[i]
    if (c === ")" || c === "]" || c === "}") depth += 1
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) { depth -= 1; continue }
      // A block or a list ends the search: the statement starts there.
      if (c === "{") break
      if (c === "(") calls.push(source.slice(Math.max(0, i - 40), i + 1))
    } else if (c === ";" && depth === 0) break
  }
  return calls
}

export function scanRust(file, source) {
  const hits = []
  for (const literal of rustLiterals(source)) {
    const before = source.slice(Math.max(0, literal.start - 80), literal.start)
    if (!looksLikeText(literal.text, before, RUST_TEXT_SPOT)) continue
    if (rustCallsBefore(source, literal.start).some((call) => RUST_LOG_CALLS.test(call) || RUST_PROGRAMMER_CALLS.test(call))) continue
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
  const pattern = /<!--[\s\S]*?-->|<![^>]*>|<(\/?)([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g
  let match
  const lineOf = (index) => html.slice(0, index).split("\n").length
  while ((match = pattern.exec(html))) {
    if (match[0].startsWith("<!")) continue
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

const SOURCE_FOLDERS = ["src/client", "src/shared", COMPANION]
const PAGES = ["public/deck.html", "public/designer.html", "public/pair.html"]

/** The modules a Rust folder only builds for its tests (#[cfg(test)] mod testing;). */
function testModules(folder) {
  const names = new Set()
  for (const file of ["mod.rs", "lib.rs", "main.rs"]) {
    const full = path.join(ROOT, folder, file)
    if (!fs.existsSync(full)) continue
    for (const match of fs.readFileSync(full, "utf8").matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+(\w+)\s*;/g)) names.add(match[1])
  }
  return names
}

function walk(folder) {
  const out = []
  const testOnly = testModules(folder)
  for (const entry of fs.readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
    // Always "/": ALLOWED names files that way, and Windows would give "\\".
    const relative = `${folder}/${entry.name}`
    if (entry.isDirectory()) { if (!testOnly.has(entry.name)) out.push(...walk(relative)) } else if (/\.ts$/.test(entry.name)) out.push(relative)
    else if (/\.rs$/.test(entry.name) && !testOnly.has(entry.name.slice(0, -3))) out.push(relative)
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
      hits.push(...(file.endsWith(".html") ? scanHtml(file, text) : file.endsWith(".rs") ? scanRust(file, text) : scanSource(file, text)))
    }
  }
  return hits
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const targets = process.argv.slice(2)
  const hits = scan(targets.length ? targets : undefined)
  for (const hit of hits) console.log(`${hit.file}:${hit.line}  ${JSON.stringify(hit.text)}`)
  console.log(`${hits.length} left`)
}
