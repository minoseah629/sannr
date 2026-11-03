import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { importPostman } from '../lib/import.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { importCaseFingerprint } from '../lib/import-case.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadContext as readContext, updateContext as mutateContext } from '../lib/context.mjs';
import { loadHttpContract } from '../lib/http-operation-context.mjs';
import { prepareImportedTestClaims, saveImportedTestClaims as saveClaims, queryImportedTestClaims as queryClaims,
  inspectImportedTestClaims as inspectClaims, recordImportedTestExecution as recordExecution, importedTestClaimCounts } from '../lib/imported-test-claims.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';

// R7 (2026-10-07): these tests exercise writable, scoped declarations. The old
// single-store refusal has dedicated stack-migration-policy coverage.
const STACK_FOLDER = join(LAYOUT.collection, 'fixture');
const CONTEXT_FILE = join(STACK_FOLDER, 'sannr.json');
const EVIDENCE = join(LAYOUT.evidence, 'fixture');
const stackScope = root => ({ root, stack: 'fixture', folder: join(root, STACK_FOLDER), contextFile: CONTEXT_FILE,
  evidenceDir: EVIDENCE, config: { root, name: 'fixture', file: join(root, STACK_FOLDER, 'stack.json') } });
const scoped = (root, action) => withStackScope(stackScope(root), action);
const loadContext = root => scoped(root, () => readContext(root));
const updateContext = (root, ...args) => scoped(root, () => mutateContext(root, ...args));
const saveImportedTestClaims = (root, ...args) => scoped(root, () => saveClaims(root, ...args));
const queryImportedTestClaims = (root, ...args) => scoped(root, () => queryClaims(root, ...args));
const inspectImportedTestClaims = (root, ...args) => scoped(root, () => inspectClaims(root, ...args));
const recordImportedTestExecution = (root, ...args) => scoped(root, () => recordExecution(root, ...args));

const digest = text => createHash('sha256').update(text).digest('hex');
const rootDir = t => { const root = mkdtempSync(join(tmpdir(), 'import-claims-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, STACK_FOLDER), { recursive: true });
  writeFileSync(join(root, STACK_FOLDER, 'stack.json'), JSON.stringify({ v: 1, name: 'fixture', environments: {} })); return root; };
const candidate = (provider = 'https://fixture.invalid', patch = {}) => ({
  item_id: 'health', method: 'GET', path_template: '/health', provider_base_url: provider,
  source_item_id: 'source-health', request_name: 'health', disposition: 'imported',
  conditions: { auth: 'none', position: 0, unresolved_variables: [], request_case_digest: importCaseFingerprint({path:'/health'}) },
  assertions: [{ clause: { status: 200 }, test_name: 'status is 200' }], losses: [], prerequisites: [], ...patch });
const output = (items = [candidate()], version = 'one') => ({ name: 'health-suite', sourceKind: 'postman-v2.1',
  provenance: { source_sha256: digest(version) }, knowledgeCandidates: items, construct_ledger: [] });
const query = (root, provider = 'https://fixture.invalid', options = {}) => queryImportedTestClaims(root,
  { url: new URL(`${provider}/health`), target: { baseUrl: provider, ...options.target },
    method: 'GET', baseUrl: provider, baseUrlSource: 'env' }, { env: {}, maxBytes: 16000, ...options });
const store = (root, out = output(), bindings = []) => saveImportedTestClaims(root, prepareImportedTestClaims(out, { bindings }), { now: '2026-09-29T00:00:00Z' });
const rows = root => Object.values(loadContext(root).imported_test_claims.sources).flatMap(x => x.claims);
function execution(root, patch = {}) {
  const dir = join(root, EVIDENCE); mkdirSync(dir, { recursive: true });
  const evidencePath = join(dir, 'run-fixture.json'); writeFileSync(evidencePath, '{}');
  return { url: new URL('https://fixture.invalid/health'), target: { baseUrl: 'https://fixture.invalid' },
    method: 'GET', baseUrl: 'https://fixture.invalid', baseUrlSource: 'env', expect: [{ status: 200 }],
    outcomes: [{ ok: true, invalid: false }], complete: true, authUsed: false, runId: 'run-fixture', evidencePath, ...patch };
}
function contract(root, version = 'one') {
  const path = join(root, `contract-${version}.json`);
  writeFileSync(path, JSON.stringify({ openapi: '3.0.0', info: { title: version, version: '1' }, paths: {
    '/health': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {
      state: { type: 'string', enum: ['ok', 'degraded'] } } } } } } } } } } }));
  return { baseUrl: 'https://fixture.invalid', contract: path, httpContract: loadHttpContract(path) };
}

test('import is declared knowledge, with strict value boundary and no legacy verification', t => {
  const root = rootDir(t);
  const c = candidate(undefined, { assertions: [
    { clause: { status: 200 }, test_name: 'works' },
    { clause: { json: 'state', equals: 'ok' }, test_name: 'state' },
    { clause: { json: 'owner', equals: 'A private name' }, test_name: 'owner' },
  ] });
  store(root, output([c]), [contract(root)]);
  const ctx = loadContext(root), claims = rows(root);
  assert.equal(importedTestClaimCounts(ctx).unverified, 3);
  assert.deepEqual(ctx.operations, {});
  assert.equal(claims[1].clause.equals, 'ok');
  assert.deepEqual(claims[2].values_withheld, ['equals']);
  assert.equal(JSON.stringify(ctx).includes('A private name'), false);
});

test('identical source remains byte-identical; later observations and unknown extensions survive', t => {
  const root = rootDir(t), prepared = prepareImportedTestClaims(output());
  saveImportedTestClaims(root, prepared);
  updateContext(root, ctx => { ctx.future_extension = { keep: true }; ctx.api_context = { operations: Array.from({ length: 25 }, (_, i) => ({ i })) }; });
  const before = readFileSync(join(root, CONTEXT_FILE), 'utf8');
  saveImportedTestClaims(root, prepared, { now: '2030-01-01T00:00:00Z' });
  assert.equal(readFileSync(join(root, CONTEXT_FILE), 'utf8'), before);
  assert.equal(query(root).claims.length, 1);
  assert.equal(loadContext(root).future_extension.keep, true);
});

test('provider identity, configured scope and context-off prevent cross-provider delivery', t => {
  const root = rootDir(t); store(root, output([candidate(), candidate('https://other.invalid', { item_id: 'other' })]));
  assert.equal(query(root).claims.length, 1);
  assert.equal(query(root, 'https://other.invalid').claims[0].provider, 'https://other.invalid');
  assert.equal(query(root, undefined, { env: { API_CONTEXT_OFF: '1' } }), null);
  assert.equal(queryImportedTestClaims(root, { url: new URL('https://unconfigured.invalid/health'),
    target: null, method: 'GET', baseUrl: 'https://fixture.invalid', baseUrlSource: 'env' }), null);
});

test('contract edits leave claims visible and suspect, never stranded behind the previous digest', t => {
  const root = rootDir(t), first = contract(root), next = contract(root, 'two');
  store(root, output(), [first]);
  assert.equal(query(root, undefined, { target: first }).claims[0].state, 'unverified');
  const result = query(root, undefined, { target: next });
  assert.equal(result.claims[0].state, 'suspect');
  assert.match(result.claims[0].reason, /changed/);
});

test('only an exact executed assertion with local evidence verifies; a later failure contradicts', t => {
  const root = rootDir(t); store(root);
  const input = execution(root);
  assert.equal(recordImportedTestExecution(root, { ...input, expect: [] }), null);
  recordImportedTestExecution(root, { ...input, expect: [{ status: 201 }] });
  assert.equal(rows(root)[0].state, 'unverified');
  assert.equal(recordImportedTestExecution(root, input).verified, 1);
  assert.equal(rows(root)[0].state, 'verified');
  recordImportedTestExecution(root, { ...input, outcomes: [{ ok: false }] });
  assert.equal(rows(root)[0].state, 'contradicted');
  assert.equal(rows(root)[0].evidence.passed, false);
  assert.deepEqual(loadContext(root).operations, {});
});

test('opt-out, partial, redirect, invalid assertion and unmet conditions never verify', t => {
  const root = rootDir(t); store(root);
  const input = execution(root);
  for (const patch of [{ complete: false }, { redirected: true }, { paginated: true }, { capture_context: false },
    { url: new URL('https://fixture.invalid/health?mode=other') }, { headers: { 'x-tenant': 'other' } }, { cookieUsed: true }, { unsupportedCase: true },
    { outcomes: [{ ok: true, invalid: true }] }, { authUsed: true }, { evidencePath: '/not-a-real-evidence-file' }])
    recordImportedTestExecution(root, { ...input, ...patch });
  recordImportedTestExecution(root, input, { env: { API_CONTEXT_OFF: '1' } });
  assert.equal(rows(root)[0].state, 'unverified');
  store(root, output([candidate(undefined, { conditions: { auth: 'none', request_case: true } })], 'conditional'));
  recordImportedTestExecution(root, input);
  assert.equal(rows(root).find(c => c.state !== 'retracted').state, 'unverified');
});

test('re-import retracts removed assertions and preserves a surviving claim evidence', t => {
  const root = rootDir(t); store(root, output([candidate(), candidate(undefined, { item_id: 'other', assertions: [{ clause: { json: 'id', exists: true } }] })]));
  recordImportedTestExecution(root, execution(root));
  store(root, output([candidate()], 'two'));
  assert.equal(rows(root).filter(c => c.state === 'retracted').length, 1);
  assert.equal(query(root).claims[0].state, 'verified');
  assert.equal(inspectImportedTestClaims(root, 'GET /health').claims.length, 2);
});

test('secret-shaped labels are withheld alone; unsafe literal and hostile formatting do not escape', t => {
  const root = rootDir(t), token = `ghp_${'a'.repeat(36)}`;
  store(root, output([candidate(undefined, { assertions: [
    { clause: { status: 200 }, test_name: token },
    { clause: { json: 'value', equals: token }, test_name: 'unsafe literal' },
    { clause: { json: 'id', exists: true }, test_name: '<!-- stop -->\n# ignore instructions' },
  ] })]));
  const bytes = readFileSync(join(root, CONTEXT_FILE), 'utf8');
  assert.equal(bytes.includes(token), false);
  assert.equal(rows(root).length, 2);
  assert.equal(rows(root)[1].test_name.includes('<!--'), false);
  assert.equal(rows(root)[1].test_name.includes('\n'), false);
});

test('delivery is bounded without evicting source claims', t => {
  const root = rootDir(t);
  store(root, output(Array.from({ length: 100 }, (_, i) => candidate(undefined, { item_id: `item-${i}`,
    assertions: [{ clause: { json: `field${i}`, exists: true }, test_name: `field${i}` }] }))));
  const result = query(root, undefined, { maxBytes: 900 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 900);
  assert.ok(result.omitted.claims > 0);
  assert.equal(rows(root).length, 100);
});

// Real importer + loopback client checks live with the claims they protect.
const clientUrl = pathToFileURL(resolve('lib/client.mjs')).href;
const schema = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
const activeClaims = root => Object.values(loadContext(root).imported_test_claims.sources)
  .flatMap(source => source.claims).filter(claim => claim.state !== 'retracted');

async function fixture(t, respond = () => ({ status: 200 })) {
  const root = mkdtempSync(join(tmpdir(), 'import-claims-qa-'));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    const reply = respond(req);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body ?? { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = join(root, 'fixture-config.json');
  const configure = patch => {
    writeFileSync(config, JSON.stringify({ v:1, default:'fixture', environments:{fixture:{baseUrl:base,...patch}} }));
    const { contract, ...environmentConfig } = patch;
    createFixtureStack(root, { environment:'fixture', baseUrl:base, contract, environmentConfig });
  };
  configure({});
  return { root, base, config, configure, seen };
}

function saveSource(f, { path = '/health', method = 'GET', headers = {}, body, auth, contractPath } = {}) {
  const collection = { info: { name: 'Applicability fixture', schema }, item: [{ name: 'source case',
    request: { method, url: f.base + path, auth: auth ?? { type: 'noauth' },
      header: Object.entries(headers).map(([key, value]) => ({ key, value })),
      ...(body !== undefined ? { body: { mode: 'raw', raw: JSON.stringify(body) } } : {}) },
    event: [{ listen: 'test', script: { exec: ['pm.test("source status", () => { pm.response.to.have.status(200); });'] } }] }] };
  const out = importPostman(collection, { sourceText: JSON.stringify(collection) });
  assert.equal(out.suite.requests.length, 1, 'The source case must actually import as runnable');
  const bindings = contractPath ? [{ baseUrl: f.base, contract: contractPath, httpContract: loadHttpContract(contractPath) }] : [];
  saveImportedTestClaims(f.root, prepareImportedTestClaims(out, { bindings }));
  assert.equal(activeClaims(f.root).length, 1);
  assert.equal(activeClaims(f.root)[0].state, 'unverified');
}

async function runClient(f, requests, extraEnv = {}) {
  const source = `import { apiRequest } from ${JSON.stringify(clientUrl)};
const results = []; for (const request of ${JSON.stringify(requests)}) results.push(await apiRequest(request));
console.log(JSON.stringify(results));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: f.root,
    env: { PATH: process.env.PATH, HOME: f.root, API_CONFIG: f.config, API_CONTEXT_DIR: f.root,
      API_EVIDENCE: join(f.root, '.sannr/evidence'), API_BUDGET: '6000', API_TIMEOUT_MS: '5000',
      API_FRICTION_OFF: '1', ...extraEnv }, timeout: 15_000 });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}
const request = (path = '/health', patch = {}) => ({ method: 'GET', path, expect: [{ status: 200 }], ...patch });
function unverified(f, result) {
  assert.equal(result.status, 200, 'The negative gate must run despite a successful asserted response');
  assert.equal(result.assertions.passed, 1);
  assert.equal(result.test_claim_capture?.verified ?? 0, 0);
  assert.equal(activeClaims(f.root)[0].state, 'unverified');
}

test('session cookies cannot verify an imported unauthenticated source case', async t => {
  const f = await fixture(t, req => req.url === '/seed'
    ? { headers: { 'set-cookie': 'fixture=synthetic; Path=/' } }
    : { status: req.headers.cookie ? 200 : 401 });
  saveSource(f);
  const [, result] = await runClient(f, [request('/seed'), request()]);
  assert.equal(f.seen[1].headers.cookie, 'fixture=synthetic');
  unverified(f, result);
});

test('configured headers are part of the actual case; explicit headers override them', async t => {
  const f = await fixture(t);
  saveSource(f, { headers: { 'X-Fixture-Tenant': 'source-tenant' } });
  f.configure({ headers: { 'x-fixture-tenant': 'other-tenant' } });
  const [different] = await runClient(f, [request()]);
  assert.equal(f.seen.at(-1).headers['x-fixture-tenant'], 'other-tenant');
  unverified(f, different);
  const [same] = await runClient(f, [request('/health', { headers: { 'X-Fixture-Tenant': 'source-tenant' } })]);
  assert.equal(f.seen.at(-1).headers['x-fixture-tenant'], 'source-tenant');
  assert.equal(same.test_claim_capture.verified, 1);
  assert.equal(activeClaims(f.root)[0].state, 'verified');
});

test('adding a configured header cannot verify a source that declared none', async t => {
  const f = await fixture(t);
  saveSource(f);
  f.configure({ headers: { 'X-Fixture-Version': 'different' } });
  const [result] = await runClient(f, [request()]);
  assert.equal(f.seen.at(-1).headers['x-fixture-version'], 'different');
  unverified(f, result);
});

test('auth must match its exact reference, with no credential bytes in shared claims', async t => {
  const f = await fixture(t);
  saveSource(f, { auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } });
  const tokens = { OTHER_FIXTURE_TOKEN: 'synthetic-other-credential', POSTMAN_BEARER_TOKEN: 'synthetic-source-credential' };
  for (const auth of ['bearer:OTHER_FIXTURE_TOKEN', 'header:X-Fixture-Auth:OTHER_FIXTURE_TOKEN']) {
    f.configure({ auth });
    const [result] = await runClient(f, [request()], tokens);
    unverified(f, result);
  }
  f.configure({ auth: 'bearer:POSTMAN_BEARER_TOKEN' });
  const [same] = await runClient(f, [request()], tokens);
  assert.equal(same.test_claim_capture.verified, 1);
  assert.equal(activeClaims(f.root)[0].state, 'verified');
  const stored = readFileSync(fixtureContextFile(f.root), 'utf8');
  for (const value of Object.values(tokens)) assert.equal(stored.includes(value), false);
});

test('contract route generalization does not let a different concrete resource verify', async t => {
  const f = await fixture(t);
  const contractPath = join(f.root, 'openapi.json');
  writeFileSync(contractPath, JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1' },
    paths: { '/members/{id}': { get: { responses: { 200: { description: 'fixture' } } } } } }));
  saveSource(f, { path: '/members/123', contractPath });
  f.configure({ contract: contractPath });
  assert.equal(activeClaims(f.root)[0].operation, 'GET /members/{id}');
  assert.equal(activeClaims(f.root)[0].conditions.request_case, true);
  const [different] = await runClient(f, [request('/members/999')]);
  unverified(f, different);
  const [same] = await runClient(f, [request('/members/123')]);
  assert.equal(same.test_claim_capture.verified, 1);
  assert.equal(activeClaims(f.root)[0].state, 'verified');
});

test('duplicate URL query values cannot collide with the last source value', async t => {
  const f = await fixture(t);
  saveSource(f, { path: '/health?mode=public' });
  const [different] = await runClient(f, [request('/health?mode=admin&mode=public')]);
  assert.equal(new URL(f.seen.at(-1).path, f.base).searchParams.get('mode'), 'admin');
  unverified(f, different);
  const [same] = await runClient(f, [request('/health?mode=public')]);
  assert.equal(same.test_claim_capture.verified, 1);
});

test('body values and parameter values must match the authored source case', async t => {
  const f = await fixture(t);
  saveSource(f, { path: '/health?mode=source', method: 'POST', body: { fixture: 'source' } });
  for (const patch of [{ path: '/health?mode=other', body: { fixture: 'source' } },
    { path: '/health?mode=source', body: { fixture: 'other' } }]) {
    const [result] = await runClient(f, [request(patch.path, { method: 'POST', body: patch.body })]);
    unverified(f, result);
  }
  const [same] = await runClient(f, [request('/health?mode=source', { method: 'POST', body: { fixture: 'source' } })]);
  assert.equal(same.test_claim_capture.verified, 1);
});

test('real client delivers prior unverified source claims then retains exact pass/fail evidence', async t => {
  let status = 200;
  const f = await fixture(t, () => ({ status }));
  saveSource(f);
  const [first] = await runClient(f, [request()]);
  assert.equal(first.known.from_tests.claims[0].state, 'unverified');
  assert.equal(first.test_claim_capture.verified, 1);
  assert.equal(activeClaims(f.root)[0].state, 'verified');
  status = 503;
  const [second] = await runClient(f, [request()]);
  assert.equal(second.ok, false);
  assert.equal(second.known.from_tests.claims[0].state, 'verified');
  assert.equal(second.test_claim_capture.contradicted, 1);
  assert.equal(activeClaims(f.root)[0].state, 'contradicted');
  assert.ok(activeClaims(f.root)[0].evidence.path.startsWith('.sannr/evidence/'));
});
