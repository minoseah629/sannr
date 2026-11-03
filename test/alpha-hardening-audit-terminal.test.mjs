import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { terminalText } from '../lib/terminal.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const route = '/audit-\x1b[31m-poison\x1b]8;;https://example.invalid\x07-link\x1b]8;;\x07\r\u202e';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ah5-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0',
    info: { title: 'Audit fixture', version: '1' }, paths: {
      '/health': { get: { responses: { '200': { description: 'ok' } } } },
    } }));
  const source = value => writeFileSync(join(root, 'app.mjs'),
    `app.get('/health', handler);\napp.get('${value}', handler);\n`);
  // A literal ESC in source reaches the route scanner unchanged.
  source(route);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('API_') && key !== 'NODE_OPTIONS'));
  const run = (...args) => spawnSync(process.execPath, [CLI, 'audit', '.', '--no-execute', ...args],
    { cwd: root, env: { ...env, [HOME_ENV_NAME]: join(root, 'home') }, encoding: 'utf8', timeout: 10000 });
  return { source, run };
}

function safeRows(result) {
  assert.equal(result.status, 0, 'the read-only audit completes');
  assert.ok(!/[\x1b\x07\r\u202e]/.test(result.stdout), 'repository control bytes must not reach audit stdout');
  assert.ok(result.stdout.includes(terminalText('/audit-\x1b[31m-poison')), 'the route remains visible as escaped data');
}

test('AH-5 audit shadow-route rows escape terminal commands and bidi controls', t => {
  const { run } = fixture(t);
  safeRows(run());
});

test('AH-5 audit CI new finding rows escape terminal commands and bidi controls', t => {
  const { source, run } = fixture(t);
  source('/before');
  assert.equal(run('--baseline', '--json').status, 0);
  source(route);
  safeRows(run('--ci', '--report-only'));
});

test('AH-5 audit CI resolved finding rows escape terminal commands and bidi controls', t => {
  const { source, run } = fixture(t);
  assert.equal(run('--baseline', '--json').status, 0);
  source('/after');
  safeRows(run('--ci', '--report-only'));
});
