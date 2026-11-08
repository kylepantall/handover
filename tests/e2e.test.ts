import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/server.ts';

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TOKEN = 'test-token';
let server: Server;
let url: string;
let tmp: string;
const auth = { authorization: `Bearer ${TOKEN}` };
const env = () => ({ ...process.env, HANDOVER_URL: url, HANDOVER_TOKEN: TOKEN, HANDOVER_HOME: path.join(tmp, 'home') }) as Record<string, string>;

function run(args: string[]) {
  const child = spawn(process.execPath, [CLI, ...args], { env: env(), cwd: tmp });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((r) =>
    child.on('close', (code) => r({ code: code ?? -1, stdout, stderr }))
  );
  return { done, stderr: () => stderr };
}

async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('condition not met');
    await Bun.sleep(50);
  }
}

const idOf = (w: ReturnType<typeof run>) => until(() => w.stderr().match(/HANDOVER_ID=(\S+)/)?.[1]);
const textOf = (res: any): string => res.content[0].text;
const parse = (res: any) => JSON.parse(textOf(res));
async function httpClient(agent?: string) {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp?token=${TOKEN}${agent ? `&agent=${agent}` : ''}`)));
  return c;
}
async function cancelPending() {
  for (const t of (await (await fetch(`${url}/tasks?status=pending`, { headers: auth })).json()) as Array<{ id: string }>)
    await fetch(`${url}/tasks/${t.id}/cancel`, { method: 'POST', headers: auth });
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-'));
  ({ server } = await startServer({ port: 0, host: '127.0.0.1', token: TOKEN }));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('waiter receives output and files when an MCP agent completes the handover', async () => {
  const waiter = run(['wait', '--objective', 'write a haiku', '--context', 'about relays', '--out', 'out']);
  const id = await idOf(waiter);

  const mcp = await httpClient();
  const tools = (await mcp.listTools()).tools.map((t) => t.name);
  for (const t of ['handover_list', 'handover_next', 'handover_claim', 'handover_renew', 'handover_complete', 'handover_create'])
    expect(tools).toContain(t);
  expect(parse(await mcp.callTool({ name: 'handover_list', arguments: {} })).some((t: any) => t.id === id)).toBe(true);

  const claimed = await mcp.callTool({ name: 'handover_claim', arguments: { id } });
  expect(claimed.isError).toBeFalsy();
  expect(textOf(claimed)).toContain('about relays');

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
  expect(res.isError).toBeFalsy();

  const { code, stdout } = await waiter.done;
  expect(code).toBe(0);
  expect(stdout.trim()).toBe('DONE');
  expect(await fs.readFile(path.join(tmp, 'out', 'haiku.txt'), 'utf8')).toBe('hello');
  expect([...(await fs.readFile(path.join(tmp, 'out', 'bin.dat')))]).toEqual([1, 2, 3]);
  await mcp.close();
});

test('failed status propagates as non-zero exit', async () => {
  const waiter = run(['wait', '--objective', 'impossible']);
  const id = await idOf(waiter);
  const mcp = await httpClient();
  await mcp.callTool({ name: 'handover_complete', arguments: { id, output: 'nope', status: 'failed' } });
  expect((await waiter.done).code).toBe(1);
  await mcp.close();
});

test('rejects requests without a valid token', async () => {
  for (const u of [`${url}/tasks`, `${url}/mcp`, `${url}/tasks?token=wrong`]) expect((await fetch(u)).status).toBe(401);
  expect((await fetch(`${url}/health`)).status).toBe(200);
});

test('stdio MCP proxies to the relay', async () => {
  const mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: env() }));
  const { id } = parse(await mcp.callTool({ name: 'handover_create', arguments: { objective: 'via stdio' } }));
  const task = (await (await fetch(`${url}/tasks/${id}`, { headers: auth })).json()) as { objective: string };
  expect(task.objective).toBe('via stdio');
  await mcp.close();
});

test('worker auto-picks up and falls back to agent stdout', async () => {
  await cancelPending();
  const waiter = run(['wait', '--objective', 'echo me back', '--json']);
  await idOf(waiter);
  // A tiny agent that works in sh and cmd.exe alike: prints 1 if the briefing mentions the objective.
  const agent = path.join(tmp, 'agent.ts');
  await fs.writeFile(agent, "console.log((await Bun.stdin.text()).includes('echo me back') ? 1 : 0)");
  const worker = run(['worker', '--exec', `"${process.execPath}" "${agent}"`, '--once']);
  expect((await worker.done).code).toBe(0);
  const { code, stdout } = await waiter.done;
  expect(code).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.status).toBe('success');
  expect(result.output).toBe('1');
});

test('handover_next over MCP respects targeting and priority', async () => {
  await cancelPending();
  await fetch(`${url}/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'bob', version: '1', platform: 'x', via: 'test' }),
  });
  const waiter = run(['wait', '--objective', 'for bob only', '--to', 'bob', '--priority', '1']);
  const id = await idOf(waiter);

  const alice = await httpClient('alice');
  await alice.callTool({ name: 'handover_create', arguments: { id: 'plain', objective: 'anyone' } });
  expect(textOf(await alice.callTool({ name: 'handover_next', arguments: {} }))).toContain('Handover plain');
  expect(textOf(await alice.callTool({ name: 'handover_next', arguments: {} }))).toContain('empty');

  const bob = await httpClient('bob');
  expect(textOf(await bob.callTool({ name: 'handover_next', arguments: { leaseSeconds: 60 } }))).toContain(`Handover ${id}`);
  expect((await bob.callTool({ name: 'handover_renew', arguments: { id } })).isError).toBeFalsy();
  expect((await alice.callTool({ name: 'handover_renew', arguments: { id } })).isError).toBe(true);
  await bob.callTool({ name: 'handover_complete', arguments: { id, output: 'hi alice' } });

  expect((await waiter.done).code).toBe(0);
  await alice.close();
  await bob.close();
});

test('hook emits SessionStart context listing pending handovers', async () => {
  const mcp = await httpClient();
  const { id } = parse(await mcp.callTool({ name: 'handover_create', arguments: { objective: 'for hook' } }));
  const { code, stdout } = await run(['hook']).done;
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
  expect(out.hookSpecificOutput.additionalContext).toContain(id);
  await mcp.close();
});

test('hook stays silent and succeeds when the relay is down', async () => {
  const child = spawn(process.execPath, [CLI, 'hook'], { env: { ...env(), HANDOVER_URL: 'http://127.0.0.1:1' } });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const code = await new Promise((r) => child.on('close', r));
  expect(code).toBe(0);
  expect(stdout).toBe('');
});
