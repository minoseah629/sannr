// Exercise public process adapters, not just the shared dispatcher. All traffic
// is a test-owned loopback fixture; invocation values and HOME stay isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';

// Also exercise the exact unpacked candidate in an independent install.
const candidate = process.env.SANNR_TEST_PACKAGE;
const CLI = candidate ? join(candidate, 'bin', 'cli.mjs') : fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const SERVER = candidate ? join(candidate, 'server.mjs') : fileURLToPath(new URL('../server.mjs', import.meta.url));
const toolName = 'api_saved_requests';
const secret = 'synthetic-private-runtime-value-739204';
const document = () => ({ folder: 'orders', name: 'lookup', stack: 'fixture', environment: 'local',
  request: { method: 'GET', path: '/orders/{id}', bindings: {
    path: { id: { $input: 'order_id' } }, query: { detail: { $enum: 'compact' } },
    headers: { 'x-private-note': { $input: 'private_note' } },
  } }, inputs: { order_id: { type: 'string', sensitive: true }, private_note: { type: 'string', sensitive: true } }, credentials: [] });

function childResult(command, args, options = {}, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Adapter process timed out')); }, 15_000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-adapters-')), seen = [], clients = [];
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  mkdirSync(env.HOME, { recursive: true });
  assert.equal((await childResult('git', ['init', '--quiet'], { cwd: root, env })).code, 0);
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, note: req.headers['x-private-note'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'ready', reflected_note: req.headers['x-private-note'], password: 'synthetic-response-secret',
      signed_url: 'https://files.example.test/file?X-Amz-Signature=synthetic-signature' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of clients) await client.close();
    await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Adapter fixture', version: '1' }, paths: {
    '/orders/{id}': { get: { parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'detail', in: 'query', required: true, schema: { type: 'string', enum: ['compact', 'full'] } },
      { name: 'x-private-note', in: 'header', schema: { type: 'string' } },
    ], responses: { 200: { description: 'ready' } } } },
  } }));
  createFixtureStack(root, { contract: 'openapi.json', baseUrl: `http://127.0.0.1:${server.address().port}` });
  return { root, env, seen, clients };
}

async function cli(f, args, input = '') {
  return childResult(process.execPath, [CLI, ...args], { cwd: f.root, env: f.env }, input);
}
function cliAdapter(f) {
  return async args => {
    const argv = ['saved', args.action]; let input = '';
    if (args.ref !== undefined) argv.push(args.ref);
    if (args.runId !== undefined) argv.push(args.runId);
    if (args.document !== undefined) { argv.push('--file', '-'); input = JSON.stringify(args.document); }
    if (args.inputs !== undefined) { argv.push('--inputs-stdin'); input = JSON.stringify(args.inputs); }
    for (const [key, flag] of [['stack', '--stack'], ['environment', '--env'], ['operation', '--operation'], ['folder', '--folder'], ['name', '--name']])
      if (args[key] !== undefined) argv.push(flag, args[key]);
    const result = await cli(f, argv, input);
    const value = JSON.parse(result.stdout);
    assert.equal(result.code, value.ok === false ? 2 : 0, result.stderr);
    return { value, error: result.code !== 0, raw: result.stdout + result.stderr };
  };
}
async function mcpAdapter(f, readOnly = false) {
  const child = spawn(process.execPath, [SERVER], { cwd: f.root,
    env: { ...f.env, ...(readOnly ? { API_REQUEST_READ_ONLY: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); let buffer = '', stderr = '', next = 1;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const reply = JSON.parse(line), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); clearTimeout(waiter.timer); waiter.resolve(reply); }
    }
  });
  child.on('error', error => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } pending.clear(); });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const close = async () => { child.stdin.end(); child.kill(); await closed; };
  f.clients.push({ close });
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'adapter-fixture', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listing = await request('tools/list');
  const tool = listing.result.tools.find(item => item.name === toolName);
  assert.ok(tool, 'saved requests are discoverable in a fresh MCP process');
  const call = async args => {
    const reply = await request('tools/call', { name: toolName, arguments: args });
    assert.equal(reply.error, undefined);
    const raw = reply.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    return { value: JSON.parse(raw), error: reply.result.isError === true, raw: raw + stderr };
  };
  return { call, tool };
}
const noPrivateOutput = result => {
  for (const value of [secret, 'synthetic-response-secret', 'synthetic-signature']) assert.ok(!result.raw.includes(value), 'private fixture values must not appear in adapter output');
};

for (const channel of ['CLI', 'MCP']) test(`${channel} saved requests support the complete portable lifecycle, named safe refusals and retained history`, async t => {
  const f = await fixture(t), call = channel === 'CLI' ? cliAdapter(f) : (await mcpAdapter(f)).call;
  const created = await call({ action: 'create', document: document() });
  const { ref, document: saved } = created.value;
  assert.equal(ref, 'orders/lookup');
  assert.match(saved.id, /^req-/);
  assert.deepEqual((await call({ action: 'list', stack: 'fixture', environment: 'local', operation: 'GET /orders/{id}' })).value.requests.map(row => row.ref), [ref]);
  const shown = (await call({ action: 'show', ref })).value;
  assert.equal(shown.document.id, saved.id); assert.deepEqual(shown.readiness.inputs.sort(), ['order_id', 'private_note']);
  const edited = structuredClone(saved); edited.request.bindings.query.detail = { $enum: 'full' };
  assert.equal((await call({ action: 'edit', ref, document: edited })).value.document.id, saved.id);
  assert.equal((await call({ action: 'show', ref })).value.document.request.bindings.query.detail.$enum, 'full');
  assert.equal(f.seen.length, 0, 'read/save/edit never send');

  for (const [inputs, code] of [[{ private_note: secret }, 'SAVED_INPUT_MISSING'], [{ private_note: secret, order_id: { secret } }, 'SAVED_INPUT_TYPE']]) {
    const failure = await call({ action: 'run', ref, inputs });
    assert.equal(failure.error, true); assert.equal(failure.value.error.code, code);
    assert.equal(failure.value.error.details.input, 'order_id'); assert.match(failure.value.error.message, /order_id/); noPrivateOutput(failure);
  }
  assert.equal(f.seen.length, 0, 'missing/malformed inputs refuse before traffic');
  const run = await call({ action: 'run', ref, inputs: { order_id: 'synthetic-order', private_note: secret } });
  assert.equal(run.error, false); assert.equal(run.value.status, 200); assert.equal(run.value.assertions, null);
  assert.equal(run.value.saved_request.assertions, 'not_run'); assert.match(run.value.evidence, /^run-/); noPrivateOutput(run);
  assert.deepEqual(f.seen, [{ method: 'GET', path: '/orders/synthetic-order?detail=full', note: secret }]);
  const runId = run.value.evidence;
  const receiptPath = join(f.root, LAYOUT.evidence, 'fixture', `${runId}.json`), receipt = readFileSync(receiptPath, 'utf8');
  assert.ok(!receipt.includes(secret));
  const inspection = await call({ action: 'inspect', runId, stack: 'fixture' });
  assert.equal(inspection.value.status, 200); assert.equal(inspection.value.redacted, true); assert.match(inspection.value.body_text, /ready/); noPrivateOutput(inspection);
  const reopened = await call({ action: 'reopen', runId, stack: 'fixture' });
  assert.equal(reopened.value.document.source.run_id, runId); assert.equal(reopened.value.traffic, 'none');
  assert.ok(reopened.value.missing_inputs.includes('path_id')); assert.ok(reopened.value.withheld.includes('historical authorization')); noPrivateOutput(reopened);
  assert.ok(!JSON.stringify(reopened.value.document).includes('synthetic-order'));

  const renamed = await call({ action: 'rename', ref, folder: 'handoff', name: 'order-quote' });
  assert.equal(renamed.value.ref, 'handoff/order-quote'); assert.equal(renamed.value.document.id, saved.id);
  assert.deepEqual((await call({ action: 'list' })).value.requests.map(row => row.ref), [renamed.value.ref]);
  const deleted = await call({ action: 'delete', ref: renamed.value.ref });
  assert.equal(deleted.value.deleted, true); assert.equal(deleted.value.history, 'retained');
  assert.deepEqual((await call({ action: 'list' })).value.requests, []);
  assert.equal(readFileSync(receiptPath, 'utf8'), receipt, 'rename/delete preserve the exact execution record');
  assert.equal((await call({ action: 'inspect', runId, stack: 'fixture' })).value.run_id, runId);
  assert.equal((await call({ action: 'reopen', runId, stack: 'fixture' })).value.document.source.run_id, runId);
  assert.equal(f.seen.length, 1, 'inspection, reopen, rename and delete do not replay');
});

test('read-only MCP permits discovery and history inspection but refuses every saved mutation and send', async t => {
  const f = await fixture(t), seed = cliAdapter(f);
  const saved = (await seed({ action: 'create', document: document() })).value;
  const run = (await seed({ action: 'run', ref: saved.ref, inputs: { order_id: 'synthetic-order', private_note: secret } })).value;
  const before = readFileSync(join(f.root, saved.path), 'utf8');
  const { call, tool } = await mcpAdapter(f, true);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['list', 'show', 'reopen', 'inspect']);
  assert.equal(tool.annotations.readOnlyHint, true);
  for (const args of [{ action: 'list' }, { action: 'show', ref: saved.ref }, { action: 'reopen', runId: run.evidence, stack: 'fixture' }, { action: 'inspect', runId: run.evidence, stack: 'fixture' }]) {
    const result = await call(args); assert.equal(result.error, false); noPrivateOutput(result);
  }
  for (const args of [
    { action: 'create', document: { ...saved.document, name: 'blocked' } },
    { action: 'edit', ref: saved.ref, document: saved.document },
    { action: 'rename', ref: saved.ref, folder: 'blocked', name: 'blocked' },
    { action: 'delete', ref: saved.ref },
    { action: 'run', ref: saved.ref, inputs: { order_id: 'synthetic-order', private_note: secret } },
  ]) {
    const result = await call(args); assert.equal(result.error, true); assert.equal(result.value.error.code, 'LIBRARIAN_READ_ONLY'); noPrivateOutput(result);
  }
  assert.equal(readFileSync(join(f.root, saved.path), 'utf8'), before);
  assert.deepEqual((await seed({ action: 'list' })).value.requests.map(row => row.ref), [saved.ref]);
  assert.equal(f.seen.length, 1, 'a read-only saved run cannot send even a GET');
});

test('workbench launch requires a real terminal; piped help remains available without a service', async t => {
  const f = await fixture(t);
  const help = await cli(f, ['workbench', '--help']); assert.equal(help.code, 0); assert.match(help.stdout, /pairing/);
  const launch = await cli(f, ['workbench', '--no-open']);
  assert.equal(launch.code, 1); assert.match(launch.stdout + launch.stderr, /WORKBENCH_TERMINAL_REQUIRED/);
  assert.doesNotMatch(launch.stdout + launch.stderr, /http:\/\/127\.0\.0\.1:/); assert.equal(f.seen.length, 0);
});
