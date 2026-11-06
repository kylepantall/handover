/**
 * Host discovery on the local network over mDNS / DNS-SD (`_handover._tcp`).
 * A host announces itself; a client finds the host with its token's network id.
 */

import { createHash, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Bonjour, type Service } from 'bonjour-service';
import type { Peer } from './types.ts';

const TYPE = 'handover';
const HOST_ROLE = 'host';

/** mDNS can be unavailable (no multicast, firewall): degrade to "not found" rather than crash. */
const onMdnsError = (err: Error) => console.error('mdns unavailable', { error: err.message });

/**
 * Public identifier for a token, announced so clients of other handover hosts
 * ignore this one. One-way: the token can't be recovered from it.
 */
export function networkId(token: string): string {
  return createHash('sha256').update(`handover-network:${token}`).digest('hex').slice(0, 16);
}

/** Announces this machine's relay as a host. Returns a function that withdraws it. */
export function advertise({ port, agent, token }: { port: number; agent: string; token: string }): () => Promise<void> {
  const bonjour = new Bonjour({}, onMdnsError);
  // The suffix keeps names unique if two machines pick the same agent name.
  bonjour.publish({
    name: `handover-${agent}-${randomBytes(2).toString('hex')}`,
    type: TYPE,
    port,
    txt: { agent, net: networkId(token), role: HOST_ROLE, v: '2' },
  });
  return () =>
    Promise.race([
      new Promise<void>((resolve) => bonjour.unpublishAll(() => (bonjour.destroy(), resolve()))),
      Bun.sleep(2000), // never hang shutdown on mDNS
    ]);
}

function urlFor(s: Service): string | null {
  const host = [s.referer?.address, ...(s.addresses ?? [])].find((a): a is string => !!a && isIPv4(a));
  return host ? `http://${host}:${s.port}` : null;
}

/** Hosts on this network announced with the same token, found within `timeoutMs`. */
export async function findHosts(token: string, { timeoutMs = 3000, first = false } = {}): Promise<Peer[]> {
  const net = networkId(token);
  const bonjour = new Bonjour({}, onMdnsError);
  const found = new Map<string, Peer>();
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      bonjour.find({ type: TYPE }, (s) => {
        const url = urlFor(s);
        const agent = typeof s.txt?.agent === 'string' ? s.txt.agent : null;
        // v0.4–0.6 peers announced no role: not hosts.
        if (s.txt?.net !== net || s.txt?.role !== HOST_ROLE || !url || !agent) return;
        found.set(url, { agent, url });
        if (first) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  } finally {
    bonjour.destroy();
  }
  return [...found.values()];
}

/** The first host found with this token, or null. */
export async function findHost(token: string, timeoutMs = 3000): Promise<Peer | null> {
  return (await findHosts(token, { timeoutMs, first: true }))[0] ?? null;
}
