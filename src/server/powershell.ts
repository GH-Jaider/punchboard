// Running short PowerShell scripts on Windows: quoting values into them,
// finding powershell.exe, and turning what it prints on failure into a
// sentence a person can read.
import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

/** A PowerShell single-quoted string literal holding `text` exactly.
    PowerShell takes the typographic quotes ‘ ’ ‚ ‛ (U+2018 to U+201B) for a
    plain ' as well, so a name like "Bob’s app" would end the string early;
    each of them is doubled like ' is (a doubled quote stands for the second
    one, so every character comes back as itself). */
export function psQuote(text: string): string {
  return `'${text.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`
}

/** The full path of Windows PowerShell, so a powershell.exe earlier on the
    PATH (or in the folder Punchboard runs from) is never the one started.
    Falls back to the bare name if the usual file is not there. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR
  if (root) {
    const full = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if (exists(full)) return full
  }
  return "powershell"
}

let resolved: string | null = null
/** powershellPath() for this computer, looked up once. */
export const powershellExe = (): string => (resolved ??= powershellPath())

/** A script made ready to run: errors stop it instead of scrolling past, no
    progress bars (with -EncodedCommand PowerShell prints them to stderr as
    CLIXML), and a failure prints just its message and exits with 1. */
export function wrapScript(body: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // UTF-8 without a byte order mark, so a name like "Café" reads back as itself.
    "try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }",
    "try {",
    body,
    "} catch {",
    // The innermost exception has the plain reason: a .NET call's outer one
    // reads 'Exception calling "Start" with "1" argument(s): ...'.
    "  $e = $_.Exception",
    "  while ($e.InnerException) { $e = $e.InnerException }",
    "  [Console]::Error.WriteLine($e.Message)",
    "  exit 1",
    "}"
  ].join("\n")
}

/** The arguments that run `script` (already wrapped or not) as one encoded
    command: no quoting of any kind reaches the command line. */
export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" }

/** What PowerShell printed on stderr, as plain text. Errors that escape the
    script's own catch (a parse error, say) arrive as CLIXML:
      #< CLIXML
      <Objs ...><S S="Error">Message_x000D__x000A_</S>...</Objs>
    which is unwrapped here, and the "At line:1 char:5 / + CategoryInfo"
    trailer PowerShell adds to error records is cut off. */
export function cleanPowerShellError(text: string): string {
  let plain = text
  if (/#<\s*CLIXML/.test(plain)) {
    const parts: string[] = []
    const pattern = /<S S="Error">([\s\S]*?)<\/S>/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(plain))) parts.push(match[1] ?? "")
    plain = parts.join("")
      .replace(/_x([0-9a-fA-F]{4})_/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&(lt|gt|amp|quot|apos);/g, (_all, name: string) => XML_ENTITIES[name] ?? "")
      .replace(/&#(\d+);/g, (_all, code: string) => String.fromCharCode(Number(code)))
  }
  const trailer = /\r?\n\s*(At line:\d+ char:\d+|At [^\r\n]*:\d+ char:\d+|\+ (CategoryInfo|FullyQualifiedErrorId)\b)/.exec(plain)
  if (trailer) plain = plain.slice(0, trailer.index)
  return plain.replace(/\s+/g, " ").trim()
}

/** Runs one script (wrapped here) and resolves with what it printed. */
export function runPowerShell(body: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(powershellExe(),powershellArgs(wrapScript(body)), { timeout: timeoutMs, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      // Without a message of its own, the error's text would be the whole
      // command line, encoded script included.
      const fallback = error.killed ? "PowerShell did not finish in time." : `PowerShell stopped with code ${String(error.code)}.`
      reject(new Error(cleanPowerShellError(stderr) || fallback))
    })
  })
}
