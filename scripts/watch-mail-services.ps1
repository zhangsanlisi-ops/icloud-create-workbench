$ErrorActionPreference = 'SilentlyContinue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Log = Join-Path $Root 'logs\mail-services-watcher.log'
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
$mutex = New-Object System.Threading.Mutex($false, 'Local\iCloudMailServicesWatcher')
if (-not $mutex.WaitOne(0)) {
  "[$(Get-Date -Format s)] watcher already running; exit" | Add-Content -LiteralPath $Log -Encoding UTF8
  exit 0
}
function Write-WatcherLog([string]$Message) {
  "[$(Get-Date -Format s)] $Message" | Add-Content -LiteralPath $Log -Encoding UTF8
}
function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(1000, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false }
  finally { try { $client.Close() } catch {} }
}
try {
  Write-WatcherLog 'watcher started'
  while ($true) {
    Set-Location -LiteralPath $Root
    if (-not (Test-Port 4173)) {
      Write-WatcherLog '4173 down; starting main service'
      Start-Process -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $Root 'run-local.ps1')) -WorkingDirectory $Root
      Start-Sleep -Seconds 8
    }
    if (-not (Test-Port 4174)) {
      Write-WatcherLog '4174 down; starting public mail proxy'
      Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList @('/d','/c','"scripts\start-mail-proxy.cmd"') -WorkingDirectory $Root
      Start-Sleep -Seconds 3
    }
    Start-Sleep -Seconds 20
  }
} finally {
  try { $mutex.ReleaseMutex() | Out-Null } catch {}
  try { $mutex.Dispose() } catch {}
}
