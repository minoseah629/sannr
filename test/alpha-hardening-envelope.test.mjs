import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { TOOL } from '../lib/client.mjs';

const REQUEST = fileURLToPath(new URL('../bin/request.mjs', import.meta.url));

test('AH-2 MCP schema advertises envelope v2 and deep equality', () => {
  assert.deepEqual(TOOL.inputSchema.properties.v?.enum, [2]);
  assert.match(TOOL.inputSchema.properties.v.description, /deep strict equality/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'envelope-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('API_') && name !== HOME_ENV_NAME));
  return version => spawnSync(process.execPath, [REQUEST, 'envelope', JSON.stringify({ v: version, requests: [] })], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...env, [HOME_ENV_NAME]: join(root, 'home'), API_CONTEXT_OFF: '1',
      API_USAGE_LOG: join(root, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence') },
  });
}

test('AH-2 envelope v1 is refused before requests execute', t => {
  const result = fixture(t)(1);
  assert.equal(result.status, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error?.code, 'ENVELOPE_VERSION_UNSUPPORTED');
  assert.equal(envelope.v, 2);
  assert.equal(envelope.attempted, 0);
  assert.deepEqual(envelope.results, []);
  // The recovery names a page that ships in the npm package and says what changed.
  const page = /\b(docs\/[a-z-]+\.md)\b/.exec(envelope.error.next)?.[1];
  assert.ok(page, envelope.error.next);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes(page), `${page} is not in the npm package`);
  assert.ok(existsSync(new URL(`../${page}`, import.meta.url)), `${page} is missing`);
  assert.match(readFileSync(new URL(`../${page}`, import.meta.url), 'utf8'), /ENVELOPE_VERSION_UNSUPPORTED/);
});

test('AH-2 unsupported envelope versions never echo caller-controlled values', t => {
  const run = fixture(t), canary = 'private-version-marker';
  for (const version of [canary, { private: canary }, [canary]]) {
    const result = run(version);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error?.code, 'ENVELOPE_VERSION_UNSUPPORTED');
    assert.equal((result.stdout + result.stderr).includes(canary), false,
      'version diagnostics must not retain caller-controlled data');
  }
});
