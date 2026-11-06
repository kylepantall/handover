import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, HandoverError, summarize } from './store.js';
import { localApi } from './client.js';
import { buildMcpServer } from './tools.js';

const MAX_BODY = 25 * 1024 * 1024;
const MAX_WAIT_MS = 60_000;
const HTTP_STATUS = { bad_request: 400, not_found: 404, conflict: 409, too_large: 413 };

const digest = (s) => createHash('sha256').update(String(s)).digest();

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HandoverError('too_large', 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HandoverError('bad_request', 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer({ port = 7777, host = '0.0.0.0', token, store = new Store(), sweepMs = 5_000 } = {}) {
  const expected = digest(token);
  const api = localApi(store);

  const authorized = (req, url) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    return given != null && timingSafeEqual(digest(given), expected);
  };

  async function handleMcp(req, res, url) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    // Stateless: a fresh server+transport per request, so any client (ChatGPT, Claude, ...) can connect.
    // Agent identity for targeting/leases: ?agent=<name> or X-Handover-Agent header.
    const agent = url.searchParams.get('agent') ?? req.headers['x-handover-agent'] ?? 'mcp-client';
    const server = buildMcpServer(api, { agentName: String(agent) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://local');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (!authorized(req, url)) return send(res, 401, { error: 'unauthorized' });
    if (parts[0] === 'mcp' && parts.length === 1) return handleMcp(req, res, url);
    if (parts[0] !== 'tasks') return send(res, 404, { error: 'not found' });

    const [, id, action] = parts;
    const m = req.method;
    const q = url.searchParams;
    if (!id && m === 'GET') {
      const filter = { status: q.get('status') ?? undefined, agent: q.has('for') ? q.get('for') : undefined };
      return send(res, 200, store.list(filter).map(summarize));
    }
    if (!id && m === 'POST') return send(res, 201, store.create(await readJson(req)));
    if (id === 'next' && !action && m === 'POST') return send(res, 200, store.claimNext(await readJson(req)));
    if (id && !action && m === 'GET') return send(res, 200, store.get(id));
    if (action === 'claim' && m === 'POST') return send(res, 200, store.claim(id, await readJson(req)));
    if (action === 'renew' && m === 'POST') return send(res, 200, store.renew(id, await readJson(req)));
    if (action === 'complete' && m === 'POST') return send(res, 200, store.complete(id, await readJson(req)));
    if (action === 'cancel' && m === 'POST') return send(res, 200, store.cancel(id));
    if (action === 'wait' && m === 'GET') {
      const ms = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 25_000, 0), MAX_WAIT_MS);
      return send(res, 200, await store.wait(id, ms));
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HandoverError) return send(res, HTTP_STATUS[err.code] ?? 400, { error: err.message, code: err.code });
      console.error('request failed', { error: err.message });
      send(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = MAX_WAIT_MS + 10_000;

  store.sweep();
  const sweeper = setInterval(() => store.sweep(), sweepMs);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(sweeper);
    store.flush();
  });

  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, store })));
}

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export const generateToken = () => randomBytes(24).toString('base64url');

/** Starts a public HTTPS tunnel. Resolves with the public URL. */
export function startTunnel(kind, port) {
  const specs = {
    cloudflared: { cmd: 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], re: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ },
    tailscale: { cmd: 'tailscale', args: ['funnel', String(port)], re: /https:\/\/[^\s/]+\.ts\.net\S*/ },
  };
  const spec = specs[kind];
  if (!spec) return Promise.reject(new Error(`unknown tunnel "${kind}" (use cloudflared or tailscale)`));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf) => {
      const match = String(buf).match(spec.re);
      if (match) resolve({ url: match[0].replace(/\/$/, ''), child });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => reject(new Error(`could not start ${spec.cmd}: ${e.message}`)));
    child.on('exit', (code) => reject(new Error(`${spec.cmd} exited with code ${code}`)));
    process.on('exit', () => child.kill());
  });
}
