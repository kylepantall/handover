/**
 * Auto-pickup: claim the next handover, run an agent on its briefing, hand
 * back the result, repeat. Used by `handover worker`, and when auto-pickup is
 * on, by the login service (`serve`) or handover's MCP server.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ADAPTERS } from './agents.ts';
import { isWindows, type Paths } from './paths.ts';
import { startResponder } from './responder.ts';
import { isTerminal } from './store.ts';
import { briefing } from './tools.ts';
import { STATUS, type Api, type AutoPickup, type Task } from './types.ts';

const log = (msg: string, ctx?: Record<string, unknown>) => console.error('[handover]', msg, ...(ctx ? [ctx] : []));

/** Set in the agent's environment, so the handover MCP server it starts doesn't start another worker. */
export const WORKER_ENV = 'HANDOVER_WORKER';

/** A shell command line (`--exec`) or an argv (an adapter). */
export type AgentCommand = string | string[];

const UNATTENDED =
  '\n\nYou are running unattended: nobody can answer questions. If the handover tools are unavailable, end with your final answer; it is sent back as the output.';

const quoteCmd = (a: string) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a}"`);

export function runAgent(command: AgentCommand, task: Task, cwd?: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, HANDOVER_ID: task.id, [WORKER_ENV]: '1' };
    const stdio: ['pipe', 'pipe', 'inherit'] = ['pipe', 'pipe', 'inherit'];
    let child;
    if (typeof command === 'string') child = spawn(command, { shell: true, stdio, env, cwd });
    // npm installs agents on Windows as .cmd shims, which only run through cmd.
    else if (isWindows && /\.(cmd|bat)$/i.test(command[0]!)) child = spawn(command.map(quoteCmd).join(' '), { shell: true, stdio, env, cwd });
    else child = spawn(command[0]!, command.slice(1), { stdio, env, cwd });
    let stdout = '';
    child.stdout!.on('data', (d: Buffer) => {
      stdout += d;
      process.stderr.write(d);
    });
    child.stdin!.on('error', () => {}); // the agent may exit before reading it all
    child.stdin!.end(briefing(task) + (typeof command === 'string' ? '' : UNATTENDED));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    child.on('error', (err) => resolve({ code: -1, stdout: err.message }));
  });
}

export interface WorkOptions {
  agent: string;
  command: AgentCommand;
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
        while (!signal?.aborted && (task = await api.claimNext({ by: o.agent, leaseMs: o.leaseMs }))) await runOne(api, task, o);
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

async function runOne(api: Api, t: Task, o: WorkOptions): Promise<void> {
  log('picked up', { id: t.id, priority: t.priority, attempt: t.attempts });
  // Keep the lease alive while the agent runs: renew at a third of its length.
  const leaseLeft = Date.parse(t.leaseExpiresAt ?? '') - Date.now();
  const renewer = setInterval(() => {
    api.renew(t.id, { by: o.agent, leaseMs: o.leaseMs }).catch((err: Error) => log('renew failed', { id: t.id, error: err.message }));
  }, Math.max(1000, leaseLeft / 3));
  let cwd: string | undefined;
  if (o.workDir) {
    cwd = path.join(o.workDir, t.id);
    await mkdir(cwd, { recursive: true });
  }
  const { code, stdout } = await runAgent(o.command, t, cwd).finally(() => clearInterval(renewer));
  if (!isTerminal((await api.get(t.id)).status)) {
    // The agent didn't call handover_complete itself: hand back its stdout.
    await api.complete(t.id, { status: code === 0 ? STATUS.SUCCESS : STATUS.FAILED, output: stdout.trim() });
  }
  log('finished', { id: t.id, exitCode: code });
}

/** The worker auto-pickup runs: the configured agent, each task in its own folder. Null if its CLI is missing. */
export function autoWork(p: Paths, auto: AutoPickup, agent: string, via: string): WorkOptions | null {
  const adapter = ADAPTERS[auto.with];
  if (!adapter?.bin()) return null;
  return { agent, command: adapter.execArgv(auto.fullAccess === true), workDir: path.join(p.dir, 'work'), via };
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
 * One auto-pickup worker per machine, whichever process gets there first (the
 * login service, or one of several open agents' MCP servers). It also stops a
 * worker's own agent from starting another: Codex doesn't pass our environment
 * to the MCP servers it starts. The lock is a file holding the owner's pid.
 */
export function acquireWorkerLock(p: Paths): boolean {
  const file = path.join(p.dir, 'worker.lock');
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
