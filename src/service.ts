/**
 * Keeps `handover serve` running at login: launchd on macOS, a systemd user
 * unit on Linux, a Task Scheduler logon task on Windows.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { selfCommand } from './claude.ts';
import { DEFAULT_PORT, loadConfig } from './config.ts';
import { isWindows, paths, windowsSystem } from './paths.ts';
import { runProcess } from './process.ts';

/** 'legacy': the hidden conhost logon task v0.5.0 created (the pattern antivirus flagged). */
export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unsupported' | 'legacy';

/** True for v0.5.0's task: hidden, run through conhost --headless. */
export const isLegacyTaskXml = (xml: string): boolean => /conhost|<Hidden>\s*true\s*<\/Hidden>/i.test(xml);

const LABEL = 'com.kylepantall.handover';
/** Absolute, like the Windows system tools: never whatever `launchctl` PATH finds first. */
const LAUNCHCTL = '/bin/launchctl';
const UNIT = 'handover.service';
const TASK = 'handover-relay';

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
  return process.platform === 'darwin' || isWindows || (process.platform === 'linux' && Bun.which('systemctl') != null);
}

/**
 * Whether setup turns the login service on unless told otherwise. Not on
 * Windows: there the relay runs inside handover's MCP server instead, and a
 * logon task is what antivirus behaviour engines score as persistence.
 */
export const serviceByDefault = (): boolean => serviceSupported() && !isWindows;

/** Windows quoting for one argument of a command line (CommandLineToArgvW rules). */
const winArg = (a: string) => (/^[^\s"]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

/**
 * Task Scheduler definition (opt-in on Windows; by default the relay runs
 * inside handover's MCP server while Claude Code is open). It is deliberately
 * not hidden: a hidden logon task launched through conhost --headless is what
 * antivirus behaviour engines flag as malware persistence. Task actions can't
 * set environment variables, so the data folder is passed as `--home`. No
 * battery or 72-hour limits, and it restarts if it crashes.
 */
export function taskXml(): string {
  const [exe, ...args] = selfCommand('serve', '--home', paths().dir, '--log', paths().log);
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : (process.env.USERNAME ?? userInfo().username);
  const commandLine = args.map(winArg).join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Handover relay (handover serve)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(exe!)}</Command><Arguments>${xml(commandLine)}</Arguments></Exec></Actions>
</Task>
`;
}

async function localRelayUp(): Promise<boolean> {
  const config = await loadConfig(paths()).catch(() => ({}) as Awaited<ReturnType<typeof loadConfig>>);
  const port = config.relay?.port ?? DEFAULT_PORT;
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
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

/**
 * Unloads the job and waits until launchd has finished: bootout returns before
 * the job is gone, and loading it again meanwhile fails with
 * "Bootstrap failed: 5: Input/output error".
 */
async function unloadLaunchd(): Promise<void> {
  const target = `${domain()}/${LABEL}`;
  await runProcess(LAUNCHCTL, ['bootout', target]); // fine if it was not loaded
  const end = Date.now() + 10_000;
  while (Date.now() < end && (await runProcess(LAUNCHCTL, ['print', target])).code === 0) await Bun.sleep(200);
}

export async function installService(): Promise<void> {
  if (isWindows) {
    const schtasks = windowsSystem('schtasks.exe');
    await mkdir(paths().dir, { recursive: true });
    const dir = await mkdtemp(join(tmpdir(), 'handover-task-'));
    try {
      const file = join(dir, 'task.xml');
      // schtasks reads task XML reliably only as UTF-16 with a byte-order mark.
      await writeFile(file, Buffer.from('\ufeff' + taskXml(), 'utf16le'));
      await must(schtasks, ['/Create', '/TN', TASK, '/XML', file, '/F']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    await runProcess(schtasks, ['/End', '/TN', TASK]); // restart if it was running
    await must(schtasks, ['/Run', '/TN', TASK]);
    return;
  }
  if (process.platform === 'darwin') {
    const file = plistPath();
    await mkdir(dirname(file), { recursive: true });
    await mkdir(paths().dir, { recursive: true, mode: 0o700 });
    await writeFile(file, plist());
    await unloadLaunchd();
    // Even after unloading, launchd can briefly refuse the same label (error 5).
    for (let attempt = 1; ; attempt++) {
      const r = await runProcess(LAUNCHCTL, ['bootstrap', domain(), file]);
      if (r.code === 0) break;
      if (attempt >= 5) throw new Error(`launchctl bootstrap ${domain()} ${file} failed: ${r.stderr.trim() || r.stdout.trim()}`);
      await Bun.sleep(1000);
    }
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
  throw new Error('no supported service manager (launchd, systemd --user or Task Scheduler); run `handover serve` yourself');
}

export async function uninstallService(): Promise<void> {
  if (isWindows) {
    await runProcess(windowsSystem('schtasks.exe'), ['/End', '/TN', TASK]);
    await runProcess(windowsSystem('schtasks.exe'), ['/Delete', '/TN', TASK, '/F']);
  } else if (process.platform === 'darwin') {
    await unloadLaunchd();
    await rm(plistPath(), { force: true });
  } else if (serviceSupported()) {
    await runProcess('systemctl', ['--user', 'disable', '--now', UNIT]);
    await rm(unitPath(), { force: true });
    await runProcess('systemctl', ['--user', 'daemon-reload']);
  }
}

export async function serviceState(): Promise<ServiceState> {
  if (isWindows) {
    const r = await runProcess(windowsSystem('schtasks.exe'), ['/Query', '/TN', TASK, '/XML']);
    if (r.code !== 0) return 'not-installed';
    if (isLegacyTaskXml(r.stdout)) return 'legacy';
    // schtasks' status column is localized; ask the relay instead.
    return (await localRelayUp()) ? 'running' : 'stopped';
  }
  if (process.platform === 'darwin') {
    if (!existsSync(plistPath())) return 'not-installed';
    const r = await runProcess(LAUNCHCTL, ['print', `${domain()}/${LABEL}`]);
    return r.code === 0 && /state = running/.test(r.stdout) ? 'running' : 'stopped';
  }
  if (!serviceSupported()) return 'unsupported';
  if (!existsSync(unitPath())) return 'not-installed';
  const r = await runProcess('systemctl', ['--user', 'is-active', UNIT]);
  return r.stdout.trim() === 'active' ? 'running' : 'stopped';
}

/**
 * Whether the installed login service runs this install (its executable or
 * launcher). The service label is machine-wide, so a test checkout or a second
 * install must never remove or replace the user's real one.
 */
export async function serviceIsOurs(): Promise<boolean> {
  const [exe] = selfCommand();
  let definition = '';
  if (isWindows) {
    const r = await runProcess(windowsSystem('schtasks.exe'), ['/Query', '/TN', TASK, '/XML']);
    if (r.code !== 0) return false;
    definition = r.stdout;
  } else {
    const file = process.platform === 'darwin' ? plistPath() : unitPath();
    if (!existsSync(file)) return false;
    definition = await Bun.file(file).text();
  }
  return definition.includes(exe!) || (isWindows && definition.includes(exe!.replace(/\//g, '\\')));
}
