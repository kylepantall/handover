/** Peer discovery on the local network over mDNS / DNS-SD (`_handover._tcp`). */

import { createHash, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { Bonjour, type Service } from 'bonjour-service';
import type { Peer } from './types.ts';

const TYPE = 'handover';

/** mDNS can be unavailable (no multicast, firewall): degrade to "no peers" rather than crash. */
const onMdnsError = (err: Error) => console.error('mdns unavailable', { error: err.message });

/**
 * Public identifier for a shared token, advertised so peers on other handover
 * networks ignore each other. One-way: the token can't be recovered from it.
 */
export function networkId(token: string): string {
  return createHash('sha256').update(`handover-network:${token}`).digest('hex').slice(0, 16);
}

/** Announces this machine's relay. Returns a function that withdraws it. */
export function advertise({ port, agent, token }: { port: number; agent: string; token: string }): () => Promise<void> {
  const bonjour = new Bonjour({}, onMdnsError);
  // The suffix keeps names unique if two machines pick the same agent name.
  bonjour.publish({ name: `handover-${agent}-${randomBytes(2).toString('hex')}`, type: TYPE, port, txt: { agent, net: networkId(token), v: '1' } });
  return () => new Promise((resolve) => bonjour.unpublishAll(() => (bonjour.destroy(), resolve())));
}

function urlFor(s: Service): string | null {
  const host = [s.referer?.address, ...(s.addresses ?? [])].find((a): a is string => !!a && isIPv4(a));
  return host ? `http://${host}:${s.port}` : null;
}

/** Keeps a live list of peers on the same handover network. */
export class PeerBrowser {
  #bonjour = new Bonjour({}, onMdnsError);
  #peers = new Map<string, Peer>();
  #browser;
  readonly ready: Promise<void>;

  constructor(token: string, { settleMs = 1500 } = {}) {
    const net = networkId(token);
    this.#browser = this.#bonjour.find({ type: TYPE }, (s) => {
      const url = urlFor(s);
      const agent = typeof s.txt?.agent === 'string' ? s.txt.agent : null;
      if (s.txt?.net === net && url && agent) this.#peers.set(s.name, { agent, url });
    });
    this.#browser.on('down', (s: Service) => this.#peers.delete(s.name));
    // Answers to the first query arrive within about a second.
    this.ready = Bun.sleep(settleMs);
  }

  peers(): Peer[] {
    return [...this.#peers.values()];
  }

  stop(): void {
    this.#browser.stop();
    this.#bonjour.destroy();
  }
}
