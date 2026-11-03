import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OVERRIDE = 'API_TEST_NODE_VERSION';
const ENTRIES = [
  { path: 'bin/cli.mjs', implementation: 'bin/cli-main.mjs', args: ['--help'], output: /init/ },
  { path: 'bin/request.mjs', implementation: 'bin/request-main.mjs', args: [], output: /^$/ },
  { path: 'server.mjs', implementation: 'lib/stdio-server.mjs', args: [], output: /"id":1/,
    input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' },
];

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'node-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(entry, root, overrides = {}, packageRoot = REPO) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(API_|SANNR_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
  }
  Object.assign(env, { HOME: root, USERPROFILE: root }, overrides);
  // An absent mark really is absent, rather than the string "undefined".
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const result = spawnSync(process.execPath, [join(packageRoot, entry.path), ...entry.args], {
    cwd: root, env, input: entry.input ?? '', encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function refusal(result, code) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, '', 'refusal precedes CLI output and MCP protocol frames');
  assert.match(result.stderr.split('\n')[0], new RegExp(`^${code}: `));
  assert.equal(result.stderr.trim().split('\n').length, 1, 'one complete line, no stack trace');
}

for (const entry of ENTRIES) {
  test(`H4 unsupported first line: ${entry.path}`, (t) => {
    const root = project(t);
    assert.ok(process.env.NODE_TEST_CONTEXT, 'use the actual Node test-runner mark');
    for (const version of ['v18.20.8', '20.19.0', '21.999.999']) {
      // A second startup fault must not displace the version diagnosis.
      const result = run(entry, root, { [OVERRIDE]: version, API_CONTEXT_PRODUCT_NAME: 'invalid name' });
      refusal(result, 'NODE_VERSION_UNSUPPORTED');
      assert.ok(result.stderr.includes(version.replace(/^v/, '')));
      assert.match(result.stderr, /minimum.*22\.0\.0/);
    }
  });

  test(`H4 guard precedes application linking: ${entry.path}`, (t) => {
    const root = project(t);
    const pkg = join(root, 'package');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    mkdirSync(join(pkg, 'lib'));
    copyFileSync(join(REPO, entry.path), join(pkg, entry.path));
    const guard = join(REPO, 'lib/node-version.mjs');
    if (existsSync(guard)) copyFileSync(guard, join(pkg, 'lib/node-version.mjs'));
    // Other application modules are deliberately absent. Even resolving them
    // before the guard would replace its diagnosis with ERR_MODULE_NOT_FOUND.
    refusal(run(entry, root, { [OVERRIDE]: '21.0.0' }, pkg), 'NODE_VERSION_UNSUPPORTED');
    const missing = run(entry, root, { [OVERRIDE]: '22.0.0' }, pkg);
    assert.notEqual(missing.status, 0, 'supported Node proceeds to application loading');
    assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
    // Human launchers install their pipe-error handler after the version guard.
    // Supply it here so the next assertion reaches the malformed application.
    if (entry.path.startsWith('bin/')) copyFileSync(join(REPO, 'lib/cli-output.mjs'), join(pkg, 'lib/cli-output.mjs'));
    writeFileSync(join(pkg, entry.implementation), 'export const broken = ;\n');
    const broken = run(entry, root, { [OVERRIDE]: '21.0.0' }, pkg);
    refusal(broken, 'NODE_VERSION_UNSUPPORTED');
    const parsed = run(entry, root, { [OVERRIDE]: '22.0.0' }, pkg);
    assert.notEqual(parsed.status, 0);
    assert.match(parsed.stderr, /SyntaxError/);
  });

  test(`H4 override forbidden outside runner: ${entry.path}`, (t) => {
    const root = project(t);
    for (const mark of [undefined, '']) {
      for (const version of ['', '20.0.0', '99.0.0']) {
        const result = run(entry, root, { [OVERRIDE]: version, NODE_TEST_CONTEXT: mark });
        refusal(result, 'NODE_VERSION_OVERRIDE_FORBIDDEN');
        assert.match(result.stderr, /NODE_TEST_CONTEXT/);
      }
    }
  });

  test(`H4 malformed override is bounded and never echoed: ${entry.path}`, (t) => {
    const root = project(t);
    for (const version of ['', '22', '-1.0.0', '22.0.0\nfixture-private-marker', '9'.repeat(4096)]) {
      const result = run(entry, root, { [OVERRIDE]: version });
      refusal(result, 'NODE_VERSION_OVERRIDE_INVALID');
      assert.ok(result.stderr.length < 200);
      assert.doesNotMatch(result.stderr, /fixture-private-marker|999999/);
    }
  });

  test(`H4 supported versions preserve startup: ${entry.path}`, (t) => {
    const root = project(t);
    for (const version of [undefined, '22.0.0', 'v24.1.0']) {
      const result = run(entry, root, { [OVERRIDE]: version });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, '', 'supported guard is silent');
      assert.match(result.stdout, entry.output);
    }
    const ordinary = run(entry, root, { NODE_TEST_CONTEXT: undefined });
    assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
    assert.equal(ordinary.stderr, '');
    assert.match(ordinary.stdout, entry.output);
  });
}

test('H4 minimum matches engines without reading package metadata at startup', async () => {
  const { MIN_NODE_VERSION } = await import('../lib/node-version.mjs');
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.equal(`>=${MIN_NODE_VERSION.replace(/\.0\.0$/, '')}`, pkg.engines.node);
});

test('H4 supported guard stays below a 10 microsecond CPU resolution budget', async (t) => {
  const { assertNodeVersion } = await import('../lib/node-version.mjs');
  const prior = process.env[OVERRIDE];
  delete process.env[OVERRIDE];
  t.after(() => {
    if (prior === undefined) delete process.env[OVERRIDE];
    else process.env[OVERRIDE] = prior;
  });
  const iterations = 20_000;
  function sample(fn) {
    const before = process.cpuUsage();
    for (let i = 0; i < iterations; i++) fn();
    const cpu = process.cpuUsage(before);
    return (cpu.user + cpu.system) / iterations;
  }
  for (let i = 0; i < 1000; i++) assertNodeVersion();
  const deltas = [];
  for (let i = 0; i < 5; i++) {
    const first = sample(i % 2 ? assertNodeVersion : () => {});
    const second = sample(i % 2 ? () => {} : assertNodeVersion);
    deltas.push(i % 2 ? first - second : second - first);
  }
  const median = deltas.sort((a, b) => a - b)[2];
  t.diagnostic(`supported guard median CPU delta: ${median.toFixed(3)} microseconds/call (5 paired samples)`);
  assert.ok(median < 10, `supported startup guard exceeded 10 microseconds: ${median}`);
});
