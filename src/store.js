import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATUS = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const FAILURE = Object.freeze({ LEASE_EXPIRED: 'lease_expired' });

const TERMINAL = new Set([STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED]);
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const AGENT_RE = /^[A-Za-z0-9._@:-]{1,64}$/;
const FILE_NAME_RE = /^[A-Za-z0-9._ -]{1,128}$/;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;

export class HandoverError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'bad_request' | 'not_found' | 'conflict'
  }
}

export const isTerminal = (status) => TERMINAL.has(status);

function validateFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw new HandoverError('bad_request', 'files must be an array');
  return files.map((f) => {
    const name = String(f?.name ?? '');
    // Flat names only: no paths, no traversal, no hidden dotfiles.
    if (!FILE_NAME_RE.test(name) || name.startsWith('.')) {
      throw new HandoverError('bad_request', 'invalid file name');
    }
    const encoding = f.encoding === 'base64' ? 'base64' : 'utf8';
    if (typeof f.content !== 'string') throw new HandoverError('bad_request', 'file content must be a string');
    return { name, encoding, content: f.content };
  });
}

function validateAgent(value, field) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (!AGENT_RE.test(s)) throw new HandoverError('bad_request', `invalid ${field}`);
  return s;
}

function validatePriority(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isInteger(n) || Math.abs(n) > 1000) throw new HandoverError('bad_request', 'priority must be an integer in -1000..1000');
  return n;
}

/** Highest priority first, then oldest first. */
const byQueueOrder = (a, b) => b.priority - a.priority || a.seq - b.seq;

/** A task is visible to `agent` when it is unaddressed or addressed to that agent. */
const eligibleFor = (task, agent) => !task.to || task.to === agent;

/**
 * Task queue. Optional JSON persistence (`file`), claim leases that requeue on expiry,
 * per-agent targeting (`to`), priorities and an atomic `claimNext`.
 */
export class Store {
  #tasks = new Map();
  #waiters = new Map(); // id -> Set<fn>
  #seq = 0;
  #file;
  #saveTimer = null;
  #now;
  #leaseMs;
  #maxAttempts;
  #retentionMs;

  constructor({ file = null, leaseMs = 10 * 60_000, maxAttempts = 3, retentionMs = 24 * 60 * 60_000, now = Date.now } = {}) {
    this.#file = file;
    this.#now = now;
    this.#leaseMs = leaseMs;
    this.#maxAttempts = maxAttempts;
    this.#retentionMs = retentionMs;
    if (file) this.#load();
  }

  create({ id, objective, context = '', from = null, to = null, priority = 0 } = {}) {
    if (typeof objective !== 'string' || !objective.trim()) {
      throw new HandoverError('bad_request', 'objective is required');
    }
    const taskId = id ?? randomBytes(6).toString('hex');
    if (!ID_RE.test(taskId) || taskId === 'next') throw new HandoverError('bad_request', 'invalid id');
    if (this.#tasks.has(taskId)) throw new HandoverError('conflict', 'id already exists');
    const now = this.#iso();
    const task = {
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
  list({ status, agent } = {}) {
    return [...this.#tasks.values()]
      .filter((t) => (!status || t.status === status) && (agent === undefined || eligibleFor(t, agent)))
      .sort(byQueueOrder);
  }

  get(id) {
    const task = this.#tasks.get(id);
    if (!task) throw new HandoverError('not_found', 'task not found');
    return task;
  }

  claim(id, { by = null, leaseMs } = {}) {
    const task = this.get(id);
    const agent = validateAgent(by, 'agent');
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
  claimNext({ by = null, leaseMs } = {}) {
    const agent = validateAgent(by, 'agent');
    const [next] = this.list({ status: STATUS.PENDING, agent });
    return next ? this.claim(next.id, { by: agent, leaseMs }) : null;
  }

  /** Extends the lease of a task claimed by `by`. */
  renew(id, { by = null, leaseMs } = {}) {
    const task = this.get(id);
    const agent = validateAgent(by, 'agent');
    if (task.status !== STATUS.CLAIMED) throw new HandoverError('conflict', 'task is not claimed');
    if (task.claimedBy !== agent) throw new HandoverError('conflict', 'task is claimed by another agent');
    return this.#update(task, { leaseExpiresAt: this.#leaseUntil(leaseMs) });
  }

  complete(id, { status = STATUS.SUCCESS, output = '', files } = {}) {
    const task = this.get(id);
    if (isTerminal(task.status)) throw new HandoverError('conflict', 'task already finished');
    if (status !== STATUS.SUCCESS && status !== STATUS.FAILED) {
      throw new HandoverError('bad_request', 'status must be success or failed');
    }
    return this.#update(task, {
      status,
      output: String(output ?? ''),
      files: validateFiles(files),
      leaseExpiresAt: null,
    });
  }

  cancel(id) {
    const task = this.get(id);
    if (isTerminal(task.status)) return task;
    return this.#update(task, { status: STATUS.CANCELLED, leaseExpiresAt: null });
  }

  /** Requeues expired claims (or fails them after maxAttempts) and prunes old finished tasks. */
  sweep() {
    const now = this.#now();
    for (const task of this.#tasks.values()) {
      if (task.status === STATUS.CLAIMED && Date.parse(task.leaseExpiresAt) <= now) {
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
  wait(id, timeoutMs) {
    const task = this.get(id);
    if (isTerminal(task.status)) return Promise.resolve(task);
    return new Promise((resolve) => {
      const set = this.#waiters.get(id) ?? new Set();
      this.#waiters.set(id, set);
      const done = (t) => {
        clearTimeout(timer);
        set.delete(done);
        resolve(t);
      };
      const timer = setTimeout(() => done(this.#tasks.get(id) ?? task), timeoutMs);
      set.add(done);
    });
  }

  /** Writes pending state to disk now (call on shutdown). */
  flush() {
    if (!this.#file) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const state = { version: STATE_VERSION, seq: this.#seq, tasks: [...this.#tasks.values()] };
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  #load() {
    let raw;
    try {
      raw = fs.readFileSync(this.#file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const state = JSON.parse(raw);
    if (state?.version !== STATE_VERSION || !Array.isArray(state.tasks)) {
      throw new Error(`unsupported state file: ${this.#file}`);
    }
    for (const t of state.tasks) this.#tasks.set(t.id, t);
    this.#seq = Math.max(Number(state.seq) || 0, ...state.tasks.map((t) => t.seq || 0));
  }

  #iso = () => new Date(this.#now()).toISOString();

  #leaseUntil(leaseMs) {
    const ms = leaseMs == null ? this.#leaseMs : Number(leaseMs);
    if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_LEASE_MS) throw new HandoverError('bad_request', 'invalid lease');
    return new Date(this.#now() + ms).toISOString();
  }

  #changed() {
    // Debounced so bursts of updates cost one write.
    if (!this.#file || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      try {
        this.flush();
      } catch (err) {
        console.error('state save failed', { file: this.#file, error: err.message });
      }
    }, 100);
    this.#saveTimer.unref?.();
  }

  #update(task, patch) {
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
export const summarize = ({ id, objective, status, from, to, priority, attempts, claimedBy, leaseExpiresAt, failureReason, createdAt, updatedAt, files }) => ({
  id, objective, status, from, to, priority, attempts, claimedBy, leaseExpiresAt, failureReason, createdAt, updatedAt, fileCount: files.length,
});
