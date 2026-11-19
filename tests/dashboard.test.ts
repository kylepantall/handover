import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { httpApi } from '../src/client.ts';
import { startServer } from '../src/server.ts';
import { workLoop } from '../src/worker.ts';

const token = 'test-dashboard-token';
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function setup() {
  const { server, store } = await startServer({ port: 0, host: '127.0.0.1', token });
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { base, post, store, api: httpApi({ url: base, token }), close: () => server.close() };
}

test('dashboard token protects data and an interactive handover receives directions for its claim', async () => {
  const app = await setup();
  const mcp = new Client({ name: 'dashboard-test', version: '1' });
  try {
    const dashboard = await fetch(app.base + '/dashboard');
    expect(dashboard.status).toBe(200);
    const html = await dashboard.text();
    expect(html).toContain('Connect to your relay');
    expect(html).not.toContain(token);
    expect(dashboard.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await fetch(app.base + '/dashboard/overview?token=' + token)).status).toBe(401);
    const script = await fetch(app.base + '/dashboard/app.js');
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(await script.text()).toContain('send-direction');

    await mcp.connect(new StreamableHTTPClientTransport(new URL(app.base + '/mcp'), {
      requestInit: { headers: { ...headers, 'x-handover-agent': 'codex@vault' } },
    }));
    const call = (name: string, args: Record<string, unknown>) => mcp.callTool({ name, arguments: args });
    const plan = await app.api.create({ objective: 'Use the staging credential', keyhopSession: true, to: 'codex@vault' });
    expect(await app.api.claimNext({ by: 'codex@vault', managed: true })).toBeNull();
    const claim = (await call('handover_claim', { id: plan.id })).content as { text: string }[];
    expect(claim[0]!.text).toContain('Use Keyhop open_session');
    expect(claim[0]!.text).toContain('and attempt 1');

    const task = '/tasks/' + plan.id;
    expect((await app.post(task + '/direct', { attempt: 2, message: 'stale' })).status).toBe(409);
    expect((await app.post(task + '/direct', { attempt: 1, message: 'Check staging only' })).status).toBe(200);
    const controls = await call('handover_controls', { id: plan.id, attempt: 1 });
    const state = JSON.parse((controls.content as { text: string }[])[0]!.text);
    expect(state).toMatchObject({ status: 'claimed', cursor: 1, directions: [{ message: 'Check staging only' }] });
    const details = await (await fetch(app.base + '/dashboard/task/' + plan.id, { headers })).json() as {
      directions: Array<{ deliveredAt?: string }>;
    };
    expect(details.directions[0]?.deliveredAt).toBeDefined();
    expect((await app.post(task + '/stop', { attempt: 1 })).status).toBe(200);
    const stopped = await call('handover_controls', { id: plan.id, attempt: 1, after: 1 });
    expect(JSON.parse((stopped.content as { text: string }[])[0]!.text)).toMatchObject({ status: 'cancelled', directions: [] });
  } finally {
    await mcp.close();
    app.close();
  }
});

test('force stop terminates a managed worker and the relay records its exit', async () => {
  const app = await setup();
  const temp = await mkdtemp(join(tmpdir(), 'handover-stop-'));
  const started = join(temp, 'started');
  const exceeded = join(temp, 'late');
  const stopWorker = new AbortController();
  let worker: Promise<void> | undefined;
  try {
    const task = app.store.create({ objective: 'Run until stopped' });
    worker = workLoop(app.api, {
      agent: 'codex@worker',
      command: [process.execPath, '-e',
        'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "started"); setTimeout(() => fs.writeFileSync(process.argv[2], "late"), 12000);',
        started, exceeded],
      once: true,
    }, stopWorker.signal);
    const deadline = Date.now() + 4000;
    while (!existsSync(started) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(started)).toBe(true);
    expect(app.store.get(task.id).managed).toBe(true);
    expect((await app.post('/tasks/' + task.id + '/stop', { attempt: 1 })).status).toBe(200);
    await Promise.race([worker, Bun.sleep(3000).then(() => { throw new Error('Worker did not stop'); })]);
    expect(app.store.get(task.id).status).toBe('cancelled');
    expect(app.store.get(task.id).stoppedAt).toBeDefined();
    expect(app.store.activity(task.id, 0).events.at(-1)?.message).toBe('Worker process stopped');
    expect(existsSync(exceeded)).toBe(false);
  } finally {
    stopWorker.abort();
    await worker?.catch(() => {});
    app.close();
    await rm(temp, { recursive: true, force: true });
  }
}, 10000);
