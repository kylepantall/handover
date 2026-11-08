import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { groupDevices } from './devices.ts';
import { isTerminal } from './store.ts';
import type { Api, Task, TaskSummary } from './types.ts';
import { VERSION } from './version.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const safe =
  <A>(fn: (args: A, extra?: { signal?: AbortSignal }) => Promise<ToolResult>) =>
  async (args: A, extra?: { signal?: AbortSignal }): Promise<ToolResult> => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] };
    }
  };

const brief = (t: Task | TaskSummary) => ({
  id: t.id,
  objective: t.objective,
  status: t.status,
  priority: t.priority,
  to: t.to,
  from: t.from,
  createdAt: t.createdAt,
});
const toMs = (seconds: number | undefined) => (seconds == null ? undefined : seconds * 1000);
const leaseSeconds = z.number().int().positive().max(86_400).optional().describe('Lease length in seconds (default set by the relay)');

/** The prompt an agent gets for a claimed task. */
export function briefing(task: Task): string {
  const lines = [
    `# Handover ${task.id}`,
    '',
    '## Objective',
    task.objective,
    '',
    '## Context',
    task.context || '(none)',
    '',
    '## When finished',
    `Call the \`handover_complete\` tool with id "${task.id}", your final output, and any files`,
    '(utf8 text, or base64 for binary). Use status "failed" with an explanation if you cannot finish.',
  ];
  if (task.leaseExpiresAt)
    lines.push(`Your claim expires at ${task.leaseExpiresAt}; call \`handover_renew\` for long work or the task returns to the queue.`);
  return lines.join('\n');
}

/** Builds an MCP server whose tools operate on `api` (local store or remote relay) as `agentName`. */
export function buildMcpServer(api: Api, { agentName = 'mcp-client', instructions }: { agentName?: string; instructions?: string } = {}): McpServer {
  const server = new McpServer({ name: 'handover', version: VERSION }, instructions ? { instructions } : undefined);

  server.registerTool(
    'handover_list',
    {
      title: 'List handovers',
      description: 'List handover tasks you can pick up (default: pending), highest priority first.',
      inputSchema: { status: z.enum(['pending', 'claimed', 'success', 'failed', 'cancelled', 'all']).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ status = 'pending' }) => {
      const tasks = await api.list({ status: status === 'all' ? undefined : status, agent: agentName });
      return text(tasks.length ? tasks.map(brief) : 'No handovers.');
    })
  );

  server.registerTool(
    'handover_devices',
    {
      title: 'List connected devices',
      description:
        'List the paired machines: online or not, what is running, and the agents there. Only these names and agent addresses (e.g. codex@pc) are accepted as `to` in handover_create.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    safe(async () => text(groupDevices(await api.agents({ all: true }))))
  );

  server.registerTool(
    'handover_next',
    {
      title: 'Take the next handover',
      description:
        'Claim the highest-priority pending handover addressed to you (or anyone). Returns its briefing, or says the queue is empty.',
      inputSchema: { leaseSeconds },
    },
    safe(async ({ leaseSeconds: s }) => {
      const task = await api.claimNext({ by: agentName, leaseMs: toMs(s) });
      return text(task ? briefing(task) : 'Queue is empty.');
    })
  );

  server.registerTool(
    'handover_watch',
    {
      title: 'Wait for the next handover',
      description:
        'Wait for a handover addressed to you (or anyone) to arrive, claim it and return its briefing. Returns "No handover yet." after timeoutSeconds: call again to keep watching. Use it when the user asks you to watch for or keep taking handovers.',
      inputSchema: {
        // Codex gives an MCP tool call 60 s by default.
        timeoutSeconds: z.number().int().positive().max(600).optional().describe('How long to wait (default 50)'),
        leaseSeconds,
      },
    },
    safe(async ({ timeoutSeconds = 50, leaseSeconds: s }, extra?: { signal?: AbortSignal }) => {
      const end = Date.now() + timeoutSeconds * 1000;
      for (;;) {
        const task = await api.claimNext({ by: agentName, leaseMs: toMs(s) });
        if (task) return text(briefing(task));
        if (Date.now() >= end || extra?.signal?.aborted) return text('No handover yet.');
        await Bun.sleep(Math.min(1000, end - Date.now()));
      }
    })
  );

  server.registerTool(
    'handover_wait',
    {
      title: 'Wait for a handover to finish',
      description:
        'Wait for a handover you created to finish and return its result (output and files). Returns its current status after timeoutSeconds if it is still running: call again to keep waiting.',
      inputSchema: {
        id: z.string(),
        // Codex gives an MCP tool call 60 s by default.
        timeoutSeconds: z.number().int().positive().max(600).optional().describe('How long to wait (default 50)'),
      },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ id, timeoutSeconds = 50 }, extra) => {
      const end = Date.now() + timeoutSeconds * 1000;
      let task = await api.get(id);
      while (!isTerminal(task.status) && Date.now() < end && !extra?.signal?.aborted) task = await api.wait(id, Math.min(25_000, end - Date.now()));
      if (isTerminal(task.status)) return text(task);
      return text({ id: task.id, status: task.status, claimedBy: task.claimedBy, note: 'Not finished yet: call handover_wait again.' });
    })
  );

  server.registerTool(
    'handover_claim',
    {
      title: 'Claim a handover',
      description: 'Claim a specific pending handover by id and receive its objective and context. Then do the work and call handover_complete.',
      inputSchema: { id: z.string(), leaseSeconds },
    },
    safe(async ({ id, leaseSeconds: s }) => text(briefing(await api.claim(id, { by: agentName, leaseMs: toMs(s) }))))
  );

  server.registerTool(
    'handover_renew',
    {
      title: 'Renew a claim',
      description: 'Extend your claim on a handover you are still working on, so it is not returned to the queue.',
      inputSchema: { id: z.string(), leaseSeconds },
    },
    safe(async ({ id, leaseSeconds: s }) => {
      const t = await api.renew(id, { by: agentName, leaseMs: toMs(s) });
      return text({ id: t.id, leaseExpiresAt: t.leaseExpiresAt });
    })
  );

  server.registerTool(
    'handover_get',
    {
      title: 'Get a handover',
      description: 'Read a handover task (objective, context, status, and result if finished) without claiming it.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ id }) => text(await api.get(id)))
  );

  server.registerTool(
    'handover_complete',
    {
      title: 'Complete a handover',
      description: 'Finish a handover: send the output and any files back to the waiting client. This unblocks it immediately.',
      inputSchema: {
        id: z.string(),
        output: z.string().describe('Final answer / summary for the waiting client'),
        status: z.enum(['success', 'failed']).optional(),
        files: z
          .array(
            z.object({
              name: z.string().describe('Flat file name, e.g. report.md (no directories)'),
              content: z.string(),
              encoding: z.enum(['utf8', 'base64']).optional(),
            })
          )
          .optional(),
      },
    },
    safe(async ({ id, output, status = 'success', files = [] }) => {
      const t = await api.complete(id, { output, status, files });
      return text(`Handover ${t.id} marked ${t.status} with ${t.files.length} file(s). The waiting client has been notified.`);
    })
  );

  server.registerTool(
    'handover_create',
    {
      title: 'Create a handover',
      description:
        'Delegate a task to another agent (another machine, or Codex / Claude Code on this one). Returns an id and how to be woken when it finishes.',
      inputSchema: {
        objective: z.string(),
        context: z.string().optional(),
        id: z.string().optional(),
        to: z
          .string()
          .optional()
          .describe('Who may take it. Must be paired: use a name from handover_devices, never a guess. A machine ("pc"), an agent anywhere ("codex", "claude"), or one agent on one machine ("codex@pc"). Default: anyone'),
        priority: z.number().int().min(-1000).max(1000).optional().describe('Higher is picked up first (default 0)'),
      },
    },
    safe(async ({ objective, context, id, to, priority }) => {
      const t = await api.create({ objective, context, id, to, priority, from: agentName });
      return text({
        id: t.id,
        status: t.status,
        to: t.to,
        priority: t.priority,
        whenDone: `To be woken when it finishes, run \`handover wait --id ${t.id} --out handover-${t.id}\` as a background command (Claude Code: Bash with run_in_background): it exits with the output and saves the files. Without background commands, call handover_wait.`,
      });
    })
  );

  return server;
}
