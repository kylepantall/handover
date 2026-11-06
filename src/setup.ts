/**
 * `handover setup`: run the relay here or join one, name this agent, and wire
 * up Claude Code. Interactive on a terminal; flags make it scriptable.
 */

import * as ui from '@clack/prompts';
import { claudeRegistration, hookInstalled, installHook, registerWithClaude } from './claude.ts';
import { probe } from './client.ts';
import { agentName, DEFAULT_PORT, loadConfig, saveConfig } from './config.ts';
import { formatChecks, runChecks } from './doctor.ts';
import type { Paths } from './paths.ts';
import { generateToken, lanAddresses } from './server.ts';
import { installService, serviceSupported } from './service.ts';
import { validateAgent } from './store.ts';
import { TUNNELS, type Config, type Tunnel } from './types.ts';

export interface SetupOptions {
  /** Run the relay on this machine. */
  relay?: boolean;
  /** Join the relay at this URL. */
  join?: string;
  token?: string;
  port?: number;
  tunnel?: Tunnel;
  agent?: string;
  /** Register the MCP server with Claude Code. */
  claude?: boolean;
  /** Add the SessionStart hook to Claude Code. */
  hook?: boolean;
  /** Start the relay at login (relay mode; default yes where supported). */
  service?: boolean;
}

const INSTALL_URL = 'https://raw.githubusercontent.com/kylepantall/handover/main/scripts/install.sh';

function bail<T>(value: T): Exclude<T, symbol> {
  if (ui.isCancel(value)) {
    ui.cancel('Setup cancelled; nothing was saved.');
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
}

function validUrl(value: string | undefined): string | undefined {
  try {
    const u = new URL(value ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:' ? undefined : 'Use an http:// or https:// URL';
  } catch {
    return 'Enter a URL like http://192.168.1.20:7777';
  }
}

function validAgent(value: string | undefined): string | undefined {
  try {
    validateAgent(value, 'agent name');
    return value ? undefined : 'Enter a name';
  } catch {
    return 'Letters, digits and . _ @ : - only (max 64)';
  }
}

async function waitForRelay(url: string, token: string, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await probe({ url, token })) === 'ok') return true;
    await Bun.sleep(250);
  }
  return false;
}

function joinHint(config: Config): string {
  const port = config.relay?.port ?? DEFAULT_PORT;
  const url = lanAddresses().map((ip) => `http://${ip}:${port}`)[0] ?? `http://<this-machine>:${port}`;
  return [
    'On each other machine, run:',
    '',
    `  curl -fsSL ${INSTALL_URL} | bash -s -- --join ${url} --token ${config.token}`,
    '',
    config.relay?.tunnel ? `Off your network, use the ${config.relay.tunnel} URL from: handover service log` : 'Off your network: rerun setup with a tunnel (tailscale or cloudflared).',
  ].join('\n');
}

/** Applies a finished set of answers: config, service, Claude Code. */
async function apply(p: Paths, config: Config, opts: SetupOptions, say: (msg: string) => void): Promise<void> {
  await saveConfig(p, config);
  say(`Saved ${p.config}`);

  if (config.relay && opts.service) {
    await installService();
    say((await waitForRelay(config.url!, config.token!)) ? 'Relay started and will run at login' : 'Relay service installed, but it is not answering yet (handover doctor)');
  }
  if (opts.claude) {
    if ((await claudeRegistration()) === 'registered') say('Claude Code: MCP server already registered');
    else {
      await registerWithClaude();
      say('Claude Code: registered "handover" (user scope); start a new session to load it');
    }
  }
  if (opts.hook) say((await installHook()) === 'added' ? 'Claude Code: SessionStart hook added' : 'Claude Code: SessionStart hook already present');
}

export async function runSetup(p: Paths, opts: SetupOptions): Promise<number> {
  const existing = await loadConfig(p);
  const scripted = opts.relay || opts.join;

  if (scripted) {
    if (opts.relay && opts.join) throw new Error('use --relay or --join, not both');
    const config: Config = { ...existing, agent: opts.agent ?? agentName(existing) };
    validateAgent(config.agent, 'agent name');
    if (opts.relay) {
      const port = opts.port ?? existing.relay?.port ?? DEFAULT_PORT;
      config.relay = { ...existing.relay, port, ...(opts.tunnel ? { tunnel: opts.tunnel } : {}) };
      config.url = `http://127.0.0.1:${port}`;
      config.token = opts.token ?? existing.token ?? generateToken();
    } else {
      if (validUrl(opts.join)) throw new Error(`invalid --join URL: ${opts.join}`);
      if (!opts.token) throw new Error('--join needs --token');
      config.url = opts.join!.replace(/\/+$/, '');
      config.token = opts.token;
      delete config.relay;
      const state = await probe({ url: config.url, token: config.token });
      if (state !== 'ok') console.warn(`warning: relay ${config.url} is ${state}; saved anyway`);
    }
    await apply(p, config, { ...opts, service: opts.relay ? (opts.service ?? serviceSupported()) : false }, (m) => console.log(m));
    if (opts.relay) console.log(`\n${joinHint(config)}`);
    return 0;
  }

  if (!process.stdin.isTTY) throw new Error('setup needs a terminal, or flags: --relay | --join <url> --token <token>');

  ui.intro('handover setup');
  const role = bail(
    await ui.select({
      message: 'What should this machine do?',
      initialValue: existing.relay || !existing.url ? 'relay' : 'join',
      options: [
        { value: 'relay', label: 'Run the relay here', hint: 'other machines connect to this one' },
        { value: 'join', label: 'Connect to a relay on another machine' },
      ],
    })
  );

  const config: Config = { ...existing };
  const choices: SetupOptions = {};
  if (role === 'relay') {
    const port = Number(
      bail(
        await ui.text({
          message: 'Port',
          initialValue: String(existing.relay?.port ?? DEFAULT_PORT),
          validate: (v) => (/^\d{2,5}$/.test(v ?? '') && Number(v) < 65536 ? undefined : 'Enter a port number'),
        })
      )
    );
    const installed = TUNNELS.filter((t) => Bun.which(t));
    const tunnel = bail(
      await ui.select<Tunnel | 'none'>({
        message: 'Reach it from outside your network?',
        initialValue: existing.relay?.tunnel ?? 'none',
        options: [
          { value: 'none', label: 'No, same network only' },
          ...installed.map((t) => ({
            value: t,
            label: t === 'tailscale' ? 'Tailscale Funnel' : 'Cloudflare quick tunnel',
            hint: t === 'tailscale' ? 'stable URL' : 'new URL each restart',
          })),
        ],
      })
    );
    config.relay = { ...existing.relay, port };
    if (tunnel === 'none') delete config.relay.tunnel;
    else config.relay.tunnel = tunnel;
    config.url = `http://127.0.0.1:${port}`;
    config.token = existing.token ?? generateToken();
    if (serviceSupported())
      choices.service = bail(await ui.confirm({ message: 'Start the relay now and at every login?', initialValue: true }));
  } else {
    config.url = bail(
      await ui.text({ message: 'Relay URL', placeholder: 'http://192.168.1.20:7777', initialValue: existing.relay ? '' : existing.url, validate: validUrl })
    ).replace(/\/+$/, '');
    config.token = bail(await ui.password({ message: 'Relay token (printed by setup on the relay machine)', validate: (v) => (v ? undefined : 'Required') }));
    delete config.relay;
    const s = ui.spinner();
    s.start('Checking the relay');
    const state = await probe({ url: config.url, token: config.token });
    s.stop(state === 'ok' ? 'Relay reachable, token accepted' : `Relay is ${state}`);
    if (state !== 'ok' && !bail(await ui.confirm({ message: 'Save anyway?', initialValue: false }))) {
      ui.cancel('Nothing saved.');
      return 1;
    }
  }

  config.agent = bail(
    await ui.text({ message: 'Name for this machine’s agent (used to address tasks to it)', initialValue: agentName(existing), validate: validAgent })
  );

  const claude = await claudeRegistration();
  if (claude !== 'no-claude') {
    choices.claude =
      claude === 'registered' || bail(await ui.confirm({ message: 'Add the handover MCP server to Claude Code?', initialValue: true }));
    if (!(await hookInstalled().catch(() => false)))
      choices.hook = bail(await ui.confirm({ message: 'Show pending handovers when a Claude Code session starts?', initialValue: true }));
  }

  await apply(p, config, choices, (m) => ui.log.success(m));
  if (role === 'relay') ui.note(joinHint(config), 'Connect other machines');
  ui.note(formatChecks(await runChecks(p, { offline: true })), 'handover doctor');
  ui.outro('Done. Hand something over: handover wait --objective "…"');
  return 0;
}
