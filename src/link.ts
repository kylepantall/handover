/** `handover link`: what a host shares so other machines can join it (docs/flow.md). */

import { DEFAULT_PORT, endpoint, roleOf } from './config.ts';
import { REPO } from './paths.ts';
import { lanAddresses } from './server.ts';
import type { Config } from './types.ts';

const raw = (file: string) => `https://raw.githubusercontent.com/${REPO}/main/scripts/${file}`;

export interface LinkInfo {
  token: string;
  /** Explicit host URL in the join commands: only when clients can't find the host themselves (tunnel). */
  url?: string;
  /** This host's LAN address, for clients where discovery is blocked. */
  lanUrl: string;
  unix: string;
  windows: string;
  installed: string;
}

export function linkInfo(config: Config): LinkInfo {
  const role = roleOf(config);
  if (role === 'client') throw new Error(`this machine is a client of ${config.url}: run handover link on the host`);
  const { token } = endpoint(config);
  if (!token || !role) throw new Error('not set up: run handover host');
  // PowerShell single quotes are literal; double any quote inside.
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const sh = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  const port = config.relay?.port ?? DEFAULT_PORT;
  const lanUrl = `http://${lanAddresses()[0] ?? '<this-machine-ip>'}:${port}`;
  // Same network: clients find the host by mDNS, so no URL. A tunnel URL is for other networks.
  const url = config.relay?.tunnel && config.url && !/127\.0\.0\.1|localhost/.test(config.url) ? config.url : undefined;
  // The token travels in an environment variable, never as an argument: arguments
  // are visible in process lists and recorded by antivirus behaviour monitors.
  return {
    token,
    url,
    lanUrl,
    unix: `curl -fsSL ${raw('install.sh')} | HANDOVER_TOKEN=${sh(token)} bash -s -- --join${url ? ` ${sh(url)}` : ''}`,
    windows: `$env:HANDOVER_TOKEN=${ps(token)}; & ([scriptblock]::Create((irm ${raw('install.ps1')}))) -Join${url ? ` -Url ${ps(url)}` : ''}`,
    installed: `handover join${url ? ` ${url}` : ''}`,
  };
}

export function formatLink(info: LinkInfo): string {
  return [
    `Token: ${info.token}`,
    '',
    'Join from another machine:',
    '',
    '  macOS / Linux:',
    `    ${info.unix}`,
    '',
    '  Windows (PowerShell):',
    `    ${info.windows}`,
    '',
    `  Already installed:  ${info.installed}   (asks for the token)`,
    '',
    info.url
      ? `Clients join through ${info.url}.`
      : `Clients on this network find this host automatically. If one can't, add the address: --join ${info.lanUrl} (Windows: -Url ${info.lanUrl}).`,
    'The token gives full access to the queue: share it like a password.',
  ].join('\n');
}
