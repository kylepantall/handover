# handover

[![CI](https://github.com/kylepantall/handover/actions/workflows/ci.yml/badge.svg)](https://github.com/kylepantall/handover/actions/workflows/ci.yml) [![MIT license](https://img.shields.io/badge/license-MIT-716e65)](LICENSE)

Hand a task from one machine to an AI agent on another, and get the result back automatically. One side runs `handover wait`; an agent (Claude, ChatGPT, Cursor…) picks it up over MCP and calls `handover_complete`; the waiter exits with the output and files.

```
 Client                       Host (relay, LAN or tunnel)        Any machine's agent
 handover wait ──create──▶  queue {id, objective, context}  ◀── agent: handover_next
      ▲  (blocks)                                           ◀── agent: handover_complete(output, files)
      └──────── exit 0, files in ./handover-<id>/
```

## Install

One machine is the **host**: it runs the relay and shares a token. Every other machine is a **client**: it joins with that token and finds the host on your network by itself. Full spec: [docs/flow.md](docs/flow.md).

**1. Host** (once):

| OS | Command |
|---|---|
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.sh \| bash -s -- --host` |
| Windows (PowerShell) | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1))) -Host` |

It prints the token and the exact join commands. Print them again any time with `handover link` on the host.

**2. Each client:** paste the command `handover link` printed (it carries the token in `HANDOVER_TOKEN`):

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.sh | HANDOVER_TOKEN=<token> bash -s -- --join
```

```powershell
$env:HANDOVER_TOKEN='<token>'; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1))) -Join
```

Without `HANDOVER_TOKEN` it asks for the token. Already installed? `handover join`. Joining ends with a round trip through the host.

**3. Check everything:** `handover test` on any machine. Every machine with Claude Code open (or `handover worker` / `handover listen` running) takes part:

```
✓ host      http://192.168.1.20:7777 answers, token accepted
✓ roundtrip pc → host → pc: 526 ms

Online: pc (claude-code), mac (claude-code), hub (relay)

Round robin:
  ✓ pc → mac   1008 ms
  ✓ mac → pc   61 ms
  …
All connections work.
```

| Installer option (`install.sh` / `install.ps1`) | Does |
|---|---|
| `--host` / `-Host` | This machine is the host |
| `--join [URL]` / `-Join [-Url URL]` | Join a host. The URL is only needed when the host is on another network |
| `--agent NAME` / `-Agent NAME` | Agent name (default: hostname) |
| `--no-claude` / `-NoClaude` | Don't add the MCP server and hook to Claude Code (added by default when it's installed) |
| `--no-service` | Host: don't run the relay at login (it runs while Claude Code is open) |
| `--no-setup` / `-NoSetup` | Install only |
| `REF` / `-Version x.y.z` | A branch, tag or commit (macOS/Linux) or a release (Windows) |

No option: a menu asks host or join. Old `--peer` / `--relay` flags still work (see docs/flow.md).

| | macOS / Linux | Windows |
|---|---|---|
| Installs | Source + a private Bun (checksum-verified) in `~/.local/share/handover`, launcher in `~/.local/bin` | `handover.exe` from the latest release (checked against `SHA256SUMS`) in `%LOCALAPPDATA%\handover\app`, added to your PATH |
| Host relay | Login service by default (launchd / systemd `--user`) | Runs inside handover while Claude Code (or `wait` / `worker`) is open; login task is opt-in (`handover service install`) |
| Client | Never runs a relay | Never runs a relay |
| Config | `~/.config/handover` | `%APPDATA%\handover` |

⚠️ Windows: the first time the relay starts, Windows Firewall asks whether to allow `handover.exe`. Allow **private networks** so other machines can reach it. If antivirus flags it, see [docs/antivirus.md](docs/antivirus.md); releases are signed once [docs/signing.md](docs/signing.md) is set up.

## Uninstall

One command per OS. It removes the login service / logon task (including the hidden one v0.5.0 created), running relays, the Claude Code MCP server and SessionStart hook, the PATH entry, the app, and your config and queue. Each step prints its result.

| OS | Command |
|---|---|
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/uninstall.sh \| bash` |
| Windows (PowerShell) | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/uninstall.ps1)))` |

Keep the config and queue (to reinstall with the same secret): add `-s -- --keep-config` (macOS/Linux) or `-KeepConfig` (Windows). Only things belonging to that install are removed. If Windows reports "access denied" even from an administrator PowerShell, your antivirus is blocking it: see [docs/antivirus.md](docs/antivirus.md).

## Commands

| Command | Does |
|---|---|
| `handover host` | Make this machine the host; prints the token and join commands |
| `handover join [HOST_URL]` | Join a host: asks for its token and finds it on this network |
| `handover setup` | Menu: host or join |
| `handover test` | Prove the machines talk: host check, a round trip, then a round robin where every online machine pings every other. Exits 1 if any link fails |
| `handover listen` | Answer test pings on a machine without Claude Code open |
| `handover wait --objective "…"` | Create a handover and block until it's done |
| `handover worker --exec "claude -p"` | Auto-pickup: run an agent on each new handover |
| `handover list` | Show the queue |
| `handover link` | Host: print the token and join commands (macOS/Linux and Windows) |
| `handover token` | Print this machine's token |
| `handover service install\|uninstall\|restart\|status\|log` | Relay at login (launchd / systemd `--user` / Task Scheduler) |
| `handover doctor` | Host: relay and service. Client: host found and token accepted |
| `handover update [--check]` | Install the latest version from GitHub |

### `wait`

```bash
handover wait --objective "Write a migration for X" --context-file notes.md --out ./result
handover wait --objective "Urgent fix" --priority 10 --to laptop
```

| Exit | Meaning |
|---|---|
| 0 | success — output on stdout, files in `--out` (default `./handover-<id>`) |
| 1 | agent reported `failed`, or the lease expired too many times |
| 2 | cancelled |
| 3 | `--timeout` hit (task cancelled) |
| 130 | Ctrl-C (task cancelled) |

`--json` prints `{id, status, failureReason, output, files}`. `--id foo` sets the id, or waits on an existing task.

## The queue

| Feature | How |
|---|---|
| Order | Highest `priority` first, then oldest |
| Targeting | `--to <agent>` → only that agent sees/claims it |
| Leases | A claim lasts 10 min (renewed while the worker runs); a dead agent's task goes back to the queue, and fails after 3 claims |
| Persistence | `~/.config/handover/tasks.json`; finished tasks pruned after 24 h |

Relay tuning lives in `config.json` under `relay` (`port`, `tunnel`, `leaseSeconds`, `maxAttempts`, `retentionHours`, `data`) or as `handover serve` flags.

## Agents

| Client | Connect with |
|---|---|
| Claude Code | `handover setup` (or `--claude`) registers `handover mcp` |
| Claude Desktop / Cursor (stdio) | `{"command": "~/.local/bin/handover", "args": ["mcp"]}` |
| Any HTTP MCP client | `<host>/mcp` with `Authorization: Bearer <token>` and `X-Handover-Agent: <name>` |
| ChatGPT (developer mode) | Needs HTTPS: set a tunnel in setup, then `<tunnel-url>/mcp?token=<token>&agent=<name>`, "No authentication" |

### Tools

| Tool | Does |
|---|---|
| `handover_list` | tasks you can pick up, queue order |
| `handover_next` | claim the next task for you |
| `handover_claim` | claim a specific task |
| `handover_renew` | extend your lease on long work |
| `handover_complete` | send output + files (`utf8` or `base64`); unblocks the waiter |
| `handover_get` | read a task without claiming |
| `handover_create` | delegate the other way (`to`, `priority` optional) |

## Configuration

| | |
|---|---|
| File | `~/.config/handover/config.json` (0600): `url`, `token`, `agent`, `relay` |
| Env overrides | `HANDOVER_URL`, `HANDOVER_TOKEN`, `HANDOVER_AGENT`, `HANDOVER_HOME` (folder) |
| Relay log | `~/.config/handover/relay.log` (`handover service log`) |

## ⚠️ Security

- The token grants full access to the queue. Treat it like a password; the `handover link` commands contain it (in `HANDOVER_TOKEN`, never as a command-line argument).
- `?token=` in a URL may be logged by tunnel providers; prefer header auth where the client supports it.
- Task context from another machine is untrusted input to your agent (prompt injection).
- Agent names are self-declared: targeting routes work, it isn't access control.
- The host announces its agent name and a one-way network id on the LAN so clients can find it; the token itself is never broadcast.
- Received files are flat names only (no paths/dotfiles), max 25 MB per request.

## Development

```bash
bun install
bun test tests
bun run typecheck
HANDOVER_SOURCE_DIR="$PWD" bash scripts/install.sh --no-setup   # install this checkout
```
