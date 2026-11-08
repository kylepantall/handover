import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { replaceFileSync } from './paths.ts';
import { FAILURE,
  STATUS,
  type AgentPresence,
  type Heartbeat,
  type TaskKind,
  type ClaimOptions,
  type CompleteInput,
  type CreateInput,
  type ListFilter,
  type Task,
  type TaskFile,
  type TaskStatus,
  type TaskSummary, type AgentsFilter, type ClearOptions, type ClearResult } from './types.ts';

const TERMINAL = new Set<TaskStatus>([STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED]);
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_RE = /^[A-Za-z0-9._@:-]{1,64}$/;
const FILE_NAME_RE = /^[A-Za-z0-9._ -]{1,128}$/;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;
/** Reserved: `POST /tasks/next` would shadow a task with this id. */
const RESERVED_IDS = new Set(['next']);

export type ErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'too_large';

export class HandoverError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

export const isTerminal = (status: TaskStatus): boolean => TERMINAL.has(status);

function validateFiles(files: CompleteInput['files']): TaskFile[] {
  if (files == null) return [];
  if (!Array.isArray(files)) throw new HandoverError('bad_request', 'files must be an array');
  return files.map((f) => {
    const name = String(f?.name ?? '');
    // Flat names only: no paths, no traversal, no hidden dotfiles.
    if (!FILE_NAME_RE.test(name) || name.startsWith('.')) throw new HandoverError('bad_request', 'invalid file name');
    if (typeof f.content !== 'string') throw new HandoverError('bad_request', 'file content must be a string');
    return { name, encoding: f.encoding === 'base64' ? 'base64' : 'utf8', content: f.content };
  });
}

export function validateAgent(value: unknown, field = 'agent'): string | null {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!AGENT_RE.test(s)) throw new HandoverError('bad_request', `invalid ${field}`);
  return s;
}

function validatePriority(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || Math.abs(n) > 1000)
    throw new HandoverError('bad_request', 'priority must be an integer in -1000..1000');
  return n;
}

/** Highest priority first, then oldest first. */
const byQueueOrder = (a: Task, b: Task) => b.priority - a.priority || a.seq - b.seq;

const kindOf = (t: Task): TaskKind => t.kind ?? 'task';
/** Unanswered pings are cancelled after this; answered ones are deleted after PING_KEEP_MS. */
export const PING_TTL_MS = 60_000;
const PING_KEEP_MS = 5 * 60_000;
/** An agent counts as online if it checked in within this long. */
export const PRESENCE_TTL_MS = 90_000;
/** A device's "last seen" is written to disk at most this often. */
const SAVE_SEEN_MS = 10 * 60_000;

/**
 * A task is visible to `agent` when it is unaddressed or addressed to it. An
 * agent named `kind@machine` (e.g. codex@pc) also takes tasks addressed to its
 * machine ("pc": any agent there) or its kind ("codex": that agent anywhere).
 */
export function eligibleFor(task: Pick<Task, 'to'>, agent: string | null): boolean {
  if (!task.to || task.to === agent) return true;
  const at = agent?.indexOf('@') ?? -1;
  if (at <= 0) return false;
  return task.to === agent!.slice(0, at) || task.to === agent!.slice(at + 1);
}

/** `kind@machine`: the address of one agent on a machine. */
export const agentAddress = (kind: string, machine: string): string => `${kind}@${machine}`;

export interface StoreOptions {
  /** JSON file to persist the queue to; null keeps it in memory. */
  file?: string | null;
  leaseMs?: number;
  maxAttempts?: number;
  retentionMs?: number;
  now?: () => number;
}

/**
 * Task queue with optional JSON persistence, claim leases that requeue on expiry,
 * per-agent targeting (`to`), priorities and an atomic `claimNext`.
 */
export class Store {
  #tasks = new Map<string, Task>();
  /** Paired names. `direct`: its own process last checked in (agent addresses a machine reports have none). */
  #presence = new Map<string, { beat: Heartbeat; seen: number; direct: number; saved: number; via: Map<string, number> }>();
  #waiters = new Map<string, Set<(t: Task) => void>>();
  #seq = 0;
  readonly #file: string | null;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #maxAttempts: number;
  readonly #retentionMs: number;

  constructor({ file = null, leaseMs = 10 * 60_000, maxAttempts = 3, retentionMs = 24 * 3_600_000, now = Date.now }: StoreOptions = {}) {
    this.#file = file;
    this.#now = now;
    this.#leaseMs = leaseMs;
    this.#maxAttempts = maxAttempts;
    this.#retentionMs = retentionMs;
    if (file) this.#load();
  }

  create({ id, objective, context = '', from = null, to = null, priority = 0, kind = 'task' }: CreateInput): Task {
    if (typeof objective !== 'string' || !objective.trim()) throw new HandoverError('bad_request', 'objective is required');
    if (kind !== 'task' && kind !== 'ping') throw new HandoverError('bad_request', 'kind must be task or ping');
    // A ping checks one machine: it must say which.
    if (kind === 'ping' && !to) throw new HandoverError('bad_request', 'a ping needs to');
    const target = validateAgent(to, 'to');
    if (target && kind === 'task') this.#assertPaired(target);
    const taskId = id ?? randomBytes(6).toString('hex');
    if (!ID_RE.test(taskId) || RESERVED_IDS.has(taskId)) throw new HandoverError('bad_request', 'invalid id');
    if (this.#tasks.has(taskId)) throw new HandoverError('conflict', 'id already exists');
    const now = this.#iso();
    const task: Task = {
      id: taskId,
      seq: ++this.#seq,
      objective,
      context: String(context ?? ''),
      from: from == null ? null : String(from).slice(0, 128),
      to: target,
      priority: validatePriority(priority),
      status: STATUS.PENDING,
      claimedBy: null,
      attempts: 0,
      leaseExpiresAt: null,
      failureReason: null,
      output: null,
      files: [],
      createdAt: now,
      updatedAt: now,
      ...(kind === 'ping' ? { kind } : {}),
    };
    this.#tasks.set(taskId, task);
    this.#changed();
    return task;
  }

  /** Tasks in queue order. `agent` limits to tasks that agent may claim. */
  list({ status, agent, kind = 'task' }: ListFilter = {}): Task[] {
    return [...this.#tasks.values()]
      .filter((t) => kindOf(t) === kind && (!status || t.status === status) && (agent === undefined || eligibleFor(t, agent)))
      .sort(byQueueOrder);
  }

  get(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) throw new HandoverError('not_found', 'task not found');
    return task;
  }

  claim(id: string, { by = null, leaseMs }: ClaimOptions = {}): Task {
    const task = this.get(id);
    const agent = validateAgent(by);
    if (task.status !== STATUS.PENDING) throw new HandoverError('conflict', 'task is not pending');
    if (!eligibleFor(task, agent)) throw new HandoverError('conflict', 'task is addressed to another agent');
    return this.#update(task, {
      status: STATUS.CLAIMED,
      claimedBy: agent,
      attempts: task.attempts + 1,
      leaseExpiresAt: this.#leaseUntil(leaseMs),
    });
  }

  /** Atomically claims the highest-priority eligible pending task, or returns null. */
  claimNext({ by = null, leaseMs, kind = 'task' }: ClaimOptions = {}): Task | null {
    const agent = validateAgent(by);
    const [next] = this.list({ status: STATUS.PENDING, agent: agent ?? '', kind });
    return next ? this.claim(next.id, { by: agent, leaseMs }) : null;
  }

  /** Extends the lease of a task claimed by `by`. */
  renew(id: string, { by = null, leaseMs }: ClaimOptions = {}): Task {
    const task = this.get(id);
    const agent = validateAgent(by);
    if (task.status !== STATUS.CLAIMED) throw new HandoverError('conflict', 'task is not claimed');
    if (task.claimedBy !== agent) throw new HandoverError('conflict', 'task is claimed by another agent');
    return this.#update(task, { leaseExpiresAt: this.#leaseUntil(leaseMs) });
  }

  complete(id: string, { status = STATUS.SUCCESS, output = '', files }: CompleteInput = {}): Task {
    const task = this.get(id);
    if (isTerminal(task.status)) throw new HandoverError('conflict', 'task already finished');
    if (status !== STATUS.SUCCESS && status !== STATUS.FAILED)
      throw new HandoverError('bad_request', 'status must be success or failed');
    return this.#update(task, { status, output: String(output ?? ''), files: validateFiles(files), leaseExpiresAt: null });
  }

  cancel(id: string): Task {
    const task = this.get(id);
    if (isTerminal(task.status)) return task;
    return this.#update(task, { status: STATUS.CANCELLED, leaseExpiresAt: null });
  }

  /**
   * Deletes finished handovers. With `all`, also cancels open ones first (so
   * anyone waiting is told) and deletes those. Pings are left to the sweep.
   */
  clear({ all = false }: ClearOptions = {}): ClearResult {
    let removed = 0;
    for (const task of [...this.#tasks.values()]) {
      if (kindOf(task) === 'ping' || (!all && !isTerminal(task.status))) continue;
      if (!isTerminal(task.status)) this.#update(task, { status: STATUS.CANCELLED, leaseExpiresAt: null });
      this.#tasks.delete(task.id);
      removed++;
    }
    if (removed) this.#changed();
    return { removed };
  }

  /** Deletes one handover, cancelling it first if it's open (so anyone waiting is told). */
  remove(id: string): Task {
    const task = this.get(id);
    if (!isTerminal(task.status)) this.#update(task, { status: STATUS.CANCELLED, leaseExpiresAt: null });
    this.#tasks.delete(id);
    this.#changed();
    return task;
  }

  /** Requeues expired claims (or fails them after maxAttempts) and prunes old finished tasks. */
  sweep(): void {
    const now = this.#now();
    for (const task of this.#tasks.values()) {
      if (kindOf(task) === 'ping') {
        const age = now - Date.parse(task.createdAt);
        if (isTerminal(task.status) && now - Date.parse(task.updatedAt) > PING_KEEP_MS) {
          this.#tasks.delete(task.id);
          this.#changed();
        } else if (!isTerminal(task.status) && age > PING_TTL_MS) {
          this.#update(task, { status: STATUS.CANCELLED, leaseExpiresAt: null }); // nobody answered
        }
        continue;
      }
      if (task.status === STATUS.CLAIMED && Date.parse(task.leaseExpiresAt ?? '') <= now) {
        if (task.attempts >= this.#maxAttempts) {
          this.#update(task, { status: STATUS.FAILED, failureReason: FAILURE.LEASE_EXPIRED, leaseExpiresAt: null });
        } else {
          this.#update(task, { status: STATUS.PENDING, claimedBy: null, leaseExpiresAt: null });
        }
      } else if (isTerminal(task.status) && now - Date.parse(task.updatedAt) > this.#retentionMs) {
        this.#tasks.delete(task.id);
        this.#changed();
      }
    }
  }

  /** Resolves with the task once it is terminal, or after timeoutMs with its current state. */
  wait(id: string, timeoutMs: number): Promise<Task> {
    const task = this.get(id);
    if (isTerminal(task.status)) return Promise.resolve(task);
    return new Promise((resolve) => {
      const set = this.#waiters.get(id) ?? new Set();
      this.#waiters.set(id, set);
      const done = (t: Task) => {
        clearTimeout(timer);
        set.delete(done);
        resolve(t);
      };
      const timer = setTimeout(() => done(this.#tasks.get(id) ?? task), timeoutMs);
      set.add(done);
    });
  }

  /**
   * Presence: an agent's handover process is running, which also pairs the
   * machine: it holds the token and stays on the list (saved) until forgotten.
   * A machine's beat can name the agents installed there (codex@pc).
   */
  heartbeat(beat: Heartbeat): void {
    const agent = validateAgent(beat.agent);
    if (!agent) throw new HandoverError('bad_request', 'agent is required');
    const now = this.#now();
    const version = String(beat.version ?? '').slice(0, 32);
    const platform = String(beat.platform ?? '').slice(0, 32);
    let save = this.#register(agent, version, platform, now);
    const entry = this.#presence.get(agent)!;
    entry.direct = now;
    entry.via.set(String(beat.via ?? 'unknown').slice(0, 32), now);
    if (!agent.includes('@') && Array.isArray(beat.addresses)) {
      for (const a of beat.addresses.slice(0, 16)) {
        if (typeof a === 'string' && a.endsWith(`@${agent}`) && AGENT_RE.test(a)) save = this.#register(a, version, platform, now) || save;
      }
    }
    if (save) this.#changed();
  }

  /** Pairs a name that doesn't check in (an HTTP MCP client that says who it is). */
  pair(name: unknown): void {
    const agent = validateAgent(name);
    if (agent && this.#register(agent, '', '', this.#now())) this.#changed();
  }

  /** Unpairs a machine (with its agents) or one agent address. */
  forget(name: string): ClearResult {
    const target = validateAgent(name);
    if (!target) throw new HandoverError('bad_request', 'a name is required');
    let removed = 0;
    for (const key of [...this.#presence.keys()]) {
      if (key === target || key.endsWith(`@${target}`)) {
        this.#presence.delete(key);
        removed++;
      }
    }
    if (removed) this.#changed();
    return { removed };
  }

  /** Records a paired name. Returns whether the saved list needs writing. */
  #register(agent: string, version: string, platform: string, now: number): boolean {
    const entry = this.#presence.get(agent);
    if (!entry) {
      this.#presence.set(agent, { beat: { agent, version, platform, via: '' }, seen: now, direct: -Infinity, saved: now, via: new Map() });
      return true;
    }
    const changed = (!!version && version !== entry.beat.version) || (!!platform && platform !== entry.beat.platform);
    entry.beat.version = version || entry.beat.version;
    entry.beat.platform = platform || entry.beat.platform;
    entry.seen = now;
    if (!changed && now - entry.saved < SAVE_SEEN_MS) return false;
    entry.saved = now;
    return true;
  }

  /** Only tasks for machines and agents that are paired: an agent can't invent a recipient. */
  #assertPaired(to: string): void {
    const names = [...this.#presence.keys()];
    if (names.some((name) => eligibleFor({ to }, name))) return;
    throw new HandoverError('bad_request', `no paired device or agent "${to}". Paired: ${names.sort().join(', ') || 'none yet'}`);
  }

  /**
   * Agents that checked in within PRESENCE_TTL_MS, most recent first. With
   * `all`, also those seen earlier since the relay started.
   */
  agents({ all = false }: AgentsFilter = {}): AgentPresence[] {
    const now = this.#now();
    return [...this.#presence.values()]
      // Without `all`: processes that can answer a ping, for handover test.
      .filter((e) => all || now - e.direct <= PRESENCE_TTL_MS)
      .sort((a, b) => b.seen - a.seen)
      .map((e) => ({
        agent: e.beat.agent,
        version: e.beat.version,
        platform: e.beat.platform,
        via: [...e.via].filter(([, t]) => now - t <= PRESENCE_TTL_MS).map(([v]) => v).sort(),
        lastSeen: new Date(e.seen).toISOString(),
        online: now - e.seen <= PRESENCE_TTL_MS,
      }));
  }

  /** Writes state to disk now. */
  flush(): void {
    if (!this.#file) return;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const devices = [...this.#presence.values()].map((e) => ({
      agent: e.beat.agent,
      version: e.beat.version,
      platform: e.beat.platform,
      lastSeen: new Date(e.seen).toISOString(),
    }));
    const state = { version: STATE_VERSION, seq: this.#seq, tasks: [...this.#tasks.values()], devices };
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    replaceFileSync(tmp, this.#file);
  }

  #load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#file!, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const state = JSON.parse(raw) as { version?: number; seq?: number; tasks?: Task[]; devices?: Array<{ agent: string; version: string; platform: string; lastSeen: string }> };
    if (state?.version !== STATE_VERSION || !Array.isArray(state.tasks)) throw new Error(`unsupported state file: ${this.#file}`);
    for (const t of state.tasks) this.#tasks.set(t.id, t);
    for (const d of Array.isArray(state.devices) ? state.devices : []) {
      const seen = Date.parse(d.lastSeen);
      if (!AGENT_RE.test(String(d.agent)) || !Number.isFinite(seen)) continue;
      this.#presence.set(d.agent, { beat: { agent: d.agent, version: String(d.version ?? ''), platform: String(d.platform ?? ''), via: '' }, seen, direct: -Infinity, saved: seen, via: new Map() });
    }
    this.#seq = Math.max(Number(state.seq) || 0, ...state.tasks.map((t) => t.seq || 0));
  }

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #leaseUntil(leaseMs: number | undefined): string {
    const ms = leaseMs == null ? this.#leaseMs : Number(leaseMs);
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_LEASE_MS) throw new HandoverError('bad_request', 'invalid lease');
    return new Date(this.#now() + ms).toISOString();
  }

  #changed(): void {
    // Written immediately, not debounced: on Windows a killed process gets no
    // shutdown hook, so anything still waiting on a timer would be lost.
    try {
      this.flush();
    } catch (err) {
      console.error('state save failed', { file: this.#file, error: (err as Error).message });
    }
  }

  #update(task: Task, patch: Partial<Task>): Task {
    Object.assign(task, patch, { updatedAt: this.#iso() });
    if (isTerminal(task.status)) {
      for (const fn of this.#waiters.get(task.id) ?? []) fn(task);
      this.#waiters.delete(task.id);
    }
    this.#changed();
    return task;
  }
}

/** Public summary without the (possibly large) payloads. */
export function summarize({ context: _c, output: _o, files, seq: _s, ...rest }: Task): TaskSummary {
  return { ...rest, fileCount: files.length };
}
