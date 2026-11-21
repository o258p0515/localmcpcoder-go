# =============================================================================
#  localmcpcoder — starts ONLY the MCP server, without a tunnel.
#
#  Use this when your tunnel already runs on its own, e.g. a Cloudflare named
#  tunnel installed as a Windows service. Otherwise use start.ps1, which also
#  opens a free quick tunnel for you.
#
#  Usage:  .\start-server.ps1
#          .\start-server.ps1 -Root "C:\Users\me\projects"
#          .\start-server.ps1 -AllowOutsideRoot      # whole disk — dangerous
# =============================================================================
param(
  [string]$Root = $PSScriptRoot,
  [int]$Port = 8787,
  [switch]$AllowOutsideRoot
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$envFile = Join-Path $here ".env"

# --- Persistent access token (same one start.ps1 uses) -----------------------
if (Test-Path $envFile) {
  $token = (Get-Content $envFile | Where-Object { $_ -match "^MCP_TOKEN=" }) -replace "^MCP_TOKEN=", ""
}
if (-not $token -or $token.Length -lt 16) {
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
  "MCP_TOKEN=$token" | Out-File -FilePath $envFile -Encoding utf8
  Write-Host "New token generated and saved to .env" -ForegroundColor Yellow
}

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $pids = ($busy | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  Write-Host "Port $Port is already in use (PID: $pids). Stop it or use -Port 8788." -ForegroundColor Red
  exit 1
}

$env:MCP_TOKEN = $token
$env:MCP_ROOT = (Resolve-Path $Root).Path
$env:MCP_PORT = "$Port"
$env:MCP_ALLOW_OUTSIDE_ROOT = if ($AllowOutsideRoot) { "1" } else { "0" }

# --- Tunnel status -----------------------------------------------------------
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($svc) {
  $color = if ($svc.Status -eq "Running") { "Green" } else { "Red" }
  Write-Host "cloudflared service: $($svc.Status)" -ForegroundColor $color
} else {
  Write-Host "Note: no cloudflared service installed. Use start.ps1 for a quick tunnel." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Connector URL: https://<your-hostname>/mcp   (Authentication: OAuth)" -ForegroundColor Cyan
Write-Host "Passphrase the consent page will ask for:" -ForegroundColor Cyan
Write-Host "   $token" -ForegroundColor White
Write-Host ""

node "$here\server.js"
