# ============================================================
# Gemini Relay Studio - Download portable Node.js 24 (Windows)
# ============================================================
$ErrorActionPreference = "Stop"

$dest = Join-Path $PSScriptRoot "node_runtime"
if (!(Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }

Write-Host "[Gemini Relay] Fetching latest Node.js 24 version info..."

try {
    $idx = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing
} catch {
    Write-Host "[ERROR] Cannot reach nodejs.org. Check your internet connection."
    exit 1
}

$v = ($idx | Where-Object { $_.version -like "v24.*" } | Select-Object -First 1).version
if (!$v) {
    Write-Host "[ERROR] Could not find Node.js v24 in release list."
    exit 1
}

Write-Host "[Gemini Relay] Downloading Node.js $v (Windows x64)..."

$zip = Join-Path $dest "_node_download.zip"
$url = "https://nodejs.org/dist/$v/node-$v-win-x64.zip"

try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
} catch {
    Write-Host "[ERROR] Download failed: $_"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    exit 1
}

Write-Host "[Gemini Relay] Extracting node.exe..."

Add-Type -AssemblyName System.IO.Compression.FileSystem
$z     = [IO.Compression.ZipFile]::OpenRead($zip)
$entry = $z.Entries | Where-Object { $_.Name -eq "node.exe" } | Select-Object -First 1

if (!$entry) {
    $z.Dispose()
    Remove-Item $zip -Force
    Write-Host "[ERROR] node.exe not found in archive."
    exit 1
}

$nodePath = Join-Path $dest "node.exe"
[IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $nodePath, $true)
$z.Dispose()
Remove-Item $zip -Force

Write-Host "[Gemini Relay] Node.js $v is ready."
