import { afterEach, expect, test } from 'bun:test';
import { plist, taskXml, unit } from '../src/service.ts';

const saved = process.env.HANDOVER_HOME;
afterEach(() => {
  if (saved === undefined) delete process.env.HANDOVER_HOME;
  else process.env.HANDOVER_HOME = saved;
});

test('service definitions carry a custom HANDOVER_HOME so the relay reads the same config', () => {
  process.env.HANDOVER_HOME = '/tmp/hand over & co';
  expect(plist()).toContain('<key>HANDOVER_HOME</key><string>/tmp/hand over &amp; co</string>');
  expect(unit()).toContain('Environment="HANDOVER_HOME=/tmp/hand over & co"');
  expect(plist()).toContain('<string>serve</string>');
});

test('without HANDOVER_HOME the service uses the default folder', () => {
  delete process.env.HANDOVER_HOME;
  expect(plist()).not.toContain('HANDOVER_HOME');
  expect(unit()).not.toContain('HANDOVER_HOME');
  expect(plist()).toContain('<key>PATH</key>');
});

test('the Windows logon task passes the data folder and log, is not hidden, and has no time limit', () => {
  process.env.HANDOVER_HOME = '/tmp/hand over';
  const xml = taskXml();
  // Hidden tasks launched through conhost --headless are what antivirus flags as persistence.
  expect(xml).not.toContain('conhost');
  expect(xml).not.toContain('--headless');
  expect(xml).not.toContain('<Hidden>');
  expect(xml).toMatch(/<Arguments>[^<]*serve --home "\/tmp\/hand over" --log /);
  expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  expect(xml).toContain('<LogonTrigger>');
});
