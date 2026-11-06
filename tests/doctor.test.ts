import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from '../src/doctor.ts';
import { paths } from '../src/paths.ts';
import { serviceState } from '../src/service.ts';

test('an idle on-demand relay is not a doctor failure', async () => {
  // Machine-wide: a developer's own installed service changes the answer, so only check clean machines (CI).
  if ((await serviceState()) !== 'not-installed') return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handover-doctor-'));
  try {
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ token: 't', agent: 'd', url: 'http://127.0.0.1:1', relay: { port: 1 } })
    );
    const relay = (await runChecks(paths(dir), { offline: true })).find((c) => c.area === 'relay');
    expect(relay?.status).toBe('info');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
