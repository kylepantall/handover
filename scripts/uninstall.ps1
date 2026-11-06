# Removes handover from Windows: the logon task (including the hidden one
# v0.5.0 created), running relays, the Claude Code MCP server and SessionStart
# hook, the user PATH entry, the app and (unless -KeepConfig) the config and
# queue. Every step reports its result; nothing fails silently.
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/uninstall.ps1)))
[CmdletBinding()]
param([switch]$KeepConfig, [switch]$Help)
$ErrorActionPreference = 'Continue'
$Task = 'handover-relay'
$script:failures = 0

function Ok([string]$Text) { Write-Host "  [ok]   $Text" }
function Skip([string]$Text) { Write-Host "  [--]   $Text" }
function Bad([string]$Text) { Write-Host "  [FAIL] $Text" -ForegroundColor Red; $script:failures++ }

function Uninstall-Handover {
  if ($Help) {
    Write-Host 'Usage: uninstall.ps1 [-KeepConfig]'
    Write-Host 'Removes handover; -KeepConfig keeps %APPDATA%\handover (secret and queue).'
    return
  }
  $installDir = if ($env:HANDOVER_INSTALL_DIR) { $env:HANDOVER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'handover' }
  $app = Join-Path $installDir 'app'
  $exe = Join-Path $app 'handover.exe'
  $dataDir = if ($env:HANDOVER_HOME) { $env:HANDOVER_HOME } else { Join-Path $env:APPDATA 'handover' }
  $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'
  Write-Host "Removing handover ($installDir)`n"

  Write-Host 'Logon task'
  $xml = (& $schtasks /Query /TN $Task /XML 2>&1 | ForEach-Object { "$_" }) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    Skip 'none installed'
  } elseif ($xml -notmatch [regex]::Escape($exe) -and $xml -notmatch 'conhost') {
    Skip "'$Task' runs another handover install; left alone"
  } else {
    & $schtasks /End /TN $Task 2>&1 | Out-Null
    $out = (& $schtasks /Delete /TN $Task /F 2>&1 | ForEach-Object { "$_" }) -join ' '
    if ($LASTEXITCODE -eq 0) { Ok "removed '$Task'" }
    else { Bad "could not remove '$Task': $out (delete it in Task Scheduler; if that is refused too, check your antivirus)" }
  }

  Write-Host 'Claude Code'
  # handover.exe edits settings.json itself: PowerShell 5.1's JSON round-trip can mangle it.
  if (Test-Path $exe) {
    $out = (& $exe claude-unlink 2>&1 | ForEach-Object { "$_" })
    if ($LASTEXITCODE -eq 0) { $out | ForEach-Object { Ok $_ } }
    else { Bad "handover claude-unlink failed: $($out -join ' ')" }
  } else {
    Skip "$exe not found; if Claude Code still lists it, run: claude mcp remove handover --scope user"
  }

  Write-Host 'Running processes'
  $procs = @(Get-Process -Name handover -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) })
  if (-not $procs.Count) { Skip 'none running' }
  else {
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    $left = @(Get-Process -Id $procs.Id -ErrorAction SilentlyContinue)
    if ($left.Count) { Bad "could not stop handover (pid $($left.Id -join ', ')); quit Claude Code and rerun" }
    else { Ok "stopped $($procs.Count) process(es)" }
  }

  Write-Host 'PATH'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @(($userPath -split ';') | Where-Object { $_ })
  if ($entries -notcontains $app) { Skip 'not on your user PATH' }
  else {
    try {
      [Environment]::SetEnvironmentVariable('Path', (@($entries | Where-Object { $_ -ne $app }) -join ';'), 'User')
      Ok "removed $app from your user PATH"
    } catch {
      Bad "could not edit your user PATH ($($_.Exception.InnerException.Message)); remove $app in Environment Variables"
    }
  }

  Write-Host 'Files'
  $targets = @($installDir)
  if ($KeepConfig) { Skip "kept $dataDir (-KeepConfig)" } else { $targets += $dataDir }
  foreach ($path in $targets) {
    if (-not (Test-Path -LiteralPath $path)) { Skip "$path not found"; continue }
    try {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      Ok "removed $path"
    } catch {
      Bad "could not remove ${path}: $($_.Exception.Message)"
    }
  }

  if ($script:failures) {
    Write-Host "`n$($script:failures) step(s) failed; see above." -ForegroundColor Red
    Write-Host 'If access is denied even from an administrator PowerShell, your antivirus is blocking it: check its quarantine / threat history for handover.'
  } else {
    Write-Host "`nhandover removed."
  }
}

Uninstall-Handover
