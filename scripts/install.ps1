# Installs handover on Windows from a GitHub Release: handover.exe, checked
# against the release's SHA256SUMS, into %LOCALAPPDATA%\handover\app (added to
# your user PATH). Then sets it up as the host or as a client (docs/flow.md).
#
#   Host:   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1))) -Host
#   Client: $env:HANDOVER_TOKEN='<token>'; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1))) -Join
#
# HANDOVER_RELEASE_DIR installs from a folder holding the zip and SHA256SUMS
# (used by CI) instead of downloading.
[CmdletBinding()]
param(
  [string]$Version = 'latest',
  # Not $Host: that's PowerShell's read-only automatic variable. -Host still works.
  [Alias('Host')][switch]$HostMode,
  [switch]$Join,
  [string]$Url,
  [string]$Agent,
  [switch]$NoClaude,
  [switch]$NoSetup,
  [switch]$Help,
  # Old flags (docs/flow.md, Compatibility).
  [switch]$Peer,
  [switch]$Relay,
  [string]$Token,
  [switch]$Claude
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
    Write-Host 'Usage: install.ps1 [-Host | -Join [-Url URL]] [-Agent NAME] [-NoClaude] [-NoSetup] [-Version x.y.z]'
    Write-Host "Installs a $repo release (default latest) under %LOCALAPPDATA%\handover\app and adds it to your user PATH."
    Write-Host '  -Host               Make this machine the host: prints the token and join commands'
    Write-Host '  -Join               Join a host: token from $env:HANDOVER_TOKEN (handover link on the host prints the'
    Write-Host '                      whole command) or asked for; finds the host on this network'
    Write-Host '  -Url URL            The host''s address, only if it is on another network'
    Write-Host '  -NoClaude           Don''t add handover to Claude Code (added by default when installed)'
    Write-Host 'No option: a menu asks host or join.'
    return
  }
  # Old: -Join 'URL' (now -Join -Url URL) binds the URL to -Version.
  if ($Version -match '^https?://') { $script:Url = $Version; $script:Version = 'latest'; $script:Join = $true }
  if ($Token) { $env:HANDOVER_TOKEN = $Token } # old links: the environment, never handover.exe's argv
  $mode = if ($HostMode -or $Relay) { 'host' } elseif ($Join -or $Url) { 'join' } elseif ($Peer) { if ($env:HANDOVER_TOKEN) { 'join' } else { 'host' } } else { '' }
  if ($HostMode -and ($Join -or $Url)) { throw 'Use -Host or -Join, not both.' }
  if ($Version -ne 'latest' -and $Version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid version: $Version" }
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
    $taskXml = (& $schtasks /Query /TN $Task /XML 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $hadTask = $LASTEXITCODE -eq 0
    # v0.5.0 created a hidden task run through conhost --headless: the pattern antivirus flagged.
    $legacyTask = $hadTask -and ($taskXml -match 'conhost|<Hidden>true')
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
      # This session can always find it; the persistent PATH is best-effort.
      $env:Path = "$env:Path;$app"
      try {
        # Only write when something changed: writing flattens %VAR% entries.
        [Environment]::SetEnvironmentVariable('Path', (($entries + $app) -join ';'), 'User')
        Write-Info "Added $app to your user PATH (new terminals pick it up)."
      } catch {
        # Security software or policy can block writes to the user environment.
        # Claude Code and setup use the full path, so nothing depends on PATH.
        Write-Info "Could not add $app to your user PATH ($($_.Exception.InnerException.Message))."
        Write-Info "handover still works: Claude Code uses the full path. In a terminal, run: & '$exe'"
        Write-Info 'or add the folder in Settings > System > About > Advanced system settings > Environment Variables.'
      }
    }

    # Never let the logon task stop the install: setup and Claude Code don't need it.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    if ($legacyTask) {
      Write-Step 'Removing the old hidden logon task'
      & $schtasks /Delete /TN $Task /F 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) { Write-Info 'Removed. The relay now runs while Claude Code is open (handover service install for a visible login task).' }
      else { Write-Info "Could not remove it (access denied?). Delete the '$Task' task in Task Scheduler yourself." }
    } elseif ($hadTask) {
      Write-Step 'Restarting the relay'
      & $exe service restart 2>&1 | ForEach-Object { Write-Info "$_" }
      if ($LASTEXITCODE -ne 0) { Write-Info 'Could not restart the login task; carrying on (handover doctor shows its state).' }
    }
    $ErrorActionPreference = $previous

    $roleArgs = @()
    if ($Agent) { $roleArgs += @('--agent', $Agent) }
    if ($NoClaude) { $roleArgs += '--no-claude' }

    # Not $home: that's PowerShell's read-only automatic variable.
    $dataDir = if ($env:HANDOVER_HOME) { $env:HANDOVER_HOME } else { Join-Path $env:APPDATA 'handover' }
    $configured = Test-Path (Join-Path $dataDir 'config.json')
    if ($NoSetup) {
      Write-Host "`nhandover installed. Next: handover host (this machine is the hub) or handover join"
    } elseif ($mode -eq 'host') {
      Write-Step 'Host'
      & $exe host @roleArgs
      if ($LASTEXITCODE -ne 0) { throw 'Setting up the host failed; fix the error above and rerun: handover host' }
    } elseif ($mode -eq 'join') {
      Write-Step 'Join'
      $joinArgs = @()
      if ($Url) { $joinArgs += $Url }
      # No HANDOVER_TOKEN: join asks for it (a hidden prompt), never as an argument.
      & $exe join @joinArgs @roleArgs
      if ($LASTEXITCODE -ne 0) { throw 'Joining failed; fix the error above and rerun: handover join' }
    } elseif (-not $configured -and [Environment]::UserInteractive) {
      Write-Step 'Setup'
      & $exe setup
      if ($LASTEXITCODE -ne 0) { Write-Info 'Setup did not finish; rerun it any time with: handover setup' }
    } elseif ($Claude -and $configured) {
      & $exe setup --claude --hook
    } else {
      Write-Host "`nhandover installed. Next: handover host (this machine is the hub) or handover join"
    }
  } finally {
    Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue
    # Setup saved the token to config; don't leave it in this PowerShell session.
    Remove-Item Env:HANDOVER_TOKEN -ErrorAction SilentlyContinue
  }
}

Install-Handover
