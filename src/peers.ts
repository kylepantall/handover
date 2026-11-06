/**
 * Peer mode: every machine runs its own relay holding the tasks it created.
 * This Api fans out across all peers, and sends each call about a task to the
 * peer that holds it.
 */

import { httpApi, RelayError } from './client.ts';
import { HandoverError } from './store.ts';
import { STATUS, type Api, type ListFilter, type Peer, type Task, type TaskSummary } from './types.ts';

export interface PeerApiOptions {
  self: Peer;
  token: string;
  /** Other peers currently visible (self is skipped if listed). */
  discover: () => Promise<Peer[]>;
}

type Listed = Task | TaskSummary;
const byQueueOrder = (a: Listed, b: Listed) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt);
const isConflict = (err: unknown) =>
  (err instanceof RelayError && err.status === 409) || (err instanceof HandoverError && err.code === 'conflict');

export function peerApi({ self, token, discover }: PeerApiOptions): Api {
  const owners = new Map<string, Peer>(); // task id -> peer holding it
  const clients = new Map<string, Api>(); // url -> client
  const clientFor = (peer: Peer) => {
    let c = clients.get(peer.url);
    if (!c) clients.set(peer.url, (c = httpApi({ url: peer.url, token })));
    return c;
  };

  async function peers(): Promise<Peer[]> {
    const others = (await discover()).filter((p) => p.agent !== self.agent && p.url !== self.url);
    return [self, ...others];
  }

  async function listAll(filter: ListFilter = {}): Promise<Listed[]> {
    const results = await Promise.allSettled(
      (await peers()).map(async (peer) => (await clientFor(peer).list(filter)).map((t) => ({ ...t, peer: peer.agent, _url: peer.url })))
    );
    const tasks = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    for (const t of tasks) owners.set(t.id, { agent: t.peer, url: t._url });
    return tasks.map(({ _url, ...t }) => t).sort(byQueueOrder);
  }

  async function owner(id: string): Promise<{ api: Api; peer: Peer }> {
    let peer = owners.get(id);
    if (!peer) {
      await listAll();
      peer = owners.get(id);
    }
    if (!peer) throw new HandoverError('not_found', 'task not found on any peer');
    return { api: clientFor(peer), peer };
  }

  const tag = (peer: Peer) => (t: Task): Task => ({ ...t, peer: peer.agent });
  const routed =
    <A extends unknown[]>(fn: (api: Api, id: string, ...args: A) => Promise<Task>) =>
    async (id: string, ...args: A): Promise<Task> => {
      const { api, peer } = await owner(id);
      return tag(peer)(await fn(api, id, ...args));
    };

  return {
    // New tasks live on this machine, so they survive other peers going away.
    async create(input) {
      const task = await clientFor(self).create(input);
      owners.set(task.id, self);
      return tag(self)(task);
    },
    list: listAll,
    get: routed((api, id) => api.get(id)),
    claim: routed((api, id, opts?: Parameters<Api['claim']>[1]) => api.claim(id, opts)),
    renew: routed((api, id, opts?: Parameters<Api['renew']>[1]) => api.renew(id, opts)),
    complete: routed((api, id, result: Parameters<Api['complete']>[1]) => api.complete(id, result)),
    cancel: routed((api, id) => api.cancel(id)),
    wait: routed((api, id, timeoutMs?: number) => api.wait(id, timeoutMs)),
    async claimNext(opts = {}) {
      const pending = await listAll({ status: STATUS.PENDING, agent: opts.by ?? '' });
      for (const t of pending) {
        try {
          const { api, peer } = await owner(t.id);
          return tag(peer)(await api.claim(t.id, opts));
        } catch (err) {
          // Someone else got it first, or that peer just went away: try the next one.
          const unreachable = !(err instanceof RelayError) && !(err instanceof HandoverError);
          if (!isConflict(err) && !unreachable) throw err;
        }
      }
      return null;
    },
  };
}
