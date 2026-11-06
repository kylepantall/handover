# Changelog

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
