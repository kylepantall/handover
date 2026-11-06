import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appRoot, compiled, isWindows, writePrivate } from './paths.ts';
import { runProcess } from './process.ts';

/** argv that runs this install's CLI with `sub` (the launcher when installed). */
export function selfCommand(...sub: string[]): string[] {
  if (compiled) return [process.execPath, ...sub];
  const launcher = process.env.HANDOVER_LAUNCHER;
  if (launcher) return [launcher, ...sub];
  return [process.execPath, join(appRoot, 'src', 'index.ts'), ...sub];
}

/**
 * Quotes one word of a hook command. Claude Code runs hooks through a shell:
 * sh on macOS/Linux, and on Windows Git Bash or cmd, where only double quotes
 * work in both (and forward slashes avoid backslash escapes).
 */
const shellQuote = (s: string): string => {
  if (isWindows) return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/\\/g, '/')}"`;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
};

export async function claudeRegistration(): Promise<'registered' | 'missing' | 'no-claude'> {
  const claude = Bun.which('claude');
  if (!claude) return 'no-claude';
  const result = await runProcess(claude, ['mcp', 'get', 'handover'], { timeoutMs: 20_000 }).catch(() => null);
  return result?.code === 0 ? 'registered' : 'missing';
}

export async function registerWithClaude(): Promise<void> {
  const claude = Bun.which('claude');
  if (!claude) throw new Error('claude CLI not found.');
  const result = await runProcess(
    claude,
    ['mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'handover', '--', ...selfCommand('mcp')],
    { timeoutMs: 30_000 }
  );
  if (result.code !== 0) throw new Error(`claude mcp add failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

// --- SessionStart hook in ~/.claude/settings.json ---

interface HookEntry {
  type?: string;
  command?: string;
}
interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: HookEntry[] }>>;
  [key: string]: unknown;
}

export function claudeSettingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
}

async function readSettings(file: string): Promise<Settings> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`could not read ${file}: ${(err as Error).message}`);
  }
}

const hookCommand = () => selfCommand('hook').map(shellQuote).join(' ');

/** This install's hook, or any `…/handover hook` (e.g. from an earlier install path). */
const isOurHook = (h: HookEntry) => {
  const command = typeof h.command === 'string' ? h.command.trim() : '';
  return command === hookCommand() || /(^|[/\\\s'"])handover(\.exe)?['"]? hook$/i.test(command);
};

export async function hookInstalled(file = claudeSettingsPath()): Promise<boolean> {
  const settings = await readSettings(file);
  return (settings.hooks?.SessionStart ?? []).some((group) => (group.hooks ?? []).some(isOurHook));
}

/** Adds `handover hook` as a SessionStart hook, leaving every other setting as it was. */
export async function installHook(file = claudeSettingsPath()): Promise<'added' | 'present'> {
  if (await hookInstalled(file)) return 'present';
  const settings = await readSettings(file);
  const command = hookCommand();
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command }] });
  await writePrivate(file, JSON.stringify(settings, null, 2) + '\n');
  return 'added';
}

/** Removes this install's SessionStart hook (exactly its command), leaving everything else. Returns how many were removed. */
export async function removeHook(file = claudeSettingsPath()): Promise<number> {
  const settings = await readSettings(file);
  const groups = settings.hooks?.SessionStart;
  if (!groups?.length) return 0;
  const command = hookCommand();
  let removed = 0;
  for (const group of groups) {
    const before = group.hooks?.length ?? 0;
    group.hooks = (group.hooks ?? []).filter((h) => (typeof h.command === 'string' ? h.command.trim() : '') !== command);
    removed += before - group.hooks.length;
  }
  if (!removed) return 0;
  const kept = groups.filter((g) => g.hooks?.length);
  if (kept.length) settings.hooks!.SessionStart = kept;
  else delete settings.hooks!.SessionStart;
  if (!Object.keys(settings.hooks!).length) delete settings.hooks;
  await writePrivate(file, JSON.stringify(settings, null, 2) + '\n');
  return removed;
}

/** Removes the "handover" MCP server if it points at this install. */
export async function unregisterFromClaude(): Promise<'removed' | 'not-registered' | 'other-install' | 'no-claude'> {
  const claude = Bun.which('claude');
  if (!claude) return 'no-claude';
  const current = await runProcess(claude, ['mcp', 'get', 'handover'], { timeoutMs: 20_000 }).catch(() => null);
  if (!current || current.code !== 0) return 'not-registered';
  const [exe] = selfCommand();
  if (!current.stdout.includes(exe!)) return 'other-install';
  const result = await runProcess(claude, ['mcp', 'remove', 'handover', '--scope', 'user'], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`claude mcp remove failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return 'removed';
}
