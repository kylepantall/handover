import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { writePrivate, type Paths } from './paths.ts';
import type { Endpoint } from './client.ts';
import type { Config, Role } from './types.ts';

export const DEFAULT_PORT = 7777;

export async function loadConfig(p: Paths): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(p.config, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${p.config} must hold a JSON object`);
  return parsed as Config;
}

export function saveConfig(p: Paths, config: Config): Promise<void> {
  return writePrivate(p.config, JSON.stringify(config, null, 2) + '\n');
}

/** Relay to talk to: env overrides config; a local relay is the fallback. */
export function endpoint(config: Config): Endpoint {
  return {
    url: process.env.HANDOVER_URL ?? config.url ?? `http://127.0.0.1:${config.relay?.port ?? DEFAULT_PORT}`,
    token: process.env.HANDOVER_TOKEN ?? config.token,
  };
}

/** Hostname reduced to the characters agent names allow. */
export function defaultAgentName(): string {
  const short = hostname().split('.')[0] ?? 'agent';
  return short.replace(/[^A-Za-z0-9._@:-]/g, '-').slice(0, 64) || 'agent';
}

/** The machine's role, reading pre-0.7 configs (relay / peer → host, a joined url → client). */
export function roleOf(config: Config): Role | undefined {
  if (config.role) return config.role;
  if (config.relay || config.peer) return 'host';
  return config.url ? 'client' : undefined;
}

export function agentName(config: Config): string {
  return process.env.HANDOVER_AGENT ?? config.agent ?? defaultAgentName();
}
