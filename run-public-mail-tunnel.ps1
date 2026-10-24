$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeExe = (Get-Command node -ErrorAction Stop).Source
Set-Location -LiteralPath $Root
New-Item -ItemType Directory -Force -Path '.\logs' | Out-Null

try {
  $health = Invoke-RestMethod 'http://127.0.0.1:4173/api/health' -TimeoutSec 2
  if ($health.service -ne 'icloud-create-workbench') { throw '4173 is not icloud-create-workbench' }
} catch {
  throw 'Main service 4173 is not running. Start run-local.ps1 first.'
}

$proxyRunning = $false
try {
  $response = Invoke-WebRequest 'http://127.0.0.1:4174/mail/test@example.com/testtoken12345678901234567890123456789012' -UseBasicParsing -TimeoutSec 2
  $proxyRunning = $response.StatusCode -eq 200
} catch { }
if (-not $proxyRunning) {
  $proxyOut = Join-Path $Root 'logs\public-mail-proxy.log'
  $proxyErr = Join-Path $Root 'logs\public-mail-proxy-error.log'
  Start-Process -FilePath $NodeExe -ArgumentList @('scripts\public-mail-proxy.mjs') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $proxyOut -RedirectStandardError $proxyErr
  Start-Sleep -Seconds 2
}

$Cloudflared = (Resolve-Path '.\tools\cloudflared.exe').Path
$TunnelConfig = (Resolve-Path '.\config\cloudflared-icloud-mail.yml').Path
$existing = $null
try {
  $existing = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -eq $Cloudflared -and $_.CommandLine -like '*cloudflared-icloud-mail.yml*' -and $_.CommandLine -like '*--protocol*http2*' } | Select-Object -First 1
} catch {
  Write-Host "cloudflared process detection skipped: $($_.Exception.Message)"
}
if (-not $existing) {
  $cfOut = Join-Path $Root 'logs\cloudflared.log'
  $cfErr = Join-Path $Root 'logs\cloudflared-error.log'
  Start-Process -FilePath $Cloudflared -ArgumentList @('tunnel','--protocol','http2','--config',$TunnelConfig,'run') -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $cfOut -RedirectStandardError $cfErr
  Start-Sleep -Seconds 5
}

try {
  $public = Invoke-WebRequest 'https://mail.zhangbinbin.edu.kg/mail/test@example.com/testtoken12345678901234567890123456789012' -UseBasicParsing -TimeoutSec 15
  Write-Host "public mail tunnel ok: https://mail.zhangbinbin.edu.kg ($($public.StatusCode))"
} catch {
  Write-Host 'public mail tunnel started, but public verification failed:'
  Write-Host $_.Exception.Message
  if (Test-Path '.\logs\cloudflared-error.log') { Get-Content '.\logs\cloudflared-error.log' -Tail 80 }
}

