import { expect, test } from 'bun:test';
import { localApi } from '../src/client.ts';
import { NO_ANSWER, pingAgent, startResponder } from '../src/responder.ts';
import { Store } from '../src/store.ts';

test('a ping reaches its agent and comes back; round robin pings report each link', async () => {
  const api = localApi(new Store());
  const a = startResponder(api, { agent: 'a', via: 'test' }, { pollMs: 20 });
  const b = startResponder(api, { agent: 'b', via: 'test' }, { pollMs: 20 });
  try {
    const direct = await pingAgent(api, 'a', 'b', { timeoutMs: 2_000 });
    expect(direct.ok).toBe(true);
    expect(direct.reply?.agent).toBe('b');

    const relayed = await pingAgent(api, 'a', 'b', { timeoutMs: 2_000, relayTo: ['a', 'nobody'] });
    expect(relayed.ok).toBe(true);
    const links = relayed.reply?.links ?? [];
    expect(links.find((l) => l.to === 'a')).toMatchObject({ from: 'b', ok: true });
    expect(links.find((l) => l.to === 'nobody')).toMatchObject({ from: 'b', ok: false, error: NO_ANSWER });

    expect((await api.agents()).map((x) => x.agent).sort()).toEqual(['a', 'b']);
  } finally {
    a.stop();
    b.stop();
  }
});

test('a ping to a machine with nothing running fails with a clear reason', async () => {
  const api = localApi(new Store());
  const r = await pingAgent(api, 'a', 'offline', { timeoutMs: 300 });
  expect(r.ok).toBe(false);
  expect(r.error).toBe(NO_ANSWER);
});
