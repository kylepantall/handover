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
import { isTerminal, STATUS } from '../src/store.js';

const EXIT = { ok: 0, failed: 1, cancelled: 2, timeout: 3, usage: 64, interrupted: 130 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[handover]', ...a);

const USAGE = `handover <command> [options]

  serve    Run the relay (REST + MCP at /mcp)
           --port 7777  --host 0.0.0.0  --token <t>  --tunnel cloudflared|tailscale
  wait     Create a handover and block until another agent completes it
           --objective <text>  --context <text> | --context-file <path>
           --id <id> (custom id, or wait on an existing one)  --out <dir>  --timeout <sec, 0=forever>  --json
  worker   Auto-pickup: claim pending handovers and run an agent on each
           --exec "<command>" (briefing on stdin, HANDOVER_ID in env)  --interval <sec>  --once
  mcp      MCP over stdio, proxied to the relay (for Claude Desktop / Code / Cursor)
  hook     Claude Code SessionStart hook: inject pending handovers as context
  list     Print handovers  --status pending|claimed|success|failed|cancelled

Env: HANDOVER_URL (default http://127.0.0.1:7777), HANDOVER_TOKEN`;

async function serve(o) {
  const port = Number(o.port ?? 7777);
  const token = o.token ?? process.env.HANDOVER_TOKEN ?? generateToken();
  await startServer({ port, host: o.host ?? '0.0.0.0', token });
  const urls = [`http://127.0.0.1:${port}`, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
  if (o.tunnel) {
    const { url } = await startTunnel(o.tunnel, port);
    urls.unshift(url);
  }
  console.log(`Handover relay running\n`);
  console.log(`  token:  ${token}`);
  for (const u of urls) console.log(`  url:    ${u}`);
  console.log(`\n  MCP (header auth):  ${urls[0]}/mcp   Authorization: Bearer <token>`);
  console.log(`  MCP (ChatGPT etc.): ${urls[0]}/mcp?token=<token>`);
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
    id = (await api.create({ id, objective: o.objective, context, from: os.hostname() })).id;
    log('created', id);
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
    log('cancelling', id);
    await api.cancel(id).catch(() => {});
    process.exit(EXIT.interrupted);
  });

  const deadline = Number(o.timeout ?? 0) > 0 ? Date.now() + Number(o.timeout) * 1000 : Infinity;
  let task;
  let backoff = 1000;
  while (Date.now() < deadline) {
    try {
      task = await api.wait(id, Math.min(25_000, deadline - Date.now()));
      backoff = 1000;
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
    log('timed out', id);
    return EXIT.timeout;
  }

  const files = task.files.length ? await writeFiles(o.out ?? `handover-${id}`, task.files) : [];
  if (o.json) {
    console.log(JSON.stringify({ id, status: task.status, output: task.output, files }, null, 2));
  } else {
    if (task.output) console.log(task.output);
    for (const f of files) log('file', f);
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
  const interval = Number(o.interval ?? 3) * 1000;
  log('worker polling', { url: process.env.HANDOVER_URL ?? 'http://127.0.0.1:7777' });
  for (;;) {
    try {
      for (const { id } of await api.list(STATUS.PENDING)) {
        let task;
        try {
          task = await api.claim(id, `worker@${os.hostname()}`);
        } catch {
          continue; // someone else claimed it
        }
        log('picked up', id);
        const { code, stdout } = await runAgent(o.exec, task);
        const after = await api.get(id);
        if (!isTerminal(after.status)) {
          // Agent didn't call handover_complete itself: hand back its stdout.
          await api.complete(id, { status: code === 0 ? STATUS.SUCCESS : STATUS.FAILED, output: stdout.trim() });
        }
        log('finished', { id, exitCode: code });
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
    const pending = await httpApi().list(STATUS.PENDING);
    if (!pending.length) return EXIT.ok;
    const lines = pending.map((t) => `- ${t.id}: ${t.objective}`).join('\n');
    const additionalContext = `Pending handovers are waiting on the Handover relay:\n${lines}\n\nIf the user wants one picked up, call handover_claim with its id, do the work, then call handover_complete.`;
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
  } catch {
    // Relay offline: never block the session.
  }
  return EXIT.ok;
}

async function list(o) {
  console.log(JSON.stringify(await httpApi().list(o.status), null, 2));
  return EXIT.ok;
}

async function mcp() {
  const server = buildMcpServer(httpApi(), { agentName: `stdio@${os.hostname()}` });
  await server.connect(new StdioServerTransport());
  return null; // keep running
}

const commands = { serve, wait, worker, mcp, hook, list };
const [cmd, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  strict: false,
  options: {
    port: { type: 'string' }, host: { type: 'string' }, token: { type: 'string' }, tunnel: { type: 'string' },
    objective: { type: 'string' }, context: { type: 'string' }, 'context-file': { type: 'string' },
    id: { type: 'string' }, out: { type: 'string' }, timeout: { type: 'string' }, json: { type: 'boolean' },
    exec: { type: 'string' }, interval: { type: 'string' }, once: { type: 'boolean' }, status: { type: 'string' },
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
