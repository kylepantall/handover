#!/usr/bin/env bash
set -uo pipefail

# Removes handover from macOS or Linux: the login service, running relays,
# the Claude Code MCP server and SessionStart hook, the app, the launcher and
# (unless --keep-config) the config and queue.
#
#   curl -fsSL https://raw.githubusercontent.com/kylepantall/handover/main/scripts/uninstall.sh | bash
#
# Only removes what belongs to this install (paths under HANDOVER_INSTALL_DIR /
# HANDOVER_BIN_DIR), so another copy of handover is left alone.

ok() { printf '  \342\234\223 %s\n' "$*"; }
skip() { printf '  \302\267 %s\n' "$*"; }
bad() { printf '  \342\234\227 %s\n' "$*"; failures=$((failures + 1)); }
failures=0

keep_config=false
for arg in "$@"; do
  case "$arg" in
    --keep-config) keep_config=true ;;
    --help | -h)
      printf 'Usage: bash uninstall.sh [--keep-config]\n'
      printf 'Removes handover; --keep-config keeps %s (secret and queue).\n' "${HANDOVER_HOME:-~/.config/handover}"
      exit 0
      ;;
    *) printf 'Unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done
[[ -n "${HOME:-}" ]] || { printf 'HOME must be set.\n' >&2; exit 1; }

install_dir="${HANDOVER_INSTALL_DIR:-$HOME/.local/share/handover}"
bin_dir="${HANDOVER_BIN_DIR:-$HOME/.local/bin}"
launcher="$bin_dir/handover"
data_dir="${HANDOVER_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/handover}"
claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

printf 'Removing handover (%s)\n\n' "$install_dir"

printf 'Login service\n'
case "$(uname -s)" in
  Darwin)
    plist="$HOME/Library/LaunchAgents/com.kylepantall.handover.plist"
    if [[ ! -f "$plist" ]]; then
      skip 'none installed'
    elif ! grep -qF "$launcher" "$plist"; then
      skip "$plist belongs to another handover install; left alone"
    else
      launchctl bootout "gui/$(id -u)/com.kylepantall.handover" 2>/dev/null
      if rm -f "$plist"; then ok "removed $plist"; else bad "could not remove $plist"; fi
    fi
    ;;
  Linux)
    unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/handover.service"
    if [[ ! -f "$unit" ]]; then
      skip 'none installed'
    elif ! grep -qF "$launcher" "$unit"; then
      skip "$unit belongs to another handover install; left alone"
    else
      systemctl --user disable --now handover.service 2>/dev/null
      if rm -f "$unit"; then ok "removed $unit"; else bad "could not remove $unit"; fi
      systemctl --user daemon-reload 2>/dev/null
    fi
    ;;
esac

printf 'Running processes\n'
if pgrep -f "$install_dir/app/src/index.ts" >/dev/null 2>&1; then
  pkill -f "$install_dir/app/src/index.ts"
  sleep 1
  if pgrep -f "$install_dir/app/src/index.ts" >/dev/null 2>&1; then
    pkill -9 -f "$install_dir/app/src/index.ts"
  fi
  ok 'stopped'
else
  skip 'none running'
fi

printf 'Claude Code\n'
if ! command -v claude >/dev/null 2>&1; then
  skip 'claude CLI not found'
else
  registered="$(claude mcp get handover 2>/dev/null)"
  if [[ -z "$registered" ]]; then
    skip 'MCP server not registered'
  elif [[ "$registered" != *"$launcher"* ]]; then
    skip 'MCP server "handover" points at another install; left alone'
  elif claude mcp remove handover --scope user >/dev/null 2>&1; then
    ok 'removed MCP server "handover"'
  else
    bad 'could not remove the MCP server: claude mcp remove handover --scope user'
  fi
fi

# The SessionStart hook lives in settings.json; edit it with whatever JavaScript
# runtime is around (handover's private Bun, bun, or node).
settings="$claude_dir/settings.json"
runtime="$(ls "$install_dir"/runtime/bun-*/bun 2>/dev/null | head -n 1)"
[[ -n "$runtime" ]] || runtime="$(command -v bun || command -v node || true)"
if [[ ! -f "$settings" ]] || ! grep -q 'handover' "$settings"; then
  skip 'no SessionStart hook'
elif [[ -z "$runtime" ]]; then
  bad "no bun or node to edit $settings: remove the \"$launcher hook\" entry yourself"
else
  removed="$(SETTINGS="$settings" LAUNCHER="$launcher" "$runtime" -e '
    const fs = require("fs");
    const file = process.env.SETTINGS;
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const ours = (h) => typeof h.command === "string" && h.command.includes(process.env.LAUNCHER) && /hook\s*$/.test(h.command);
    let n = 0;
    const groups = (s.hooks && s.hooks.SessionStart) || [];
    for (const g of groups) { const before = (g.hooks || []).length; g.hooks = (g.hooks || []).filter((h) => !ours(h)); n += before - g.hooks.length; }
    if (n) {
      s.hooks.SessionStart = groups.filter((g) => g.hooks.length);
      if (!s.hooks.SessionStart.length) delete s.hooks.SessionStart;
      if (!Object.keys(s.hooks).length) delete s.hooks;
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
    }
    console.log(n);
  ' 2>&1)"
  if [[ "$removed" =~ ^[0-9]+$ ]]; then
    if ((removed > 0)); then ok "removed the SessionStart hook from $settings"; else skip 'no SessionStart hook for this install'; fi
  else
    bad "could not edit $settings: $removed"
  fi
fi

printf 'Files\n'
for path in "$launcher" "$install_dir"; do
  if [[ ! -e "$path" ]]; then skip "$path not found"
  elif rm -rf -- "$path"; then ok "removed $path"
  else bad "could not remove $path"; fi
done
if [[ "$keep_config" == true ]]; then
  skip "kept $data_dir (--keep-config)"
elif [[ ! -e "$data_dir" ]]; then
  skip "$data_dir not found"
elif rm -rf -- "$data_dir"; then
  ok "removed $data_dir (config, secret, queue)"
else
  bad "could not remove $data_dir"
fi

if ((failures)); then
  printf '\n%d step(s) failed; see above.\n' "$failures"
  exit 1
fi
printf '\nhandover removed.\n'
