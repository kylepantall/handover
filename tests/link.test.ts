import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostUrl } from '../src/connect.ts';
import { loadConfig } from '../src/config.ts';
import { formatLink, linkInfo } from '../src/link.ts';
import { paths } from '../src/paths.ts';

const host = { role: 'host' as const, token: 'sec-ret', url: 'http://127.0.0.1:7777', relay: { port: 7777 } };

test('host link: token plus join commands with no URL (clients find the host)', () => {
  const info = linkInfo(host);
  expect(info.unix).toEndWith('install.sh | HANDOVER_TOKEN=sec-ret bash -s -- --join');
  expect(info.windows).toStartWith("$env:HANDOVER_TOKEN='sec-ret'; & ([scriptblock]::Create((irm ");
  expect(info.windows).toEndWith('install.ps1))) -Join');
  expect(info.installed).toBe('handover join');
  const text = formatLink(info);
  expect(text).toContain('Token: sec-ret');
  expect(text).toContain('macOS / Linux');
  expect(text).toContain('Windows (PowerShell)');
  expect(text).toContain(`--join ${info.lanUrl}`); // fallback when discovery is blocked
});

test('the token is never a command-line argument (antivirus logs and process lists record those)', () => {
  const info = linkInfo(host);
  expect(info.unix).not.toContain('--token');
  expect(info.windows).not.toContain('-Token');
});

test('a host with a tunnel puts its public URL in the join commands', () => {
  const info = linkInfo({ ...host, url: 'https://hub.example.ts.net', relay: { port: 7777, tunnel: 'tailscale' } });
  expect(info.unix).toEndWith('--join https://hub.example.ts.net');
  expect(info.windows).toEndWith("-Join -Url 'https://hub.example.ts.net'");
  expect(info.installed).toBe('handover join https://hub.example.ts.net');
});

test('tokens are quoted safely for each shell', () => {
  const info = linkInfo({ ...host, token: "it's" });
  expect(info.unix).toContain(`HANDOVER_TOKEN='it'\\''s'`);
  expect(info.windows).toContain(`$env:HANDOVER_TOKEN='it''s'`);
});

test('only a host has a link', () => {
  expect(() => linkInfo({ role: 'client', url: 'http://10.0.0.2:7777', token: 't' })).toThrow('on the host');
  expect(() => linkInfo({})).toThrow();
});

test('a discovered client finds its host again when the stored URL stops answering', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-link-'));
  try {
    const p = paths(dir);
    const moved = { agent: 'hub', url: 'http://127.0.0.1:9' };
    let lookups = 0;
    const find = async () => (lookups++, moved);

    const dead = { role: 'client' as const, discover: true, url: 'http://127.0.0.1:1', token: 't' };
    expect(await hostUrl(p, dead, find)).toBe(moved.url);
    expect((await loadConfig(p)).url).toBe(moved.url); // remembered

    // Joined with an explicit URL: never rediscovers.
    expect(await hostUrl(p, { ...dead, discover: false }, find)).toBe(dead.url);
    expect(lookups).toBe(1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
