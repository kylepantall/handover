import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  FAILURE,
  STATUS,
  type ClaimOptions,
  type CompleteInput,
  type CreateInput,
  type ListFilter,
  type Task,
  type TaskFile,
  type TaskStatus,
  type TaskSummary,
} from './types.ts';

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

/** A task is visible to `agent` when it is unaddressed or addressed to that agent. */
const eligibleFor = (task: Task, agent: string | null) => !task.to || task.to === agent;

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
  #waiters = new Map<string, Set<(t: Task) => void>>();
  #seq = 0;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
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

  create({ id, objective, context = '', from = null, to = null, priority = 0 }: CreateInput): Task {
    if (typeof objective !== 'string' || !objective.trim()) throw new HandoverError('bad_request', 'objective is required');
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
      to: validateAgent(to, 'to'),
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
    };
    this.#tasks.set(taskId, task);
    this.#changed();
    return task;
  }

  /** Tasks in queue order. `agent` limits to tasks that agent may claim. */
  list({ status, agent }: ListFilter = {}): Task[] {
    return [...this.#tasks.values()]
      .filter((t) => (!status || t.status === status) && (agent === undefined || eligibleFor(t, agent)))
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
  claimNext({ by = null, leaseMs }: ClaimOptions = {}): Task | null {
    const agent = validateAgent(by);
    const [next] = this.list({ status: STATUS.PENDING, agent: agent ?? '' });
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

  /** Requeues expired claims (or fails them after maxAttempts) and prunes old finished tasks. */
  sweep(): void {
    const now = this.#now();
    for (const task of this.#tasks.values()) {
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

  /** Writes state to disk now (call on shutdown). */
  flush(): void {
    if (!this.#file) return;
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const state = { version: STATE_VERSION, seq: this.#seq, tasks: [...this.#tasks.values()] };
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  #load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#file!, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const state = JSON.parse(raw) as { version?: number; seq?: number; tasks?: Task[] };
    if (state?.version !== STATE_VERSION || !Array.isArray(state.tasks)) throw new Error(`unsupported state file: ${this.#file}`);
    for (const t of state.tasks) this.#tasks.set(t.id, t);
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
    // Debounced so bursts of updates cost one write.
    if (!this.#file || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      try {
        this.flush();
      } catch (err) {
        console.error('state save failed', { file: this.#file, error: (err as Error).message });
      }
    }, 100);
    this.#saveTimer.unref?.();
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
