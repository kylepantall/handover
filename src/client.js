/** HTTP client for a Handover relay. Same async surface as localApi(store). */
export function httpApi({ url = process.env.HANDOVER_URL ?? 'http://127.0.0.1:7777', token = process.env.HANDOVER_TOKEN } = {}) {
  const base = url.replace(/\/+$/, '');
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  }
  const enc = encodeURIComponent;
  const query = (params) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    return q ? `?${q}` : '';
  };
  return {
    create: (input) => call('POST', '/tasks', input),
    list: ({ status, agent } = {}) => call('GET', `/tasks${query({ status, for: agent })}`),
    get: (id) => call('GET', `/tasks/${enc(id)}`),
    claim: (id, opts = {}) => call('POST', `/tasks/${enc(id)}/claim`, opts),
    claimNext: (opts = {}) => call('POST', '/tasks/next', opts),
    renew: (id, opts = {}) => call('POST', `/tasks/${enc(id)}/renew`, opts),
    complete: (id, result) => call('POST', `/tasks/${enc(id)}/complete`, result),
    cancel: (id) => call('POST', `/tasks/${enc(id)}/cancel`, {}),
    wait: (id, timeoutMs = 25_000) => call('GET', `/tasks/${enc(id)}/wait${query({ timeout: timeoutMs })}`),
  };
}

/** Wraps an in-process Store with the same async surface as httpApi. */
export function localApi(store) {
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
  };
}
