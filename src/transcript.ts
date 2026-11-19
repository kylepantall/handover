import type { TranscriptEntry } from './types.ts';

const MAX_ENTRIES = 512;
const MAX_CHARS = 192_000;
const MAX_TASKS = 128;

type Log = {
  entries: TranscriptEntry[];
  length: number;
  discardedThrough: number;
  workerAttempt?: number;
  workerCursor: number;
};

/** Recent transcript text stays in memory. The queue file still holds the final result. */
export class Transcripts {
  #logs = new Map<string, Log>();
  #seq = 0;

  append(id: string, entries: Omit<TranscriptEntry, 'seq'>[]): void {
    if (!entries.length) return;
    const log = this.#get(id);
    for (const entry of entries) {
      log.entries.push({ ...entry, seq: ++this.#seq });
      log.length += entry.text.length;
    }
    while (log.entries.length > MAX_ENTRIES || log.length > MAX_CHARS) {
      const removed = log.entries.shift()!;
      log.length -= removed.text.length;
      log.discardedThrough = removed.seq;
    }
  }

  worker(id: string, attempt: number, chunks: Array<{ seq: number; messageId: string; text: string }>): void {
    if (!chunks.length) return;
    const log = this.#get(id);
    if (log.workerAttempt !== attempt) {
      log.workerAttempt = attempt;
      log.workerCursor = 0;
    }
    const fresh: Omit<TranscriptEntry, 'seq'>[] = [];
    for (const chunk of chunks) {
      if (chunk.seq <= log.workerCursor) continue;
      log.workerCursor = chunk.seq;
      fresh.push({ attempt, role: 'assistant', messageId: chunk.messageId, text: chunk.text });
    }
    this.append(id, fresh);
  }

  page(id: string, after: number) {
    const log = this.#logs.get(id);
    const entries = log?.entries ?? [];
    const events = entries.filter((entry) => entry.seq > after).slice(0, 64);
    return {
      events,
      cursor: events.at(-1)?.seq ?? after,
      truncated: (log?.discardedThrough ?? 0) > after,
    };
  }

  delete(id: string): void {
    this.#logs.delete(id);
  }

  #get(id: string): Log {
    const log = this.#logs.get(id) ?? { entries: [], length: 0, discardedThrough: 0, workerCursor: 0 };
    this.#logs.delete(id);
    this.#logs.set(id, log);
    if (this.#logs.size > MAX_TASKS) this.#logs.delete(this.#logs.keys().next().value!);
    return log;
  }
}
