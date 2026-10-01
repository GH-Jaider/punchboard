// The scripts Punchboard writes for Windows and macOS, checked as text on
// any system: every key has its physical scan code, values reach PowerShell
// quoted so they come back as themselves (typographic quotes included), and
// what PowerShell prints on failure reads as a sentence. Nothing here runs
// a script, presses a key or starts an app; tests/windows.test.mjs runs the
// scripts themselves, dry, on Windows.
//   node tests/scripts.test.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isAppName, urlShortcutStartsApp, windowsApps } from "../src/server/apps.ts"
import { MAC_CODES, SCAN_KEYS_TYPE, WINDOWS_KEY_HELPER, WIN_MODIFIER_SCAN_CODES, WIN_SCAN_CODES, macScript, windowsInputs, windowsKeyLine, windowsMediaLine } from "../src/server/keys.ts"
import { GENERIC_HOSTS, windowsLaunchScript } from "../src/server/launch.ts"
import { cleanPowerShellError, powershellArgs, powershellPath, psQuote, wrapScript } from "../src/server/powershell.ts"
import { KEY_NAMES, MODIFIERS, keyPlatform, parseCombo, unsendableReason } from "../src/shared/keys.ts"
import { checker } from "./companion.mjs"

const { check, tally } = checker()

// ------------------------------------------------- a small PowerShell lexer

// PowerShell's quote characters: ' and ‘ ’ ‚ ‛ are all single quotes, " and
// “ ” „ all double quotes.
const SINGLE = new Set(["'", "\u2018", "\u2019", "\u201a", "\u201b"])
const DOUBLE = new Set(["\"", "\u201c", "\u201d", "\u201e"])

/** Reads the single-quoted literal starting at `at` the way PowerShell's
    tokenizer does: a quote followed by another quote is one quote (the
    second), a lone quote ends the string. */
function readSingle(text, at) {
  let value = ""
  let i = at + 1
  while (i < text.length) {
    const c = text[i]
    if (SINGLE.has(c)) {
      if (SINGLE.has(text[i + 1])) { value += text[i + 1]; i += 2; continue }
      return { value, end: i + 1 }
    }
    value += c
    i += 1
  }
  return null
}

function readDouble(text, at) {
  let i = at + 1
  while (i < text.length) {
    const c = text[i]
    if (c === "`") { i += 2; continue }
    if (DOUBLE.has(c)) {
      if (DOUBLE.has(text[i + 1])) { i += 2; continue }
      return { end: i + 1 }
    }
    i += 1
  }
  return null
}

/** The single-quoted strings in a script and whether every string closes
    and every bracket outside strings pairs up. */
function lex(script) {
  const strings = []
  const stack = []
  const pairs = { ")": "(", "]": "[", "}": "{" }
  for (let i = 0; i < script.length;) {
    const c = script[i]
    if (SINGLE.has(c)) {
      const read = readSingle(script, i)
      if (!read) return { ok: false, why: `unclosed '...' at ${i}`, strings }
      strings.push(read.value)
      i = read.end
      continue
    }
    if (DOUBLE.has(c)) {
      const read = readDouble(script, i)
      if (!read) return { ok: false, why: `unclosed "..." at ${i}`, strings }
      i = read.end
      continue
    }
    if (c === "#" && (i === 0 || /\s/.test(script[i - 1]))) {
      const end = script.indexOf("\n", i)
      i = end === -1 ? script.length : end
      continue
    }
    if ("([{".includes(c)) stack.push(c)
    if (")]}".includes(c) && stack.pop() !== pairs[c]) return { ok: false, why: `unpaired ${c} at ${i}`, strings }
    i += 1
  }
  return stack.length ? { ok: false, why: `unclosed ${stack.join("")}`, strings } : { ok: true, strings }
}

// ---------------------------------------------------------------- psQuote

const tricky = [
  "C:\\Users\\Ann\\Start Menu\\Bob’s app.lnk",
  "‘quoted’ ‚low‛ 'plain'",
  "''", "’", "a'’‘b", "C:\\[brackets]\\$dollar `tick` \"double\" “curly” „low”.lnk", "", "Café ünïcode 日本"
]
for (const text of tricky) {
  const literal = psQuote(text)
  const read = readSingle(literal, 0)
  check(`psQuote round-trips ${JSON.stringify(text)}`, read && read.value === text && read.end === literal.length, `${literal} read as ${JSON.stringify(read)}`)
}
check("psQuote doubles every typographic single quote", psQuote("‘’‚‛'") === "'‘‘’’‚‚‛‛'''", psQuote("‘’‚‛'"))

// ----------------------------------------------------- powershell helpers

check("powershell.exe is found under SystemRoot", powershellPath({ SystemRoot: "C:\\Windows" }, () => true) === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", powershellPath({ SystemRoot: "C:\\Windows" }, () => true))
check("windir works when SystemRoot is missing", powershellPath({ windir: "D:\\Win" }, () => true) === "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "")
check("Falls back to the bare name when the file is not there", powershellPath({ SystemRoot: "C:\\Windows" }, () => false) === "powershell" && powershellPath({}, () => true) === "powershell", "")

const wrapped = wrapScript("Write-Output 1")
check("Scripts stop on errors and show no progress", /\$ErrorActionPreference = 'Stop'/.test(wrapped) && /\$ProgressPreference = 'SilentlyContinue'/.test(wrapped) && /exit 1/.test(wrapped), wrapped)
check("The wrapper parses", lex(wrapped).ok, lex(wrapped).why)
const args = powershellArgs("Write-Output 'é’'")
check("Scripts travel encoded, as UTF-16", args[args.length - 2] === "-EncodedCommand" && Buffer.from(args[args.length - 1], "base64").toString("utf16le") === "Write-Output 'é’'", args.join(" "))

const clixml = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><Obj S=\"progress\" RefId=\"0\"><TN RefId=\"0\"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N=\"SourceId\">1</I64></MS></Obj><S S=\"Error\">This command cannot be run because &quot;C:\\nowhere\\Bob’s app.lnk&quot; &lt;x&gt; was not found._x000D__x000A_</S><S S=\"Error\">At line:12 char:1_x000D__x000A_</S><S S=\"Error\">+ Start-Process -FilePath $target_x000D__x000A_</S><S S=\"Error\">    + CategoryInfo          : InvalidOperation: (:) [Start-Process], InvalidOperationException_x000D__x000A_</S></Objs>"
const cleaned = cleanPowerShellError(clixml)
check("CLIXML errors come back as their plain message", cleaned === "This command cannot be run because \"C:\\nowhere\\Bob’s app.lnk\" <x> was not found.", cleaned)
check("Plain errors lose PowerShell's position trailer", cleanPowerShellError("Access is denied\r\nAt line:3 char:5\r\n+ foo\r\n") === "Access is denied", cleanPowerShellError("Access is denied\r\nAt line:3 char:5\r\n+ foo\r\n"))
check("Plain messages pass through", cleanPowerShellError("  The system cannot find the file specified\r\n") === "The system cannot find the file specified", "")

// --------------------------------------------------------- Windows keys

const missingScan = KEY_NAMES.filter((name) => WIN_SCAN_CODES[name] === undefined)
check("Every key name has a Windows scan code", missingScan.length === 0, missingScan.join(" "))
check("No scan code is there for a key that does not exist", Object.keys(WIN_SCAN_CODES).every((name) => KEY_NAMES.includes(name)), Object.keys(WIN_SCAN_CODES).filter((name) => !KEY_NAMES.includes(name)).join(" "))
const codes = Object.values(WIN_SCAN_CODES).concat(Object.values(WIN_MODIFIER_SCAN_CODES))
check("No two keys share a scan code", new Set(codes).size === codes.length, "")
// The layout of set 1 is regular enough to check by rows.
const run = (names, first) => names.every((name, i) => WIN_SCAN_CODES[name] === first + i)
check("Digit row: 1 to 0, then - and = are 0x02 to 0x0D", run(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "minus", "equal"], 0x02), "")
check("Top letter row: Q to ] are 0x10 to 0x1B", run(["q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "bracketleft", "bracketright"], 0x10), "")
check("Home row: A to ` are 0x1E to 0x29", run(["a", "s", "d", "f", "g", "h", "j", "k", "l", "semicolon", "quote", "backquote"], 0x1e), "")
check("Bottom row: \\ then Z to / are 0x2B to 0x35", run(["backslash", "z", "x", "c", "v", "b", "n", "m", "comma", "period", "slash"], 0x2b), "")
check("F1 to F10 are 0x3B to 0x44, F11 and F12 0x57 and 0x58", run(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10"], 0x3b) && WIN_SCAN_CODES.f11 === 0x57 && WIN_SCAN_CODES.f12 === 0x58, "")
check("F13 to F23 are 0x64 to 0x6E and F24 is 0x76", run(["f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23"], 0x64) && WIN_SCAN_CODES.f24 === 0x76, "")
const extended = KEY_NAMES.filter((name) => WIN_SCAN_CODES[name] & 0xe000).sort().join(" ")
check("Exactly the arrows and the navigation block are extended keys", extended === "delete down end home left pagedown pageup right up", extended)
check("The modifiers are the left-hand Ctrl, Alt, Shift and Win", WIN_MODIFIER_SCAN_CODES.ctrl === 0x1d && WIN_MODIFIER_SCAN_CODES.alt === 0x38 && WIN_MODIFIER_SCAN_CODES.shift === 0x2a && WIN_MODIFIER_SCAN_CODES.meta === 0xe05b, JSON.stringify(WIN_MODIFIER_SCAN_CODES))

const SCANCODE = 8, KEYUP = 2, EXTENDEDKEY = 1
let inputProblems = []
for (const name of KEY_NAMES) {
  const scan = WIN_SCAN_CODES[name]
  const ext = scan & 0xe000 ? EXTENDEDKEY : 0
  const bare = windowsInputs({ modifiers: [], key: name })
  const want = [{ scan: scan & 0xff, flags: SCANCODE | ext }, { scan: scan & 0xff, flags: SCANCODE | ext | KEYUP }]
  if (JSON.stringify(bare) !== JSON.stringify(want)) inputProblems.push(`${name}: ${JSON.stringify(bare)}`)
  const all = windowsInputs(parseCombo(`meta+shift+alt+ctrl+${name}`))
  const order = all.map((input) => `${input.scan.toString(16)}${input.flags & KEYUP ? "^" : "v"}${input.flags & EXTENDEDKEY ? "e" : ""}`).join(" ")
  const k = (scan & 0xff).toString(16)
  const e = ext ? "e" : ""
  const wantOrder = `1dv 38v 2av 5bve ${k}v${e} ${k}^${e} 5b^e 2a^ 38^ 1d^`
  if (order !== wantOrder || !all.every((input) => input.flags & SCANCODE)) inputProblems.push(`${name}: ${order} (want ${wantOrder})`)
}
check("Every key, bare and with every modifier, is pressed in order and released in reverse as scan codes", inputProblems.length === 0, inputProblems.slice(0, 5).join("; "))

// The helper reads "keys|dry DOWNS SCANS FLAGS": what it would read back,
// following its script (split on spaces, then commas, Int32.Parse).
const readLine = (line) => {
  const parts = line.trim().split(" ")
  if (parts.length !== 4 || !/^(keys|dry)$/.test(parts[0])) return null
  const ints = (text) => text.split(",").map((part) => (/^\d+$/.test(part) ? Number(part) : NaN))
  return { dry: parts[0] === "dry", downs: Number(parts[1]), scans: ints(parts[2]), flags: ints(parts[3]) }
}
const lineProblems = []
for (const name of KEY_NAMES) {
  for (const combo of [{ modifiers: [], key: name }, parseCombo(`ctrl+alt+shift+meta+${name}`), parseCombo(`shift+${name}`)]) {
    for (const dry of [false, true]) {
      const inputs = windowsInputs(combo)
      const read = readLine(windowsKeyLine(combo, dry))
      const ok = read && read.dry === dry && read.downs === combo.modifiers.length + 1 &&
        JSON.stringify(read.scans) === JSON.stringify(inputs.map((input) => input.scan)) &&
        JSON.stringify(read.flags) === JSON.stringify(inputs.map((input) => input.flags)) &&
        read.flags.slice(0, read.downs).every((flag) => !(flag & KEYUP)) && read.flags.slice(read.downs).every((flag) => flag & KEYUP)
      if (!ok) lineProblems.push(`${name}: ${windowsKeyLine(combo, dry)}`)
    }
  }
}
check("The helper command for every key carries its scan codes as plain integers, presses before releases", lineProblems.length === 0, lineProblems.slice(0, 5).join("; "))
check("Win and F17 to F24 are no longer refused on Windows", (() => { try { windowsKeyLine(parseCombo("meta+shift+s")); windowsKeyLine(parseCombo("ctrl+f24")); return true } catch { return false } })(), "")
const helperLexed = lex(WINDOWS_KEY_HELPER)
check("The key helper script parses", helperLexed.ok, helperLexed.why)
check("The key helper gets the C# back exactly", helperLexed.strings[0] === SCAN_KEYS_TYPE, "")
check("The key helper parses numbers with the invariant culture", (WINDOWS_KEY_HELPER.match(/::Parse\(/g) || []).length === 4 && (WINDOWS_KEY_HELPER.match(/::Parse\([^)]*, \$inv\)/g) || []).length === 4, "")
check("The key helper answers every command, failures included", /catch \{\s*\[Console\]::Out\.WriteLine\('error '/.test(WINDOWS_KEY_HELPER) && /'error Punchboard sent/.test(WINDOWS_KEY_HELPER), "")
check("The C# for SendInput holds no single quote and its braces pair up", !/['\u2018-\u201b]/.test(SCAN_KEYS_TYPE) && lex(SCAN_KEYS_TYPE.replace(/"[^"\n]*"/g, "\"\"")).ok, "")
check("The C# declares the mouse event too, so INPUT has its real size", /struct MOUSEINPUT/.test(SCAN_KEYS_TYPE) && /FieldOffset\(0\)\] public MOUSEINPUT/.test(SCAN_KEYS_TYPE), "")
check("The releases are sent in a finally", /finally \{\s*sent \+= Post\(release\)/.test(SCAN_KEYS_TYPE), "")
check("Music keys stay virtual keys", windowsMediaLine("play_pause") === "media 179" && windowsMediaLine("next") === "media 176" && windowsMediaLine("previous") === "media 177", "")

// ------------------------------------------------------------- macOS keys

const macUnsendable = KEY_NAMES.filter((name) => unsendableReason(name, "mac"))
const macMissing = KEY_NAMES.filter((name) => MAC_CODES[name] === undefined)
check("The recorder flags exactly the keys macOS has no code for (F21 to F24)", macUnsendable.join(" ") === macMissing.join(" ") && macMissing.join(" ") === "f21 f22 f23 f24", `${macUnsendable.join(" ")} vs ${macMissing.join(" ")}`)
check("Nothing is flagged on Windows", KEY_NAMES.every((name) => !unsendableReason(name, "windows")), "")
check("Other systems are told key combinations do not work there", Boolean(unsendableReason("a", "other")), "")
const macErrors = KEY_NAMES.filter((name) => { try { macScript({ modifiers: ["meta"], key: name }); return false } catch (error) { return error.message !== unsendableReason(name, "mac") } })
check("macOS says the same thing at press time", macErrors.length === 0, macErrors.join(" "))
check("Platform names are read from Node and from the browser", keyPlatform("darwin") === "mac" && keyPlatform("MacIntel") === "mac" && keyPlatform("iPad") === "mac" && keyPlatform("win32") === "windows" && keyPlatform("Win32") === "windows" && keyPlatform("Linux x86_64") === "other" && keyPlatform("linux") === "other", "")
check("Modifiers keep their fixed order", MODIFIERS.join(" ") === "ctrl alt shift meta", "")

// ----------------------------------------------------------- the launcher

for (const dry of [false, true]) {
  const target = "C:\\Users\\Ann\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Bob’s ‘[beta]’ app's $tool.lnk"
  const script = windowsLaunchScript(target, dry)
  const lexed = lex(script)
  check(`The launcher${dry ? " (dry run)" : ""} parses with a curly-quoted path`, lexed.ok, lexed.why)
  check(`The launcher${dry ? " (dry run)" : ""} gets the path back exactly`, lexed.strings.includes(target), lexed.strings.slice(0, 3).join(" | "))
  check(`The launcher${dry ? " (dry run)" : ""} knows every generic host`, GENERIC_HOSTS.every((name) => lexed.strings.includes(name)), "")
}
const live = windowsLaunchScript("C:\\a.lnk")
const dryLaunch = windowsLaunchScript("C:\\a.lnk", true)
check("The dry run stops before touching any window", dryLaunch.indexOf("exit 0") < dryLaunch.indexOf("keybd_event(0xE8") && !/Process\]::Start/.test(dryLaunch.slice(0, dryLaunch.indexOf("exit 0"))), "")
check("No Alt tap: the foreground is earned with an unassigned key", !/keybd_event\(0x12/.test(live) && /keybd_event\(0xE8, 0, 0,/.test(live) && /keybd_event\(0xE8, 0, 2,/.test(live), "")
check("A refused SetForegroundWindow is retried, then the shortcut is started", /AttachThreadInput\(\$me, \$other, \$true\)/.test(live) && /if \(\$front\) \{ exit 0 \}/.test(live) && live.lastIndexOf("Process]::Start") > live.indexOf("if ($front)"), "")
check("Shortcuts with arguments are started, not matched to a window", /elseif \(\$arguments\.Trim\(\)\) \{\s*\$exe = ''/.test(live), "")
check("Squirrel's Update.exe --processStart X.exe looks for X", /'Update\.exe' -and \$arguments -match/.test(live), "")
// The regex the script uses, run here on the arguments Squirrel writes.
const squirrel = /^\s*--processStart\s+(?:"([^"]+)"|(\S+))\s*$/
check("--processStart is read quoted and unquoted, and not with more arguments", squirrel.exec("--processStart \"Discord.exe\"")?.[1] === "Discord.exe" && squirrel.exec("--processStart slack.exe")?.[2] === "slack.exe" && !squirrel.test("--processStart \"Teams.exe\" --process-start-args \"--profile=AAD\""), "")

// ----------------------------------------------------------- the app list

const names = ["Helpdesk", "Hotspot Helper", "Manual Focus", "Uninstall Foo", "Foo Uninstaller", "Readme", "Read Me", "VLC Help", "Foo Website", "Foo on the Web", "Foo Documentation", "Help Desk Pro", "Release Notes", "Web Site", "User Manual", "GIMP", "Unhelpful Tool"]
const kept = names.filter(isAppName)
check("Real apps are kept and uninstallers, readmes and help pages dropped", kept.join("|") === "Helpdesk|Hotspot Helper|Manual Focus|Help Desk Pro|GIMP|Unhelpful Tool", kept.join("|"))
check(".url shortcuts to a game launcher count as apps", urlShortcutStartsApp("[InternetShortcut]\r\nURL=steam://rungameid/570\r\nIconIndex=0\r\n") && urlShortcutStartsApp("[{000214A0-0000-0000-C000-000000000046}]\nProp3=19,0\n[InternetShortcut]\nURL=com.epicgames.launcher://apps/Fortnite?action=launch\n"), "")
check(".url shortcuts to web pages and files do not", !urlShortcutStartsApp("[InternetShortcut]\nURL=https://example.com/\n") && !urlShortcutStartsApp("[InternetShortcut]\nURL=file:///C:/x.txt\n") && !urlShortcutStartsApp("garbage"), "")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-apps-"))
const machine = path.join(root, "machine")
const user = path.join(root, "user")
const touch = (file, content = "") => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
touch(path.join(machine, "Discord Inc", "Discord.lnk"))
touch(path.join(machine, "Helpdesk.lnk"))
touch(path.join(machine, "Foo", "Uninstall Foo.lnk"))
touch(path.join(machine, "Foo", "Foo Website.url"), "[InternetShortcut]\nURL=https://foo.example/\n")
touch(path.join(user, "Discord.lnk"))
touch(path.join(user, "Steam", "Dota 2.url"), "[InternetShortcut]\nURL=steam://rungameid/570\n")
touch(path.join(user, "Steam", "Portal.url"), "[InternetShortcut]\nURL=steam://rungameid/400\n")
touch(path.join(user, "Portal.lnk"))
touch(path.join(user, "notes.txt"))
const listed = windowsApps([machine, user]).map((app) => `${app.name}=${path.relative(root, app.path)}`).sort()
const wantListed = [`Discord=${path.join("machine", "Discord Inc", "Discord.lnk")}`, `Dota 2=${path.join("user", "Steam", "Dota 2.url")}`, `Helpdesk=${path.join("machine", "Helpdesk.lnk")}`, `Portal=${path.join("user", "Portal.lnk")}`]
check("The Start Menu lists each app once, game shortcuts included and web links not", listed.join(" | ") === wantListed.join(" | "), listed.join(" | "))
fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${tally.pass} passed, ${tally.fail} failed`)
process.exit(tally.fail ? 1 : 0)
