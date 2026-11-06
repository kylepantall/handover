import { afterEach, beforeEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replaceFile, replaceFileSync } from '../src/paths.ts';

let dir: string;
let temp: string;
let target: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-paths-'));
  temp = path.join(dir, 'config.json.tmp');
  target = path.join(dir, 'config.json');
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(temp, 'new');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const locked = (times: number) => {
  let calls = 0;
  const fail = () => Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  return {
    sync: (a: string, b: string) => {
      if (calls++ < times) throw fail();
      fs.renameSync(a, b);
    },
    async: async (a: string, b: string) => {
      if (calls++ < times) throw fail();
      fs.renameSync(a, b);
    },
    calls: () => calls,
  };
};

test('a briefly locked target (antivirus scan) is retried until the rename succeeds', async () => {
  const s = locked(3);
  replaceFileSync(temp, target, { renameImpl: s.sync });
  expect(fs.readFileSync(target, 'utf8')).toBe('new');
  expect(s.calls()).toBe(4);

  fs.writeFileSync(temp, 'newer');
  const a = locked(2);
  await replaceFile(temp, target, { renameImpl: a.async });
  expect(fs.readFileSync(target, 'utf8')).toBe('newer');
});

test('a target that stays locked is written by copying, and the temp file is removed', async () => {
  replaceFileSync(temp, target, { renameImpl: locked(Infinity).sync, retryMs: 50 });
  expect(fs.readFileSync(target, 'utf8')).toBe('new');
  expect(fs.existsSync(temp)).toBe(false);

  fs.writeFileSync(temp, 'newer');
  await replaceFile(temp, target, { renameImpl: locked(Infinity).async, retryMs: 50 });
  expect(fs.readFileSync(target, 'utf8')).toBe('newer');
  expect(fs.existsSync(temp)).toBe(false);
});

test('other errors are not retried', () => {
  const missing = path.join(dir, 'nope.tmp');
  expect(() => replaceFileSync(missing, target)).toThrow();
  expect(fs.readFileSync(target, 'utf8')).toBe('old');
});
