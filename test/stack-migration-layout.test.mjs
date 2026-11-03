import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LAYOUT, LEGACY_LAYOUT, layoutFor, migrateLayout, projectedLayoutFiles } from '../lib/layout.mjs';

function specimen(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'stack-layout-migration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, bytes, mode = 0o644) => {
    fs.mkdirSync(dirname(join(root, file)), { recursive: true });
    fs.writeFileSync(join(root, file), bytes, { mode });
  };
  put(LEGACY_LAYOUT.context, JSON.stringify({ v: 0, api: {}, operations: {} }));
  put(`${LEGACY_LAYOUT.evidence}/run-fixture.json`, '{"request":{"url":"https://example.test/health"}}', 0o600);
  return { root, put };
}

test('old-layout stack preflight receives rewritten canonical bytes without a write', t => {
  const { root, put } = specimen(t);
  put(LEGACY_LAYOUT.environments, JSON.stringify({ defaults: { evidenceDir: LEGACY_LAYOUT.evidence } }));
  const plan = migrateLayout(root, { dryRun: true });
  const files = projectedLayoutFiles(root, plan);
  assert.equal(files.get(LAYOUT.context).from, LEGACY_LAYOUT.context);
  assert.equal(JSON.parse(files.get(LAYOUT.environments).bytes).defaults.evidenceDir, LAYOUT.evidence);
  assert.equal(files.get(`${LAYOUT.evidence}/run-fixture.json`).mode, 0o600);
  assert.equal(fs.existsSync(join(root, LAYOUT.context)), false);
  assert.equal(fs.existsSync(join(root, LEGACY_LAYOUT.context)), true);
});

test('old-layout destination readback failure preserves every source', t => {
  const { root } = specimen(t);
  const original = fs.readFileSync;
  const source = original(join(root, LEGACY_LAYOUT.context));
  fs.readFileSync = function(path, ...args) {
    if (String(path) === join(root, LAYOUT.context) && fs.existsSync(path)) return Buffer.from('damaged-readback');
    return original.call(this, path, ...args);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => migrateLayout(root), { code: 'MIGRATION_READBACK_FAILED' });
    assert.deepEqual(original(join(root, LEGACY_LAYOUT.context)), source);
    assert.equal(fs.existsSync(join(root, LEGACY_LAYOUT.evidence, 'run-fixture.json')), true);
  } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  // Interrupted readback leaves a complete identical destination; retry must
  // finish safely rather than strand the preserved original behind a conflict.
  migrateLayout(root);
  assert.equal(fs.existsSync(join(root, LEGACY_LAYOUT.context)), false);
  assert.deepEqual(original(join(root, LAYOUT.context)), source);
});

test('old-layout migration preserves private evidence mode and exact bytes', t => {
  const { root } = specimen(t);
  const before = fs.readFileSync(join(root, LEGACY_LAYOUT.evidence, 'run-fixture.json'));
  migrateLayout(root);
  const moved = join(root, LAYOUT.evidence, 'run-fixture.json');
  assert.deepEqual(fs.readFileSync(moved), before);
  assert.equal(fs.statSync(moved).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(join(root, LEGACY_LAYOUT.evidence, 'run-fixture.json')), false);
});

function renamedSpecimen(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'stack-renamed-layout-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = layoutFor('precursor', 'library');
  const put = (path, value) => {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true });
    fs.writeFileSync(join(root, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const contract = `${old.config}/contract.json`, envFile = `${old.config}/provider.env`;
  put(old.marker, { kind: 'repo-api-layout', v: 1, product: 'precursor', collection: 'library' });
  put(contract, { openapi: '3.0.3', info: { title: 'Example API', version: '1' },
    paths: { '/users': { get: { responses: { 200: { description: 'Synthetic response' } } } } } });
  put(envFile, '# Synthetic fixture; no credential values.\n');
  put(old.environments, { v: 1, default: 'dev', environments: {
    dev: { baseUrl: 'https://example.test', contract, envFile },
  } });
  put(old.context, { v: 0, api: { name: 'Example API', contract }, operations: {
    'GET /users': { fields: {}, notes: [] },
  } });
  return { root, old, put, contract, envFile };
}

test('renamed layout rewrites only schema-owned moved contract and env-file references', t => {
  const { root, old, put, contract, envFile } = renamedSpecimen(t);
  const custom = { contract, envFile };
  put(old.context, { v: 0, api: { name: 'Example API', contract: join(root, contract), custom, envFile },
    operations: {}, custom });
  const env = { baseUrl: 'https://example.test', contract, envFile, custom };
  put(old.environments, { v: 1, default: 'dev', custom, hosts: {
    peer: env, internal: { ...env, contract: join(root, contract), envFile: join(root, envFile) },
    absolute: { baseUrl: 'https://absolute.example.test', envFile: '/external/provider.env' },
    home: { baseUrl: 'https://home.example.test', envFile: '~/.config/example/provider.env' },
  }, environments: { dev: { ...env, hosts: { peer: env } } } });
  const projected = projectedLayoutFiles(root, migrateLayout(root, { dryRun: true }));
  const config = JSON.parse(projected.get(LAYOUT.environments).bytes);
  const knowledge = JSON.parse(projected.get(LAYOUT.context).bytes);
  const movedContract = `${LAYOUT.config}/contract.json`, movedEnvFile = `${LAYOUT.config}/provider.env`;
  assert.equal(knowledge.api.contract, movedContract);
  for (const item of [config.environments.dev, config.hosts.peer, config.hosts.internal, config.environments.dev.hosts.peer]) {
    assert.equal(item.contract, movedContract);
    assert.equal(item.envFile, movedEnvFile);
    assert.deepEqual(item.custom, custom);
  }
  assert.deepEqual(config.custom, custom);
  assert.deepEqual(knowledge.custom, custom);
  assert.deepEqual(knowledge.api.custom, custom);
  assert.equal(knowledge.api.envFile, envFile, 'api.envFile is not a declared schema field');
  assert.equal(config.hosts.absolute.envFile, '/external/provider.env');
  assert.equal(config.hosts.home.envFile, '~/.config/example/provider.env');
});

async function migrateCommand(root, args) {
  const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'migrate', '--json', ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, API_CONTEXT_DIR: root,
      API_USAGE_LOG: '', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data);
  child.stderr.on('data', data => stderr += data);
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  assert.equal(exit, 0, `${stdout}\n${stderr}`);
  return JSON.parse(stdout);
}

test('renamed bound contract and env file survive CLI dry-run, apply, and idempotent retry', async t => {
  const { root, old, contract, envFile } = renamedSpecimen(t);
  const originalContract = fs.readFileSync(join(root, contract));
  const originalEnvFile = fs.readFileSync(join(root, envFile));
  const dry = await migrateCommand(root, ['--dry-run']);
  assert.equal(dry.dry_run, true);
  assert.equal(fs.existsSync(join(root, LAYOUT.directory)), false);
  assert.deepEqual(fs.readFileSync(join(root, contract)), originalContract);
  const applied = await migrateCommand(root, []);
  assert.equal(applied.requests_executed, 0);
  const folder = join(root, LAYOUT.collection, 'example');
  const stack = JSON.parse(fs.readFileSync(join(folder, 'stack.json'), 'utf8'));
  assert.equal(stack.contract, 'contract.json');
  assert.equal(stack.environments.dev.envFile, '../../config/provider.env');
  assert.deepEqual(fs.readFileSync(join(folder, stack.contract)), originalContract);
  assert.deepEqual(fs.readFileSync(join(folder, stack.environments.dev.envFile)), originalEnvFile);
  const knowledge = JSON.parse(fs.readFileSync(join(folder, 'sannr.json'), 'utf8'));
  assert.equal(knowledge.api.contract, `${LAYOUT.collection}/example/contract.json`);
  assert.equal(fs.existsSync(join(root, old.directory)), false);
  const after = fs.readFileSync(join(folder, 'sannr.json'));
  const retry = await migrateCommand(root, []);
  assert.equal(retry.stack_migration.state, 'noop');
  assert.deepEqual(fs.readFileSync(join(folder, 'sannr.json')), after);
});
