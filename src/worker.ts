/**
 * Auto-pickup: claim the next handover, run an agent on its briefing, hand
 * back the result, repeat. Used by `handover worker`, and when auto-pickup is
 * on, by the login service (`serve`) or handover's MCP server.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { agentStream, type SendInput } from './agent-stream.ts';
import { ADAPTERS } from './agents.ts';
import { RelayError } from './client.ts';
import { isWindows, windowsSystem, type Paths } from './paths.ts';
import { startResponder } from './responder.ts';
import { briefing } from './tools.ts';
import { agentAddress, HandoverError } from './store.ts';
import { STATUS, type AgentKind, type Api, type Task, type TranscriptChunk, type WorkerUpdate } from './types.ts';

const log = (msg: string, ctx?: Record<string, unknown>) => console.error('[handover]', msg, ...(ctx ? [ctx] : []));

/** Set in the agent's environment, so the handover MCP server it starts doesn't start another worker. */
export const WORKER_ENV = 'HANDOVER_WORKER';

/** A shell command line (`--exec`) or an argv (an adapter). */
export type AgentCommand = string | string[];

const UNATTENDED =
  '\n\nThe user can watch your visible messages and send input through Handover. Continue independently when possible. If the handover tools are unavailable, end with your final answer; it is sent back as the output. If you could not do the task, start that final answer with "FAILED:".';

/** The agent said it couldn't do the task (see UNATTENDED), even if it exited 0. */
export const reportsFailure = (output: string): boolean => /^\s*FAILED:/.test(output);

const quoteCmd = (a: string) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`);

function stopAgent(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (!isWindows) process.kill(-child.pid, 'SIGKILL');
    else if (child.exitCode === null && child.signalCode === null) {
      const result = spawnSync(windowsSystem('taskkill.exe'), ['/T', '/F', '/PID', String(child.pid)], {
        timeout: 5000, windowsHide: true,
      });
      if (result.status !== 0) child.kill('SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

type AgentResult = { code: number; stdout: string };
type AgentOutput = {
  transcript(chunk: TranscriptChunk): void;
  ready(send: SendInput): void;
  native?: { kind: AgentKind; fullAccess: boolean };
};

export function runAgent(command: AgentCommand, task: Task, cwd?: string, signal?: AbortSignal, output?: AgentOutput): Promise<AgentResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: 1, stdout: '' });
    const env = { ...process.env, HANDOVER_ID: task.id, [WORKER_ENV]: '1' };
    const stdio: ['pipe', 'pipe', 'inherit'] = ['pipe', 'pipe', 'inherit'];
    let child;
    const options = { stdio, env, cwd, detached: !isWindows, windowsHide: true };
    if (typeof command === 'string') child = spawn(command, { ...options, shell: true });
    // npm installs agents on Windows as .cmd shims, which only run through cmd.
    else if (isWindows && /\.(cmd|bat)$/i.test(command[0]!)) child = spawn(command.map(quoteCmd).join(' '), { ...options, shell: true });
    else child = spawn(command[0]!, command.slice(1), options);
    const stop = () => stopAgent(child);
    signal?.addEventListener('abort', stop, { once: true });
    const prompt = briefing(task) + (typeof command === 'string' ? '' : UNATTENDED);
    let stdout = '';
    let result: AgentResult | undefined;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdin!.on('error', () => {}); // the agent may exit before reading it all
    if (output?.native) {
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
      lines.on('line', agentStream({
        ...output.native, stdin: child.stdin!, cwd: path.resolve(cwd ?? '.'), prompt,
        transcript: output.transcript, ready: output.ready,
        finish: (code, stdout) => {
          if (result) return;
          result = { code, stdout };
          child.stdin!.end();
          exitTimer = setTimeout(stop, 2000);
          exitTimer.unref();
        },
      }));
    } else {
      child.stdout!.setEncoding('utf8').on('data', (text: string) => {
        stdout += text;
        process.stderr.write(text);
        output?.transcript({ messageId: 'stdout', text });
      });
      child.stdin!.end(prompt);
    }
    child.on('close', (code) => {
      clearTimeout(exitTimer);
      signal?.removeEventListener('abort', stop);
      resolve(result ?? (output?.native
        ? { code: code || 1, stdout: 'The agent process exited before finishing the handover.' }
        : { code: code ?? 1, stdout }));
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', stop);
      resolve({ code: -1, stdout: err.message });
    });
  });
}

export interface WorkOptions {
  agent: string;
  command: AgentCommand;
  native?: { kind: AgentKind; fullAccess: boolean };
  /** Each task runs in its own folder under here; default: the current folder. */
  workDir?: string;
  leaseMs?: number;
  intervalMs?: number;
  once?: boolean;
  via?: string;
}

/** Takes handovers until stopped (or one pass with `once`). */
export async function workLoop(api: Api, o: WorkOptions, signal?: AbortSignal): Promise<void> {
  const responder = startResponder(api, { agent: o.agent, via: o.via ?? 'worker' });
  let failing = false;
  try {
    while (!signal?.aborted) {
      try {
        let task: Task | null;
        while (!signal?.aborted && (task = await api.claimNext({ by: o.agent, leaseMs: o.leaseMs, managed: true, liveInput: !!o.native })))
          await runOne(api, task, o, signal);
        if (failing) log('relay reachable again');
        failing = false;
      } catch (err) {
        // Once per outage (e.g. while the relay starts), not every poll.
        if (!failing) log('poll failed', { error: (err as Error).message });
        failing = true;
      }
      if (o.once) return;
      await Bun.sleep(o.intervalMs ?? 3000);
    }
  } finally {
    responder.stop();
  }
}

const sameClaim = (t: Task, current: { claimedBy: string | null; attempt?: number }) =>
  t.claimedBy === current.claimedBy && (current.attempt === undefined || t.attempts === current.attempt);

const missingTask = (error: unknown) =>
  (error instanceof RelayError || error instanceof HandoverError) && error.code === 'not_found';

async function claimStatus(api: Api, id: string, signal: AbortSignal) {
  try {
    return await api.activity(id, Number.MAX_SAFE_INTEGER, signal);
  } catch (error) {
    if (!(error instanceof RelayError) || error.status !== 404 || error.code) throw error;
    // Relays from before the activity endpoint still accept managed workers.
    const task = await api.get(id);
    return { claimedBy: task.claimedBy, status: task.status, attempt: task.attempts };
  }
}

async function observeClaim(api: Api, task: Task, stop: AbortController, finished: AbortSignal): Promise<void> {
  while (!finished.aborted) {
    try {
      const current = await claimStatus(api, task.id, AbortSignal.any([finished, AbortSignal.timeout(2500)]));
      if (!sameClaim(task, current) || current.status === STATUS.CANCELLED || current.status === STATUS.PENDING) {
        stop.abort();
        return;
      }
    } catch (error) {
      if (missingTask(error)) {
        stop.abort();
        return;
      }
    }
    await delay(1000, undefined, { signal: finished }).catch(() => {});
  }
}

function liveRelay(api: Api, task: Task, native: WorkOptions['native']) {
  const chunks: WorkerUpdate['chunks'] = [];
  const receipts: WorkerUpdate['receipts'] = [];
  let seq = 0;
  let send: SendInput | undefined;
  let connected = true;
  const output: AgentOutput = {
    native,
    ready: (input) => { send = input; },
    transcript({ messageId, text }) {
      if (!connected || !text) return;
      for (let i = 0; i < text.length; i += 4096)
        chunks.push({ seq: ++seq, messageId: messageId.slice(0, 128), text: text.slice(i, i + 4096) });
      if (chunks.length > 256) chunks.splice(0, chunks.length - 256);
    },
  };

  async function exchange(signal?: AbortSignal) {
    const batch = chunks.slice(0, 32);
    const sentReceipts = receipts.slice();
    const result = await api.workerUpdate(task.id, {
      by: task.claimedBy!, attempt: task.attempts, chunks: batch, receipts: sentReceipts,
    }, AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]));
    const last = batch.at(-1)?.seq ?? 0;
    while (chunks[0] && chunks[0].seq <= last) chunks.shift();
    receipts.splice(0, sentReceipts.length);
    for (const direction of result.directions) {
      if (signal?.aborted || !send || receipts.some((receipt) => receipt.cursor === direction.cursor)) break;
      const accepted = await send(direction.message).then(() => true, () => false);
      receipts.push({ cursor: direction.cursor, accepted });
    }
  }

  return {
    output,
    async watch(signal: AbortSignal) {
      while (!signal.aborted && connected) {
        try {
          await exchange(signal);
        } catch (error) {
          // An older relay can still run the task without live updates.
          if ((error instanceof RelayError && error.status === 404 && !error.code) || missingTask(error)) connected = false;
        }
        await delay(250, undefined, { signal }).catch(() => {});
      }
    },
    async flush() {
      send = undefined;
      try {
        while (connected && (chunks.length || receipts.length)) await exchange();
      } catch { /* The result still uses the normal completion path. */ }
    },
  };
}

async function runOne(api: Api, t: Task, o: WorkOptions, signal?: AbortSignal): Promise<void> {
  log('picked up', { id: t.id, priority: t.priority, attempt: t.attempts });
  let cwd: string | undefined;
  if (o.workDir) {
    cwd = path.join(o.workDir, t.id);
    await mkdir(cwd, { recursive: true });
  }
  const stop = new AbortController();
  const finished = new AbortController();
  const observer = observeClaim(api, t, stop, finished.signal);
  const live = liveRelay(api, t, o.native);
  const publisher = live.watch(finished.signal);
  // Keep the lease alive while the agent runs: renew at a third of its length.
  const leaseLeft = Date.parse(t.leaseExpiresAt ?? '') - Date.now();
  const renewer = setInterval(() => {
    api.renew(t.id, { by: o.agent, leaseMs: o.leaseMs, attempt: t.attempts }).catch((err: Error) => log('renew failed', { id: t.id, error: err.message }));
  }, Math.max(1000, leaseLeft / 3));
  const running = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const { code, stdout } = await runAgent(o.command, t, cwd, running, live.output).finally(async () => {
    clearInterval(renewer);
    finished.abort();
    await Promise.all([observer, publisher]);
  });
  await live.flush();
  const active = await claimStatus(api, t.id, AbortSignal.timeout(5000)).catch((error: unknown) => {
    if (missingTask(error)) return null;
    throw error;
  });
  if (active && sameClaim(t, active) && active.status === STATUS.CANCELLED && t.managed) {
    await api.workerStopped(t.id, o.agent, t.attempts);
  } else if (active && sameClaim(t, active) && active.status === STATUS.CLAIMED && !running.aborted) {
    // The agent didn't call handover_complete itself: hand back its stdout.
    const failed = code !== 0 || reportsFailure(stdout);
    await api.complete(t.id, {
      status: failed ? STATUS.FAILED : STATUS.SUCCESS,
      output: stdout.trim(),
      claim: { by: o.agent, attempt: t.attempts },
    });
  }
  log('finished', { id: t.id, exitCode: code });
}

/**
 * A worker for one agent: it claims tasks as `kind@machine` (so `to: "codex"`
 * reaches it), each task in its own folder. Null if the agent's CLI is missing.
 */
export function agentWork(p: Paths, kind: AgentKind, fullAccess: boolean, machine: string, via: string): WorkOptions | null {
  const adapter = ADAPTERS[kind];
  if (!adapter?.bin()) return null;
  return { agent: agentAddress(kind, machine), command: adapter.execArgv(fullAccess), native: { kind, fullAccess }, workDir: path.join(p.dir, 'work'), via };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One worker per agent per machine, whichever process gets there first (the
 * login service, or one of several open agents' MCP servers). It also stops a
 * worker's own agent from starting another: Codex doesn't pass our environment
 * to the MCP servers it starts. The lock is a file holding the owner's pid.
 */
export function acquireWorkerLock(p: Paths, kind: AgentKind): boolean {
  const file = path.join(p.dir, `worker-${kind}.lock`);
  mkdirSync(p.dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx' });
      process.once('exit', () => {
        try {
          if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file, { force: true });
        } catch {
          // already gone
        }
      });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number(readFileSync(file, 'utf8').trim());
      if (owner === process.pid) return true;
      if (owner && alive(owner)) return false;
      rmSync(file, { force: true }); // its owner is gone
    }
  }
  return false;
}
