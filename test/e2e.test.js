import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/server.js';

const BIN = fileURLToPath(new URL('../bin/handover.js', import.meta.url));
const TOKEN = 'test-token';
let server, url, tmp;
const env = () => ({ ...process.env, HANDOVER_URL: url, HANDOVER_TOKEN: TOKEN });

function run(args) {
  const child = spawn(process.execPath, [BIN, ...args], { env: env(), cwd: tmp });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((r) => child.on('close', (code) => r({ code, stdout, stderr })));
  return { child, done, stderr: () => stderr };
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const parse = (res) => JSON.parse(res.content[0].text);
const httpClient = async (u) => {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(u)));
  return c;
};

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-'));
  ({ server } = await startServer({ port: 0, host: '127.0.0.1', token: TOKEN }));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('waiter receives output and files when an MCP agent completes the handover', async () => {
  const waiter = run(['wait', '--objective', 'write a haiku', '--context', 'about relays', '--out', 'out']);
  const id = await until(() => waiter.stderr().match(/HANDOVER_ID=(\S+)/)?.[1]);

  const mcp = await httpClient(`${url}/mcp?token=${TOKEN}`);
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  assert.ok(['handover_list', 'handover_claim', 'handover_complete', 'handover_create'].every((t) => tools.includes(t)));

  const pending = parse(await mcp.callTool({ name: 'handover_list', arguments: {} }));
  assert.ok(pending.some((t) => t.id === id));

  const claimed = await mcp.callTool({ name: 'handover_claim', arguments: { id } });
  assert.ok(!claimed.isError);
  assert.match(claimed.content[0].text, /about relays/);

  const res = await mcp.callTool({
    name: 'handover_complete',
    arguments: {
      id,
      output: 'DONE',
      files: [
        { name: 'haiku.txt', content: 'hello' },
        { name: 'bin.dat', content: Buffer.from([1, 2, 3]).toString('base64'), encoding: 'base64' },
      ],
    },
  });
  assert.ok(!res.isError);

  const { code, stdout } = await waiter.done;
  assert.equal(code, 0);
  assert.equal(stdout.trim(), 'DONE');
  assert.equal(await fs.readFile(path.join(tmp, 'out', 'haiku.txt'), 'utf8'), 'hello');
  assert.deepEqual([...(await fs.readFile(path.join(tmp, 'out', 'bin.dat')))], [1, 2, 3]);
  await mcp.close();
});

test('failed status propagates as non-zero exit', async () => {
  const waiter = run(['wait', '--objective', 'impossible']);
  const id = await until(() => waiter.stderr().match(/HANDOVER_ID=(\S+)/)?.[1]);
  const mcp = await httpClient(`${url}/mcp?token=${TOKEN}`);
  await mcp.callTool({ name: 'handover_complete', arguments: { id, output: 'nope', status: 'failed' } });
  assert.equal((await waiter.done).code, 1);
  await mcp.close();
});

test('rejects requests without a valid token', async () => {
  for (const u of [`${url}/tasks`, `${url}/mcp`, `${url}/tasks?token=wrong`]) {
    assert.equal((await fetch(u)).status, 401);
  }
  assert.equal((await fetch(`${url}/health`)).status, 200);
});

test('rejects path-traversal file names', async () => {
  const mcp = await httpClient(`${url}/mcp?token=${TOKEN}`);
  const { id } = parse(await mcp.callTool({ name: 'handover_create', arguments: { objective: 'x' } }));
  for (const name of ['../evil', 'a/b', '.bashrc']) {
    const res = await mcp.callTool({ name: 'handover_complete', arguments: { id, output: '', files: [{ name, content: 'x' }] } });
    assert.equal(res.isError, true);
  }
  assert.equal(parse(await mcp.callTool({ name: 'handover_get', arguments: { id } })).status, 'pending');
  await mcp.close();
});

test('stdio MCP proxies to the relay', async () => {
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env: env() }));
  const { id } = parse(await mcp.callTool({ name: 'handover_create', arguments: { objective: 'via stdio' } }));
  const task = await (await fetch(`${url}/tasks/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.equal(task.objective, 'via stdio');
  await mcp.close();
});

test('worker auto-picks up and falls back to agent stdout', async () => {
  const waiter = run(['wait', '--objective', 'echo me back', '--json']);
  await until(() => waiter.stderr().includes('HANDOVER_ID='));
  // Clear other pending tasks so --once handles ours.
  const headers = { authorization: `Bearer ${TOKEN}` };
  for (const t of await (await fetch(`${url}/tasks?status=pending`, { headers })).json()) {
    if (t.objective !== 'echo me back') await fetch(`${url}/tasks/${t.id}/cancel`, { method: 'POST', headers });
  }
  const worker = run(['worker', '--exec', 'grep -c "echo me back"', '--once']);
  assert.equal((await worker.done).code, 0);
  const { code, stdout } = await waiter.done;
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'success');
  assert.equal(result.output, '1');
});

test('hook emits SessionStart context listing pending handovers', async () => {
  const mcp = await httpClient(`${url}/mcp?token=${TOKEN}`);
  const { id } = parse(await mcp.callTool({ name: 'handover_create', arguments: { objective: 'for hook' } }));
  const { code, stdout } = await run(['hook']).done;
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.ok(out.hookSpecificOutput.additionalContext.includes(id));
  await mcp.close();
});
