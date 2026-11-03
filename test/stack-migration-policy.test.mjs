// R7: an old store is readable, but a successful request cannot silently add
// more knowledge to it. All peers and credentials here are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYOUT, LEGACY_LAYOUT } from '../lib/layout.mjs';
import { BIN_NAME } from '../lib/brand.mjs';
import { createHash } from 'node:crypto';
import { importCaseFingerprint } from '../lib/import-case.mjs';
import { prepareImportedTestClaims, saveImportedTestClaims, recordImportedTestExecution } from '../lib/imported-test-claims.mjs';
import { recordGraphContext } from '../lib/graph-record.mjs';
import { captureHttpContext } from '../lib/http-operation-context.mjs';

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = pathToFileURL(join(SOURCE, 'lib/client.mjs')).href;
const COMMAND = `${BIN_NAME} migrate --dry-run`;
const TOKEN = 'fixture-migration-auth-value-' + 'x'.repeat(32);
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^API_/.test(key)));

async function child(t, script, { cwd, env = {}, ipc = false } = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...cleanEnv(), ...env }, stdio: ['pipe', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', data => { stdout += data; });
  proc.stderr.on('data', data => { stderr += data; });
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await once(proc, 'exit'); } });
  return { proc, result: () => ({ stdout, stderr }) };
}

async function fixture(t, { oldRoot = false, contract = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stack-migration-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const peer = await child(t, `
    import { createServer } from 'node:http';
    const requests = [];
    const server = createServer(async (req,res) => {
      let raw=''; for await (const chunk of req) raw+=chunk;
      let body; try { body=JSON.parse(raw); } catch {}
      requests.push({path:req.url,authorization:req.headers.authorization});
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify(req.url==='/graphql' ? {data:{health:{ready:true}}}
        : req.url==='/rpc' ? {jsonrpc:'2.0',id:body.id,result:{ready:true}}
        : {ready:true,private:'fixture-response-value'}));
    });
    server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
    process.on('message',()=>process.send({requests}));
  `, { cwd: root, ipc: true });
  const [{ port }] = await once(peer.proc, 'message');
  const origin = `http://127.0.0.1:${port}`;
  const storePath = join(root, oldRoot ? LEGACY_LAYOUT.context : LAYOUT.context);
  write(storePath, { v: 0, api: { name: 'Fixture API' }, operations: {
    'GET /health': { notes: ['A saved synthetic lesson.'], notes_provenance: [{ by: 'agent', at: '2026-10-07' }] },
  } });
  const configPath = join(root, oldRoot ? LEGACY_LAYOUT.environments : LAYOUT.environments);
  write(configPath, { v: 1, default: 'local', environments: { local: { baseUrl: origin,
    auth: 'bearer:FIXTURE_MIGRATION_TOKEN', ...(contract ? { contract: 'openapi.json' } : {}) } } });
  if (contract) write(join(root, 'openapi.json'), { openapi: '3.0.0', info: { title: 'Fixture API', version: '1' },
    paths: { '/health': { get: { responses: { 200: { description: 'ready' } } } } } });
  const before = readFileSync(storePath, 'utf8');
  const run = async (requests, overrides = {}) => {
    const worker = await child(t, `
      const {apiRequest}=await import(${JSON.stringify(CLIENT)});
      const results=[]; for (const args of ${JSON.stringify(requests)}) results.push(await apiRequest(args));
      process.stdout.write(JSON.stringify(results));
    `, { cwd: root, env: { API_CONFIG: configPath, API_CONTEXT_DIR: root,
      API_EVIDENCE: join(root, LAYOUT.evidence), API_USAGE_LOG: '/dev/null', API_BUDGET: '100000',
      FIXTURE_MIGRATION_TOKEN: TOKEN, SANNR_HOME: join(root, '.home'), ...overrides } });
    const [code] = await once(worker.proc, 'close');
    assert.equal(code, 0, worker.result().stderr);
    return JSON.parse(worker.result().stdout);
  };
  const received = async () => { peer.proc.send({ snapshot: true }); return (await once(peer.proc, 'message'))[0].requests; };
  return { root, storePath, before, origin, run, received };
}

function skipped(result) {
  assert.equal(result.context_capture?.state, 'skipped');
  assert.equal(result.context_capture.code, 'STACKS_MIGRATION_REQUIRED');
  assert.equal(result.context_capture.command, COMMAND);
}

test('legacy HTTP requests execute with auth, retain private evidence and name skipped capture without changing knowledge', async t => {
  const f = await fixture(t);
  const results = await f.run([{ path: '/health', expect: [{ status: 200 }] }, { path: '/health', capture_context: true }]);
  for (const result of results) { assert.equal(result.ok, true); skipped(result); assert.match(result.evidence, /^run-/); }
  assert.equal(readFileSync(f.storePath, 'utf8'), f.before);
  assert.equal(readdirSync(join(f.root, LAYOUT.evidence)).filter(name => /^run-.*\.json$/.test(name)).length, 2);
  const requests = await f.received();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.authorization === `Bearer ${TOKEN}`));
});

test('legacy contractless and pre-layout requests name migration before route or contract limitations', async t => {
  for (const options of [{ contract: false }, { oldRoot: true }]) {
    const f = await fixture(t, options);
    const [result] = await f.run([{ path: '/health', capture_context: true }]);
    assert.equal(result.ok, true); skipped(result);
    assert.equal(readFileSync(f.storePath, 'utf8'), f.before);
    assert.equal((await f.received()).length, 1);
  }
});

test('legacy GraphQL and JSON-RPC requests execute while shared protocol capture stays read-only', async t => {
  const f = await fixture(t);
  const results = await f.run([
    { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Health { health { ready } }' } },
    { protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'health.get', params: {} } },
  ]);
  for (const result of results) { assert.equal(result.ok, true); skipped(result); assert.ok(result.evidence); }
  assert.equal(readFileSync(f.storePath, 'utf8'), f.before);
  assert.equal((await f.received()).length, 2);
});

test('budgeted HTTP and protocol envelopes retain the exact migration command', async t => {
  const f = await fixture(t);
  const results = await f.run([{ path: '/health' },
    { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Health { health { ready } }' } }], { API_BUDGET: '200' });
  for (const result of results) { assert.equal(result.ok, true); skipped(result); }
  assert.equal(readFileSync(f.storePath, 'utf8'), f.before);
});

test('explicit capture opt-outs still name intentional disabling instead of a failed request', async t => {
  const f = await fixture(t);
  const requests = [{ path: '/health', capture_context: false },
    { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Health { health { ready } }' }, capture_context: false }];
  for (const result of await f.run(requests)) {
    assert.equal(result.ok, true);
    assert.deepEqual(result.context_capture, { state: 'disabled', reason: 'request-opt-out' });
  }
  for (const result of await f.run(requests.map(request => ({ ...request, capture_context: true })), { API_CONTEXT_OFF: '1' })) {
    assert.equal(result.ok, true);
    assert.deepEqual(result.context_capture, { state: 'disabled', reason: 'API_CONTEXT_OFF' });
  }
  assert.equal(readFileSync(f.storePath, 'utf8'), f.before);
});

test('legacy imported assertion capture cannot verify source claims behind the read-only boundary', t => {
  const root = mkdtempSync(join(tmpdir(), 'stack-migration-claims-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = 'https://api.example.test';
  saveImportedTestClaims(root, prepareImportedTestClaims({ name: 'fixture', sourceKind: 'postman-v2.1',
    provenance: { source_sha256: createHash('sha256').update('synthetic source').digest('hex') }, construct_ledger: [],
    knowledgeCandidates: [{ item_id: 'health', source_item_id: 'health', request_name: 'Health', disposition: 'imported',
      provider_base_url: provider, path_template: '/health', method: 'GET',
      conditions: { auth: 'none', position: 0, unresolved_variables: [], request_case_digest: importCaseFingerprint({ path: '/health' }) },
      assertions: [{ clause: { status: 200 }, test_name: 'status' }], losses: [], prerequisites: [] }] }));
  const storePath = join(root, LAYOUT.context), before = readFileSync(storePath, 'utf8');
  const evidencePath = join(root, LAYOUT.evidence, 'run-fixture.json'); write(evidencePath, {});
  const receipt = recordImportedTestExecution(root, { url: new URL(`${provider}/health`), target: { baseUrl: provider },
    method: 'GET', baseUrl: provider, baseUrlSource: 'config', expect: [{ status: 200 }], outcomes: [{ ok: true, invalid: false }],
    complete: true, authUsed: false, runId: 'run-fixture', evidencePath });
  assert.equal(receipt?.state, 'skipped');
  assert.equal(receipt.code, 'STACKS_MIGRATION_REQUIRED');
  assert.equal(receipt.command, COMMAND);
  assert.equal(readFileSync(storePath, 'utf8'), before);
});

test('the direct HTTP bridge refuses legacy shared capture before evidence linking or store writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'stack-migration-bridge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storePath = join(root, LAYOUT.context);
  write(storePath, { v: 0, api: {}, operations: {} });
  const before = readFileSync(storePath, 'utf8');
  const receipt = captureHttpContext(root, { capture_context: true, status: 200,
    identity: { provider: 'https://api.example.test', environment: 'local', protocol: 'http', operation: 'GET /health',
      endpoint: 'https://api.example.test/health', contractDigest: null }, complete: true, response: { ready: true } });
  skipped({ context_capture: receipt });
  assert.equal(readFileSync(storePath, 'utf8'), before);
});

test('direct graph recording refuses legacy writes before argument validation and preserves the old store', t => {
  const root = mkdtempSync(join(tmpdir(), 'stack-migration-direct-record-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  const file = join(root,LAYOUT.context);
  write(file,{v:0,api:{name:'Fixture'},operations:{'GET /health':{notes:['Retained authored claim.']}}});
  const before = readFileSync(file,'utf8');
  for (const args of [undefined, {}, {node:'repo',operation:'GET /health',note:'An unverified fixture lesson.'}]) {
    assert.throws(() => recordGraphContext(root,args), error => {
      assert.equal(error.code,'STACKS_MIGRATION_REQUIRED');
      assert.equal(error.command,COMMAND);
      return true;
    });
    assert.equal(readFileSync(file,'utf8'),before);
  }
});
