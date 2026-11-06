import { httpApi } from './client.ts';
import { agentName, DEFAULT_PORT, endpoint } from './config.ts';
import { PeerBrowser } from './discovery.ts';
import { peerApi } from './peers.ts';
import type { Api, Config } from './types.ts';

export interface Connection {
  api: Api;
  agent: string;
  /** Where this connection points, for logs and doctor. */
  label: string;
  close(): void;
}

/** The Api this machine should use: one relay, or every peer on the network. */
export function connect(config: Config): Connection {
  const ep = endpoint(config);
  if (!ep.token) throw new Error('no relay token: run handover setup (or set HANDOVER_TOKEN)');
  const agent = agentName(config);
  if (!config.peer || process.env.HANDOVER_URL) {
    return { api: httpApi(ep), agent, label: ep.url, close: () => {} };
  }
  const browser = new PeerBrowser(ep.token);
  const self = { agent, url: `http://127.0.0.1:${config.relay?.port ?? DEFAULT_PORT}` };
  const api = peerApi({
    self,
    token: ep.token,
    discover: async () => {
      await browser.ready;
      return browser.peers();
    },
  });
  return { api, agent, label: `peers on this network (self ${self.url})`, close: () => browser.stop() };
}
