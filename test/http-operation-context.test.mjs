import { LAYOUT as REPO_LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync,  readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureHttpContext as captureHttp, httpContextScope, loadHttpContract, matchHttpOperation } from '../lib/http-operation-context.mjs';
import { queryOperationContext as queryContext } from '../lib/operation-context.mjs';
import { emptyRegistry, registerRepo, saveRegistry, grant, revoke } from '../lib/registry.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';

// R7 (2026-10-07): capture fixtures are explicit stacks; the policy suite pins
// old single-store requests and their named refusal to write shared knowledge.
const STACK_FOLDER = join(REPO_LAYOUT.collection, 'fixture');
const LAYOUT = { ...REPO_LAYOUT, context: join(STACK_FOLDER, 'sannr.json'), evidence: join(REPO_LAYOUT.evidence, 'fixture') };
const fixtureScope = root => ({ root, stack: 'fixture', folder: join(root, STACK_FOLDER), contextFile: LAYOUT.context,
  evidenceDir: LAYOUT.evidence, config: { root, name: 'fixture' } });
const captureHttpContext = (root, ...args) => withStackScope(fixtureScope(root), () => captureHttp(root, ...args));
const queryOperationContext = (root, ...args) => withStackScope(fixtureScope(root), () => queryContext(root, ...args));
function configure(root, environment, hosts = {}) {
  writeFileSync(join(root, STACK_FOLDER, 'stack.json'), JSON.stringify({ v: 1, name: 'fixture', default_environment: 'fixture',
    environments: { fixture: environment } }));
  writeFileSync(join(root, REPO_LAYOUT.directory, 'defaults.json'), JSON.stringify({ default_stack: 'fixture' }));
  for (const [name, value] of Object.entries(hosts))
    writeFileSync(join(root, REPO_LAYOUT.collection, name, 'stack.json'), JSON.stringify({ v: 1, name, default_environment: 'fixture', environments: { fixture: value } }));
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'http-operation-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, STACK_FOLDER, 'stack.json'), JSON.stringify({ v: 1, name: 'fixture', environments: {} }));
  return root;
}
const identity = { provider: 'http://127.0.0.1:9000', environment: 'local', protocol: 'http',
  operation: 'GET /devices/{id}', endpoint: 'http://127.0.0.1:9000/devices/{id}', contractDigest: `sha256:${'a'.repeat(64)}` };
function input(root, overrides = {}) {
  mkdirSync(join(root, LAYOUT.evidence), { recursive: true });
  writeFileSync(join(root, LAYOUT.evidence, 'request.json'), JSON.stringify({ response: { body: { private: 'private-sample' } } }));
  return { capture_context: true, identity, status: 200, complete: true, attempts: 1,
    request: { params: { filter: 'request-scalar' } }, response: { label: 'response-scalar' },
    evidencePath: join(root, LAYOUT.evidence, 'request.json'), ...overrides };
}

test('HTTP bridge requires explicit opt-in or configured scope and honors both opt-outs', t => {
  const root = project(t);
  assert.equal(captureHttpContext(root).reason, 'not-requested');
  assert.equal(captureHttpContext(root, { capture_context: true }, { env: { API_CONTEXT_OFF: '1' } }).reason, 'API_CONTEXT_OFF');
  assert.equal(captureHttpContext(root, { capture_context: false }, { scope: { eligible: true } }).reason, 'request-opt-out');
  assert.equal(existsSync(join(root, LAYOUT.context)), false);
});

test('automatic scope requires an explicitly configured origin and exact path segment prefix', () => {
  const baseUrl = 'https://api.example.test/v1', primary = { baseUrl, name: null };
  const config = { baseUrl, baseUrlSource: 'config' };
  assert.deepEqual(httpContextScope(`${baseUrl}/health`, primary, config), { eligible: true, primary: true, provider: baseUrl });
  assert.equal(httpContextScope(`${baseUrl}/health`, primary, { ...config, baseUrlSource: 'env' }).eligible, true);
  for (const url of ['https://api.example.test/v12/health', 'https://api.example.test/health', 'https://other.example.test/v1/health'])
    assert.equal(httpContextScope(url, primary, config).eligible, false);
  assert.equal(httpContextScope(`${baseUrl}/health`, primary, { ...config, baseUrlSource: 'fallback' }).eligible, false);
  assert.equal(httpContextScope(`${baseUrl}/health`, null, config).eligible, false);
  assert.equal(httpContextScope(`${baseUrl}/health`, { ...primary, collision: ['a', 'b'] }, config).eligible, false);
  const integration = { name: 'billing', baseUrl: 'https://billing.example.test/v2' };
  assert.deepEqual(httpContextScope(`${integration.baseUrl}/status`, integration, config),
    { eligible: true, primary: false, provider: integration.baseUrl });
});

test('HTTP route binding preserves canonical contract operations, explicit mounts and exact contract bytes', t => {
  const root = project(t), file = join(root, 'vendor.json');
  const raw = JSON.stringify({ openapi: '3.0.0', servers: [{ url: 'https://ignored.example.test/guessed' }], paths: {
    '/devices/{deviceId}': { get: {} }, '/devices/latest': { get: {} },
  } });
  writeFileSync(file, raw);
  const contract = loadHttpContract(file, { pathPrefix: '/vendor/' });
  assert.equal(contract.digest, `sha256:${createHash('sha256').update(raw).digest('hex')}`);
  assert.deepEqual(matchHttpOperation(contract, 'GET', '/vendor/devices/943278'), {
    op: 'GET /devices/{deviceId}', method: 'GET', path: '/devices/{deviceId}', endpointPath: '/vendor/devices/{deviceId}',
  });
  assert.equal(matchHttpOperation(contract, 'GET', '/vendor/devices/latest').op, 'GET /devices/latest');
  assert.equal(matchHttpOperation(contract, 'POST', '/vendor/devices/latest'), null);
  assert.equal(matchHttpOperation(contract, 'GET', '/devices/943278'), null);
  assert.equal(matchHttpOperation(loadHttpContract(file), 'GET', '/guessed/devices/943278'), null);
  assert.doesNotMatch(JSON.stringify(contract), /943278/);
});

test('HTTP route bindings fail closed on missing files, unsafe mounts and ambiguous templates', t => {
  const root = project(t), file = join(root, 'vendor.json');
  writeFileSync(file, JSON.stringify({ openapi: '3.0.0', paths: {
    '/devices/{first}': { get: {} }, '/devices/{second}': { get: {} },
  } }));
  assert.equal(matchHttpOperation(loadHttpContract(file), 'GET', '/devices/943278'), null);
  for (const pathPrefix of ['relative', '//other.test', '/v1/../v2', '/v1?token=value', '/v1#fragment', '/{tenant}', '/v1\\v2', 42])
    assert.equal(loadHttpContract(file, { pathPrefix }), null, String(pathPrefix));
  assert.equal(loadHttpContract(join(root, 'missing.json')), null);
  writeFileSync(file, '{broken');
  assert.equal(loadHttpContract(file), null);
});

test('HTTP bridge preserves legacy metadata and stores only scoped structure and evidence identities', t => {
  const root = project(t), env = { SANNR_HOME: join(root, 'home') };
  const legacy = { verified_at: null, notes: ['Legacy note stays.'] };
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, api: { name: 'fixture' }, operations: { 'GET /devices/{id}': legacy } }));
  const result = captureHttpContext(root, input(root), { env });
  assert.equal(result.state, 'captured');
  const stored = readFileSync(join(root, LAYOUT.context), 'utf8');
  assert.doesNotMatch(stored, /request-scalar|response-scalar|private-sample/);
  assert.deepEqual(JSON.parse(stored).operations['GET /devices/{id}'], legacy);
  const observation = queryOperationContext(root, identity, { env }).operations[0].observations[0];
  assert.equal(observation.verification, 'client-observation');
  assert.equal(observation.complete, true);
  assert.equal(observation.outcome, 'success');
  assert.equal(observation.attempts, 1);
  assert.equal(observation.request_shape.properties.params.properties.filter.type, 'string');
  assert.equal(observation.response_shape.properties.label.type, 'string');
  assert.equal(observation.evidence[0].state, 'matching');
});

test('HTTP response failure, passing negative assertions and partial pagination remain separate facts', t => {
  const root = project(t), env = { SANNR_HOME: join(root, 'home') };
  assert.equal(captureHttpContext(root, input(root, { status: 404, assertions: { passed: 2, failed: 0 } }), { env }).state, 'captured');
  assert.equal(captureHttpContext(root, input(root, { pages: { fetched: 2, complete: false, stopped_early: 'cap' }, attempts: 3 }), { env }).state, 'captured');
  const observations = queryOperationContext(root, identity, { env }).operations[0].observations;
  assert.equal(observations[0].outcome, 'error');
  assert.equal(observations[0].complete, true);
  assert.deepEqual(observations[0].assertions, { passed: 2, failed: 0 });
  assert.equal(observations[1].outcome, 'partial');
  assert.equal(observations[1].complete, false);
  assert.equal(observations[1].attempts, 3);
  assert.match(observations[1].notes.join(' '), /2 pages; traversal incomplete/);
  assert.match(observations[1].omissions.join(' '), /do not cover every captured page/);
});

test('HTTP bridge never retains an outside-project evidence pointer or fails the HTTP outcome', t => {
  const root = project(t), outside = project(t), env = { SANNR_HOME: join(root, 'home') };
  const external = input(outside).evidencePath;
  symlinkSync(external, join(root, 'linked.json'));
  assert.equal(captureHttpContext(root, input(root, { evidencePath: join(root, 'linked.json') }), { env }).state, 'captured');
  const observation = queryOperationContext(root, identity, { env }).operations[0].observations[0];
  assert.deepEqual(observation.evidence, []);
  assert.match(observation.omissions.join(' '), /outside the project/);
  const result = captureHttpContext(root, input(root, { identity: { ...identity, protocol: 'grpc' } }), { env });
  assert.equal(result.state, 'failed');
  assert.equal(result.code, 'HTTP_CONTEXT_IDENTITY_INVALID');
});

test('HTTP identity and fresh grants preserve provider and environment isolation', t => {
  const provider = project(t), consumer = project(t), home = project(t), env = { SANNR_HOME: home };
  captureHttpContext(provider, input(provider), { env });
  captureHttpContext(provider, input(provider, { identity: { ...identity, environment: 'staging' } }), { env });
  // Cross-repository grants still read the implicit old store during the R7
  // transition. This fixture is an already-saved snapshot, not a new write by
  // a pre-migration request.
  writeFileSync(join(provider, REPO_LAYOUT.context), readFileSync(join(provider, LAYOUT.context)));
  const registry = emptyRegistry();
  const p = registerRepo(registry, provider).id, c = registerRepo(registry, consumer).id;
  saveRegistry(registry, env);
  assert.equal(queryOperationContext(consumer, identity, { env }).operations.length, 0);
  grant(registry, c, p); saveRegistry(registry, env);
  const query = queryOperationContext(consumer, identity, { env });
  assert.equal(query.operations.length, 1);
  assert.equal(query.operations[0].identity.environment, 'local');
  assert.equal(query.operations[0].repository, p);
  revoke(registry, c, p); saveRegistry(registry, env);
  assert.equal(queryOperationContext(consumer, identity, { env }).operations.length, 0);
});

test('HTTP apiRequest and envelopes automatically capture configured APIs, with explicit opt-out isolated from coalescing', async t => {
  const root = project(t), calls = [];
  const server = createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: req.url.split('/').at(-1), private: 'response-scalar-not-context' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const legacy = { verified_at: null, notes: ['Declared device lookup.'] };
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, api: { name: 'fixture' },
    operations: { 'GET /devices/{deviceId}': legacy } }));
  const contract = JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1' },
    paths: { '/devices/{deviceId}': { get: { responses: { 200: { description: 'A device' } } } } } });
  writeFileSync(join(root, STACK_FOLDER, 'openapi.json'), contract);
  configure(root, { baseUrl: origin, contract: 'openapi.json' });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { SANNR_HOME: join(root, 'home'), API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0',
    API_ENV: 'fixture',
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence'), API_FRICTION_OFF: '1' });
  const script = `
    import { readFileSync } from 'node:fs';
    const { apiRequest, runEnvelope } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    const ordinary = await apiRequest({ path: '/devices/41' });
    const afterDefault = JSON.parse(readFileSync(${JSON.stringify(LAYOUT.context)}, 'utf8'));
    const opted = await apiRequest({ path: '/devices/42', capture_context: true, expect: [{ status: 200 }] });
    const batch = await runEnvelope({ v: 2, requests: [{ path: '/devices/43' }] });
    const concurrent = await Promise.all([
      apiRequest({ path: '/devices/44' }), apiRequest({ path: '/devices/44', capture_context: false })]);
    process.stdout.write(JSON.stringify({ ordinary, defaultHasContext: Boolean(afterDefault.api_context), opted, batch, concurrent }));
  `;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(child.stdout);
  assert.equal(result.ordinary.ok, true);
  assert.equal(result.ordinary.context_capture.state, 'captured');
  assert.equal(result.defaultHasContext, true);
  assert.equal(result.opted.context_capture.state, 'captured');
  assert.equal(result.batch.ok, true);
  assert.equal(result.batch.results[0].context_capture.state, 'captured');
  assert.equal(result.concurrent[0].context_capture.state, 'captured');
  assert.deepEqual(result.concurrent[1].context_capture, { state: 'disabled', reason: 'request-opt-out' });
  assert.equal(result.concurrent[1].coalesced, undefined);
  assert.deepEqual(calls, ['/devices/41', '/devices/42', '/devices/43', '/devices/44', '/devices/44']);
  const query = queryOperationContext(root, { protocol: 'http' }, { env });
  assert.equal(query.operations.length, 1);
  const operation = query.operations[0];
  assert.deepEqual(operation.identity, { v: 1, stack: 'fixture', provider: origin, environment: 'fixture', protocol: 'http',
    operation: 'GET /devices/{deviceId}', endpoint: `${origin}/devices/{deviceId}`,
    contractDigest: `sha256:${createHash('sha256').update(contract).digest('hex')}` });
  assert.equal(operation.observations.length, 4);
  assert.doesNotMatch(operation.identity.operation + operation.identity.endpoint, /\/devices\/4[1-4]/);
  assert.deepEqual(result.ordinary.known.applicability,
    { stack: 'fixture', provider: origin, environment: 'fixture', basis: 'resolved-stack-request' });
  for (const observation of operation.observations) {
    assert.equal(observation.attempts, 1);
    assert.equal(observation.verification, 'client-observation');
    assert.equal(observation.complete, true);
    assert.equal(observation.evidence[0].state, 'matching');
    assert.equal(observation.declaration.validationScope, 'declared-method-and-path-only');
    assert.equal(observation.declaration.responseValidated, false);
  }
  assert.equal(operation.observations[0].assertions, undefined);
  assert.deepEqual(operation.observations[1].assertions, { passed: 1, failed: 0 });
  const stored = readFileSync(join(root, LAYOUT.context), 'utf8');
  assert.doesNotMatch(stored, /response-scalar-not-context/);
  assert.deepEqual(JSON.parse(stored).operations['GET /devices/{deviceId}'], legacy);
});

test('integration capture never borrows the primary API route or contract and outside-prefix calls stay out', async t => {
  const root = project(t), requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, value: 'private-result' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, api: {}, operations: {
    'GET /vendor/devices/{id}': { notes: ['This legacy route belongs to another API.'] },
  } }));
  writeFileSync(join(root, STACK_FOLDER, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: {
    '/vendor/devices/{id}': { get: {} }, '/api/devices/{first}': { get: {} }, '/api/devices/{second}': { get: {} },
  } }));
  configure(root, { baseUrl: `${origin}/api`, contract: 'openapi.json' }, { vendor: { baseUrl: `${origin}/vendor` } });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0',
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_FRICTION_OFF: '1' });
  const script = `
    const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    const integration = await apiRequest({ upstream: 'vendor', path: '/devices/42' });
    const outside = await apiRequest({ path: ${JSON.stringify(`${origin}/apiary/status`)} });
    const ambiguous = await apiRequest({ path: '/devices/43' });
    process.stdout.write(JSON.stringify({ integration, outside, ambiguous }));
  `;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  const result = JSON.parse(child.stdout);
  assert.equal(result.integration.context_capture.state, 'limited');
  assert.equal(result.integration.context_capture.code, 'CONTRACT_NOT_BOUND');
  assert.equal(result.integration.known, null);
  assert.equal(result.ambiguous.context_capture.state, 'limited');
  assert.equal(result.ambiguous.context_capture.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(result.outside.context_capture, undefined);
  assert.equal(result.outside.error.code, 'ORIGIN_NOT_CONFIGURED');
  assert.equal(result.outside.known, null);
  const contexts = queryOperationContext(root, { protocol: 'http' }, { env }).operations;
  assert.equal(contexts.length, 0);
  assert.doesNotMatch(readFileSync(join(root, LAYOUT.context), 'utf8'), /private-result|\/devices\/42|\/devices\/43/);
  assert.deepEqual(requests, ['/vendor/devices/42', '/api/devices/43']);
  // Ambient single-API overrides never move an explicit stack's credentials
  // or contract to a different provider, even when its path matches.
  const overrideScript = `
    const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    process.stdout.write(JSON.stringify(await apiRequest({ path: '/devices/45' })));
  `;
  const override = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', overrideScript],
    { cwd: root, env: { ...env, API_BASE_URL: `${origin}/vendor` }, encoding: 'utf8', timeout: 15000 });
  assert.equal(JSON.parse(override.stdout).context_capture.state, 'limited');
  assert.equal(JSON.parse(override.stdout).known, null);
  assert.equal(requests.at(-1), '/api/devices/45');
  assert.equal(queryOperationContext(root, { protocol: 'http' }, { env }).operations.length, 0);
  const forced = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', overrideScript.replace("path: '/devices/45'", "path: '/devices/943278', capture_context: true")],
    { cwd: root, env: { ...env, API_BASE_URL: `${origin}/vendor` }, encoding: 'utf8', timeout: 15000 });
  assert.equal(JSON.parse(forced.stdout).context_capture.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.doesNotMatch(readFileSync(join(root, LAYOUT.context), 'utf8'), /943278/);
});

test('capture failure is visible without changing a successful unasserted HTTP result', async t => {
  const root = project(t);
  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  mkdirSync(join(root, LAYOUT.context), { recursive: true });
  writeFileSync(join(root, STACK_FOLDER, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: { '/health': { get: {} } } }));
  configure(root, { baseUrl: `http://127.0.0.1:${server.address().port}`, contract: 'openapi.json' });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { API_CONTEXT_DIR: root,
    API_CONTEXT_OFF: '0', API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_FRICTION_OFF: '1' });
  const script = `const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    process.stdout.write(JSON.stringify(await apiRequest({ path: '/health' })));`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.assertions, null);
  assert.equal(result.context_capture.state, 'failed');
  assert.match(result.context_capture.code, /^(HTTP_CONTEXT|CONTEXT)_/);
});

test('automatic capture pays the HTTP response budget while retaining complete observation history', async t => {
  const root = project(t);
  writeFileSync(join(root, STACK_FOLDER, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: { '/items': { get: {} } } }));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.from({ length: 30 }, (_, id) => ({ id, title: 'x'.repeat(300) }))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  configure(root, { baseUrl: `http://127.0.0.1:${server.address().port}`, contract: 'openapi.json' });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { API_CONTEXT_DIR: root,
    API_CONTEXT_OFF: '0', API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_FRICTION_OFF: '1' });
  const script = `const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    process.stdout.write(JSON.stringify(await apiRequest({ path: '/items' })));`;
  for (const budget of [800, 400, 200]) {
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
      { cwd: root, env: { ...env, API_BUDGET: String(budget) }, encoding: 'utf8', timeout: 15000 });
    assert.equal(JSON.parse(child.stdout).context_capture.state, 'captured');
    assert.ok(Math.ceil(child.stdout.length / 4) <= budget, `${child.stdout.length / 4} exceeds ${budget}`);
  }
  const context = queryOperationContext(root, { protocol: 'http' }, { env }).operations;
  assert.equal(context[0].observations.length, 3);
  assert.ok(context[0].observations.every(item => item.response_shape && item.source.tool === 'api_request:http'));
});

test('redirect capture needs the final primary contract identity and never stores actual parameter values', async t => {
  const root = project(t);
  const server = createServer((req, res) => {
    if (req.url === '/api/redirect') { res.writeHead(302, { location: '/vendor/result' }); res.end(); }
    else if (req.url === '/api/redirect-primary') { res.writeHead(302, { location: '/api/result/943278' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"result":true}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, STACK_FOLDER, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: {
    '/api/redirect': { get: {} }, '/api/result/{id}': { get: {} },
  } }));
  configure(root, { baseUrl: `${origin}/api`, contract: 'openapi.json' }, { vendor: { baseUrl: `${origin}/vendor` } });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { API_CONTEXT_DIR: root,
    API_CONTEXT_OFF: '0', API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_FRICTION_OFF: '1' });
  const script = `const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    process.stdout.write(JSON.stringify(await apiRequest({ path: '/redirect' })));`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(JSON.parse(child.stdout).context_capture.state, 'limited');
  assert.equal(JSON.parse(child.stdout).known, null);
  assert.equal(existsSync(join(root, LAYOUT.context)), false);
  const primary = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script.replace("path: '/redirect'", "path: '/redirect-primary'")],
    { cwd: root, env, encoding: 'utf8', timeout: 15000 });
  assert.equal(JSON.parse(primary.stdout).context_capture.state, 'captured');
  const context = queryOperationContext(root, { protocol: 'http' }, { env }).operations[0];
  assert.equal(context.identity.provider, `${origin}/api`);
  assert.equal(context.identity.operation, 'GET /api/result/{id}');
  assert.equal(context.identity.endpoint, `${origin}/api/result/{id}`);
  assert.match(context.identity.contractDigest, /^sha256:/);
  assert.equal(context.observations[0].request_shape, undefined);
  assert.equal(context.observations[0].attempts, 2);
  assert.match(context.observations[0].omissions.join(' '), /final redirect response/);
  assert.doesNotMatch(readFileSync(join(root, LAYOUT.context), 'utf8'), /943278/);
});
