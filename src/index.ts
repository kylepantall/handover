#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { EXIT, hook, list, mcp, serve, wait, worker } from './commands.ts';
import { endpoint, loadConfig, roleOf } from './config.ts';
import { readFile } from 'node:fs/promises';
import { runDoctor } from './doctor.ts';
import { formatLink, linkInfo } from './link.ts';
import { ADAPTERS, parseAgentKind, parseAgentKinds } from './agents.ts';
import { removeHook } from './claude.ts';
import { paths } from './paths.ts';
import { installService, serviceState, uninstallService } from './service.ts';
import { isRelayUrl, runAgents, runAuto, runHost, runJoin, runSetup, type AgentOptions } from './setup.ts';
import { runListen, runTest } from './test.ts';
import { AGENT_KINDS, TUNNELS, type AgentKind, type Tunnel } from './types.ts';
import { runUpdate } from './update.ts';
import { VERSION } from './version.ts';

const HELP = `handover ${VERSION} — hand tasks between AI agents on different machines

Usage: handover <command>

  host                          Make this machine the host: it runs the relay, and prints the token and
                                the join commands for other machines (docs/flow.md)
        [--agent NAME] [--port N] [--tunnel tailscale|cloudflared] [--no-service] [AGENT FLAGS]
  join [HOST_URL]               Join a host: asks for its token (or reads HANDOVER_TOKEN) and finds it on
                                this network; HOST_URL only if it's elsewhere [--agent NAME] [AGENT FLAGS]
        AGENT FLAGS: [--auto claude|codex|both|off] [--full-access] [--no-claude] [--no-codex] [--no-service]
                     Both add handover to Claude Code and Codex when installed, and ask (in a
                     terminal) whether one takes handovers automatically
  setup                         Menu: host or join
  agents [WHO SETTING...]       List this machine's agents, or change them. WHO: claude, codex or all.
                                SETTING: on / off (take handovers automatically), full-access (⚠️ no
                                permission prompts or sandbox) / default-access. Example:
                                handover agents all on, handover agents codex full-access
  auto [claude|codex|both|off]  Older form: auto-pickup with exactly these agents [--full-access]
  test [--timeout SEC] [--json] Check this machine reaches the host, then a round robin: every online
                                machine pings every other. Exits 1 if any link fails
  listen                        Answer test pings on a machine without Claude Code open
  wait --objective TEXT         Create a handover and block until an agent completes it
        [--context TEXT | --context-file PATH] [--priority N]
        [--to MACHINE | claude | codex | codex@MACHINE]
        [--id ID] [--out DIR] [--timeout SEC] [--json]
  worker [--with claude|codex | --exec "CMD"]
                                Take the next handover, pipe its briefing to the agent, repeat (default:
                                the auto-pickup agent) [--full-access] [--agent NAME] [--lease SEC]
                                [--interval SEC] [--once]
  list [--status S] [--for AGENT]
  serve                         Run the relay in the foreground (the service runs this)
        [--port N] [--host H] [--tunnel T] [--data FILE|none] [--lease SEC]
        [--max-attempts N] [--retention HOURS] [--log FILE] [--home DIR]
  service install|uninstall|restart|status|log
                                Run handover at login (launchd, systemd --user, or Task Scheduler): the
                                relay on a host, auto-pickup on either
  link [--json]                 Host: print the token and join commands (macOS/Linux and Windows)
  token                         Print this machine's token
  doctor [--json]               Check role, relay or host, service, agents and auto-pickup
  update [--check] [--ref R]    Install the latest version from GitHub
  unlink                        Remove this install's MCP server from Claude Code and Codex, and its
                                SessionStart hook (claude-unlink: the same)
  mcp [--as claude|codex]       MCP server over stdio; Claude Code and Codex start this. --as: claim tasks
                                as claude@MACHINE / codex@MACHINE, so --to codex reaches it
  hook                          Claude Code SessionStart hook

Config: ~/.config/handover/config.json, %APPDATA%\\handover on Windows (HANDOVER_HOME overrides).
Env overrides: HANDOVER_URL, HANDOVER_TOKEN, HANDOVER_AGENT.`;

const s = { type: 'string' } as const;
const b = { type: 'boolean' } as const;
const AGENT_FLAGS = { auto: s, 'full-access': b, 'no-claude': b, 'no-codex': b, 'no-service': b } as const;
const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  host: { agent: s, port: s, tunnel: s, ...AGENT_FLAGS },
  setup: { peer: b, relay: b, join: s, token: s, port: s, tunnel: s, agent: s, claude: b, hook: b, 'no-service': b },
  wait: { objective: s, context: s, 'context-file': s, id: s, to: s, priority: s, out: s, timeout: s, json: b },
  worker: { exec: s, with: s, 'full-access': b, agent: s, lease: s, interval: s, once: b },
  auto: { 'full-access': b },
  mcp: { as: s },
  list: { status: s, for: s },
  serve: { port: s, host: s, token: s, tunnel: s, data: s, lease: s, 'max-attempts': s, retention: s, log: s, home: s },
  link: { json: b },
  join: { agent: s, ...AGENT_FLAGS },
  test: { timeout: s, json: b },
  doctor: { json: b },
  update: { check: b, force: b, ref: s },
};

const num = (v: unknown, name: string): number | undefined => {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};
const tunnel = (v: unknown): Tunnel | undefined => {
  if (v == null) return undefined;
  if (!TUNNELS.includes(v as Tunnel)) throw new Error(`--tunnel must be ${TUNNELS.join(' or ')}`);
  return v as Tunnel;
};

function autoArg(v: unknown, flag: string): AgentKind[] | 'off' | undefined {
  if (v == null) return undefined;
  return v === 'off' ? 'off' : parseAgentKinds(String(v), flag);
}

/** --auto, --full-access, --no-claude, --no-codex, --no-service. */
function agentOptions(o: Record<string, string | boolean | undefined>): AgentOptions {
  return {
    auto: autoArg(o.auto, '--auto'),
    fullAccess: o['full-access'] ? true : undefined,
    claude: o['no-claude'] ? false : undefined,
    codex: o['no-codex'] ? false : undefined,
    service: o['no-service'] ? false : undefined,
  };
}

async function main(argv: string[]): Promise<number | null> {
  // The launcher starts Bun in the app folder (so a planted bunfig.toml or .env
  // in the user's folder is never loaded); return to where the user ran us.
  if (process.env.HANDOVER_CWD) process.chdir(process.env.HANDOVER_CWD);

  const [command, ...rest] = argv;
  const { values: o, positionals } = parseArgs({ args: rest, options: OPTIONS[command ?? ''] ?? {}, allowPositionals: true }) as {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
  const str = (k: string) => o[k] as string | undefined;
  // --home: the Windows logon task can't set HANDOVER_HOME, so it passes the folder.
  const p = paths(command === 'serve' ? str('home') : undefined);

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return EXIT.ok;
    case '--version':
    case '-v':
      console.log(VERSION);
      return EXIT.ok;
    case 'setup':
      return runSetup(p, {
        peer: o.peer === true,
        relay: o.relay === true,
        join: str('join'),
        token: str('token'),
        port: num(o.port, 'port'),
        tunnel: tunnel(o.tunnel),
        agent: str('agent'),
        claude: o.claude === true,
        hook: o.hook === true,
        service: o['no-service'] ? false : undefined,
      });
    case 'host':
      return runHost(p, { ...agentOptions(o), agent: str('agent'), port: num(o.port, 'port'), tunnel: tunnel(o.tunnel) });
    case 'join': {
      const [url, extra] = positionals;
      if (extra) throw new Error('Usage: handover join [HOST_URL]');
      if (url && !isRelayUrl(url))
        throw new Error(
          'don’t put the token on the command line (process lists and antivirus logs record it). Run `handover join` and paste it when asked, or set HANDOVER_TOKEN.'
        );
      return runJoin(p, { ...agentOptions(o), url, agent: str('agent') });
    }
    case 'agents':
      return runAgents(p, positionals);
    case 'auto': {
      // handover auto claude codex = handover auto claude,codex = handover auto both
      const choice = positionals.length ? positionals.join(',') : undefined;
      return runAuto(p, { auto: autoArg(choice, 'handover auto'), fullAccess: o['full-access'] ? true : undefined });
    }
    case 'test':
      return runTest(p, { json: o.json === true, timeoutSeconds: num(o.timeout, 'timeout') });
    case 'listen':
      return runListen(p);
    case 'serve':
      await serve(p, {
        port: num(o.port, 'port'),
        host: str('host'),
        token: str('token'),
        tunnel: str('tunnel'),
        data: str('data'),
        leaseSeconds: num(o.lease, 'lease'),
        maxAttempts: num(o['max-attempts'], 'max-attempts'),
        retentionHours: num(o.retention, 'retention'),
        log: str('log'),
      });
      return null; // keep serving
    case 'wait':
      return wait(p, {
        objective: str('objective'),
        context: str('context'),
        contextFile: str('context-file'),
        id: str('id'),
        to: str('to'),
        priority: str('priority'),
        out: str('out'),
        timeoutSeconds: num(o.timeout, 'timeout'),
        json: o.json === true,
      });
    case 'worker':
      return worker(p, {
        exec: str('exec'),
        with: o.with == null ? undefined : parseAgentKind(String(o.with), '--with'),
        fullAccess: o['full-access'] ? true : undefined,
        agent: str('agent'),
        leaseSeconds: num(o.lease, 'lease'),
        intervalSeconds: num(o.interval, 'interval'),
        once: o.once === true,
      });
    case 'list':
      return list(p, { status: str('status'), for: str('for') });
    case 'mcp':
      await mcp(p, { as: o.as == null ? undefined : parseAgentKind(String(o.as), '--as') });
      return null;
    case 'hook':
      return hook(p);
    case 'doctor':
      return runDoctor(p, { json: o.json === true });
    case 'update':
      return runUpdate({ check: o.check === true, force: o.force === true, ref: str('ref') });
    case 'unlink':
    case 'claude-unlink': {
      for (const kind of AGENT_KINDS) console.log(`${kind} mcp: ${await ADAPTERS[kind].unregister()}`);
      console.log(`claude hook: ${(await removeHook()) > 0 ? 'removed' : 'none'}`);
      return EXIT.ok;
    }
    case 'link': {
      const info = linkInfo(await loadConfig(p));
      console.log(o.json ? JSON.stringify(info, null, 2) : formatLink(info));
      return EXIT.ok;
    }
    case 'token': {
      const { token } = endpoint(await loadConfig(p));
      if (!token) throw new Error('no token yet: run handover setup');
      console.log(token);
      return EXIT.ok;
    }
    case 'service': {
      const [action] = positionals;
      if (action === 'install' || action === 'restart') {
        const config = await loadConfig(p);
        // A client's service only does auto-pickup: without it, it would exit and restart forever.
        if (roleOf(config) === 'client' && !config.auto) throw new Error('nothing to run at login on a client: turn on auto-pickup first (handover auto claude|codex)');
        await installService();
        console.log(roleOf(config) === 'client' ? 'Auto-pickup service started; it runs at login.' : 'Relay service started; it runs at login.');
      } else if (action === 'uninstall') {
        await uninstallService();
        console.log('Login service removed.');
      } else if (action === 'status') {
        console.log(await serviceState());
      } else if (action === 'log') {
        console.log(p.log);
        const text = await readFile(p.log, 'utf8').catch(() => '(no log yet)\n');
        process.stdout.write(text.split(/\r?\n/).slice(-41).join('\n'));
      } else {
        throw new Error('Usage: handover service install|uninstall|restart|status|log');
      }
      return EXIT.ok;
    }
    default:
      throw new Error(`Unknown command: ${command}. Run handover help.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code != null) process.exit(code);
  },
  (err: Error) => {
    console.error(`handover: ${err.message}`);
    process.exit(EXIT.failed);
  }
);
