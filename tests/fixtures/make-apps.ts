// Fixtures for the Rust port of the app list and the launcher
// (server/src/apps/): the TypeScript is run over many inputs and what it
// answers is written to tests/fixtures/apps/*.json as arrays of
// { input, output }. The Rust unit tests read them and must answer the same.
// Nothing here depends on the clock or on chance, so a second run writes the
// same files.
//   node tests/fixtures/make-apps.ts        (from the repository's root)
//
// macApps.json comes from the real listApps() on a Mac (its folders cannot be
// passed in, but the one under the home folder follows HOME): on another
// system that file is left as it is.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AppEntry } from "../../src/shared/api.ts"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
interface Case { input: Json; output: Json; [extra: string]: Json }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "../..")
const OUT = path.join(HERE, "apps")
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "punchboard-fixtures-apps-"))

// The companion's own modules read the environment when they load.
process.env.PUNCHBOARD_LOCALES_DIR = path.join(ROOT, "public", "locales")
delete process.env.PUNCHBOARD_LOCALE
const { isAppName, urlShortcutStartsApp, windowsApps } = await import("../../src/server/apps.ts")
const { GENERIC_HOSTS } = await import("../../src/server/launch.ts")
const { cleanPowerShellError } = await import("../../src/server/powershell.ts")

const counts: Record<string, number> = {}
function write(name: string, cases: Case[]): void {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, name), `[\n${cases.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`)
  counts[name] = cases.length
}

const unique = (values: string[]): string[] => [...new Set(values)]

// ------------------------------------------------------------- isAppName

{
  const phrases = [
    "uninstall", "uninstaller", "uninstalls", "uninstalled", "reinstall", "readme", "read me", "read  me", "read-me", "readmes",
    "release notes", "release  notes", "release note", "releasenotes", "website", "web site", "web  site", "websites", "on the web",
    "on the webs", "documentation", "documentations", "user guide", "users guide", "user's guide", "user\u2019s guide", "user manual",
    "users manual", "user's manual", "userss guide", "user 's guide", "user guides", "user  guide", "help", "helper", "helps"
  ]
  const shapes: ((phrase: string) => string)[] = [
    (p) => p, (p) => `Foo ${p}`, (p) => `${p} Foo`, (p) => `Foo${p}`, (p) => `${p}Foo`, (p) => `Foo-${p}`, (p) => `${p}-Foo`,
    (p) => `${p}.`, (p) => `(${p})`, (p) => `${p}_x`, (p) => `x_${p}`, (p) => `9${p}`, (p) => `${p}9`, (p) => `é${p}`, (p) => `${p}é`,
    (p) => `Foo ${p} `, (p) => `Foo\t${p}`, (p) => `Foo\u00a0${p}`, (p) => `Foo\u3000${p}`, (p) => `Foo\n${p}`, (p) => `${p}\n`,
    (p) => `  ${p}`, (p) => `Foo.${p}`, (p) => `Foo ${p} 2`
  ]
  const cased: ((text: string) => string)[] = [
    (text) => text,
    (text) => text.toUpperCase(),
    (text) => text.replace(/(^|[\s(-])([a-z])/g, (_all, before: string, letter: string) => before + letter.toUpperCase())
  ]
  const names: string[] = [
    // tests/scripts.test.mjs
    "Helpdesk", "Hotspot Helper", "Manual Focus", "Uninstall Foo", "Foo Uninstaller", "Readme", "Read Me", "VLC Help", "Foo Website",
    "Foo on the Web", "Foo Documentation", "Help Desk Pro", "Release Notes", "Web Site", "User Manual", "GIMP", "Unhelpful Tool",
    // Apps people have.
    "Google Chrome", "Visual Studio Code", "Notepad++", "7-Zip File Manager", "OBS Studio", "Steam", "Discord", "WhatsApp", "Spotify",
    "Microsoft Edge", "Windows PowerShell (x86)", "Git Bash", "VLC media player", "Help Viewer", "HelpNDoc", "Get Help", "Tips",
    "Web Help Desk", "User Manual Maker", "Guide", "Manual", "The User", "Userguide", "User-Guide", "User_Guide", "Read Me First",
    "ReadMe.txt", "README", "Uninstall", "UNINSTALL", "Uninstall.exe", "Un-install", "Uninstall_Foo", "Foo (Uninstall)", "Website Builder",
    "On The Web Radio", "Radio on the web", "Documentation Browser", "Dash Documentation", "Release Notes Viewer", "Whats New",
    // Other languages: only English words are filtered.
    "Désinstaller Foo", "Foo deinstallieren", "Desinstalar Foo", "Léeme", "Leeme", "Ayuda", "Aide", "Hilfe", "Ayuda de VLC",
    "Documentación", "Documentation française", "Dokumentation", "Sitio web de Foo", "Foo en la web", "Manual del usuario",
    "Guía del usuario", "Benutzerhandbuch", "ドキュメント", "ヘルプ", "アンインストール", "卸载 Foo", "Справка", "Удалить Foo", "Calculadora",
    "Bloc de notas", "Café", "Ñandú", "Übersicht", "日本語アプリ", "Emoji 😀 App", "😀 help", "help 😀",
    // Letters that only look like the English ones, or fold to them.
    "un\u0131nstall", "Un\u0130nstall", "\u212aelp", "hel\u017f", "\uff28elp", "U\u0308ninstall", "we\u0299 site",
    // Edges.
    "", " ", "help", "Help", "HELP", " help", "help ", "Help\n", "\nhelp", "xhelp", "x help", "x\u2028help", "x\ufeffhelp", "x\u0085help",
    "x\u200bhelp", "x\u180ehelp", "help.", "Help!", "A Help", "A  Help", "Helper", "Help Me", "selfhelp", "self-help", "Self Help"
  ]
  for (const phrase of phrases) {
    for (const shape of shapes) {
      for (const letterCase of cased) names.push(shape(letterCase(phrase)))
    }
  }
  write("isAppName.json", unique(names).map((name) => ({ input: name, output: isAppName(name) })))
}

// --------------------------------------------------- urlShortcutStartsApp

{
  const schemes = [
    "steam", "com.epicgames.launcher", "http", "https", "HTTP", "Https", "ftp", "file", "mailto", "about", "javascript", "data",
    "uplay", "origin2", "battlenet", "ms-settings", "ms-windows-store", "spotify", "discord", "zoommtg", "vscode", "x+y.z-1", "a",
    "httpx", "https2", "files", "ftps", "datas", "h", "1steam", "+steam", "ste_am", "ste am", "st\u00e9am", "\u017fteam", "\u212aodi"
  ]
  const rests = ["//rungameid/570", "//apps/Fortnite?action=launch", "//example.com/", "", "x", "///C:/x.txt"]
  const shapes: ((address: string) => string)[] = [
    (a) => `[InternetShortcut]\r\nURL=${a}\r\nIconIndex=0\r\n`,
    (a) => `[InternetShortcut]\nURL=${a}\n`,
    (a) => `URL=${a}`,
    (a) => `url=${a}`,
    (a) => `Url = ${a}`,
    (a) => `  URL\t=\t${a}`,
    (a) => `[{000214A0-0000-0000-C000-000000000046}]\nProp3=19,0\n[InternetShortcut]\nURL=${a}\n`,
    (a) => `\ufeff[InternetShortcut]\r\nURL=${a}\r\n`,
    (a) => `\ufeffURL=${a}`,
    (a) => `BASEURL=${a}\n`,
    (a) => `x URL=${a}\n`,
    (a) => `;URL=${a}\n`,
    (a) => `IconFile=x\rURL=${a}\r`,
    (a) => `a\u2028URL=${a}`,
    (a) => `a\u2029 URL =${a}`,
    (a) => `a\u0085URL=${a}`,
    (a) => `a\u000bURL=${a}`,
    (a) => `a\u000cURL=${a}`,
    (a) => `\n\n\n   \n URL \n = \n ${a}`,
    (a) => `URL=https://first.example/\nURL=${a}\n`,
    (a) => `URL=steam://first\nURL=${a}\n`,
    (a) => `URL=\nURL=${a}\n`,
    (a) => `URL=://x\nURL=${a}\n`,
    (a) => `URL==${a}`,
    (a) => `URL:${a}`,
    (a) => `URL ${a}`,
    (a) => `U RL=${a}`,
    (a) => `URLS=${a}`,
    (a) => `WorkingDirectory=C:\\x\nurl=${a}\nHotKey=0`
  ]
  const contents: string[] = [
    "", "garbage", "URL", "URL=", "URL=:", "URL=steam", "URL=steam:", "URL=s:", "URL=1:", "URL=C:\\Games\\x.exe", "URL=c:/x", "URL=//x",
    "[InternetShortcut]", "[InternetShortcut]\nURL=steam//rungameid/570", "URL=\"steam://x\"", "URL='steam://x'", "URL=<steam://x>",
    "URL=steam ://x", "URL=steam\n://x", "URL=steam\u00a0:x", "\u0131RL=steam://x", "\u016aRL=steam://x", "UR\u2028L=steam://x",
    "URL\u00a0=\u3000steam://x", "URL\ufeff=\ufeffsteam://x", "URL\u200b=steam://x", "\u0000URL=steam://x", "URL=steam://x\u0000"
  ]
  for (const scheme of schemes) {
    for (const rest of rests) {
      const address = `${scheme}:${rest}`
      // Every shape for a few addresses, the plain shapes for all of them.
      const some = rest === rests[0] ? shapes : shapes.slice(0, 3)
      for (const shape of some) contents.push(shape(address))
    }
  }
  write("urlShortcutStartsApp.json", unique(contents).map((content) => ({ input: content, output: urlShortcutStartsApp(content) })))
}

// ---------------------------------------------------------- windowsApps

interface TreeFile {
  /** Relative to the case's folder, with "/". */
  path: string
  /** What the file holds, as base64, so every byte reaches Rust. */
  base64: string
}
interface Tree { name: string; roots: string[]; files: TreeFile[]; folders?: string[] }

const text = (content: string): string => Buffer.from(content, "utf8").toString("base64")
const lnk = (file: string): TreeFile => ({ path: file, base64: "" })
const url = (file: string, address: string): TreeFile => ({ path: file, base64: text(`[InternetShortcut]\r\nURL=${address}\r\n`) })

function build(tree: Tree, index: number): string {
  const base = path.join(TMP, `tree-${index}`)
  fs.mkdirSync(base, { recursive: true })
  for (const folder of tree.folders ?? []) fs.mkdirSync(path.join(base, ...folder.split("/")), { recursive: true })
  for (const file of tree.files) {
    const full = path.join(base, ...file.path.split("/"))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, Buffer.from(file.base64, "base64"))
  }
  return base
}

/** Entries with their paths relative to `base`, with "/", in a fixed order
    (the order folders are read in is the file system's, not Punchboard's). */
function relative(apps: AppEntry[], base: string): Json[] {
  return apps
    .map((app) => ({ name: app.name, path: path.relative(base, app.path).split(path.sep).join("/") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

{
  const trees: Tree[] = [
    {
      name: "the tree of tests/scripts.test.mjs",
      roots: ["machine", "user"],
      files: [
        lnk("machine/Discord Inc/Discord.lnk"), lnk("machine/Helpdesk.lnk"), lnk("machine/Foo/Uninstall Foo.lnk"),
        url("machine/Foo/Foo Website.url", "https://foo.example/"), lnk("user/Discord.lnk"), url("user/Steam/Dota 2.url", "steam://rungameid/570"),
        url("user/Steam/Portal.url", "steam://rungameid/400"), lnk("user/Portal.lnk"), { path: "user/notes.txt", base64: "" }
      ]
    },
    {
      name: "three folders deep are read, four are not",
      roots: ["menu"],
      files: [lnk("menu/Top.lnk"), lnk("menu/a/One.lnk"), lnk("menu/a/b/Two.lnk"), lnk("menu/a/b/c/Three.lnk"), lnk("menu/a/b/c/d/Four.lnk"), lnk("menu/a/b/c/d/e/Five.lnk")]
    },
    {
      name: "the extension in any case, and only as the extension",
      roots: ["menu"],
      files: [
        lnk("menu/Upper.LNK"), lnk("menu/Mixed.Lnk"), url("menu/Game.URL", "steam://rungameid/1"), url("menu/Other.Url", "uplay://launch/2"),
        lnk("menu/Not a shortcut.lnk.txt"), lnk("menu/lnk"), lnk("menu/Program.exe"), lnk("menu/desktop.ini"), lnk("menu/Trailing.lnk2"),
        lnk("menu/Double.lnk.lnk"), lnk("menu/Dotted.name.lnk")
      ]
    },
    {
      name: "a shortcut wins over a link of the same name, whichever comes first",
      roots: ["first", "second"],
      files: [
        url("first/Link then shortcut.url", "steam://rungameid/1"), lnk("second/Link then shortcut.lnk"),
        lnk("first/Shortcut then link.lnk"), url("second/Shortcut then link.url", "steam://rungameid/2"),
        url("first/Two links.url", "steam://rungameid/3"), url("second/Two links.url", "steam://rungameid/4"),
        lnk("first/Two shortcuts.lnk"), lnk("second/Two shortcuts.lnk"),
        url("first/Web then game.url", "https://example.com/"), url("second/Web then game.url", "steam://rungameid/5"),
        url("first/Web then shortcut.url", "https://example.com/"), lnk("second/Web then shortcut.lnk"),
        lnk("first/Shortcut then web.lnk"), url("second/Shortcut then web.url", "https://example.com/")
      ]
    },
    {
      name: "three places for one name",
      roots: ["first", "second", "third"],
      files: [
        url("first/Game.url", "steam://rungameid/1"), lnk("second/Game.lnk"), url("third/Game.url", "steam://rungameid/2"),
        url("first/Other.url", "steam://rungameid/3"), lnk("second/Other.lnk"), lnk("third/Other.lnk")
      ]
    },
    {
      name: "one entry per name, whatever its case",
      roots: ["first", "second"],
      files: [
        lnk("first/DISCORD.lnk"), lnk("second/Discord.lnk"), lnk("first/\u00c9COLE.lnk"), lnk("second/\u00e9cole.lnk"),
        lnk("first/\u0130stanbul.lnk"), lnk("second/i\u0307stanbul.lnk"), lnk("first/STRASSE.lnk"), lnk("second/stra\u00dfe.lnk"),
        lnk("first/\u03a3\u0391\u03a3.lnk"), lnk("second/\u03c3\u03b1\u03c2.lnk"), lnk("first/\u03a3\u0391\u03a3 2.lnk"), lnk("second/\u03c3\u03b1\u03c3 2.lnk")
      ]
    },
    {
      name: "names are trimmed, and what is not an app is left out",
      roots: ["menu"],
      files: [
        lnk("menu/Spaced  .lnk"), lnk("menu/  Leading.lnk"), lnk("menu/ .lnk"), lnk("menu/.lnk"), lnk("menu/.url"), lnk("menu/Uninstall Foo.lnk"),
        lnk("menu/Foo Uninstaller.lnk"), lnk("menu/Readme.lnk"), lnk("menu/Read Me.lnk"), lnk("menu/VLC Help.lnk"), lnk("menu/Help Desk Pro.lnk"),
        lnk("menu/Release Notes.lnk"), lnk("menu/Foo on the Web.lnk"), lnk("menu/Foo Documentation.lnk"), lnk("menu/User's Guide.lnk"),
        url("menu/Foo Website.url", "steam://rungameid/9"), url("menu/Help.url", "steam://rungameid/9"), lnk("menu/Helpdesk.lnk"), lnk("menu/GIMP.lnk")
      ]
    },
    {
      name: "names in other alphabets and with typographic quotes",
      roots: ["menu"],
      files: [
        lnk("menu/Caf\u00e9.lnk"), lnk("menu/Bob\u2019s \u2018tool\u2019.lnk"), lnk("menu/\u65e5\u672c\u8a9e\u30a2\u30d7\u30ea.lnk"),
        lnk("menu/\u00d1and\u00fa.lnk"), lnk("menu/Emoji \ud83d\ude00.lnk"), url("menu/\u30b2\u30fc\u30e0.url", "steam://rungameid/7"),
        lnk("menu/[beta] app's $tool.lnk"), lnk("menu/100% #1.lnk")
      ]
    },
    {
      name: "folders are folders, whatever they are called",
      roots: ["menu"],
      files: [lnk("menu/Folder.lnk/Inner.lnk"), url("menu/Folder.url/Inner game.url", "steam://rungameid/8"), lnk("menu/Plain/App.lnk")],
      folders: ["menu/Empty", "menu/Empty.lnk"]
    },
    {
      name: "a root that is not there",
      roots: ["missing", "menu", "also missing"],
      files: [lnk("menu/App.lnk")]
    },
    {
      name: "a root that is a file",
      roots: ["menu/App.lnk", "menu"],
      files: [lnk("menu/App.lnk")]
    },
    {
      name: "the same root twice",
      roots: ["menu", "menu"],
      files: [lnk("menu/App.lnk"), url("menu/Game.url", "steam://rungameid/1")]
    },
    {
      name: "a root inside another",
      roots: ["menu/Games", "menu"],
      files: [lnk("menu/App.lnk"), url("menu/Games/Game.url", "steam://rungameid/1"), lnk("menu/Games/Launcher.lnk")]
    },
    {
      name: "no roots",
      roots: [],
      files: [lnk("menu/App.lnk")]
    },
    {
      name: "links in other encodings and shapes",
      roots: ["menu"],
      files: [
        { path: "menu/With a mark.url", base64: text("\ufeff[InternetShortcut]\r\nURL=steam://rungameid/1\r\n") },
        { path: "menu/Mark and nothing else.url", base64: text("\ufeffURL=steam://rungameid/1") },
        { path: "menu/Empty.url", base64: "" },
        { path: "menu/Broken bytes.url", base64: Buffer.from([0xff, 0xfe, 0x0a, 0x55, 0x52, 0x4c, 0x3d, 0x73, 0x74, 0x65, 0x61, 0x6d, 0x3a, 0x2f, 0x2f, 0x78, 0xc3]).toString("base64") },
        { path: "menu/Broken scheme.url", base64: Buffer.from([0x55, 0x52, 0x4c, 0x3d, 0x73, 0xff, 0x74, 0x3a, 0x2f, 0x2f, 0x78]).toString("base64") },
        { path: "menu/Sixteen bits.url", base64: Buffer.from("[InternetShortcut]\r\nURL=steam://rungameid/1\r\n", "utf16le").toString("base64") },
        { path: "menu/A file.url", base64: text("[InternetShortcut]\nURL=file:///C:/x.txt\n") },
        { path: "menu/A page.url", base64: text("[InternetShortcut]\nURL=http://example.com/\n") },
        { path: "menu/Mail.url", base64: text("[InternetShortcut]\nURL=mailto:a@b.example\n") },
        { path: "menu/Epic.url", base64: text("[{000214A0-0000-0000-C000-000000000046}]\nProp3=19,0\n[InternetShortcut]\nURL=com.epicgames.launcher://apps/Fortnite?action=launch\n") },
        { path: "menu/Lower.url", base64: text("[InternetShortcut]\nurl = uplay://launch/1\n") }
      ]
    }
  ]
  const cases: Case[] = trees.map((tree, index) => {
    const base = build(tree, index)
    const roots = tree.roots.map((root) => path.join(base, ...root.split("/")))
    const input: Json = { name: tree.name, roots: tree.roots, folders: tree.folders ?? [], files: tree.files.map((file) => ({ path: file.path, base64: file.base64 })) }
    return { input, output: relative(windowsApps(roots), base) }
  })
  write("windowsApps.json", cases)
}

// ------------------------------------------------------------ the order

// listApps() sorts with a.name.localeCompare(b.name, undefined, { sensitivity:
// "base" }), in the language Node started in. Here the same comparison is
// made in several languages, on names given in a fixed order (equal names
// keep it: the sort is stable).
{
  const names = [
    "Zoom", "zoom.us", "Zebra", "apple", "Apple", "APPLE", "\u00c1pple", "Banana", "banana 2", "Banana 10", "banana 1", "1Password", "7-Zip",
    "10 Things", "2Do", "\u00dcbersicht", "Uber", "Ubuntu", "\u00d1and\u00fa", "Nando", "Nudge", "N\u00fcrnberg", "\u00c5ngstr\u00f6m", "Angstrom",
    "\u00d6dland", "Odland", "Oz", "\u00c4rger", "Arger", "Az", "iTerm", "\u0130stanbul", "Istanbul", "\u0131rmak", "irmak", "IntelliJ IDEA",
    "\u00c6on", "Aeon", "\u0152uvre", "Oeuvre", "Stra\u00dfe", "Strasse", "Strasze", "Caf\u00e9", "Cafe", "Cafe\u0301", "cafeteria", "co-op", "coop",
    "co op", "Co_op", "CO.OP", "-dash", "_underscore", ".hidden", "(parenthesis)", "[bracket]", "#hash", "@at", "~tilde", "$dollar", "\u20ac euro",
    " Leading space", "Trailing ", "Two  spaces", "Two spaces", "TwoSpaces", "Llama", "llave", "Luz", "lzz", "Chocolate", "Cup", "czar",
    "\u65e5\u672c\u8a9e", "\u304b\u306a", "\u30ab\u30ca", "\uff76\uff85", "\u4e2d\u6587", "\u6f22\u5b57", "\ud55c\uad6d\uc5b4", "\u0420\u0443\u0441\u0441\u043a\u0438\u0439",
    "\u0440\u0443\u0441\u0441\u043a\u0438\u0439 2", "\u0395\u03bb\u03bb\u03b7\u03bd\u03b9\u03ba\u03ac", "\u05e2\u05d1\u05e8\u05d9\u05ea", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629",
    "\uff21pp fullwidth", "App fullwidth", "\ud83d\ude00 Emoji", "\ud83c\udfae Games", "A\u200bB", "AB", "A B", "", "a", "A", "\u00e0", "\u00e1", "\u00e2", "\u00e4", "\u00e5", "b", "B",
    "Final Cut Pro", "final cut", "Finder", "FaceTime", "Font Book", "Safari", "safari 2", "System Settings", "System Information",
    "Visual Studio Code", "Visual Studio", "VLC", "vlc media player", "Xcode", "xbox", "X"
  ]
  const locales = ["en-US", "es", "es-CO", "sv", "de", "fr", "tr", "da", "ja", "zh", "ko", "ru", "pl", "cs", "hu", "und"]
  const cases: Case[] = locales.map((locale) => ({
    input: { locale, names },
    output: [...names].sort((a, b) => a.localeCompare(b, locale, { sensitivity: "base" }))
  }))
  write("order.json", cases)
}

// -------------------------------------------------------------- macApps

interface MacTree {
  name: string
  /** What the environment says about the language (LC_ALL). */
  locale: string
  /** Under the home folder's Applications, with "/"; ending in "/" for a folder. */
  entries: string[]
}

if (process.platform === "darwin") {
  const trees: MacTree[] = [
    {
      name: "bundles, one folder deep, and what is not one",
      locale: "en_US.UTF-8",
      entries: [
        "Zeta.app/Contents/Info.plist", "Alpha.app/", "beta.app/", "Gamma Suite/Tool.app/", "Gamma Suite/Deeper/Too deep.app/",
        "Gamma Suite/notes.txt", ".Hidden.app/", ".hidden folder/Inside.app/", "Gamma Suite/.Hidden too.app/", "Plain file.app",
        "Not an app.txt", "Bundle.app/Contents/Helpers/Inner.app/", "Upper.APP/Inside upper.app/", "Folder/", "No extension/",
        "Trailing.app.bak/", "Trailing.app.bak/Inside trailing.app/", "Dotted.name.app/", "Caf\u00e9.app/", "\u65e5\u672c\u8a9e.app/"
      ]
    },
    {
      name: "the order in English",
      locale: "en_US.UTF-8",
      entries: ["\u00d1and\u00fa.app/", "Nudge.app/", "Nz.app/", "Oz.app/", "\u00c5ngstr\u00f6m.app/", "Zebra.app/", "apple.app/", "Banana.app/", "1Password.app/", "iTerm.app/", "\u00d6dland.app/", "Utilities/Zoom.app/", "Utilities/aardvark.app/"]
    },
    {
      name: "the order in Spanish",
      locale: "es_ES.UTF-8",
      entries: ["\u00d1and\u00fa.app/", "Nudge.app/", "Nz.app/", "Oz.app/", "\u00c5ngstr\u00f6m.app/", "Zebra.app/", "apple.app/", "Banana.app/", "1Password.app/", "iTerm.app/", "\u00d6dland.app/", "Utilities/Zoom.app/", "Utilities/aardvark.app/"]
    },
    {
      name: "the order in Swedish",
      locale: "sv_SE.UTF-8",
      entries: ["\u00d1and\u00fa.app/", "Nudge.app/", "Nz.app/", "Oz.app/", "\u00c5ngstr\u00f6m.app/", "Zebra.app/", "apple.app/", "Banana.app/", "1Password.app/", "iTerm.app/", "\u00d6dland.app/", "Utilities/Zoom.app/", "Utilities/aardvark.app/"]
    },
    {
      name: "the order with no language set",
      locale: "C",
      entries: ["\u00d1and\u00fa.app/", "Nudge.app/", "Nz.app/", "Oz.app/", "\u00c5ngstr\u00f6m.app/", "Zebra.app/", "apple.app/", "Banana.app/", "1Password.app/", "iTerm.app/", "\u00d6dland.app/", "Utilities/Zoom.app/", "Utilities/aardvark.app/"]
    },
    {
      name: "no Applications folder at home",
      locale: "en_US.UTF-8",
      entries: []
    }
  ]
  const module = pathToFileURL(path.join(ROOT, "src", "server", "apps.ts")).href
  const cases: Case[] = trees.map((tree, index) => {
    // The real path: /var/folders/… is a link on a Mac, and paths are compared below.
    const home = fs.realpathSync(fs.mkdtempSync(path.join(TMP, `home-${index}-`)))
    const applications = path.join(home, "Applications")
    for (const entry of tree.entries) {
      const full = path.join(applications, ...entry.split("/").filter(Boolean))
      if (entry.endsWith("/")) {
        fs.mkdirSync(full, { recursive: true })
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, "")
      }
    }
    // A fresh Node each time: listApps() remembers its answer for a minute,
    // and the language is read once, when Node starts.
    const printed = execFileSync(process.execPath, ["--input-type=module", "-e", `import { listApps } from ${JSON.stringify(module)}; console.log(JSON.stringify(listApps()))`], {
      env: { PATH: process.env.PATH ?? "", HOME: home, LC_ALL: tree.locale, PUNCHBOARD_LOCALES_DIR: path.join(ROOT, "public", "locales") },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    })
    const all = JSON.parse(printed) as AppEntry[]
    // The Mac's own apps are in the list too; only this home's are kept, in
    // the order listApps() gave them.
    const ours = all
      .filter((app) => app.path.startsWith(`${applications}${path.sep}`))
      .map((app) => ({ name: app.name, path: path.relative(applications, app.path).split(path.sep).join("/") }))
    return { input: { name: tree.name, locale: tree.locale, entries: tree.entries }, output: ours }
  })
  write("macApps.json", cases)
} else {
  console.log("macApps.json is written on a Mac only; left as it is.")
}

// ------------------------------------------------- cleanPowerShellError

// PowerShell is gone from the Rust companion, and CLIXML with it. What stays
// is the last step: whatever the system said, as one line. `plain` marks the
// inputs that have no PowerShell wrapping, which Rust's clean_system_error
// must answer the same way.
{
  const clixml = "#< CLIXML\r\n<Objs Version=\"1.1.0.1\" xmlns=\"http://schemas.microsoft.com/powershell/2004/04\"><Obj S=\"progress\" RefId=\"0\"><TN RefId=\"0\"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N=\"SourceId\">1</I64></MS></Obj><S S=\"Error\">This command cannot be run because &quot;C:\\nowhere\\Bob\u2019s app.lnk&quot; &lt;x&gt; was not found._x000D__x000A_</S><S S=\"Error\">At line:12 char:1_x000D__x000A_</S><S S=\"Error\">+ Start-Process -FilePath $target_x000D__x000A_</S><S S=\"Error\">    + CategoryInfo          : InvalidOperation: (:) [Start-Process], InvalidOperationException_x000D__x000A_</S></Objs>"
  const inputs = [
    // tests/scripts.test.mjs
    clixml,
    "Access is denied\r\nAt line:3 char:5\r\n+ foo\r\n",
    "  The system cannot find the file specified\r\n",
    // What Windows itself says (FormatMessage), which is what Rust now gets.
    "The system cannot find the file specified.\r\n",
    "The system cannot find the path specified.\r\n",
    "Access is denied.\r\n",
    "The operation was canceled by the user.\r\n",
    "No application is associated with the specified file for this operation.\r\n",
    "The specified executable is not a valid application for this OS platform.",
    "%1 is not a valid Win32 application.\r\n",
    "The process cannot access the file because it is being used by another process.\r\n",
    "This file does not have a program associated with it for performing this action. Please install a program or, if one is already installed, create an association in the Default Programs control panel.\r\n",
    "El sistema no puede encontrar el archivo especificado.\r\n",
    "Das System kann die angegebene Datei nicht finden.\r\n",
    "\u6307\u5b9a\u3055\u308c\u305f\u30d5\u30a1\u30a4\u30eb\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002\r\n",
    // What macOS and Linux say.
    "The application \u201cNowhere\u201d can\u2019t be opened.",
    "The file \u201cx\u201d couldn\u2019t be opened because there is no such file.\n",
    "No such file or directory (os error 2)",
    "Permission denied (os error 13)\n",
    // Shapes.
    "", " ", "\r\n", "\n\n\n", "one", " one ", "one  two", "one\ttwo", "one\r\ntwo", "one\n\n\ntwo\n", "\tone \t two\t", "one\u00a0two", "\u00a0one\u00a0",
    "one\u3000two", "one\u2028two", "\ufeffone", "one\u200btwo", "one\u0085two", "a  b   c    d", "Line one.\r\nLine two.\r\n",
    // PowerShell's own wrapping, which Rust no longer sees.
    "boom\r\n    + CategoryInfo          : NotSpecified: (:) [Write-Error], WriteErrorException\r\n    + FullyQualifiedErrorId : x\r\n",
    "boom\nAt C:\\x\\script.ps1:4 char:1\n+ throw 'boom'\n",
    "#< CLIXML\r\n<Objs><S S=\"Error\">a &amp; b &#39;c&#39; &apos;d&apos;_x000D__x000A_</S></Objs>",
    "#< CLIXML\r\n<Objs><S S=\"Warning\">not an error</S></Objs>",
    "#< CLIXML",
    "At line:1 char:1",
    "Something. At line:1 char:1 is not a trailer here"
  ]
  const wrapped = (input: string): boolean => /CLIXML/.test(input) || /\r?\n\s*(At |\+ )/.test(input)
  write("cleanPowerShellError.json", inputs.map((input) => ({ input, output: cleanPowerShellError(input), plain: !wrapped(input) })))
}

// ------------------------------------------------------------ constants

write("constants.json", [{ input: "GENERIC_HOSTS", output: [...GENERIC_HOSTS] }])

fs.rmSync(TMP, { recursive: true, force: true })
for (const [name, count] of Object.entries(counts)) console.log(`${String(count).padStart(5)}  ${name}`)
