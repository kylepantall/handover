import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Api, Task, TaskSummary } from './types.ts';
import { VERSION } from './version.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const safe =
  <A>(fn: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
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
export function buildMcpServer(api: Api, { agentName = 'mcp-client' }: { agentName?: string } = {}): McpServer {
  const server = new McpServer({ name: 'handover', version: VERSION });

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
      description: 'Delegate a task to another agent. Returns an id; a client can run `handover wait --id <id>` or you can poll handover_get.',
      inputSchema: {
        objective: z.string(),
        context: z.string().optional(),
        id: z.string().optional(),
        to: z.string().optional().describe('Only this agent name may claim it'),
        priority: z.number().int().min(-1000).max(1000).optional().describe('Higher is picked up first (default 0)'),
      },
    },
    safe(async ({ objective, context, id, to, priority }) => {
      const t = await api.create({ objective, context, id, to, priority, from: agentName });
      return text({ id: t.id, status: t.status, to: t.to, priority: t.priority });
    })
  );

  return server;
}
