import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createMcpSession } from '../lib/mcp-transport.mjs';
import { HOME_ENV_NAME, TOOL_NAME } from '../lib/brand.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { buildApiMapModel } from '../lib/api-map.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const op = 'GET /users';
const notes = { alpha: 'Alpha requires an explicit date range.', beta: 'Beta excludes archived records.' };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
};

async function fixture(t, { mounted = true, contractlessBeta = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-2-request-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'),
    API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  mkdirSync(env.HOME, { recursive: true });
  const servers = {};
  for (const name of ['alpha', 'beta']) {
    // A separate async-spawned process is the wire witness, so CLI commands
    // cannot starve its event loop. All response values are synthetic.
    const child = spawn(process.execPath, [join(packageRoot, 'test/fixtures/stacks-1a-server.mjs'), name],
      { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(async () => {
      if (child.exitCode !== null) return;
      const closed = new Promise(resolve => child.once('exit', resolve));
      if (child.connected) child.send({ command: 'stop' }); else child.kill();
      await closed;
    });
    const origin = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('message', value => resolve(value.origin));
      child.once('exit', code => reject(new Error(`Fixture stopped before readiness (${code})`)));
    });
    const baseUrl = `${origin}${mounted ? `/${name}/v2` : ''}`;
    const contract = `${name}.openapi.json`;
    writeJson(join(root, contract), { openapi: '3.0.3', info: { title: `${name} API`, version: '1' },
      paths: { '/users': { get: { responses: { '200': { description: 'Synthetic response' } } } } } });
    const hasContract = !(name === 'beta' && contractlessBeta);
    createFixtureStack(root, { name, baseUrl, ...(hasContract ? { contract } : {}) });
    writeJson(fixtureContextFile(root, name), { v: 0, api: { name: `${name} API`,
      ...(hasContract ? { contract: `.sannr/stacks/${name}/${contract}` } : {}) }, operations: {
      [op]: { verified_at: null, contract_digest: null, shape_hash: null, status_codes: [], effect: 'read', fields: {},
        notes: [notes[name]], notes_provenance: [{ by: 'fixture-author', at: '2026-10-07' }] },
    } });
    servers[name] = { origin, baseUrl, snapshot: () => new Promise(resolve => {
      const id = `snapshot-${name}`;
      const receive = value => { if (value.id === id) { child.off('message', receive); resolve(value.requests); } };
      child.on('message', receive); child.send({ command: 'snapshot', id });
    }) };
  }
  return { root, env, servers };
}

async function command(f, args) {
  const child = spawn(process.execPath, [join(packageRoot, 'bin/cli.mjs'), ...args],
    { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', exit => {
      let value; try { value = JSON.parse(stdout); } catch { /* Refusals may use terminal text. */ }
      resolve({ exit, stdout, stderr, value });
    });
  });
}
const passed = result => {
  assert.equal(result.exit, 0, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.value, result.stdout);
  return result.value;
};
const request = (f, path, args = []) => command(f, ['request', 'GET', path, '--expect-status', '200', ...args]);
function ownNotes(result, name, expected = notes[name]) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.stack, name);
  assert.deepEqual(result.known?.notes, [expected], `${name} must receive only its own saved notes`);
  assert.ok(!JSON.stringify(result.known).includes(notes[name === 'alpha' ? 'beta' : 'alpha']));
}

test('STACKS-2(a) resolved mounted stack B receives B notes for relative and absolute requests', async t => {
  const f = await fixture(t);
  for (const [path, options] of [
    ['/users', ['--stack', 'beta']],
    [`${f.servers.beta.baseUrl}/users`, []],
  ]) ownNotes(passed(await request(f, path, options)), 'beta');
  ownNotes(passed(await request(f, '/users', ['--stack', 'alpha'])), 'alpha');
});

test('STACKS-2(a) MCP requests retain each stack notes and read updates without restarting', async t => {
  const f = await fixture(t);
  const session = createMcpSession({ command: process.execPath, args: [join(packageRoot, 'server.mjs')],
    cwd: f.root, env: f.env, timeoutMs: 15_000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'stack-notes-fixture', version: '1' } });
  await session.notify('notifications/initialized');
  const call = async (stack, routing = { stack }) => {
    const reply = await session.request('tools/call', { name: TOOL_NAME,
      arguments: { method: 'GET', path: '/users', ...routing, expect: [{ status: 200 }] } });
    assert.ok(reply.result, JSON.stringify(reply));
    return JSON.parse(reply.result.content.find(block => block.type === 'text').text);
  };
  const names = ['alpha', 'beta', 'beta', 'alpha'];
  const results = [];
  for (const name of names) results.push(await call(name));
  results.forEach((result, i) => ownNotes(result, names[i]));
  const next = 'Beta excludes archived records and uses a cursor.';
  const file = fixtureContextFile(f.root, 'beta'), saved = json(file);
  saved.operations[op].notes = [next];
  writeJson(file, saved);
  ownNotes(await call('beta'), 'beta', next);
  ownNotes(await call('beta', { upstream: 'beta' }), 'beta', next);
  ownNotes(await call('alpha'), 'alpha');
});

test('STACKS-2(a) concurrent dispatches retain independent stack note readers', async t => {
  const f = await fixture(t);
  const script = `const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    const results = await Promise.all(['beta', 'alpha', 'beta', 'alpha'].map(stack =>
      apiRequest({ method: 'GET', path: '/users', stack, expect: [{ status: 200 }] })));
    process.stdout.write(JSON.stringify(results));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script],
    { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', value => stdout += value);
  child.stderr.on('data', value => stderr += value);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  JSON.parse(stdout).forEach((result, i) => ownNotes(result, i % 2 ? 'alpha' : 'beta'));
});

test('STACKS-2(a) contractless stack notes still deliver without borrowing the default stack', async t => {
  const f = await fixture(t, { mounted: false, contractlessBeta: true });
  writeJson(join(f.root, '.sannr/defaults.json'), { default_stack: 'alpha' });
  ownNotes(passed(await request(f, '/users', ['--stack', 'beta'])), 'beta');
  ownNotes(passed(await request(f, `${f.servers.beta.baseUrl}/users`)), 'beta');
  ownNotes(passed(await request(f, '/users')), 'alpha');
});

test('STACKS-2(a) contractless mounted stack delivers notes relative to its configured base path', async t => {
  const f = await fixture(t, { contractlessBeta: true });
  const relative = passed(await request(f, '/users', ['--stack', 'beta']));
  ownNotes(relative, 'beta');
  assert.notEqual(relative.context_capture.state, 'captured', 'Authored notes do not imply contractless capture.');
  ownNotes(passed(await request(f, `${f.servers.beta.baseUrl}/users`)), 'beta');
  const outside = await request(f, `${f.servers.beta.origin}/beta/v20/users`, ['--stack', 'beta']);
  assert.notEqual(outside.exit, 0, 'A similar textual prefix outside the configured base path is refused.');
  assert.equal(outside.value?.known?.notes, undefined);
});

test('STACKS-2(a) an ambiguous declared route cannot use the contractless note fallback', async t => {
  const f = await fixture(t), file = join(f.root, '.sannr/stacks/beta/beta.openapi.json');
  const contract = json(file);
  contract.paths = { '/{first}': { get: {} }, '/{second}': { get: {} } };
  writeJson(file, contract);
  const result = passed(await request(f, '/users', ['--stack', 'beta']));
  assert.equal(result.ok, true);
  assert.equal(result.known?.notes, undefined);
  assert.equal(result.context_capture.code, 'HTTP_CONTEXT_ROUTE_UNRESOLVED');
  assert.equal(result.context_capture.reason, 'ambiguous-match');
});

test('STACKS-2 scoped show and context query keep identical operation keys separate', async t => {
  const f = await fixture(t), query = join(f.root, 'query.json');
  writeJson(query, { operation: op });
  for (const name of ['alpha', 'beta']) {
    passed(await request(f, '/users', ['--stack', name]));
    const shown = passed(await command(f, ['show', op, '--stack', name]));
    assert.deepEqual(shown.notes, [notes[name]]);
    assert.deepEqual(shown.scoped.operations.map(row => row.identity.stack), [name]);
    const context = passed(await command(f, ['context', 'query', query, '--stack', name]));
    assert.deepEqual(context.operations.map(row => row.identity.stack), [name]);
    assert.equal(context.operations[0].observations.length, 1);
  }
  assert.notEqual((await command(f, ['show', op])).exit, 0, 'No implicit stack is selected from two candidates.');
  assert.notEqual((await command(f, ['context', 'query', query])).exit, 0);
  writeJson(join(f.root, '.sannr/defaults.json'), { default_stack: 'beta' });
  assert.deepEqual(passed(await command(f, ['show', op])).notes, [notes.beta]);
  assert.deepEqual(passed(await command(f, ['context', 'query', query])).operations.map(row => row.identity.stack), ['beta']);
});

test('STACKS-2 omission recovery: the exact scoped show command lists notes, observations and contract-only operations', async t => {
  const f = await fixture(t);
  for (const name of ['alpha', 'beta']) passed(await request(f, '/users', ['--stack', name]));
  const alphaPath = fixtureContextFile(f.root, 'alpha'), alpha = json(alphaPath);
  const record = Object.values(alpha.api_context.operations)[0];
  // An authored fixture may cite the same response, but cannot claim the
  // client's internally derived contradiction comparisons.
  const { note_contradictions: _clientComparisons, ...response } = record.observations[0];
  record.observations.push({ ...response, id: 'authored-fixture-lesson', basis: 'authored',
    source: { kind: 'external', tool: 'fixture-author' }, verification: 'external-claim',
    notes: ['An inherited alpha lesson beyond the inline cap.'] });
  writeJson(alphaPath, alpha);
  const betaPath = fixtureContextFile(f.root, 'beta'), beta = json(betaPath);
  beta.operations = {}; writeJson(betaPath, beta);
  for (const name of ['alpha', 'beta']) {
    const result = passed(await command(f, ['show', '--stack', name]));
    assert.equal(result.stack, name);
    assert.equal(result.operations.length, 1);
    assert.equal(result.operations[0].op, op);
    assert.deepEqual(result.operations[0].active_notes, name === 'alpha' ? [notes.alpha] : []);
    assert.deepEqual(result.scoped.operations.map(row => row.identity.stack), [name]);
    assert.ok(result.scoped.operations[0].observations.some(row => row.verification === 'client-observation'));
    if (name === 'alpha') assert.match(JSON.stringify(result.scoped), /An inherited alpha lesson/);
    const index = buildApiMapModel(f.root, { env: f.env }).stack_index.find(row => row.name === name);
    for (const key of ['operations', 'observed', 'responses', 'notes']) assert.equal(result.counts[key], index[key], key);
    const human = await command(f, ['show', '--stack', name, '--human']);
    assert.equal(human.exit, 0, human.stdout + human.stderr);
    assert.ok(human.stdout.includes(op));
    if (name === 'alpha') assert.match(human.stdout, /An inherited alpha lesson/);
  }
  rmSync(alphaPath);
  const declared = passed(await command(f, ['show', '--stack', 'alpha']));
  assert.deepEqual(declared.counts, { operations: 1,
    evidence_classes: { written: 1, observed: 0, asserted: 0, verified: 0 },
    observed: 0, responses: 0, notes: 0 });
  assert.equal(declared.operations[0].in_contract, true);
  assert.equal(declared.operations[0].in_store, false);
  const declaredIndex = buildApiMapModel(f.root, { env: f.env }).stack_index.find(row => row.name === 'alpha');
  for (const key of ['operations', 'observed', 'responses', 'notes']) assert.equal(declared.counts[key], declaredIndex[key], key);
  // Legacy bare show still requires an operation; this is scoped discovery.
  const legacy = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-2-legacy-show-')));
  t.after(() => rmSync(legacy, { recursive: true, force: true }));
  const missing = await command({ root: legacy, env: { ...f.env, API_CONTEXT_DIR: legacy } }, ['show']);
  assert.notEqual(missing.exit, 0);
  assert.match(missing.stdout + missing.stderr, /OPERATION_REQUIRED/);
});

test('STACKS-2 setup replay remains repo-level in a two-stack repo with no default and sends no requests', async t => {
  const f = await fixture(t);
  const result = await command(f, ['context', 'query', '--onboarding', '--human']);
  assert.equal(result.exit, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /STACK_REQUIRED/);
  assert.deepEqual(await f.servers.alpha.snapshot(), []);
  assert.deepEqual(await f.servers.beta.snapshot(), []);
});


test('Requests receive only their operation code locations, capped and disabled with context', async t => {
  const f = await fixture(t);
  // Older init attribution could save a pure URL helper as the operation's
  // source. Keep that provenance in the store, but current calls guide agents.
  writeFileSync(join(f.root, 'old-url-helper.mjs'), 'export const url = path => "https://example.test" + path;\n');
  const stored = json(fixtureContextFile(f.root, 'beta'));
  stored.operations[op].source_file = 'old-url-helper.mjs';
  writeJson(fixtureContextFile(f.root, 'beta'), stored);
  for (const name of ['alpha', 'beta']) for (let n = 0; n < 7; n++)
    writeFileSync(join(f.root, `consumer-${name}-${n}.mjs`),
      `const BASE = ${JSON.stringify(f.servers[name].baseUrl)};\nfetch(\`\${BASE}/users\`);\n`);
  const session = createMcpSession({ command: process.execPath, args: [join(packageRoot, 'server.mjs')],
    cwd: f.root, env: f.env, timeoutMs: 15_000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'code-location-fixture', version: '1' } });
  await session.notify('notifications/initialized');
  const call = async path => {
    const reply = await session.request('tools/call', { name: TOOL_NAME,
      arguments: { method: 'GET', path, stack: 'beta', expect: [{ status: 200 }] } });
    return JSON.parse(reply.result.content.find(block => block.type === 'text').text);
  };
  const result = await call('/users');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.known.code.called_from, Array.from({ length: 5 }, (_, n) => `consumer-beta-${n}.mjs:2`));
  assert.equal(result.known.code.omitted, 2);
  assert.equal(result.known.code.remembered, undefined);
  assert.equal(json(fixtureContextFile(f.root, 'beta')).operations[op].source_file, 'old-url-helper.mjs');
  assert.equal(JSON.stringify(result.known.code).includes('consumer-alpha'), false);
  t.diagnostic(`known.code: ${Buffer.byteLength(JSON.stringify(result.known.code))} UTF-8 bytes; complete envelope: ${Buffer.byteLength(JSON.stringify(result))} UTF-8 bytes`);
  assert.equal((await call('/unrelated')).known?.code, undefined);
  for (let n = 0; n < 7; n++) rmSync(join(f.root, `consumer-beta-${n}.mjs`));
  assert.deepEqual((await call('/users')).known.code.remembered, ['old-url-helper.mjs'],
    'the same MCP process notices removal and retains the honest historical fallback');
  writeFileSync(join(f.root, 'new-beta-call.mjs'), `fetch(${JSON.stringify(`${f.servers.beta.baseUrl}/users`)});\n`);
  const refreshed = await call('/users');
  assert.deepEqual(refreshed.known.code.called_from, ['new-beta-call.mjs:1']);
  assert.equal(refreshed.known.code.remembered, undefined);
  const off = passed(await request({ ...f, env: { ...f.env, API_CONTEXT_OFF: '1' } }, '/users', ['--stack', 'beta']));
  assert.equal(off.known, null);
  const bounded = passed(await request({ ...f, env: { ...f.env, API_BUDGET: '500' } }, '/users', ['--stack', 'beta']));
  assert.ok(Math.ceil(JSON.stringify(bounded).length / 4) <= 500 || bounded.budget_min);
  if (!bounded.known?.code) assert.ok(bounded.known?.withheld?.code || bounded.known?.withheld?.known);
});

test('A refused request still respects its output budget after credential masking expands code locations', async t => {
  const f = await fixture(t);
  const stackPath = join(f.root, '.sannr/stacks/beta/stack.json');
  const stack = json(stackPath);
  stack.environments.local.auth = 'bearer:CODE1_FIXTURE_SECRET';
  writeJson(stackPath, stack);
  // A short synthetic secret exercises expansion by the existing scrubber.
  // The literal request credential is refused locally, before any API traffic.
  const env = { ...f.env, API_BUDGET: '500', CODE1_FIXTURE_SECRET: 'a' };
  for (let n = 0; n < 5; n++) writeFileSync(join(f.root, `${'a'.repeat(60)}-${n}.mjs`),
    `const BASE = ${JSON.stringify(f.servers.beta.baseUrl)};\nfetch(\`\${BASE}/users\`);\n`);
  const session = createMcpSession({ command: process.execPath, args: [join(packageRoot, 'server.mjs')],
    cwd: f.root, env, timeoutMs: 15_000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'code-location-refusal-fixture', version: '1' } });
  await session.notify('notifications/initialized');
  const reply = await session.request('tools/call', { name: TOOL_NAME, arguments: {
    stack: 'beta', method: 'GET', path: '/users', headers: { authorization: 'Bearer synthetic-fixture-credential' },
  } });
  const result = JSON.parse(reply.result.content.find(block => block.type === 'text').text);
  assert.equal(result.error.code, 'CREDENTIAL_IN_REQUEST');
  assert.deepEqual(await f.servers.alpha.snapshot(), []);
  assert.deepEqual(await f.servers.beta.snapshot(), []);
  assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 500 || result.budget_min,
    'A refusal must trim expanded code context or name the minimum-envelope exception.');
});
