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
}

export type TaskSummary = Omit<Task, 'context' | 'output' | 'files' | 'seq'> & { fileCount: number };

export interface CreateInput {
  id?: string;
  objective: string;
  context?: string;
  from?: string | null;
  to?: string | null;
  priority?: number | string;
}

export interface ListFilter {
  status?: TaskStatus;
  /** Only tasks this agent may claim (unaddressed or addressed to it). */
  agent?: string;
}

export interface ClaimOptions {
  by?: string | null;
  leaseMs?: number;
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

/** ~/.config/handover/config.json */
export interface Config {
  /** Relay this machine talks to. */
  url?: string;
  token?: string;
  /** This machine's agent name, used for targeting and leases. */
  agent?: string;
  /** Set when this machine runs the relay (also in peer mode, where every machine runs one). */
  relay?: RelayConfig;
  /** Peer-to-peer on the local network: find other machines by mDNS instead of one relay URL. */
  peer?: boolean;
}

/** A machine found on the network in peer mode. */
export interface Peer {
  agent: string;
  url: string;
}
