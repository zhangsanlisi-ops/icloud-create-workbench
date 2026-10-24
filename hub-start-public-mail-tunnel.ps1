$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 3) {
  try {
    $r = Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return [int]$r.StatusCode -ge 200 -and [int]$r.StatusCode -lt 500
  } catch {
    return $false
  }
}

New-Item -ItemType Directory -Force -Path '.\logs' | Out-Null

# 1) Ensure main iCloud workbench source service is running on 4173.
if (-not (Test-HttpOk 'http://127.0.0.1:4173/api/health' 3)) {
  Write-Host '[hub-start-public-mail-tunnel] 4173 not running, starting run-local.ps1 first...'
  $mainOut = Join-Path $Root 'logs\hub-start-main.out.log'
  $mainErr = Join-Path $Root 'logs\hub-start-main.err.log'
  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', (Join-Path $Root 'run-local.ps1')) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $mainOut -RedirectStandardError $mainErr
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-HttpOk 'http://127.0.0.1:4173/api/health' 3) { $ok = $true; break }
  }
  if (-not $ok) {
    Write-Host '[hub-start-public-mail-tunnel] 4173 failed to start. Last stderr:'
    if (Test-Path $mainErr) { Get-Content $mainErr -Tail 80 }
    throw 'Main service 4173 failed to start'
  }
}

# 2) Start/verify public mail proxy 4174 and Cloudflare tunnel.
& (Join-Path $Root 'run-public-mail-tunnel.ps1')

# 3) Final source checks.
if (-not (Test-HttpOk 'http://127.0.0.1:4174/mail/test@example.com/testtoken12345678901234567890123456789012' 5)) {
  throw 'Public mail proxy 4174 is not reachable after start'
}
Write-Host '[hub-start-public-mail-tunnel] local source OK: 4173 + 4174'
