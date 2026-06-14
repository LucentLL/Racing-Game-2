# Rebuild the standalone Driver City desktop app into .\app\.
# Run this after code changes; close the running app first (the exe locks while open).
# The app is a dev-mode frontend bundled into a debug Tauri shell (editor + dev tools intact).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# Free the exe if the app is open. The dev binary builds as 'driver-city'
# but is copied to app\DriverCity.exe, which runs as the process
# 'DriverCity' — stop BOTH names or the copy below fails on a locked file.
Get-Process driver-city, DriverCity -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

Push-Location $root
try {
  npm run tauri:build -- --debug --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
  $dbg = Join-Path $root 'src-tauri\target\debug'
  $app = Join-Path $root 'app'
  New-Item -ItemType Directory -Force -Path $app | Out-Null
  Copy-Item (Join-Path $dbg 'driver-city.exe')      (Join-Path $app 'DriverCity.exe')       -Force
  Copy-Item (Join-Path $dbg 'driver_city_lib.dll')  (Join-Path $app 'driver_city_lib.dll')  -Force
  Write-Host "Updated $app\DriverCity.exe" -ForegroundColor Green
} finally {
  Pop-Location
}
