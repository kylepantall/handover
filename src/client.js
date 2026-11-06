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
      const err = new Error(data.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const enc = encodeURIComponent;
  return {
    create: (input) => call('POST', '/tasks', input),
    list: (status) => call('GET', `/tasks${status ? `?status=${enc(status)}` : ''}`),
    get: (id) => call('GET', `/tasks/${enc(id)}`),
    claim: (id, by) => call('POST', `/tasks/${enc(id)}/claim`, { by }),
    complete: (id, result) => call('POST', `/tasks/${enc(id)}/complete`, result),
    cancel: (id) => call('POST', `/tasks/${enc(id)}/cancel`, {}),
    wait: (id, timeoutMs = 25_000) => call('GET', `/tasks/${enc(id)}/wait?timeout=${timeoutMs}`),
  };
}

/** Wraps an in-process Store with the same async surface as httpApi. */
export function localApi(store) {
  return {
    create: async (input) => store.create(input),
    list: async (status) => store.list(status),
    get: async (id) => store.get(id),
    claim: async (id, by) => store.claim(id, by),
    complete: async (id, result) => store.complete(id, result),
    cancel: async (id) => store.cancel(id),
    wait: (id, timeoutMs = 25_000) => store.wait(id, timeoutMs),
  };
}
