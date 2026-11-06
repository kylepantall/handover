# Antivirus false positives

handover.exe is a Bun-compiled, (by default) unsigned executable that opens a network port. Behaviour engines can score that as suspicious.

## What changed after Bitdefender flagged v0.5.0

| v0.5.0 did | Now |
|---|---|
| Created a **hidden** logon task running `conhost --headless handover.exe serve` during setup | No logon task by default on Windows. The relay runs inside handover's MCP server (started by Claude Code), `wait` or `worker`. `handover service install` is opt-in and creates a visible task |
| Passed the secret as `--token` on handover.exe's command line | The secret travels in `HANDOVER_TOKEN`; it never appears in a command line |
| Unsigned exe | Release workflow signs it when Azure Artifact Signing is configured ([signing.md](signing.md)) |

## Reporting a false positive to Bitdefender

Submit at [bitdefender.com/submit](https://www.bitdefender.com/submit/) (the [business form](https://www.bitdefender.com/en-us/business/submit) reaches the same lab if the consumer one fails). Category: **False positive**.

| Field | Value (v0.5.0) |
|---|---|
| File | `handover.exe` from [handover-windows-x64.zip](https://github.com/kylepantall/handover/releases/download/v0.5.0/handover-windows-x64.zip) |
| SHA-256 (exe) | `360ef891a687fe042cff88f1c78341c6cb2437e0466befb409227476da09541e` |
| SHA-256 (zip) | `c60f67e4d85893f3172488df9b6bf1b19c1dcd570359d246391021d913e92165` |
| Detection | Advanced Threat Defense, "Malware", on `handover.exe setup --peer` |
| Screenshot | The Advanced Threat Defense entry. **Crop out or blur the token** |

The exe is about 97 MB, over the form's 25 MB limit: give the release URL above instead of uploading, or ask Bitdefender support for an upload link.

Suggested reason:

> handover is an open-source (MIT) CLI and MCP server that passes tasks between AI coding agents on a local network: https://github.com/kylepantall/handover. The binary is built by GitHub Actions from public source with `bun build --compile` and published with a SHA256SUMS file. The flagged run was its first-time setup, which created a Task Scheduler logon task for its local relay. Later versions no longer create that task by default.
