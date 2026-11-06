/**
 * `handover test`: proves the machines talk. Checks the host answers, does a
 * round trip to this machine through the host, then a round robin: pings each
 * online machine and asks each to ping every other, so every pair is tested.
 * `handover listen`: answers pings on a machine without Claude Code open.
 */

import { loadConfig, roleOf } from './config.ts';
import { connect } from './connect.ts';
import { keepLocalRelay } from './host.ts';
import type { Paths } from './paths.ts';
import { pingAgent, startResponder, type Link } from './responder.ts';
import type { AgentPresence } from './types.ts';

export interface TestReport {
  agent: string;
  host: string;
  hostOk: boolean;
  hostError?: string;
  self?: Link;
  online: AgentPresence[];
  links: Link[];
  ok: boolean;
}

/** Runs the checks; `timeoutMs` bounds each ping. */
export async function testConnections(p: Paths, { timeoutMs = 8_000 } = {}): Promise<TestReport> {
  const config = await loadConfig(p);
  const { api, agent, label } = await connect(p, config);
  const report: TestReport = { agent, host: label, hostOk: false, online: [], links: [], ok: false };
  try {
    await api.list({ status: 'pending' });
    report.hostOk = true;
  } catch (err) {
    report.hostError = (err as Error).message;
    return report;
  }

  // Answer pings while testing, so other machines can reach this one too.
  if (roleOf(config) === 'host') keepLocalRelay(p, config);
  const responder = startResponder(api, { agent, via: 'test' });
  try {
    const self = await pingAgent(api, agent, agent, { timeoutMs });
    report.self = { from: agent, to: agent, ok: self.ok, ms: self.ms, error: self.error };

    report.online = await api.agents();
    const others = report.online.map((a) => a.agent).filter((a) => a !== agent);
    const results = await Promise.all(
      others.map((to) => pingAgent(api, agent, to, { timeoutMs, relayTo: [agent, ...others.filter((o) => o !== to)] }))
    );
    others.forEach((to, i) => {
      const r = results[i]!;
      report.links.push({ from: agent, to, ok: r.ok, ms: r.ms, error: r.error });
      for (const link of r.reply?.links ?? []) report.links.push(link);
      // It didn't answer, so it couldn't test its own links either.
      if (!r.ok) for (const o of [agent, ...others.filter((x) => x !== to)]) report.links.push({ from: to, to: o, ok: false, error: 'not tested: no answer' });
    });
  } finally {
    responder.stop();
  }
  report.ok = report.hostOk && !!report.self?.ok && report.links.every((l) => l.ok);
  return report;
}

const mark = (ok: boolean) => (ok ? '✓' : '✗');
const ms = (l: Link) => (l.ok ? `${l.ms} ms` : l.error ?? 'failed');

export function formatReport(r: TestReport): string {
  const lines = [`handover test (as ${r.agent})`, ''];
  if (!r.hostOk) {
    lines.push(`✗ host      ${r.host}: ${r.hostError}`, '  → handover doctor');
    return lines.join('\n');
  }
  lines.push(`✓ host      ${r.host} answers, token accepted`);
  if (r.self) lines.push(`${mark(r.self.ok)} roundtrip ${r.agent} → host → ${r.agent}: ${ms(r.self)}`);
  const via = (a: AgentPresence) => `${a.agent} (${a.via.join(', ')})`;
  lines.push('', `Online: ${r.online.map(via).join(', ') || 'only this machine'}`);
  if (r.online.filter((a) => a.agent !== r.agent).length === 0) {
    lines.push('', 'No other machines online. Each needs Claude Code open, handover worker, or handover listen running.');
  } else {
    lines.push('', 'Round robin:');
    const width = Math.max(...r.links.map((l) => `${l.from} → ${l.to}`.length));
    for (const l of r.links) lines.push(`  ${mark(l.ok)} ${`${l.from} → ${l.to}`.padEnd(width)}  ${ms(l)}`);
  }
  lines.push('', r.ok ? 'All connections work.' : 'Some connections failed: see ✗ above.');
  return lines.join('\n');
}

export async function runTest(p: Paths, { json = false, timeoutSeconds }: { json?: boolean; timeoutSeconds?: number } = {}): Promise<number> {
  const report = await testConnections(p, { timeoutMs: (timeoutSeconds ?? 8) * 1000 });
  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report.ok ? 0 : 1;
}

/** Answers pings (and checks in) until stopped: for machines without Claude Code open. */
export async function runListen(p: Paths): Promise<null> {
  const config = await loadConfig(p);
  if (roleOf(config) === 'host') keepLocalRelay(p, config);
  const { api, agent, label } = await connect(p, config);
  startResponder(api, { agent, via: 'listen' });
  console.log(`Listening as ${agent} on ${label}. Other machines can reach this one; Ctrl-C to stop.`);
  return null;
}
