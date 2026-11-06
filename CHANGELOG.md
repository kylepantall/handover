# Changelog

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
