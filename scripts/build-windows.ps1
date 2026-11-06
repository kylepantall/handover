# Builds the Windows release into dist\: handover.exe (Bun compiled), zipped as
# handover-windows-x64.zip with SHA256SUMS. Used by CI and the release workflow.
#
#   build-windows.ps1              compile and package
#   build-windows.ps1 -CompileOnly compile dist\handover\handover.exe (sign it next)
#   build-windows.ps1 -PackageOnly zip dist\handover and write SHA256SUMS
param([switch]$CompileOnly, [switch]$PackageOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  $dist = Join-Path $root 'dist'
  $stage = Join-Path $dist 'handover'

  if (-not $PackageOnly) {
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    # HANDOVER_COMPILED tells src/paths.ts the app lives beside handover.exe.
    # Never load bunfig.toml or .env from the working directory (often a project an agent can write to).
    bun build --compile --minify --target=bun-windows-x64-baseline --define HANDOVER_COMPILED=true `
      --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/index.ts --outfile (Join-Path $stage 'handover.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Compiling handover.exe failed.' }
    Copy-Item LICENSE, README.md $stage
    Write-Host "Compiled $(Join-Path $stage 'handover.exe')"
  }

  if (-not $CompileOnly) {
    if (-not (Test-Path (Join-Path $stage 'handover.exe'))) { throw 'Nothing to package: run with -CompileOnly first.' }
    $zip = Join-Path $dist 'handover-windows-x64.zip'
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    [IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS'), "$hash  handover-windows-x64.zip`n")
    Write-Host "Built $zip ($hash)"
  }
} finally {
  Pop-Location
}
