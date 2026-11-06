# Changelog

## 0.6.6

- `handover join [RELAY_URL]`: join peers on this network (or a relay) on a machine that already has handover. Asks for the secret, or reads `HANDOVER_TOKEN`; refuses a secret on the command line. `handover link` mentions it.
- `handover doctor` / `service status` recognise v0.5.0's hidden logon task on Windows (`legacy`) and say to remove it, instead of reporting a broken service.
- macOS: `service install` waits for launchd to finish unloading the old job and retries, fixing `Bootstrap failed: 5: Input/output error`.

## 0.6.5

- `scripts/uninstall.sh` and `scripts/uninstall.ps1`: one-command removal on every OS (service/logon task incl. the v0.5.0 hidden one, running relays, Claude Code MCP server and hook, PATH, app, config). `--keep-config` / `-KeepConfig`.
- `handover claude-unlink`: removes this install's MCP server and SessionStart hook from Claude Code.

## 0.6.4

Windows fixes from a real install with Bitdefender:

- Config and queue writes retry for a moment when the file is locked (EPERM/EACCES/EBUSY, typically antivirus scanning the file just written), then fall back to copying over it.
- The installer removes the hidden logon task left by v0.5.0 instead of recreating it, and never aborts over the logon task.
- Setup treats a login service that can't be installed as a warning: the relay also runs inside Claude Code's MCP server, `wait` and `worker`.

## 0.6.3

- Windows installer: adding handover to your user PATH is best-effort. If security software or policy blocks it (`UnauthorizedAccessException`), install and setup carry on, since Claude Code uses the full path.

## 0.6.2

- `handover doctor`: a relay that isn't running right now is reported as information, not a failure. It starts on demand with Claude Code's MCP server, `wait` or `worker`; only an installed login service that isn't answering is a failure.

## 0.6.1

- Fix: the queue is written to disk on every change. On Windows a killed process gets no shutdown hook, so the newest task could be lost when the process hosting the relay was terminated.
- v0.6.0 was tagged but never released (its Windows tests caught this); 0.6.1 includes everything listed under 0.6.0.

## 0.6.0

Changes after Bitdefender flagged v0.5.0 on Windows (see docs/antivirus.md).

- ⚠️ No hidden logon task. The relay now runs inside handover itself (Claude Code's MCP server, `wait`, `worker`) whenever one is open; another process takes over if it exits, and the queue survives on disk.
- ⚠️ Login service is opt-in on Windows and visible (no `conhost --headless`). macOS/Linux still default to it. `serve` stands by instead of failing if another handover process already hosts the relay.
- ⚠️ Secrets stay off command lines: `handover link`, `install.sh` and `install.ps1` pass the token in `HANDOVER_TOKEN`. `--token` / `-Token` still work but are converted to the environment variable before reaching setup.
- Release workflow signs `handover.exe` with Azure Artifact Signing when configured (docs/signing.md).

## 0.5.0

- Windows 11: `install.ps1` installs a compiled `handover.exe` from GitHub Releases (checked against `SHA256SUMS`), adds it to your user PATH and runs setup. `-Peer`, `-Relay`, `-Join`, `-Token`, `-Agent`, `-Claude`.
- The relay runs at logon on Windows through Task Scheduler (hidden console, no battery or time limits, restarts on failure).
- `handover link`: prints the commands that connect another machine, for macOS/Linux and Windows, with the token. Setup shows the same.
- `handover update` on Windows installs the latest release in place.
- Config on Windows lives in `%APPDATA%\handover`.
- `serve --log FILE` and `serve --home DIR`.
- Fix: the installer's `--claude` on an existing setup no longer needs a terminal.

## 0.4.0

- Peer-to-peer mode: `handover setup --peer` (or `install.sh --peer --token <secret>`). Every machine runs its own small relay and peers find each other by mDNS (`_handover._tcp`), so there are no addresses to type.
- Peers only see each other when they share a secret (advertised as a one-way network id).
- MCP tools, `worker`, `list` and the SessionStart hook work across all peers; new tasks stay on the machine that created them.
- `doctor` shows the mode and the peers it can see.

## 0.3.0

- One-line install (`curl … | bash`) with a private Bun and a `handover` launcher in `~/.local/bin`, like keyhop.
- `handover setup`: run the relay here or join one, name this agent, register the MCP server and SessionStart hook with Claude Code. Scriptable with `--relay` / `--join URL --token T`.
- Config in `~/.config/handover/config.json` (0600); env vars still override.
- `handover service install|uninstall|restart|status|log`: relay at login via launchd (macOS) or systemd `--user` (Linux).
- `handover doctor`, `handover update`, `handover token`, `--version`.
- Rewritten in TypeScript on Bun.
- ⚠️ `serve` no longer prints the token; use `handover token`.

## 0.2.0

- Queue: persistence, claim leases with requeue, targeting (`--to`), priority, `handover_next`, `handover_renew`.

## 0.1.0

- Relay with REST + MCP, `wait`, `worker`, stdio MCP proxy, SessionStart hook, tunnels.
