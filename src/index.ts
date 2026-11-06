#!/usr/bin/env bun
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { EXIT, hook, list, mcp, serve, wait, worker } from './commands.ts';
import { endpoint, loadConfig } from './config.ts';
import { readFile } from 'node:fs/promises';
import { runDoctor } from './doctor.ts';
import { formatLink, linkInfo } from './link.ts';
import { removeHook, unregisterFromClaude } from './claude.ts';
import { paths } from './paths.ts';
import { installService, serviceState, uninstallService } from './service.ts';
import { isRelayUrl, runHost, runJoin, runSetup } from './setup.ts';
import { TUNNELS, type Tunnel } from './types.ts';
import { runUpdate } from './update.ts';
import { VERSION } from './version.ts';

const HELP = `handover ${VERSION} — hand tasks between AI agents on different machines

Usage: handover <command>

  host                          Make this machine the host: it runs the relay, and prints the token and
                                the join commands for other machines (docs/flow.md)
        [--agent NAME] [--port N] [--tunnel tailscale|cloudflared] [--no-service] [--no-claude]
  join [HOST_URL]               Join a host: asks for its token (or reads HANDOVER_TOKEN) and finds it on
                                this network; HOST_URL only if it's elsewhere [--agent NAME] [--no-claude]
  setup                         Menu: host or join
  wait --objective TEXT         Create a handover and block until an agent completes it
        [--context TEXT | --context-file PATH] [--to AGENT] [--priority N]
        [--id ID] [--out DIR] [--timeout SEC] [--json]
  worker --exec "CMD"           Take the next handover, pipe its briefing to CMD, repeat
        [--agent NAME] [--lease SEC] [--interval SEC] [--once]
  list [--status S] [--for AGENT]
  serve                         Run the relay in the foreground (the service runs this)
        [--port N] [--host H] [--tunnel T] [--data FILE|none] [--lease SEC]
        [--max-attempts N] [--retention HOURS] [--log FILE] [--home DIR]
  service install|uninstall|restart|status|log
                                Run the relay at login (launchd, systemd --user, or Task Scheduler)
  link [--json]                 Host: print the token and join commands (macOS/Linux and Windows)
  token                         Print this machine's token
  doctor [--json]               Check role, relay or host, service and Claude Code
  update [--check] [--ref R]    Install the latest version from GitHub
  claude-unlink                 Remove this install's MCP server and SessionStart hook from Claude Code
  mcp                           MCP server over stdio; Claude Code starts this
  hook                          Claude Code SessionStart hook

Config: ~/.config/handover/config.json, %APPDATA%\\handover on Windows (HANDOVER_HOME overrides).
Env overrides: HANDOVER_URL, HANDOVER_TOKEN, HANDOVER_AGENT.`;

const s = { type: 'string' } as const;
const b = { type: 'boolean' } as const;
const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  host: { agent: s, port: s, tunnel: s, 'no-service': b, 'no-claude': b },
  setup: { peer: b, relay: b, join: s, token: s, port: s, tunnel: s, agent: s, claude: b, hook: b, 'no-service': b },
  wait: { objective: s, context: s, 'context-file': s, id: s, to: s, priority: s, out: s, timeout: s, json: b },
  worker: { exec: s, agent: s, lease: s, interval: s, once: b },
  list: { status: s, for: s },
  serve: { port: s, host: s, token: s, tunnel: s, data: s, lease: s, 'max-attempts': s, retention: s, log: s, home: s },
  link: { json: b },
  join: { agent: s, 'no-claude': b },
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
      return runHost(p, {
        agent: str('agent'),
        port: num(o.port, 'port'),
        tunnel: tunnel(o.tunnel),
        service: o['no-service'] ? false : undefined,
        claude: o['no-claude'] ? false : undefined,
      });
    case 'join': {
      const [url, extra] = positionals;
      if (extra) throw new Error('Usage: handover join [HOST_URL]');
      if (url && !isRelayUrl(url))
        throw new Error(
          'don’t put the token on the command line (process lists and antivirus logs record it). Run `handover join` and paste it when asked, or set HANDOVER_TOKEN.'
        );
      return runJoin(p, { url, agent: str('agent'), claude: o['no-claude'] ? false : undefined });
    }
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
        agent: str('agent'),
        leaseSeconds: num(o.lease, 'lease'),
        intervalSeconds: num(o.interval, 'interval'),
        once: o.once === true,
      });
    case 'list':
      return list(p, { status: str('status'), for: str('for') });
    case 'mcp':
      await mcp(p);
      return null;
    case 'hook':
      return hook(p);
    case 'doctor':
      return runDoctor(p, { json: o.json === true });
    case 'update':
      return runUpdate({ check: o.check === true, force: o.force === true, ref: str('ref') });
    case 'claude-unlink': {
      const mcp = await unregisterFromClaude();
      console.log(`mcp: ${mcp}`);
      console.log(`hook: ${(await removeHook()) > 0 ? 'removed' : 'none'}`);
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
        await installService();
        console.log('Relay service started; it runs at login.');
      } else if (action === 'uninstall') {
        await uninstallService();
        console.log('Relay service removed.');
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
