// "Launch an app": start it, or bring it forward if it is already running.
//
// macOS does the right thing by itself: opening an app that runs activates it.
// Windows does not: running a Start Menu shortcut again starts the program
// again, and Chrome answers that with another window. So on Windows the
// shortcut's program is looked up among the running ones first, and if one has
// a window, that window is restored and brought to the front instead.
import { execFile } from "node:child_process"

let openModule: Promise<(target: string) => Promise<unknown>> | null = null
function loadOpen(): Promise<(target: string) => Promise<unknown>> {
  openModule ??= import("open").then((module) => module.default)
  return openModule
}

/** The PowerShell that activates or starts one shortcut or program, exposed for tests. */
export function windowsLaunchScript(target: string): string {
  const quoted = `'${target.replace(/'/g, "''")}'`
  return [
    // A program may only take the foreground from the one that has it if a key
    // was just pressed; a tap of Alt (up again at once) is the usual way through.
    `Add-Type -Name Front -Namespace Punchboard -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int cmd); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h); [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'`,
    `$target = ${quoted}`,
    "$exe = $target",
    "if ($target -match '\\.lnk$') { $exe = (New-Object -ComObject WScript.Shell).CreateShortcut($target).TargetPath }",
    "$name = [System.IO.Path]::GetFileNameWithoutExtension($exe)",
    "$running = if ($name) { Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } | Select-Object -First 1 }",
    "if ($running) {",
    "  $h = $running.MainWindowHandle",
    "  if ([Punchboard.Front]::IsIconic($h)) { [void][Punchboard.Front]::ShowWindowAsync($h, 9) }",
    "  [Punchboard.Front]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)",
    "  [Punchboard.Front]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)",
    "  [void][Punchboard.Front]::SetForegroundWindow($h)",
    "} else {",
    "  Start-Process -FilePath $target",
    "}"
  ].join("\n")
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()))
      else resolve()
    })
  })
}

export async function launchApp(target: string): Promise<void> {
  if (process.platform === "win32") {
    const encoded = Buffer.from(windowsLaunchScript(target), "utf16le").toString("base64")
    try {
      await run("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded])
    } catch (error) {
      throw new Error(`Could not open that app. (${error instanceof Error ? error.message : String(error)})`)
    }
    return
  }
  await (await loadOpen())(target)
}
