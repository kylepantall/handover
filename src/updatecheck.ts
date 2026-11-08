/**
 * Tells people a newer release exists. The answer is cached for a few hours, so
 * most starts make no network call, and a refresh can only delay a start by
 * REFRESH_MS. Never fails: offline just means no notice.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { REPO, writePrivate, type Paths } from './paths.ts';
import { compareVersions } from './update.ts';
import { VERSION } from './version.ts';

export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const REFRESH_MS = 1500;

interface Cache {
  checkedAt: number;
  latest: string | null;
}

async function latestRelease(): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(REFRESH_MS),
  });
  if (!response.ok) throw new Error(`releases returned ${response.status}`);
  const { tag_name: tag } = (await response.json()) as { tag_name?: string };
  if (!tag) throw new Error('release has no tag');
  return tag.replace(/^v/, '');
}

/** The notice, if the newest known release is ahead of `current`. `fetchLatest` and `now` are for tests. */
export async function checkForUpdate(
  p: Paths,
  { fetchLatest = latestRelease, now = Date.now(), current = VERSION }: { fetchLatest?: () => Promise<string>; now?: number; current?: string } = {}
): Promise<string | null> {
  try {
    const file = path.join(p.dir, 'update-check.json');
    let cache: Cache | null = null;
    try {
      cache = JSON.parse(await readFile(file, 'utf8')) as Cache;
    } catch {
      // first check, or an unreadable cache
    }
    let latest = cache?.latest ?? null;
    if (!cache || now - cache.checkedAt >= CHECK_EVERY_MS) {
      latest = await fetchLatest().catch(() => latest);
      // Recorded even after a failure, so an offline machine doesn't wait on every start.
      await writePrivate(file, JSON.stringify({ checkedAt: now, latest } satisfies Cache) + '\n');
    }
    return latest && compareVersions(latest, current) > 0 ? `handover ${latest} is available (you have ${current}). To update: handover update` : null;
  } catch {
    return null;
  }
}

/** checkForUpdate, unless turned off (HANDOVER_NO_UPDATE_CHECK) or under test. */
export async function updateNotice(p: Paths): Promise<string | null> {
  if (process.env.HANDOVER_NO_UPDATE_CHECK || process.env.NODE_ENV === 'test') return null;
  return checkForUpdate(p);
}
