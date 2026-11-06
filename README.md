# Handover

Hand a task from one machine/agent to another LLM, and get the result back automatically.

```
 Machine A                     Relay (LAN or tunnel)             Machine B (Claude / ChatGPT / …)
 handover wait ──create──▶  task {id, objective, context}  ◀──handover_claim── LLM via MCP
      ▲  (blocks)                                           ◀──handover_complete(output, files)
      └──────── success + files written to ./handover-<id>/
```

## Install

```bash
cd handover && npm install && npm link   # gives you the `handover` command
```

## 1. Run the relay (once, on any machine)

| Reach | Command |
|---|---|
| Same network | `handover serve` |
| Anywhere (Cloudflare quick tunnel) | `handover serve --tunnel cloudflared` |
| Anywhere (Tailscale Funnel) | `handover serve --tunnel tailscale` |

It prints a **token** and URLs. Set them on every machine:

```bash
export HANDOVER_URL=http://192.168.1.20:7777 HANDOVER_TOKEN=<token>
```

Use a fixed token with `HANDOVER_TOKEN=... handover serve`, or it's random each start.

| Serve option | Default | Meaning |
|---|---|---|
| `--data <file\|none>` | `~/.handover/tasks.json` | Persist the queue (0600). `none` = memory only |
| `--lease <sec>` | 600 | How long a claim lasts before the task is requeued |
| `--max-attempts <n>` | 3 | Claims allowed before an expired task is marked `failed` (`lease_expired`) |
| `--retention <hours>` | 24 | Finished tasks are pruned after this |

## The queue

| Feature | How |
|---|---|
| Order | Highest `priority` first, then oldest |
| Targeting | `--to <agent>` → only that agent sees/claims it. Unaddressed = anyone |
| Agent name | `HANDOVER_AGENT` (default: hostname). HTTP MCP: `?agent=<name>` or `X-Handover-Agent` header |
| Leases | A claim expires after `--lease`; agents/workers renew while working. Dead agent → task goes back to the queue |
| Atomic pickup | `handover_next` / `POST /tasks/next` claims the next eligible task in one step |

## 2. Waiting side

```bash
handover wait --objective "Write a migration for X" --context-file notes.md --out ./result
handover wait --objective "Urgent fix" --priority 10 --to laptop
```

| Exit | Meaning |
|---|---|
| 0 | success — output on stdout, files in `--out` (default `./handover-<id>`) |
| 1 | agent reported `failed` |
| 2 | cancelled |
| 3 | `--timeout` hit (task is cancelled) |
| 130 | Ctrl-C (task is cancelled) |

`--json` prints `{id, status, failureReason, output, files}`. `--id foo` sets the id, or waits on an existing task.

## 3. Agent side — connect the MCP

**Claude Code / Desktop / Cursor (stdio):**

```json
{ "mcpServers": { "handover": {
    "command": "handover", "args": ["mcp"],
    "env": { "HANDOVER_URL": "http://192.168.1.20:7777", "HANDOVER_TOKEN": "<token>" } } } }
```

Or remote HTTP: `claude mcp add --transport http handover <URL>/mcp --header "Authorization: Bearer <token>"`

**ChatGPT (developer mode connector):** needs HTTPS → use `--tunnel`, then add `<tunnel-url>/mcp?token=<token>&agent=<name>` with "No authentication".

### Tools

| Tool | Does |
|---|---|
| `handover_list` | tasks you can pick up, queue order |
| `handover_next` | claim the next task for you (priority, then oldest) |
| `handover_claim` | claim a specific task by id |
| `handover_renew` | extend your lease on long work |
| `handover_complete` | send output + files (`utf8` or `base64`), unblocks the waiter |
| `handover_get` | read a task without claiming |
| `handover_create` | delegate the other way (`to`, `priority` optional; waiter runs `handover wait --id <id>`) |

## 4. Auto-pickup (no human needed)

| Option | How |
|---|---|
| Worker loop | `handover worker --exec "claude -p" --agent laptop` — takes the next task, pipes the briefing to the agent's stdin and renews the lease while it runs. If the agent doesn't call `handover_complete`, its stdout becomes the output. |
| Claude Code hook | Add to `~/.claude/settings.json` → pending tasks appear at session start: |

```json
{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "handover hook" } ] } ] } }
```

## ⚠️ Security

- Anyone with the token can read tasks and send results. Treat it like a password.
- `?token=` in the URL may be logged by tunnel providers — prefer header auth where the client supports it.
- Task context from another machine is untrusted input to your LLM (prompt injection).
- Received files are flat names only (no paths/dotfiles); size capped at 25 MB per request.
- The state file holds task context and results in plain text (mode 0600).
- Agent names are self-declared — targeting routes work, it is not access control.

## Test

```bash
npm test
```
