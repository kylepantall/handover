# Installs handover on Windows from a GitHub Release: handover.exe, checked
# against the release's SHA256SUMS, into %LOCALAPPDATA%\handover\app (added to
# your user PATH). Then runs "handover setup".
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1)))
#   $env:HANDOVER_TOKEN='<secret>'; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1))) -Peer
#
# HANDOVER_RELEASE_DIR installs from a folder holding the zip and SHA256SUMS
# (used by CI) instead of downloading.
[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [switch]$Peer,
  [switch]$Relay,
  [string]$Join,
  [string]$Token,
  [string]$Agent,
  [switch]$Claude,
  [switch]$NoSetup,
  [switch]$Help
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Asset = 'handover-windows-x64.zip'
$Task = 'handover-relay'

function Write-Step([string]$Text) { Write-Host "`n==> $Text" }
function Write-Info([string]$Text) { Write-Host "    $Text" }

function Install-Handover {
  $repo = if ($env:HANDOVER_REPO) { $env:HANDOVER_REPO } else { 'kylepantall/handover' }
  if ($Help) {
    Write-Host 'Usage: [$env:HANDOVER_TOKEN=T;] install.ps1 [-Peer | -Relay | -Join URL] [-Agent NAME] [-Claude] [-NoSetup] [-Version x.y.z]'
    Write-Host "Installs a $repo release (default latest) under %LOCALAPPDATA%\handover\app and adds it to your user PATH."
    Write-Host '  -Peer               Peer-to-peer on this network (other machines: set $env:HANDOVER_TOKEN first)'
    Write-Host '  -Relay              Make this machine the relay'
    Write-Host '  -Join URL           Connect to a relay (token in $env:HANDOVER_TOKEN)'
    Write-Host '  -Claude             Add the MCP server and SessionStart hook to Claude Code'
    return
  }
  if ($Version -ne 'latest' -and $Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version: $Version" }
  $modes = @(@([bool]$Peer, [bool]$Relay, [bool]$Join) | Where-Object { $_ })
  if ($modes.Count -gt 1) { throw 'Use one of -Peer, -Relay or -Join.' }
  if ($Join -and -not $Token -and -not $env:HANDOVER_TOKEN) { throw '-Join needs the relay token: set $env:HANDOVER_TOKEN (handover link prints the command).' }
  $label = if ($env:HANDOVER_RELEASE_DIR) { $env:HANDOVER_RELEASE_DIR } elseif ($Version -eq 'latest') { "$repo (latest release)" } else { "$repo v$Version" }
  Write-Host "handover installer - $label"

  $installDir = if ($env:HANDOVER_INSTALL_DIR) { $env:HANDOVER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'handover' }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  $installDir = (Resolve-Path -LiteralPath $installDir).Path.TrimEnd('\')
  $app = Join-Path $installDir 'app'
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('handover-install-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $temp | Out-Null
  $schtasks = Join-Path $env:SystemRoot 'System32\schtasks.exe'

  try {
    Write-Step 'Downloading'
    $zip = Join-Path $temp $Asset
    $sums = Join-Path $temp 'SHA256SUMS'
    if ($env:HANDOVER_RELEASE_DIR) {
      Copy-Item (Join-Path $env:HANDOVER_RELEASE_DIR $Asset) $zip
      Copy-Item (Join-Path $env:HANDOVER_RELEASE_DIR 'SHA256SUMS') $sums
    } else {
      $base = if ($Version -eq 'latest') { "https://github.com/$repo/releases/latest/download" } else { "https://github.com/$repo/releases/download/v$Version" }
      Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
      Invoke-WebRequest "$base/$Asset" -OutFile $zip -UseBasicParsing
    }
    $line = Get-Content $sums | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+\*?$([regex]::Escape($Asset))$" } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS does not list $Asset." }
    if ((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne ($line -split '\s+')[0].ToLower()) { throw 'Checksum mismatch: the download is not the published release.' }
    Write-Info 'Checksum verified'

    Write-Step 'Installing'
    # Unpack beside the install and swap it in, so a failure leaves the working
    # install untouched. Config and the queue live in %APPDATA%\handover.
    $staging = Join-Path $installDir 'app.new'
    if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    Expand-Archive $zip -DestinationPath $staging -Force
    if (-not (Test-Path (Join-Path $staging 'handover.exe'))) { throw 'The release is missing handover.exe.' }
    # Marks a folder the installer owns; "handover update" refuses to rewrite any other.
    Set-Content -LiteralPath (Join-Path $staging '.handover-install') -Value 'handover' -Encoding ASCII

    # A running relay holds handover.exe open; stop it for the swap.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $schtasks /Query /TN $Task 2>&1 | Out-Null
    $hadTask = $LASTEXITCODE -eq 0
    if ($hadTask) { & $schtasks /End /TN $Task 2>&1 | Out-Null; Start-Sleep -Seconds 1 }
    $ErrorActionPreference = $previous

    $old = Join-Path $installDir 'app.old'
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    if (Test-Path $app) {
      try { Move-Item $app $old }
      catch { throw 'handover is running (Claude Code starts it). Quit Claude Code, then rerun the installer.' }
    }
    try { Move-Item $staging $app }
    catch {
      if (Test-Path $old) { Move-Item $old $app }
      throw "Could not move the new version into place: $($_.Exception.Message)"
    }
    if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
    $exe = Join-Path $app 'handover.exe'
    Write-Info "$exe (version $((& $exe --version 2>&1 | ForEach-Object { "$_" }) -join ' '))"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @(($userPath -split ';') | Where-Object { $_ })
    if ($entries -notcontains $app) {
      # Only write when something changed: writing flattens %VAR% entries.
      [Environment]::SetEnvironmentVariable('Path', (($entries + $app) -join ';'), 'User')
      $env:Path = "$env:Path;$app"
      Write-Info "Added $app to your user PATH (new terminals pick it up)."
    }

    if ($hadTask) {
      Write-Step 'Restarting the relay'
      & $exe service restart
    }

    $setupArgs = @()
    if ($Peer) { $setupArgs += '--peer' }
    if ($Relay) { $setupArgs += '--relay' }
    if ($Join) { $setupArgs += @('--join', $Join) }
    # The token reaches setup through the environment, never handover.exe's command line.
    if ($Token) { $env:HANDOVER_TOKEN = $Token }
    if ($Agent) { $setupArgs += @('--agent', $Agent) }
    $hasMode = $Peer -or $Relay -or [bool]$Join
    if ($Claude) { $setupArgs += @('--claude', '--hook') }

    # Not $home: that's PowerShell's read-only automatic variable.
    $dataDir = if ($env:HANDOVER_HOME) { $env:HANDOVER_HOME } else { Join-Path $env:APPDATA 'handover' }
    $configured = Test-Path (Join-Path $dataDir 'config.json')
    if ($NoSetup) {
      Write-Host "`nhandover installed. Next: handover setup"
    } elseif ($hasMode -or ($Claude -and $configured)) {
      Write-Step 'Setup'
      & $exe setup @setupArgs
      if ($LASTEXITCODE -ne 0) { throw 'Setup failed; fix the error above and rerun: handover setup' }
    } elseif (-not $configured -and [Environment]::UserInteractive) {
      Write-Step 'Setup'
      & $exe setup
      if ($LASTEXITCODE -ne 0) { Write-Info 'Setup did not finish; rerun it any time with: handover setup' }
    } else {
      Write-Host "`nhandover installed. Next: handover setup (first time) or handover doctor"
    }
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    # Setup saved the token to config; don't leave it in this PowerShell session.
    Remove-Item Env:HANDOVER_TOKEN -ErrorAction SilentlyContinue
  }
}

Install-Handover
