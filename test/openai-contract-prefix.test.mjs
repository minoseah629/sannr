import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { LAYOUT } from '../lib/layout.mjs';
import { resolveNoteEvidence } from '../lib/note-evidence.mjs';

const exec = promisify(execFile);
// This test-only override replays the same loopback assertions against an
// archived release tree; neither the installed package nor a vendor is called.
const client = process.env.SANNR_PREFIX_TEST_SOURCE_ROOT
  ? pathToFileURL(join(resolve(process.env.SANNR_PREFIX_TEST_SOURCE_ROOT), 'lib/client.mjs')).href
  : new URL('../lib/client.mjs', import.meta.url).href;

async function fixture(t, { route = '/models', paths, contractPathPrefix } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openai-contract-prefix-'));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'synthetic-model' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`, baseUrl = `${origin}/v1`;
  const raw = JSON.stringify({ openapi: '3.0.0', info: { title: 'Synthetic mount fixture', version: '1' },
    // The configured base URL is authoritative; the unrelated server cannot
    // supply a prefix or cause a connection to this reserved domain.
    servers: [{ url: 'https://unused.example.invalid/ignored' }],
    paths: paths ?? { [route]: { get: { responses: { 200: { description: 'Synthetic list' } } } } } });
  const contract = join(root, 'openapi.json');
  writeFileSync(contract, raw);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ default: 'fixture', environments: { fixture: {
    baseUrl, contract, ...(contractPathPrefix !== undefined ? { contractPathPrefix } : {}),
  } } }));
  // Keep the archived-source replay on its historical layout; current capture
  // exercises an explicit stack rather than relying on a pre-migration store.
  const current = !process.env.SANNR_PREFIX_TEST_SOURCE_ROOT;
  const evidenceDir = current ? join(root, LAYOUT.evidence, 'fixture') : join(root, 'evidence');
  if (current) {
    const folder = join(root, LAYOUT.collection, 'fixture');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'stack.json'), JSON.stringify({ v: 1, name: 'fixture', default_environment: 'fixture',
      environments: { fixture: { baseUrl, contract: '../../../openapi.json', ...(contractPathPrefix !== undefined ? { contractPathPrefix } : {}) } } }));
  }
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_'))),
    HOME: root, SANNR_HOME: join(root, 'home'), API_CONFIG: config, API_CONTEXT_DIR: root,
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_FRICTION_OFF: '1', API_BUDGET: '4000' };
  return { root, env, origin, baseUrl, seen, evidenceDir, contractDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}` };
}

async function request(f, path) {
  const { stdout, stderr } = await exec(process.execPath, ['--input-type=module', '-e', `
    const {apiRequest} = await import(${JSON.stringify(client)});
    console.log(JSON.stringify(await apiRequest({method:'GET',path:${JSON.stringify(path)},expect:[{status:200}]})));
  `], { cwd: f.root, env: f.env, timeout: 15000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.assertions.failed, 0);
  return { result, stderr };
}

function assertEvidence(f, result, operation) {
  const evidenceDir = f.evidenceDir;
  const saved = JSON.parse(readFileSync(join(evidenceDir, `${result.evidence}.json`), 'utf8'));
  assert.equal(saved.origin.scope.operation, operation);
  assert.equal(saved.origin.scope.contract_digest, f.contractDigest);
  const notes = resolveNoteEvidence([result.evidence], { evidenceDir, operation,
    environment: 'fixture', provider: f.baseUrl, contractDigest: f.contractDigest });
  assert.equal(notes.references[0].state, 'available');
  assert.deepEqual(notes.warnings, [], 'the request receipt binds note evidence without EVIDENCE_SCOPE_UNKNOWN');
}

test('OpenAI NOTE-001 primary honors explicit contractPathPrefix and records note evidence identity', async t => {
  const f = await fixture(t, { contractPathPrefix: '/v1/beta/' });
  const { result } = await request(f, '/beta/models');
  assert.deepEqual(f.seen, ['/v1/beta/models']);
  assert.equal(result.context_capture?.state, 'captured', JSON.stringify(result.context_capture));
  assert.equal(result.context_capture.identity.operation, 'GET /models');
  assert.equal(result.context_capture.identity.endpoint, `${f.origin}/v1/beta/models`);
  assertEvidence(f, result, 'GET /models');
});

test('OpenAI NOTE-001 primary infers /v1 from base URL and records note evidence identity', async t => {
  const f = await fixture(t);
  const { result } = await request(f, '/models');
  assert.deepEqual(f.seen, ['/v1/models']);
  assert.equal(result.context_capture?.state, 'captured', JSON.stringify(result.context_capture));
  assert.equal(result.context_capture.identity.operation, 'GET /models');
  assert.equal(result.context_capture.identity.endpoint, `${f.origin}/v1/models`);
  assert.equal(result.contract_delta, null, 'capture and undeclared-path checks use the same inferred mount');
  assertEvidence(f, result, 'GET /models');
});

test('primary capture says whether an explicit or inferred path prefix was used', async t => {
  for (const [contractPathPrefix, path, mount] of [
    ['/v1/beta', '/beta/models', { pathPrefix: '/v1/beta', source: 'contractPathPrefix' }],
    [undefined, '/models', { pathPrefix: '/v1', source: 'base-url-path' }],
  ]) {
    const f = await fixture(t, { contractPathPrefix });
    const { result } = await request(f, path);
    assert.deepEqual(result.context_capture?.mount, mount);
  }
});

test('primary contract routes already covering /v1 are used as written without a second mount', async t => {
  const f = await fixture(t, { route: '/v1/models' });
  const { result } = await request(f, '/models');
  assert.deepEqual(f.seen, ['/v1/models']);
  assert.equal(result.context_capture?.state, 'captured');
  assert.equal(result.context_capture.identity.endpoint, `${f.origin}/v1/models`);
  assert.equal(result.context_capture.mount, undefined);
  assertEvidence(f, result, 'GET /v1/models');
});

test('primary explicit prefix remains authoritative when it mismatches the request', async t => {
  const f = await fixture(t, { contractPathPrefix: '/v2' });
  const { result } = await request(f, '/models');
  assert.deepEqual(f.seen, ['/v1/models']);
  assert.equal(result.context_capture?.state, 'limited');
  assert.equal(result.context_capture.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(result.context_capture.reason, 'prefix-mismatch');
  assert.match(result.context_capture.message, /prefix/i);
  const saved = JSON.parse(readFileSync(join(f.evidenceDir, `${result.evidence}.json`), 'utf8'));
  assert.equal(saved.origin.scope.operation, null);
  assert.equal(saved.origin.scope.contract_digest, null);
});

test('primary imported test claims bind the same explicit prefix as the request client', async t => {
  const f = await fixture(t, { contractPathPrefix: '/v1/beta' });
  const candidate = { name: 'synthetic mount claims', sourceKind: 'postman-v2.1',
    provenance: { source_sha256: 'a'.repeat(64) }, construct_ledger: [], knowledgeCandidates: [{
      item_id: 'models', method: 'GET', path_template: '/v1/beta/models', provider_base_url: f.baseUrl,
      disposition: 'imported', conditions: { auth: 'none' }, assertions: [{ clause: { status: 200 } }],
    }] };
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    const {resolveConfig} = await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)});
    const {importedClaimBindings,prepareImportedTestClaims} = await import(${JSON.stringify(new URL('../lib/imported-test-claims.mjs', import.meta.url).href)});
    console.log(JSON.stringify(prepareImportedTestClaims(${JSON.stringify(candidate)}, {bindings:importedClaimBindings(resolveConfig())})));
  `], { cwd: f.root, env: f.env, timeout: 15000, maxBuffer: 1024 * 1024 });
  const prepared = JSON.parse(stdout);
  assert.equal(prepared.claims.length, 1);
  assert.equal(prepared.claims[0].operation, 'GET /models');
  assert.equal(prepared.claims[0].binding_state, 'bound');
  assert.equal(prepared.claims[0].contract_digest, f.contractDigest);
});

test('query-bearing routes warn at client load while /v1/models captures with the inferred prefix', async t => {
  const f = await fixture(t, { paths: { '/models': { get: {} },
    '/responses?beta=true': { post: {} }, '/synthetic?credential=DO_NOT_LOG_QUERY_VALUE': { get: {} } } });
  const { result, stderr } = await request(f, '/models');
  assert.deepEqual(f.seen, ['/v1/models']);
  assert.match(stderr, /HTTP_CONTRACT_ROUTE_SKIPPED.*\/responses.*literal-query-suffix/);
  assert.match(stderr, /HTTP_CONTRACT_ROUTE_SKIPPED.*\/synthetic.*literal-query-suffix/);
  assert.doesNotMatch(stderr, /beta=true|DO_NOT_LOG_QUERY_VALUE/);
  assert.equal(result.context_capture?.state, 'captured');
  assertEvidence(f, result, 'GET /models');
});

test('all-skipped contract returns a rejected-contract reason and load-time diagnostic', async t => {
  const f = await fixture(t, { route: '/models?beta=true' });
  const { result, stderr } = await request(f, '/models');
  assert.equal(result.context_capture?.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(result.context_capture.reason, 'contract-rejected');
  assert.equal(result.context_capture.contract_reason, 'no-matchable-routes');
  assert.match(result.context_capture.message, /contract was rejected/i);
  assert.match(stderr, /HTTP_CONTRACT_REJECTED.*no-matchable-routes/);
  assert.doesNotMatch(stderr, /beta=true/);
});

test('requests to skipped query keys explain the skip instead of claiming no declaration', async t => {
  const f = await fixture(t, { paths: { '/models': { get: {} }, '/responses?beta=true': { get: {} } } });
  const { result } = await request(f, '/responses?beta=true');
  assert.equal(result.context_capture?.reason, 'route-skipped');
  assert.equal(result.context_capture.route_reason, 'literal-query-suffix');
  assert.match(result.context_capture.message, /path key was skipped/i);
  assert.doesNotMatch(result.context_capture.message, /beta=true/);
});

test('declared ambiguous routes name the ambiguity in the client capture receipt', async t => {
  const f = await fixture(t, { paths: { '/models/{first}': { get: {} }, '/models/{second}': { get: {} } } });
  const { result } = await request(f, '/models/synthetic-id');
  assert.equal(result.context_capture?.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(result.context_capture.reason, 'ambiguous-match');
  assert.match(result.context_capture.message, /multiple declared HTTP routes/i);
  assert.doesNotMatch(result.context_capture.message, /synthetic-id/);
});

test('an undeclared path is distinguished from prefix mismatch and contract rejection', async t => {
  const f = await fixture(t);
  const { result } = await request(f, '/synthetic-undeclared');
  assert.equal(result.context_capture?.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(result.context_capture.reason, 'route-not-declared');
  assert.match(result.context_capture.message, /no declared HTTP route/i);
  assert.doesNotMatch(result.context_capture.message, /synthetic-undeclared/);
});
