# =============================================================================
#  localmcpcoder — starts the MCP server AND a free Cloudflare quick tunnel.
#
#  Usage:  .\start.ps1
#          .\start.ps1 -Root "C:\Users\me\projects"
#          .\start.ps1 -Port 8788
#          .\start.ps1 -AllowOutsideRoot      # whole disk — dangerous
# =============================================================================
param(
  [string]$Root = $PSScriptRoot,
  [int]$Port = 8787,
  [switch]$AllowOutsideRoot
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$envFile = Join-Path $here ".env"

# --- 1. Persistent access token ---------------------------------------------
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

# --- 2. Locate cloudflared ---------------------------------------------------
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  $cf = "$env:ProgramFiles\cloudflared\cloudflared.exe"
  if (-not (Test-Path $cf)) {
    Write-Host "cloudflared not found. Install it with:" -ForegroundColor Red
    Write-Host "  winget install --id Cloudflare.cloudflared -e" -ForegroundColor Red
    Write-Host "then open a new terminal and try again." -ForegroundColor Red
    exit 1
  }
}

# --- 3. MCP server -----------------------------------------------------------
# Make sure the port is free: if something else is already listening, the health
# check below would report a false "OK" against that other process.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $pids = ($busy | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
  Write-Host ""
  Write-Host "Port $Port is already in use (PID: $pids)." -ForegroundColor Red
  Write-Host "There is probably another copy of localmcpcoder running. You can:" -ForegroundColor Red
  Write-Host "  - close the other PowerShell window running it, or" -ForegroundColor Red
  Write-Host "  - Stop-Process -Id $pids -Force" -ForegroundColor Red
  Write-Host "  - or use another port:  .\start.ps1 -Port 8788" -ForegroundColor Red
  exit 1
}

$env:MCP_TOKEN = $token
$env:MCP_ROOT = (Resolve-Path $Root).Path
$env:MCP_PORT = "$Port"
$env:MCP_ALLOW_OUTSIDE_ROOT = if ($AllowOutsideRoot) { "1" } else { "0" }

Write-Host ""
Write-Host "Starting MCP server..." -ForegroundColor Cyan
$runId = "$PID-$(Get-Date -Format 'HHmmss')"
$srvOut = Join-Path $env:TEMP "localmcpcoder-server-$runId.log"
$server = Start-Process node -ArgumentList "`"$here\server.js`"" `
  -PassThru -NoNewWindow -RedirectStandardOutput $srvOut -RedirectStandardError "$srvOut.err"

# Wait until it is actually listening
$listening = $false
foreach ($i in 1..30) {
  Start-Sleep -Milliseconds 400
  try {
    $null = Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
    $listening = $true
    break
  } catch {}
}
if (-not $listening) {
  Write-Host "The server failed to start. Log:" -ForegroundColor Red
  if (Test-Path "$srvOut.err") { Get-Content "$srvOut.err" }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  exit 1
}
Write-Host "  OK - listening on 127.0.0.1:$Port" -ForegroundColor Green

# --- 4. Cloudflare quick tunnel ---------------------------------------------
Write-Host "Opening Cloudflare tunnel (free, no account needed)..." -ForegroundColor Cyan
$tunOut = Join-Path $env:TEMP "localmcpcoder-tunnel-$runId.log"
Remove-Item $tunOut -Force -ErrorAction SilentlyContinue
$tunnel = Start-Process $cf -ArgumentList "tunnel", "--url", "http://localhost:$Port", "--no-autoupdate" `
  -PassThru -NoNewWindow -RedirectStandardOutput "$tunOut.out" -RedirectStandardError $tunOut

$publicUrl = $null
foreach ($i in 1..60) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $tunOut) {
    $m = Select-String -Path $tunOut -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue |
         Select-Object -First 1
    if ($m) { $publicUrl = $m.Matches[0].Value; break }
  }
}

if (-not $publicUrl) {
  Write-Host "Could not get the tunnel URL. Log: $tunOut" -ForegroundColor Red
  Stop-Process -Id $server.Id -Force
  if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
  exit 1
}

$fullUrl = "$publicUrl/mcp"

Write-Host ""
Write-Host "=============================================================" -ForegroundColor Green
Write-Host " READY. Paste this URL into your MCP client:" -ForegroundColor Green
Write-Host ""
Write-Host "   $fullUrl" -ForegroundColor White
Write-Host ""
Write-Host " Authentication: OAuth. Leave client ID and secret blank —" -ForegroundColor Green
Write-Host " the client registers itself." -ForegroundColor Green
Write-Host ""
Write-Host " Then the browser will ask for this passphrase:" -ForegroundColor Green
Write-Host ""
Write-Host "   $token" -ForegroundColor White
Write-Host ""
Write-Host " Exposed folder: $env:MCP_ROOT" -ForegroundColor Green
Write-Host "=============================================================" -ForegroundColor Green
Write-Host ""
Set-Clipboard -Value $fullUrl -ErrorAction SilentlyContinue
Write-Host "(URL copied to the clipboard. Press Ctrl+C to shut everything down.)" -ForegroundColor DarkGray
Write-Host "(The passphrase is also in .env, and never travels in a URL.)" -ForegroundColor DarkGray
Write-Host ""

# --- 5. Stay alive, clean up on exit -----------------------------------------
try {
  while ($true) {
    Start-Sleep -Seconds 2
    if ($server.HasExited) { Write-Host "The MCP server stopped." -ForegroundColor Red; break }
    if ($tunnel.HasExited) { Write-Host "The tunnel stopped." -ForegroundColor Red; break }
  }
} finally {
  Write-Host "Shutting down..." -ForegroundColor Yellow
  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue }
}
