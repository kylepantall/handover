import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import html from './dashboard/index.html' with { type: 'text' };
import css from './dashboard/style.css' with { type: 'text' };
import js from './dashboard/app.js' with { type: 'text' };

const assets = new Map([
  ['/dashboard', ['text/html', html]],
  ['/dashboard/', ['text/html', html]],
  ['/dashboard/login', ['text/html', html]],
  ['/dashboard/style.css', ['text/css', css]],
  ['/dashboard/app.js', ['text/javascript', js]],
]);

const COOKIE_NAME = 'handover_dashboard';
const SESSION_SECONDS = 12 * 60 * 60;

export class DashboardSessions {
  #sessions = new Map<string, number>();

  #cookieId(req: IncomingMessage): string | undefined {
    return req.headers.cookie?.split(';').map((value) => value.trim())
      .find((value) => value.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1);
  }

  has(req: IncomingMessage): boolean {
    const id = this.#cookieId(req);
    return !!id && (this.#sessions.get(id) ?? 0) > Date.now();
  }

  signIn(req: IncomingMessage, res: ServerResponse): void {
    this.#forget(req);
    const now = Date.now();
    for (const [id, expiry] of this.#sessions) if (expiry <= now) this.#sessions.delete(id);
    if (this.#sessions.size >= 128) this.#sessions.delete(this.#sessions.keys().next().value!);
    const id = randomBytes(32).toString('base64url');
    this.#sessions.set(id, now + SESSION_SECONDS * 1000);
    this.#setCookie(req, res, id, SESSION_SECONDS);
  }

  signOut(req: IncomingMessage, res: ServerResponse): void {
    this.#forget(req);
    this.#setCookie(req, res, '', 0);
  }

  #forget(req: IncomingMessage): void {
    const id = this.#cookieId(req);
    if (id) this.#sessions.delete(id);
  }

  #setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number): void {
    const secure = (req.socket as TLSSocket).encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
  }
}

export function serveDashboard(path: string, res: ServerResponse): boolean {
  const asset = assets.get(path);
  if (!asset) return false;
  const [mime, body] = asset;
  res.writeHead(200, {
    'Content-Type': mime + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}
