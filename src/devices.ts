/** Groups presence check-ins (`pc`, `codex@pc`, `claude@pc`) into machines. */

import type { AgentPresence, Device } from './types.ts';

const machineOf = (agent: string) => {
  const at = agent.indexOf('@');
  return at > 0 ? agent.slice(at + 1) : agent;
};

/** Online machines first, then most recently seen. */
export function groupDevices(presence: AgentPresence[]): Device[] {
  const devices = new Map<string, Device>();
  const newestFirst = [...presence].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  for (const p of newestFirst) {
    const machine = machineOf(p.agent);
    const online = p.online !== false; // relays before 0.12 only list online agents
    const device = devices.get(machine) ?? { machine, online: false, version: p.version, platform: p.platform, agents: [], via: [], lastSeen: p.lastSeen };
    device.online ||= online;
    if (p.agent !== machine) device.agents.push(p.agent);
    device.via = [...new Set([...device.via, ...p.via])];
    devices.set(machine, device);
  }
  return [...devices.values()]
    .map((d) => ({ ...d, agents: d.agents.sort(), via: d.via.sort() }))
    .sort((a, b) => Number(b.online) - Number(a.online) || Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
}

function ago(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function formatDevices(devices: Device[]): string {
  if (!devices.length) return 'No paired devices yet. A machine pairs when it runs handover join.';
  const rows = [
    ['device', 'status', 'version', 'platform', 'agents', 'running', 'last seen'],
    ...devices.map((d) => [
      d.machine,
      d.online ? 'online' : 'offline',
      d.version || '-',
      d.platform || '-',
      d.agents.join(', ') || '-',
      d.via.join(', ') || '-',
      ago(d.lastSeen),
    ]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}
