/**
 * Runs this machine's relay. `handover serve` does it in the foreground; any
 * other long-lived handover process (Claude Code's MCP server, `wait`,
 * `worker`) hosts it in-process when nothing else is, so no login service is
 * needed. Whichever process binds the port first serves; the queue lives on
 * disk, so the next host picks it up when that one exits.
 */

import type { Server } from 'node:http';
import path from 'node:path';
import { agentName, DEFAULT_PORT, roleOf } from './config.ts';
import { advertise } from './discovery.ts';
import type { Paths } from './paths.ts';
import { startServer } from './server.ts';
import { Store } from './store.ts';
import type { Config } from './types.ts';

export interface StoreOverrides {
  data?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retentionHours?: number;
}

export function storeFor(p: Paths, config: Config, o: StoreOverrides = {}): { store: Store; data: string } {
  const relay = config.relay ?? {};
  const data = o.data ?? relay.data ?? p.tasks;
  const store = new Store({
    file: data === 'none' ? null : path.resolve(data),
    leaseMs: (o.leaseSeconds ?? relay.leaseSeconds ?? 600) * 1000,
    maxAttempts: o.maxAttempts ?? relay.maxAttempts ?? 3,
    retentionMs: (o.retentionHours ?? relay.retentionHours ?? 24) * 3_600_000,
  });
  return { store, data };
}

export interface Hosted {
  server: Server;
  store: Store;
  stop(): Promise<void>;
}

/** Starts the relay in this process and announces it in peer mode. Throws EADDRINUSE if another process has it. */
export async function hostRelay(p: Paths, config: Config, opts: { host?: string; port?: number; token: string } & StoreOverrides): Promise<Hosted> {
  const port = opts.port ?? config.relay?.port ?? DEFAULT_PORT;
  const { store } = storeFor(p, config, opts);
  const { server } = await startServer({ port, host: opts.host ?? config.relay?.host ?? '0.0.0.0', token: opts.token, store });
  // Clients find the host by this announcement (docs/flow.md).
  const unadvertise = advertise({ port, agent: agentName(config), token: opts.token });
  let stopped = false;
  return {
    server,
    store,
    async stop() {
      if (stopped) return;
      stopped = true;
      store.flush();
      server.close();
      await unadvertise().catch(() => {});
    },
  };
}

async function relayUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

let hosted: Hosted | null = null;
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const stop = async () => {
    await hosted?.stop();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Last chance for a synchronous flush when the process ends any other way.
  process.once('exit', () => hosted?.store.flush());
}

/**
 * Makes sure this machine's relay is up, hosting it here if no process is.
 * Does nothing unless this machine runs a relay (relay or peer mode) and
 * HANDOVER_URL doesn't point elsewhere.
 */
export async function ensureLocalRelay(p: Paths, config: Config): Promise<'running' | 'hosting' | 'not-local'> {
  // Only a host runs a relay; a client never does (docs/flow.md).
  if (roleOf(config) !== 'host' || !config.token || process.env.HANDOVER_URL) return 'not-local';
  if (hosted) return 'hosting';
  const port = config.relay?.port ?? DEFAULT_PORT;
  if (await relayUp(port)) return 'running';
  try {
    hosted = await hostRelay(p, config, { token: config.token });
    hookExit();
    console.error('[handover] hosting the relay in this process', { port });
    return 'hosting';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') return 'running'; // another process won the race
    throw err;
  }
}

/** For long-lived processes: host the relay now and take over whenever its host goes away. */
export function keepLocalRelay(p: Paths, config: Config, everyMs = 5_000): void {
  const tick = () =>
    ensureLocalRelay(p, config).catch((err: Error) => console.error('[handover] could not host the relay', { error: err.message }));
  void tick();
  setInterval(() => {
    if (!hosted) void tick();
  }, everyMs).unref();
}

/** Stops a relay this process is hosting (tests, graceful shutdown). */
export async function stopHosting(): Promise<void> {
  await hosted?.stop();
  hosted = null;
}
