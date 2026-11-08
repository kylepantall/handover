import type { Store } from './store.ts';
import type { Api, Task } from './types.ts';

export interface Endpoint {
  url: string;
  token?: string;
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

/** HTTP client for a Handover relay. */
export function httpApi({ url, token }: Endpoint): Api {
  const base = url.replace(/\/+$/, '');
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string } | null;
    if (!res.ok) throw new RelayError(data?.error ?? `HTTP ${res.status}`, res.status, data?.code);
    return data as T;
  }
  const enc = encodeURIComponent;
  const query = (params: Record<string, string | number | undefined>) => {
    const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] != null);
    const q = new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
    return q ? `?${q}` : '';
  };
  return {
    create: (input) => call('POST', '/tasks', input),
    list: ({ status, agent, kind } = {}) => call('GET', `/tasks${query({ status, for: agent, kind })}`),
    get: (id) => call('GET', `/tasks/${enc(id)}`),
    claim: (id, opts = {}) => call('POST', `/tasks/${enc(id)}/claim`, opts),
    claimNext: (opts = {}) => call<Task | null>('POST', '/tasks/next', opts),
    renew: (id, opts = {}) => call('POST', `/tasks/${enc(id)}/renew`, opts),
    complete: (id, result) => call('POST', `/tasks/${enc(id)}/complete`, result),
    cancel: (id) => call('POST', `/tasks/${enc(id)}/cancel`, {}),
    wait: (id, timeoutMs = 25_000) => call('GET', `/tasks/${enc(id)}/wait${query({ timeout: timeoutMs })}`),
    heartbeat: async (beat) => void (await call('POST', '/agents', beat)),
    agents: ({ all } = {}) => call('GET', `/agents${query({ all: all ? 1 : undefined })}`),
    remove: (id) => call('DELETE', `/tasks/${enc(id)}`),
    forget: (name) => call('DELETE', `/agents/${enc(name)}`),
    clear: ({ all } = {}) => call('DELETE', `/tasks${query({ all: all ? 1 : undefined })}`),
  };
}

/** Wraps an in-process Store with the same surface as httpApi. */
export function localApi(store: Store): Api {
  return {
    create: async (input) => store.create(input),
    list: async (filter) => store.list(filter),
    get: async (id) => store.get(id),
    claim: async (id, opts) => store.claim(id, opts),
    claimNext: async (opts) => store.claimNext(opts),
    renew: async (id, opts) => store.renew(id, opts),
    complete: async (id, result) => store.complete(id, result),
    cancel: async (id) => store.cancel(id),
    wait: (id, timeoutMs = 25_000) => store.wait(id, timeoutMs),
    heartbeat: async (beat) => store.heartbeat(beat),
    agents: async (filter) => store.agents(filter),
    clear: async (options) => store.clear(options),
    forget: async (name) => store.forget(name),
    remove: async (id) => store.remove(id),
  };
}

/** True when the relay answers and accepts the token. */
export async function probe({ url, token }: Endpoint): Promise<'ok' | 'unreachable' | 'unauthorized'> {
  try {
    await httpApi({ url, token }).list({ status: 'pending' });
    return 'ok';
  } catch (err) {
    return err instanceof RelayError && err.status === 401 ? 'unauthorized' : 'unreachable';
  }
}
