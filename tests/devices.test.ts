import { expect, test } from 'bun:test';
import { groupDevices } from '../src/devices.ts';
import { PRESENCE_TTL_MS, Store } from '../src/store.ts';

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
