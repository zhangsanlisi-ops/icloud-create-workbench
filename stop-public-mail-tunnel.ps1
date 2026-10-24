$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $Root
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$CloudflaredPath = Join-Path $Root 'tools\cloudflared.exe'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $NodeExe -and $_.CommandLine -like '*public-mail-proxy.mjs*' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "stopped public mail proxy PID=$($_.ProcessId)"
}
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $CloudflaredPath -and $_.CommandLine -like '*cloudflared-icloud-mail.yml*' } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "stopped cloudflared tunnel PID=$($_.ProcessId)"
}
