import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const TOKEN = 'host-test-token';
let dir: string;
let port: number;
const children: ChildProcess[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

function run(args: string[]) {
  const { HANDOVER_URL: _u, HANDOVER_TOKEN: _t, HANDOVER_AGENT: _a, ...base } = process.env;
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, HANDOVER_HOME: dir }, cwd: dir });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<{ code: number; stdout: string; stderr: string }>((r) =>
    child.on('close', (code) => r({ code: code ?? -1, stdout, stderr }))
  );
  return { child, done, stderr: () => stderr };
}

async function until<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('condition not met');
    await Bun.sleep(100);
  }
}

const healthy = () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-host-'));
  port = await freePort();
  // This machine runs the relay, but nothing is serving it: no service, no `serve`.
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}`, token: TOKEN, agent: 'box', relay: { port } })
  );
});
afterEach(async () => {
  for (const c of children.splice(0)) c.kill();
  await Bun.sleep(200);
  await fs.rm(dir, { recursive: true, force: true });
});

test('wait hosts the relay itself when no service or serve is running', async () => {
  expect(await healthy()).toBe(false);
  const waiter = run(['wait', '--objective', 'self hosted', '--json']);
  await until(() => waiter.stderr().includes('HANDOVER_ID='));
  expect(await healthy()).toBe(true);

  const worker = run(['worker', '--once', '--exec', `"${process.execPath}" -e "console.log('done')"`]);
  expect((await worker.done).code).toBe(0);
  const { code, stdout } = await waiter.done;
  expect(code).toBe(0);
  expect(JSON.parse(stdout).output).toBe('done');
}, 30_000);

test('when the hosting process exits, a waiting process takes over and the queue survives', async () => {
  // A long-running worker hosts first (like Claude Code's MCP server would).
  const host = run(['worker', '--exec', 'exit 1', '--interval', '600']);
  await until(healthy);

  // A paired machine that never picks it up, so the task stays pending.
  await fetch(`http://127.0.0.1:${port}/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'nobody-yet', version: '1', platform: 'x', via: 'test' }),
  });
  const waiter = run(['wait', '--objective', 'survive the host', '--json', '--to', 'nobody-yet']);
  const id = await until(() => waiter.stderr().match(/HANDOVER_ID=(\S+)/)?.[1]);

  // A hard kill, like Windows' TerminateProcess: no shutdown hook gets to save anything.
  host.child.kill('SIGKILL');
  await host.done;
  // The waiter notices the relay is gone and hosts it, reloading the task from disk.
  await until(() => waiter.stderr().includes('hosting the relay in this process'));
  await until(healthy);
  const task = await (await fetch(`http://127.0.0.1:${port}/tasks/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  expect((task as { status: string }).status).toBe('pending');

  await fetch(`http://127.0.0.1:${port}/tasks/${id}/complete`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ output: 'after takeover' }),
  });
  const { code, stdout } = await waiter.done;
  expect(code).toBe(0);
  expect(JSON.parse(stdout).output).toBe('after takeover');
}, 45_000);

test('serve stands by instead of failing when another process hosts the relay', async () => {
  const host = run(['worker', '--exec', 'exit 1', '--interval', '600']);
  await until(healthy);
  const serve = run(['serve']);
  let out = '';
  serve.child.stdout!.on('data', (d) => (out += d));
  await until(() => out.includes('standing by'));
  expect(serve.child.exitCode).toBeNull(); // still running, not crash-looping

  host.child.kill('SIGTERM');
  await until(() => out.includes('running (announced'));
  expect(await healthy()).toBe(true);
}, 45_000);
