import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Store, HandoverError, summarize, type ErrorCode } from './store.ts';
import { localApi } from './client.ts';
import { DashboardSessions, serveDashboard } from './dashboard.ts';
import { buildMcpServer } from './tools.ts';
import type { TaskKind, TaskStatus, Tunnel, WorkerUpdate } from './types.ts';

const MAX_BODY = 25 * 1024 * 1024;
const MAX_WAIT_MS = 60_000;
const HTTP_STATUS: Record<ErrorCode, number> = { bad_request: 400, not_found: 404, conflict: 409, too_large: 413 };

const digest = (s: string) => createHash('sha256').update(s).digest();

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HandoverError('too_large', 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HandoverError('bad_request', 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export interface ServerOptions {
  port?: number;
  host?: string;
  token: string;
  store?: Store;
  sweepMs?: number;
}

export function startServer({ port = 7777, host = '0.0.0.0', token, store = new Store(), sweepMs = 5_000 }: ServerOptions) {
  if (!token) throw new Error('a token is required');
  const expected = digest(token);
  const api = localApi(store);
  const sessions = new DashboardSessions();

  const authorized = (req: IncomingMessage, url: URL, headerOnly = false) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : headerOnly ? null : url.searchParams.get('token');
    return given != null && timingSafeEqual(digest(given), expected);
  };

  function streamTranscript(id: string, req: IncomingMessage, res: ServerResponse, url: URL) {
    let after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
    store.transcript(id, after); // Validate the task and cursor before sending headers.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
    });
    let writable = res.write('retry: 1000\n\n');
    let lastWrite = Date.now();
    let interval: ReturnType<typeof setInterval> | undefined;
    const close = () => { clearInterval(interval); res.end(); };
    res.on('close', () => clearInterval(interval));
    res.on('drain', () => { writable = true; });
    const publish = () => {
      if (!sessions.has(req) && !authorized(req, url, true)) return close();
      if (!writable) return;
      try {
        const page = store.transcript(id, after);
        if (page.events.length) {
          after = page.cursor;
          writable = res.write(`id: ${after}\nevent: transcript\ndata: ${JSON.stringify(page)}\n\n`);
          lastWrite = Date.now();
        } else if (Date.now() - lastWrite >= 15_000) {
          writable = res.write(': keepalive\n\n');
          lastWrite = Date.now();
        }
      } catch {
        close(); // The task was removed while this browser was watching it.
      }
    };
    interval = setInterval(publish, 200);
    publish();
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
    const body = await readJson(req);
    // Agent identity for targeting/leases: ?agent=<name> or X-Handover-Agent header.
    const named = url.searchParams.get('agent') ?? req.headers['x-handover-agent'];
    const agent = named ?? 'mcp-client';
    // A client that says who it is can be sent tasks, like any paired machine.
    if (named) {
      try {
        store.pair(String(named));
      } catch {
        // an invalid name: its tool calls report it
      }
    }
    // Stateless: a fresh server+transport per request, so any client (ChatGPT, Claude, ...) can connect.
    const server = buildMcpServer(api, { agentName: String(agent) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (url.pathname === '/health') return send(res, 200, { ok: true });
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(302, { location: '/dashboard', 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && serveDashboard(url.pathname, res)) return;
    if (parts[0] === 'dashboard') {
      // A cross-origin form cannot add this header or send a preflight that the relay accepts.
      if (req.method === 'POST' && req.headers['x-handover-dashboard'] !== '1')
        return send(res, 403, { error: 'Open the Handover dashboard to make this request.' });
      if (url.pathname === '/dashboard/login' && req.method === 'POST') {
        const { token: entered } = await readJson(req, 4096);
        if (typeof entered !== 'string' || !timingSafeEqual(digest(entered), expected))
          return send(res, 401, { error: 'That token did not match the relay.' });
        sessions.signIn(req, res);
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/dashboard/logout' && req.method === 'POST') {
        sessions.signOut(req, res);
        return send(res, 200, { ok: true });
      }
      if (!sessions.has(req) && !authorized(req, url, true))
        return send(res, 401, { error: 'Sign in to the Handover dashboard.' });
      if (url.pathname === '/dashboard/overview' && req.method === 'GET')
        return send(res, 200, { tasks: store.list().map(summarize), agents: store.agents({ all: true }) });
      const [, category, id, action] = parts;
      if (category === 'task' && id && parts.length <= 4) {
        if (action === 'transcript' && req.method === 'GET') return streamTranscript(id, req, res, url);
        if (action === 'direct' && req.method === 'POST') {
          const { attempt, message } = await readJson(req, 4096);
          store.direct(id, attempt, message);
          return send(res, 200, { ok: true });
        }
        if (action === 'stop' && req.method === 'POST') {
          const { attempt } = await readJson(req, 4096);
          return send(res, 200, summarize(store.stop(id, attempt)));
        }
        if (!action && req.method === 'GET') {
          const task = store.get(id);
          return send(res, 200, {
            task: summarize(task),
            activity: store.activity(id, Number(url.searchParams.get('after') ?? 0)),
            directions: task.directions ?? [],
            output: task.output?.slice(0, 64_000),
            outputTruncated: (task.output?.length ?? 0) > 64_000,
          });
        }
      }
      return send(res, 404, { error: 'not found' });
    }
    const controls = parts[0] === 'tasks' && ['direct', 'stop', 'controls', 'stopped', 'worker-live'].includes(parts[2] ?? '');
    if (!authorized(req, url, controls)) return send(res, 401, { error: 'unauthorized' });
    if (url.pathname === '/keyhop-session/tasks' && req.method === 'POST')
      return send(res, 201, store.create({ ...(await readJson(req) as any), keyhopSession: true }));
    if (parts[0] === 'mcp' && parts.length === 1) return handleMcp(req, res, url);
    if (parts[0] === 'agents' && parts.length === 1) {
      if (req.method === 'POST') {
        store.heartbeat((await readJson(req)) as any);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET') return send(res, 200, store.agents({ all: url.searchParams.get('all') === '1' }));
    }
    if (parts[0] === 'agents' && parts.length === 2 && req.method === 'DELETE') return send(res, 200, store.forget(parts[1]!));
    if (parts[0] !== 'tasks') return send(res, 404, { error: 'not found' });

    const [, id, action] = parts;
    const m = req.method;
    const q = url.searchParams;
    if (!id && m === 'GET') {
      const filter = {
        status: (q.get('status') ?? undefined) as TaskStatus | undefined,
        agent: q.get('for') ?? undefined,
        kind: (q.get('kind') ?? undefined) as TaskKind | undefined,
      };
      return send(res, 200, store.list(filter).map(summarize));
    }
    if (!id && m === 'DELETE') return send(res, 200, store.clear({ all: q.get('all') === '1' }));
    if (!id && m === 'POST') return send(res, 201, store.create((await readJson(req)) as any));
    if (id === 'next' && !action && m === 'POST') return send(res, 200, store.claimNext(await readJson(req)));
    if (id && !action && m === 'DELETE') return send(res, 200, store.remove(id));
    if (id && !action && m === 'GET') return send(res, 200, store.get(id));
    if (id && action === 'activity' && m === 'GET') return send(res, 200, store.activity(id, Number(q.get('after') ?? 0)));
    if (id && action === 'progress' && m === 'POST') {
      store.progress(id, (await readJson(req)) as { by: string; message: string });
      return send(res, 200, { ok: true });
    }
    if (id && action === 'direct' && m === 'POST') {
      const { attempt, message } = await readJson(req);
      store.direct(id, attempt, message);
      return send(res, 200, { ok: true });
    }
    if (id && action === 'stop' && m === 'POST') {
      const { attempt } = await readJson(req);
      return send(res, 200, summarize(store.stop(id, attempt)));
    }
    if (id && action === 'controls' && m === 'POST') {
      const { by, attempt, after } = await readJson(req);
      return send(res, 200, store.controls(id, by, attempt, after));
    }
    if (id && action === 'stopped' && m === 'POST') {
      const { by, attempt } = await readJson(req);
      store.workerStopped(id, by, attempt);
      return send(res, 200, { ok: true });
    }
    if (id && action === 'worker-live' && m === 'POST') {
      const update = await readJson(req, 512 * 1024);
      return send(res, 200, store.workerUpdate(id, update as unknown as WorkerUpdate));
    }
    if (id && action === 'claim' && m === 'POST') return send(res, 200, store.claim(id, await readJson(req)));
    if (id && action === 'renew' && m === 'POST') return send(res, 200, store.renew(id, await readJson(req)));
    if (id && action === 'complete' && m === 'POST') return send(res, 200, store.complete(id, await readJson(req)));
    if (id && action === 'cancel' && m === 'POST') return send(res, 200, store.cancel(id));
    if (id && action === 'wait' && m === 'GET') {
      const ms = Math.min(Math.max(Number(q.get('timeout')) || 25_000, 0), MAX_WAIT_MS);
      return send(res, 200, await store.wait(id, ms));
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err: Error) => {
      if (res.headersSent) return res.end();
      if (err instanceof HandoverError) return send(res, HTTP_STATUS[err.code], { error: err.message, code: err.code });
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

  return new Promise<{ server: http.Server; store: Store }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, store }));
  });
}

export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i!.address);
}

export const generateToken = (): string => randomBytes(24).toString('base64url');

/** Starts a public HTTPS tunnel. Resolves with the public URL. */
export function startTunnel(kind: Tunnel, port: number): Promise<{ url: string; child: ChildProcess }> {
  const specs: Record<Tunnel, { cmd: string; args: string[]; re: RegExp }> = {
    cloudflared: {
      cmd: 'cloudflared',
      args: ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
      re: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    },
    tailscale: { cmd: 'tailscale', args: ['funnel', String(port)], re: /https:\/\/[^\s/]+\.ts\.net\S*/ },
  };
  const spec = specs[kind];
  if (!spec) return Promise.reject(new Error(`unknown tunnel "${kind}" (use cloudflared or tailscale)`));
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buf: Buffer) => {
      const match = String(buf).match(spec.re);
      if (match) resolve({ url: match[0].replace(/\/$/, ''), child });
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.on('error', (e) => reject(new Error(`could not start ${spec.cmd}: ${e.message}`)));
    child.on('exit', (code) => reject(new Error(`${spec.cmd} exited with code ${code}`)));
    process.on('exit', () => child.kill());
  });
}
