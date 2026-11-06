import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, STATUS, FAILURE } from '../src/store.js';

const clock = (start = Date.parse('2026-01-01T00:00:00Z')) => {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};

const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
};

test('claimNext takes highest priority first, then oldest', () => {
  const s = new Store();
  s.create({ id: 'low', objective: 'x', priority: -1 });
  s.create({ id: 'old', objective: 'x' });
  s.create({ id: 'new', objective: 'x' });
  s.create({ id: 'urgent', objective: 'x', priority: 5 });
  const order = [];
  let t;
  while ((t = s.claimNext({ by: 'a' }))) order.push(t.id);
  assert.deepEqual(order, ['urgent', 'old', 'new', 'low']);
});

test('claimNext returns null on an empty queue', () => {
  assert.equal(new Store().claimNext({ by: 'a' }), null);
});

test('targeted tasks are only visible to and claimable by their agent', () => {
  const s = new Store();
  s.create({ id: 'for-b', objective: 'x', to: 'bob' });
  s.create({ id: 'any', objective: 'x' });
  assert.deepEqual(s.list({ status: STATUS.PENDING, agent: 'alice' }).map((t) => t.id), ['any']);
  assert.equal(codeOf(() => s.claim('for-b', { by: 'alice' })), 'conflict');
  assert.equal(s.claimNext({ by: 'alice' }).id, 'any');
  assert.equal(s.claimNext({ by: 'alice' }), null);
  assert.equal(s.claimNext({ by: 'bob' }).id, 'for-b');
});

test('expired lease requeues the task, then fails it after maxAttempts', () => {
  const now = clock();
  const s = new Store({ now, leaseMs: 1000, maxAttempts: 2 });
  s.create({ id: 't', objective: 'x' });

  s.claim('t', { by: 'a' });
  now.advance(1001);
  s.sweep();
  assert.equal(s.get('t').status, STATUS.PENDING);
  assert.equal(s.get('t').claimedBy, null);

  s.claim('t', { by: 'b' });
  now.advance(1001);
  s.sweep();
  assert.equal(s.get('t').status, STATUS.FAILED);
  assert.equal(s.get('t').failureReason, FAILURE.LEASE_EXPIRED);
});

test('renew extends the lease and only the claimer can renew', () => {
  const now = clock();
  const s = new Store({ now, leaseMs: 1000 });
  s.create({ id: 't', objective: 'x' });
  s.claim('t', { by: 'a' });
  assert.equal(codeOf(() => s.renew('t', { by: 'b' })), 'conflict');
  now.advance(900);
  s.renew('t', { by: 'a' });
  now.advance(900);
  s.sweep();
  assert.equal(s.get('t').status, STATUS.CLAIMED);
});

test('waiter wakes on completion', async () => {
  const now = clock();
  const s = new Store({ now, leaseMs: 1000 });
  s.create({ id: 't', objective: 'x' });
  const waiting = s.wait('t', 5000);
  s.claim('t', { by: 'a' });
  s.complete('t', { output: 'ok' });
  assert.equal((await waiting).status, STATUS.SUCCESS);
});

test('state persists across restarts', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-store-'));
  const file = path.join(dir, 'tasks.json');
  const a = new Store({ file });
  a.create({ id: 'one', objective: 'x', priority: 2 });
  a.create({ id: 'two', objective: 'y' });
  a.claim('two', { by: 'w' });
  a.flush();
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  const b = new Store({ file });
  assert.equal(b.get('one').priority, 2);
  assert.equal(b.get('two').status, STATUS.CLAIMED);
  b.create({ id: 'three', objective: 'z' });
  assert.ok(b.get('three').seq > b.get('two').seq);
});

test('finished tasks are pruned after retention', () => {
  const now = clock();
  const s = new Store({ now, retentionMs: 1000 });
  s.create({ id: 'done', objective: 'x' });
  s.create({ id: 'open', objective: 'x' });
  s.complete('done', { output: '' });
  now.advance(1001);
  s.sweep();
  assert.equal(codeOf(() => s.get('done')), 'not_found');
  assert.equal(s.get('open').status, STATUS.PENDING);
});

test('rejects invalid input', () => {
  const s = new Store();
  assert.equal(codeOf(() => s.create({ objective: '' })), 'bad_request');
  assert.equal(codeOf(() => s.create({ id: 'next', objective: 'x' })), 'bad_request');
  assert.equal(codeOf(() => s.create({ objective: 'x', priority: 1.5 })), 'bad_request');
  assert.equal(codeOf(() => s.create({ objective: 'x', to: 'bad name!' })), 'bad_request');
  s.create({ id: 't', objective: 'x' });
  assert.equal(codeOf(() => s.claim('t', { by: 'a', leaseMs: -1 })), 'bad_request');
});
