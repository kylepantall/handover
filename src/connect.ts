import { httpApi } from './client.ts';
import { agentName, DEFAULT_PORT, endpoint, roleOf, saveConfig } from './config.ts';
import { findHost } from './discovery.ts';
import type { Paths } from './paths.ts';
import type { Api, Config, Peer } from './types.ts';

export interface Connection {
  api: Api;
  agent: string;
  /** Where this connection points, for logs and doctor. */
  label: string;
}

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

/**
 * A client that joined by discovery finds its host again when the stored URL
 * stops answering (the host's IP changed), and remembers the new one.
 */
export async function hostUrl(
  p: Paths,
  config: Config,
  find: (token: string) => Promise<Peer | null> = (t) => findHost(t)
): Promise<string | undefined> {
  if (!config.discover || !config.token || (config.url && (await answers(config.url)))) return config.url;
  const host = await find(config.token);
  if (!host) return config.url;
  if (host.url !== config.url) await saveConfig(p, { ...config, url: host.url });
  return host.url;
}

/** The relay this machine uses: its own on a host, the host's on a client (docs/flow.md). */
export async function connect(p: Paths, config: Config): Promise<Connection> {
  const ep = endpoint(config);
  if (!ep.token) throw new Error('not set up: run handover host (this machine is the hub) or handover join');
  const agent = agentName(config);
  if (process.env.HANDOVER_URL) return { api: httpApi(ep), agent, label: ep.url };
  if (roleOf(config) === 'host') {
    const url = `http://127.0.0.1:${config.relay?.port ?? DEFAULT_PORT}`;
    return { api: httpApi({ url, token: ep.token }), agent, label: `this host (${url})` };
  }
  const url = (await hostUrl(p, config)) ?? ep.url;
  return { api: httpApi({ url, token: ep.token }), agent, label: url };
}
