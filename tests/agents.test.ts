/**
 * Coding agents: setup wires up Claude Code and Codex, and auto-pickup runs
 * tasks with them. Real CLIs are never used: HANDOVER_AGENT_PATH points at fake
 * `claude` and `codex` scripts that record what they were asked to do.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { localApi } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { paths } from '../src/paths.ts';
import { startServer } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { buildMcpServer } from '../src/tools.ts';
import type { Task } from '../src/types.ts';

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TOKEN = 'agents-test-token-0123456789abcdef';
let dir: string;
let fakes: string;
const spawned: ChildProcess[] = [];
const servers: Array<{ close(): void }> = [];

/**
 * A fake agent CLI: `mcp get|add|remove handover` keep a registration file;
 * anything else is a task run: it logs its argv and answers with the briefing's first line.
 */
const FAKE = `#!/bin/sh
PATH=/usr/bin:/bin
name="$(basename "$0")"
state="$FAKE_STATE/$name.mcp"
if [ "$1" = mcp ]; then
  case "$2" in
    get) [ -f "$state" ] && cat "$state" && exit 0; exit 1 ;;
    add) shift 2; echo "$*" > "$state"; exit 0 ;;
    remove) rm -f "$state"; exit 0 ;;
  esac
fi
echo "$*" >> "$FAKE_STATE/$name.runs"
input="$(cat)"
case "$input" in
  *"please fail"*) echo "FAILED: could not" ;;
  *) printf '%s\n' "$input" | head -n 1 | sed "s/^/done by $name: /" ;;
esac
`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-agents-'));
  fakes = path.join(dir, 'bin');
  await fs.mkdir(fakes);
  for (const name of ['claude', 'codex']) await fs.writeFile(path.join(fakes, name), FAKE, { mode: 0o755 });
});
afterEach(async () => {
  for (const c of spawned.splice(0)) c.kill();
  for (const s of servers.splice(0)) s.close();
  await Bun.sleep(100);
  await fs.rm(dir, { recursive: true, force: true });
});

function start(args: string[], env: Record<string, string> = {}) {
  const { HANDOVER_URL: _u, HANDOVER_TOKEN: _t, HANDOVER_AGENT: _a, HANDOVER_WORKER: _w, ...base } = process.env;
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...base,
      PATH: path.dirname(process.execPath),
      HANDOVER_HOME: path.join(dir, 'home'),
      HANDOVER_AGENT_PATH: fakes,
      FAKE_STATE: dir,
      CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
      ...env,
    },
  });
  spawned.push(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<{ code: number; out: string }>((r) => child.on('close', (code) => r({ code: code ?? -1, out })));
  return { child, done, out: () => out };
}
const cli = (args: string[], env?: Record<string, string>) => start(args, env).done;
const read = (file: string) => fs.readFile(path.join(dir, file), 'utf8').catch(() => '');

async function host() {
  const store = new Store();
  const { server } = await startServer({ port: 0, host: '127.0.0.1', token: TOKEN, store });
  servers.push(server);
  const addr = server.address();
  return { store, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 15_000) {
  for (const end = Date.now() + ms; !(await fn()); ) {
    if (Date.now() > end) throw new Error('condition not met');
    await Bun.sleep(100);
  }
}

const join = (url: string, ...flags: string[]) => cli(['join', url, '--agent', 'box', '--no-service', ...flags], { HANDOVER_TOKEN: TOKEN });

describe.skipIf(process.platform === 'win32')('agents', () => {
  test('join registers handover with Claude Code and Codex, and saves the auto-pickup choice', async () => {
    const { url } = await host();
    const { code } = await join(url, '--auto', 'codex');
    expect(code).toBe(0);
    expect((await loadConfig(paths(path.join(dir, 'home')))).agents).toEqual({ codex: { auto: true } });
    for (const name of ['claude', 'codex']) expect(await read(`${name}.mcp`)).toContain(`${CLI} mcp --as ${name}`);
    expect(existsSync(path.join(dir, 'claude', 'settings.json'))).toBe(true); // Claude Code's SessionStart hook
  });

  test('join replaces this install’s pre-0.10 registration (no --as)', async () => {
    const { url } = await host();
    await fs.writeFile(path.join(dir, 'codex.mcp'), `${process.execPath} ${CLI} mcp\n`);
    expect((await join(url)).code).toBe(0);
    expect(await read('codex.mcp')).toContain('mcp --as codex');
  });

  test('auto-pickup with both: tasks for codex go to Codex, for claude to Claude, for the machine to either', async () => {
    const { store, url } = await host();
    expect((await join(url, '--auto', 'both')).code).toBe(0);
    expect((await loadConfig(paths(path.join(dir, 'home')))).agents).toEqual({ claude: { auto: true }, codex: { auto: true } });
    const forCodex = store.create({ objective: 'graphics', to: 'codex' });
    const forClaude = store.create({ objective: 'the PR', to: 'claude@box' });
    const forBox = store.create({ objective: 'anything', to: 'box' });
    const elsewhere = store.create({ objective: 'not here', to: 'codex@other' });
    start(['serve']);
    await until(() => [forCodex, forClaude, forBox].every((t) => store.get(t.id).status === 'success'));
    expect(store.get(forCodex.id)).toMatchObject({ claimedBy: 'codex@box' });
    expect(store.get(forClaude.id)).toMatchObject({ claimedBy: 'claude@box' });
    expect(store.get(elsewhere.id).status).toBe('pending');
  });

  test('--no-codex leaves Codex alone; --auto with a skipped or missing agent fails', async () => {
    const { url } = await host();
    expect((await join(url, '--no-codex')).code).toBe(0);
    expect(await read('codex.mcp')).toBe('');
    expect((await join(url, '--no-codex', '--auto', 'codex')).code).not.toBe(0);
    await fs.rm(path.join(fakes, 'codex'));
    expect((await join(url, '--auto', 'codex')).code).not.toBe(0);
  });

  test('a client picks up a pending task right after join: the login service runs serve', async () => {
    const { store, url } = await host();
    const task = store.create({ objective: 'write the summary' });
    expect((await join(url, '--auto', 'codex')).code).toBe(0);
    start(['serve']); // what the login service runs on a client
    await until(() => store.get(task.id).status === 'success');
    expect(store.get(task.id).output).toBe(`done by codex: # Handover ${task.id}`);
    const argv = await read('codex.runs');
    expect(argv).toContain('exec');
    expect(argv).not.toContain('dangerously'); // default permissions
    expect(argv).toContain('--sandbox workspace-write'); // it may write in its own task folder
    expect(argv).toContain('mcp_servers.handover.default_tools_approval_mode=approve'); // and use handover's tools
  });

  test('without a service, the MCP server an agent starts takes tasks; not inside a worker’s own agent', async () => {
    const { store, url } = await host();
    expect((await join(url, '--auto', 'claude')).code).toBe(0);
    start(['mcp'], { HANDOVER_WORKER: '1' }); // an agent the worker started: must not start another worker
    const first = store.create({ objective: 'not for the nested server' });
    await Bun.sleep(3000);
    expect(store.get(first.id).status).toBe('pending');

    start(['mcp']);
    await until(() => store.get(first.id).status === 'success');
    expect(await read('claude.runs')).toContain('-p');
  });

  test('one auto-pickup worker per machine: a second process waits, and takes over when the first exits', async () => {
    const { url } = await host();
    expect((await join(url, '--auto', 'codex')).code).toBe(0);
    const lock = path.join(dir, 'home', 'worker-codex.lock');
    const first = start(['mcp']);
    await until(() => existsSync(lock));
    const second = start(['serve']);
    await Bun.sleep(1500);
    expect((await fs.readFile(lock, 'utf8')).trim()).toBe(String(first.child.pid));
    first.child.kill();
    await first.done;
    await until(async () => (await fs.readFile(lock, 'utf8').catch(() => '')).trim() === String(second.child.pid), 40_000);
  }, 60_000);

  test('handover agents changes one agent, or all, without touching the others', async () => {
    const { url } = await host();
    expect((await join(url)).code).toBe(0);
    const p = paths(path.join(dir, 'home'));
    const agents = async () => (await loadConfig(p)).agents;
    expect((await cli(['agents', 'all', 'on'])).code).toBe(0);
    expect(await agents()).toEqual({ claude: { auto: true }, codex: { auto: true } });
    expect((await cli(['agents', 'codex', 'full-access'])).code).toBe(0);
    expect(await agents()).toEqual({ claude: { auto: true }, codex: { auto: true, fullAccess: true } });
    expect((await cli(['agents', 'claude', 'off'])).code).toBe(0);
    expect(await agents()).toEqual({ codex: { auto: true, fullAccess: true } });
    expect((await cli(['agents', 'all', 'default-access'])).code).toBe(0);
    expect(await agents()).toEqual({ codex: { auto: true } });
    expect((await cli(['agents'])).code).toBe(0); // the list
    expect((await cli(['agents', 'codex', 'sideways'])).code).not.toBe(0);
  });

  test('a 0.9–0.10 config ("auto") is read, and rewritten as per-agent settings', async () => {
    const { url } = await host();
    expect((await join(url)).code).toBe(0);
    const p = paths(path.join(dir, 'home'));
    await fs.writeFile(p.config, JSON.stringify({ ...(await loadConfig(p)), auto: { with: 'codex', fullAccess: true } }));
    expect((await cli(['agents', 'codex', 'default-access'])).code).toBe(0);
    const c = await loadConfig(p);
    expect(c.auto).toBeUndefined();
    expect(c.agents).toEqual({ codex: { auto: true } });
  });

  test('an agent that answers FAILED: marks the task failed, even when it exits 0', async () => {
    const { store, url } = await host();
    expect((await join(url)).code).toBe(0);
    const task = store.create({ objective: 'please fail' });
    expect((await cli(['worker', '--with', 'codex', '--once'])).code).toBe(0);
    expect(store.get(task.id)).toMatchObject({ status: 'failed', output: 'FAILED: could not' });
  });

  test('worker --with … --full-access passes the agent its bypass flag', async () => {
    const { store, url } = await host();
    expect((await join(url)).code).toBe(0);
    const task = store.create({ objective: 'risky' });
    expect((await cli(['worker', '--with', 'claude', '--full-access', '--once'])).code).toBe(0);
    expect(store.get(task.id).status).toBe('success');
    expect(await read('claude.runs')).toContain('--dangerously-skip-permissions');
  });

  test('auto shows and changes the setting; doctor reports agents and auto-pickup', async () => {
    const { url } = await host();
    expect((await join(url)).code).toBe(0);
    const p = paths(path.join(dir, 'home'));
    expect((await loadConfig(p)).agents).toBeUndefined();
    expect((await cli(['auto', 'codex', '--full-access'])).code).toBe(0);
    expect((await loadConfig(p)).agents).toEqual({ codex: { auto: true, fullAccess: true } });

    const doctor = (await cli(['doctor', '--json'])).out;
    const checks = JSON.parse(doctor.slice(doctor.indexOf('[')));
    const byArea = Object.fromEntries(checks.map((c: { area: string; status: string }) => [c.area, c.status]));
    expect(byArea).toMatchObject({ 'claude code': 'ok', codex: 'ok', 'auto-pickup': 'warn' }); // full access warns

    expect((await cli(['auto', 'off'])).code).toBe(0);
    expect((await loadConfig(p)).agents?.codex?.auto).toBeFalsy();
  });

  test('unlink removes this install from both agents, and leaves another install’s alone', async () => {
    const { url } = await host();
    expect((await join(url)).code).toBe(0);
    await fs.writeFile(path.join(dir, 'codex.mcp'), '/somewhere/else/handover mcp\n');
    expect((await cli(['unlink'])).code).toBe(0);
    expect(await read('claude.mcp')).toBe('');
    expect(await read('codex.mcp')).toContain('/somewhere/else'); // another install's entry stays
  });
});

test('handover_watch waits for the next task and claims it', async () => {
  const store = new Store();
  const server = buildMcpServer(localApi(store), { agentName: 'watcher' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);
  const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

  expect(text(await mcp.callTool({ name: 'handover_watch', arguments: { timeoutSeconds: 1 } }))).not.toContain('# Handover');
  const watching = mcp.callTool({ name: 'handover_watch', arguments: { timeoutSeconds: 10 } });
  await Bun.sleep(300);
  const task: Task = store.create({ objective: 'arrives later' });
  expect(text(await watching)).toContain(`# Handover ${task.id}`);
  expect(store.get(task.id)).toMatchObject({ status: 'claimed', claimedBy: 'watcher' });
  await mcp.close();
});

test('handover_wait returns the result once the task finishes', async () => {
  const store = new Store();
  const server = buildMcpServer(localApi(store), { agentName: 'claude@mac' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);
  const json = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

  const created = json(await mcp.callTool({ name: 'handover_create', arguments: { objective: 'draw it', to: 'codex' } }));
  expect(created.whenDone).toContain(`handover wait --id ${created.id}`);
  expect(json(await mcp.callTool({ name: 'handover_wait', arguments: { id: created.id, timeoutSeconds: 1 } })).status).toBe('pending');

  const waiting = mcp.callTool({ name: 'handover_wait', arguments: { id: created.id, timeoutSeconds: 10 } });
  store.claim(created.id, { by: 'codex@pc' });
  store.complete(created.id, { output: 'here', files: [{ name: 'logo.svg', content: '<svg/>' }] });
  expect(json(await waiting)).toMatchObject({ status: 'success', output: 'here', files: [{ name: 'logo.svg' }] });
  await mcp.close();
});
