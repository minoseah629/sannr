import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { codeLocations, forOperationCode, withCodeLocations } from '../lib/code-locations.mjs';
import { createSourceScan, withSourceScan } from '../lib/source-scan.mjs';
import { buildMapModel } from '../lib/map.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';

const write = (root, file, value) => {
  const target = resolve(root, file); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); return target;
};
const contract = (title, paths) => ({ openapi: '3.0.3', info: { title, version: '1' },
  paths: Object.fromEntries(paths.map(path => [path, { get: { responses: { 200: { description: 'ok' } } } }])) });
const project = t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'code-locations-')));
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  const home = join(root, '.home'); mkdirSync(home);
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state');
  t.after(() => {
    for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(root, { recursive: true, force: true });
  }); return root;
};

test('explicit structural legacy config avoids credential resolution without changing the default join', t => {
  const root = project(t);
  const marker = 'SURVEY_CREDENTIAL_RESOLUTION_TEST';
  t.after(() => { delete process.env[marker]; });
  const contractFile = write(root, 'openapi.json', contract('Legacy', ['/items']));
  const envFile = write(root, '.env', `${marker}=must-not-load\n`);
  write(root, LAYOUT.environments, { v: 1, default: 'local', environments: {
    local: { baseUrl: 'https://legacy.example.test', contract: contractFile, envFile },
  } });
  write(root, 'src/client.mjs', 'fetch("https://legacy.example.test/items");\n');
  const model = withCodeLocations(root, () => codeLocations(root), { legacyConfig: {
    name: 'local', baseUrl: 'https://legacy.example.test', baseUrlSource: 'config', contract: contractFile,
  }, excludeFiles: [envFile] });
  assert.equal(process.env[marker], undefined, 'structural scanning must not load a credential file');
  assert.equal(model.stacks[''].operations['GET /items'].called_from.length, 1);
});

test('a contract copy locates parameterized routes only in its uniquely bound service', t => {
  const root = project(t);
  write(root, 'openapi.json', contract('Parent', ['/files/{fileId}']));
  write(root, 'src/files.mjs', 'app.get("/files/:id", handler);\n');
  write(root, 'child/openapi.json', contract('Child', ['/files/{fileId}']));
  write(root, 'child/src/files.mjs', 'app.get("/files/:id", childHandler);\n');
  createFixtureStack(root, { name: 'files', contract: 'openapi.json' });
  const model = codeLocations(root), op = model.stacks.files.operations['GET /files/{fileId}'];
  assert.deepEqual(op.defined_in.map(value => [value.file, value.line, value.code_path]), [['src/files.mjs', 1, '/files/:id']]);
  assert.ok(model.unmatched.routes.some(value => value.file === 'child/src/files.mjs'));
  // Two independently discovered services carrying identical contract bytes are
  // ambiguous. A copied stack contract must not choose either by path similarity.
  copyFileSync(join(root, 'openapi.json'), join(root, 'child/openapi.json'));
  assert.equal(codeLocations(root).stacks.files.operations['GET /files/{fileId}'].defined_in.length, 0);
  // A stack can bind distinct service contracts for two environments. Their
  // shared operation spelling does not erase which environment owns a source.
  write(root, 'child/openapi.json', contract('Child', ['/files/{fileId}']));
  const folder = join(root, LAYOUT.collection, 'files');
  copyFileSync(join(root, 'child/openapi.json'), join(folder, 'staging.json'));
  write(root, join(folder, 'stack.json'), { v: 1, name: 'files', contract: 'openapi.json', default_environment: 'production',
    environments: { production: { baseUrl: 'https://files.example.test' },
      staging: { baseUrl: 'https://staging-files.example.test', contract: 'staging.json' } } });
  const separated = codeLocations(root).stacks.files.operations['GET /files/{fileId}'].defined_in;
  assert.deepEqual(separated.map(value => [value.file, value.environments]), [
    ['child/src/files.mjs', ['staging']], ['src/files.mjs', ['production']],
  ]);
});

test('an outbound call needs a unique stack and the configured mounted operation', t => {
  const root = project(t);
  write(root, 'contracts/billing.json', contract('Billing', ['/invoices']));
  write(root, 'contracts/other.json', contract('Other', ['/customers']));
  createFixtureStack(root, { name: 'billing', contract: 'contracts/billing.json', environment: 'staging', baseUrl: 'https://billing.example.test/v2' });
  createFixtureStack(root, { name: 'other', contract: 'contracts/other.json', environment: 'staging', baseUrl: 'https://billing.example.test/v2' });
  write(root, 'src/invoices.mjs', 'const BASE = "https://billing.example.test/v2";\nfetch(`${BASE}/invoices`);\nfetch(new URL("/invoices", BASE));\nconst prepared = `${BASE}/invoices`;\n');
  const first = codeLocations(root);
  assert.deepEqual(first.stacks.billing.operations['GET /invoices'].called_from.map(value => [value.file, value.line, value.environments]),
    [['src/invoices.mjs', 2, ['staging']]]);
  assert.equal(first.stacks.other.operations['GET /customers'].called_from.length, 0);
  assert.equal(first.unmatched.hosts[0].reason, 'ambiguous-stack');
  assert.ok(first.unmatched.hosts.some(value => value.file === 'src/invoices.mjs' && value.line === 4 && value.kind === 'binding'));
  write(root, join(LAYOUT.collection, 'other', 'other.json'), contract('Other', ['/invoices']));
  const ambiguous = codeLocations(root);
  assert.equal(ambiguous.stacks.billing.operations['GET /invoices'].called_from.length, 0);
  assert.equal(ambiguous.stacks.other.operations['GET /invoices'].called_from.length, 0);
});

test('remembered missing sources and secret-shaped paths remain visible without revealing values or changing knowledge', t => {
  const root = project(t), secret = `sk_live_${'x'.repeat(32)}`;
  write(root, 'contracts/spec.json', contract('Files', ['/missing', '/secret', '/existing']));
  createFixtureStack(root, { name: 'files', contract: 'contracts/spec.json' });
  write(root, 'src/existing.mjs', 'export const value = 1;\n');
  write(root, `src/${secret}.mjs`, 'fetch("https://fixture.example.test/secret");\nfetch("https://fixture.example.test/existing");\n');
  const file = fixtureContextFile(root, 'files');
  write(root, file, { v: 0, api: { name: 'Files' }, operations: {
    'GET /missing': { source_file: 'src/deleted.mjs', notes: ['Keep this lesson.'] },
    'GET /secret': { source_file: `src/${secret}.mjs`, notes: [] },
    'GET /existing': { source_file: 'src/existing.mjs', notes: [] },
  } });
  const before = readFileSync(file, 'utf8'), model = codeLocations(root);
  assert.equal(model.stacks.files.operations['GET /missing'].defined_in[0].state, 'not-found');
  assert.equal(model.stacks.files.operations['GET /existing'].defined_in[0].state, 'remembered');
  assert.equal(model.stacks.files.operations['GET /secret'].called_from[0].file, 'withheld');
  assert.equal(model.summary.withheld_paths, 1);
  assert.equal(model.stacks.files.summary.withheld_paths, 1, 'one withheld file counts once across its references and requests');
  assert.deepEqual(model.stacks.files.operations['GET /secret'].defined_in, [], 'a current withheld source does not become a duplicate remembered location');
  assert.ok(!JSON.stringify(model).includes(secret));
  assert.equal(readFileSync(file, 'utf8'), before);
  const shown = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cli.mjs', import.meta.url)),
    'show', '--stack', 'files', 'GET /secret', '--json'], { cwd: root, env: process.env, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stderr + shown.stdout);
  assert.ok(!shown.stdout.includes(secret), 'show withholds the source path from both its legacy fields and code section');
  write(root, 'src/solo.mjs', 'app.get("/unbound", handler);\n');
  assert.ok(codeLocations(root).unmatched.routes.some(value => value.path === '/unbound'));
});

test('a large source tree shares one scan while retaining matched operation locations', async t => {
  const root = project(t);
  write(root, 'openapi.json', contract('Large', ['/items/{itemId}']));
  createFixtureStack(root, { name: 'items', contract: 'openapi.json' });
  write(root, 'src/routes.mjs', 'app.get("/items/:id", handler);\n');
  for (const functionsPerFile of [0, 40]) {
    for (let i = 0; i < 5000; i++) write(root, `src/generated/file-${i}.mjs`, functionsPerFile
      ? Array.from({ length: functionsPerFile }, (_, n) =>
        `export function helper${n}(value) { const local${n} = value + ${n}; return local${n}; }`).join('\n') + '\n'
      : `export const item${i} = ${i};\n`);
    const scan = createSourceScan(root);
    await withSourceScan(scan, () => withCodeLocations(root, async () => {
      const footprint = await buildMapModel(root, { execute: false });
      assert.ok(footprint);
      const result = forOperationCode(root, 'items', 'GET /items/{itemId}');
      assert.deepEqual(result.defined_in.map(value => value.file), ['src/routes.mjs']);
      assert.equal(codeLocations(root).stacks.items.operations['GET /items/{itemId}'], result);
    }));
    assert.ok(scan.stats.files_read.length >= 5000);
    assert.equal(new Set(scan.stats.files_read).size, scan.stats.files_read.length);
    // Forty functions in each unrelated utility file used to turn every local
    // declaration into a search across the whole repository's function list.
    // Check bounded work rather than pinning a machine-dependent duration.
    assert.ok(scan.stats.route_candidate_files < 10, JSON.stringify(scan.stats));
    assert.ok(scan.stats.route_scopes_indexed < 10, JSON.stringify(scan.stats));
    t.diagnostic(`${functionsPerFile} functions/file: ${scan.stats.route_candidate_files} route candidates, ${scan.stats.route_scope_comparisons ?? 0} scope comparisons`);
    write(root, 'AGENTS.md', `Generated pointer after the ${functionsPerFile}-function scan.\n`);
    const warm = createSourceScan(root);
    await withSourceScan(warm, () => withCodeLocations(root, async () => {
      await buildMapModel(root, { execute: false });
      assert.deepEqual(forOperationCode(root, 'items', 'GET /items/{itemId}').defined_in.map(value => value.file), ['src/routes.mjs']);
    }));
    assert.equal(warm.stats.content_reads, 0, 'a fresh tool call reuses unchanged source bytes');
    assert.ok(warm.stats.derived_hits > 0, 'unchanged source discovery is reused across calls, including after pointer writes');
  }
});
