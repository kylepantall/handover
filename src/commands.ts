/** serve, wait, worker, hook, list, mcp. */

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { format } from 'node:util';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RelayError } from './client.ts';
import { agentName, DEFAULT_PORT, loadConfig, roleOf, saveConfig } from './config.ts';
import { connect } from './connect.ts';
import { ensureLocalRelay, hostRelay, keepLocalRelay, stopHosting } from './host.ts';
import { startResponder } from './responder.ts';
import type { Paths } from './paths.ts';
import { generateToken, lanAddresses, startTunnel } from './server.ts';
import { isTerminal } from './store.ts';
import { buildMcpServer } from './tools.ts';
import { acquireWorkerLock, autoWork, WORKER_ENV, workLoop, type WorkOptions } from './worker.ts';
import { STATUS, TUNNELS, type AgentKind, type Config, type Task, type TaskStatus, type Tunnel } from './types.ts';

export const EXIT = { ok: 0, failed: 1, cancelled: 2, timeout: 3, usage: 64, interrupted: 130 } as const;
const log = (msg: string, ctx?: Record<string, unknown>) => console.error('[handover]', msg, ...(ctx ? [ctx] : []));

async function client(p: Paths) {
  const config = await loadConfig(p);
  return { ...(await connect(p, config)), isHost: roleOf(config) === 'host' };
}

export interface ServeOptions {
  port?: number;
  host?: string;
  token?: string;
  tunnel?: string;
  data?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retentionHours?: number;
  /** Append everything serve prints to this file (the Windows service has no console). */
  log?: string;
}

function teeConsole(file: string): void {
  const out = createWriteStream(file, { flags: 'a' });
  for (const level of ['log', 'error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      out.write(`${new Date().toISOString()} ${format(...args)}\n`);
      original(...args);
    };
  }
}

export async function serve(p: Paths, o: ServeOptions): Promise<void> {
  if (o.log) {
    await fs.mkdir(path.dirname(o.log), { recursive: true });
    teeConsole(o.log);
  }
  const config = await loadConfig(p);
  if (roleOf(config) === 'client') {
    // A client's service only takes handovers; it never runs a relay.
    if (startAuto(p, config, 'service')) return;
    throw new Error(
      'this machine is a client: it uses the host’s relay. Turn on auto-pickup (handover auto claude|codex), or run handover host to make this machine the host.'
    );
  }
  startAuto(p, config, 'service');
  const relay = config.relay ?? {};
  const port = o.port ?? relay.port ?? DEFAULT_PORT;
  let token = o.token ?? process.env.HANDOVER_TOKEN ?? config.token;
  if (!token) {
    // Keep the token stable across restarts so joined machines keep working.
    token = generateToken();
    await saveConfig(p, { ...config, role: 'host', token, url: config.url ?? `http://127.0.0.1:${port}`, relay: { ...relay, port } });
  }
  const tunnel = (o.tunnel ?? relay.tunnel) as Tunnel | undefined;
  if (tunnel && !TUNNELS.includes(tunnel)) throw new Error(`unknown tunnel "${tunnel}" (use ${TUNNELS.join(' or ')})`);
  const data = o.data ?? relay.data ?? p.tasks;
  // Claude Code's MCP server may already host the relay. Stand by and take over
  // when it exits, rather than failing (a login service would restart-loop).
  let hosted;
  for (let announced = false; ; ) {
    try {
      hosted = await hostRelay(p, config, { ...o, port, token });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      if (!announced) console.log('Another handover process is hosting the relay; standing by to take over', { port });
      announced = true;
      await Bun.sleep(5_000);
    }
  }
  const shutdown = async () => {
    await hosted.stop();
    process.exit(EXIT.ok);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const urls = [`http://127.0.0.1:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
  if (tunnel) urls.unshift((await startTunnel(tunnel, port)).url);
  console.log(`Handover host "${agentName(config)}" running (announced on this network)\n`);
  console.log(`  data:   ${data === 'none' ? '(memory only)' : path.resolve(data)}`);
  for (const u of urls) console.log(`  url:    ${u}`);
  console.log(`\n  Token:  handover token   (stored in ${p.config})`);
  console.log(`  MCP:    ${urls[0]}/mcp   Authorization: Bearer <token>   X-Handover-Agent: <name>`);
  console.log(`  ChatGPT etc.: ${urls[0]}/mcp?token=<token>&agent=<name>`);
}

async function writeFiles(dir: string, files: Task['files']): Promise<string[]> {
  await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const f of files) {
    const target = path.join(dir, path.basename(f.name)); // relay validates names; basename is defence in depth
    await fs.writeFile(target, Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8'));
    written.push(target);
  }
  return written;
}

export interface WaitOptions {
  objective?: string;
  context?: string;
  contextFile?: string;
  id?: string;
  to?: string;
  priority?: string;
  out?: string;
  timeoutSeconds?: number;
  json?: boolean;
}

export async function wait(p: Paths, o: WaitOptions): Promise<number> {
  const config = await loadConfig(p);
  // This machine's relay holds new tasks in relay and peer mode: host it here if nothing else is.
  await ensureLocalRelay(p, config);
  const { api, agent, isHost } = await client(p);
  const context = o.contextFile ? await fs.readFile(o.contextFile, 'utf8') : (o.context ?? '');

  let id = o.id;
  if (o.objective) {
    const task = await api
      .create({ id, objective: o.objective, context, from: agent, to: o.to, priority: o.priority })
      .catch((err: Error) => {
        // Peer mode keeps new tasks on this machine's own relay.
        if (!(err instanceof RelayError))
          throw new Error(isHost ? 'could not reach or start this host’s relay: see handover doctor' : 'could not reach the host: see handover doctor');
        throw err;
      });
    id = task.id;
    log('created', { id, to: task.to, priority: task.priority });
  } else if (!id) {
    console.error('wait needs --objective (new handover) or --id (existing one)');
    return EXIT.usage;
  } else {
    await api.get(id); // fail fast on an unknown id
  }
  const taskId = id;
  console.error(`HANDOVER_ID=${taskId}`);

  let interrupted = false;
  process.on('SIGINT', async () => {
    if (interrupted) process.exit(EXIT.interrupted);
    interrupted = true;
    log('cancelling', { id: taskId });
    await api.cancel(taskId).catch(() => {});
    process.exit(EXIT.interrupted);
  });

  const deadline = o.timeoutSeconds && o.timeoutSeconds > 0 ? Date.now() + o.timeoutSeconds * 1000 : Infinity;
  let task: Task | undefined;
  let backoff = 1000;
  let lastStatus: TaskStatus | undefined;
  while (Date.now() < deadline) {
    try {
      task = await api.wait(taskId, Math.min(25_000, deadline - Date.now()));
      backoff = 1000;
      if (task.status !== lastStatus) {
        log('status', { id: taskId, status: task.status, claimedBy: task.claimedBy, attempts: task.attempts });
        lastStatus = task.status;
      }
      if (isTerminal(task.status)) break;
    } catch (err) {
      if (err instanceof RelayError && err.status === 404) throw err;
      log('relay unreachable, retrying', { error: (err as Error).message });
      // If the process hosting our relay exited, take over (the queue is on disk).
      await ensureLocalRelay(p, config).catch(() => {});
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  if (!task || !isTerminal(task.status)) {
    await api.cancel(taskId).catch(() => {});
    log('timed out', { id: taskId });
    return EXIT.timeout;
  }

  const files = task.files.length ? await writeFiles(o.out ?? `handover-${taskId}`, task.files) : [];
  if (o.json) {
    console.log(JSON.stringify({ id: taskId, status: task.status, failureReason: task.failureReason, output: task.output, files }, null, 2));
  } else {
    if (task.output) console.log(task.output);
    if (task.failureReason) log('failure', { id: taskId, reason: task.failureReason });
    for (const f of files) log('file', { path: f });
  }
  if (task.status === STATUS.SUCCESS) return EXIT.ok;
  return task.status === STATUS.FAILED ? EXIT.failed : EXIT.cancelled;
}

export interface WorkerOptions {
  exec?: string;
  /** Run this coding agent's CLI (default: the auto-pickup agent from setup). */
  with?: AgentKind;
  fullAccess?: boolean;
  agent?: string;
  leaseSeconds?: number;
  intervalSeconds?: number;
  once?: boolean;
}

export async function worker(p: Paths, o: WorkerOptions): Promise<number> {
  const config = await loadConfig(p);
  const kind = o.with ?? (o.exec ? undefined : config.auto?.with);
  if (!o.exec && !kind) {
    console.error('worker needs --with claude|codex or --exec "<agent command>"');
    return EXIT.usage;
  }
  keepLocalRelay(p, config);
  const { api, agent: configured, label } = await client(p);
  const agent = o.agent ?? configured;
  let work: WorkOptions | null;
  if (o.exec) work = { agent, command: o.exec };
  else {
    work = autoWork(p, { with: kind!, fullAccess: o.fullAccess ?? (o.with ? false : config.auto?.fullAccess) }, agent, 'worker');
    if (!work) {
      console.error(`worker: the ${kind} CLI isn't installed`);
      return EXIT.failed;
    }
  }
  // Hold the machine's worker lock if it's free, so the MCP server of an agent
  // this worker starts doesn't start a second worker.
  acquireWorkerLock(p);
  log('worker polling', { agent, relay: label, with: kind ?? 'exec' });
  await workLoop(api, { ...work, leaseMs: o.leaseSeconds ? o.leaseSeconds * 1000 : undefined, intervalMs: (o.intervalSeconds ?? 3) * 1000, once: o.once });
  return EXIT.ok;
}

/**
 * Auto-pickup inside a long-running process (the login service or the MCP
 * server), in the background. Only one process per machine works at a time
 * (acquireWorkerLock); the others check every 30 s and take over when it goes.
 * Waits, rather than failing, while the agent's CLI is missing. Returns false
 * when auto-pickup is off, or inside an agent the worker started.
 */
export function startAuto(p: Paths, config: Config, via: string): boolean {
  const auto = config.auto;
  if (!auto || process.env[WORKER_ENV]) return false;
  void (async () => {
    let reported = '';
    const report = (state: string, ctx: Record<string, unknown>) => {
      if (state !== reported) log(state, ctx);
      reported = state;
    };
    for (;;) {
      try {
        const { api, agent } = await connect(p, config);
        const work = autoWork(p, auto, agent, via);
        if (!work) report('auto-pickup waiting: agent CLI not installed', { with: auto.with });
        else if (acquireWorkerLock(p)) {
          log('auto-pickup on', { agent, with: auto.with, fullAccess: auto.fullAccess === true, via });
          await workLoop(api, work);
          return;
        } else report('auto-pickup: another handover process is the worker', { via });
      } catch (err) {
        report('auto-pickup failed to start', { error: (err as Error).message });
      }
      await Bun.sleep(30_000);
    }
  })();
  return true;
}

/** Claude Code SessionStart hook. Never fails the session. */
export async function hook(p: Paths): Promise<number> {
  try {
    const { api, agent } = await client(p);
    const pending = await api.list({ status: STATUS.PENDING, agent });
    if (!pending.length) return EXIT.ok;
    const lines = pending.map((t) => `- ${t.id} (priority ${t.priority}): ${t.objective}`).join('\n');
    const additionalContext = `Pending handovers are waiting on the Handover relay:\n${lines}\n\nIf the user wants one picked up, call handover_next (or handover_claim with an id), do the work, then call handover_complete.`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  } catch {
    // Relay offline or not set up.
  }
  return EXIT.ok;
}

export async function list(p: Paths, o: { status?: string; for?: string }): Promise<number> {
  const { api } = await client(p);
  console.log(JSON.stringify(await api.list({ status: o.status as TaskStatus | undefined, agent: o.for }), null, 2));
  return EXIT.ok;
}

export async function mcp(p: Paths): Promise<void> {
  const config = await loadConfig(p);
  const { api, agent } = await client(p);
  // Claude Code keeps this process alive while it's open, which makes it a natural
  // host for this machine's relay: no login service needed.
  keepLocalRelay(p, config);
  startResponder(api, { agent, via: 'mcp' });
  // Auto-pickup while an agent is open (unless another process already does it).
  startAuto(p, config, 'mcp');
  // A hosted relay would keep the process alive after Claude Code closes our stdin.
  process.stdin.once('end', async () => {
    await stopHosting();
    process.exit(EXIT.ok);
  });
  await buildMcpServer(api, { agentName: agent }).connect(new StdioServerTransport());
}
