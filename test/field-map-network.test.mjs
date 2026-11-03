import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME, CONTEXT_BASENAME } from '../lib/brand.mjs';
import { viewMapModel } from '../lib/view-records.mjs';
import { renderMapText } from '../lib/map.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'field-map-')));
  const server = spawn(process.execPath, [join(ROOT, 'test/fixtures/field-map-api.mjs')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const requests = [];
  server.on('message', msg => { if (msg.request) requests.push(msg.request); });
  const [{ origins }] = await once(server, 'message');
  t.after(async () => { server.send('close'); await once(server, 'exit'); rmSync(root, { recursive: true, force: true }); });
  const doc = { openapi: '3.0.3', info: { title: 'Synthetic map fixture', version: '1' }, paths: {
    '/items': { get: { responses: { 200: { description: 'OK' } } }, post: { responses: { 201: { description: 'Created' } } } },
    '/health': { head: { responses: { 200: { description: 'OK' } } } },
    '/items/{id}': { get: { responses: { 200: { description: 'OK' } } } },
  } };
  writeFileSync(join(root, 'openapi.json'), JSON.stringify(doc));
  for (const name of Object.keys(origins)) {
    const folder = join(root, LAYOUT.collection, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'openapi.json'), JSON.stringify(doc));
    writeFileSync(join(folder, 'stack.json'), JSON.stringify({ v: 1, name, contract: 'openapi.json', default_environment: 'local',
      environments: { local: { baseUrl: origins[name], auth: `bearer:${name.toUpperCase()}_FIXTURE_TOKEN`, headers: { 'x-fixture-stack': name } } } }));
    writeFileSync(join(folder, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name, contract: `${LAYOUT.collection}/${name}/openapi.json` }, operations: {
      'GET /items': { notes: [], fields: {}, verified_at: null },
      'HEAD /health': { notes: [], fields: {}, verified_at: null },
    } }));
  }
  writeFileSync(join(root, LAYOUT.directory, 'defaults.json'), JSON.stringify({ default_stack: 'alpha' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_|SANNR_|NODE_OPTIONS$)/.test(key)));
  Object.assign(env, { HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'), NO_COLOR: '1', API_FRICTION_OFF: '1' });
  for (const name of Object.keys(origins)) env[`${name.toUpperCase()}_FIXTURE_TOKEN`] = `local-${name}-fixture-token`;
  const preload = join(root, 'clock-and-network.mjs');
  writeFileSync(preload, `import { appendFileSync, readFileSync } from 'node:fs';
const ActualDate = Date; globalThis.Date = class extends ActualDate { constructor(...args) { super(...(args.length ? args : ['2026-10-08T12:00:00.000Z'])); } static now() { return 1791460800000; } };
const write = process.stderr.write.bind(process.stderr); process.stderr.write = (...args) => { appendFileSync(process.env.FIXTURE_STDERR, args[0]); return write(...args); };
const fetch = globalThis.fetch; globalThis.fetch = (...args) => { if (process.env.FIXTURE_BLOCK === '1') throw new Error('synthetic network blocked');
if (process.env.FIXTURE_REQUIRE_PLAN === '1' && !readFileSync(process.env.FIXTURE_STDERR, 'utf8').includes('MAP_PROBE_PLAN')) throw new Error('request before plan'); return fetch(...args); };
`);
  env.NODE_OPTIONS = `--import=${preload}`;
  let counter = 0;
  const run = async (args, extra = {}) => {
    const stderrFile = join(root, `stderr-${counter++}.txt`); writeFileSync(stderrFile, '');
    const child = spawn(process.execPath, [join(ROOT, 'bin/cli.mjs'), ...args], { cwd: root,
      env: { ...env, FIXTURE_STDERR: stderrFile, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    if (extra.FIXTURE_CLOSE_STDERR === '1') child.stderr.destroy();
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  };
  return { root, origins, requests, run };
}

test('MAP-001: default map and view HTML are byte-identical with network allowed or blocked', async t => {
  const f = await fixture(t);
  for (const command of ['map', 'view']) {
    const file = join(f.root, `${command}.html`);
    const allowed = await f.run([command, '--out', file]);
    assert.equal(allowed.code, 0, allowed.stderr);
    const before = readFileSync(file, 'utf8');
    const blocked = await f.run([command, '--out', file], { FIXTURE_BLOCK: '1' });
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.equal(readFileSync(file, 'utf8'), before, `${command} output changes with network availability (clock fixed identically)`);
  }
  assert.equal(f.requests.length, 0, 'visualization defaults must not send requests');
});

for (const command of ['map', 'view']) test(`MAP-001: ${command} --execute announces all targets first, routes three stacks and saves authenticated evidence`, async t => {
  const f = await fixture(t);
  const result = await f.run([command, '--execute', '--out', join(f.root, `${command}.html`)], { FIXTURE_REQUIRE_PLAN: '1' });
  assert.equal(result.code, 0, result.stderr);
  const plan = result.stderr.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(row => row.code === 'MAP_PROBE_PLAN');
  const page = readFileSync(join(f.root, `${command}.html`), 'utf8');
  assert.match(page, /Content-Security-Policy/);
  assert.doesNotMatch(page, /<script|<iframe|<object|<embed|\son[a-z]+=/i);
  assert.ok(!page.includes('local-item'), 'response values never enter the map');
  for (const name of ['alpha', 'beta', 'gamma']) assert.ok(!page.includes(`local-${name}-fixture-token`));
  assert.equal(plan?.count, 6, result.stderr);
  assert.equal(plan.targets.length, 6);
  assert.equal(f.requests.length, 6);
  for (const name of ['alpha', 'beta', 'gamma']) {
    const calls = f.requests.filter(row => row.stack === name);
    assert.deepEqual(calls.map(row => `${row.method} ${row.path}`).sort(), ['GET /items', 'HEAD /health']);
    assert.ok(calls.every(row => row.authorization === `Bearer local-${name}-fixture-token` && row.marker === name));
    assert.equal(plan.targets.filter(row => row.stack === name && row.base_url === f.origins[name]).length, 2);
    const folder = join(f.root, LAYOUT.evidence, name);
    const evidence = readdirSync(folder).filter(file => /^run-.*\.json$/.test(file)).map(file => JSON.parse(readFileSync(join(folder, file))));
    assert.equal(evidence.length, 2);
    for (const record of evidence) {
      assert.equal(record.response.status, 200);
      assert.equal(record.origin.initiator, `cli.${command}`);
      assert.ok(record.request.url.startsWith(f.origins[name]));
    }
  }
  if (command === 'map') {
    const retained = JSON.parse(readFileSync(join(f.root, LAYOUT.evidence, 'view', 'records', 'map.json')));
    assert.equal(retained.model.map_execution?.responses, 6, 'retained map must preserve declared read counts');
    assert.equal(retained.model.map_execution?.requests.length, 6);
    assert.ok(retained.model.map_execution.requests.every(row => !Object.hasOwn(row, 'base_url') && !Object.hasOwn(row, 'evidence')), 'retained map keeps structural read identities, not target URLs or private evidence paths');
    const later = await f.run(['view', '--out', join(f.root, 'later-view.html')], { FIXTURE_BLOCK: '1' });
    assert.equal(later.code, 0, later.stderr);
    assert.match(renderMapText(viewMapModel(retained.model)), /6 responses from 6 announced read attempts/);
    assert.equal(f.requests.length, 6, 'retained read summaries do not re-execute reads');
  }
  assert.equal(plan.omitted.filter(row => row.reason === 'unresolved-path-parameters').reduce((sum, row) => sum + row.count, 0), 3);
  for (const name of ['alpha', 'beta', 'gamma']) assert.ok(!result.stderr.includes(`local-${name}-fixture-token`));
});


test('MAP-001: explicit reads never follow redirects or retry throttles; ordinary requests still follow redirects', async t => {
  const f = await fixture(t);
  const file = join(f.root, LAYOUT.collection, 'alpha', 'openapi.json');
  const contract = JSON.parse(readFileSync(file));
  contract.paths = Object.fromEntries(['/redirect', '/throttle'].map(path => [path, { get: { responses: { 200: { description: 'OK' } } } }]));
  writeFileSync(file, JSON.stringify(contract));
  const result = await f.run(['map', '--execute', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.requests.filter(row => row.stack === 'alpha').map(row => row.path), ['/redirect', '/throttle']);
  const report = JSON.parse(result.stdout).map_execution;
  assert.deepEqual(report.requests.filter(row => row.stack === 'alpha').map(row => row.status), [302, 429]);
  assert.equal(report.attempted, 6);
  const before = f.requests.length;
  const ordinary = await f.run(['request', 'GET', '/redirect', '--stack', 'alpha']);
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.deepEqual(f.requests.slice(before).map(row => row.path), ['/redirect', '/items']);
});

test('MAP-001: OAuth is omitted before the plan; absent credentials never become an unauthenticated probe', async t => {
  const f = await fixture(t);
  const file = join(f.root, LAYOUT.collection, 'alpha', 'stack.json');
  const stack = JSON.parse(readFileSync(file));
  stack.environments.local.auth = 'oauth:FIXTURE_CLIENT_ID:FIXTURE_CLIENT_SECRET';
  stack.environments.local.tokenUrl = `${f.origins.alpha}/token`;
  writeFileSync(file, JSON.stringify(stack));
  const result = await f.run(['map', '--execute', '--json'], { BETA_FIXTURE_TOKEN: '' });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout).map_execution;
  assert.equal(report.planned, 4);
  assert.ok(report.omitted.some(row => row.stack === 'alpha' && row.reason === 'oauth-grant-requires-explicit-request' && row.count === 2));
  assert.deepEqual(new Set(f.requests.map(row => row.stack)), new Set(['gamma']));
  assert.equal(report.requests.filter(row => row.stack === 'beta' && row.refusal && row.attempts === 0).length, 2);
});

test('MAP-001: --no-execute wins over --execute without opening the client', async t => {
  const f = await fixture(t);
  for (const command of ['map', 'view']) {
    const result = await f.run([command, '--execute', '--no-execute', '--out', join(f.root, `${command}.html`)], { FIXTURE_BLOCK: '1' });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stderr.includes('MAP_PROBE_PLAN'));
  }
  assert.equal(f.requests.length, 0);
});


test('MAP-001: a closed announcement stream refuses execution before any traffic', async t => {
  const f = await fixture(t);
  const result = await f.run(['map', '--execute', '--json'], { FIXTURE_CLOSE_STDERR: '1' });
  assert.notEqual(result.code, 0);
  assert.equal(f.requests.length, 0);
});

test('MAP-001: an umbrella of legacy surfaces uses each own auth, headers and evidence directory', async t => {
  const f = await fixture(t);
  const contract = readFileSync(join(f.root, 'openapi.json'));
  rmSync(join(f.root, LAYOUT.collection), { recursive: true });
  rmSync(join(f.root, LAYOUT.directory, 'defaults.json'));
  for (const name of ['alpha', 'beta', 'gamma']) {
    const dir = join(f.root, name); mkdirSync(dir);
    writeFileSync(join(dir, 'openapi.json'), contract);
    const config = join(dir, LAYOUT.environments); mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ default: 'local', environments: { local: {
      baseUrl: f.origins[name], auth: `bearer:${name.toUpperCase()}_FIXTURE_TOKEN`, headers: { 'x-fixture-stack': name },
    } } }));
  }
  const result = await f.run(['map', '--execute', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout).map_execution;
  assert.equal(report.planned, 6);
  assert.equal(f.requests.length, 6);
  for (const name of ['alpha', 'beta', 'gamma']) {
    assert.ok(f.requests.filter(row => row.stack === name).every(row => row.authorization === `Bearer local-${name}-fixture-token` && row.marker === name));
    const folder = join(f.root, name, LAYOUT.evidence);
    assert.equal(readdirSync(folder).filter(file => /^run-.*\.json$/.test(file)).length, 2);
  }
});
