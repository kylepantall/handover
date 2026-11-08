import { describe, expect, test } from 'bun:test';
import { groupDevices } from '../src/devices.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/paths.ts';
import { PRESENCE_TTL_MS, Store } from '../src/store.ts';
import { CHECK_EVERY_MS, checkForUpdate } from '../src/updatecheck.ts';

const beat = (agent: string, via: string) => ({ agent, version: '1', platform: 'darwin/arm64', via });

test('groupDevices folds per-agent addresses into their machine', () => {
  const store = new Store();
  store.heartbeat(beat('pc', 'mcp'));
  store.heartbeat(beat('codex@pc', 'service'));
  store.heartbeat(beat('claude@pc', 'service'));
  store.heartbeat(beat('mac', 'relay'));
  const devices = groupDevices(store.agents({ all: true }));
  expect(devices.map((d) => d.machine).sort()).toEqual(['mac', 'pc']);
  expect(devices.find((d) => d.machine === 'pc')).toMatchObject({ online: true, agents: ['claude@pc', 'codex@pc'], via: ['mcp', 'service'] });
});

test('a machine that went quiet is listed as offline, and only when asked for', () => {
  let now = 1_000_000;
  const store = new Store({ now: () => now });
  store.heartbeat(beat('old', 'mcp'));
  now += PRESENCE_TTL_MS + 1;
  store.heartbeat(beat('new', 'mcp'));
  expect(store.agents().map((a) => a.agent)).toEqual(['new']);
  const devices = groupDevices(store.agents({ all: true }));
  expect(devices.map((d) => [d.machine, d.online])).toEqual([['new', true], ['old', false]]);
});

test('clear removes finished handovers and leaves open ones', () => {
  const store = new Store();
  const done = store.create({ objective: 'done' });
  store.complete(done.id, { output: 'x' });
  const open = store.create({ objective: 'open' });
  expect(store.clear()).toEqual({ removed: 1 });
  expect(store.list().map((t) => t.id)).toEqual([open.id]);
});

test('clear all cancels open handovers, telling anyone waiting', async () => {
  const store = new Store();
  const open = store.create({ objective: 'open' });
  const waiting = store.wait(open.id, 5000);
  expect(store.clear({ all: true })).toEqual({ removed: 1 });
  expect((await waiting).status).toBe('cancelled');
  expect(store.list()).toEqual([]);
});

test('clear leaves pings to the sweep', () => {
  const store = new Store();
  store.create({ kind: 'ping', to: 'pc', objective: 'ping' });
  expect(store.clear({ all: true })).toEqual({ removed: 0 });
  expect(store.list({ kind: 'ping' }).length).toBe(1);
});

test('paired devices survive a relay restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-devices-'));
  const file = path.join(dir, 'tasks.json');
  const first = new Store({ file });
  first.heartbeat({ ...beat('pc', 'mcp'), addresses: ['codex@pc', 'nope@elsewhere'] });
  first.flush();

  const second = new Store({ file, now: () => Date.now() + PRESENCE_TTL_MS + 1000 });
  expect(second.create({ objective: 'x', to: 'codex@pc' }).to).toBe('codex@pc');
  expect(() => second.create({ objective: 'x', to: 'nope@elsewhere' })).toThrow(); // a machine only speaks for itself
  expect(second.agents()).toEqual([]); // paired, but nothing there answers pings yet
  expect(second.agents({ all: true }).find((a) => a.agent === 'pc')?.online).toBe(false);
  await fs.rm(dir, { recursive: true, force: true });
});

test('a reported agent address is not pinged by handover test', () => {
  const store = new Store();
  store.heartbeat({ ...beat('pc', 'mcp'), addresses: ['codex@pc'] });
  expect(store.agents().map((a) => a.agent)).toEqual(['pc']);
});

test('remove cancels an open handover, telling anyone waiting', async () => {
  const store = new Store();
  const open = store.create({ objective: 'open' });
  const waiting = store.wait(open.id, 5000);
  store.remove(open.id);
  expect((await waiting).status).toBe('cancelled');
  expect(store.list()).toEqual([]);
});

describe('update check', () => {
  const setup = async () => paths(await fs.mkdtemp(path.join(os.tmpdir(), 'handover-update-')));
  const never = async () => {
    throw new Error('should not fetch');
  };

  test('tells when a newer release exists, and not otherwise', async () => {
    expect(await checkForUpdate(await setup(), { fetchLatest: async () => '2.0.0', current: '1.0.0' })).toContain('2.0.0');
    expect(await checkForUpdate(await setup(), { fetchLatest: async () => '1.0.0', current: '1.0.0' })).toBeNull();
  });

  test('uses the cached answer until it is stale', async () => {
    const p = await setup();
    await checkForUpdate(p, { fetchLatest: async () => '2.0.0', current: '1.0.0', now: 1000 });
    expect(await checkForUpdate(p, { fetchLatest: never, current: '1.0.0', now: 2000 })).toContain('2.0.0');
    expect(await checkForUpdate(p, { fetchLatest: async () => '3.0.0', current: '1.0.0', now: 1000 + CHECK_EVERY_MS })).toContain('3.0.0');
  });

  test('offline: no notice, no failure, and no retry on the next start', async () => {
    const p = await setup();
    expect(await checkForUpdate(p, { fetchLatest: never, current: '1.0.0', now: 1000 })).toBeNull();
    expect(await checkForUpdate(p, { fetchLatest: never, current: '1.0.0', now: 2000 })).toBeNull();
  });
});
