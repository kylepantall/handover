import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { networkId } from '../src/discovery.ts';
import { peerApi } from '../src/peers.ts';
import { startServer } from '../src/server.ts';
import { STATUS, type Api, type Peer } from '../src/types.ts';

const TOKEN = 'peer-secret';
const servers: Server[] = [];
let alice: Peer;
let bob: Peer;
let visible: Peer[];

async function relay(): Promise<string> {
  const { server } = await startServer({ port: 0, host: '127.0.0.1', token: TOKEN });
  servers.push(server);
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

// Each machine's view: itself plus whatever discovery currently reports.
const view = (self: Peer): Api => peerApi({ self, token: TOKEN, discover: async () => visible });

beforeAll(async () => {
  alice = { agent: 'alice', url: await relay() };
  bob = { agent: 'bob', url: await relay() };
  visible = [alice, bob];
});
afterAll(() => servers.forEach((s) => s.close()));

test('a task created on one peer is picked up and completed from another', async () => {
  const fromAlice = view(alice);
  const fromBob = view(bob);
  const task = await fromAlice.create({ objective: 'peer task', from: 'alice' });
  expect(task.peer).toBe('alice');

  const waiting = fromAlice.wait(task.id, 5000);
  const claimed = await fromBob.claimNext({ by: 'bob' });
  expect(claimed?.id).toBe(task.id);
  expect(claimed?.peer).toBe('alice');
  await fromBob.renew(task.id, { by: 'bob' });
  await fromBob.complete(task.id, { output: 'done by bob' });

  const finished = await waiting;
  expect(finished.status).toBe(STATUS.SUCCESS);
  expect(finished.output).toBe('done by bob');
});

test('claimNext orders by priority across peers and respects targeting', async () => {
  const a = view(alice);
  const b = view(bob);
  await a.create({ id: 'a-low', objective: 'x', priority: 1 });
  await b.create({ id: 'b-high', objective: 'x', priority: 5 });
  await b.create({ id: 'b-for-alice', objective: 'x', priority: 9, to: 'alice' });

  const carol = view({ agent: 'carol', url: 'http://127.0.0.1:1' }); // carol's own relay is down
  expect((await carol.claimNext({ by: 'carol' }))?.id).toBe('b-high');
  expect((await carol.claimNext({ by: 'carol' }))?.id).toBe('a-low');
  expect(await carol.claimNext({ by: 'carol' })).toBeNull();
  expect((await a.claimNext({ by: 'alice' }))?.id).toBe('b-for-alice');
});

test('list merges peers and tags each task with its peer', async () => {
  const a = view(alice);
  await view(bob).create({ id: 'listed-on-bob', objective: 'x' });
  const all = await a.list({ status: STATUS.PENDING, agent: 'alice' });
  expect(all.find((t) => t.id === 'listed-on-bob')?.peer).toBe('bob');
});

test('a peer that disappears is skipped, not fatal', async () => {
  const before = visible;
  visible = [alice, { agent: 'ghost', url: 'http://127.0.0.1:1' }];
  try {
    const a = view(alice);
    await a.create({ id: 'still-works', objective: 'x' });
    expect((await a.list({ status: STATUS.PENDING })).some((t) => t.id === 'still-works')).toBe(true);
    await expect(a.get('nowhere')).rejects.toThrow();
  } finally {
    visible = before;
  }
});

test('networkId is stable, distinct per token, and does not contain the token', () => {
  expect(networkId(TOKEN)).toBe(networkId(TOKEN));
  expect(networkId(TOKEN)).not.toBe(networkId('other'));
  expect(networkId(TOKEN)).not.toContain(TOKEN);
  expect(networkId(TOKEN)).toMatch(/^[0-9a-f]{16}$/);
});
