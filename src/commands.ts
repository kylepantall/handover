/** serve, wait, worker, hook, list, mcp. */

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { format } from 'node:util';
import path from 'node:path';
import * as ui from '@clack/prompts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RelayError } from './client.ts';
import { agentName, DEFAULT_PORT, loadConfig, roleOf, saveConfig } from './config.ts';
import { connect } from './connect.ts';
import { formatDevices, groupDevices } from './devices.ts';
import { ensureLocalRelay, hostRelay, keepLocalRelay, stopHosting } from './host.ts';
import { startResponder } from './responder.ts';
import type { Paths } from './paths.ts';
import { generateToken, lanAddresses, startTunnel } from './server.ts';
import { agentAddress, isTerminal } from './store.ts';
import { buildMcpServer } from './tools.ts';
import { updateNotice } from './updatecheck.ts';
import { acquireWorkerLock, agentWork, WORKER_ENV, workLoop, type WorkOptions } from './worker.ts';
import { autoKinds, fullAccessFor } from './agents.ts';
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
      'this machine is a client: it uses the host’s relay. Turn on auto-pickup (handover agents all on), or run handover host to make this machine the host.'
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

const TOO_OLD = 'the host is too old for this: run handover update there';

/** `handover clear`: empties finished handovers; --all also cancels open ones; ids remove just those. */
export async function clear(p: Paths, { ids = [], all = false, yes = false }: { ids?: string[]; all?: boolean; yes?: boolean }): Promise<number> {
  if (ids.length && all) {
    console.error('clear takes ids or --all, not both');
    return EXIT.usage;
  }
  const config = await loadConfig(p);
  await ensureLocalRelay(p, config); // a host's queue is on disk even when no relay is running
  const { api } = await client(p);
  if (ids.length) {
    let missing = 0;
    for (const id of ids) {
      try {
        const task = await api.remove(id);
        console.log(`Removed ${id}${isTerminal(task.status) && task.status !== STATUS.CANCELLED ? '' : ' (cancelled)'}`);
      } catch (err) {
        if (!(err instanceof RelayError) || err.status !== 404) throw err;
        if (err.code !== 'not_found') throw new Error(TOO_OLD);
        console.error(`No handover ${id}`);
        missing++;
      }
    }
    return missing ? EXIT.failed : EXIT.ok;
  }
  if (all && !yes) {
    if (!process.stdin.isTTY) {
      console.error('clear --all also cancels open handovers: add --yes');
      return EXIT.usage;
    }
    const open = (await api.list({ status: STATUS.PENDING })).length + (await api.list({ status: STATUS.CLAIMED })).length;
    const answer = await ui.confirm({ message: `Delete every handover, cancelling ${open} still open? Anyone waiting on them is told it was cancelled.`, initialValue: false });
    if (answer !== true) {
      console.log('Nothing changed.');
      return EXIT.ok;
    }
  }
  try {
    const { removed } = await api.clear({ all });
    console.log(`Cleared ${removed} handover${removed === 1 ? '' : 's'}.`);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof RelayError && err.status === 404) throw new Error(TOO_OLD);
    throw err;
  }
}

/** `handover devices`: the paired machines. `devices forget NAME` unpairs one. */
export async function devices(p: Paths, { json = false, forget }: { json?: boolean; forget?: string }): Promise<number> {
  const config = await loadConfig(p);
  await ensureLocalRelay(p, config);
  const { api, label } = await client(p);
  if (forget) {
    const { removed } = await api.forget(forget);
    if (!removed) {
      console.error(`No paired device named ${forget}. See handover devices.`);
      return EXIT.failed;
    }
    console.log(`Forgot ${forget}. It pairs again if handover still runs there with this token.`);
    return EXIT.ok;
  }
  const list = groupDevices(await api.agents({ all: true }));
  console.log(json ? JSON.stringify(list, null, 2) : `Host: ${label}\n\n${formatDevices(list)}`);
  return EXIT.ok;
}

export interface WorkerOptions {
  exec?: string;
  /** Run this coding agent's CLI (default: the auto-pickup agents from setup). */
  with?: AgentKind;
  fullAccess?: boolean;
  agent?: string;
  leaseSeconds?: number;
  intervalSeconds?: number;
  once?: boolean;
}

export async function worker(p: Paths, o: WorkerOptions): Promise<number> {
  const config = await loadConfig(p);
  const kinds = o.with ? [o.with] : o.exec ? [] : autoKinds(config);
  if (!o.exec && !kinds.length) {
    console.error('worker needs --with claude|codex or --exec "<agent command>"');
    return EXIT.usage;
  }
  keepLocalRelay(p, config);
  const { api, agent: machine, label } = await client(p);
  const timing = { leaseMs: o.leaseSeconds ? o.leaseSeconds * 1000 : undefined, intervalMs: (o.intervalSeconds ?? 3) * 1000, once: o.once };
  if (o.exec) {
    log('worker polling', { agent: o.agent ?? machine, relay: label, with: 'exec' });
    await workLoop(api, { agent: o.agent ?? machine, command: o.exec, ...timing });
    return EXIT.ok;
  }
  const works: WorkOptions[] = [];
  for (const kind of kinds) {
    const work = agentWork(p, kind, o.fullAccess ?? fullAccessFor(config, kind), o.agent ?? machine, 'worker');
    if (!work) {
      console.error(`worker: the ${kind} CLI isn't installed`);
      return EXIT.failed;
    }
    // Hold this agent's worker lock if it's free, so the MCP server of an agent
    // this worker starts doesn't start a second worker.
    acquireWorkerLock(p, kind);
    log('worker polling', { agent: work.agent, relay: label, with: kind });
    works.push(work);
  }
  await Promise.all(works.map((w) => workLoop(api, { ...w, ...timing })));
  return EXIT.ok;
}

/**
 * Auto-pickup inside a long-running process (the login service or the MCP
 * server), in the background: one worker per configured agent. Only one
 * process per machine runs each agent's worker (acquireWorkerLock); the others
 * check every 30 s and take over when it goes. Waits, rather than failing,
 * while an agent's CLI is missing. Returns false when auto-pickup is off, or
 * inside an agent the worker started.
 */
export function startAuto(p: Paths, config: Config, via: string): boolean {
  const kinds = autoKinds(config);
  if (!kinds.length || process.env[WORKER_ENV]) return false;
  for (const kind of kinds) void autoAgent(p, config, kind, fullAccessFor(config, kind), via);
  return true;
}

async function autoAgent(p: Paths, config: Config, kind: AgentKind, fullAccess: boolean, via: string): Promise<void> {
  let reported = '';
  const report = (state: string, ctx: Record<string, unknown>) => {
    if (state !== reported) log(state, ctx);
    reported = state;
  };
  for (;;) {
    try {
      const { api, agent: machine } = await connect(p, config);
      const work = agentWork(p, kind, fullAccess, machine, via);
      if (!work) report('auto-pickup waiting: agent CLI not installed', { with: kind });
      else if (acquireWorkerLock(p, kind)) {
        log('auto-pickup on', { agent: work.agent, fullAccess, via });
        await workLoop(api, work);
        return;
      } else report('auto-pickup: another handover process is the worker', { with: kind, via });
    } catch (err) {
      report('auto-pickup failed to start', { with: kind, error: (err as Error).message });
    }
    await Bun.sleep(30_000);
  }
}

/** Claude Code SessionStart hook. Never fails the session. */
export async function hook(p: Paths): Promise<number> {
  try {
    const notes: string[] = [];
    const notice = await updateNotice(p);
    if (notice) notes.push(`Tell the user once: ${notice}`);
    try {
      const { api, agent: machine } = await client(p);
      const pending = await api.list({ status: STATUS.PENDING, agent: agentAddress('claude', machine) });
      const lines = pending.map((t) => `- ${t.id} (priority ${t.priority}): ${t.objective}`).join('\n');
      if (pending.length) notes.push(`Pending handovers are waiting on the Handover relay:\n${lines}\n\nIf the user wants one picked up, call handover_next (or handover_claim with an id), do the work, then call handover_complete.`);
    } catch {
      // Relay offline or not set up.
    }
    if (notes.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: notes.join('\n\n') } }));
  } catch {
    // Never fail the session.
  }
  return EXIT.ok;
}

export async function list(p: Paths, o: { status?: string; for?: string }): Promise<number> {
  await ensureLocalRelay(p, await loadConfig(p)); // a host's queue is on disk even when no relay is running
  const { api } = await client(p);
  console.log(JSON.stringify(await api.list({ status: o.status as TaskStatus | undefined, agent: o.for }), null, 2));
  return EXIT.ok;
}

/** `as`: which agent started this server (registered as `handover mcp --as codex`); it claims as kind@machine. */
export async function mcp(p: Paths, { as }: { as?: AgentKind } = {}): Promise<void> {
  const config = await loadConfig(p);
  const { api, agent: machine } = await client(p);
  // Claude Code and Codex keep this process alive while they're open, which makes
  // it a natural host for this machine's relay: no login service needed.
  keepLocalRelay(p, config);
  startResponder(api, { agent: machine, via: 'mcp' });
  // Auto-pickup while an agent is open (unless another process already does it).
  startAuto(p, config, 'mcp');
  // A hosted relay would keep the process alive after the agent closes our stdin.
  process.stdin.once('end', async () => {
    await stopHosting();
    process.exit(EXIT.ok);
  });
  const notice = await updateNotice(p);
  await buildMcpServer(api, { agentName: as ? agentAddress(as, machine) : machine, instructions: notice ? `Tell the user once: ${notice}` : undefined }).connect(new StdioServerTransport());
}
