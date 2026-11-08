# handover

[![CI](https://github.com/kylepantall/handover/actions/workflows/ci.yml/badge.svg)](https://github.com/kylepantall/handover/actions/workflows/ci.yml) [![MIT license](https://img.shields.io/badge/license-MIT-716e65)](LICENSE)

Hand a task to an AI agent on another machine and get the result back. Works with Claude Code, Codex and any MCP client.

```
 You: handover wait ──▶  host (queue)  ◀── agent on any machine picks it up
      ▲ blocks                           ── agent sends output + files back
      └──── exits with the result
```

## Quick start

**1. Pick one machine as the host** and run:

| OS | Command |
|---|---|
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.sh \| bash -s -- --host` |
| Windows (PowerShell) | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.ps1))) -Host` |

It prints a **join command** that contains the token. Show it again any time with `handover link`.

**2. On every other machine**, paste that join command. It installs handover, finds the host on your network, and asks one question:

```
◆ Take handovers automatically on this machine?
│ ● Yes, with Claude Code   (runs each task unattended, with your usual permission settings)
│ ○ Yes, with Codex
│ ○ Yes, with both
│ ○ No                      (tasks wait until you ask an agent to pick them up)
```

**3. Check it:** `handover test` on any machine.

```
✓ host      http://192.168.1.20:7777 answers, token accepted
✓ roundtrip pc → host → pc: 526 ms
Round robin:
  ✓ pc → mac   1008 ms
  ✓ mac → pc   61 ms
All connections work.
```

**4. Hand something over:**

```bash
handover wait --objective "Write a migration for X" --context-file notes.md
```

It blocks until an agent finishes, then prints the output and saves any files to `./handover-<id>/`.

### Or let your coding agent set it up

Paste this into Claude Code or Codex on each machine:

```text
Set up Handover on this machine: https://github.com/kylepantall/handover
1. Ask me two things: is this machine the host, or does it join an existing host? And should it
   take handovers automatically with Claude Code, Codex, both, or not at all?
2. Install it with the README's Quick start command for this OS, adding --no-setup (Windows: -NoSetup).
3. Host: run `handover host` (add `--auto claude`, `--auto codex` or `--auto both` if I said yes). Don't repeat the
   token it prints; tell me to run `handover link` myself when I want to share it.
   Join: never ask me for the token in chat. Tell me to run `handover join` in my own terminal (it
   asks for the token privately, and about auto-pickup) and wait until I say it's done.
4. Never use --full-access unless I ask for it by name.
5. Run `handover doctor` and `handover test`, then tell me which lines aren't ✓ and how to fix them.
```

## Agents working together

Every agent has its own address: `claude@pc`, `codex@pc`. Send a task to whoever should do it:

| `--to` (or `to` in `handover_create`) | Who can take it |
|---|---|
| (nothing) | Any agent |
| `pc` | Any agent on that machine |
| `codex` / `claude` | That agent, on any machine |
| `codex@pc` | Only Codex on `pc` |

Only paired devices and their agents are accepted: `to` with any other name is refused, and the error lists the valid ones. Agents can look them up with `handover_devices`.

**Example:** ask Claude Code: *"Have Codex make the graphics for this page, wait for them, then finish the page and open a PR."* Claude calls `handover_create` with `to: "codex"`, then waits in the background with `handover wait --id …`. Claude Code wakes the session when Codex finishes, and Claude gets the files and carries on. If the request was itself a handover, Claude ends with `handover_complete`, putting the PR link in the output.

| Waiting for a result | How |
|---|---|
| Claude Code | Runs `handover wait --id …` in the background and is woken when it exits |
| Codex and other agents | Call the `handover_wait` tool (it returns after 50 s if the task isn't done: call it again) |
| You, in a terminal | `handover wait --id …` |

⚠️ Each agent's auto-pickup worker does one task at a time. A task it's running that delegates to the same agent on the same machine (Claude's worker → `claude@pc`) waits until it times out. Delegate to the other agent or another machine.

## How agents pick up tasks

| Setup | What happens |
|---|---|
| Auto-pickup on (the setup question, or `handover agents all on`) | Each task runs unattended with `claude -p` or `codex exec`, in its own folder. With both, each agent has its own worker, so they run at the same time. macOS/Linux: runs at login. Windows: runs while Claude Code or Codex is open |
| Auto-pickup off | Claude Code shows pending tasks when a session starts. Ask any agent to "pick up the handover", or to "watch for handovers" (`handover_watch`) |
| Other MCP clients | See [Connect other agents](#connect-other-agents) |

### Per-agent settings

```bash
handover agents                     # list: installed, MCP, auto-pickup, access
handover agents all on              # every agent takes handovers automatically
handover agents codex off           # just Codex stops
handover agents codex full-access   # ⚠️ just Codex: no permission prompts or sandbox
handover agents all default-access
```

| Access | Claude Code | Codex |
|---|---|---|
| default | Your permission settings; handover's own tools allowed | Writes only in the task's own folder, no network; handover's own tools allowed |
| ⚠️ full-access | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` |

⚠️ Tasks come from other machines, so treat them as untrusted input. Only give an agent full access on a machine you'd trust anyone on the network with. With default access, an agent can make files and send them back, but it can't change your repos or open PRs: have an open session do that part (see the example above).

If an agent can't finish, it answers `FAILED: …`, and the task is marked failed.

## Commands

| Command | Does |
|---|---|
| `handover host` | Make this machine the host; prints the join commands |
| `handover join [HOST_URL]` | Join a host (asks for the token). The URL is only needed if the host is on another network |
| `handover agents [WHO SETTING…]` | List agents, or change them: `all on`, `codex off`, `codex full-access`, `all default-access` |
| `handover test` | Check every machine reaches every other. Exits 1 if any link fails |
| `handover doctor` | Check the host, the login service, Claude Code, Codex and auto-pickup |
| `handover wait --objective "…"` | Create a task and block until it's done |
| `handover worker [--with claude\|codex \| --exec "CMD"]` | Run tasks in the foreground with an agent |
| `handover list` | Show the queue |
| `handover clear [ID…]` | Delete finished handovers, or just these ids (open ones are cancelled). `--all` also cancels and deletes every open one |
| `handover devices` | The paired machines: online or not, version, agents, what's running. `handover devices forget NAME` unpairs one |
| `handover link` | Host: print the join commands and token |
| `handover listen` | Answer test pings on a machine without an agent open |
| `handover unlink` | Remove handover from Claude Code and Codex |
| `handover service install\|uninstall\|restart\|status\|log` | Run handover at login |
| `handover update` | Install the latest version |

`handover help` lists every flag.

## Uninstall

| OS | Command |
|---|---|
| macOS / Linux | `curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/uninstall.sh \| bash` |
| Windows (PowerShell) | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/kylepantall/handover/main/scripts/uninstall.ps1)))` |

Removes the login service, the Claude Code and Codex entries, the app, and your config and queue. Keep the config: add `-s -- --keep-config` (macOS/Linux) or `-KeepConfig` (Windows).

## Reference

<details>
<summary>Installer options</summary>

| `install.sh` / `install.ps1` | Does |
|---|---|
| `--host` / `-Host` | This machine is the host |
| `--join [URL]` / `-Join [-Url URL]` | Join a host; token from `HANDOVER_TOKEN` or asked for |
| `--auto claude\|codex\|both\|off` / `-Auto …` | Auto-pickup without being asked |
| `--full-access` / `-FullAccess` | ⚠️ Auto-pickup skips the agent's permission prompts and sandbox |
| `--agent NAME` / `-Agent NAME` | Agent name (default: hostname) |
| `--no-claude`, `--no-codex` / `-NoClaude`, `-NoCodex` | Don't add handover to that agent |
| `--no-service` | Don't run handover at login |
| `--no-setup` / `-NoSetup` | Install only |
| `REF` / `-Version x.y.z` | A branch, tag or commit (macOS/Linux) or a release (Windows) |

No option: a menu asks host or join. Old `--peer` / `--relay` flags still work ([docs/flow.md](docs/flow.md)).

</details>

<details>
<summary>Platforms</summary>

| | macOS / Linux | Windows |
|---|---|---|
| Installs | Source + a private, checksum-verified Bun in `~/.local/share/handover`; launcher in `~/.local/bin` | `handover.exe` from the latest release (checked against `SHA256SUMS`) in `%LOCALAPPDATA%\handover\app` |
| At login | Host relay and auto-pickup (launchd / systemd `--user`) | Nothing by default: runs while Claude Code or Codex is open. Opt in with `handover service install` |
| Config | `~/.config/handover` | `%APPDATA%\handover` |

⚠️ Windows: allow `handover.exe` on **private networks** when the firewall asks. If antivirus flags it, see [docs/antivirus.md](docs/antivirus.md).

</details>

<details>
<summary><code>wait</code> exit codes</summary>

| Exit | Meaning |
|---|---|
| 0 | success: output on stdout, files in `--out` (default `./handover-<id>`) |
| 1 | the agent reported `failed`, or the lease expired too many times |
| 2 | cancelled |
| 3 | `--timeout` hit (task cancelled) |
| 130 | Ctrl-C (task cancelled) |

`--to AGENT` sends it to one machine, `--priority N` jumps the queue, `--json` prints `{id, status, failureReason, output, files}`.

</details>

<details>
<summary>The queue</summary>

| Feature | How |
|---|---|
| Order | Highest `priority` first, then oldest |
| Targeting | `--to pc`, `--to codex` or `--to codex@pc`: see [Agents working together](#agents-working-together). Must be paired (`handover devices`); anything else is refused |
| Leases | A claim lasts 10 min and is renewed while the agent works; a dead agent's task goes back to the queue and fails after 3 claims |
| Persistence | `tasks.json` in the config folder; finished tasks are kept for 24 h |

Relay tuning lives in `config.json` under `relay` (`port`, `tunnel`, `leaseSeconds`, `maxAttempts`, `retentionHours`, `data`) or as `handover serve` flags.

</details>

<details id="connect-other-agents">
<summary>Connect other agents · MCP tools</summary>

| Client | Connect with |
|---|---|
| Claude Code, Codex | Automatic during `host` / `join` |
| Claude Desktop, Cursor (stdio) | `{"command": "~/.local/bin/handover", "args": ["mcp"]}` (claims as the machine) |
| Any HTTP MCP client | `<host>/mcp` with `Authorization: Bearer <token>` and `X-Handover-Agent: <name>` |
| ChatGPT (developer mode) | Needs HTTPS: pick a tunnel in `handover setup`, then `<tunnel-url>/mcp?token=<token>&agent=<name>` |

| Tool | Does |
|---|---|
| `handover_list` | Tasks you can pick up |
| `handover_devices` | Machines on the relay and their agent addresses |
| `handover_next` | Claim the next task |
| `handover_watch` | Wait for the next task to arrive, then claim it |
| `handover_wait` | Wait for a task you created to finish; returns its output and files |
| `handover_claim` | Claim a specific task |
| `handover_renew` | Extend your claim on long work |
| `handover_complete` | Send output and files back; unblocks the waiter |
| `handover_get` | Read a task without claiming it |
| `handover_create` | Delegate a task (`to` a machine, an agent, or both) |

</details>

<details>
<summary>Configuration</summary>

| | |
|---|---|
| File | `config.json` (0600): `role`, `url`, `token`, `agent`, `auto`, `relay` |
| Env overrides | `HANDOVER_URL`, `HANDOVER_TOKEN`, `HANDOVER_AGENT`, `HANDOVER_HOME` (folder), `HANDOVER_NO_UPDATE_CHECK=1` |
| Updates | Commands in a terminal, Claude Code at session start and MCP clients are told when a new release is out (checked at most every 6 h) |
| Log | `handover service log` |

</details>

## ⚠️ Security

- The token grants full access to the queue: treat it like a password. Join commands carry it in `HANDOVER_TOKEN`, never as a command-line argument.
- Task context from another machine is untrusted input to your agent (prompt injection). Keep auto-pickup on default permissions.
- `?token=` URLs may be logged by tunnel providers; prefer header auth.
- Agent names are self-declared: `--to` routes work, it isn't access control.
- The host announces its name and a one-way network id on the LAN; the token is never broadcast.
- Received files are flat names only (no paths or dotfiles), max 25 MB per request.

Full spec: [docs/flow.md](docs/flow.md).

## Development

```bash
bun install
bun test tests
bun run typecheck
HANDOVER_SOURCE_DIR="$PWD" bash scripts/install.sh --no-setup   # install this checkout
```
