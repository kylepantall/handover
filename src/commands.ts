/** serve, wait, worker, hook, list, mcp. */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RelayError } from './client.ts';
import { agentName, DEFAULT_PORT, loadConfig, saveConfig } from './config.ts';
import { connect } from './connect.ts';
import { advertise } from './discovery.ts';
import type { Paths } from './paths.ts';
import { generateToken, lanAddresses, startServer, startTunnel } from './server.ts';
import { isTerminal, Store } from './store.ts';
import { buildMcpServer, briefing } from './tools.ts';
import { STATUS, TUNNELS, type Task, type TaskStatus, type Tunnel } from './types.ts';

export const EXIT = { ok: 0, failed: 1, cancelled: 2, timeout: 3, usage: 64, interrupted: 130 } as const;
const log = (msg: string, ctx?: Record<string, unknown>) => console.error('[handover]', msg, ...(ctx ? [ctx] : []));

async function client(p: Paths) {
  const config = await loadConfig(p);
  return { ...connect(config), peer: config.peer === true };
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
}

export async function serve(p: Paths, o: ServeOptions): Promise<void> {
  const config = await loadConfig(p);
  const relay = config.relay ?? {};
  const port = o.port ?? relay.port ?? DEFAULT_PORT;
  let token = o.token ?? process.env.HANDOVER_TOKEN ?? config.token;
  if (!token) {
    // Keep the token stable across restarts so joined machines keep working.
    token = generateToken();
    await saveConfig(p, { ...config, token, url: config.url ?? `http://127.0.0.1:${port}`, relay: { ...relay, port } });
  }
  const tunnel = (o.tunnel ?? relay.tunnel) as Tunnel | undefined;
  if (tunnel && !TUNNELS.includes(tunnel)) throw new Error(`unknown tunnel "${tunnel}" (use ${TUNNELS.join(' or ')})`);
  const data = o.data ?? relay.data ?? p.tasks;
  const store = new Store({
    file: data === 'none' ? null : path.resolve(data),
    leaseMs: (o.leaseSeconds ?? relay.leaseSeconds ?? 600) * 1000,
    maxAttempts: o.maxAttempts ?? relay.maxAttempts ?? 3,
    retentionMs: (o.retentionHours ?? relay.retentionHours ?? 24) * 3_600_000,
  });
  const { server } = await startServer({ port, host: o.host ?? relay.host ?? '0.0.0.0', token, store });
  const unadvertise = config.peer ? advertise({ port, agent: agentName(config), token }) : null;
  const shutdown = async () => {
    store.flush();
    server.close();
    await unadvertise?.().catch(() => {});
    process.exit(EXIT.ok);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const urls = [`http://127.0.0.1:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
  if (tunnel) urls.unshift((await startTunnel(tunnel, port)).url);
  console.log(config.peer ? `Handover peer "${agentName(config)}" running (announced on this network)\n` : 'Handover relay running\n');
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
  const { api, agent, peer } = await client(p);
  const context = o.contextFile ? await fs.readFile(o.contextFile, 'utf8') : (o.context ?? '');

  let id = o.id;
  if (o.objective) {
    const task = await api
      .create({ id, objective: o.objective, context, from: agent, to: o.to, priority: o.priority })
      .catch((err: Error) => {
        // Peer mode keeps new tasks on this machine's own relay.
        if (peer && !(err instanceof RelayError)) throw new Error('this machine’s peer relay is not running: handover service install');
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

function runAgent(command: string, task: Task): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, HANDOVER_ID: task.id } });
    let stdout = '';
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d;
      process.stderr.write(d);
    });
    child.stdin!.end(briefing(task));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.on('error', (err) => resolve({ code: -1, stdout: err.message }));
  });
}

export interface WorkerOptions {
  exec?: string;
  agent?: string;
  leaseSeconds?: number;
  intervalSeconds?: number;
  once?: boolean;
}

export async function worker(p: Paths, o: WorkerOptions): Promise<number> {
  if (!o.exec) {
    console.error('worker needs --exec "<agent command>"');
    return EXIT.usage;
  }
  const { api, agent: configured, label } = await client(p);
  const agent = o.agent ?? configured;
  const leaseMs = o.leaseSeconds ? o.leaseSeconds * 1000 : undefined;
  log('worker polling', { agent, relay: label });
  for (;;) {
    try {
      let task: Task | null;
      while ((task = await api.claimNext({ by: agent, leaseMs }))) {
        const t = task;
        log('picked up', { id: t.id, priority: t.priority, attempt: t.attempts });
        // Keep the lease alive while the agent runs: renew at a third of its length.
        const leaseLeft = Date.parse(t.leaseExpiresAt ?? '') - Date.now();
        const renewer = setInterval(() => {
          api.renew(t.id, { by: agent, leaseMs }).catch((err: Error) => log('renew failed', { id: t.id, error: err.message }));
        }, Math.max(1000, leaseLeft / 3));
        const { code, stdout } = await runAgent(o.exec, t).finally(() => clearInterval(renewer));
        if (!isTerminal((await api.get(t.id)).status)) {
          // Agent didn't call handover_complete itself: hand back its stdout.
          await api.complete(t.id, { status: code === 0 ? STATUS.SUCCESS : STATUS.FAILED, output: stdout.trim() });
        }
        log('finished', { id: t.id, exitCode: code });
      }
    } catch (err) {
      log('poll failed', { error: (err as Error).message });
    }
    if (o.once) return EXIT.ok;
    await Bun.sleep((o.intervalSeconds ?? 3) * 1000);
  }
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
  const { api, agent } = await client(p);
  await buildMcpServer(api, { agentName: agent }).connect(new StdioServerTransport());
}
