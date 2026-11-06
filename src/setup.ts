/**
 * `handover setup`: run the relay here or join one, name this agent, and wire
 * up Claude Code. Interactive on a terminal; flags make it scriptable.
 */

import * as ui from '@clack/prompts';
import { existsSync } from 'node:fs';
import { claudeRegistration, hookInstalled, installHook, registerWithClaude } from './claude.ts';
import { probe } from './client.ts';
import { agentName, DEFAULT_PORT, loadConfig, saveConfig } from './config.ts';
import { formatChecks, runChecks } from './doctor.ts';
import type { Paths } from './paths.ts';
import { PeerBrowser } from './discovery.ts';
import { formatLink, linkInfo } from './link.ts';
import { generateToken } from './server.ts';
import { installService, serviceSupported } from './service.ts';
import { validateAgent } from './store.ts';
import { TUNNELS, type Config, type Tunnel } from './types.ts';

export interface SetupOptions {
  /** Run the relay on this machine. */
  relay?: boolean;
  /** Join the relay at this URL. */
  join?: string;
  /** Peer-to-peer on this network: every machine runs its own relay and peers find each other by mDNS. */
  peer?: boolean;
  token?: string;
  port?: number;
  tunnel?: Tunnel;
  agent?: string;
  /** Register the MCP server with Claude Code. */
  claude?: boolean;
  /** Add the SessionStart hook to Claude Code. */
  hook?: boolean;
  /** Start the relay at login (relay and peer mode; default yes where supported). */
  service?: boolean;
}

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

/** Peers already on this network with the same secret (agent names). */
async function findPeers(token: string, self: string): Promise<string[]> {
  const browser = new PeerBrowser(token, { settleMs: 2500 });
  await browser.ready;
  const names = browser.peers().map((p) => p.agent).filter((a) => a !== self);
  browser.stop();
  return [...new Set(names)];
}

const joinHint = (config: Config) => formatLink(linkInfo(config));

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
  const scripted = opts.relay || opts.join || opts.peer;

  // Only Claude Code wiring requested (e.g. installer --claude on an existing setup).
  if (!scripted && (opts.claude || opts.hook) && existsSync(p.config)) {
    await apply(p, existing, { claude: opts.claude, hook: opts.hook }, (m) => console.log(m));
    return 0;
  }

  if (scripted) {
    if ([opts.relay, opts.join, opts.peer].filter(Boolean).length > 1) throw new Error('use one of --relay, --join or --peer');
    const config: Config = { ...existing, agent: opts.agent ?? agentName(existing) };
    validateAgent(config.agent, 'agent name');
    if (opts.relay || opts.peer) {
      const port = opts.port ?? existing.relay?.port ?? DEFAULT_PORT;
      config.relay = { ...existing.relay, port, ...(opts.tunnel ? { tunnel: opts.tunnel } : {}) };
      config.url = `http://127.0.0.1:${port}`;
      // A relay token from a joined machine belongs to that relay, not to a new peer network.
      const reusable = opts.peer ? existing.peer && existing.token : existing.relay && existing.token;
      config.token = opts.token ?? (reusable || generateToken());
      if (opts.peer) config.peer = true;
      else delete config.peer;
    } else {
      if (validUrl(opts.join)) throw new Error(`invalid --join URL: ${opts.join}`);
      if (!opts.token) throw new Error('--join needs --token');
      config.url = opts.join!.replace(/\/+$/, '');
      config.token = opts.token;
      delete config.relay;
      delete config.peer;
      const state = await probe({ url: config.url, token: config.token });
      if (state !== 'ok') console.warn(`warning: relay ${config.url} is ${state}; saved anyway`);
    }
    const runsRelay = Boolean(opts.relay || opts.peer);
    await apply(p, config, { ...opts, service: runsRelay ? (opts.service ?? serviceSupported()) : false }, (m) => console.log(m));
    if (opts.peer) {
      const found = await findPeers(config.token!, config.agent!);
      console.log(found.length ? `Peers on this network: ${found.join(', ')}` : 'No other peers seen yet.');
    }
    if (runsRelay) console.log(`\n${joinHint(config)}`);
    return 0;
  }

  if (!process.stdin.isTTY) throw new Error('setup needs a terminal, or flags: --peer | --relay | --join <url> --token <token>');

  ui.intro('handover setup');
  const role = bail(
    await ui.select({
      message: 'How should this machine connect?',
      initialValue: existing.peer || (!existing.url && !existing.relay) ? 'peer' : existing.relay ? 'relay' : 'join',
      options: [
        { value: 'peer', label: 'Peer-to-peer on this network', hint: 'fastest: no addresses, just a shared secret' },
        { value: 'relay', label: 'Run a relay here', hint: 'one hub; works across networks with a tunnel' },
        { value: 'join', label: 'Connect to a relay on another machine' },
      ],
    })
  );

  const config: Config = { ...existing };
  const choices: SetupOptions = {};
  if (role === 'peer') {
    const first = bail(
      await ui.select({
        message: 'Shared secret',
        initialValue: existing.peer && existing.token ? 'keep' : 'new',
        options: [
          ...(existing.peer && existing.token ? [{ value: 'keep', label: 'Keep the current secret' }] : []),
          { value: 'new', label: 'This is the first machine: create a secret' },
          { value: 'enter', label: 'Join other peers: enter their secret', hint: 'handover token on a peer prints it' },
        ],
      })
    );
    if (first === 'new') config.token = generateToken();
    else if (first === 'enter') config.token = bail(await ui.password({ message: 'Secret', validate: (v) => (v ? undefined : 'Required') }));
    config.peer = true;
    config.relay = { ...existing.relay, port: existing.relay?.port ?? DEFAULT_PORT };
    config.url = `http://127.0.0.1:${config.relay.port}`;
    if (first === 'enter') {
      const s = ui.spinner();
      s.start('Looking for peers with this secret');
      const found = await findPeers(config.token!, agentName(existing));
      s.stop(found.length ? `Found: ${found.join(', ')}` : 'No peers seen yet (they may be off); continuing');
    }
    choices.service = serviceSupported()
      ? bail(await ui.confirm({ message: 'Start this machine’s peer relay now and at every login? (needed to send handovers)', initialValue: true }))
      : false;
  } else if (role === 'relay') {
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
    config.token = (existing.relay && !existing.peer && existing.token) || generateToken();
    delete config.peer;
    if (serviceSupported())
      choices.service = bail(await ui.confirm({ message: 'Start the relay now and at every login?', initialValue: true }));
  } else {
    config.url = bail(
      await ui.text({ message: 'Relay URL', placeholder: 'http://192.168.1.20:7777', initialValue: existing.relay ? '' : existing.url, validate: validUrl })
    ).replace(/\/+$/, '');
    config.token = bail(await ui.password({ message: 'Relay token (printed by setup on the relay machine)', validate: (v) => (v ? undefined : 'Required') }));
    delete config.relay;
    delete config.peer;
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
  if (role !== 'join') ui.note(joinHint(config), 'Connect other machines');
  ui.note(formatChecks(await runChecks(p, { offline: true })), 'handover doctor');
  ui.outro('Done. Hand something over: handover wait --objective "…"');
  return 0;
}
