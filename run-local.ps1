$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = (Get-Command node -ErrorAction Stop).Source
Set-Location -LiteralPath $Root
New-Item -ItemType Directory -Force -Path '.\logs', '.\data' | Out-Null

try {
  $existingHealth = Invoke-RestMethod 'http://127.0.0.1:4173/api/health' -TimeoutSec 2
  if ($existingHealth.service -eq 'icloud-create-workbench') {
    Write-Host 'already running: http://127.0.0.1:4173'
    exit 0
  }
} catch {}

$occupied = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($occupied) { throw "Port 4173 is occupied by PID=$($occupied.OwningProcess), not starting." }

if (-not (Test-Path $NodeExe)) { throw "Node not found: $NodeExe" }
if (-not (Test-Path '.\.env')) { throw 'Missing .env' }
if (-not (Test-Path '.\frontend\apps\admin\dist\index.html')) { throw 'Missing frontend build: frontend\apps\admin\dist\index.html' }
if (-not (Test-Path '.\.venv\Scripts\python.exe')) { throw 'Missing Python venv: .venv\Scripts\python.exe' }

$py = (Resolve-Path '.\.venv\Scripts\python.exe').Path
$db = (Join-Path $Root 'data\workbench.db')
$stdout = Join-Path $Root 'logs\server.log'
$stderr = Join-Path $Root 'logs\server-error.log'
$cmdFile = Join-Path $Root 'logs\run-server.cmd'
"[$(Get-Date -Format s)] starting iCloud Create Workbench" | Add-Content -LiteralPath $stdout -Encoding UTF8

$cmdLines = New-Object System.Collections.Generic.List[string]
$cmdLines.Add('@echo off')
$cmdLines.Add(('cd /d "{0}"' -f $Root))
$cmdLines.Add(('set "PYTHON_COMMAND={0}"' -f $py))
$cmdLines.Add(('set "DATABASE_PATH={0}"' -f $db))
$cmdLines.Add('set "HOST=127.0.0.1"')
$cmdLines.Add('set "PORT=4173"')
$cmdLines.Add(('"{0}" src/server.mjs >> "{1}" 2>> "{2}"' -f $NodeExe, $stdout, $stderr))
Set-Content -LiteralPath $cmdFile -Value $cmdLines.ToArray() -Encoding ASCII
Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c', ('"' + $cmdFile + '"')) -WorkingDirectory $Root -WindowStyle Hidden

for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod 'http://127.0.0.1:4173/api/health' -TimeoutSec 2
    if ($health.service -eq 'icloud-create-workbench') {
      $health | ConvertTo-Json -Compress
      Write-Host 'started: http://127.0.0.1:4173'
      exit 0
    }
  } catch {}
  $port = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($port -and $attempt -gt 4) {
    Write-Host "port 4173 listening PID=$($port.OwningProcess), waiting for health..."
  }
}

Write-Host 'start failed, run cmd:'
Get-Content -LiteralPath $cmdFile -ErrorAction SilentlyContinue
Write-Host 'stderr tail:'
if (Test-Path $stderr) { Get-Content -Tail 120 $stderr }
exit 1

