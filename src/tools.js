import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] });
const safe = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

const brief = (t) => ({ id: t.id, objective: t.objective, status: t.status, from: t.from, createdAt: t.createdAt });

export function briefing(task) {
  return [
    `# Handover ${task.id}`,
    '',
    `## Objective`,
    task.objective,
    '',
    `## Context`,
    task.context || '(none)',
    '',
    `## When finished`,
    `Call the \`handover_complete\` tool with id "${task.id}", your final output, and any files`,
    `(utf8 text, or base64 for binary). Use status "failed" with an explanation if you cannot finish.`,
  ].join('\n');
}

/** Builds an MCP server whose tools operate on `api` (local store or remote relay). */
export function buildMcpServer(api, { agentName = 'mcp-client' } = {}) {
  const server = new McpServer({ name: 'handover', version: '0.1.0' });

  server.registerTool(
    'handover_list',
    {
      title: 'List handovers',
      description: 'List handover tasks waiting to be picked up (default: pending).',
      inputSchema: { status: z.enum(['pending', 'claimed', 'success', 'failed', 'cancelled', 'all']).optional() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ status = 'pending' }) => {
      const tasks = await api.list(status === 'all' ? undefined : status);
      return text(tasks.length ? tasks.map(brief) : 'No handovers.');
    }),
  );

  server.registerTool(
    'handover_claim',
    {
      title: 'Claim a handover',
      description:
        'Claim a pending handover by id and receive its objective and context. Then do the work and call handover_complete.',
      inputSchema: { id: z.string() },
    },
    safe(async ({ id }) => text(briefing(await api.claim(id, agentName)))),
  );

  server.registerTool(
    'handover_get',
    {
      title: 'Get a handover',
      description: 'Read a handover task (objective, context, status, and result if finished) without claiming it.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    safe(async ({ id }) => text(await api.get(id))),
  );

  server.registerTool(
    'handover_complete',
    {
      title: 'Complete a handover',
      description:
        'Finish a handover: send the output and any files back to the waiting client. This unblocks it immediately.',
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
            }),
          )
          .optional(),
      },
    },
    safe(async ({ id, output, status = 'success', files = [] }) => {
      const t = await api.complete(id, { output, status, files });
      return text(`Handover ${t.id} marked ${t.status} with ${t.files.length} file(s). The waiting client has been notified.`);
    }),
  );

  server.registerTool(
    'handover_create',
    {
      title: 'Create a handover',
      description:
        'Delegate a task to another agent. Returns an id; a client can run `handover wait --id <id>` or you can poll handover_get.',
      inputSchema: { objective: z.string(), context: z.string().optional(), id: z.string().optional() },
    },
    safe(async ({ objective, context, id }) => {
      const t = await api.create({ objective, context, id, from: agentName });
      return text({ id: t.id, status: t.status });
    }),
  );

  return server;
}
