/** Three machines on one host, through the real CLI: join, listen, then `handover test`. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { paths } from '../src/paths.ts';
import type { TestReport } from '../src/test.ts';

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let dir: string;
const spawned: ChildProcess[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-rr-'));
});
afterEach(async () => {
  for (const c of spawned.splice(0)) c.kill();
  await Bun.sleep(200);
  await fs.rm(dir, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

/** The CLI with no `claude` on PATH, as machine `home`. */
function start(home: string, args: string[], env: Record<string, string> = {}) {
  const { HANDOVER_URL: _u, HANDOVER_TOKEN: _t, HANDOVER_AGENT: _a, ...base } = process.env;
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...base, PATH: path.dirname(process.execPath), HANDOVER_HOME: path.join(dir, home), ...env },
  });
  spawned.push(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<{ code: number; out: string }>((r) => child.on('close', (code) => r({ code: code ?? -1, out })));
  return { child, done, out: () => out };
}

async function until(fn: () => boolean, ms = 10_000) {
  for (const end = Date.now() + ms; !fn(); ) {
    if (Date.now() > end) throw new Error('condition not met');
    await Bun.sleep(100);
  }
}

test('every machine reaches every other; a machine that stops shows as failed', async () => {
  const port = await freePort();
  expect((await start('hub', ['host', '--agent', 'hub', '--port', String(port), '--no-service']).done).code).toBe(0);
  const { token } = await loadConfig(paths(path.join(dir, 'hub')));
  const relay = start('hub', ['serve']);
  await until(() => relay.out().includes('running'));

  const url = `http://127.0.0.1:${port}`;
  for (const name of ['mac', 'pc']) {
    const joined = await start(name, ['join', url, '--agent', name], { HANDOVER_TOKEN: token! }).done;
    expect(joined.code).toBe(0);
    expect(joined.out).toContain('Round trip through the host:');
  }
  const mac = start('mac', ['listen']);
  const pc = start('pc', ['listen']);
  await until(() => mac.out().includes('Listening') && pc.out().includes('Listening'));
  await Bun.sleep(500); // first check-ins

  const ok = await start('hub', ['test', '--json', '--timeout', '3']).done;
  const report = JSON.parse(ok.out) as TestReport;
  expect(ok.code).toBe(0);
  expect(report.ok).toBe(true);
  expect(report.online.map((a) => a.agent).sort()).toEqual(['hub', 'mac', 'pc']);
  const pairs = report.links.filter((l) => l.ok).map((l) => `${l.from}>${l.to}`).sort();
  expect(pairs).toEqual(['hub>mac', 'hub>pc', 'mac>hub', 'mac>pc', 'pc>hub', 'pc>mac']);

  // From a client too, in the readable format.
  const fromMac = await start('mac', ['test', '--timeout', '3']).done;
  expect(fromMac.code).toBe(0);
  expect(fromMac.out).toContain('All connections work.');

  pc.child.kill(); // pc stops answering but is still listed as recently online
  await pc.done;
  const broken = await start('hub', ['test', '--json', '--timeout', '2']).done;
  const after = JSON.parse(broken.out) as TestReport;
  expect(broken.code).toBe(1);
  expect(after.links.find((l) => l.from === 'hub' && l.to === 'pc')?.ok).toBe(false);
  expect(after.links.find((l) => l.from === 'mac' && l.to === 'hub')?.ok).toBe(true);
}, 60_000);
