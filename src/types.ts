export const STATUS = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
export type TaskStatus = (typeof STATUS)[keyof typeof STATUS];
export const TASK_STATUSES = Object.values(STATUS);

export const FAILURE = { LEASE_EXPIRED: 'lease_expired' } as const;
export type FailureReason = (typeof FAILURE)[keyof typeof FAILURE];

export type FileEncoding = 'utf8' | 'base64';

export interface TaskFile {
  name: string;
  encoding: FileEncoding;
  content: string;
}

export interface Task {
  id: string;
  seq: number;
  objective: string;
  context: string;
  from: string | null;
  to: string | null;
  priority: number;
  status: TaskStatus;
  claimedBy: string | null;
  attempts: number;
  leaseExpiresAt: string | null;
  failureReason: FailureReason | null;
  output: string | null;
  files: TaskFile[];
  createdAt: string;
  updatedAt: string;
  /** Peer mode: agent name of the peer holding this task (set by the client, not stored). */
  peer?: string;
  /** 'ping': a connectivity check answered by handover itself, never shown to agents. */
  kind?: TaskKind;
}

export const TASK_KINDS = ['task', 'ping'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export type TaskSummary = Omit<Task, 'context' | 'output' | 'files' | 'seq'> & { fileCount: number };

export interface CreateInput {
  id?: string;
  objective: string;
  context?: string;
  from?: string | null;
  to?: string | null;
  priority?: number | string;
  kind?: TaskKind;
}

export interface ListFilter {
  status?: TaskStatus;
  /** Only tasks this agent may claim (unaddressed or addressed to it). */
  agent?: string;
  /** Default 'task': pings are only for handover's own responders. */
  kind?: TaskKind;
}

export interface ClaimOptions {
  by?: string | null;
  leaseMs?: number;
  /** claimNext only; default 'task'. */
  kind?: TaskKind;
}

/** A handover process that checked in with the host recently. */
export interface AgentPresence {
  agent: string;
  version: string;
  platform: string;
  /** What is running there: relay, mcp, worker, listen, test. */
  via: string[];
  lastSeen: string;
}

export interface Heartbeat {
  agent: string;
  version: string;
  platform: string;
  via: string;
}

export interface CompleteInput {
  status?: 'success' | 'failed';
  output?: string;
  files?: Array<{ name: string; content: string; encoding?: FileEncoding }>;
}

/** What MCP tools and the CLI need from a relay, in-process or over HTTP. */
export interface Api {
  create(input: CreateInput): Promise<Task>;
  list(filter?: ListFilter): Promise<Array<Task | TaskSummary>>;
  get(id: string): Promise<Task>;
  claim(id: string, opts?: ClaimOptions): Promise<Task>;
  claimNext(opts?: ClaimOptions): Promise<Task | null>;
  renew(id: string, opts?: ClaimOptions): Promise<Task>;
  complete(id: string, result: CompleteInput): Promise<Task>;
  cancel(id: string): Promise<Task>;
  wait(id: string, timeoutMs?: number): Promise<Task>;
  /** Presence: tell the host this agent is online. */
  heartbeat(beat: Heartbeat): Promise<void>;
  /** Agents seen recently, newest first. */
  agents(): Promise<AgentPresence[]>;
}

export const TUNNELS = ['cloudflared', 'tailscale'] as const;
export type Tunnel = (typeof TUNNELS)[number];

export interface RelayConfig {
  port?: number;
  host?: string;
  /** Path to the queue file, or "none" for memory only. */
  data?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  retentionHours?: number;
  tunnel?: Tunnel;
}

/** host: runs the relay others join. client: joins a host, never runs a relay (docs/flow.md). */
export type Role = 'host' | 'client';

/** ~/.config/handover/config.json */
export interface Config {
  role?: Role;
  /** Relay this machine talks to: its own on a host; the host's on a client. */
  url?: string;
  /** Client only: the URL came from discovery; find the host again when it stops answering. */
  discover?: boolean;
  token?: string;
  /** This machine's agent name, used for targeting and leases. */
  agent?: string;
  /** Host only: relay settings. */
  relay?: RelayConfig;
  /** Take handovers automatically with a coding agent's CLI (off when absent). */
  auto?: AutoPickup;
  /** @deprecated v0.4–0.6 peer mode; read as host. */
  peer?: boolean;
}

/** Coding agents handover knows how to wire up and run headless. */
export const AGENT_KINDS = ['claude', 'codex'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export interface AutoPickup {
  /** The agents that take handovers here, each with its own worker; one name in 0.9 configs. */
  with: AgentKind | AgentKind[];
  /** Skip the agent's permission prompts and sandbox (opt-in only: tasks come from other machines). */
  fullAccess?: boolean;
}

/** A host found on the network. */
export interface Peer {
  agent: string;
  url: string;
}
