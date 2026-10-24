$ErrorActionPreference = 'Continue'
try {
  $health = Invoke-RestMethod 'http://127.0.0.1:4173/api/health' -TimeoutSec 2
  if ($health.service -ne 'icloud-create-workbench') { throw '4173 is not icloud-create-workbench' }
} catch {
  Write-Host 'iCloud Create Workbench is not confirmed running on 4173; not stopping unknown process.'
  exit 0
}
$connection = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($connection) {
  Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue
  Write-Host "stopped iCloud Create Workbench PID=$($connection.OwningProcess)"
} else {
  Write-Host 'iCloud Create Workbench is not running'
}
