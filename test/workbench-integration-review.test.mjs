import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';

const serverModule = new URL('../lib/workbench-server.mjs', import.meta.url).href;
const engineModule = new URL('../lib/workbench-engine.mjs', import.meta.url).href;
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
const document = () => ({ kind: 'saved-request', origin: 'saved-request-document', format_version: 1,
  folder: 'review', name: 'echo', stack: 'fixture', environment: 'local',
  request: { method: 'GET', path: '/echo/{id}', bindings: { path: { id: { $input: 'identifier' } }, headers: { 'x-note': { $input: 'note' } } } },
  inputs: { identifier: { type: 'string' }, note: { type: 'string', sensitive: true } }, credentials: ['bearer:REVIEW_AUTH'] });

// Both the real adapters and their lazily imported client run with an isolated
// HOME and machine store. IPC is a test-only substitute for terminal pairing;
// it is not added to the public HTTP server or to package assets.
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-review-')), seen = [];
  const auth = 'synthetic-review-auth-943721', note = 'synthetic-private-input-839203';
  const api = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ordinary: 'synthetic-visible-response', authorization: req.headers.authorization,
        reflected: req.headers['x-note'], encoded: Buffer.from(req.headers['x-note'] ?? '').toString('base64'),
        signed_url: 'https://download.invalid/file?X-Amz-Signature=synthetic-signature',
        markup: '</script><img src="https://attacker.invalid/steal" onerror="alert(1)">' }));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  write(join(root, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Synthetic review', version: '1' }, paths: {
    '/echo/{id}': { get: { parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'x-note', in: 'header', schema: { type: 'string' } },
    ], responses: { 200: { description: 'ok' } } } },
    '/echo': { post: { responses: { 200: { description: 'ok' } } } },
  } });
  const baseUrl = `http://127.0.0.1:${api.address().port}`;
  createFixtureStack(root, { contract: 'openapi.json', environments: {
    local: { baseUrl, auth: 'bearer:REVIEW_AUTH' }, production: { baseUrl, auth: 'bearer:REVIEW_AUTH', production: true },
  } });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1', REVIEW_AUTH: auth };
  mkdirSync(env.HOME);
  const script = `
    const {createWorkbenchServer}=await import(${JSON.stringify(serverModule)});
    const {workbenchHandlers,workbenchAssets}=await import(${JSON.stringify(engineModule)});
    const counts={}; const handlers=workbenchHandlers(process.cwd());
    for(const [name,entry] of Object.entries(handlers)) { const run=typeof entry==='function'?entry:entry.run;
      handlers[name]={touch:entry.touch===true,run:async(...args)=>{counts[name]=(counts[name]??0)+1;return run(...args);}}; }
    const service=await createWorkbenchServer({assets:workbenchAssets(),handlers});
    process.on('message',async message=>{
      if(message.type==='pair') process.send({id:message.id,value:service.authorizePairing(message.code)});
      if(message.type==='counts') process.send({id:message.id,value:counts});
      if(message.type==='close') {await service.close();process.exit(0);}
    });
    process.send({type:'ready',url:service.url,origin:service.origin});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', serial = 0;
  child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
  const pending = new Map();
  child.on('message', message => { if (message.id) { pending.get(message.id)?.(message.value); pending.delete(message.id); } });
  const service = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error(`Workbench child exited ${code}: ${output}`)));
    child.on('message', message => { if (message.type === 'ready') resolve(message); });
  });
  service.command = message => new Promise(resolve => { const id = ++serial; pending.set(id, resolve); child.send({ ...message, id }); });
  t.after(async () => {
    if (child.exitCode === null) { child.send({ type: 'close' }); await new Promise(resolve => child.once('exit', resolve)); }
    await new Promise(resolve => api.close(resolve));
    assert.ok(!output.includes(auth) && !output.includes(note), 'service output contains no synthetic private values');
    rmSync(root, { recursive: true, force: true });
  });
  return { root, service, auth, note, seen };
}
function call(service, action, params = {}, { token, headers = {}, route = '/action' } = {}) {
  const payload = Buffer.from(JSON.stringify(route === '/action' ? { action, params } : {}));
  return new Promise((resolve, reject) => {
    const req = request(service.url, { method: 'POST', path: route, agent: false, headers: {
      origin: service.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
      'content-type': 'application/json', accept: 'application/json', 'content-length': payload.length,
      ...(token ? { 'x-workbench-token': token } : {}), ...headers,
    } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(payload);
  });
}
async function pair(service) {
  const pending = await call(service, null, null, { route: '/pair/start' });
  assert.equal(pending.status, 200);
  assert.equal(await service.command({ type: 'pair', code: pending.json.result.code }), true);
  const complete = await call(service, null, null, { route: '/pair/complete', headers: { 'x-workbench-pairing': pending.json.result.nonce } });
  assert.equal(complete.status, 200);
  return complete.json.result.token;
}

test('real adapters stay unreachable with a leaked URL or external origin; paired file destinations refuse escapes', async t => {
  const f = await fixture(t), { service, root } = f;
  const runId = 'run-review-retained', evidence = join(root, LAYOUT.evidence, 'fixture');
  write(join(evidence, `${runId}.json`), { runId, response: { status: 200, body: { ordinary: 'synthetic-private-response' } } });
  const cases = [['snapshot', {}], ['inspect', { stack: 'fixture', runId }], ['settings', { theme: 'ink' }],
    ['saved', { action: 'create', document: document() }], ['saved', { action: 'run', document: document(), inputs: { identifier: 'one', note: f.note } }]];
  for (const [action, params] of cases) assert.equal((await call(service, action, params)).status, 401);
  const token = await pair(service);
  for (const [action, params] of cases) {
    const denied = await call(service, action, params, { token, headers: { origin: 'https://attacker.invalid' } });
    assert.equal(denied.status, 403); assert.doesNotMatch(denied.text, /synthetic-private-response/);
  }
  assert.deepEqual(await service.command({ type: 'counts' }), {});
  assert.equal(f.seen.length, 0); assert.equal(existsSync(join(root, LAYOUT.requests)), false);
  assert.equal(existsSync(join(root, LAYOUT.evidence, 'workbench')), false);
  const snapshot = await call(service, 'snapshot', {}, { token });
  assert.equal(snapshot.status, 200); assert.ok(!snapshot.text.includes(f.auth));
  assert.equal(snapshot.json.result.stacks[0].environments[0].credential_readiness.state, 'present');
  const saved = await call(service, 'saved', { action: 'create', document: document() }, { token });
  assert.equal(saved.status, 200); assert.equal(f.seen.length, 0);
  for (const params of [
    { action: 'show', ref: '../../outside' }, { action: 'run', ref: saved.json.result.ref, inputFile: '../outside.json' },
    { action: 'run', ref: saved.json.result.ref, inputStdin: '{}' },
    { action: 'create', document: { ...document(), folder: '../outside' } },
  ]) assert.equal((await call(service, 'saved', params, { token })).status, 409);
  const outside = join(root, 'outside'); mkdirSync(outside);
  write(join(outside, 'private.json'), { synthetic_secret: 'must-not-be-read' });
  symlinkSync(outside, join(root, LAYOUT.requests, 'linked'));
  assert.equal((await call(service, 'saved', { action: 'create', document: { ...document(), folder: 'linked' } }, { token })).status, 409);
  assert.equal(existsSync(join(outside, 'echo.json')), false);
  symlinkSync(join(outside, 'private.json'), join(evidence, 'run-linked.json'));
  linkSync(join(outside, 'private.json'), join(evidence, 'run-hardlinked.json'));
  for (const invalidId of ['../outside/private', 'run-linked', 'run-hardlinked']) {
    const refused = await call(service, 'inspect', { stack: 'fixture', runId: invalidId }, { token });
    assert.equal(refused.status, 409); assert.doesNotMatch(refused.text, /must-not-be-read/);
  }
  assert.equal((await call(service, 'settings', { theme: 'paper' }, { token })).status, 200);
  const settings = join(root, LAYOUT.evidence, 'workbench', 'settings.json'); unlinkSync(settings);
  symlinkSync(join(outside, 'private.json'), settings);
  assert.equal((await call(service, 'settings', { theme: 'ink' }, { token })).status, 409);
  assert.equal(JSON.parse(readFileSync(join(outside, 'private.json'))).synthetic_secret, 'must-not-be-read');
  assert.equal(f.seen.length, 0);
});

test('paired saved sends keep current policy and redact runtime/auth reflections through private inspection', async t => {
  const f = await fixture(t), token = await pair(f.service), send = params => call(f.service, 'saved', params, { token });
  const saved = await send({ action: 'create', document: document() });
  assert.equal(saved.status, 200);
  const ref = saved.json.result.ref;
  const missing = await send({ action: 'run', ref, inputs: { identifier: 'one' } });
  assert.equal(missing.status, 409); assert.equal(missing.json.error.code, 'SAVED_INPUT_MISSING');
  assert.match(missing.json.error.next_action, /note/);
  const wrongScope = await send({ action: 'run', ref, environment: 'production', inputs: { identifier: 'one', note: f.note } });
  assert.equal(wrongScope.status, 409); assert.equal(wrongScope.json.error.code, 'SAVED_REQUEST_SCOPE_MISMATCH');
  const mutation = { ...document(), environment: 'production', request: { method: 'POST', path: '/echo', bindings: {} }, inputs: {} };
  const production = await send({ action: 'run', document: mutation });
  assert.equal(production.status, 200); assert.equal(production.json.result.mode, 'refused');
  assert.match(production.json.result.error.code, /PROD/); assert.equal(f.seen.length, 0);
  const result = await send({ action: 'run', ref, inputs: { identifier: 'one', note: f.note } });
  assert.equal(result.status, 200); assert.equal(result.json.result.status, 200); assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].headers.authorization, `Bearer ${f.auth}`); assert.equal(f.seen[0].headers['x-note'], f.note);
  assert.equal(result.json.result.saved_request.assertions, 'not_run');
  const runId = result.json.result.evidence;
  const inspected = await call(f.service, 'inspect', { runId, stack: 'fixture' }, { token });
  assert.equal(inspected.status, 200); assert.match(inspected.json.result.body_text, /synthetic-visible-response/);
  assert.ok(inspected.json.result.body_bytes <= 32768); assert.equal(inspected.json.result.redacted, true);
  const reopened = await send({ action: 'reopen', runId, stack: 'fixture' });
  assert.equal(reopened.status, 200); assert.equal(reopened.json.result.traffic, 'none');
  assert.equal(f.seen.length, 1);
  for (const reply of [result, inspected, reopened]) for (const value of [f.auth, f.note, Buffer.from(f.note).toString('base64'), 'synthetic-signature'])
    assert.ok(!reply.text.includes(value), `private value withheld from ${reply === inspected ? 'inspection' : 'action'}`);
  for (const folder of [join(f.root, LAYOUT.requests, 'review'), join(f.root, LAYOUT.evidence, 'fixture')])
    for (const file of readdirSync(folder).filter(name => name.endsWith('.json')))
      for (const value of [f.auth, f.note]) assert.ok(!readFileSync(join(folder, file), 'utf8').includes(value), file);
  assert.equal(inspected.headers['cache-control'], 'no-store');
  assert.equal(inspected.headers['access-control-allow-origin'], undefined);
});
