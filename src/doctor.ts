import { existsSync } from 'node:fs';
import { claudeRegistration, hookInstalled } from './claude.ts';
import { probe } from './client.ts';
import { agentName, DEFAULT_PORT, endpoint, loadConfig, roleOf } from './config.ts';
import { hostUrl } from './connect.ts';
import type { Paths } from './paths.ts';
import { serviceIsOurs, serviceState } from './service.ts';
import type { Config } from './types.ts';
import { compareVersions, latestVersion, resolveRef } from './update.ts';
import { VERSION } from './version.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  area: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export async function runChecks(p: Paths, { offline = false } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (area: string, status: CheckStatus, detail: string, fix?: string) => checks.push({ area, status, detail, fix });

  add('handover', 'info', `${VERSION} (${process.platform}/${process.arch}, data in ${p.dir})`);
  if (!offline) {
    try {
      const latest = await latestVersion(await resolveRef('main'));
      if (compareVersions(latest, VERSION) > 0) add('update', 'warn', `${latest} is available`, 'handover update');
    } catch {
      add('update', 'info', 'could not check GitHub for a newer version');
    }
  }

  let config: Config = {};
  if (!existsSync(p.config)) add('config', 'fail', 'not set up yet', 'handover host or handover join');
  else {
    try {
      config = await loadConfig(p);
      add('config', 'ok', p.config);
    } catch (err) {
      add('config', 'fail', (err as Error).message, `Fix ${p.config} or rerun handover setup`);
    }
  }

  const role = roleOf(config);
  const ep = endpoint(config);
  add('agent', 'info', agentName(config));
  if (!role || !ep.token) {
    add('role', 'fail', 'not set up', 'handover host (this machine is the hub) or handover join');
  } else if (role === 'host') {
    add('role', 'info', 'host: runs the relay; share access with handover link');
    const local = { url: `http://127.0.0.1:${config.relay?.port ?? DEFAULT_PORT}`, token: ep.token };
    const state = await probe(local);
    if (state === 'ok') add('relay', 'ok', `${local.url} running, token accepted`);
    else if (state === 'unauthorized') add('relay', 'fail', `${local.url} is another handover with a different token`, 'handover service restart');
    else if (['running', 'stopped'].includes(await serviceState()) && (await serviceIsOurs()))
      add('relay', 'fail', `${local.url} not answering, but the login service is installed`, `handover service restart (log: ${p.log})`);
    // Hosted on demand: not running is the normal idle state, not a failure.
    else add('relay', 'info', 'not running right now; starts with Claude Code’s MCP server, wait or worker', 'handover service install (to keep it running)');
  } else {
    const url = (await hostUrl(p, config)) ?? ep.url;
    add('role', 'info', `client of ${url}${config.discover ? ' (found on this network)' : ''}`);
    const state = await probe({ url, token: ep.token });
    if (state === 'ok') add('host', 'ok', `${url} reachable, token accepted`);
    else if (state === 'unauthorized') add('host', 'fail', `${url} rejected the token`, 'handover join (with the token from handover link on the host)');
    else
      add('host', 'fail', `${url} not answering`, 'Is the host on? A Windows host runs its relay while Claude Code is open there; handover doctor on the host');
    if (['running', 'stopped'].includes(await serviceState()) && (await serviceIsOurs()))
      add('service', 'warn', 'this client still has a relay login service', 'handover service uninstall');
  }

  if (role === 'host') {
    const svc = await serviceState();
    if (svc === 'legacy')
      add('service', 'fail', 'old hidden logon task from v0.5.0 (the pattern antivirus flagged)', "handover service uninstall, or delete 'handover-relay' in Task Scheduler");
    else if (svc === 'running') add('service', 'ok', 'relay runs at login');
    else if (svc === 'stopped') add('service', 'warn', 'installed but not running', `handover service restart (log: ${p.log})`);
    else if (svc === 'not-installed')
      add('service', 'info', 'not installed: the relay runs inside handover (Claude Code’s MCP server, wait, worker) while one is open', 'handover service install');
    else add('service', 'info', 'no service manager here; run handover serve yourself');
    if (config.relay?.tunnel && !Bun.which(config.relay.tunnel))
      add('tunnel', 'fail', `${config.relay.tunnel} not installed`, config.relay.tunnel === 'tailscale' ? 'brew install tailscale' : 'brew install cloudflared');
  }

  const claude = await claudeRegistration();
  if (claude === 'registered') add('claude code', 'ok', 'handover MCP server registered');
  else if (claude === 'missing') add('claude code', 'warn', 'MCP server not registered', 'handover setup');
  else add('claude code', 'info', 'claude CLI not found');
  if (claude !== 'no-claude') {
    try {
      if (await hookInstalled()) add('claude hook', 'ok', 'pending handovers shown at session start');
      else add('claude hook', 'info', 'SessionStart hook not installed', 'handover setup');
    } catch (err) {
      add('claude hook', 'warn', (err as Error).message);
    }
  }
  return checks;
}

const ICONS: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.area.length));
  return checks
    .map((c) => `${ICONS[c.status]} ${c.area.padEnd(width)}  ${c.detail}${c.fix ? `\n  ${' '.repeat(width)}  → ${c.fix}` : ''}`)
    .join('\n');
}

export async function runDoctor(p: Paths, { json = false } = {}): Promise<number> {
  const checks = await runChecks(p);
  process.stdout.write((json ? JSON.stringify(checks, null, 2) : formatChecks(checks)) + '\n');
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
