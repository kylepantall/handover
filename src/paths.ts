import { randomBytes } from 'node:crypto';
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
export function windowsSystem(program: 'schtasks.exe' | 'tar.exe' | 'conhost.exe'): string {
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

/** Writes owner-only, via a temp file and rename so readers never see a partial file. */
export async function writePrivate(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temp, contents, { mode: 0o600 });
  await rename(temp, file);
}
