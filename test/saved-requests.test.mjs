import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';
import { saveSavedRequest, showSavedRequest, listSavedRequests, renameSavedRequest, deleteSavedRequest, reopenSavedRequest, savedRequestContext } from '../lib/saved-requests.mjs';
import { readSavedRequestInputFile, resolveSavedRequestInputs } from '../lib/saved-request-inputs.mjs';
import { savedRequestAction, savedActionFailure } from '../lib/saved-request-actions.mjs';
import { inspectRecordedResponse } from '../lib/response-inspection.mjs';

const moduleUrl = new URL('../lib/saved-requests.mjs', import.meta.url).href;
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value)); };
const document = () => ({ kind: 'saved-request', format_version: 1, folder: 'orders', name: 'lookup', stack: 'fixture', environment: 'local',
  request: { method: 'GET', path: '/orders/{id}', bindings: { path: { id: { $input: 'order_id' } }, query: { detail: { $enum: 'compact' } }, headers: { 'x-private-note': { $input: 'private_note' } } } },
  inputs: { order_id: { type: 'string' }, private_note: { type: 'string', sensitive: true, source: { env: 'FIXTURE_NOTE' } } }, credentials: [] });
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'saved-requests-')), seen = [];
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => {
      seen.push({ method: req.method, path: req.url, headers: req.headers, body });
      res.writeHead(req.url.includes('missing') ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'synthetic-order', note: req.headers['x-private-note'] ?? null, body }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  const contract = { openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, paths: {
    '/orders/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { parameters: [
      { name: 'detail', in: 'query', required: true, schema: { type: 'string', enum: ['compact', 'full'] } },
      { name: 'x-private-note', in: 'header', schema: { type: 'string' } }], responses: { 200: { description: 'ok' }, 404: { description: 'absent' } } } },
    '/orders': { post: { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } },
  } };
  write(join(root, 'openapi.json'), contract);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  createFixtureStack(root, { contract: 'openapi.json', baseUrl });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  mkdirSync(env.HOME, { recursive: true });
  return { root, seen, env, contract, baseUrl };
}
function run(f, data, extraEnv = {}) {
  const script = `import {readFileSync} from 'node:fs'; const api=await import(${JSON.stringify(moduleUrl)}); const data=JSON.parse(readFileSync(0,'utf8')); try { const result=await api.runSavedRequest(process.cwd(),data.ref??data.document,{...data.options,initiator:'cli.saved'});console.log(JSON.stringify(result));} catch(error){console.log(JSON.stringify({ok:false,error:{code:error.code,message:error.message,next:error.next,details:error.details}}));}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: { ...f.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => { if (code) reject(new Error(`Child ${code}: ${stderr}`)); else try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Invalid child output: ${stdout} ${stderr}`)); } });
    child.stdin.end(JSON.stringify(data));
  });
}
const refusal = (action, code) => assert.throws(action, error => error.code === code);

test('private response preview curates and re-masks headers, bounds UTF-8 and distinguishes absent API time', t => {
  const root = mkdtempSync(join(tmpdir(), 'response-preview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFixtureStack(root);
  const runId = 'run-preview', file = join(root, LAYOUT.evidence, 'fixture', `${runId}.json`);
  const token = 'synthetic-private-credential', signed = 'https://files.example.test/object?X-Amz-Signature=synthetic-signature';
  const record = { runId, durationMs: 12.5, response: { status: 200,
    headers: { 'Content-Type': 'application/json', 'content-length': '48000', etag: token,
      location: signed, link: `Bearer ${'a'.repeat(32)}`, 'x-request-id': 'x'.repeat(1023) + '🐦'.repeat(400),
      authorization: 'Bearer private-header-only-credential', 'set-cookie': 'session=private-cookie-value',
      'x-provider-private': 'unselected-header-value', 'retry-after': { invalid: 'not a string' } },
    body: { password: token, message: '🐦'.repeat(12000) },
  } };
  write(file, record);
  const before = readFileSync(file), preview = inspectRecordedResponse(root, { runId, stack: 'fixture' });
  assert.equal(preview.duration_ms, 12.5);
  assert.equal(preview.headers['content-type'], 'application/json');
  assert.equal(preview.headers['content-length'], '48000');
  assert.deepEqual(Object.keys(preview.headers).sort(), ['content-length', 'content-type', 'etag', 'link', 'location', 'x-request-id']);
  for (const value of [token, signed, 'a'.repeat(32), 'private-header-only-credential', 'private-cookie-value', 'unselected-header-value'])
    assert.ok(!JSON.stringify(preview).includes(value), 'secret and uncurated header values remain private');
  assert.match(preview.headers.etag, /withheld/); assert.match(preview.headers.location, /withheld/);
  assert.equal(preview.headers_total, 10); assert.equal(preview.headers_omitted, 4);
  assert.equal(preview.header_values_truncated, 1);
  assert.ok(Buffer.byteLength(preview.headers['x-request-id']) <= 1024);
  assert.ok(Buffer.byteLength(preview.body_text) <= 32768); assert.ok(preview.omitted_bytes > 0);
  assert.equal(preview.omitted_bytes, preview.body_bytes - Buffer.byteLength(preview.body_text));
  assert.ok(!preview.headers['x-request-id'].includes('\ufffd')); assert.ok(!preview.body_text.includes('\ufffd'));
  assert.deepEqual(readFileSync(file), before, 'inspection never rewrites the original receipt');
  for (const duration of [undefined, null, '12', -1, 0]) {
    write(file, { ...record, durationMs: duration });
    assert.equal(inspectRecordedResponse(root, { runId, stack: 'fixture' }).duration_ms, duration === 0 ? 0 : null);
  }
  // JSON can represent an overflowing number lexically; accepting it as API time
  // would make an invalid historical receipt look like a measured duration.
  writeFileSync(file, JSON.stringify(record).replace('"durationMs":12.5', '"durationMs":1e999'));
  assert.equal(inspectRecordedResponse(root, { runId, stack: 'fixture' }).duration_ms, null);
  for (const response of [{ status: 200, headers: { 'content-type': 'image/png' } }, { status: 200, body: null }]) {
    write(file, { runId, response });
    const read = inspectRecordedResponse(root, { runId, stack: 'fixture' });
    assert.equal(read.body_available, Object.hasOwn(response, 'body'));
    if (!read.body_available) assert.match(read.body_unavailable_reason, /not retained/);
    else { assert.equal(read.body_text, 'null'); assert.equal(read.body_unavailable_reason, null); }
  }
  for (const password of ['body', 'headers', 'etag']) {
    write(file, { runId, response: { body: { password }, headers: { etag: password } } });
    const read = inspectRecordedResponse(root, { runId, stack: 'fixture' });
    assert.match(read.body_text, /withheld/);
    if (password === 'etag') { assert.deepEqual(read.headers, {}); assert.equal(read.headers_omitted, 1); }
    else assert.match(read.headers.etag, /withheld/);
  }
});

test('portable create/show/list preserve shape; literals, required inputs and unsafe paths refuse without traffic', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document());
  assert.equal(f.seen.length, 0); assert.equal(saved.ref, 'orders/lookup');
  assert.equal(showSavedRequest(f.root, saved.ref).document.id, saved.document.id);
  assert.equal(listSavedRequests(f.root).requests[0].id, saved.document.id);
  const literal = document(); literal.request.bindings.query.detail = 'private-query-value';
  refusal(() => saveSavedRequest(f.root, literal), 'SAVED_BINDING_INVALID');
  const missing = document(); delete missing.request.bindings.query.detail;
  refusal(() => saveSavedRequest(f.root, missing), 'SAVED_BINDING_MISSING');
  const enumBad = document(); enumBad.request.bindings.query.detail = { $enum: 'private-query-value' };
  refusal(() => saveSavedRequest(f.root, enumBad), 'SAVED_LITERAL_NOT_ENUM');
  refusal(() => showSavedRequest(f.root, '../outside'), 'SAVED_REQUEST_PATH');
  const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(f.root, LAYOUT.directory, 'requests', 'linked'));
  refusal(() => saveSavedRequest(f.root, { ...document(), folder: 'linked' }), 'SAVED_REQUEST_UNSAFE_PATH');
  assert.equal(listSavedRequests(f.root).issues[0].code, 'SAVED_REQUEST_UNSAFE_PATH');
  assert.equal(f.seen.length, 0);
});

test('send uses current engine, creates separate receipts, preserves HTTP failure, masks sensitive reflections and discovers bounded references', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document()), secret = 'private-runtime-note-739204';
  const data = { ref: saved.ref, options: { inputStdin: JSON.stringify({ order_id: 'missing', private_note: secret }) } };
  const first = await run(f, data), second = await run(f, { ...data, options: { inputStdin: JSON.stringify({ order_id: 'found', private_note: secret }) } });
  assert.equal(first.status, 404); assert.equal(second.status, 200);
  assert.equal(first.assertions, null); assert.equal(second.saved_request.assertions, 'not_run');
  assert.notEqual(first.evidence, second.evidence); assert.notEqual(first.saved_request.execution_id, second.saved_request.execution_id);
  assert.equal(f.seen[0].headers['x-private-note'], secret); assert.equal(f.seen[0].path, '/v1/orders/missing?detail=compact');
  assert.ok(!JSON.stringify(first).includes(secret)); assert.ok(!JSON.stringify(second).includes(secret));
  const evidence = join(f.root, LAYOUT.evidence, 'fixture');
  for (const file of readdirSync(evidence).filter(file => file.endsWith('.json'))) assert.ok(!readFileSync(join(evidence, file), 'utf8').includes(secret), file);
  assert.ok(!readFileSync(join(f.root, 'machine', 'usage.jsonl'), 'utf8').includes(secret));
  assert.equal(second.known.saved_requests.requests[0].ref, saved.ref);
  const context = savedRequestContext(f.root, { stack: 'fixture', environment: 'local', operation: 'GET /orders/{id}', maxBytes: 180 });
  assert.equal(context.bytes, Buffer.byteLength(JSON.stringify(context))); assert.ok(context.bytes <= 180);
  assert.ok(!JSON.stringify(context).includes('private_note'));
  const expanded = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'found', private_note: 'lookup' } } });
  assert.equal(expanded.known.saved_requests.bytes, Buffer.byteLength(JSON.stringify(expanded.known.saved_requests)));
  assert.equal(expanded.known.saved_requests.requests[0].ref, 'orders/[redacted]');
  assert.equal(savedRequestContext(f.root, { stack: 'fixture', environment: 'local', operation: 'GET /orders/{id}', env: { API_CONTEXT_OFF: '1' } }), null);
  const off = await run(f, data, { API_CONTEXT_OFF: '1' }); assert.equal(off.known, null);
});

test('wrong scope, missing/type input, changed credential reference and production refusal send no traffic', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document());
  const cases = [
    [{ environment: 'production', inputs: {} }, 'SAVED_REQUEST_SCOPE_MISMATCH'],
    [{ inputs: {} }, 'SAVED_INPUT_MISSING'],
    [{ inputs: { order_id: 3, private_note: 'synthetic' } }, 'SAVED_INPUT_TYPE'],
    [{ inputs: { order_id: 'found', private_note: 'synthetic', unknown: 'never-print-me' } }, 'SAVED_INPUT_UNKNOWN'],
  ];
  for (const [options, code] of cases) { const out = await run(f, { ref: saved.ref, options }); assert.equal(out.error.code, code); assert.ok(!JSON.stringify(out).includes('never-print-me')); }
  const file = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(file));
  config.environments.local.auth = 'bearer:FIXTURE_TOKEN'; write(file, config);
  assert.equal((await run(f, { ref: saved.ref })).error.code, 'SAVED_CREDENTIAL_SCOPE_MISMATCH');
  const bound = saveSavedRequest(f.root, { ...saved.document, credentials: ['bearer:FIXTURE_TOKEN'] }, { overwrite: true });
  const missingCredential = await run(f, { ref: bound.ref, options: { inputs: { order_id: 'found', private_note: 'synthetic' } } });
  assert.equal(missingCredential.error.code, 'IMPORTED_AUTH_VALUE_REQUIRED');
  delete config.environments.local.auth; config.environments.local.production = true; write(file, config);
  const post = saveSavedRequest(f.root, { ...document(), name: 'create', request: { method: 'POST', path: '/orders', bindings: { body: { title: { $input: 'title' } } } }, inputs: { title: { type: 'string' } } });
  const production = await run(f, { ref: post.ref, options: { inputs: { title: 'synthetic' } } });
  assert.equal(production.mode, 'refused'); assert.match(production.error.code, /PROD/);
  assert.equal(f.seen.length, 0);
});

test('safe local file inputs require Git ignored/untracked regular files; environment references work', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document()), secret = 'local-file-private-text-8297';
  write(join(f.root, 'local-inputs.json'), { order_id: 'found', private_note: secret });
  refusal(() => readSavedRequestInputFile(f.root, 'local-inputs.json'), 'SAVED_INPUT_FILE_NOT_PRIVATE');
  writeFileSync(join(f.root, '.gitignore'), 'local-inputs.json\n');
  const out = await run(f, { ref: saved.ref, options: { inputFile: 'local-inputs.json' } }); assert.equal(out.status, 200); assert.ok(!JSON.stringify(out).includes(secret));
  execFileSync('git', ['add', '--force', 'local-inputs.json'], { cwd: f.root });
  refusal(() => readSavedRequestInputFile(f.root, 'local-inputs.json'), 'SAVED_INPUT_FILE_NOT_PRIVATE');
  const envOut = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'found' } } }, { FIXTURE_NOTE: secret });
  assert.equal(envOut.status, 200); assert.ok(!JSON.stringify(envOut).includes(secret));
  const ordinary = structuredClone(saved.document); ordinary.inputs.private_note.sensitive = false;
  saveSavedRequest(f.root, ordinary, { overwrite: true });
  const opaque = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'found' } } }, { FIXTURE_NOTE: secret });
  assert.equal(opaque.status, 200); assert.ok(!JSON.stringify(opaque).includes(secret));
  const configFile = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(configFile));
  config.environments.local.auth = 'bearer:FIXTURE_NOTE'; write(configFile, config);
  refusal(() => saveSavedRequest(f.root, { ...ordinary, credentials: ['bearer:FIXTURE_NOTE'] }, { overwrite: true }), 'SAVED_CREDENTIAL_BINDING');
});

test('history reopen never copies values, rename/delete retain receipts, and clone reuse needs fresh inputs', async t => {
  const f = await fixture(t), saved = saveSavedRequest(f.root, document());
  const original = await run(f, { ref: saved.ref, options: { inputs: { order_id: 'private-order-id', private_note: 'private-history-note' } } });
  const draft = reopenSavedRequest(f.root, { runId: original.evidence, stack: 'fixture' });
  assert.equal(draft.traffic, 'none'); assert.equal(f.seen.length, 1); assert.ok(!JSON.stringify(draft).includes('private-order-id')); assert.ok(!JSON.stringify(draft).includes('private-history-note'));
  assert.equal(draft.document.source.run_id, original.evidence); assert.ok(draft.missing_inputs.length >= 2);
  const renamed = renameSavedRequest(f.root, saved.ref, { folder: 'archive', name: 'renamed' }); assert.equal(renamed.document.id, saved.document.id);
  const clone = join(f.root, 'clone'); mkdirSync(clone); cpSync(join(f.root, LAYOUT.collection), join(clone, LAYOUT.collection), { recursive: true }); cpSync(join(f.root, LAYOUT.directory, 'requests'), join(clone, LAYOUT.directory, 'requests'), { recursive: true });
  const fresh = { ...f, root: clone, env: { ...f.env, API_CONTEXT_DIR: clone, HOME: join(clone, 'home'), [HOME_ENV_NAME]: join(clone, 'machine'), API_USAGE_LOG: join(clone, 'machine', 'usage.jsonl') } }; mkdirSync(fresh.env.HOME);
  assert.equal(showSavedRequest(clone, renamed.ref).document.id, saved.document.id);
  const missing = await run(fresh, { ref: renamed.ref }); assert.equal(missing.error.code, 'SAVED_INPUT_MISSING');
  refusal(() => reopenSavedRequest(clone, { runId: original.evidence, stack: 'fixture' }), 'SAVED_HISTORY_UNAVAILABLE');
  const resumed = await run(fresh, { ref: renamed.ref, options: { inputs: { order_id: 'fresh', private_note: 'fresh-local-secret' } } }); assert.equal(resumed.status, 200); assert.notEqual(resumed.evidence, original.evidence);
  deleteSavedRequest(f.root, renamed.ref); assert.equal(listSavedRequests(f.root).requests.length, 0);
  assert.ok(readFileSync(join(f.root, LAYOUT.evidence, 'fixture', `${original.evidence}.json`)));
});

test('contractless bound drafts are author-declared, enum promotion is refused, and runtime file directives never read', async t => {
  const f = await fixture(t), file = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(file)); delete config.contract; write(file, config);
  const raw = { ...document(), name: 'blank', request: { method: 'POST', path: '/orders', bindings: { body: { $input: 'payload' } } }, inputs: { payload: { type: 'object' } } };
  const saved = saveSavedRequest(f.root, raw); assert.match(showSavedRequest(f.root, saved.ref).readiness.basis, /author-declared/);
  const out = await run(f, { ref: saved.ref, options: { inputs: { payload: { $file: '/etc/passwd' } } } }); assert.equal(out.error.code, 'SAVED_INPUT_STRUCTURE'); assert.equal(f.seen.length, 0);
  const noContractEnum = document(); refusal(() => saveSavedRequest(f.root, noContractEnum), 'SAVED_LITERAL_NOT_ENUM');
  const clean = await run(f, { ref: saved.ref, options: { inputs: { payload: { title: 'synthetic' } } } }); assert.equal(clean.status, 200);
});

test('whole-body inputs check nested contract schemas and expanded environment inputs stay bounded', async t => {
  const f = await fixture(t), contractPath = join(f.root, LAYOUT.collection, 'fixture', 'openapi.json');
  const raw = { ...document(), name: 'structured', request: { method: 'POST', path: '/orders', bindings: { body: { $input: 'payload' } } }, inputs: { payload: { type: 'object' } } };
  const schema = f.contract.paths['/orders'].post.requestBody.content['application/json'];
  schema.schema = { type: 'object', required: ['nested'], properties: { nested: { type: 'object', allOf: [{ required: ['missing'] }] } } };
  write(contractPath, f.contract);
  const saved = saveSavedRequest(f.root, raw);
  const composed = await run(f, { ref: saved.ref, options: { inputs: { payload: { nested: {} } } } });
  assert.equal(composed.error.code, 'SAVED_CONTRACT_UNSUPPORTED');
  schema.schema = { type: 'object', additionalProperties: { type: 'string' } }; write(contractPath, f.contract);
  const wrongType = await run(f, { ref: saved.ref, options: { inputs: { payload: { undeclared: 123 } } } });
  assert.equal(wrongType.error.code, 'SAVED_INPUT_TYPE');
  schema.schema = { type: 'object', additionalProperties: false }; write(contractPath, f.contract);
  const unexpected = await run(f, { ref: saved.ref, options: { inputs: { payload: { undeclared: 'value' } } } });
  assert.equal(unexpected.error.code, 'SAVED_INPUT_FIELD');
  assert.equal(f.seen.length, 0);
  const keys = ['SAVED_FIXTURE_ENV_A', 'SAVED_FIXTURE_ENV_B', 'SAVED_FIXTURE_ENV_C'];
  const previous = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'x'.repeat(100000);
    const declarations = Object.fromEntries(keys.map((key, index) => [`input_${index}`, { type: 'string', source: { env: key } }]));
    refusal(() => resolveSavedRequestInputs(f.root, declarations), 'SAVED_INPUT_LIMIT');
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});


test('contract draft declares required request fields without examples, private values, writes or traffic', async t => {
  const f = await fixture(t), contractFile = join(f.root, LAYOUT.collection, 'fixture', 'openapi.json');
  f.contract.paths['/sessions/{id}'] = { post: {
    parameters: [
      { in: 'path', name: 'id', required: true, schema: { type: 'string', example: 'private-example-path' } },
      { in: 'query', name: 'retry', required: true, schema: { type: 'integer', enum: [0, 1, 2], default: 99 } },
      { in: 'header', name: 'x-confirm', required: true, schema: { type: 'boolean' } },
      { in: 'query', name: 'optional', schema: { type: 'string' } },
    ],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['session_token', 'settings'], properties: {
        session_token: { type: 'string', description: 'private-description', example: 'private-example-token' },
        settings: { type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' }, label: { type: 'string' } } },
      },
    } } } }, responses: { 200: { description: 'ok' } },
  } };
  write(contractFile, f.contract);
  const configFile = join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), config = JSON.parse(readFileSync(configFile));
  config.environments.local.auth = 'bearer:FIXTURE_TOKEN'; write(configFile, config);
  const before = readdirSync(join(f.root, LAYOUT.directory), { recursive: true }).sort();
  const result = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /sessions/{id}' }, { readOnly: true });
  assert.equal(result.ready, true); assert.equal(result.traffic, 'none'); assert.equal(result.document.environment, 'local');
  assert.equal(result.document.request.body_type, 'json'); assert.deepEqual(result.document.credentials, ['bearer:FIXTURE_TOKEN']);
  assert.deepEqual(result.fields.map(field => [field.label, field.type]), [['path.id', 'string'], ['query.retry', 'integer'], ['headers.x-confirm', 'boolean'], ['body.session_token', 'string'], ['body.settings.enabled', 'boolean']]);
  assert.deepEqual(result.fields.find(field => field.label === 'query.retry').enum, [0, 1, 2]);
  const tokenField = result.fields.find(field => field.label === 'body.session_token');
  assert.equal(result.document.inputs[tokenField.input].sensitive, true);
  assert.deepEqual(result.document.request.bindings.body.session_token, { $input: tokenField.input });
  assert.match(result.warnings.find(w => w.code === 'SAVED_DRAFT_OPTIONAL_OMITTED').message, /2/);
  assert.ok(!JSON.stringify(result).match(/private-example|private-description|default|\b99\b/));
  assert.deepEqual(readdirSync(join(f.root, LAYOUT.directory), { recursive: true }).sort(), before); assert.equal(f.seen.length, 0);
  saveSavedRequest(f.root, result.document);
});

test('incomplete contract drafts block with a named field; missing-body errors explain the required fields', async t => {
  const f = await fixture(t), request = { ...document(), request: { method: 'POST', path: '/orders', bindings: {} }, inputs: {} };
  let failure; try { saveSavedRequest(f.root, request); } catch (error) { failure = savedActionFailure(error); }
  assert.equal(failure.error.code, 'SAVED_BINDING_MISSING'); assert.match(failure.error.message, /body.title/);
  assert.match(failure.error.next, /required.*field/i);
  f.contract.paths['/orders'].post.requestBody.content['application/json'].schema.properties.title = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
  const result = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /orders' });
  assert.equal(result.ready, false); assert.equal(result.warnings.some(w => w.blocking && /body.title/.test(w.message)), true);
  f.contract.paths['/orders'].post.requestBody.content = { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } };
  write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
  const form = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /orders' });
  assert.equal(form.ready, true); assert.equal(form.document.request.body_type, 'form');
  saveSavedRequest(f.root, form.document);
  f.contract.paths['/orders'].post.requestBody.content['application/x-www-form-urlencoded'].schema.properties.title = { type: 'object', required: ['nested'], properties: { nested: { type: 'string' } } };
  write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
  const nestedForm = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'POST /orders' });
  assert.equal(nestedForm.ready, false); assert.equal(nestedForm.warnings.some(w => w.blocking && /scalar fields/.test(w.message)), true);
  for (const location of ['cookie', 'formData']) {
    f.contract.paths['/unsupported'] = { get: { parameters: [{ in: location, name: 'required_field', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } };
    write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
    const unsupported = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'GET /unsupported' });
    assert.equal(unsupported.ready, false, location);
    assert.equal(unsupported.warnings.some(w => w.blocking && w.message.includes(`${location}.required_field`)), true);
  }
  for (const choices of [[{ hidden: 'not-a-scalar' }], ['sk_syntheticNeverUseThisValue']]) {
    f.contract.paths['/enum'] = { get: { parameters: [{ in: 'query', name: 'choice', required: true, schema: { type: 'string', enum: choices } }], responses: { 200: { description: 'ok' } } } };
    write(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'), f.contract);
    const unsafeEnum = await savedRequestAction(f.root, { action: 'draft', stack: 'fixture', operation: 'GET /enum' });
    assert.equal(unsafeEnum.ready, false);
    assert.equal(JSON.stringify(unsafeEnum).includes('not-a-scalar'), false);
    assert.equal(JSON.stringify(unsafeEnum).includes('sk_syntheticNeverUseThisValue'), false);
  }
  assert.equal(f.seen.length, 0);
});
