# Downloads the official Node.js build for Windows into .\runtime, checks it
# against nodejs.org's published SHA-256 sums, and unpacks it. Called by
# start.bat on the first run; nothing is installed system-wide.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Arch,
  [Parameter(Mandatory = $true)][string]$Dest
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # the progress bar makes downloads many times slower
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$name = "node-v$Version-win-$Arch"
$base = "https://nodejs.org/dist/v$Version"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("punchboard-node-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  $zip = Join-Path $tmp "$name.zip"
  Write-Host "  First run: downloading Node.js $Version (about 30 MB)..."
  Invoke-WebRequest -Uri "$base/$name.zip" -OutFile $zip -UseBasicParsing

  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $line = ($sums -split "\r?\n") | Where-Object { $_ -match "\s$([regex]::Escape($name)).zip$" } | Select-Object -First 1
  $expected = if ($line) { ($line -split "\s+")[0].ToLower() } else { "" }
  $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw "The download did not match the official checksum, so it was discarded." }

  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  Move-Item -Path (Join-Path $tmp $name) -Destination (Join-Path $Dest $name)
  Write-Host "  Node.js is ready."
  exit 0
} catch {
  Write-Host "  $($_.Exception.Message)"
  exit 1
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
