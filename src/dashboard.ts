import type { ServerResponse } from 'node:http';
import html from './dashboard/index.html' with { type: 'text' };
import css from './dashboard/style.css' with { type: 'text' };
import js from './dashboard/app.js' with { type: 'text' };

const assets = new Map([
  ['/dashboard', ['text/html', html]],
  ['/dashboard/', ['text/html', html]],
  ['/dashboard/style.css', ['text/css', css]],
  ['/dashboard/app.js', ['text/javascript', js]],
]);

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
