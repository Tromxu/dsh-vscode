# package.ps1 - Build a .vsix by hand (OPC layout), no vsce/npm/network needed.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package.ps1
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less
# UTF-8 as ANSI/GBK, and a non-ASCII trailing byte can swallow the next
# line's leading "$", silently breaking assignments.
$ErrorActionPreference = "Stop"

# Self-locating root (works with -File and from any CWD).
if ($PSScriptRoot) {
  $root = Split-Path -Parent $PSScriptRoot
} else {
  $scriptPath = $MyInvocation.MyCommand.Path
  if (-not $scriptPath) { throw "Cannot locate package.ps1" }
  $root = Split-Path -Parent (Split-Path -Parent $scriptPath)
}

$pkg = Get-Content (Join-Path $root "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$name = $pkg.name
$version = $pkg.version
$vsixName = "$name-$version.vsix"
$staging = Join-Path $root ".vsix-stage"
$vsix = Join-Path $root $vsixName

if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
if (Test-Path $vsix) { Remove-Item $vsix -Force }

New-Item -ItemType Directory -Force -Path (Join-Path $staging "extension") | Out-Null

# Extension payload
Copy-Item (Join-Path $root "package.json") (Join-Path $staging "extension\package.json")
Copy-Item (Join-Path $root "src") (Join-Path $staging "extension\src") -Recurse
Copy-Item (Join-Path $root "media") (Join-Path $staging "extension\media") -Recurse
if (Test-Path (Join-Path $root "README.md")) {
  Copy-Item (Join-Path $root "README.md") (Join-Path $staging "extension\README.md")
}
if (Test-Path (Join-Path $root "LICENSE")) {
  Copy-Item (Join-Path $root "LICENSE") (Join-Path $staging "extension\LICENSE")
}

# Vendor the `ws` WebSocket client from the DSH runtime (no deps, no network needed)
# Locate the harness: env DSH_HARNESS first, then standard install paths.
$harnessRoot = $env:DSH_HARNESS
if (-not $harnessRoot) {
  $cands = @()
  if ($env:LOCALAPPDATA) { $cands += "$env:LOCALAPPDATA\Programs\DeepSeek Harness" }
  if ($env:ProgramFiles) { $cands += "$env:ProgramFiles\DeepSeek Harness" }
  if (${env:ProgramFiles(x86)}) { $cands += "${env:ProgramFiles(x86)}\DeepSeek Harness" }
  foreach ($c in $cands) {
    if (Test-Path (Join-Path $c "resources\dsh\vendor\node_modules\@deepseek-ai\dsh\lib\bin.js")) {
      $harnessRoot = $c
      break
    }
  }
}
# Prefer the project's own node_modules/ws (from `npm install`) if present.
$vendorWs = $null
if (Test-Path (Join-Path $root "node_modules\ws\package.json")) {
  $vendorWs = Join-Path $root "node_modules\ws"
} elseif ($harnessRoot) {
  $candidate = Join-Path $harnessRoot "resources\dsh\vendor\node_modules\ws"
  if (Test-Path $candidate) { $vendorWs = $candidate }
}
if ($vendorWs) {
  New-Item -ItemType Directory -Force -Path (Join-Path $staging "extension\node_modules") | Out-Null
  Copy-Item $vendorWs (Join-Path $staging "extension\node_modules\ws") -Recurse
  Write-Output "Vendored ws -> extension/node_modules/ws"
} else {
  Write-Warning "ws not found (run 'npm install' or set DSH_HARNESS); session client will fail at runtime"
}

# OPC manifests (filename contains brackets: use -LiteralPath)
Copy-Item -LiteralPath (Join-Path $root "packaging\[Content_Types].xml") (Join-Path $staging "[Content_Types].xml")
Copy-Item (Join-Path $root "packaging\extension.vsixmanifest") (Join-Path $staging "extension.vsixmanifest")

# Zip the staging contents (so [Content_Types].xml sits at the zip root), then rename to .vsix
$zipTmp = Join-Path $root ".vsix-tmp.zip"
if (Test-Path $zipTmp) { Remove-Item $zipTmp -Force }
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipTmp -Force
Rename-Item $zipTmp $vsix

Remove-Item $staging -Recurse -Force
Write-Output "VSIX ready: $vsix"
