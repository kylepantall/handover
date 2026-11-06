import { existsSync } from 'node:fs';
import { claudeRegistration, hookInstalled } from './claude.ts';
import { probe } from './client.ts';
import { agentName, endpoint, loadConfig } from './config.ts';
import { PeerBrowser } from './discovery.ts';
import type { Paths } from './paths.ts';
import { serviceState } from './service.ts';
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
  if (!existsSync(p.config)) add('config', 'fail', 'not set up yet', 'handover setup');
  else {
    try {
      config = await loadConfig(p);
      add('config', 'ok', p.config);
    } catch (err) {
      add('config', 'fail', (err as Error).message, `Fix ${p.config} or rerun handover setup`);
    }
  }

  const ep = config.peer ? { ...endpoint(config), url: `http://127.0.0.1:${config.relay?.port ?? 7777}` } : endpoint(config);
  add('agent', 'info', agentName(config));
  add('mode', 'info', config.peer ? 'peer-to-peer (mDNS on this network)' : config.relay ? 'relay on this machine' : 'joined relay');
  if (!ep.token) add('relay', 'fail', `no token for ${ep.url}`, 'handover setup');
  else {
    const state = await probe(ep);
    if (state === 'ok') add('relay', 'ok', `${ep.url} reachable, token accepted`);
    else if (state === 'unauthorized') add('relay', 'fail', `${ep.url} rejected the token`, 'handover setup --join <url> --token <token>');
    else add('relay', 'fail', `${ep.url} unreachable`, config.relay ? 'handover service install' : 'Is the relay running?');
  }

  if (config.peer && ep.token) {
    const browser = new PeerBrowser(ep.token, { settleMs: 2000 });
    await browser.ready;
    const others = [...new Set(browser.peers().map((p) => p.agent).filter((a) => a !== agentName(config)))];
    browser.stop();
    if (others.length) add('peers', 'ok', others.join(', '));
    else add('peers', 'warn', 'no other peers seen', 'Run setup --peer with the same secret on another machine (handover token)');
  }

  if (config.relay) {
    const svc = await serviceState();
    if (svc === 'running') add('service', 'ok', 'relay runs at login');
    else if (svc === 'stopped') add('service', 'warn', 'installed but not running', `handover service restart (log: ${p.log})`);
    else if (svc === 'not-installed') add('service', 'info', 'not installed; run handover serve yourself', 'handover service install');
    else add('service', 'info', 'no service manager here; run handover serve yourself');
    if (config.relay.tunnel && !Bun.which(config.relay.tunnel))
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
