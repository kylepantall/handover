/**
 * `handover update [--check] [--ref <branch|tag>] [--force]`: compare with the
 * version on GitHub and rerun the installer for it. Config and the queue in the
 * data directory are never touched.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from './paths.ts';
import { VERSION } from './version.ts';

const REF = /^[A-Za-z0-9._/-]+$/;

const raw = (ref: string, path: string) => `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.text();
}

/** Resolves a branch or tag to its commit, so a cached branch URL can't serve a stale file. */
export async function resolveRef(ref: string): Promise<string> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/commits/${ref}`, {
      headers: { Accept: 'application/vnd.github.sha' },
      signal: AbortSignal.timeout(10_000),
    });
    const sha = response.ok ? (await response.text()).trim() : '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : ref;
  } catch {
    return ref; // rate-limited or offline
  }
}

export async function latestVersion(ref: string): Promise<string> {
  const pkg = JSON.parse(await fetchText(raw(ref, 'package.json'))) as { version?: string };
  if (!pkg.version) throw new Error('package.json on GitHub has no version.');
  return pkg.version;
}

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export async function runUpdate({ check = false, force = false, ref = 'main' }: { check?: boolean; force?: boolean; ref?: string }): Promise<number> {
  if (!REF.test(ref) || ref.includes('..')) throw new Error(`Invalid ref: ${ref}`);
  const commit = await resolveRef(ref);
  const latest = await latestVersion(commit);
  const diff = compareVersions(latest, VERSION);
  console.log(`Installed ${VERSION}; ${REPO}@${ref} has ${latest}.`);
  if (check) return diff > 0 ? 10 : 0;
  if (diff <= 0 && !force) {
    console.log(diff === 0 ? 'Already up to date.' : 'Installed version is newer; use --force to install it anyway.');
    return 0;
  }
  if (!process.env.HANDOVER_LAUNCHER) throw new Error('This copy was not installed by the installer; update it with git pull.');

  const dir = await mkdtemp(join(tmpdir(), 'handover-update-'));
  try {
    const script = join(dir, 'install.sh');
    // Install exactly the commit that was checked.
    await writeFile(script, await fetchText(raw(commit, 'scripts/install.sh')));
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn('bash', [script, '--no-setup', commit], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', (status) => resolve(status ?? 1));
    });
    if (code === 0) console.log(`Updated to ${latest}. Restart Claude Code (and the relay: handover service restart) to load it.`);
    return code;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
