import { randomBytes } from 'node:crypto';

export const STATUS = Object.freeze({
  PENDING: 'pending',
  CLAIMED: 'claimed',
  SUCCESS: 'success',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL = new Set([STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCELLED]);
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const FILE_NAME_RE = /^[A-Za-z0-9._ -]{1,128}$/;

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

/** In-memory task store. lean-ctx: in-memory only, upgrade to disk persistence when relay restarts matter. */
export class Store {
  #tasks = new Map();
  #waiters = new Map(); // id -> Set<fn>

  create({ id, objective, context = '', from = null } = {}) {
    if (typeof objective !== 'string' || !objective.trim()) {
      throw new HandoverError('bad_request', 'objective is required');
    }
    const taskId = id ?? randomBytes(6).toString('hex');
    if (!ID_RE.test(taskId)) throw new HandoverError('bad_request', 'invalid id');
    if (this.#tasks.has(taskId)) throw new HandoverError('conflict', 'id already exists');
    const now = new Date().toISOString();
    const task = {
      id: taskId,
      objective,
      context: String(context ?? ''),
      from,
      status: STATUS.PENDING,
      claimedBy: null,
      output: null,
      files: [],
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.set(taskId, task);
    return task;
  }

  list(status) {
    return [...this.#tasks.values()].filter((t) => !status || t.status === status);
  }

  get(id) {
    const task = this.#tasks.get(id);
    if (!task) throw new HandoverError('not_found', 'task not found');
    return task;
  }

  claim(id, by = null) {
    const task = this.get(id);
    if (task.status !== STATUS.PENDING) throw new HandoverError('conflict', 'task is not pending');
    return this.#update(task, { status: STATUS.CLAIMED, claimedBy: by });
  }

  complete(id, { status = STATUS.SUCCESS, output = '', files } = {}) {
    const task = this.get(id);
    if (isTerminal(task.status)) throw new HandoverError('conflict', 'task already finished');
    if (status !== STATUS.SUCCESS && status !== STATUS.FAILED) {
      throw new HandoverError('bad_request', 'status must be success or failed');
    }
    return this.#update(task, { status, output: String(output ?? ''), files: validateFiles(files) });
  }

  cancel(id) {
    const task = this.get(id);
    if (isTerminal(task.status)) return task;
    return this.#update(task, { status: STATUS.CANCELLED });
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
      const timer = setTimeout(() => done(this.get(id)), timeoutMs);
      set.add(done);
    });
  }

  #update(task, patch) {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    if (isTerminal(task.status)) {
      for (const fn of this.#waiters.get(task.id) ?? []) fn(task);
      this.#waiters.delete(task.id);
    }
    return task;
  }
}

/** Public summary without the (possibly large) payloads. */
export const summarize = ({ id, objective, status, from, claimedBy, createdAt, updatedAt, files }) => ({
  id, objective, status, from, claimedBy, createdAt, updatedAt, fileCount: files.length,
});
