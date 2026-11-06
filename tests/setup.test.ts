import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookInstalled, installHook } from '../src/claude.ts';
import { loadConfig } from '../src/config.ts';
import { paths } from '../src/paths.ts';
import { runSetup } from '../src/setup.ts';
import { startServer } from '../src/server.ts';

const CLI = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-setup-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function cli(args: string[], extraEnv: Record<string, string> = {}) {
  const { HANDOVER_URL: _u, HANDOVER_TOKEN: _t, HANDOVER_AGENT: _a, ...base } = process.env;
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, HANDOVER_HOME: dir, ...extraEnv } });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stdout += d));
  return new Promise<{ code: number; stdout: string }>((r) => child.on('close', (code) => r({ code: code ?? -1, stdout })));
}

test('scripted relay setup writes a private config with a token', async () => {
  const p = paths(dir);
  const log = console.log;
  console.log = () => {};
  try {
    expect(await runSetup(p, { relay: true, port: 7999, agent: 'box', service: false })).toBe(0);
  } finally {
    console.log = log;
  }
  const config = await loadConfig(p);
  expect(config.relay?.port).toBe(7999);
  expect(config.url).toBe('http://127.0.0.1:7999');
  expect(config.agent).toBe('box');
  expect(config.token?.length).toBeGreaterThanOrEqual(32);
  if (process.platform !== 'win32') expect((await fs.stat(p.config)).mode & 0o777).toBe(0o600);

  // Rerunning keeps the token, so joined machines keep working.
  console.log = () => {};
  try {
    await runSetup(p, { relay: true, service: false });
  } finally {
    console.log = log;
  }
  expect((await loadConfig(p)).token).toBe(config.token!);
});

test('scripted join checks the relay and stores url, token and agent', async () => {
  const { server } = await startServer({ port: 0, host: '127.0.0.1', token: 'secret' });
  const addr = server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    const { code, stdout } = await cli(['setup', '--join', url, '--token', 'secret', '--agent', 'laptop']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('warning');
    const config = await loadConfig(paths(dir));
    expect(config).toMatchObject({ url, token: 'secret', agent: 'laptop' });
    expect(config.relay).toBeUndefined();

    // The CLI now reaches the relay from config alone.
    expect((await cli(['list'])).code).toBe(0);
  } finally {
    server.close();
  }
});

test('scripted peer setup: new secret, kept on rerun, never reuses a joined relay token', async () => {
  const p = paths(dir);
  await fs.writeFile(p.config, JSON.stringify({ url: 'http://10.0.0.5:7777', token: 'relay-token' }));
  const quiet = async (fn: () => Promise<unknown>) => {
    const log = console.log;
    console.log = () => {};
    try {
      await fn();
    } finally {
      console.log = log;
    }
  };
  await quiet(() => runSetup(p, { peer: true, agent: 'desk', service: false }));
  const first = await loadConfig(p);
  expect(first.peer).toBe(true);
  expect(first.token).not.toBe('relay-token');
  expect(first.url).toBe('http://127.0.0.1:7777');

  await quiet(() => runSetup(p, { peer: true, service: false }));
  expect((await loadConfig(p)).token).toBe(first.token!);

  await quiet(() => runSetup(p, { peer: true, token: 'shared', service: false }));
  expect((await loadConfig(p)).token).toBe('shared');
}, 20_000); // each peer setup scans the network for a few seconds

test('join rejects a bad URL and a missing token', async () => {
  expect((await cli(['setup', '--join', 'not a url', '--token', 'x'])).code).toBe(1);
  expect((await cli(['setup', '--join', 'http://127.0.0.1:1'])).code).toBe(1);
});

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

test('--version and token work from config', async () => {
  expect((await cli(['--version'])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  expect((await cli(['token'])).code).toBe(1);
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ token: 'abc' }));
  expect((await cli(['token'])).stdout.trim()).toBe('abc');
});

test('removeHook takes out only this install’s hook and tidies empty sections', async () => {
  const { installHook, removeHook } = await import('../src/claude.ts');
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
  expect(await removeHook(file)).toBe(0);
});
