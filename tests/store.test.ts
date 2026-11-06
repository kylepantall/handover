import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HandoverError, Store } from '../src/store.ts';
import { FAILURE, STATUS } from '../src/types.ts';

const clock = (start = Date.parse('2026-01-01T00:00:00Z')) => {
  let t = start;
  const now = () => t;
  now.advance = (ms: number) => (t += ms);
  return now;
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as HandoverError).code;
  }
  return null;
};

test('claimNext takes highest priority first, then oldest', () => {
  const s = new Store();
  s.create({ id: 'low', objective: 'x', priority: -1 });
  s.create({ id: 'old', objective: 'x' });
  s.create({ id: 'new', objective: 'x' });
  s.create({ id: 'urgent', objective: 'x', priority: 5 });
  const order: string[] = [];
  let t;
  while ((t = s.claimNext({ by: 'a' }))) order.push(t.id);
  expect(order).toEqual(['urgent', 'old', 'new', 'low']);
});

test('claimNext returns null on an empty queue', () => {
  expect(new Store().claimNext({ by: 'a' })).toBeNull();
});

test('targeted tasks are only visible to and claimable by their agent', () => {
  const s = new Store();
  s.create({ id: 'for-b', objective: 'x', to: 'bob' });
  s.create({ id: 'any', objective: 'x' });
  expect(s.list({ status: STATUS.PENDING, agent: 'alice' }).map((t) => t.id)).toEqual(['any']);
  expect(codeOf(() => s.claim('for-b', { by: 'alice' }))).toBe('conflict');
  expect(s.claimNext({ by: 'alice' })?.id).toBe('any');
  expect(s.claimNext({ by: 'alice' })).toBeNull();
  expect(s.claimNext({ by: 'bob' })?.id).toBe('for-b');
});

test('expired lease requeues the task, then fails it after maxAttempts', () => {
  const now = clock();
  const s = new Store({ now, leaseMs: 1000, maxAttempts: 2 });
  s.create({ id: 't', objective: 'x' });

  s.claim('t', { by: 'a' });
  now.advance(1001);
  s.sweep();
  expect(s.get('t').status).toBe(STATUS.PENDING);
  expect(s.get('t').claimedBy).toBeNull();

  s.claim('t', { by: 'b' });
  now.advance(1001);
  s.sweep();
  expect(s.get('t').status).toBe(STATUS.FAILED);
  expect(s.get('t').failureReason).toBe(FAILURE.LEASE_EXPIRED);
});

test('renew extends the lease and only the claimer can renew', () => {
  const now = clock();
  const s = new Store({ now, leaseMs: 1000 });
  s.create({ id: 't', objective: 'x' });
  s.claim('t', { by: 'a' });
  expect(codeOf(() => s.renew('t', { by: 'b' }))).toBe('conflict');
  now.advance(900);
  s.renew('t', { by: 'a' });
  now.advance(900);
  s.sweep();
  expect(s.get('t').status).toBe(STATUS.CLAIMED);
});

test('waiter wakes on completion', async () => {
  const s = new Store();
  s.create({ id: 't', objective: 'x' });
  const waiting = s.wait('t', 5000);
  s.claim('t', { by: 'a' });
  s.complete('t', { output: 'ok' });
  expect((await waiting).status).toBe(STATUS.SUCCESS);
});

test('state persists across restarts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-store-'));
  const file = path.join(dir, 'tasks.json');
  const a = new Store({ file });
  a.create({ id: 'one', objective: 'x', priority: 2 });
  a.create({ id: 'two', objective: 'y' });
  a.claim('two', { by: 'w' });
  a.flush();
  if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

  const b = new Store({ file });
  expect(b.get('one').priority).toBe(2);
  expect(b.get('two').status).toBe(STATUS.CLAIMED);
  b.create({ id: 'three', objective: 'z' });
  expect(b.get('three').seq).toBeGreaterThan(b.get('two').seq);
  await fs.rm(dir, { recursive: true, force: true });
});

test('every change is on disk at once, so a killed process loses nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-store-'));
  const file = path.join(dir, 'tasks.json');
  const s = new Store({ file });
  s.create({ id: 'now', objective: 'x' });
  // No flush() and no waiting: a fresh store (the next host) already sees it.
  expect(new Store({ file }).get('now').status).toBe(STATUS.PENDING);
  s.claim('now', { by: 'a' });
  expect(new Store({ file }).get('now').status).toBe(STATUS.CLAIMED);
  await fs.rm(dir, { recursive: true, force: true });
});

test('finished tasks are pruned after retention', () => {
  const now = clock();
  const s = new Store({ now, retentionMs: 1000 });
  s.create({ id: 'done', objective: 'x' });
  s.create({ id: 'open', objective: 'x' });
  s.complete('done', { output: '' });
  now.advance(1001);
  s.sweep();
  expect(codeOf(() => s.get('done'))).toBe('not_found');
  expect(s.get('open').status).toBe(STATUS.PENDING);
});

test('rejects invalid input', () => {
  const s = new Store();
  expect(codeOf(() => s.create({ objective: '' }))).toBe('bad_request');
  expect(codeOf(() => s.create({ id: 'next', objective: 'x' }))).toBe('bad_request');
  expect(codeOf(() => s.create({ objective: 'x', priority: 1.5 }))).toBe('bad_request');
  expect(codeOf(() => s.create({ objective: 'x', to: 'bad name!' }))).toBe('bad_request');
  s.create({ id: 't', objective: 'x' });
  expect(codeOf(() => s.claim('t', { by: 'a', leaseMs: -1 }))).toBe('bad_request');
  for (const name of ['../evil', 'a/b', '.bashrc'])
    expect(codeOf(() => s.complete('t', { output: '', files: [{ name, content: 'x' }] }))).toBe('bad_request');
});

test('pings are hidden from agents and claimable only by their addressee', () => {
  const s = new Store();
  s.create({ id: 'job', objective: 'real work' });
  expect(codeOf(() => s.create({ objective: 'ping', kind: 'ping' }))).toBe('bad_request'); // needs `to`
  s.create({ id: 'p', objective: 'ping', kind: 'ping', to: 'b' });
  expect(s.list({ status: STATUS.PENDING }).map((t) => t.id)).toEqual(['job']);
  expect(s.claimNext({ by: 'b' })?.id).toBe('job'); // the worker never gets pings
  expect(s.claimNext({ by: 'a', kind: 'ping' })).toBeNull();
  expect(s.claimNext({ by: 'b', kind: 'ping' })?.id).toBe('p');
});

test('unanswered pings are cancelled, answered ones cleaned up', () => {
  const now = clock();
  const s = new Store({ now });
  s.create({ id: 'lost', objective: 'ping', kind: 'ping', to: 'gone' });
  s.create({ id: 'done', objective: 'ping', kind: 'ping', to: 'b' });
  s.complete('done', { output: '{}' });
  now.advance(61_000);
  s.sweep();
  expect(s.get('lost').status).toBe(STATUS.CANCELLED);
  now.advance(5 * 60_000);
  s.sweep();
  expect(codeOf(() => s.get('done'))).toBe('not_found');
});

test('presence: agents checked in recently, with everything running there', () => {
  const now = clock();
  const s = new Store({ now });
  s.heartbeat({ agent: 'pc', version: '1', platform: 'win32/x64', via: 'claude-code' });
  s.heartbeat({ agent: 'pc', version: '1', platform: 'win32/x64', via: 'worker' });
  now.advance(60_000);
  s.heartbeat({ agent: 'mac', version: '1', platform: 'darwin/arm64', via: 'relay' });
  expect(s.agents().map((a) => [a.agent, a.via])).toEqual([['mac', ['relay']], ['pc', ['claude-code', 'worker']]]);
  now.advance(60_000);
  expect(s.agents().map((a) => a.agent)).toEqual(['mac']); // pc went quiet
});
