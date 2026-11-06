/** Keeps `handover serve` running at login: launchd on macOS, a systemd user unit on Linux. */

import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { selfCommand } from './claude.ts';
import { paths } from './paths.ts';
import { runProcess } from './process.ts';

export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unsupported';

const LABEL = 'com.kylepantall.handover';
const UNIT = 'handover.service';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user', UNIT);
const domain = () => `gui/${userInfo().uid}`;

/** Env the service needs: PATH (so --tunnel finds tailscale/cloudflared) and a custom HANDOVER_HOME. */
function serviceEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HANDOVER_HOME ? { HANDOVER_HOME: process.env.HANDOVER_HOME } : {}),
  };
}

export function serviceSupported(): boolean {
  return process.platform === 'darwin' || (process.platform === 'linux' && Bun.which('systemctl') != null);
}

export function plist(): string {
  const args = selfCommand('serve').map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const log = xml(paths().log);
  const env = Object.entries(serviceEnv())
    .map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${env}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

export function unit(): string {
  const exec = selfCommand('serve').map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  return `[Unit]
Description=Handover relay

[Service]
ExecStart=${exec}
${Object.entries(serviceEnv())
  .map(([k, v]) => `Environment="${k}=${v.replace(/(["\\])/g, '\\$1')}"`)
  .join('\n')}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

async function must(cmd: string, args: string[]): Promise<void> {
  const r = await runProcess(cmd, args);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

export async function installService(): Promise<void> {
  if (process.platform === 'darwin') {
    const file = plistPath();
    await mkdir(dirname(file), { recursive: true });
    await mkdir(paths().dir, { recursive: true, mode: 0o700 });
    await writeFile(file, plist());
    await runProcess('launchctl', ['bootout', `${domain()}/${LABEL}`]); // fine if it was not loaded
    await must('launchctl', ['bootstrap', domain(), file]);
    return;
  }
  if (serviceSupported()) {
    const file = unitPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, unit());
    await must('systemctl', ['--user', 'daemon-reload']);
    await must('systemctl', ['--user', 'enable', '--now', UNIT]);
    await must('systemctl', ['--user', 'restart', UNIT]);
    return;
  }
  throw new Error('no supported service manager (launchd or systemd --user); run `handover serve` yourself');
}

export async function uninstallService(): Promise<void> {
  if (process.platform === 'darwin') {
    await runProcess('launchctl', ['bootout', `${domain()}/${LABEL}`]);
    await rm(plistPath(), { force: true });
  } else if (serviceSupported()) {
    await runProcess('systemctl', ['--user', 'disable', '--now', UNIT]);
    await rm(unitPath(), { force: true });
    await runProcess('systemctl', ['--user', 'daemon-reload']);
  }
}

export async function serviceState(): Promise<ServiceState> {
  if (process.platform === 'darwin') {
    if (!existsSync(plistPath())) return 'not-installed';
    const r = await runProcess('launchctl', ['print', `${domain()}/${LABEL}`]);
    return r.code === 0 && /state = running/.test(r.stdout) ? 'running' : 'stopped';
  }
  if (!serviceSupported()) return 'unsupported';
  if (!existsSync(unitPath())) return 'not-installed';
  const r = await runProcess('systemctl', ['--user', 'is-active', UNIT]);
  return r.stdout.trim() === 'active' ? 'running' : 'stopped';
}
