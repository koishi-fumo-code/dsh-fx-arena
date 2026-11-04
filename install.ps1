# dsh-fx-arena one-click installer (Windows)
# Finds a Node 22+ runtime: PATH node first, then the runtime bundled with DeepSeek Harness.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [--dry] [--profiles a,b]
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-NodeRuntime {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return @{ Exe = $cmd.Source; Electron = $false } }

  if ($env:DSH_DESKTOP_NODE_EXECUTABLE -and (Test-Path -LiteralPath $env:DSH_DESKTOP_NODE_EXECUTABLE)) {
    return @{ Exe = $env:DSH_DESKTOP_NODE_EXECUTABLE; Electron = $true }
  }

  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $pf86exe = $null
  if ($pf86) { $pf86exe = Join-Path $pf86 'DeepSeek Harness\DeepSeek Harness.exe' }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe'),
    $pf86exe,
    'D:\deepseekharness\DeepSeek Harness.exe',
    'D:\DeepSeek Harness\DeepSeek Harness.exe',
    'E:\deepseekharness\DeepSeek Harness.exe'
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path -LiteralPath $p)) { return @{ Exe = $p; Electron = $true } }
  }
  return $null
}

$rt = Find-NodeRuntime
if (-not $rt) {
  Write-Host ''
  Write-Host '  Node.js not found, and no DeepSeek Harness runtime was found either.' -ForegroundColor Yellow
  Write-Host '  Please install Node.js 22+ and run this file again.'
  Write-Host ''
  if ($args.Count -eq 0) { Read-Host 'Press Enter to exit' | Out-Null }
  exit 1
}

Write-Host ''
Write-Host ('  Runtime: ' + $rt.Exe) -ForegroundColor DarkGray
if ($rt.Electron) { $env:ELECTRON_RUN_AS_NODE = '1' }

$installScript = Join-Path $here 'scripts\install.mjs'
& $rt.Exe $installScript @args
$code = $LASTEXITCODE

if ($args.Count -eq 0) { Read-Host 'Press Enter to exit' | Out-Null }
exit $code
