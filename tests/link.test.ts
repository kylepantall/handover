import { expect, test } from 'bun:test';
import { formatLink, linkInfo } from '../src/link.ts';

test('peer link: same secret on every OS, passed in an env var, no address', () => {
  const info = linkInfo({ peer: true, token: 'sec-ret', relay: { port: 7777 } });
  expect(info.mode).toBe('peer');
  expect(info.unix).toContain('install.sh | HANDOVER_TOKEN=sec-ret bash -s -- --peer');
  expect(info.windows).toStartWith("$env:HANDOVER_TOKEN='sec-ret'; & ([scriptblock]::Create((irm ");
  expect(info.windows).toEndWith('install.ps1))) -Peer');
  expect(info.unix).not.toContain('--join');
});

test('the token is never a command-line argument (antivirus logs and process lists record those)', () => {
  for (const config of [{ peer: true, token: 'zzz' }, { url: 'http://10.0.0.2:7777', token: 'zzz' }]) {
    const info = linkInfo(config);
    expect(info.unix).not.toContain('--token');
    expect(info.windows).not.toContain('-Token');
  }
});

test('relay link points other machines at a LAN address, not localhost', () => {
  const info = linkInfo({ url: 'http://127.0.0.1:7801', token: 't', relay: { port: 7801 } });
  expect(info.mode).toBe('relay');
  expect(info.url).not.toContain('127.0.0.1');
  expect(info.url).toMatch(/:7801$/);
  expect(info.unix).toContain(`HANDOVER_TOKEN=t bash -s -- --join ${info.url}`);
  expect(info.windows).toEndWith(`-Join '${info.url}'`);
});

test('a joined machine shares the relay it uses', () => {
  expect(linkInfo({ url: 'https://relay.example.ts.net', token: 't' }).url).toBe('https://relay.example.ts.net');
});

test('tokens are quoted safely for each shell', () => {
  const info = linkInfo({ peer: true, token: "it's" });
  expect(info.unix).toContain(`HANDOVER_TOKEN='it'\\''s'`);
  expect(info.windows).toContain(`$env:HANDOVER_TOKEN='it''s'`);
});

test('formatted link shows both platforms and needs a token', () => {
  const text = formatLink(linkInfo({ peer: true, token: 'x' }));
  expect(text).toContain('macOS / Linux');
  expect(text).toContain('Windows (PowerShell)');
  expect(() => linkInfo({})).toThrow();
});
