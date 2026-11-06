# handover

[![CI](https://github.com/kylepantall/handover/actions/workflows/ci.yml/badge.svg)](https://github.com/kylepantall/handover/actions/workflows/ci.yml) [![MIT license](https://img.shields.io/badge/license-MIT-716e65)](LICENSE)

Hand a task from one machine to an AI agent on another, and get the result back automatically. One side runs `handover wait`; an agent (Claude, ChatGPT, Cursor…) picks it up over MCP and calls `handover_complete`; the waiter exits with the output and files.

```
 Machine A                    Relay (LAN or tunnel)              Machine B
 handover wait ──create──▶  queue {id, objective, context}  ◀── agent: handover_next
      ▲  (blocks)                                           ◀── agent: handover_complete(output, files)
      └──────── exit 0, files in ./handover-<id>/
```

## Install

**macOS / Linux** — one command per machine.

The relay machine:

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.sh | bash
```

Setup asks whether this machine runs the relay; say yes. It starts the relay at login, adds handover to Claude Code, and prints the join command for your other machines, like:

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.sh | bash -s -- --join http://192.168.1.20:7777 --token <token>
```

| Installer option | Does |
|---|---|
| `--relay` | Make this machine the relay, no questions |
| `--join URL --token T` | Connect to a relay, no questions |
| `--agent NAME` | Agent name (default: hostname) |
| `--claude` | Add the MCP server and SessionStart hook to Claude Code |
| `--no-setup` | Install only |
| `REF` (e.g. `bash -s -- v0.3.0`) | Install a branch, tag or commit |

It installs a private Bun if needed (checksum-verified) into `~/.local/share/handover`, and a `handover` launcher in `~/.local/bin`.

## Commands

| Command | Does |
|---|---|
| `handover setup` | Guided setup; rerun any time |
| `handover wait --objective "…"` | Create a handover and block until it's done |
| `handover worker --exec "claude -p"` | Auto-pickup: run an agent on each new handover |
| `handover list` | Show the queue |
| `handover token` | Print the relay token |
| `handover service install\|uninstall\|restart\|status\|log` | Relay at login (launchd / systemd `--user`) |
| `handover doctor` | Check config, relay, service, Claude Code |
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
| Any HTTP MCP client | `<relay>/mcp` with `Authorization: Bearer <token>` and `X-Handover-Agent: <name>` |
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

- The token grants full access to the queue. Treat it like a password; the join command contains it.
- `?token=` in a URL may be logged by tunnel providers; prefer header auth where the client supports it.
- Task context from another machine is untrusted input to your agent (prompt injection).
- Agent names are self-declared: targeting routes work, it isn't access control.
- Received files are flat names only (no paths/dotfiles), max 25 MB per request.

## Development

```bash
bun install
bun test tests
bun run typecheck
HANDOVER_SOURCE_DIR="$PWD" bash scripts/install.sh --no-setup   # install this checkout
```
