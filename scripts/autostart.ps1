# autostart.ps1 - idempotent launcher (ASCII only on purpose:
# Windows PowerShell 5.1 mis-parses UTF-8 without BOM, keep this file plain).
#
#   - start server if port 8788 is not listening
#   - start metrics pump if not running
#   - start data pump if not running
# Running twice will not create duplicates.

$ErrorActionPreference = "SilentlyContinue"
$root = "{{ROOT}}"
Set-Location $root
New-Item -ItemType Directory -Force -Path logs | Out-Null

function Port-Up($p) {
  return [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

function Has-Process($needle) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'"
  foreach ($p in $procs) {
    if ($p.CommandLine -like "*$needle*" -and $p.CommandLine -notlike "*runner.js*") { return $true }
  }
  return $false
}

function Log($msg) {
  "[$(Get-Date -f HH:mm:ss)] $msg" | Add-Content "$root\logs\autostart.log"
}

# 0) watchdog first: it brings up server + pumps by itself and keeps them alive
if (-not (Has-Process "keepalive.mjs")) {
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "keepalive.mjs" -WorkingDirectory $root -RedirectStandardOutput "$root\logs\keepalive-out.log" -RedirectStandardError "$root\logs\keepalive-err.log"
  Log "watchdog started"
  Start-Sleep -Seconds 6
} else {
  Log "watchdog running"
}

# 1) server
if (-not (Port-Up 8788)) {
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "server.mjs" -WorkingDirectory $root -RedirectStandardOutput "$root\logs\server.log" -RedirectStandardError "$root\logs\server.err.log"
  Start-Sleep -Seconds 2
  Log "server started"
} else {
  Log "server already up"
}

# 2) metrics pump: every 5 min, 21 dashboard metrics
if (-not (Has-Process "shop_demo-browser")) {
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "watch.mjs","--connectors","shop_demo-browser","--every","300" -WorkingDirectory $root -RedirectStandardOutput "$root\logs\watch-metrics.log" -RedirectStandardError "$root\logs\watch-metrics.err.log"
  Log "metrics pump started"
} else {
  Log "metrics pump running"
}

# 3) data pump: every 10 min, orders + products
if (-not (Has-Process "doudian-orders")) {
  Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "watch.mjs","--connectors","doudian-orders,doudian-products","--every","600" -WorkingDirectory $root -RedirectStandardOutput "$root\logs\watch-data.log" -RedirectStandardError "$root\logs\watch-data.err.log"
  Log "data pump started"
} else {
  Log "data pump running"
}
