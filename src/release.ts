/**
 * Windows installs come from GitHub Releases: a zip holding handover.exe (Bun
 * compiled), built by .github/workflows/release.yml and listed with its SHA-256
 * in SHA256SUMS. No PowerShell runs at runtime.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { appRoot, REPO, windowsSystem } from './paths.ts';
import { runProcess } from './process.ts';

export const WINDOWS_ASSET = 'handover-windows-x64.zip';
/** Written by install.ps1 into the app folder. */
export const INSTALL_MARKER = '.handover-install';

export const releaseUrl = (version: string, file: string) => `https://github.com/${REPO}/releases/download/v${version}/${file}`;

/** The hash SHA256SUMS lists for `file` (`<hash>  <file>` or `<hash> *<file>`). */
export function expectedSum(sums: string, file: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === file) return match[1]!.toLowerCase();
  }
  return undefined;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (response.status === 404) throw new Error(`${url} is not published yet. Try again in a few minutes.`);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Replaces this install's files with release `version`. A running exe can be
 * renamed but not overwritten, so each file moves aside to `.old` first; any
 * failure puts the old files back.
 */
export async function installWindowsRelease(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version on GitHub: ${version}`);
  // Only an install the installer made: never rewrite a folder handover.exe was merely copied into.
  if (!existsSync(join(appRoot, INSTALL_MARKER)))
    throw new Error('This handover.exe was not installed by the installer; reinstall it with install.ps1.');
  const sums = (await download(releaseUrl(version, 'SHA256SUMS'))).toString('utf8');
  const expected = expectedSum(sums, WINDOWS_ASSET);
  if (!expected) throw new Error(`SHA256SUMS for v${version} does not list ${WINDOWS_ASSET}.`);
  const zip = await download(releaseUrl(version, WINDOWS_ASSET));
  if (createHash('sha256').update(zip).digest('hex') !== expected) throw new Error('Downloaded release failed its checksum.');

  const staging = join(appRoot, '.update');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const archive = join(staging, WINDOWS_ASSET);
    await writeFile(archive, zip);
    const unpacked = join(staging, 'files');
    await mkdir(unpacked);
    // Windows' own tar.exe reads zip files and refuses paths outside the target.
    const tar = await runProcess(windowsSystem('tar.exe'), ['-xf', archive, '-C', unpacked], { timeoutMs: 120_000 });
    if (tar.code !== 0) throw new Error(`Could not unpack the release: ${tar.stderr.trim()}`);
    if (!existsSync(join(unpacked, 'handover.exe'))) throw new Error('The release is missing handover.exe.');

    // Leftovers from earlier updates; one may still be running (an older relay or MCP server), so skip those.
    for (const old of (await listFiles(appRoot)).filter((f) => f.endsWith('.old') && !f.startsWith(staging)))
      await rm(old, { force: true }).catch(() => undefined);

    const moved: { target: string; aside: string }[] = [];
    try {
      for (const source of await listFiles(unpacked)) {
        const target = join(appRoot, relative(unpacked, source));
        await mkdir(dirname(target), { recursive: true });
        if (existsSync(target)) {
          await rm(`${target}.old`, { force: true }).catch(() => undefined);
          const aside = existsSync(`${target}.old`) ? `${target}.${Date.now()}.old` : `${target}.old`;
          await rename(target, aside);
          moved.push({ target, aside });
        }
        await rename(source, target);
      }
    } catch (error) {
      for (const { target, aside } of moved.reverse()) {
        await rm(target, { force: true }).catch(() => undefined);
        await rename(aside, target).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
