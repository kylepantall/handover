/**
 * Coding agents handover wires up: each adapter registers handover's MCP
 * server with the agent's CLI and knows how to run one task headless (the
 * briefing on stdin). HANDOVER_AGENT_PATH replaces PATH when looking for the
 * agents' CLIs (tests use it to supply fakes).
 */

import { selfCommand } from './claude.ts';
import { runProcess } from './process.ts';
import { AGENT_KINDS, type AgentKind, type AutoPickup } from './types.ts';

export type McpState = 'registered' | 'missing' | 'not-installed';
export type UnlinkResult = 'removed' | 'not-registered' | 'other-install' | 'not-installed';

export interface Adapter {
  kind: AgentKind;
  label: string;
  /** Path of the agent's CLI, if installed. */
  bin(): string | undefined;
  mcpState(): Promise<McpState>;
  register(): Promise<void>;
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
  return {
    kind,
    label,
    bin,
    async mcpState() {
      const cli = bin();
      if (!cli) return 'not-installed';
      return (await get(cli))?.code === 0 ? 'registered' : 'missing';
    },
    async register() {
      const cli = bin();
      if (!cli) throw new Error(`${kind} CLI not found`);
      const r = await runProcess(cli, ['mcp', 'add', ...add, 'handover', '--', ...selfCommand('mcp')], { timeoutMs: 30_000 });
      if (r.code !== 0) throw failure(`${kind} mcp add`, r);
    },
    async unregister() {
      const cli = bin();
      if (!cli) return 'not-installed';
      const current = await get(cli);
      if (!current || current.code !== 0) return 'not-registered';
      const [exe] = selfCommand();
      if (!current.stdout.includes(exe!)) return 'other-install';
      const r = await runProcess(cli, ['mcp', 'remove', 'handover', ...remove], { timeoutMs: 30_000 });
      if (r.code !== 0) throw failure(`${kind} mcp remove`, r);
      return 'removed';
    },
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
    // "-": read the prompt from stdin. Otherwise Codex's own sandbox and approval settings apply.
    exec: (full) => ['exec', '--skip-git-repo-check', ...(full ? ['--dangerously-bypass-approvals-and-sandbox'] : []), '-'],
  }),
};

/** Agents whose CLI is installed here. */
export const installedAgents = (): Adapter[] => AGENT_KINDS.map((k) => ADAPTERS[k]).filter((a) => a.bin());

export function parseAgentKind(value: string, flag: string): AgentKind {
  if ((AGENT_KINDS as readonly string[]).includes(value)) return value as AgentKind;
  throw new Error(`${flag} must be ${AGENT_KINDS.join(' or ')}`);
}

/** What auto-pickup does here, e.g. "Codex, with your usual permission settings; runs at login". */
export function autoSummary(auto: AutoPickup | undefined, atLogin: boolean): string {
  if (!auto) return 'off (turn on with handover auto claude|codex)';
  const how = auto.fullAccess ? '⚠️ full access (no permission prompts or sandbox)' : 'with your usual permission settings';
  return `${ADAPTERS[auto.with].label}, ${how}; ${atLogin ? 'runs at login' : 'runs while Claude Code or Codex is open'}`;
}

export const describeAuto = (auto: AutoPickup | undefined, atLogin: boolean) => `Auto-pickup: ${autoSummary(auto, atLogin)}`;
