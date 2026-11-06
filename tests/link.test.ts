import { expect, test } from 'bun:test';
import { formatLink, linkInfo } from '../src/link.ts';

test('peer link: same secret on every OS, no address', () => {
  const info = linkInfo({ peer: true, token: 'sec-ret', relay: { port: 7777 } });
  expect(info.mode).toBe('peer');
  expect(info.unix).toContain('install.sh | bash -s -- --peer --token sec-ret');
  expect(info.windows).toContain("install.ps1))) -Peer -Token 'sec-ret'");
  expect(info.unix).not.toContain('--join');
});

test('relay link points other machines at a LAN address, not localhost', () => {
  const info = linkInfo({ url: 'http://127.0.0.1:7801', token: 't', relay: { port: 7801 } });
  expect(info.mode).toBe('relay');
  expect(info.url).not.toContain('127.0.0.1');
  expect(info.url).toMatch(/:7801$/);
  expect(info.unix).toContain(`--join ${info.url} --token t`);
  expect(info.windows).toContain(`-Join '${info.url}' -Token 't'`);
});

test('a joined machine shares the relay it uses', () => {
  const info = linkInfo({ url: 'https://relay.example.ts.net', token: 't' });
  expect(info.url).toBe('https://relay.example.ts.net');
});

test('tokens are quoted safely for each shell', () => {
  const info = linkInfo({ peer: true, token: "it's" });
  expect(info.unix).toContain(`--token 'it'\\''s'`);
  expect(info.windows).toContain(`-Token 'it''s'`);
});

test('formatted link shows both platforms and needs a token', () => {
  const text = formatLink(linkInfo({ peer: true, token: 'x' }));
  expect(text).toContain('macOS / Linux');
  expect(text).toContain('Windows (PowerShell)');
  expect(() => linkInfo({})).toThrow();
});
