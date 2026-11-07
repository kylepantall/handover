/**
 * Coding agents handover wires up: each adapter registers handover's MCP
 * server with the agent's CLI and knows how to run one task headless (the
 * briefing on stdin). HANDOVER_AGENT_PATH replaces PATH when looking for the
 * agents' CLIs (tests use it to supply fakes).
 */

import { selfCommand } from './claude.ts';
import { runProcess } from './process.ts';
import { AGENT_KINDS, type AgentKind, type AgentSettings, type Config } from './types.ts';

/** 'outdated': registered by this install before agents had their own address (no `--as`). */
export type McpState = 'registered' | 'outdated' | 'missing' | 'not-installed';
export type UnlinkResult = 'removed' | 'not-registered' | 'other-install' | 'not-installed';

export interface Adapter {
  kind: AgentKind;
  label: string;
  /** Path of the agent's CLI, if installed. */
  bin(): string | undefined;
  mcpState(): Promise<McpState>;
  /** Adds the MCP server; pass the state mcpState() just returned to skip asking again. */
  register(state?: McpState): Promise<void>;
  /** Removes the "handover" MCP server if it points at this install. */
  unregister(): Promise<UnlinkResult>;
  /** argv running one task unattended, prompt on stdin. */
  execArgv(fullAccess: boolean): string[];
}

const which = (cmd: string) => Bun.which(cmd, process.env.HANDOVER_AGENT_PATH ? { PATH: process.env.HANDOVER_AGENT_PATH } : undefined) ?? undefined;
const failure = (what: string, r: { stdout: string; stderr: string }) => new Error(`${what} failed: ${r.stderr.trim() || r.stdout.trim()}`);

/** An adapter for a CLI with `mcp get|add|remove <name>` subcommands. */
function adapter(
  kind: AgentKind,
  label: string,
  { add, remove, exec }: { add: string[]; remove: string[]; exec: (full: boolean) => string[] }
): Adapter {
  const bin = () => which(kind);
  const get = async (cli: string) => runProcess(cli, ['mcp', 'get', 'handover'], { timeoutMs: 20_000 }).catch(() => null);
  const mcpState = async (): Promise<McpState> => {
    const cli = bin();
    if (!cli) return 'not-installed';
    const r = await get(cli);
    if (r?.code !== 0) return 'missing';
    return r.stdout.includes(selfCommand()[0]!) && !r.stdout.includes(`--as ${kind}`) ? 'outdated' : 'registered';
  };
  const unregister = async (): Promise<UnlinkResult> => {
    const cli = bin();
    if (!cli) return 'not-installed';
    const current = await get(cli);
    if (!current || current.code !== 0) return 'not-registered';
    const [exe] = selfCommand();
    if (!current.stdout.includes(exe!)) return 'other-install';
    const r = await runProcess(cli, ['mcp', 'remove', 'handover', ...remove], { timeoutMs: 30_000 });
    if (r.code !== 0) throw failure(`${kind} mcp remove`, r);
    return 'removed';
  };
  return {
    kind,
    label,
    bin,
    mcpState,
    async register(state) {
      const cli = bin();
      if (!cli) throw new Error(`${kind} CLI not found`);
      // Replace an outdated entry of ours; never another install's.
      if ((state ?? (await mcpState())) === 'outdated') await unregister();
      // --as: the MCP server claims tasks as kind@machine (e.g. codex@pc).
      const r = await runProcess(cli, ['mcp', 'add', ...add, 'handover', '--', ...selfCommand('mcp', '--as', kind)], { timeoutMs: 30_000 });
      if (r.code !== 0) throw failure(`${kind} mcp add`, r);
    },
    unregister,
    execArgv: (full) => [bin() ?? kind, ...exec(full)],
  };
}

export const ADAPTERS: Record<AgentKind, Adapter> = {
  claude: adapter('claude', 'Claude Code', {
    add: ['--transport', 'stdio', '--scope', 'user'],
    remove: ['--scope', 'user'],
    // Handover's own tools are allowed so the agent can complete with files;
    // anything else follows the user's Claude Code permission settings.
    // --allowedTools is variadic, so it goes last (the prompt comes on stdin).
    exec: (full) => ['-p', ...(full ? ['--dangerously-skip-permissions'] : []), '--allowedTools', 'mcp__handover'],
  }),
  codex: adapter('codex', 'Codex', {
    add: [],
    remove: [],
    // Unattended Codex can't answer approvals, so handover's own tools are
    // approved up front (as for Claude), and it may write in the task's own
    // folder (its working directory) but nowhere else, with no network.
    // The -c value has no quotes: Codex reads a value that isn't TOML as a
    // string, and quotes would not survive cmd on Windows. "-": prompt on stdin.
    exec: (full) => [
      'exec',
      '--skip-git-repo-check',
      '-c',
      'mcp_servers.handover.default_tools_approval_mode=approve',
      ...(full ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write']),
      '-',
    ],
  }),
};

/** Agents whose CLI is installed here. */
export const installedAgents = (): Adapter[] => AGENT_KINDS.map((k) => ADAPTERS[k]).filter((a) => a.bin());

export function parseAgentKind(value: string, flag: string): AgentKind {
  if ((AGENT_KINDS as readonly string[]).includes(value)) return value as AgentKind;
  throw new Error(`${flag} must be ${AGENT_KINDS.join(' or ')}`);
}

/** `claude`, `codex`, `claude,codex` or `both` → agent kinds. */
export function parseAgentKinds(value: string, flag: string): AgentKind[] {
  const parts = value === 'both' ? [...AGENT_KINDS] : value.split(',').map((v) => v.trim()).filter(Boolean);
  if (!parts.length) throw new Error(`${flag} needs ${AGENT_KINDS.join(', ')} or both`);
  return [...new Set(parts.map((v) => parseAgentKind(v, flag)))];
}

/** Per-agent settings, reading the 0.9–0.10 `auto` field ({ with, fullAccess }). */
export function agentSettings(config: Config): AgentSettings {
  if (config.agents) return config.agents;
  const legacy = config.auto;
  if (!legacy) return {};
  const kinds = Array.isArray(legacy.with) ? legacy.with : [legacy.with];
  return Object.fromEntries(kinds.map((k) => [k, { auto: true, ...(legacy.fullAccess ? { fullAccess: true } : {}) }]));
}

/** The agents that take handovers automatically here. */
export const autoKinds = (config: Config): AgentKind[] => AGENT_KINDS.filter((k) => agentSettings(config)[k]?.auto === true);
export const fullAccessFor = (config: Config, kind: AgentKind): boolean => agentSettings(config)[kind]?.fullAccess === true;

/** The config with these settings (written as `agents`; the old `auto` field is dropped). */
export function withAgentSettings(config: Config, settings: AgentSettings): Config {
  const { auto: _legacy, agents: _old, ...rest } = config;
  const agents: AgentSettings = {};
  for (const k of AGENT_KINDS) {
    const s = settings[k];
    if (s?.auto || s?.fullAccess) agents[k] = { ...(s.auto ? { auto: true } : {}), ...(s.fullAccess ? { fullAccess: true } : {}) };
  }
  return Object.keys(agents).length ? { ...rest, agents } : rest;
}

/** What auto-pickup does here, e.g. "Codex (⚠️ full access) and Claude Code; runs at login". */
export function autoSummary(config: Config, atLogin: boolean): string {
  const kinds = autoKinds(config);
  if (!kinds.length) return 'off (turn on with handover agents all on)';
  const each = kinds.map((k) => `${ADAPTERS[k].label}${fullAccessFor(config, k) ? ' (⚠️ full access)' : ''}`).join(' and ');
  return `${each}; ${atLogin ? 'runs at login' : 'runs while Claude Code or Codex is open'}`;
}

export const describeAuto = (config: Config, atLogin: boolean) => `Auto-pickup: ${autoSummary(config, atLogin)}`;
