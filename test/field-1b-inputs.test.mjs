import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOnlyPlan } from '../lib/verify.mjs';
import { readOnlyRequestProblem } from '../lib/librarian.mjs';
import { HOME_ENV_NAME, FEEDBACK_STACK_NAME } from '../lib/brand.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const ref = (path, encoding = 'utf8', prefix) => ({ $file: { path, encoding, ...(prefix === undefined ? {} : { prefix }) } });
const digest = value => createHash('sha256').update(value).digest('hex');
const run = (cwd, env, args, input = '') => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  child.on('error', reject); child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); }); child.stdin.end(input);
});
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'field-input-')), home = join(root, 'home'); mkdirSync(home);
  const child = spawn(process.execPath, [join(source, 'test/fixtures/field-input-server.mjs'), join(root, 'received')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const [{ origin }] = await once(child, 'message');
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } rmSync(root, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'machine'), API_BASE_URL: origin,
    API_CONTEXT_DIR: root, API_CONTEXT_OFF: '1', API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_BUDGET: '4000', API_TIMEOUT_MS: '2000', NO_COLOR: '1' };
  return { root, env, async execute(input, mode = 'direct', overrides = {}) {
    const func = mode === 'batch' ? 'runEnvelope' : 'apiRequest';
    const args = mode === 'cli' ? [join(source, 'bin/cli.mjs'), 'protocol', join(root, 'input.json')]
      : ['--input-type=module', '-e', `import {${func}} from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)}; let input=''; for await(const c of process.stdin) input+=c; console.log(JSON.stringify(await ${func}(JSON.parse(input))));`];
    if (mode === 'cli') writeFileSync(join(root, 'input.json'), JSON.stringify(input));
    const out = await run(root, { ...env, ...overrides }, args, mode === 'cli' ? '' : JSON.stringify(input));
    return { ...out, result: out.stdout.trim() ? JSON.parse(out.stdout) : null };
  }, cli: (...args) => run(root, env, [join(source, 'bin/cli.mjs'), ...args]),
    script: code => run(root, env, ['--input-type=module', '-e', code]) };
}

test('CLI-005 batch preserves double braces and still resolves single-brace captures', async t => {
  const f = await fixture(t);
  const { result } = await f.execute({ requests: [{ path: '/capture', capture: { id: 'id' } },
    { method: 'POST', path: '/echo', body: { template: '{{item.expected}}', mixed: '{{id}} {id}', nested: ['{{{id}}}'] },
      expect: [{ json: 'template', equals: '{{item.expected}}' }, { json: 'mixed', equals: '{{id}} captured-value' }, { json: 'nested.0', equals: '{{{id}}}' }] }] }, 'batch');
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.results[1].assertions.passed, 3);
});
test('CLI-005 unresolved single braces still refuse and direct bodies retain templates', async t => {
  const f = await fixture(t);
  const direct = await f.execute({ method: 'POST', path: '/echo', body: { template: '{{item.expected}}' }, expect: [{ json: 'template', equals: '{{item.expected}}' }] });
  assert.equal(direct.result.ok, true);
  const batch = await f.execute({ requests: [{ method: 'POST', path: '/echo', body: '{missing}' }] }, 'batch');
  assert.equal(batch.result.results[0].error?.code, 'UNRESOLVED_PLACEHOLDER'); assert.equal(batch.result.attempted, 0);
});
for (const mode of ['direct', 'batch']) test(`CLI-006/008 ${mode} multipart infers MIME and preserves explicit directory filename`, async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'photo.PNG'), 'png-fixture'); writeFileSync(join(f.root, 'other.unknown'), 'other-fixture');
  const req = { method: 'POST', path: '/multipart', files: { image: 'photo.PNG', document: { path: 'other.unknown', contentType: 'text/markdown', filename: 'skill/SKILL.md' }, unknown: 'other.unknown' },
    expect: [{ json: 'parts.0.type', equals: 'image/png' }, { json: 'parts.1.filename', equals: 'skill/SKILL.md' }, { json: 'parts.1.type', equals: 'text/markdown' }, { json: 'parts.2.type', equals: 'application/octet-stream' }] };
  const { result } = await f.execute(mode === 'batch' ? { requests: [req] } : req, mode);
  assert.equal(result.ok, true, JSON.stringify(result));
});
for (const mode of ['direct', 'batch', 'cli']) test(`CLI-007 ${mode} expands nested UTF-8/base64 references without templating bytes`, async t => {
  const f = await fixture(t), text = '{{item.expected}} {not-a-capture} café';
  writeFileSync(join(f.root, 'fixture.txt'), text);
  const expected = 'data:text/plain;base64,' + Buffer.from(text).toString('base64');
  const req = { protocol: 'http', method: 'POST', path: '/echo', body: { text: ref('fixture.txt'), nested: [ref('fixture.txt', 'base64', 'data:text/plain;base64,')] },
    expect: [{ json: 'text', length: text.length }, { json: 'nested.0', length: expected.length }] };
  const { result } = await f.execute(mode === 'batch' ? { requests: [req] } : req, mode);
  assert.equal(result.ok, true, JSON.stringify(result));
});
test('CLI-007 a small CLI envelope can send a file larger than 1 MiB; inline input cap remains', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(1100 * 1024, 97); writeFileSync(join(f.root, 'large.bin'), bytes);
  const encoded = bytes.toString('base64');
  const req = { protocol: 'http', method: 'POST', path: '/digest', body: { image: ref('large.bin', 'base64') },
    expect: [{ json: 'image.length', equals: encoded.length }, { json: 'image.sha256', equals: digest(encoded) }] };
  const good = await f.execute(req, 'cli'); assert.equal(good.result.ok, true, good.stderr);
  assert.ok(readFileSync(join(f.root, 'input.json')).length < 1024);
  const oversized = await f.execute({ ...req, body: { image: encoded } }, 'cli');
  assert.notEqual(oversized.code, 0); assert.match(oversized.stdout + oversized.stderr, /JSON_INPUT_LIMIT/);
});
test('CLI-007 suite save/run preserves references and literal templates', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'fixture.txt'), 'suite contents');
  const req = { method: 'POST', path: '/echo', body: { text: ref('fixture.txt'), template: '{{item.expected}}' }, expect: [{ json: 'text', equals: 'suite contents' }] };
  writeFileSync(join(f.root, 'suite.json'), JSON.stringify({ requests: [req] }));
  const saved = await f.cli('suite', 'save', 'inputs', 'suite.json'); assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  const ran = await f.cli('suite', 'run', 'inputs', '--json'); assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(JSON.parse(ran.stdout).suites[0].ok, true);
});
test('CLI-007 descriptor paths are literal and captured responses cannot synthesize local reads', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'fixture.txt'), 'local bytes');
  const { result } = await f.execute({ requests: [{ path: '/capture', capture: { path: 'path', descriptor: 'descriptor' } },
    { method: 'POST', path: '/echo', body: { text: ref('{path}') } }] }, 'batch');
  assert.equal(result.results[1].error?.code, 'REQUEST_FILE_UNREADABLE'); assert.equal(result.attempted, 1);
  const captured = await f.execute({ requests: [{ path: '/capture', capture: { descriptor: 'descriptor' } },
    { method: 'POST', path: '/echo', body: { text: '{descriptor}' }, expect: [{ json: 'text', equals: '[object Object]' }] }] }, 'batch');
  assert.equal(captured.result.ok, true);
});
test('CLI-007 malformed, oversized and nonregular file references refuse with named codes', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'big.bin'), Buffer.alloc(16 * 1024 * 1024 + 1));
  writeFileSync(join(f.root, 'small.txt'), 'hello'); symlinkSync('small.txt', join(f.root, 'linked.txt'));
  for (const [file, code] of [[ref('small.txt', 'hex'), 'BODY_FILE_INVALID'], [ref('big.bin'), 'BODY_FILE_LIMIT'], [ref('linked.txt'), 'REQUEST_FILE_UNSAFE'], [ref('home'), 'REQUEST_FILE_UNSAFE'], [ref('missing.txt'), 'REQUEST_FILE_UNREADABLE']]) {
    const { result } = await f.execute({ requests: [{ method: 'POST', path: '/echo', body: { file } }] }, 'batch');
    assert.equal(result.results[0].error?.code, code, JSON.stringify(result)); assert.equal(result.attempted, 0);
  }
});
test('CLI-007 total encoded expansion is bounded separately from per-file bytes', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'chunk.bin'), Buffer.alloc(13 * 1024 * 1024, 97));
  const { result } = await f.execute({ requests: [{ method: 'POST', path: '/echo', body: [ref('chunk.bin', 'base64'), ref('chunk.bin', 'base64')] }] }, 'batch');
  assert.equal(result.results[0].error?.code, 'BODY_FILE_LIMIT'); assert.equal(result.attempted, 0);
});
test('CLI-007 admission precedes file access for production, authentication, protocol and feedback', async t => {
  const f = await fixture(t), body = { file: ref('missing.txt') };
  const config = join(f.root, 'production.json'); writeFileSync(config, JSON.stringify({ v: 1, default: 'production', environments: { production: { baseUrl: f.env.API_BASE_URL, production: true } } }));
  const production = await f.execute({ method: 'POST', path: '/echo', body }, 'direct', { API_CONFIG: config, API_ALLOW_PRODUCTION_WRITES: '0' });
  assert.match(production.result.error?.code ?? '', /PRODUCTION/);
  const auth = await f.execute({ method: 'POST', path: '/echo', body }, 'direct', { API_AUTH: 'basic:FIELD_USER:FIELD_PASSWORD' });
  assert.match(auth.result.error?.code ?? '', /AUTH/);
  const protocol = await f.execute({ protocol: 'jsonrpc', path: '/echo', body, rpc: { method: 'fixture' } });
  assert.equal(protocol.result.error?.code, 'PROTOCOL_OPTION_UNSUPPORTED');
  const feedback = await f.execute({ stack: FEEDBACK_STACK_NAME, method: 'POST', path: '/feedback', body });
  assert.equal(feedback.result.error?.code, 'FEEDBACK_REQUEST_INVALID');
});
test('CLI-007 read-only verify skips local file input and librarian refuses it atomically', () => {
  const req = { path: '/echo', body: { file: ref('missing.txt') }, capture: { file: 'file' } };
  const plan = readOnlyPlan({ requests: [req, { path: '/echo', headers: { 'x-file': '{file}' } }] });
  assert.equal(plan.retained.length, 0); assert.equal(plan.skipped.length, 2); assert.match(plan.skipped[0].reason, /file/i);
  assert.equal(readOnlyRequestProblem({ requests: [{ path: '/health' }, req] })?.code, 'LIBRARIAN_READ_ONLY');
});
test('CLI-006/008 file reads also follow required authentication and malformed metadata refuses', async t => {
  const f = await fixture(t);
  const { result } = await f.execute({ method: 'POST', path: '/multipart', files: { file: 'missing.txt' } }, 'direct', { API_AUTH: 'basic:FIELD_USER:FIELD_PASSWORD' });
  assert.equal(result?.error?.code, 'AUTH_ENV_MISSING');
  for (const file of [{ path: 'missing.txt', contentType: 'text/plain\r\nx-injected: yes' }, { path: 'missing.txt', filename: '../folder/file\n.txt' }, { path: 'missing.txt', extra: true }]) {
    const out = await f.execute({ method: 'POST', path: '/multipart', files: { file } });
    assert.equal(out.result?.error?.code, 'MULTIPART_FILE_INVALID');
  }
});
test('CLI-007 special files refuse promptly instead of waiting for input', async t => {
  const f = await fixture(t), pipe = join(f.root, 'input.pipe');
  const child = spawn('mkfifo', [pipe], { stdio: 'ignore' }); const [code] = await once(child, 'exit'); assert.equal(code, 0);
  const out = await f.execute({ method: 'POST', path: '/echo', body: { file: ref('input.pipe') } });
  assert.equal(out.result?.error?.code, 'REQUEST_FILE_UNSAFE');
});
test('CLI-005 read-only dependency scanning treats double braces as literal', () => {
  const plan = readOnlyPlan({ requests: [{ method: 'POST', path: '/create', capture: { id: 'id' } },
    { path: '/health', headers: { 'x-template': '{{id}}' } }] });
  assert.equal(plan.retained.length, 1); assert.equal(plan.skipped.length, 1);
});
test('CLI-007 recorded request shape describes transmitted file text rather than the local descriptor', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'fixture.txt'), 'local fixture text');
  writeFileSync(join(f.root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Fixture', version: '1' },
    paths: { '/echo': { post: { responses: { '200': { description: 'ok' } } } } } }));
  createFixtureStack(f.root, { baseUrl: f.env.API_BASE_URL, contract: 'openapi.json' });
  const { result } = await f.execute({ stack: 'fixture', method: 'POST', path: '/echo', body: { content: ref('fixture.txt') },
    expect: [{ json: 'content', equals: 'local fixture text' }] }, 'direct', { API_CONTEXT_OFF: '0' });
  assert.equal(result.ok, true); assert.equal(result.context_capture?.state, 'captured');
  const store = JSON.parse(readFileSync(fixtureContextFile(f.root)));
  const [entry] = Object.values(store.api_context.operations), [observation] = entry.observations;
  assert.equal(observation.request_shape.properties.body.properties.content.type, 'string');
  assert.equal(JSON.stringify(observation.request_shape).includes('$file'), false);
});
test('CLI-007 concurrent keyed requests read current file bytes and retain separate evidence', async t => {
  const f = await fixture(t); writeFileSync(join(f.root, 'fixture.txt'), 'first bytes');
  const request = { method: 'POST', path: '/hold', idempotency_key: 'fixture-key', body: { content: ref('fixture.txt') } };
  const output = await f.script(`import {apiRequest} from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)}; import {existsSync,writeFileSync} from 'node:fs';
    const args=${JSON.stringify(request)},first=apiRequest(args);
    for(let n=0;n<200&&!existsSync('received');n++)await new Promise(resolve=>setTimeout(resolve,5));
    if(!existsSync('received'))throw Error('first request did not reach fixture');
    writeFileSync('fixture.txt','second bytes'); const second=apiRequest(args);
    console.log(JSON.stringify(await Promise.all([first,second])));`);
  assert.equal(output.code, 0, output.stderr); const [first, second] = JSON.parse(output.stdout);
  assert.equal(first.data.content, 'first bytes'); assert.equal(second.data.content, 'second bytes');
  assert.notEqual(first.evidence, second.evidence); assert.notEqual(second.coalesced, true);
});
