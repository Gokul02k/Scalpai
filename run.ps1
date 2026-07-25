# Start ScalpAI (Next.js) in the background and print the local + network URLs.
#
# Usage (PowerShell):
#   .\run.ps1                 # start on port 3000 (default)
#   .\run.ps1 -Port 4000      # start on a custom port
#   .\run.ps1 stop            # stop the background server
#   .\run.ps1 logs            # follow the server logs
#
# If you get an execution-policy error, run it like this instead:
#   powershell -ExecutionPolicy Bypass -File .\run.ps1

param(
  [string]$Command = "start",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$LogFile = Join-Path $PSScriptRoot "dev-server.log"
$PidFile = Join-Path $PSScriptRoot "dev-server.pid"

function Stop-Server {
  if (Test-Path $PidFile) {
    $serverPid = (Get-Content $PidFile | Select-Object -First 1).Trim()
    if ($serverPid) {
      Write-Host "Stopping ScalpAI (PID $serverPid)..."
      # /T also kills the child node process that npm spawned.
      taskkill /PID $serverPid /T /F 2>$null | Out-Null
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host "Stopped."
  }
  else {
    Write-Host "No running instance found."
  }
}

function Get-LanIp {
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      Select-Object -First 1 -ExpandProperty IPAddress
    return $ip
  }
  catch { return $null }
}

switch ($Command.ToLower()) {
  "stop" { Stop-Server; return }
  "logs" {
    if (Test-Path $LogFile) { Get-Content $LogFile -Wait } else { Write-Host "No log file yet." }
    return
  }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm was not found. Install Node.js (which includes npm) from https://nodejs.org and reopen PowerShell."
  return
}

# Install dependencies on first run.
if (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
  Write-Host "Installing dependencies (first run, this can take a minute)..."
  npm install
}

# Restart cleanly if already running.
if (Test-Path $PidFile) {
  $existingPid = (Get-Content $PidFile | Select-Object -First 1).Trim()
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Write-Host "ScalpAI is already running (PID $existingPid). Restarting..."
    Stop-Server
    Start-Sleep -Seconds 1
  }
}

Write-Host "Starting ScalpAI on port $Port..."
# -H 0.0.0.0 lets other devices on your Wi-Fi (e.g. your phone) reach it too.
# cmd /c handles the log redirection so both stdout and stderr land in one file.
$cmdLine = "npm run dev -- -p $Port -H 0.0.0.0 > `"$LogFile`" 2>&1"
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", $cmdLine -WindowStyle Hidden -PassThru
$proc.Id | Out-File -FilePath $PidFile -Encoding ascii

# Wait for the dev server to report it is ready (up to ~40s).
Write-Host -NoNewline "Waiting for the server to be ready"
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  if ((Test-Path $LogFile) -and (Select-String -Path $LogFile -Pattern "Ready in|started server|Local:" -Quiet)) {
    $ready = $true
    break
  }
  if ($proc.HasExited) {
    Write-Host ""
    Write-Host "Server failed to start. Recent logs:" -ForegroundColor Red
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 20 }
    return
  }
  Write-Host -NoNewline "."
  Start-Sleep -Seconds 1
}
Write-Host ""

$lanIp = Get-LanIp

Write-Host ""
Write-Host "======================================================"
Write-Host "  ScalpAI is running in the background"
Write-Host "  Port:     $Port"
Write-Host "  Local:    http://localhost:$Port"
if ($lanIp) {
  Write-Host "  Network:  http://${lanIp}:$Port   (open this on your phone, same Wi-Fi)"
}
Write-Host "  PID:      $($proc.Id)"
Write-Host "  Logs:     dev-server.log   (view with: .\run.ps1 logs)"
Write-Host "  Stop:     .\run.ps1 stop"
Write-Host "======================================================"
if (-not $ready) {
  Write-Host "(Server is still starting - give it a few more seconds, then open the link.)" -ForegroundColor Yellow
}
