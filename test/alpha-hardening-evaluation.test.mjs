import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('AH-6 private alpha ZIP fixture skips by name without archive tools', t => {
  if (!existsSync(join(ROOT, 'scripts/pack-alpha.mjs')))
    return t.skip('the private alpha ZIP tooling is absent from this public source cut');
  if (!['darwin', 'linux'].includes(process.platform))
    return t.skip('Private alpha ZIP workflow supports macOS/Linux only');
  const empty = mkdtempSync(join(tmpdir(), 'archive-tools-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const env = { ...process.env, PATH: empty };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/alpha-package.test.mjs'], {
    cwd: ROOT, encoding: 'utf8', env, timeout: 120_000,
  });
  assert.equal(run.status, 0, 'missing archive tools must skip, not fail the package test');
  assert.match(run.stdout, /alpha ZIP installs offline[^\n]+# SKIP[^\n]+zip, unzip/);
});

test('AH-6 loopback response-change tests are named as fixtures', () => {
  assert.equal(existsSync(join(ROOT, 'test/response-change-live.test.mjs')), false);
  assert.ok(existsSync(join(ROOT, 'test/response-change-fixture.test.mjs')));
});
