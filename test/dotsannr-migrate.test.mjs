import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { PRODUCT, CONTEXT_BASENAME, POINTER_BEGIN, POINTER_END, HOME_ENV_NAME } from '../lib/brand.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function specimen(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'layout-migrate-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const env = { ...process.env, [HOME_ENV_NAME]: join(root, 'home'), API_USAGE_LOG: '' };
  for (const key of ['API_CONFIG', 'API_BASE_URL', 'API_ENV', 'API_CONTRACT', 'API_CONTEXT_DIR', 'API_EVIDENCE']) delete env[key];
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  const context = { v: 0, api: { contract: 'openapi.json' }, operations: {} };
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'API', version: '1' }, paths: {} }));
  writeFileSync(join(root, CONTEXT_BASENAME), JSON.stringify(context));
  writeFileSync(join(root, 'api-request.md'), '# Existing request convention\n');
  writeFileSync(join(root, 'AGENTS.md'), `User instructions\n${POINTER_BEGIN}\nRead ${CONTEXT_BASENAME} and api-request.md.\n${POINTER_END}\n`);
  return { root, run, context };
}

test('DOTSANNR-1 migrate moves a legacy install, rewrites only managed pointers, and is idempotent', async t => {
  const { root, run, context } = specimen(t);
  const first = run('migrate', '--json');
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const { LAYOUT } = await import('../lib/layout.mjs');
  const migrated = JSON.parse(readFileSync(join(root, LAYOUT.collection, 'api', CONTEXT_BASENAME)));
  assert.deepEqual(migrated.operations, context.operations);
  assert.equal(migrated.api.contract, `${LAYOUT.collection}/api/openapi.json`);
  assert.equal(readFileSync(join(root, LAYOUT.skillGuide), 'utf8'), '# Existing request convention\n');
  assert.equal(existsSync(join(root, CONTEXT_BASENAME)), false);
  assert.equal(existsSync(join(root, 'api-request.md')), false);
  const pointer = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(pointer.startsWith('User instructions\n'));
  assert.ok(pointer.includes(LAYOUT.context));
  assert.ok(pointer.includes(LAYOUT.skillGuide));
  const second = run('migrate', '--json');
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).moved, []);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), pointer);
});

test('DOTSANNR-1 migrate refuses a named conflicting destination before moving any source', async t => {
  const { root, run } = specimen(t);
  const { LAYOUT } = await import('../lib/layout.mjs');
  mkdirSync(dirname(join(root, LAYOUT.context)), { recursive: true });
  writeFileSync(join(root, LAYOUT.context), 'destination must survive');
  const result = run('migrate', '--json');
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /MIGRATION_CONFLICT/);
  assert.ok((result.stdout + result.stderr).includes(LAYOUT.context));
  assert.equal(readFileSync(join(root, LAYOUT.context), 'utf8'), 'destination must survive');
  assert.ok(existsSync(join(root, CONTEXT_BASENAME)));
  assert.ok(existsSync(join(root, 'api-request.md')));
});

test('DOTSANNR-1 doctor names a legacy install and gives the migrate fix', t => {
  const { run } = specimen(t);
  const result = run('doctor', '--offline', '--json');
  const report = JSON.parse(result.stdout);
  const row = report.checks.find(row => row.name === 'layout');
  assert.ok(row, 'doctor must diagnose layout separately');
  assert.equal(row.state, 'WARN');
  assert.match(row.fix, /migrate/);
  assert.ok(row.detail.includes(CONTEXT_BASENAME));
});

test('DOTSANNR-1 doctor recognizes a legacy request skill by name', async t => {
  const { root, run } = specimen(t);
  const { SKILL_SOURCES, renderSkill } = await import('../lib/connect.mjs');
  const { LEGACY_SKILL_NAMES, SKILL_NAMES } = await import('../lib/brand.mjs');
  const legacy = LEGACY_SKILL_NAMES.request[0];
  const path = join(root, '.claude', 'skills', legacy, 'SKILL.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSkill(SKILL_SOURCES[0], null).replace(`name: ${SKILL_NAMES.request}`, `name: ${legacy}`));
  const result = run('doctor', '--offline', '--json');
  const row = JSON.parse(result.stdout).checks.find(row => row.name === 'skills');
  assert.ok(row.detail.includes(legacy), row.detail);
  assert.match(row.fix, /migrate/);
});

test('DOTSANNR-1 migration rewrites generated native registrations including Codex inline env', async t => {
  const { root, run } = specimen(t);
  const { LAYOUT, LEGACY_LAYOUT } = await import('../lib/layout.mjs');
  const { serverEntry, codexServerBlock } = await import('../lib/connect.mjs');
  const { MCP_SERVER_KEY } = await import('../lib/brand.mjs');
  const entry = serverEntry({ configPath: join(root, LEGACY_LAYOUT.environments),
    evidencePath: join(root, LEGACY_LAYOUT.evidence), contextPath: root });
  writeFileSync(join(root, LEGACY_LAYOUT.environments), '{}');
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry, unrelated: { command: 'keep' } } }));
  mkdirSync(join(root, '.codex'));
  writeFileSync(join(root, '.codex', 'config.toml'), codexServerBlock(entry));
  const result = run('migrate', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const file of ['.mcp.json', '.codex/config.toml']) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.ok(text.includes(join(root, LAYOUT.environments)), file);
    assert.ok(text.includes(join(root, LAYOUT.evidence)), file);
  }
  assert.equal(JSON.parse(readFileSync(join(root, '.mcp.json'))).mcpServers.unrelated.command, 'keep');
});

test('DOTSANNR-1 one product and collection rename plus migrate updates the complete installed trail', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'layout-full-rename-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Rename fixture', version: '1' }, paths: { '/health': { get: { responses: { '200': { description: 'ready' } } } } } }));
  const { LAYOUT, layoutFor } = await import('../lib/layout.mjs');
  const { CI_WORKFLOW_BASENAME } = await import('../lib/brand.mjs');
  const nextProduct = 'renamed-product', nextCollection = 'renamed-collection', next = layoutFor(nextProduct, nextCollection);
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_')));
  const invoke = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: root,
    env: { ...baseEnv, [HOME_ENV_NAME]: join(root, 'home'), API_USAGE_LOG: '', ...extra }, encoding: 'utf8' });
  let result = invoke(['connect', '--ci', '--install', 'registry', '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const changed = { API_CONTEXT_PRODUCT_NAME: nextProduct, API_CONTEXT_COLLECTION_NAME: nextCollection };
  result = invoke(['migrate', '--json'], changed);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const migratedContext = `${next.collection}/rename-fixture/${nextProduct}.json`;
  assert.ok(existsSync(join(root, migratedContext)));
  assert.equal(existsSync(join(root, LAYOUT.directory)), false);
  // alpha.10 connect creates a named stack before this branding migration.
  // Its actual pointer must track both renamed axes and the per-stack store.
  const pointer = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(pointer.includes(migratedContext));
  assert.ok(!pointer.includes(`${LAYOUT.collection}/rename-fixture/${CONTEXT_BASENAME}`));
  assert.equal(existsSync(join(root, next.context)), false, 'migration must not add a parallel single-store path');
  for (const role of ['request', 'write', 'feedback']) for (const base of [next.skills, '.agents/skills', '.claude/skills']) {
    const body = readFileSync(join(root, base, `${nextProduct}-${role}`, 'SKILL.md'), 'utf8');
    assert.ok(body.includes(`name: ${nextProduct}-${role}`));
    assert.ok(!body.includes(LAYOUT.context));
  }
  const workflow = join(root, '.github', 'workflows', CI_WORKFLOW_BASENAME.replace(PRODUCT, nextProduct));
  assert.ok(readFileSync(workflow, 'utf8').includes(next.context));
  result = invoke(['migrate', '--json'], changed);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).moved, []);
  assert.deepEqual(JSON.parse(result.stdout).updated, []);
});
