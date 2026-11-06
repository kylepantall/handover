/** `handover link`: the commands that connect another machine to this one, per OS. */

import { DEFAULT_PORT, endpoint } from './config.ts';
import { REPO } from './paths.ts';
import { lanAddresses } from './server.ts';
import type { Config } from './types.ts';

const raw = (file: string) => `https://raw.githubusercontent.com/${REPO}/main/scripts/${file}`;

export interface LinkInfo {
  mode: 'peer' | 'relay';
  /** Relay URL other machines should use (relay mode). */
  url?: string;
  token: string;
  unix: string;
  windows: string;
  /** Extra guidance, e.g. about reaching the relay from outside the network. */
  note?: string;
}

/** Relay URL as another machine would reach it. */
function relayUrlFor(config: Config): string {
  const configured = endpoint(config).url;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(configured);
  if (!config.relay || !local) return configured; // a joined machine shares the relay it uses
  const ip = lanAddresses()[0];
  return `http://${ip ?? '<this-machine-ip>'}:${config.relay.port ?? DEFAULT_PORT}`;
}

export function linkInfo(config: Config): LinkInfo {
  const { token } = endpoint(config);
  if (!token) throw new Error('nothing to link yet: run handover setup');
  // PowerShell single quotes are literal; double any quote inside.
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const sh = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  // The token travels in an environment variable, never as an argument: arguments
  // are visible in process lists and recorded by antivirus behaviour monitors.
  const winInstall = `$env:HANDOVER_TOKEN=${ps(token)}; & ([scriptblock]::Create((irm ${raw('install.ps1')})))`;
  const unixInstall = `curl -fsSL ${raw('install.sh')} | HANDOVER_TOKEN=${sh(token)} bash -s --`;

  if (config.peer) {
    return {
      mode: 'peer',
      token,
      unix: `${unixInstall} --peer`,
      windows: `${winInstall} -Peer`,
      note: 'Machines on the same network find each other automatically.',
    };
  }
  const url = relayUrlFor(config);
  return {
    mode: 'relay',
    url,
    token,
    unix: `${unixInstall} --join ${sh(url)}`,
    windows: `${winInstall} -Join ${ps(url)}`,
    note: config.relay?.tunnel
      ? `From outside this network, swap the URL for the ${config.relay.tunnel} URL in: handover service log`
      : config.relay
        ? 'Off this network: rerun setup with a tunnel (tailscale or cloudflared).'
        : undefined,
  };
}

export function formatLink(info: LinkInfo): string {
  return [
    info.mode === 'peer' ? 'Connect another machine on this network:' : `Connect another machine to ${info.url}:`,
    '',
    '  macOS / Linux:',
    `    ${info.unix}`,
    '',
    '  Windows (PowerShell):',
    `    ${info.windows}`,
    ...(info.note ? ['', info.note] : []),
    '',
    'These contain the token: share them like a password.',
  ].join('\n');
}
