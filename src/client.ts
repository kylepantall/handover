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
  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
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
    create: async (input) => {
      if (!input.keyhopSession) return call('POST', '/tasks', input);
      try {
        return await call('POST', '/keyhop-session/tasks', input);
      } catch (error) {
        if (error instanceof RelayError && error.status === 404 && !error.code)
          throw new RelayError('Update the Handover host to queue interactive Keyhop sessions.', 404);
        throw error;
      }
    },
    list: ({ status, agent, kind } = {}) => call('GET', `/tasks${query({ status, for: agent, kind })}`),
    get: (id) => call('GET', `/tasks/${enc(id)}`),
    activity: (id, after, signal) => call('GET', `/tasks/${enc(id)}/activity${query({ after })}`, undefined, signal),
    progress: async (id, input) => void (await call('POST', `/tasks/${enc(id)}/progress`, input)),
    controls: (id, by, attempt, after) => call('POST', `/tasks/${enc(id)}/controls`, { by, attempt, after }),
    workerStopped: async (id, by, attempt) => void (await call('POST', `/tasks/${enc(id)}/stopped`, { by, attempt })),
    workerUpdate: (id, update, signal) => call('POST', `/tasks/${enc(id)}/worker-live`, update, signal),
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
    activity: async (id, after) => store.activity(id, after),
    progress: async (id, input) => store.progress(id, input),
    controls: async (id, by, attempt, after) => store.controls(id, by, attempt, after),
    workerStopped: async (id, by, attempt) => store.workerStopped(id, by, attempt),
    workerUpdate: async (id, update) => store.workerUpdate(id, update),
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
