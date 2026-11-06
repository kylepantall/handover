/**
 * `handover join [relay-url]`: connect an installed machine in one step.
 * No URL: join peers on this network. With a URL: join that relay. The secret
 * comes from a hidden prompt or HANDOVER_TOKEN, never the command line, which
 * process lists and antivirus logs record.
 */

import * as ui from '@clack/prompts';
import { claudeRegistration } from './claude.ts';
import type { Paths } from './paths.ts';
import { runSetup } from './setup.ts';

export interface JoinOptions {
  target?: string;
  agent?: string;
  service?: boolean;
}

export const isRelayUrl = (s: string) => /^https?:\/\//i.test(s);

export async function runJoin(p: Paths, { target, agent, service }: JoinOptions): Promise<number> {
  if (target && !isRelayUrl(target))
    throw new Error(
      'don’t put the secret on the command line (process lists and antivirus logs record it). Run `handover join` and paste it when asked, or set HANDOVER_TOKEN.'
    );
  let token = process.env.HANDOVER_TOKEN || undefined;
  if (!token) {
    if (!process.stdin.isTTY) throw new Error('no secret: set HANDOVER_TOKEN, or run handover join in a terminal');
    const answer = await ui.password({
      message: target ? `Token for ${target}` : 'Peer secret (`handover token` on a machine already set up prints it)',
      validate: (v) => (v ? undefined : 'Required'),
    });
    if (ui.isCancel(answer)) {
      ui.cancel('Nothing changed.');
      return 1;
    }
    token = answer;
  }
  const claude = (await claudeRegistration()) !== 'no-claude';
  return runSetup(p, {
    peer: !target,
    join: target,
    token,
    agent,
    claude,
    hook: claude,
    service,
  });
}
