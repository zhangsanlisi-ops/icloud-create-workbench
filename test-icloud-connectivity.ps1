param(
  [string]$Proxy = ""
)

$ErrorActionPreference = "Continue"
$targets = @(
  "setup.icloud.com.cn",
  "setup.icloud.com",
  "p217-maildomainws.icloud.com.cn",
  "p68-maildomainws.icloud.com"
)

if ($Proxy) {
  $env:HTTPS_PROXY = $Proxy
  $env:HTTP_PROXY = $Proxy
  $env:NO_PROXY = "127.0.0.1,localhost"
  Write-Host "Using proxy: $Proxy"
} else {
  Write-Host "No proxy env set. Use -Proxy http://127.0.0.1:7890 if needed."
}

Write-Host "`n== PowerShell TCP test =="
foreach ($target in $targets) {
  try {
    $r = Test-NetConnection $target -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue
    Write-Host ($target.PadRight(36) + " TCP443=" + $r)
  } catch {
    Write-Host ($target.PadRight(36) + " ERROR=" + $_.Exception.Message)
  }
}

Write-Host "`n== Python aiohttp test =="
$py = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
$code = @"
import asyncio, os, aiohttp, ssl, certifi
urls = [
 'https://setup.icloud.com.cn/setup/ws/1/validate',
 'https://setup.icloud.com/setup/ws/1/validate',
]
async def main():
    connector=aiohttp.TCPConnector(ssl_context=ssl.create_default_context(cafile=certifi.where()))
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8), connector=connector, trust_env=True) as s:
        for url in urls:
            try:
                async with s.get(url, headers={'User-Agent':'Mozilla/5.0','Accept':'*/*'}) as r:
                    print(url, 'HTTP', r.status)
            except Exception as e:
                print(url, type(e).__name__, str(e))
asyncio.run(main())
"@
$tmp = New-TemporaryFile
Set-Content -LiteralPath $tmp -Value $code -Encoding UTF8
& $py $tmp
Remove-Item $tmp -Force

Write-Host "`n== Local workbench =="
try { Invoke-RestMethod http://127.0.0.1:4173/api/health -TimeoutSec 3 | ConvertTo-Json -Compress } catch { Write-Host $_.Exception.Message }
