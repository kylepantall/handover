/**
 * Connectivity: every running handover process (relay, Claude Code's MCP
 * server, worker, listen) checks in with the host and answers ping tasks
 * addressed to its agent. A ping can ask the receiver to ping other agents
 * and report back, which is how `handover test` checks every pair.
 */

import { isTerminal } from './store.ts';
import type { Api, Task } from './types.ts';
import { VERSION } from './version.ts';

export interface Link {
  from: string;
  to: string;
  ok: boolean;
  ms?: number;
  error?: string;
}

export interface PingReply {
  agent: string;
  version: string;
  platform: string;
  /** Pings this agent sent on request (round robin). */
  links?: Link[];
}

interface PingPayload {
  from: string;
  relayTo?: string[];
  timeoutMs?: number;
}

export const NO_ANSWER = 'no answer: nothing is running there (open Claude Code, or run handover listen)';
const platform = `${process.platform}/${process.arch}`;

/** Sends a ping to `to` through the host and waits for its answer. */
export async function pingAgent(
  api: Api,
  from: string,
  to: string,
  { timeoutMs = 8_000, relayTo }: { timeoutMs?: number; relayTo?: string[] } = {}
): Promise<{ ok: boolean; ms?: number; reply?: PingReply; error?: string }> {
  const started = Date.now();
  // Forwarded pings get the same budget; the outer ping waits for them too.
  const inner = relayTo?.length ? timeoutMs : undefined;
  const budget = inner ? timeoutMs * 2 + 2_000 : timeoutMs;
  let task: Task;
  try {
    task = await api.create({
      kind: 'ping',
      to,
      from,
      objective: `handover ping from ${from}`,
      context: JSON.stringify({ from, relayTo, timeoutMs: inner } satisfies PingPayload),
    });
  } catch (err) {
    return { ok: false, error: `could not reach the host: ${(err as Error).message}` };
  }
  const end = started + budget;
  try {
    while (!isTerminal(task.status) && Date.now() < end) task = await api.wait(task.id, Math.min(25_000, end - Date.now()));
  } catch (err) {
    return { ok: false, error: `lost the host: ${(err as Error).message}` };
  }
  if (task.status !== 'success') {
    await api.cancel(task.id).catch(() => {});
    return { ok: false, error: task.status === 'failed' ? task.output || 'failed' : NO_ANSWER };
  }
  try {
    return { ok: true, ms: Date.now() - started, reply: JSON.parse(task.output ?? '{}') as PingReply };
  } catch {
    return { ok: true, ms: Date.now() - started };
  }
}

export interface Responder {
  stop(): void;
}

/** Checks in with the host and answers pings for `agent` until stopped. */
export function startResponder(api: Api, { agent, via }: { agent: string; via: string }, { pollMs = 1_000, beatMs = 20_000 } = {}): Responder {
  let stopped = false;
  const beat = () => api.heartbeat({ agent, version: VERSION, platform, via }).catch(() => {});
  void beat();
  const beatTimer = setInterval(beat, beatMs);
  beatTimer.unref?.();

  async function answer(task: Task): Promise<void> {
    let payload: PingPayload = { from: task.from ?? '' };
    try {
      payload = { ...payload, ...(JSON.parse(task.context || '{}') as PingPayload) };
    } catch {
      // a plain ping
    }
    const links = payload.relayTo?.length
      ? await Promise.all(
          payload.relayTo.map(async (to): Promise<Link> => {
            const r = await pingAgent(api, agent, to, { timeoutMs: payload.timeoutMs });
            return { from: agent, to, ok: r.ok, ms: r.ms, error: r.error };
          })
        )
      : undefined;
    const reply: PingReply = { agent, version: VERSION, platform, ...(links ? { links } : {}) };
    await api.complete(task.id, { output: JSON.stringify(reply) }).catch(() => {});
  }

  void (async () => {
    while (!stopped) {
      try {
        let task: Task | null;
        while (!stopped && (task = await api.claimNext({ by: agent, kind: 'ping' }))) void answer(task);
      } catch {
        // host away: keep trying
      }
      await Bun.sleep(pollMs);
    }
  })();

  return {
    stop() {
      stopped = true;
      clearInterval(beatTimer);
    },
  };
}
