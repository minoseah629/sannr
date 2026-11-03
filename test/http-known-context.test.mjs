import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { LAYOUT as REPO_LAYOUT } from '../lib/layout.mjs';
import { resolveStack } from '../lib/stacks.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';
const LAYOUT = { ...REPO_LAYOUT, context: join(REPO_LAYOUT.collection, 'fixture', 'sannr.json') };
import { captureHttpContext, queryHttpContext, compactHttpContext } from '../lib/http-operation-context.mjs';

const client = new URL('../lib/client.mjs', import.meta.url).href;
const execute = promisify(execFile);

async function fixture(t, handler) {
  const root = mkdtempSync(join(tmpdir(), 'http-known-context-'));
  const server = createServer(handler ?? ((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"label":"private-response-value","count":1}');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: { '/items/{id}': { get: {} } } }));
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: origin, contract: 'openapi.json' }, other: { baseUrl: origin, contract: 'openapi.json' },
  } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { API_CONFIG: join(root, LAYOUT.environments), API_CONTEXT_DIR: root,
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'),
    SANNR_HOME: join(root, 'home'), API_CONTEXT_OFF: '0', API_FRICTION_OFF: '1', API_BUDGET: '4000' });
  // R7: legacy-shaped fixture configuration remains a convenient test input,
  // but every capture request resolves current, independently scoped stacks.
  const syncStacks = () => {
    const configured = JSON.parse(readFileSync(join(root, LAYOUT.environments), 'utf8'));
    const environments = Object.fromEntries(Object.entries(configured.environments).map(([name, value]) =>
      [name, { ...value, contract: `../../../${value.contract}` }]));
    writeFileSync(join(root, REPO_LAYOUT.collection, 'fixture', 'stack.json'), JSON.stringify({ v: 1, name: 'fixture',
      default_environment: configured.default, environments }));
    writeFileSync(join(root, REPO_LAYOUT.directory, 'defaults.json'), JSON.stringify({ default_stack: 'fixture' }));
    for (const [name, value] of Object.entries(configured.hosts ?? {}))
      writeFileSync(join(root, REPO_LAYOUT.collection, name, 'stack.json'), JSON.stringify({ v: 1, name,
        default_environment: 'local', environments: { local: { ...value, contract: `../../../${value.contract}` } } }));
  };
  const scope = fn => { syncStacks(); return withStackScope(resolveStack(root, { stack: 'fixture', environment: 'local' }), fn); };
  const run = async (program, overrides = {}) => {
    syncStacks();
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      `const { apiRequest } = await import(${JSON.stringify(client)}); ${program}`],
    { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const request = (args = { path: '/items/42' }, overrides) =>
    run(`process.stdout.write(JSON.stringify(await apiRequest(${JSON.stringify(args)})));`, overrides);
  return { root, origin, env, run, request, scope };
}

test('later HTTP requests receive saved statuses, shapes and assertions separately from legacy verification', async t => {
  let calls = 0;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(++calls === 1 ? 422 : 200, { 'content-type': 'application/json' });
    res.end('{"label":"private-response-value","count":1,"authorization":"private-response-auth"}');
  });
  const legacy = { verified_at: null, contract_digest: null, shape_hash: null, status_codes: [], fields: {},
    notes: ['Existing author guidance with an unchecked run reference.'] };
  writeFileSync(join(f.root, LAYOUT.context), JSON.stringify({ v: 0, api: {}, operations: { 'GET /items/{id}': legacy } }));
  const result = await f.run(`
    const first = await apiRequest({ path: '/items/41', params: { filter: 'private-query-value' }, expect: [{ status: 422 }] });
    const second = await apiRequest({ path: '/items/42' });
    const third = await apiRequest({ path: '/items/43', capture_context: false });
    process.stdout.write(JSON.stringify({ first, second, third }));`);
  assert.equal(result.first.ok, true);
  assert.equal(result.first.known.scoped, undefined, 'a call cannot return its own observation as prior knowledge');
  const first = result.second.known.scoped.observations[0];
  assert.equal(first.id, result.first.context_capture.observation_id);
  assert.notEqual(first.id, result.second.context_capture.observation_id);
  assert.equal(first.verification, 'client-observation');
  assert.equal(first.response_status, 422);
  assert.equal(first.outcome, 'error');
  assert.deepEqual(first.assertions, { passed: 1, failed: 0 });
  assert.equal(result.second.assertions, null, 'earlier assertions are not assertions of this request');
  assert.equal(first.response_shape.properties.label.type, 'string');
  assert.equal(first.request_shape.properties.params.properties.filter.type, 'string');
  assert.equal(first.evidence[0].state, 'matching');
  assert.equal(first.declaration.responseValidated, false);
  assert.deepEqual(result.second.known.notes, legacy.notes);
  assert.equal(result.second.known.verified_at, null);
  assert.equal(result.second.known.confidence, 'unverified');
  assert.deepEqual(result.third.context_capture, { state: 'disabled', reason: 'request-opt-out' });
  assert.deepEqual(result.third.known.scoped.observations.map(o => o.response_status), [200, 422]);
  assert.equal(result.third.known.scoped.observations[0].assertions, undefined);
  assert.doesNotMatch(JSON.stringify(result.third.known.scoped), /private-response-value|private-response-auth|private-query-value|\/items\/4[123]/);
  const saved = JSON.parse(readFileSync(join(f.root, LAYOUT.context), 'utf8'));
  assert.deepEqual(saved.operations['GET /items/{id}'], legacy);
  assert.equal(Object.values(saved.api_context.operations)[0].observations.length, 2);
});

test('named upstreams retrieve their own scoped history without primary legacy notes', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'vendor.json'), JSON.stringify({ openapi: '3.0.0', paths: { '/items/{id}': { get: {} } } }));
  writeFileSync(join(f.root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: f.origin, contract: 'openapi.json' },
  }, hosts: { vendor: { baseUrl: `${f.origin}/vendor`, contract: 'vendor.json', contractPathPrefix: '/vendor' } } }));
  writeFileSync(join(f.root, LAYOUT.context), JSON.stringify({ v: 0, api: {}, operations: {
    'GET /vendor/items/{id}': { notes: ['Primary-only guidance must not cross into vendor context.'] },
  } }));
  const result = await f.run(`
    const primary = await apiRequest({ path: '/items/41' });
    const first = await apiRequest({ upstream: 'vendor', path: '/items/42' });
    const second = await apiRequest({ upstream: 'vendor', path: '/items/43' });
    process.stdout.write(JSON.stringify({ primary, first, second }));`);
  assert.equal(result.first.known, null);
  const known = result.second.known;
  assert.equal(known.notes, undefined);
  assert.equal(known.verified_at, undefined);
  assert.equal(known.scoped.identity.provider, `${f.origin}/vendor`);
  assert.equal(known.scoped.identity.endpoint, `${f.origin}/vendor/items/{id}`);
  assert.equal(known.scoped.identity.operation, 'GET /items/{id}');
  assert.deepEqual(known.scoped.observations.map(o => o.id), [result.first.context_capture.observation_id]);
  assert.notEqual(known.scoped.observations[0].id, result.primary.context_capture.observation_id);
});

test('environment, contract, route and explicit API overrides cannot borrow scoped HTTP history', async t => {
  const f = await fixture(t);
  await f.request();
  const otherEnvironment = await f.request({ path: '/items/43' }, { API_ENV: 'other' });
  assert.equal(otherEnvironment.ok, true);
  assert.equal(otherEnvironment.context_capture.state, 'captured');
  assert.equal(otherEnvironment.known?.scoped, undefined);
  // Same declared routes, different bytes: a new contract identity, not a re-verification.
  writeFileSync(join(f.root, 'changed.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'changed' }, paths: { '/items/{id}': { get: {} } } }));
  // R3: ambient single-provider overrides cannot redirect a selected stack.
  const ambient = await f.request({ path: '/items/44' }, { API_CONTRACT: join(f.root, 'changed.json') });
  assert.ok(ambient.known?.scoped, 'The selected stack retains its own declared contract');
  const configured = JSON.parse(readFileSync(join(f.root, LAYOUT.environments), 'utf8'));
  configured.environments.local.contract = 'changed.json';
  writeFileSync(join(f.root, LAYOUT.environments), JSON.stringify(configured));
  assert.equal((await f.request({ path: '/items/44' })).known?.scoped, undefined);
  const unknown = await f.request({ path: '/unbound/45', capture_context: true });
  assert.equal(unknown.known?.scoped, undefined);
  assert.equal(unknown.context_capture.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  const override = await f.request({ path: '/items/46' }, { API_BASE_URL: `${f.origin}/elsewhere` });
  assert.ok(override.known?.scoped, 'An ambient base override cannot borrow another provider or replace stack configuration');
  assert.equal(override.context_capture.identity.provider, f.origin);
  configured.environments.local.baseUrl = `${f.origin}/elsewhere`;
  writeFileSync(join(f.root, LAYOUT.environments), JSON.stringify(configured));
  const changedProvider = await f.request({ path: '/items/47' });
  assert.equal(changedProvider.known?.scoped, undefined, 'A real stack configuration change cannot borrow old provider history');
  const saved = Object.values(JSON.parse(readFileSync(join(f.root, LAYOUT.context), 'utf8')).api_context.operations)[0];
  for (const changed of [
    { provider: 'https://different.example.invalid' }, { environment: 'unobserved' },
    { endpoint: `${f.origin}/different/{id}` }, { operation: 'POST /items/{id}' },
    { contractDigest: null },
  ]) assert.equal(f.scope(() => queryHttpContext(f.root, { ...saved.identity, ...changed }, { env: f.env })), null);
});

test('global context opt-out suppresses retrieval and leaves saved observations unchanged', async t => {
  const f = await fixture(t);
  await f.request();
  const before = readFileSync(join(f.root, LAYOUT.context), 'utf8');
  const disabled = await f.request({ path: '/items/44', capture_context: true }, { API_CONTEXT_OFF: '1' });
  assert.equal(disabled.known, null);
  assert.deepEqual(disabled.context_capture, { state: 'disabled', reason: 'API_CONTEXT_OFF' });
  assert.equal(readFileSync(join(f.root, LAYOUT.context), 'utf8'), before);
});

test('damaged scoped history cannot fail an otherwise successful HTTP response', async t => {
  const f = await fixture(t);
  await f.request();
  const file = join(f.root, LAYOUT.context), saved = JSON.parse(readFileSync(file, 'utf8'));
  saved.api_context.v = 99;
  writeFileSync(file, JSON.stringify(saved));
  const result = await f.request();
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.context_capture.state, 'failed');
  assert.equal(result.known.scoped.observations.length, 0);
  assert.ok(result.known.scoped.issues.some(issue => issue.code.startsWith('CONTEXT_')));
});

test('large prior observations pay the HTTP response budget, with explicit omissions', async t => {
  const f = await fixture(t);
  const first = await f.request();
  const identity = first.context_capture.identity;
  for (let i = 0; i < 5; i++) f.scope(() => captureHttpContext(f.root, { capture_context: true, identity,
    response: Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`field_${n}`, { label: 'private-large-value' }])),
    status: 200, complete: true, attempts: 1, evidencePath: join(f.root, REPO_LAYOUT.evidence, 'fixture', `${first.evidence}.json`) }, { env: f.env }));
  for (const budget of [800, 400, 200]) {
    const result = await f.request({ path: '/items/45', capture_context: false }, { API_BUDGET: String(budget) });
    assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= budget, `response exceeds ${budget}`);
    if (budget === 800) {
      assert.ok(result.known.scoped.observations.length > 0);
      assert.ok(result.known.scoped.omissions.observations > 0);
      assert.ok(result.known.scoped.observations.some(o => o.details_omitted));
    } else assert.ok(result.known?.withheld?.scoped || result.known?.scoped?.details_omitted
      || result.known?.scoped?.omissions.observations > 0);
    assert.doesNotMatch(JSON.stringify(result.known), /private-large-value/);
  }
});

test('unavailable provider diagnostics share the scoped history byte limit', () => {
  const context = { operation_id: `sha256:${'a'.repeat(64)}`,
    identity: { provider: 'https://api.example.invalid', environment: 'local', protocol: 'http',
      operation: 'GET /items/{id}', endpoint: 'https://api.example.invalid/items/{id}', contractDigest: `sha256:${'b'.repeat(64)}` },
    meaning: 'Earlier scoped observations and claims; not current verification. Assertion counts belong only to their saved observation.',
    observations: [], omissions: { observations: 1, operations: 1, evidence_checks: 1, issues: 0 },
    issues: Array.from({ length: 20 }, (_, i) => ({ repository: `fixture-${i}`, code: 'CONTEXT_INVALID' })) };
  for (const budget of [256, 512, 1000]) {
    const result = compactHttpContext(context, budget);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= budget);
    assert.equal((result.issues?.length ?? 0) + result.omissions.issues, 20);
  }
});

test('binary responses also budget prior scoped history instead of bypassing the shrink path', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(128, 7));
  });
  const first = await f.request();
  assert.equal(first.mode, 'binary');
  for (const budget of [800, 400]) {
    const result = await f.request({ path: '/items/44', capture_context: false }, { API_BUDGET: String(budget) });
    assert.equal(result.mode, 'binary');
    assert.equal(result.binary.bytes, 128);
    assert.equal(result.data, null);
    assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= budget);
    assert.ok(result.known?.scoped || result.known?.withheld?.scoped);
  }
});
