import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { AgentKind, TranscriptChunk } from './types.ts';

export type SendInput = (message: string) => Promise<void>;

type StreamOptions = {
  kind: AgentKind;
  stdin: Writable;
  prompt: string;
  cwd: string;
  fullAccess: boolean;
  transcript(chunk: TranscriptChunk): void;
  ready(send: SendInput): void;
  finish(code: number, output: string): void;
};

const send = (stream: Writable, value: unknown): Promise<void> => new Promise((resolve, reject) => {
  stream.write(JSON.stringify(value) + '\n', (error) => error ? reject(error) : resolve());
});

function claude(o: StreamOptions) {
  // Claude acknowledges each user message with --replay-user-messages, then emits a result for its turn.
  const queued = new Set<string>();
  let messageId = 'claude';
  let counter = 0;
  const streamed = new Set<string>();
  const write = async (text: string, followUp: boolean) => {
    const uuid = randomUUID();
    if (followUp) queued.add(uuid);
    try {
      await send(o.stdin, {
        type: 'user', uuid, parent_tool_use_id: null, session_id: '',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
    } catch (error) {
      queued.delete(uuid);
      throw error;
    }
  };
  const textBlock = (id: string, text: unknown) => {
    if (typeof text === 'string' && text) o.transcript({ messageId: id, text });
  };

  void write(o.prompt, false).then(() => o.ready((message) => write(message, true)), () => o.finish(1, 'Could not send the briefing to Claude Code.'));
  return (frame: any) => {
    if (frame.type === 'user' && frame.isReplay === true) {
      queued.delete(frame.uuid);
    } else if (frame.type === 'stream_event') {
      const event = frame.event;
      if (event?.type === 'message_start') {
        messageId = event.message?.id ?? `claude-${++counter}`;
        streamed.clear();
      } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const id = `${messageId}-${event.index}`;
        streamed.add(id);
        textBlock(id, event.delta.text);
      }
    } else if (frame.type === 'assistant' && Array.isArray(frame.message?.content)) {
      for (const [i, block] of frame.message.content.entries()) {
        const id = `${frame.message.id ?? messageId}-${i}`;
        if (block?.type === 'text' && !streamed.has(id)) textBlock(id, block.text);
      }
    } else if (frame.type === 'result' && (frame.is_error || queued.size === 0)) {
      o.finish(frame.is_error ? 1 : 0, typeof frame.result === 'string' ? frame.result : 'Claude Code ended the turn.');
    }
  };
}

function codex(o: StreamOptions) {
  let nextId = 0;
  let threadId: string;
  let turnId: string;
  let latest = '';
  const streamed = new Set<string>();
  const pending = new Map<number, (response?: any) => void>();
  const rpc = (method: string, params: object, timeout = 30_000): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex did not answer ${method}.`));
    }, timeout);
    timer.unref?.();
    pending.set(id, (response) => {
      clearTimeout(timer);
      pending.delete(id);
      if (response?.error || response === undefined) reject(new Error(`Codex declined ${method}.`));
      else resolve(response.result);
    });
    void send(o.stdin, { id, method, params }).catch(() => pending.get(id)?.());
  });

  const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
  const start = async () => {
    await rpc('initialize', { clientInfo: { name: 'handover', title: 'Handover', version: '1.0.0' }, capabilities: null });
    await send(o.stdin, { method: 'initialized' });
    const start = await rpc('thread/start', {
      cwd: o.cwd,
      approvalPolicy: 'never',
      sandbox: o.fullAccess ? 'danger-full-access' : 'workspace-write',
      ephemeral: true,
    });
    threadId = start.thread.id;
    const started = await rpc('turn/start', {
      threadId,
      input: text(o.prompt),
      sandboxPolicy: o.fullAccess ? { type: 'dangerFullAccess' } : {
        type: 'workspaceWrite', writableRoots: [o.cwd], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      },
    });
    turnId = started.turn.id;
    o.ready(async (message) => {
      await rpc('turn/steer', { threadId, expectedTurnId: turnId, input: text(message) }, 5000);
    });
  };
  void start().catch((error) => o.finish(1, error instanceof Error ? error.message : 'Could not start Codex.'));
  o.stdin.once('close', () => { for (const respond of pending.values()) respond(); });

  return (frame: any) => {
    if (typeof frame.id === 'number' && !frame.method) {
      pending.get(frame.id)?.(frame);
      return;
    }
    if (frame.method && frame.id != null) {
      // Worker input is user chat. Server requests for tool or permission approval remain unapproved.
      void send(o.stdin, { id: frame.id, error: { code: -32601, message: 'This worker does not handle agent-to-client requests.' } }).catch(() => {});
      return;
    }
    const params = frame.params;
    if (!threadId || params?.threadId !== threadId) return;
    if (frame.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.itemId === 'string') {
      streamed.add(params.itemId);
      o.transcript({ messageId: params.itemId, text: params.delta });
    } else if (frame.method === 'item/completed' && params.item?.type === 'agentMessage' &&
        typeof params.item.text === 'string' && typeof params.item.id === 'string') {
      latest = params.item.text;
      if (!streamed.has(params.item.id)) o.transcript({ messageId: params.item.id, text: latest });
    } else if (frame.method === 'turn/completed' && params.turn) {
      o.finish(params.turn.status === 'completed' ? 0 : 1, latest || 'Codex ended the turn.');
    }
  };
}

/** Read only text that the agent actually said. Reasoning, tool inputs and raw outputs stay local. */
export function agentStream(o: StreamOptions): (line: string) => void {
  const handle = o.kind === 'codex' ? codex(o) : claude(o);
  return (line) => {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame && typeof frame === 'object') handle(frame);
  };
}
