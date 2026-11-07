#!/usr/bin/env bash
set -euo pipefail

# Installs handover from GitHub on macOS or Linux: a private Bun if needed, the
# app, and a launcher in ~/.local/bin. Then runs "handover setup".
# HANDOVER_SOURCE_DIR installs from a local checkout instead of downloading.
HANDOVER_REPO="${HANDOVER_REPO:-kylepantall/handover}"
BUN_VERSION=1.4.3

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# Runs a noisy command quietly, showing its output only if it fails.
quiet() {
  local log="$HANDOVER_INSTALL_TEMP/step.log"
  if ! "$@" >"$log" 2>&1; then
    sed 's/^/    | /' "$log" >&2
    return 1
  fi
}

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

usage() {
  cat <<EOF
Usage: bash install.sh [options] [REF]

Installs $HANDOVER_REPO (branch, tag or commit; default main) under
~/.local/share/handover with a launcher in ~/.local/bin, then sets it up.

  --host                  Make this machine the host: prints the token and join commands
  --join [URL]            Join a host. Token in HANDOVER_TOKEN (handover link on the host prints
                          the whole command), otherwise asked for. Finds the host on this
                          network; URL only if it's elsewhere
  --agent NAME            Agent name for this machine (default: hostname)
  --auto AGENT            Take handovers automatically: claude, codex, both or off (asked in a terminal)
  --full-access           Auto-pickup skips the agent's permission prompts and sandbox (risky)
  --no-claude             Don't add handover to Claude Code (added by default when installed)
  --no-codex              Don't add handover to Codex (added by default when installed)
  --no-service            Host: don't start the relay at login (it runs while Claude Code is open)
  --no-setup              Install only; run "handover setup" later

No option: a menu asks host or join. See docs/flow.md.
Override with HANDOVER_INSTALL_DIR, HANDOVER_BIN_DIR, HANDOVER_REPO and HANDOVER_SOURCE_DIR.
EOF
}

main() {
  local ref='main' run_setup=true mode='' join_url='' claude=false
  local -a role_args=()
  while (($#)); do
    case "$1" in
      --help | -h) usage; return ;;
      --no-setup) run_setup=false ;;
      --host | --relay) mode=host ;;
      --join)
        mode=join
        if [[ $# -ge 2 && "$2" =~ ^https?:// ]]; then join_url="$2"; shift; fi
        ;;
      # Old flag: the first machine (no token) hosts; with a token it joins.
      --peer) mode=peer ;;
      --token)
        # Old links; hand it over through the environment, never argv.
        [[ $# -ge 2 ]] || { printf '%s needs a value.\n' "$1" >&2; return 1; }
        export HANDOVER_TOKEN="$2"
        shift
        ;;
      --agent)
        [[ $# -ge 2 ]] || { printf '%s needs a value.\n' "$1" >&2; return 1; }
        role_args+=(--agent "$2")
        shift
        ;;
      --claude) claude=true ;; # default now; kept for old links
      --no-claude | --no-codex | --full-access | --no-service) role_args+=("$1") ;;
      --auto)
        [[ $# -ge 2 ]] || { printf '%s needs a value.\n' "$1" >&2; return 1; }
        role_args+=(--auto "$2")
        shift
        ;;
      -*) printf 'Unknown option: %s\n' "$1" >&2; return 1 ;;
      *) ref="$1" ;;
    esac
    shift
  done
  if [[ "$mode" == peer ]]; then
    if [[ -n "${HANDOVER_TOKEN:-}" ]]; then mode=join; else mode=host; fi
  fi
  if [[ ! "$ref" =~ ^[A-Za-z0-9._/-]+$ || "$ref" == *..* || "$ref" == /* || "$ref" == */ ]]; then
    printf 'Invalid ref: %s\n' "$ref" >&2
    return 1
  fi
  [[ -n "${HOME:-}" ]] || { printf 'HOME must be set.\n' >&2; return 1; }

  local os
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) printf 'handover installs on macOS and Linux.\n' >&2; return 1 ;;
  esac
  local source_label="$HANDOVER_REPO@$ref"
  [[ -z "${HANDOVER_SOURCE_DIR:-}" ]] || source_label="$HANDOVER_SOURCE_DIR"
  printf 'handover installer — %s\n' "$source_label"

  HANDOVER_INSTALL_TEMP="$(mktemp -d)"
  local temp_dir="$HANDOVER_INSTALL_TEMP"
  trap 'rm -rf -- "$HANDOVER_INSTALL_TEMP"' EXIT

  local install_dir="${HANDOVER_INSTALL_DIR:-$HOME/.local/share/handover}"
  local bin_dir="${HANDOVER_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir" "$bin_dir"
  install_dir="$(cd "$install_dir" && pwd)"
  bin_dir="$(cd "$bin_dir" && pwd)"

  step 'Bun runtime'
  local bun_bin
  if command -v bun >/dev/null 2>&1 &&
    bun -e "process.exit(Bun.semver.satisfies(Bun.version, '>=$BUN_VERSION') ? 0 : 1)" >/dev/null 2>&1; then
    bun_bin="$(command -v bun)"
    info "Using $bun_bin ($("$bun_bin" --version))"
  elif [[ -x "$install_dir/runtime/bun-$BUN_VERSION/bun" ]]; then
    bun_bin="$install_dir/runtime/bun-$BUN_VERSION/bun"
    info "Using private Bun $BUN_VERSION from a previous install"
  else
    local arch archive expected base="https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION"
    case "$(uname -m)" in
      arm64 | aarch64) arch=aarch64 ;;
      x86_64) arch=x64-baseline ;;
      *) printf 'Unsupported architecture. Install Bun %s+ first.\n' "$BUN_VERSION" >&2; return 1 ;;
    esac
    archive="bun-$os-$arch.zip"
    command -v unzip >/dev/null 2>&1 || { printf 'unzip not found; install it and rerun.\n' >&2; return 1; }
    info "Downloading a private Bun $BUN_VERSION ($archive) and verifying its checksum"
    curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 "$base/SHASUMS256.txt" -o "$temp_dir/SHASUMS256.txt"
    expected="$(awk -v file="$archive" '$2 == file || $2 == ("*" file) {print $1; exit}' "$temp_dir/SHASUMS256.txt")"
    [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || { printf 'Bun archive checksum not found.\n' >&2; return 1; }
    curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 "$base/$archive" -o "$temp_dir/$archive"
    [[ "$(sha256 "$temp_dir/$archive")" == "$expected" ]] || { printf 'Bun checksum mismatch.\n' >&2; return 1; }
    unzip -q "$temp_dir/$archive" -d "$temp_dir"
    local runtime_dir="$install_dir/runtime/bun-$BUN_VERSION"
    mkdir -p "$runtime_dir"
    cp "$temp_dir/${archive%.zip}/bun" "$runtime_dir/.bun-new"
    chmod +x "$runtime_dir/.bun-new"
    mv -f "$runtime_dir/.bun-new" "$runtime_dir/bun"
    bun_bin="$runtime_dir/bun"
    info "Installed to $bun_bin"
  fi

  # Build into a fresh directory and swap it in, so a failed install leaves the
  # working one untouched. Config and the queue live in ~/.config/handover.
  local staging="$install_dir/app.new"
  rm -rf -- "$staging"
  mkdir -p "$staging"
  step 'Fetching source'
  if [[ -n "${HANDOVER_SOURCE_DIR:-}" ]]; then
    info "Copying $HANDOVER_SOURCE_DIR"
    (cd "$HANDOVER_SOURCE_DIR" && git ls-files -z --cached --others --exclude-standard |
      xargs -0 tar -cf - --) | tar -xf - -C "$staging"
  else
    info "Downloading github.com/$HANDOVER_REPO ($ref)"
    curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 \
      "https://codeload.github.com/$HANDOVER_REPO/tar.gz/$ref" -o "$temp_dir/source.tar.gz"
    tar -xzf "$temp_dir/source.tar.gz" -C "$staging" --strip-components 1
  fi

  step 'Installing dependencies'
  (cd "$staging" && quiet "$bun_bin" install --frozen-lockfile --production --ignore-scripts)
  info 'Done'

  rm -rf -- "$install_dir/app.old"
  [[ ! -d "$install_dir/app" ]] || mv "$install_dir/app" "$install_dir/app.old"
  mv "$staging" "$install_dir/app"
  rm -rf -- "$install_dir/app.old"
  info "Installed into $install_dir/app"

  step 'Installing launcher'
  local launcher
  launcher="$(mktemp "$bin_dir/.handover.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export HANDOVER_LAUNCHER=%q\n' "$bin_dir/handover"
    # Bun reads bunfig.toml (preload) and .env from its working directory, which
    # is often a project an agent can write to. Start in the app folder instead;
    # handover changes back to HANDOVER_CWD itself.
    printf 'export HANDOVER_CWD="$PWD"\n'
    printf 'cd %q || exit 1\n' "$install_dir/app"
    printf 'exec %q %q "$@"\n' "$bun_bin" "$install_dir/app/src/index.ts"
  } >"$launcher"
  chmod +x "$launcher"
  mv -f "$launcher" "$bin_dir/handover"
  info "$bin_dir/handover (version $("$bin_dir/handover" --version 2>&1))"

  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf '\nAdd %s to your PATH to run handover from a terminal.\n' "$bin_dir" ;;
  esac

  # A running relay keeps the old code until it restarts. The service name is
  # machine-wide, so only restart one that runs this install's launcher.
  local plist="$HOME/Library/LaunchAgents/com.kylepantall.handover.plist"
  local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/handover.service"
  if grep -qsF "$bin_dir/handover" "$plist" "$unit" 2>/dev/null &&
    [[ "$("$bin_dir/handover" service status 2>/dev/null)" == running ]]; then
    step 'Restarting the relay service'
    quiet "$bin_dir/handover" service restart && info 'Done'
  fi

  [[ "$run_setup" == true ]] || { printf '\nhandover installed. Next: handover host, or handover join\n'; return; }

  local data_dir="${HANDOVER_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/handover}"
  # Under curl | bash, stdin is the pipe. Hand prompts the real terminal behind stdout.
  local tty_dev=''
  if [[ -t 0 ]]; then
    tty_dev=/dev/stdin
  elif [[ -t 1 ]]; then
    tty_dev="$(tty <&1 2>/dev/null)" || tty_dev=''
  fi
  local has_tty=false
  [[ "$tty_dev" == /dev/* && "$tty_dev" != /dev/tty ]] && has_tty=true

  case "$mode" in
    host)
      step 'Host'
      # In a terminal, so it can ask about auto-pickup.
      if [[ "$has_tty" == true ]]; then
        "$bin_dir/handover" host ${role_args[@]+"${role_args[@]}"} <"$tty_dev"
      else
        "$bin_dir/handover" host ${role_args[@]+"${role_args[@]}"}
      fi
      ;;
    join)
      step 'Join'
      local -a join_args=()
      [[ -z "$join_url" ]] || join_args+=("$join_url")
      if [[ "$has_tty" == true ]]; then
        # Asks for the token (unless HANDOVER_TOKEN is set) and about auto-pickup.
        "$bin_dir/handover" join ${join_args[@]+"${join_args[@]}"} ${role_args[@]+"${role_args[@]}"} <"$tty_dev"
      else
        "$bin_dir/handover" join ${join_args[@]+"${join_args[@]}"} ${role_args[@]+"${role_args[@]}"}
      fi
      ;;
    *)
      if [[ ! -f "$data_dir/config.json" && "$has_tty" == true ]]; then
        step 'Setup'
        "$bin_dir/handover" setup <"$tty_dev" || info 'Setup did not finish; rerun it any time with: handover setup'
      elif [[ "$claude" == true && -f "$data_dir/config.json" ]]; then
        "$bin_dir/handover" setup --claude --hook
      else
        printf '\nhandover installed. Next: handover host (this machine is the hub) or handover join\n'
      fi
      ;;
  esac
}

main "$@"
