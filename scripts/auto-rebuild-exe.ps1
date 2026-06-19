# Claude Code Stop-hook helper — rebuild app\DriverCity.exe automatically,
# but ONLY when a frontend/shell source changed since the last build. This
# keeps conversational turns instant (no Rust/vite build) while guaranteeing
# the exe the user runs is always current after a code change.
#
# Wired via the Stop hook in .claude/settings.json. For a forced/manual
# full rebuild, run .\build-standalone.ps1 directly.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$exe  = Join-Path $root 'app\DriverCity.exe'

# --- Freshness guard --------------------------------------------------------
# Source inputs whose change requires re-embedding the frontend or
# recompiling the Tauri shell. Build outputs (dist\, src-tauri\target\) are
# intentionally excluded so a build never re-triggers itself.
$inputDirs = @('src', 'public', 'src-tauri\src') |
  ForEach-Object { Join-Path $root $_ }
$inputFiles = @(
  'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts',
  'src-tauri\Cargo.toml', 'src-tauri\tauri.conf.json'
) | ForEach-Object { Join-Path $root $_ }

$newest = [DateTime]::MinValue
foreach ($d in $inputDirs) {
  if (Test-Path $d) {
    $f = Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($f -and $f.LastWriteTimeUtc -gt $newest) { $newest = $f.LastWriteTimeUtc }
  }
}
foreach ($p in $inputFiles) {
  if (Test-Path $p) {
    $t = (Get-Item $p).LastWriteTimeUtc
    if ($t -gt $newest) { $newest = $t }
  }
}

if ((Test-Path $exe) -and ((Get-Item $exe).LastWriteTimeUtc -ge $newest)) {
  Write-Host 'auto-rebuild: app\DriverCity.exe is current - skipping build.'
  exit 0
}

# --- Build ------------------------------------------------------------------
# Make node + cargo reachable regardless of the environment the hook is
# launched from, then delegate to the single source-of-truth build script.
Write-Host 'auto-rebuild: source changed - rebuilding app\DriverCity.exe...'
$env:Path = "C:\Program Files\nodejs;$env:USERPROFILE\.cargo\bin;$env:Path"
& (Join-Path $root 'build-standalone.ps1')
exit $LASTEXITCODE
