// "Launch an app": start it, or bring it forward if it is already running.
//
// macOS does the right thing by itself: opening an app that runs activates it.
// Windows does not: running a Start Menu shortcut again starts the program
// again, and Chrome answers that with another window. So on Windows the
// shortcut's program is looked up among the running ones first, and if one has
// a window, that window is restored and brought to the front instead.
//
// That only works when the program's name says which window is meant. It
// does not when the shortcut passes arguments ("Chrome - Work profile",
// a web app's --app-id, a game's -profile) or starts a launcher that runs
// something else (cmd, powershell, javaw, explorer): any window of that
// program would be the wrong one, so those shortcuts are simply started.
// Squirrel apps (Discord, Slack...) start through Update.exe --processStart
// X.exe, where X.exe is the program to look for.
import { psQuote, runPowerShell } from "./powershell.ts"

let openModule: Promise<(target: string) => Promise<unknown>> | null = null
function loadOpen(): Promise<(target: string) => Promise<unknown>> {
  openModule ??= import("open").then((module) => module.default)
  return openModule
}

/** Programs that run other things, so a window of theirs says nothing about
    which shortcut opened it. Lower case, without .exe. */
export const GENERIC_HOSTS: readonly string[] = [
  "explorer", "cmd", "powershell", "pwsh", "wt", "windowsterminal", "conhost", "wscript", "cscript", "mshta", "rundll32",
  "msiexec", "dllhost", "mmc", "control", "hh", "java", "javaw", "py", "pyw", "python", "pythonw", "node", "update"
]

const FRONT_API = [
  "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(System.IntPtr h);",
  "[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow();",
  "[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(System.IntPtr h);",
  "[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(System.IntPtr h, int cmd);",
  "[DllImport(\"user32.dll\")] public static extern bool IsIconic(System.IntPtr h);",
  "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr process);",
  "[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);",
  "[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();",
  "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);"
].join(" ")

/** The PowerShell that activates or starts one shortcut or program, exposed
    for tests. With `dryRun` it prints what it would do ("focus NAME
    running|idle" or "start REASON") and does nothing. */
export function windowsLaunchScript(target: string, dryRun = false): string {
  return [
    // Compiled every time, dry run included, so the test sees it compile.
    `Add-Type -Name Front -Namespace Punchboard -MemberDefinition ${psQuote(FRONT_API)}`,
    `$target = ${psQuote(target)}`,
    `$hosts = @(${GENERIC_HOSTS.map(psQuote).join(", ")})`,
    // The program to look for among the running ones; empty when the
    // shortcut cannot be matched to one window, $why says why.
    "$exe = ''",
    "$why = 'not a program'",
    "if ($target -match '\\.lnk$') {",
    "  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($target)",
    "  $arguments = [string]$link.Arguments",
    "  $exe = [string]$link.TargetPath",
    "  if ([System.IO.Path]::GetFileName($exe) -eq 'Update.exe' -and $arguments -match '^\\s*--processStart\\s+(?:\"([^\"]+)\"|(\\S+))\\s*$') {",
    "    $exe = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }",
    "  } elseif ($arguments.Trim()) {",
    "    $exe = ''",
    "    $why = 'arguments'",
    "  }",
    "} elseif ($target -match '\\.exe$') {",
    "  $exe = $target",
    "}",
    "$name = ''",
    "if ($exe -match '\\.exe$') {",
    "  $name = [System.IO.Path]::GetFileNameWithoutExtension($exe)",
    "  if ($hosts -contains $name) { $why = 'launcher ' + $name; $name = '' }",
    "}",
    "$running = $null",
    "if ($name) {",
    "  $running = Get-Process -Name ([WildcardPattern]::Escape($name)) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } | Select-Object -First 1",
    "}",
    dryRun
      ? "if ($name) { Write-Output ('focus ' + $name + ' ' + $(if ($running) { 'running' } else { 'idle' })) } else { Write-Output ('start ' + $why) }; exit 0"
      : "",
    "if ($running) {",
    "  $h = $running.MainWindowHandle",
    "  if ([Punchboard.Front]::IsIconic($h)) { [void][Punchboard.Front]::ShowWindowAsync($h, 9) }",
    // Windows lets a program take the foreground only if it sent the last
    // input. A tap of VK 0xE8, a key no keyboard has (AutoHotkey uses it for
    // the same reason), earns that without doing anything: Alt, the usual
    // choice, opens the menu bar of the app in front.
    "  [Punchboard.Front]::keybd_event(0xE8, 0, 0, [System.UIntPtr]::Zero)",
    "  [Punchboard.Front]::keybd_event(0xE8, 0, 2, [System.UIntPtr]::Zero)",
    "  $front = [Punchboard.Front]::SetForegroundWindow($h)",
    "  if (-not $front) {",
    // Second try: borrow the input queue of the window in front, which may
    // always hand the foreground on.
    "    $me = [Punchboard.Front]::GetCurrentThreadId()",
    "    $other = [Punchboard.Front]::GetWindowThreadProcessId([Punchboard.Front]::GetForegroundWindow(), [System.IntPtr]::Zero)",
    "    if ($other -and $other -ne $me -and [Punchboard.Front]::AttachThreadInput($me, $other, $true)) {",
    "      try {",
    "        [void][Punchboard.Front]::BringWindowToTop($h)",
    "        $front = [Punchboard.Front]::SetForegroundWindow($h)",
    "      } finally {",
    "        [void][Punchboard.Front]::AttachThreadInput($me, $other, $false)",
    "      }",
    "    }",
    "  }",
    // If Windows still says no, start the shortcut as the Start Menu would:
    // most apps run one copy and come forward themselves when started again
    // (Windows allows them), and at worst one opens another window, which
    // beats a button that seems to do nothing.
    "  if ($front) { exit 0 }",
    "}",
    // ShellExecute, as a double-click does; unlike Start-Process it reads no
    // wildcards, so a [ or ] in the path is just a character.
    "$start = New-Object System.Diagnostics.ProcessStartInfo",
    "$start.FileName = $target",
    "$start.UseShellExecute = $true",
    "[void][System.Diagnostics.Process]::Start($start)"
  ].filter(Boolean).join("\n")
}

export async function launchApp(target: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      await runPowerShell(windowsLaunchScript(target), 15000)
    } catch (error) {
      throw new Error(`Could not open that app. (${error instanceof Error ? error.message : String(error)})`)
    }
    return
  }
  await (await loadOpen())(target)
}
