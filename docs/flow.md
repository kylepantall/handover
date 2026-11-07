# Setup flow

One machine is the **host**: it runs the relay that holds the queue. Every other machine is a **client**: it joins the host with the host's token. A client never runs a relay.

## Roles

| | Host | Client |
|---|---|---|
| Command | `handover host` | `handover join [HOST_URL]` |
| Installer | `--host` / `-Host` | `--join [URL]` / `-Join [-Url URL]` |
| Setup menu | "Host: other machines join this one" | "Join a host" |
| Runs the relay | Yes: login service by default on macOS/Linux; on Windows inside handover's MCP server / `wait` / `worker` (service opt-in) | Never. Joining removes a relay service this install had set up |
| Asks for | Nothing required (agent name; port and tunnel in the menu) | The **token** (hidden prompt or `HANDOVER_TOKEN`; never a command-line argument) |
| Finds the other side | Announces itself on the LAN (`_handover._tcp`, role `host`, one-way network id from the token) | Finds the host by mDNS: no URL. Asks for a URL only if none is found (other network, blocked multicast) |
| Prints | Token + join commands for macOS/Linux and Windows | "Joined <host> at <url>" |
| Agents | MCP server in Claude Code (+ SessionStart hook) and Codex, for each CLI that's installed (`--no-claude` / `--no-codex` skip) | Same |
| Auto-pickup | Asked in a terminal (default: the first agent found); `--auto claude\|codex\|off` in scripts; kept on rerun | Same |

## Commands

| Step | Host | Client |
|---|---|---|
| Install + set up | `curl …/install.sh \| bash -s -- --host` | The line `handover link` prints on the host: `curl …/install.sh \| HANDOVER_TOKEN=… bash -s -- --join` |
| Already installed | `handover host` | `handover join` (asks for the token) |
| Share access | `handover link` | — (`link` on a client says to run it on the host) |
| Health | `handover doctor`: relay up / idle, service | `handover doctor`: host found and token accepted |

## Verify

| Check | How |
|---|---|
| Just joined | `handover join` ends with a round trip through the host and lists who's online |
| Every machine | `handover test`: host answers; round trip; round robin where each online machine pings every other (full grid of directed links, with timings). Exit 1 if any link fails; `--json` for scripts |
| Presence | Every running handover process (host relay, Claude Code's MCP server, `worker`, `listen`) checks in with the host every 20 s; "online" means seen in the last 90 s |
| Answering | Pings are system tasks addressed to one agent, answered by its running handover process, never shown to Claude, `list`, the hook or the worker. Unanswered pings are cancelled after 60 s |
| A machine without Claude Code open | `handover listen` answers pings until stopped |

## Auto-pickup

| | |
|---|---|
| Runs | `claude -p --allowedTools mcp__handover` or `codex exec --skip-git-repo-check -`, briefing on stdin, in `<config>/work/<id>` |
| Permissions | The agent's own settings. `--full-access` adds `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`, and doctor warns |
| Where | The login service (`serve`) on macOS/Linux, on both roles. On Windows (no service by default) inside handover's MCP server while Claude Code or Codex is open. One worker per machine (`worker.lock` holds its pid); other processes check every 30 s and take over when it exits. Never inside an agent the worker started |
| Result | The agent calls `handover_complete`; if it doesn't, its stdout is the output (exit 0 → success) |
| Change it | `handover auto claude\|codex\|off [--full-access]`. On a client it installs or removes the login service; on a host it restarts a running one |

## Rules

- Token: the host keeps its token across reruns. A machine switching from client to host gets a new token unless `HANDOVER_TOKEN` is set. A client keeps whatever token it joined with.
- A client found by discovery stores the host's URL and refreshes it by mDNS when the host stops answering (IP changes). A client joined with an explicit URL never rediscovers.
- Discovery only accepts services announced with role `host` and the client's network id. v0.4–0.6 peers are ignored.
- Off the LAN: give the host a tunnel (`handover host --tunnel tailscale`); `handover link` then prints the tunnel URL in the join commands.

## Compatibility

| Old | Now |
|---|---|
| `--peer` / `-Peer` without a token | Host |
| `--peer` / `-Peer` with `HANDOVER_TOKEN` | Join (discovery) |
| `--relay` / `-Relay`, `setup --relay` | Host |
| `--join URL`, `-Join URL`, `setup --join URL` | Join that URL |
| Config with `peer: true` or `relay` | Read as host; rerun `handover join` to become a client |
