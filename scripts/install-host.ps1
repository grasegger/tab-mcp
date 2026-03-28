# install-host.ps1 – install the tab-mcp native messaging host on Windows
#
# Usage (PowerShell, run as normal user):
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\scripts\install-host.ps1

$ErrorActionPreference = "Stop"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir    = Split-Path -Parent $ScriptDir
$HostDir    = Join-Path $RepoDir "native-host"

Write-Host "==> Installing npm dependencies in native-host/ ..."
Push-Location $HostDir
if (Test-Path (Join-Path $HostDir "package-lock.json")) {
  npm ci --omit=dev
} else {
  npm install --omit=dev
}
Pop-Location

# Create wrapper batch file (UTF-8 so the file is valid ASCII/UTF-8 on all Windows versions)
$WrapperPath = Join-Path $HostDir "run.bat"
$IndexPath   = Join-Path $HostDir "index.js"
Set-Content -Path $WrapperPath -Value "@echo off`r`nnode `"$IndexPath`" %*" -Encoding UTF8

# Native messaging manifest destination (per-user HKCU)
$ManifestDir  = Join-Path $env:APPDATA "Mozilla\NativeMessagingHosts"
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null
$ManifestDest = Join-Path $ManifestDir "tab_mcp_host.json"

# Read template and substitute path (use forward slashes for JSON safety)
$Template = Get-Content (Join-Path $HostDir "host-manifest.json") -Raw -Encoding UTF8
$Template  = $Template -replace "PATH_PLACEHOLDER", ($WrapperPath -replace "\\", "/")
Set-Content -Path $ManifestDest -Value $Template -Encoding UTF8

# Register in Windows registry so Firefox can discover it
$RegPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\tab_mcp_host"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestDest

Write-Host ""
Write-Host "✅ Native messaging host installed."
Write-Host "   Manifest : $ManifestDest"
Write-Host "   Registry : $RegPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Load the extension in Firefox: about:debugging -> Load Temporary Add-on -> extension\manifest.json"
Write-Host "  2. Point your MCP client at: http://127.0.0.1:3712/mcp"
