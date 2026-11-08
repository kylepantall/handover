# Changelog

## 0.12.0

- `handover clear`: deletes finished handovers; `handover clear ID...` removes just those, cancelling any still open. `--all` also cancels and deletes every open one, and asks first (`--yes` in scripts). CLI only, so a task's text can't get an agent to wipe the queue.
- `handover devices` (`--json`): the machines on this relay, with online status, version, platform, agents and what's running. New `handover_devices` MCP tool, so agents can find addresses for `to`.
- New-release notice: commands in a terminal, Claude Code at session start and MCP clients are told when a newer release exists. Checked at most every 6 h, and a check delays a start by 1.5 s at most. `HANDOVER_NO_UPDATE_CHECK=1` turns it off.
- ⚠️ Only paired devices can be sent tasks. The relay saves every machine that has checked in with its token (`join` does this), with its installed agents, and refuses a `to` that matches none of them; the error lists the valid names. `handover devices forget NAME` unpairs one.
- ⚠️ Update the host, then each machine: until a machine runs 0.12, `to: "codex@pc"` is refused unless a worker there has checked in.

## 0.11.0

- `handover agents`: lists each agent (installed, MCP, auto-pickup, access) and changes one or all: `handover agents all on`, `handover agents codex off`, `handover agents codex full-access`, `handover agents all default-access`. Settings are per agent (`agents` in config.json; older `auto` configs are read and rewritten). `handover auto` still works.
- Fix: Codex tasks could do nothing unattended. Codex now may write in the task's own folder (`--sandbox workspace-write`, no network), and handover's own tools are approved up front, so `handover_complete` works (as with Claude's `--allowedTools mcp__handover`).
- Fix: a task the agent couldn't do was marked success because the agent exited 0. Agents are told to answer `FAILED: …`, and the task is marked failed.

## 0.10.0

- Several agents per machine: each has its own address, `claude@pc` and `codex@pc`. `--to codex` reaches Codex on any machine, `--to codex@pc` one agent, and `--to pc` any agent there, as before. ⚠️ Update the host first: the matching happens in its relay.
- Auto-pickup with both agents: `--auto both` (or the setup menu), `handover auto claude codex`. Each agent gets its own worker, so they run in parallel.
- Being told when a delegated task finishes: `handover_create` tells the agent to run `handover wait --id …` in the background, which wakes Claude Code when it exits. New `handover_wait` tool for agents without background commands.
- MCP servers are registered as `handover mcp --as claude|codex`; `host` / `join` update older entries of this install.

## 0.9.0

- Codex support: `host` and `join` add handover's MCP server to Codex as well as Claude Code, for each CLI that's installed. `--no-codex` / `-NoCodex` skips it.
- Auto-pickup: setup asks whether this machine takes handovers automatically, with Claude Code (`claude -p`) or Codex (`codex exec`). Each task runs unattended in its own folder with the agent's usual permissions. It runs at login on macOS/Linux and while Claude Code or Codex is open on Windows. Change it with `handover auto claude|codex|off`; installers take `--auto` / `-Auto`.
- ⚠️ `--full-access` (opt-in only) skips the agent's permission prompts and sandbox; doctor warns while it's on.
- `handover_watch` MCP tool: an open session waits for the next task and claims it.
- `handover worker --with claude|codex` runs an agent without writing its command line.
- `handover unlink` removes handover from Claude Code and Codex (`claude-unlink` still works). The uninstall scripts remove the Codex entry too.
- `doctor` lists each agent's MCP status and auto-pickup.
- ⚠️ A client may now have a login service: it runs auto-pickup only, never a relay. In a terminal, `join` always asks about auto-pickup, even with `HANDOVER_TOKEN` set.
- README rewritten around a quick start, with a prompt that lets a coding agent set handover up.

## 0.8.0

- `handover test`: checks the host answers, does a round trip through it, then a round robin where every online machine pings every other, giving the full grid of directed links with timings. Exits 1 if any link fails; `--json`.
- `handover join` ends with a round trip through the host and lists who's online.
- Presence: the host relay, Claude Code's MCP server, `worker` and the new `handover listen` check in with the host and answer ping tasks for their agent. Pings never reach Claude, `list`, the hook or the worker.

## 0.7.0

Setup is now host / client ([docs/flow.md](docs/flow.md)):

- ⚠️ `handover host` (installer `--host` / `-Host`): this machine runs the relay and prints the token and join commands. `handover join` (installer `--join` / `-Join`): asks for the token, finds the host on this network by mDNS (URL only when it's elsewhere), and never runs a relay.
- ⚠️ Peer-to-peer mode is gone. `--peer` without a token now means host, with `HANDOVER_TOKEN` it means join; `--relay` means host. Old configs are read as host (relay/peer) or client (joined URL).
- A client that found its host by discovery finds it again when the host's address changes.
- `handover link` only runs on the host. `serve` refuses on a client. Joining removes a relay service this install had set up as a host.
- Claude Code is wired up by default when its CLI is installed; `--no-claude` / `-NoClaude` skips it.
- `install.sh --no-service` for hosts. The installer only restarts a login service that runs its own launcher, so a second install never repoints yours; becoming host leaves another install's service alone.
- `launchctl` is called by absolute path.

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
