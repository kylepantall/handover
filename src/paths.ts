import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of this checkout or install. */
export const appRoot = fileURLToPath(new URL('..', import.meta.url));

export const REPO = process.env.HANDOVER_REPO ?? 'kylepantall/handover';

export function dataDir(): string {
  if (process.env.HANDOVER_HOME) return process.env.HANDOVER_HOME;
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
