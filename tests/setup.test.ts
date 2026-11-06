/**
 * The host / client flow (docs/flow.md). Every run hides the `claude` CLI and
 * hosts use --no-service, so tests never touch the developer's real Claude
 * Code config or login service.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookInstalled, installHook, removeHook } from '../src/claude.ts';
import { loadConfig, roleOf } from '../src/config.ts';
import { paths } from '../src/paths.ts';
import { startServer } from '../src/server.ts';

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let dir: string;
const spawned: ChildProcess[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-setup-'));
});
afterEach(async () => {
  for (const c of spawned.splice(0)) c.kill();
  await Bun.sleep(100);
  await fs.rm(dir, { recursive: true, force: true });
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

/** Runs the CLI with no `claude` on PATH and a private HANDOVER_HOME. */
function start(args: string[], env: Record<string, string> = {}, home = dir) {
  const { HANDOVER_URL: _u, HANDOVER_TOKEN: _t, HANDOVER_AGENT: _a, ...base } = process.env;
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...base, PATH: path.dirname(process.execPath), HANDOVER_HOME: home, ...env },
  });
  spawned.push(child);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const done = new Promise<{ code: number; out: string }>((r) => child.on('close', (code) => r({ code: code ?? -1, out })));
  return { child, done, out: () => out };
}
const cli = (args: string[], env: Record<string, string> = {}, home = dir) => start(args, env, home).done;
const config = (home = dir) => loadConfig(paths(home));

async function relay(token: string) {
  const { server } = await startServer({ port: 0, host: '127.0.0.1', token });
  const addr = server.address();
  return { server, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

// ── host ──

test('host: saves the host role and a token, prints the token and join commands', async () => {
  const { code, out } = await cli(['host', '--agent', 'box', '--port', '7999', '--no-service']);
  expect(code).toBe(0);
  const c = await config();
  expect(c).toMatchObject({ role: 'host', agent: 'box', url: 'http://127.0.0.1:7999', relay: { port: 7999 } });
  expect(c.token!.length).toBeGreaterThanOrEqual(32);
  expect(out).toContain(`Token: ${c.token}`);
  expect(out).toContain(`HANDOVER_TOKEN=${c.token} bash -s -- --join`);
  expect(out).toContain(`$env:HANDOVER_TOKEN='${c.token}'`);
  expect(out).toContain('handover join');
  if (process.platform !== 'win32') expect((await fs.stat(paths(dir).config)).mode & 0o777).toBe(0o600);

  await cli(['host', '--no-service']);
  expect((await config()).token).toBe(c.token!); // rerun keeps the token, so clients keep working
});

test('host: a former client gets its own token, not the one it joined with', async () => {
  await fs.writeFile(paths(dir).config, JSON.stringify({ role: 'client', url: 'http://10.0.0.5:7777', token: 'joined-token' }));
  expect((await cli(['host', '--no-service'])).code).toBe(0);
  const c = await config();
  expect(c.role).toBe('host');
  expect(c.token).not.toBe('joined-token');
  expect(c.discover).toBeUndefined();
});

// ── join ──

test('join URL: asks nothing else, saves the client role, never a relay', async () => {
  const { server, url } = await relay('host-token');
  try {
    const { code, out } = await cli(['join', url, '--agent', 'laptop'], { HANDOVER_TOKEN: 'host-token' });
    expect(code).toBe(0);
    expect(out).toContain(`Joined the host at ${url}`);
    expect(out).not.toContain('HANDOVER_TOKEN='); // a client shares nothing
    const c = await config();
    expect(c).toMatchObject({ role: 'client', url, discover: false, token: 'host-token', agent: 'laptop' });
    expect(c.relay).toBeUndefined();
  } finally {
    server.close();
  }
});

test('join: a wrong token is rejected and nothing is saved', async () => {
  const { server, url } = await relay('host-token');
  try {
    const { code, out } = await cli(['join', url], { HANDOVER_TOKEN: 'wrong' });
    expect(code).toBe(1);
    expect(out).toContain('rejected the token');
    expect(existsSync(paths(dir).config)).toBe(false);
  } finally {
    server.close();
  }
});

test('join: the token never comes from the command line', async () => {
  const onArgv = await cli(['join', 'my-secret-value']);
  expect(onArgv.code).toBe(1);
  expect(onArgv.out).toContain('HANDOVER_TOKEN');
  expect(onArgv.out).not.toContain('my-secret-value');
  const none = await cli(['join']); // not a terminal, no env
  expect(none.code).toBe(1);
  expect(existsSync(paths(dir).config)).toBe(false);
}, 15_000);

// GitHub's macOS runners are VMs that block multicast, so mDNS can't work there.
// Ubuntu CI and real Macs run it.
const noMulticast = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'darwin';

test.skipIf(noMulticast)('join with no URL finds the host on this network (real mDNS)', async () => {
  const hostHome = path.join(dir, 'host');
  const clientHome = path.join(dir, 'client');
  const port = await freePort();
  expect((await cli(['host', '--agent', 'hub', '--port', String(port), '--no-service'], {}, hostHome)).code).toBe(0);
  const { token } = await config(hostHome);
  const host = start(['serve'], {}, hostHome); // announces itself as a host
  for (let i = 0; i < 50 && !host.out().includes('running'); i++) await Bun.sleep(100);

  const { code, out } = await cli(['join', '--agent', 'laptop'], { HANDOVER_TOKEN: token! }, clientHome);
  expect(code).toBe(0);
  expect(out).toContain('Found host hub');
  const c = await config(clientHome);
  expect(c).toMatchObject({ role: 'client', discover: true, token });
  expect(c.url).toEndWith(`:${port}`);
  // The client works against the host it found.
  expect((await cli(['list'], {}, clientHome)).code).toBe(0);
}, 30_000);

test('a client never runs a relay and has nothing to share', async () => {
  await fs.writeFile(paths(dir).config, JSON.stringify({ role: 'client', url: 'http://10.0.0.5:7777', token: 't' }));
  const serve = await cli(['serve']);
  expect(serve.code).toBe(1);
  expect(serve.out).toContain('client');
  const link = await cli(['link']);
  expect(link.code).toBe(1);
  expect(link.out).toContain('run handover link on the host');
});

// ── old flags (docs/flow.md, Compatibility) ──

test('old flags map onto host and join', async () => {
  expect((await cli(['setup', '--relay', '--no-service'])).code).toBe(0);
  expect((await config()).role).toBe('host');
  await fs.rm(paths(dir).config);
  expect((await cli(['setup', '--peer', '--no-service'])).code).toBe(0); // first machine: host
  expect((await config()).role).toBe('host');

  const { server, url } = await relay('host-token');
  try {
    expect((await cli(['setup', '--join', url], { HANDOVER_TOKEN: 'host-token' })).code).toBe(0);
    expect(await config()).toMatchObject({ role: 'client', url });
  } finally {
    server.close();
  }
});

test('pre-0.7 configs keep their role: relay/peer → host, joined url → client', () => {
  expect(roleOf({ relay: { port: 1 } })).toBe('host');
  expect(roleOf({ peer: true })).toBe('host');
  expect(roleOf({ url: 'http://x:1', token: 't' })).toBe('client');
  expect(roleOf({})).toBeUndefined();
});

// ── Claude Code hook ──

test('installHook adds the SessionStart hook once and keeps other settings', async () => {
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  expect(await hookInstalled(file)).toBe(false);
  expect(await installHook(file)).toBe('added');
  expect(await installHook(file)).toBe('present');
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(settings.model).toBe('opus');
  expect(settings.hooks.Stop).toHaveLength(1);
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.SessionStart[0].hooks[0].command).toMatch(/ hook$/);
});

test('removeHook takes out only this install’s hook and tidies empty sections', async () => {
  const file = path.join(dir, 'settings.json');
  const other = { hooks: [{ type: 'command', command: '/somewhere/else/handover hook' }] };
  await fs.writeFile(file, JSON.stringify({ model: 'opus', hooks: { SessionStart: [other], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  await installHook(file); // already "present" via the other install's hook
  expect(await removeHook(file)).toBe(0); // never removes another install's hook

  await fs.writeFile(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  await installHook(file);
  expect(await removeHook(file)).toBe(1);
  const settings = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(settings.model).toBe('opus');
  expect(settings.hooks.SessionStart).toBeUndefined();
  expect(settings.hooks.Stop).toHaveLength(1);
});

test('--version and token work from config', async () => {
  expect((await cli(['--version'])).out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  expect((await cli(['token'])).code).toBe(1);
  await fs.writeFile(paths(dir).config, JSON.stringify({ token: 'abc' }));
  expect((await cli(['token'])).out.trim()).toBe('abc');
});
