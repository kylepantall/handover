import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [kind, mode] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
const emit = (frame: object) => console.log(JSON.stringify(frame));
const reply = (id: number, result: object) => emit({ id, result });
const notify = (method: string, params: object) => emit({ method, params: { threadId: 'thread-1', ...params } });
const textOf = (input: string) => input.includes('please fail') ? 'FAILED: could not' : `done by ${kind}: ${input.split('\n')[0]}`;
let promptSeen = false;

function claudeText(text: string, id: string) {
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  emit({ type: 'assistant', message: { id, content: [{ type: 'text', text }, { type: 'thinking', thinking: 'private reasoning' }] } });
}

function codexText(text: string, itemId: string) {
  notify('item/agentMessage/delta', { turnId: 'turn-1', itemId, delta: text });
  notify('item/completed', { item: { type: 'agentMessage', id: itemId, text } });
}

lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (kind === 'claude') {
    emit({ ...frame, isReplay: true });
    const text = frame.message.content[0].text;
    if (mode === 'wait' && !promptSeen) {
      promptSeen = true;
      return claudeText('Agent is working.', 'assistant-1');
    }
    const result = mode === 'wait' ? `Received: ${text}` : textOf(text);
    claudeText(result, 'assistant-2');
    emit({ type: 'result', result, is_error: false });
    return;
  }

  switch (frame.method) {
    case 'initialize':
      reply(frame.id, {});
      break;
    case 'thread/start':
      if (process.env.FAKE_STATE) writeFileSync(join(process.env.FAKE_STATE, 'codex.thread'), JSON.stringify(frame.params));
      reply(frame.id, { thread: { id: 'thread-1' } });
      break;
    case 'turn/start': {
      if (process.env.FAKE_STATE) writeFileSync(join(process.env.FAKE_STATE, 'codex.turn'), JSON.stringify(frame.params.sandboxPolicy));
      reply(frame.id, { turn: { id: 'turn-1' } });
      notify('item/completed', { item: { type: 'reasoning', content: ['private reasoning'] } });
      if (mode === 'wait') {
        codexText('Agent is working.', 'assistant-1');
        break;
      }
      codexText(textOf(frame.params.input[0].text), 'assistant-2');
      notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      break;
    }
    case 'turn/steer':
      if (frame.params.expectedTurnId !== 'turn-1') {
        emit({ id: frame.id, error: { code: -1, message: 'wrong turn' } });
        break;
      }
      reply(frame.id, { turnId: 'turn-1' });
      codexText(`Received: ${frame.params.input[0].text}`, 'assistant-2');
      notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      break;
  }
});
