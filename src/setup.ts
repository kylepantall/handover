/**
 * Setup, as specified in docs/flow.md: a machine is either the host (runs the
 * relay, shares its token) or a client (asks for the token, finds the host,
 * never runs a relay).
 *
 *   handover host            become the host; prints the token and join commands
 *   handover join [URL]      join a host: token from a prompt or HANDOVER_TOKEN
 *   handover setup           a menu offering the two
 */

import * as ui from '@clack/prompts';
import { existsSync } from 'node:fs';
import { ADAPTERS, describeAuto, installedAgents } from './agents.ts';
import { installHook } from './claude.ts';
import { probe } from './client.ts';
import { agentName, DEFAULT_PORT, loadConfig, roleOf, saveConfig } from './config.ts';
import { connect } from './connect.ts';
import { findHost } from './discovery.ts';
import { pingAgent, startResponder } from './responder.ts';
import { formatChecks, runChecks } from './doctor.ts';
import { formatLink, linkInfo } from './link.ts';
import type { Paths } from './paths.ts';
import { generateToken } from './server.ts';
import { installService, serviceByDefault, serviceIsOurs, serviceState, serviceSupported, uninstallService } from './service.ts';
import { validateAgent } from './store.ts';
import { TUNNELS, type AgentKind, type AutoPickup, type Config, type Tunnel } from './types.ts';

type Say = (message: string) => void;

const cancelled = <T>(value: T): Exclude<T, symbol> => {
  if (ui.isCancel(value)) {
    ui.cancel('Nothing changed.');
    process.exit(1);
  }
  return value as Exclude<T, symbol>;
};

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

/** Which coding agents to wire up and whether one takes handovers automatically. */
export interface AgentOptions {
  /** false: leave Claude Code alone. */
  claude?: boolean;
  /** false: leave Codex alone. */
  codex?: boolean;
  /** Auto-pickup agent, or 'off'. Unset: ask in a terminal, else keep the current choice. */
  auto?: AgentKind | 'off';
  /** Auto-pickup without the agent's permission prompts or sandbox. */
  fullAccess?: boolean;
  /** Login service: default on macOS/Linux, off on Windows (docs/flow.md). */
  service?: boolean;
}

const skipped = (o: AgentOptions, kind: AgentKind) => o[kind] === false;

/** Registers handover's MCP server with every installed agent (and Claude Code's SessionStart hook). */
async function wireAgents(o: AgentOptions, say: Say): Promise<void> {
  for (const a of installedAgents()) {
    if (skipped(o, a.kind)) continue;
    try {
      if ((await a.mcpState()) === 'registered') say(`${a.label}: MCP server already registered`);
      else {
        await a.register();
        say(`${a.label}: added the "handover" MCP server (start a new session to load it)`);
      }
      if (a.kind === 'claude' && (await installHook()) === 'added') say('Claude Code: pending handovers now show at session start');
    } catch (err) {
      say(`${a.label}: could not add the MCP server (${(err as Error).message}); see handover doctor`);
    }
  }
}

/** The auto-pickup setting after setup: from the flags, a prompt, or the current config. */
async function chooseAuto(existing: Config, o: AgentOptions, ask: boolean): Promise<AutoPickup | undefined> {
  const pick = (kind: AgentKind, keptFullAccess?: boolean): AutoPickup => ({
    with: kind,
    ...((o.fullAccess ?? keptFullAccess) ? { fullAccess: true } : {}),
  });
  if (o.auto === 'off') return undefined;
  if (o.auto) {
    if (skipped(o, o.auto)) throw new Error(`--auto ${o.auto} needs handover added to ${o.auto}: drop --no-${o.auto}`);
    if (!ADAPTERS[o.auto].bin()) throw new Error(`--auto ${o.auto}: the ${o.auto} CLI isn't installed here`);
    return pick(o.auto);
  }
  const agents = installedAgents().filter((a) => !skipped(o, a.kind));
  if (ask && agents.length) {
    const choice = cancelled(
      await ui.select<AgentKind | 'off'>({
        message: 'Take handovers automatically on this machine?',
        initialValue: existing.auto?.with ?? agents[0]!.kind,
        options: [
          ...agents.map((a) => ({ value: a.kind, label: `Yes, with ${a.label}`, hint: 'runs each task unattended, with your usual permission settings' })),
          { value: 'off' as const, label: 'No', hint: 'tasks wait until you ask an agent to pick them up' },
        ],
      })
    );
    if (choice === 'off') return undefined;
    return pick(choice, existing.auto?.with === choice ? existing.auto.fullAccess : undefined);
  }
  return existing.auto ? pick(existing.auto.with, existing.auto.fullAccess) : undefined;
}

/**
 * A client's login service exists only for auto-pickup: installs it when
 * auto-pickup is on (and the service is wanted), removes ours otherwise.
 * Returns whether auto-pickup runs at login.
 */
async function clientService(existing: Config, config: Config, o: AgentOptions, say: Say): Promise<boolean> {
  const ours = await serviceIsOurs();
  if (['running', 'stopped'].includes(await serviceState()) && !ours) {
    if (config.auto) say('A login service from another handover install exists; left alone');
    return false;
  }
  const kept = roleOf(existing) === 'client' && ours;
  if (config.auto && serviceSupported() && (o.service ?? (serviceByDefault() || kept))) {
    try {
      await installService();
      return true;
    } catch (err) {
      say(`Could not install the login service (${(err as Error).message})`);
      return false;
    }
  }
  if (ours) {
    await uninstallService().catch(() => {});
    say(roleOf(existing) === 'host' ? 'Removed this machine’s relay service (clients use the host’s relay)' : 'Removed the auto-pickup login service');
  }
  return false;
}

/** `handover auto [claude|codex|off]`: shows or changes auto-pickup. */
export async function runAuto(p: Paths, o: AgentOptions): Promise<number> {
  const existing = await loadConfig(p);
  const role = roleOf(existing);
  if (!role) throw new Error('not set up yet: handover host or handover join');
  const say: Say = (m) => console.log(m);
  if (o.auto === undefined && o.fullAccess === undefined) {
    const state = await serviceState();
    say(describeAuto(existing.auto, state === 'running' && (await serviceIsOurs())));
    return 0;
  }
  const auto = await chooseAuto(existing, o, false);
  const config: Config = { ...existing };
  if (auto) config.auto = auto;
  else delete config.auto;
  await saveConfig(p, config);
  let atLogin = false;
  if (role === 'client') atLogin = await clientService(existing, config, o, say);
  else if ((await serviceState()) === 'running' && (await serviceIsOurs())) {
    await installService(); // restart, so the relay service picks it up
    atLogin = true;
  }
  say(describeAuto(config.auto, atLogin));
  if (!atLogin && config.auto) say('Start a new Claude Code or Codex session to apply it.');
  return 0;
}

// ── host ────────────────────────────────────────────────────────────────

export interface HostOptions extends AgentOptions {
  port?: number;
  tunnel?: Tunnel;
  agent?: string;
  /** Ask about auto-pickup (a terminal). */
  ask?: boolean;
}

/** Makes this machine the host and returns its config (printing the link is up to the caller). */
export async function becomeHost(p: Paths, o: HostOptions, say: Say): Promise<Config> {
  const existing = await loadConfig(p);
  await wireAgents(o, say);
  const auto = await chooseAuto(existing, o, o.ask === true);
  const wasHost = roleOf(existing) === 'host';
  const port = o.port ?? existing.relay?.port ?? DEFAULT_PORT;
  const config: Config = {
    role: 'host',
    agent: o.agent ?? agentName(existing),
    // Keep the host's token across reruns; a former client gets its own.
    token: process.env.HANDOVER_TOKEN || (wasHost ? existing.token : undefined) || generateToken(),
    url: `http://127.0.0.1:${port}`,
    relay: { ...(wasHost ? existing.relay : {}), port, ...(o.tunnel ? { tunnel: o.tunnel } : {}) },
    ...(auto ? { auto } : {}),
  };
  validateAgent(config.agent, 'agent name');
  await saveConfig(p, config);
  say(`Saved ${p.config}`);

  const existingService = await serviceState();
  const foreignService = ['running', 'stopped'].includes(existingService) && !(await serviceIsOurs());
  let atLogin = false;
  if (foreignService) {
    say('A login service from another handover install exists; left alone');
  } else if (o.service ?? serviceByDefault()) {
    try {
      await installService();
      atLogin = true;
      say((await waitForRelay(config.url!, config.token!)) ? 'Relay running; it starts at login' : 'Relay service installed but not answering yet (handover doctor)');
    } catch (err) {
      // Not fatal: the relay also runs inside handover's MCP server, wait and worker.
      say(`Could not install the login service (${(err as Error).message}); the relay runs while Claude Code, Codex or a handover command is open`);
    }
  } else {
    say('The relay runs while Claude Code, Codex or a handover command is open (handover service install keeps it running)');
  }
  say(describeAuto(config.auto, atLogin));
  return config;
}

export async function runHost(p: Paths, o: HostOptions): Promise<number> {
  const config = await becomeHost(p, { ...o, ask: o.ask ?? process.stdin.isTTY === true }, (m) => console.log(m));
  console.log(`\n${formatLink(linkInfo(config))}`);
  return 0;
}

// ── join ────────────────────────────────────────────────────────────────

export interface JoinOptions extends AgentOptions {
  /** Host URL; omit to find the host on this network. */
  url?: string;
  /** Normally from a prompt or HANDOVER_TOKEN (never argv); kept for old installer flags. */
  token?: string;
  agent?: string;
  /** Prompt for missing answers (a terminal) instead of failing. */
  interactive?: boolean;
}

export const isRelayUrl = (s: string) => /^https?:\/\//i.test(s);

/** Joins a host and returns the config. Throws with the reason on failure. */
export async function becomeClient(p: Paths, o: JoinOptions, say: Say): Promise<Config> {
  if (o.url && validUrl(o.url)) throw new Error(`not a host URL: ${o.url}`);
  const existing = await loadConfig(p);

  let token = o.token || process.env.HANDOVER_TOKEN || undefined;
  if (!token) {
    if (!o.interactive) throw new Error('no token: set HANDOVER_TOKEN, or run handover join in a terminal');
    token = cancelled(
      await ui.password({ message: 'Token from the host (handover link or handover token there)', validate: (v) => (v ? undefined : 'Required') })
    );
  }

  let url = o.url?.replace(/\/+$/, '');
  let discovered = false;
  if (!url) {
    const spin = o.interactive ? ui.spinner() : null;
    spin?.start('Looking for the host on this network');
    const host = await findHost(token, 4000);
    spin?.stop(host ? `Found host ${host.agent} at ${host.url}` : 'No host found on this network');
    if (host) {
      url = host.url;
      discovered = true;
      if (!spin) say(`Found host ${host.agent} at ${host.url}`);
    } else if (o.interactive) {
      url = cancelled(
        await ui.text({ message: 'Host URL (handover link on the host shows it)', placeholder: 'http://192.168.1.20:7777', validate: validUrl })
      ).replace(/\/+$/, '');
    } else {
      throw new Error('no host found on this network. Is it running (handover doctor on the host)? Or give its URL: handover join http://HOST:7777');
    }
  }

  const state = await probe({ url, token });
  if (state === 'unauthorized') throw new Error(`the host at ${url} rejected the token`);
  // A Windows host runs its relay only while Claude Code or handover is open there.
  if (state === 'unreachable') say(`Warning: the host at ${url} isn't answering right now; saved anyway`);

  await wireAgents(o, say);
  const auto = await chooseAuto(existing, o, o.interactive === true);
  const config: Config = { role: 'client', url, discover: discovered, token, agent: o.agent ?? agentName(existing), ...(auto ? { auto } : {}) };
  validateAgent(config.agent, 'agent name');
  await saveConfig(p, config);
  say(`Saved ${p.config}`);

  // A client never runs a relay; its service (if any) only takes handovers.
  say(describeAuto(config.auto, await clientService(existing, config, o, say)));
  return config;
}

export async function runJoin(p: Paths, o: Omit<JoinOptions, 'interactive'>): Promise<number> {
  // A terminal: ask for what's missing (the token, and whether to take handovers automatically).
  const interactive = process.stdin.isTTY === true;
  if (interactive) ui.intro('handover join');
  const say: Say = interactive ? (m) => ui.log.success(m) : (m) => console.log(m);
  const config = await becomeClient(p, { ...o, interactive }, say);
  const check = await roundTrip(p);
  say(check);
  const done = `Joined the host at ${config.url}${config.discover ? ' (found on this network)' : ''} as ${config.agent}. Check every machine: handover test`;
  if (interactive) ui.outro(done);
  else console.log(done);
  return 0;
}

/** After joining: a round trip to this machine through the host, and who's online. */
async function roundTrip(p: Paths): Promise<string> {
  const config = await loadConfig(p);
  const { api, agent } = await connect(p, config);
  const responder = startResponder(api, { agent, via: 'join' });
  try {
    const r = await pingAgent(api, agent, agent, { timeoutMs: 6_000 });
    if (!r.ok) return `Round trip through the host failed: ${r.error}`;
    const online = (await api.agents()).map((a) => a.agent).filter((a) => a !== agent);
    return `Round trip through the host: ${r.ms} ms. Online: ${online.join(', ') || 'no other machines yet'}`;
  } catch (err) {
    return `Round trip through the host failed: ${(err as Error).message}`;
  } finally {
    responder.stop();
  }
}

// ── setup: menu + compatibility flags ───────────────────────────────────

export interface SetupOptions {
  /** Old flags (docs/flow.md, Compatibility). */
  peer?: boolean;
  relay?: boolean;
  join?: string;
  token?: string;
  port?: number;
  tunnel?: Tunnel;
  agent?: string;
  claude?: boolean;
  hook?: boolean;
  service?: boolean;
}

export async function runSetup(p: Paths, opts: SetupOptions): Promise<number> {
  const existing = await loadConfig(p);

  // Old flags map onto the two roles.
  if (opts.relay || (opts.peer && !(opts.token || process.env.HANDOVER_TOKEN)))
    return runHost(p, { port: opts.port, tunnel: opts.tunnel, agent: opts.agent, service: opts.service, claude: opts.claude || undefined });
  if (opts.join || opts.peer) return runJoin(p, { url: opts.join, token: opts.token, agent: opts.agent, claude: opts.claude || undefined });

  // Only agent wiring requested on an existing setup (installer --claude).
  if ((opts.claude || opts.hook) && existsSync(p.config)) {
    await wireAgents({}, (m) => console.log(m));
    return 0;
  }

  if (!process.stdin.isTTY) throw new Error('setup needs a terminal; or run handover host / handover join');

  ui.intro('handover setup');
  const role = cancelled(
    await ui.select({
      message: 'What should this machine be?',
      initialValue: roleOf(existing) ?? 'host',
      options: [
        { value: 'host', label: 'Host', hint: 'runs the relay; other machines join it with its token' },
        { value: 'client', label: 'Join a host', hint: 'asks for the host’s token and finds it on this network' },
      ],
    })
  );
  const step: Say = (m) => ui.log.success(m);
  const agent = cancelled(await ui.text({ message: 'Name for this machine’s agent', initialValue: agentName(existing), validate: validAgent }));

  if (role === 'client') {
    const config = await becomeClient(p, { agent, interactive: true }, step);
    step(await roundTrip(p));
    ui.outro(`Joined the host at ${config.url} as ${config.agent}. Check every machine: handover test`);
    return 0;
  }

  const port = Number(
    cancelled(
      await ui.text({
        message: 'Port',
        initialValue: String(existing.relay?.port ?? DEFAULT_PORT),
        validate: (v) => (/^\d{2,5}$/.test(v ?? '') && Number(v) < 65536 ? undefined : 'Enter a port number'),
      })
    )
  );
  const installed = TUNNELS.filter((t) => Bun.which(t));
  const tunnel = installed.length
    ? cancelled(
        await ui.select<Tunnel | 'none'>({
          message: 'Let machines on other networks join?',
          initialValue: existing.relay?.tunnel ?? 'none',
          options: [
            { value: 'none', label: 'No, this network only' },
            ...installed.map((t) => ({
              value: t,
              label: t === 'tailscale' ? 'Yes, via Tailscale Funnel' : 'Yes, via a Cloudflare quick tunnel',
              hint: t === 'tailscale' ? 'stable URL' : 'new URL each restart',
            })),
          ],
        })
      )
    : 'none';
  const service = serviceSupported()
    ? cancelled(
        await ui.confirm({
          message: 'Keep the relay running at every login? (Otherwise it runs while Claude Code or a handover command is open.)',
          initialValue: serviceByDefault() || (await serviceState()) === 'running',
        })
      )
    : false;

  const config = await becomeHost(p, { agent, port, tunnel: tunnel === 'none' ? undefined : tunnel, service, ask: true }, step);
  ui.note(formatLink(linkInfo(config)), 'Share with the machines that should join');
  ui.note(formatChecks(await runChecks(p, { offline: true })), 'handover doctor');
  ui.outro('This machine is the host.');
  return 0;
}
