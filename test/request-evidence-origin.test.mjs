import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { baselineNoteHistory } from '../lib/note-history.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const client = new URL('../lib/client.mjs', import.meta.url).href;
const run = (f, args) => new Promise((resolve, reject) => execFile(process.execPath, args,
  { cwd: f.dir, env: f.env, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(`Fixture child failed (${error.code}): ${stderr.slice(0, 500)}`)) : resolve(stdout)));
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'request-origin-'));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url });
    let text = ''; req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      let body = { ready: true };
      try { const rpc = JSON.parse(text); if (rpc.jsonrpc) body = { jsonrpc: '2.0', id: rpc.id, result: { ready: true } }; } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const contract = join(dir, 'openapi.json');
  writeFileSync(contract, JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1' }, paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } }));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ default: 'fixture', environments: { fixture: { baseUrl, contract } } }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_'))), HOME: dir,
    API_CONFIG: config, API_CONTEXT_DIR: dir, API_CONTEXT_OFF: '1', API_EVIDENCE: join(dir, 'evidence'), API_USAGE_LOG: join(dir, 'usage.jsonl'), API_FRICTION_OFF: '1' };
  return { dir, env, baseUrl, seen, evidence: () => readdirSync(join(dir, 'evidence')).filter(x => /^run-.*\.json$/.test(x)).map(x => JSON.parse(readFileSync(join(dir, 'evidence', x), 'utf8'))) };
}

test('one request engine stamps ordinary, learn, probe, batch and protocol evidence without trusting public fields', async t => {
  const f = await fixture(t);
  const out = await run(f, ['--input-type=module', '-e', `
    const {apiRequest,apiLearnRead,apiReadProbe,runEnvelope}=await import(${JSON.stringify(client)});
    const request={method:'GET',path:'/health',expect:[{status:200}],initiator:'cli.doctor',internal:{initiator:'cli.doctor'}};
    const results=[];
    const refused = await apiRequest({...request, origin:{initiator:'cli.doctor'}});
    if (refused.error?.code !== 'REQUEST_ROUTING_FIELD_UNSUPPORTED') throw new Error('Public origin must be refused');
    results.push(await apiRequest(request));
    results.push((await apiLearnRead({method:'GET',path:'/health'})).result);
    results.push((await apiReadProbe({method:'GET',path:'/health',onRequest:()=>{},targetSource:'configured'},{initiator:'cli.doctor'})).result);
    results.push((await apiReadProbe({method:'GET',path:'/health',onRequest:()=>{},targetSource:'configured'},{initiator:'cli.request'})).result);
    results.push(await runEnvelope({v:2,requests:[request]},{initiator:'cli.request'}));
    results.push(await apiRequest({protocol:'jsonrpc',path:'/rpc',rpc:{method:'fixture.read'},expect:[{json:'result.ready',equals:true}]},{initiator:'cli.protocol'}));
    console.log(JSON.stringify(results.map(x=>({ok:x.ok,error:x.error?.code}))));
  `]);
  const outcomes = JSON.parse(out.trim());
  assert.ok(outcomes.every(x => x.ok !== false && !x.error), JSON.stringify(outcomes));
  const records = f.evidence(); assert.equal(records.length, 6);
  assert.deepEqual(records.map(x => x.origin.initiator).sort(), ['library.apiRequest', 'cli.learn', 'cli.doctor', 'cli.request', 'cli.request', 'cli.protocol'].sort());
  for (const r of records) {
    assert.equal(r.origin.v, 1);
    assert.ok(Number.isFinite(Date.parse(r.origin.observed_at)));
    assert.match(r.origin.package_version, /^\d+\.\d+\.\d+/);
    assert.ok(r.origin.build_id === null || /^[a-f0-9-]{36}$/.test(r.origin.build_id));
    assert.equal(r.origin.scope.environment, 'fixture');
    assert.equal(r.origin.scope.provider, f.baseUrl);
    if (r.origin.transport === 'api_request:http') {
      assert.equal(r.origin.scope.operation, 'GET /health');
      assert.match(r.origin.scope.contract_digest, /^sha256:[a-f0-9]{64}$/);
    } else assert.equal(r.origin.transport, 'api_request:jsonrpc');
  }
});

test('concurrent identical requests with different initiators cannot coalesce across origin identities', async t => {
  const f = await fixture(t);
  await run(f, ['--input-type=module', '-e', `const {apiRequest}=await import(${JSON.stringify(client)}); const args={method:'GET',path:'/health',expect:[{status:200}]}; await Promise.all([apiRequest(args,{initiator:'cli.request'}),apiRequest(args,{initiator:'cli.learn'})]);`]);
  assert.equal(f.seen.length, 2);
  assert.deepEqual(f.evidence().map(x => x.origin.initiator).sort(), ['cli.learn', 'cli.request']);
});

test('actual CLI request carries its own origin; unbound concrete paths are not promoted into note scope', async t => {
  const f = await fixture(t);
  await run(f, [join(root, 'bin/request.mjs'), 'GET', '/health', '--expect-status', '200']);
  await run(f, [join(root, 'bin/request.mjs'), 'GET', '/members/private-person-id', '--expect-status', '200']);
  const records = f.evidence(); assert.equal(records.length, 2);
  assert.ok(records.every(x => x.origin.initiator === 'cli.request'));
  const unbound = records.find(x => x.request.url.includes('private-person-id'));
  assert.equal(unbound.origin.scope.operation, null);
  assert.equal(JSON.stringify(unbound.origin).includes('private-person-id'), false);
});

test('actual MCP request and envelope stamps cannot be forged through request JSON', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(root, 'server.mjs')], { cwd: f.dir, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const pending = new Map(); let next = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { try { const value = JSON.parse(line); pending.get(value.id)?.(value); } catch {} });
  t.after(() => { child.kill(); lines.close(); });
  const rpc = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); });
  await rpc('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'origin-fixture',version:'1'} });
  const args = {method:'GET',path:'/health',expect:[{status:200}],initiator:'cli.doctor'};
  for (const request of [args, {v:2,requests:[args],initiator:'cli.doctor'}]) {
    const reply = await rpc('tools/call', {name:'api_request', arguments:request});
    assert.equal(reply.error, undefined);
    const value = JSON.parse(reply.result.content[0].text);
    assert.equal(value.ok, true, JSON.stringify(value.error));
  }
  assert.deepEqual(f.evidence().map(x => x.origin.initiator), ['mcp.api_request','mcp.api_request']);
});

for (const state of ['changed', 'invalid', 'unbaselined']) test(`request-time guidance exposes ${state} note history without payload metadata`, async t => {
  const f = await fixture(t);
  f.env.API_CONTEXT_OFF = '0';
  const entry = { notes: ['A recorded API lesson.'], notes_provenance: [{ by: 'agent', at: '2026-09-30' }] };
  if (state !== 'unbaselined') baselineNoteHistory(entry);
  if (state === 'changed') entry.notes[0] = 'A hand-edited API lesson.';
  if (state === 'invalid') entry.notes.push({ authorization: 'private-fixture-value' });
  const path = join(f.dir, LAYOUT.context); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ v: 1, operations: { 'GET /health': entry } }));
  const out = await run(f, ['--input-type=module', '-e', `const {apiRequest}=await import(${JSON.stringify(client)}); console.log(JSON.stringify(await apiRequest({method:'GET',path:'/health',capture_context:false,expect:[{status:200}]})));`]);
  const response = JSON.parse(out);
  assert.equal(response.ok, true);
  assert.equal(response.known.note_history.state, state);
  assert.ok(response.known.note_history.issues.length);
  assert.equal(out.includes('private-fixture-value'), false);
  if (state !== 'unbaselined') assert.match(response.known.note_history.baseline_digest, /^sha256:/);
});

test('tiny budgets keep a compact integrity warning and name the required minimum', async t => {
  const f = await fixture(t); f.env.API_CONTEXT_OFF = '0'; f.env.API_BUDGET = '32';
  const entry = { notes: ['Recorded guidance.'], notes_provenance: [{ by: 'agent', at: '2026-09-30' }] };
  baselineNoteHistory(entry); entry.notes[0] += ' changed'.repeat(500);
  const path = join(f.dir, LAYOUT.context); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ v: 1, operations: { 'GET /health': entry } }));
  const out = await run(f, ['--input-type=module', '-e', `const {apiRequest}=await import(${JSON.stringify(client)}); console.log(JSON.stringify(await apiRequest({method:'GET',path:'/health',capture_context:false,expect:[{status:200}]})));`]);
  const response = JSON.parse(out);
  assert.equal(response.known.note_history.state, 'changed');
  assert.equal(response.known.note_history.details_omitted, true);
  assert.ok(response.budget_min > 32);
});


test('duplicate CLI evidence links and identical note retries reuse the original run without new requests', async t => {
  const f = await fixture(t);
  const cli = join(root, 'bin/cli.mjs');
  createFixtureStack(f.dir, { environment:'fixture', baseUrl:f.baseUrl, contract:'openapi.json' });
  await run(f, [cli, 'init', '--stack', 'fixture']);
  f.evidence = () => readdirSync(join(f.dir, fixtureEvidencePath())).filter(x => /^run-.*\.json$/.test(x))
    .map(x => JSON.parse(readFileSync(join(f.dir, fixtureEvidencePath(),x),'utf8')));
  const result = JSON.parse(await run(f, [join(root, 'bin/request.mjs'), 'GET', '/health', '--expect-status', '200']));
  const id = result.evidence;
  assert.ok(id);
  const args = [cli, 'note', 'GET /health', 'Observed a successful health response in the local fixture.', '--evidence', id, '--evidence', id];
  await run(f, args);
  const path = fixtureContextFile(f.dir), before = readFileSync(path, 'utf8');
  const saved = JSON.parse(before).operations['GET /health'];
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.notes_provenance[0].evidence.length, 1);
  assert.equal(saved.notes_provenance[0].evidence[0].run_id, id);
  assert.equal(saved.notes_provenance[0].evidence[0].provenance.initiator, 'cli.request');
  await run(f, args);
  assert.equal(readFileSync(path, 'utf8'), before, 'retry preserves the first note stamp and evidence binding');
  assert.equal(f.evidence().length, 1);
  assert.equal(f.seen.length, 1);
});
