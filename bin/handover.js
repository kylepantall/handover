#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startServer, startTunnel, lanAddresses, generateToken } from '../src/server.js';
import { httpApi } from '../src/client.js';
import { buildMcpServer, briefing } from '../src/tools.js';
import { Store, isTerminal, STATUS } from '../src/store.js';

const EXIT = { ok: 0, failed: 1, cancelled: 2, timeout: 3, usage: 64, interrupted: 130 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[handover]', ...a);
const seconds = (v, fallback) => (v == null ? fallback : Number(v) * 1000);
const defaultAgent = () => process.env.HANDOVER_AGENT ?? os.hostname().split('.')[0];

const USAGE = `handover <command> [options]

  serve    Run the relay (REST + MCP at /mcp)
           --port 7777  --host 0.0.0.0  --token <t>  --tunnel cloudflared|tailscale
           --data <file|none> (default ~/.handover/tasks.json)  --lease <sec, 600>
           --max-attempts <3>  --retention <hours, 24>
  wait     Create a handover and block until another agent completes it
           --objective <text>  --context <text> | --context-file <path>
           --to <agent>  --priority <int>  --id <id> (custom, or wait on existing)
           --out <dir>  --timeout <sec, 0=forever>  --json
  worker   Auto-pickup: take the next handover and run an agent on it, repeatedly
           --exec "<command>" (briefing on stdin, HANDOVER_ID in env)
           --agent <name>  --lease <sec>  --interval <sec>  --once
  mcp      MCP over stdio, proxied to the relay (for Claude Desktop / Code / Cursor)
  hook     Claude Code SessionStart hook: inject pending handovers as context
  list     Print handovers  --status <status>  --for <agent>

Env: HANDOVER_URL (default http://127.0.0.1:7777), HANDOVER_TOKEN,
     HANDOVER_AGENT (this machine's agent name, default hostname)`;

async function serve(o) {
  const port = Number(o.port ?? 7777);
  const token = o.token ?? process.env.HANDOVER_TOKEN ?? generateToken();
  const data = o.data ?? path.join(os.homedir(), '.handover', 'tasks.json');
  const store = new Store({
    file: data === 'none' ? null : path.resolve(data),
    leaseMs: seconds(o.lease, 600_000),
    maxAttempts: Number(o['max-attempts'] ?? 3),
    retentionMs: o.retention == null ? 24 * 3_600_000 : Number(o.retention) * 3_600_000,
  });
  const { server } = await startServer({ port, host: o.host ?? '0.0.0.0', token, store });
  const shutdown = () => {
    store.flush();
    server.close();
    process.exit(EXIT.ok);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const urls = [`http://127.0.0.1:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
  if (o.tunnel) {
    const { url } = await startTunnel(o.tunnel, port);
    urls.unshift(url);
  }
  console.log(`Handover relay running\n`);
  console.log(`  token:  ${token}`);
  console.log(`  data:   ${data === 'none' ? '(memory only)' : path.resolve(data)}`);
  for (const u of urls) console.log(`  url:    ${u}`);
  console.log(`\n  MCP (header auth):  ${urls[0]}/mcp   Authorization: Bearer <token>   X-Handover-Agent: <name>`);
  console.log(`  MCP (ChatGPT etc.): ${urls[0]}/mcp?token=<token>&agent=<name>`);
  console.log(`\n  export HANDOVER_URL=${urls[0]} HANDOVER_TOKEN=${token}`);
}

async function writeFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  const written = [];
  for (const f of files) {
    const target = path.join(dir, path.basename(f.name)); // relay validates names; basename is defence in depth
    await fs.writeFile(target, Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf8'));
    written.push(target);
  }
  return written;
}

async function wait(o) {
  const api = httpApi();
  let context = o.context ?? '';
  if (o['context-file']) context = await fs.readFile(o['context-file'], 'utf8');

  let id = o.id;
  if (o.objective) {
    const task = await api.create({ id, objective: o.objective, context, from: defaultAgent(), to: o.to, priority: o.priority });
    id = task.id;
    log('created', { id, to: task.to, priority: task.priority });
  } else if (!id) {
    console.error('wait needs --objective (new handover) or --id (existing one)');
    return EXIT.usage;
  } else {
    await api.get(id); // fail fast on unknown id
  }
  console.error(`HANDOVER_ID=${id}`);

  let interrupted = false;
  process.on('SIGINT', async () => {
    if (interrupted) process.exit(EXIT.interrupted);
    interrupted = true;
    log('cancelling', { id });
    await api.cancel(id).catch(() => {});
    process.exit(EXIT.interrupted);
  });

  const deadline = Number(o.timeout ?? 0) > 0 ? Date.now() + Number(o.timeout) * 1000 : Infinity;
  let task;
  let backoff = 1000;
  let lastStatus;
  while (Date.now() < deadline) {
    try {
      task = await api.wait(id, Math.min(25_000, deadline - Date.now()));
      backoff = 1000;
      if (task.status !== lastStatus) {
        log('status', { id, status: task.status, claimedBy: task.claimedBy, attempts: task.attempts });
        lastStatus = task.status;
      }
      if (isTerminal(task.status)) break;
    } catch (err) {
      if (err.status === 404) throw err;
      log('relay unreachable, retrying', { error: err.message });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15_000);
    }
  }

  if (!task || !isTerminal(task.status)) {
    await api.cancel(id).catch(() => {});
    log('timed out', { id });
    return EXIT.timeout;
  }

  const files = task.files.length ? await writeFiles(o.out ?? `handover-${id}`, task.files) : [];
  if (o.json) {
    console.log(JSON.stringify({ id, status: task.status, failureReason: task.failureReason, output: task.output, files }, null, 2));
  } else {
    if (task.output) console.log(task.output);
    if (task.failureReason) log('failure', { id, reason: task.failureReason });
    for (const f of files) log('file', { path: f });
  }
  return { [STATUS.SUCCESS]: EXIT.ok, [STATUS.FAILED]: EXIT.failed }[task.status] ?? EXIT.cancelled;
}

function runAgent(command, task) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, HANDOVER_ID: task.id },
    });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      process.stderr.write(d);
    });
    child.stdin.end(briefing(task));
    child.on('close', (code) => resolve({ code, stdout }));
    child.on('error', (err) => resolve({ code: -1, stdout: err.message }));
  });
}

async function worker(o) {
  if (!o.exec) {
    console.error('worker needs --exec "<agent command>"');
    return EXIT.usage;
  }
  const api = httpApi();
  const agent = o.agent ?? defaultAgent();
  const leaseMs = seconds(o.lease, undefined);
  const interval = seconds(o.interval, 3000);
  log('worker polling', { agent, url: process.env.HANDOVER_URL ?? 'http://127.0.0.1:7777' });
  for (;;) {
    try {
      let task;
      while ((task = await api.claimNext({ by: agent, leaseMs }))) {
        log('picked up', { id: task.id, priority: task.priority, attempt: task.attempts });
        // Keep the lease alive while the agent runs: renew at a third of its length.
        const leaseLeft = Date.parse(task.leaseExpiresAt) - Date.now();
        const renewer = setInterval(() => {
          api.renew(task.id, { by: agent, leaseMs }).catch((err) => log('renew failed', { id: task.id, error: err.message }));
        }, Math.max(1000, leaseLeft / 3));
        const { code, stdout } = await runAgent(o.exec, task).finally(() => clearInterval(renewer));
        const after = await api.get(task.id);
        if (!isTerminal(after.status)) {
          // Agent didn't call handover_complete itself: hand back its stdout.
          await api.complete(task.id, { status: code === 0 ? STATUS.SUCCESS : STATUS.FAILED, output: stdout.trim() });
        }
        log('finished', { id: task.id, exitCode: code });
      }
    } catch (err) {
      log('poll failed', { error: err.message });
    }
    if (o.once) return EXIT.ok;
    await sleep(interval);
  }
}

async function hook() {
  try {
    const pending = await httpApi().list({ status: STATUS.PENDING, agent: defaultAgent() });
    if (!pending.length) return EXIT.ok;
    const lines = pending.map((t) => `- ${t.id} (priority ${t.priority}): ${t.objective}`).join('\n');
    const additionalContext = `Pending handovers are waiting on the Handover relay:\n${lines}\n\nIf the user wants one picked up, call handover_next (or handover_claim with an id), do the work, then call handover_complete.`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  } catch {
    // Relay offline: never block the session.
  }
  return EXIT.ok;
}

async function list(o) {
  console.log(JSON.stringify(await httpApi().list({ status: o.status, agent: o.for }), null, 2));
  return EXIT.ok;
}

async function mcp() {
  const server = buildMcpServer(httpApi(), { agentName: defaultAgent() });
  await server.connect(new StdioServerTransport());
  return null; // keep running
}

const commands = { serve, wait, worker, mcp, hook, list };
const [cmd, ...rest] = process.argv.slice(2);
const str = { type: 'string' };
const { values } = parseArgs({
  args: rest,
  strict: false,
  options: {
    port: str, host: str, token: str, tunnel: str, data: str, lease: str, 'max-attempts': str, retention: str,
    objective: str, context: str, 'context-file': str, to: str, priority: str,
    id: str, out: str, timeout: str, json: { type: 'boolean' },
    exec: str, agent: str, interval: str, once: { type: 'boolean' }, status: str, for: str,
  },
});

if (!commands[cmd]) {
  console.error(USAGE);
  process.exit(cmd ? EXIT.usage : EXIT.ok);
}
commands[cmd](values).then(
  (code) => {
    if (typeof code === 'number' && cmd !== 'serve') process.exit(code);
  },
  (err) => {
    log('error', { error: err.message });
    process.exit(EXIT.failed);
  },
);
