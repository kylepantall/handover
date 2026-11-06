import { randomBytes } from 'node:crypto';
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Replaced with `true` by `bun build --define` (scripts/build-windows.ps1); never set at runtime. */
declare const HANDOVER_COMPILED: boolean | undefined;

/** True inside the compiled release executable (handover.exe), whose sources live in Bun's virtual file system. */
export const compiled = typeof HANDOVER_COMPILED !== 'undefined' && HANDOVER_COMPILED === true;

/** Root of this checkout or install. For the compiled release, the folder holding handover.exe. */
export const appRoot = compiled ? dirname(process.execPath) : fileURLToPath(new URL('..', import.meta.url));

export const REPO = process.env.HANDOVER_REPO ?? 'kylepantall/handover';

export const isWindows = process.platform === 'win32';

/**
 * Full paths to Windows system programs. Windows searches the working
 * directory before PATH, so a bare `schtasks.exe` could run a planted copy.
 */
export function windowsSystem(program: 'schtasks.exe' | 'tar.exe'): string {
  return win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', program);
}

export function dataDir(): string {
  if (process.env.HANDOVER_HOME) return process.env.HANDOVER_HOME;
  if (isWindows) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'handover');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'handover');
}

export interface Paths {
  dir: string;
  config: string;
  tasks: string;
  log: string;
}

export function paths(dir = dataDir()): Paths {
  return {
    dir,
    config: join(dir, 'config.json'),
    tasks: join(dir, 'tasks.json'),
    log: join(dir, 'relay.log'),
  };
}

/**
 * On Windows, replacing a file fails (EPERM/EACCES/EBUSY) while another process
 * has it open, typically antivirus scanning the file just written. Retry for a
 * moment, as graceful-fs does.
 */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MS = 3_000;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** rename(temp, file), retried while the target is locked; finally copies over it instead. */
export function replaceFileSync(
  temp: string,
  file: string,
  { renameImpl = renameSync as (from: string, to: string) => void, retryMs = RENAME_RETRY_MS } = {}
): void {
  const end = Date.now() + retryMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      return renameImpl(temp, file);
    } catch (err) {
      if (!RETRYABLE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      if (Date.now() >= end) break;
      sleepSync(wait);
    }
  }
  // Still locked: not atomic, but the content lands. Copying works where replacing a
  // locked file does not when the lock allows writes (scanners usually do).
  copyFileSync(temp, file);
  rmSync(temp, { force: true });
}

export async function replaceFile(
  temp: string,
  file: string,
  { renameImpl = rename as (from: string, to: string) => Promise<void>, retryMs = RENAME_RETRY_MS } = {}
): Promise<void> {
  const end = Date.now() + retryMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 250)) {
    try {
      return await renameImpl(temp, file);
    } catch (err) {
      if (!RETRYABLE.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      if (Date.now() >= end) break;
      await Bun.sleep(wait);
    }
  }
  copyFileSync(temp, file);
  rmSync(temp, { force: true });
}

/** Writes owner-only, via a temp file and rename so readers never see a partial file. */
export async function writePrivate(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await replaceFile(temp, file);
}
