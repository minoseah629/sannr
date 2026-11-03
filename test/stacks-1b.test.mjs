// STACKS-1B integration specimens contain synthetic structure only. Legacy
// records are authored as fixtures; migration must not reinterpret them as
// newly executed observations. Only child-process loopback witnesses do I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createMcpSession } from '../lib/mcp-transport.mjs';
import { HOME_ENV_NAME, PRODUCT, TOOL_NAME, MCP_SERVER_KEY, CLI_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { operationIdentity, operationId } from '../lib/operation-context.mjs';
import { discoverMcpRegistrations } from '../lib/mcp-registrations.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = join(packageRoot, 'bin', 'cli.mjs');
// Refusals name this install's command; the CLI here runs from the source checkout.
const SOURCE_CLI_MIGRATE = new RegExp(`node ${cliPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} migrate --dry-run`);
const op = 'GET /users', looseOp = 'GET /downloads';
const secrets = ['synthetic-alpha-token', 'synthetic-beta-token', 'private-evidence-marker', 'synthetic-private-response'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const bytes = path => readFileSync(path, 'utf8');
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const writeJson = (path, value, mode) => { mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', mode === undefined ? undefined : { mode }); };

function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-1b-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: '', NO_COLOR: '1',
    FIXTURE_ALPHA_TOKEN: secrets[0], FIXTURE_BETA_TOKEN: secrets[1] };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env };
}
async function command(f, args, extra = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], { cwd: f.root,
    env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', exit => {
      let value; try { value = JSON.parse(stdout); } catch { /* human receipt */ }
      resolve({ exit, stdout, stderr, value });
    });
  });
}
const passed = r => { assert.equal(r.exit, 0, `${r.stdout}\n${r.stderr}`); return r.value; };
const refused = (r, code) => { assert.notEqual(r.exit, 0, r.stdout); assert.match(`${r.stdout}\n${r.stderr}`, new RegExp(code)); };
const migrate = (f, args = []) => command(f, ['migrate', ...args, '--json']);
const request = (f, path, args = []) => command(f, ['request', 'GET', path, '--expect-status', '200', ...args]);
const folder = (f, name) => join(f.root, LAYOUT.collection, name);
const stack = (f, name) => json(join(folder(f, name), 'stack.json'));
const knowledge = (f, name) => json(join(folder(f, name), 'sannr.json'));
const records = stored => Object.values(stored.api_context?.operations ?? {});

function tree(root, predicate = () => true) {
  const out = {};
  const walk = path => {
    for (const row of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, row.name), key = relative(root, full);
      if (!predicate(key)) continue;
      if (row.isDirectory()) { out[`${key}/`] = 'directory'; walk(full); }
      else out[key] = { mode: statSync(full).mode & 0o777, data: readFileSync(full).toString('base64') };
    }
  };
  walk(root); return out;
}
function sharedText(f) {
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(row => {
    const full = join(path, row.name);
    if (full === join(f.root, LAYOUT.evidence)) return [];
    return row.isDirectory() ? walk(full) : [bytes(full)];
  });
  return walk(join(f.root, LAYOUT.directory)).join('\n');
}
function noPromotedValues(text) { for (const value of secrets) assert.equal(text.includes(value), false, `private fixture value escaped: ${value}`); }
const contract = (title = 'Billing API') => ({ openapi: '3.0.3', info: { title, version: '1' }, paths: {
  '/users': { get: { responses: { '200': { description: 'Synthetic user readiness', content: { 'application/json': {
    schema: { type: 'object', properties: { ready: { type: 'boolean' } } },
  } } } } } },
} });
const entry = note => ({ verified_at: null, contract_digest: null, shape_hash: null, status_codes: [], effect: 'read', fields: {},
  notes: note ? [note] : [], notes_provenance: note ? [{ by: 'fixture-agent', at: '2026-10-06' }] : [],
  notes_superseded: note ? [null] : [] });
function legacy(f, config, { name = 'Billing API', withContract = true, operations, observations = [] } = {}) {
  const contractFile = join(f.root, LAYOUT.config, 'billing.openapi.json');
  if (withContract) writeJson(contractFile, contract());
  writeJson(join(f.root, LAYOUT.marker), { kind: 'repo-api-layout', v: 1, product: PRODUCT, collection: 'stacks' });
  writeJson(join(f.root, LAYOUT.environments), config);
  writeJson(join(f.root, LAYOUT.defaults), { budget: 777 });
  const store = { v: 0, api: { ...(name === undefined ? {} : { name }),
    ...(withContract ? { contract: relative(f.root, contractFile), contract_digest: sha(bytes(contractFile)) } : {}) },
    operations: operations ?? { [op]: entry('Use the declared readiness field.') },
    ...(observations.length ? { api_context: { v: 1, operations: Object.fromEntries(observations.map(row => [operationId(row.identity), row])) } } : {}) };
  writeJson(join(f.root, LAYOUT.context), store);
  return { contractFile, store };
}
function observation(f, label, origin, environment, operation = op, withContract = true) {
  const evidencePath = join(LAYOUT.evidence, `run-${label}.json`), evidence = { runId: `run-${label}`,
    // Run routing uses request.url, not a lookalike provider in other metadata.
    origin: { scope: { provider: 'https://misleading.example.test' } },
    request: { method: 'GET', url: `${origin}${operation.split(' ')[1]}`, headers: { authorization: '[redacted]' } },
    response: { status: 200, body: { value: secrets[2] } } };
  writeJson(join(f.root, evidencePath), evidence, 0o600);
  const identity = operationIdentity({ provider: origin, environment, protocol: 'http', operation,
    endpoint: `${origin}${operation.split(' ')[1]}`, contractDigest: withContract ? sha(JSON.stringify(contract(), null, 2) + '\n') : null });
  return { identity, observations: [{ id: `observation-${label}`, recorded_at: '2026-10-06T12:00:00.000Z',
    observed_at: '2026-10-06T12:00:00.000Z', source: { kind: 'client', tool: 'api_request:http' }, basis: 'observed',
    verification: 'client-observation', outcome: 'success', complete: true, response_status: 200,
    request_shape: { type: 'object', properties: {} }, response_shape: { type: 'object', properties: { value: { type: 'string' } } },
    notes: [], omissions: [], evidence: [{ path: evidencePath, digest: sha(bytes(join(f.root, evidencePath))), locator: '/response' }] }],
    omitted_observations: 0 };
}
async function server(t, label) {
  const child = spawn(process.execPath, [join(packageRoot, 'test/fixtures/stacks-1a-server.mjs'), label],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.connected) child.send({ command: 'stop' }); else child.kill();
    await exited;
  });
  const origin = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('message', row => resolve(row.origin));
    child.once('exit', code => reject(new Error(`Loopback fixture exited before ready (${code})`)));
  });
  let serial = 0;
  return { origin, snapshot: () => new Promise(resolve => {
    const id = ++serial, receive = row => { if (row.id === id) { child.off('message', receive); resolve(row.requests); } };
    child.on('message', receive); child.send({ command: 'snapshot', id });
  }) };
}
async function host(t, f) {
  const session = createMcpSession({ command: process.execPath, args: [join(packageRoot, 'server.mjs')],
    cwd: f.root, env: f.env, timeoutMs: 15000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'migration-fixture', version: '1' } });
  await session.notify('notifications/initialized');
  return { call: async args => {
    const reply = await session.request('tools/call', { name: TOOL_NAME, arguments: args });
    assert.ok(reply.result, JSON.stringify(reply));
    return JSON.parse(reply.result.content.find(row => row.type === 'text').text);
  } };
}
async function motivating(t) {
  const f = project(t), a = await server(t, 'alpha'), b = await server(t, 'beta');
  const c = join(LAYOUT.config, 'billing.openapi.json');
  const captured = [observation(f, 'alpha', a.origin, 'production'), observation(f, 'npm', b.origin, 'npm', looseOp, false),
    observation(f, 'unknown', 'https://unknown.example.test', 'production', 'GET /unattributed', false)];
  const { contractFile } = legacy(f, { v: 1, default: 'production', environments: {
    production: { baseUrl: a.origin, contract: c, auth: 'bearer:FIXTURE_ALPHA_TOKEN', production: true },
    npm: { baseUrl: b.origin, auth: 'bearer:FIXTURE_BETA_TOKEN' },
  } }, { operations: { [op]: entry('Billing readiness is a boolean.'),
    [looseOp]: entry('Billing owns this note according to its text; migration must use declarations instead.') }, observations: captured });
  writeJson(join(f.root, LAYOUT.graphManifest), { v: 1, fixture: 'keep-repo-level' });
  writeJson(join(f.root, LAYOUT.baseline), { v: 1, findings: [] });
  writeJson(join(f.root, LAYOUT.suites, 'fixture.json'), { v: 1, name: 'fixture', steps: [] });
  return { ...f, a, b, contractFile, captured };
}

test('STACKS-1B(a) dry run suggests but never applies a split; explicit migration preserves scoped knowledge and private evidence', async t => {
  const f = await motivating(t), before = tree(f.root), contractBytes = bytes(f.contractFile);
  const repoArtifacts = [LAYOUT.graphManifest, LAYOUT.baseline, join(LAYOUT.suites, 'fixture.json')]
    .map(path => [path, bytes(join(f.root, path))]);
  const preview = await migrate(f, ['--dry-run']);
  const plan = passed(preview);
  assert.equal(plan.dry_run, true);
  assert.match(JSON.stringify(plan), /MIGRATION_SPLIT_SUGGESTED/);
  assert.match(JSON.stringify(plan), /--split npm=npm/);
  assert.deepEqual(tree(f.root), before, 'preview cannot write, move or remove any artifact');
  noPromotedValues(preview.stdout + preview.stderr);
  const result = await migrate(f, ['--split', 'npm=npm']);
  const applied = passed(result);
  assert.ok(applied); noPromotedValues(result.stdout + result.stderr);
  assert.deepEqual(Object.keys(stack(f, 'billing').environments), ['production']);
  assert.deepEqual(Object.keys(stack(f, 'npm').environments), ['npm']);
  assert.deepEqual(stack(f, 'unsorted').environments, {});
  assert.equal(bytes(resolve(folder(f, 'billing'), stack(f, 'billing').contract)), contractBytes);
  assert.equal(stack(f, 'npm').contract, undefined);
  assert.deepEqual(knowledge(f, 'billing').operations[op], entry('Billing readiness is a boolean.'));
  assert.equal(knowledge(f, 'billing').operations[looseOp], undefined);
  assert.ok(knowledge(f, 'unsorted').operations[looseOp], 'unmatched declaration is retained, regardless of API names in prose');
  assert.match(result.stdout, /UNSORTED|UNDECLARED|UNASSIGNED|NO_CONTRACT|OPERATION_UNRESOLVED/);
  for (const [name, label] of [['billing', 'alpha'], ['npm', 'npm'], ['unsorted', 'unknown']]) {
    const migrated = records(knowledge(f, name));
    assert.equal(migrated.length, 1, `${name} receives only its identity-owned observation`);
    assert.equal(migrated[0].identity.stack, name);
    assert.equal(migrated[0].observations[0].id, `observation-${label}`);
    assert.equal(migrated[0].observations[0].observed_at, '2026-10-06T12:00:00.000Z');
    assert.equal(migrated[0].observations[0].verification, 'client-observation');
    const ref = migrated[0].observations[0].evidence[0];
    assert.equal(ref.path, join(LAYOUT.evidence, name, `run-${label}.json`));
    assert.equal(bytes(join(f.root, ref.path)), Buffer.from(before[join(LAYOUT.evidence, `run-${label}.json`)].data, 'base64').toString());
    assert.equal(statSync(join(f.root, ref.path)).mode & 0o777, 0o600);
    assert.equal(existsSync(join(f.root, LAYOUT.evidence, `run-${label}.json`)), false);
  }
  assert.equal(existsSync(join(f.root, LAYOUT.config)), false, 'retired config is removed only after its artifacts move');
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false);
  assert.equal(json(join(f.root, LAYOUT.directory, 'defaults.json')).budget, 777);
  for (const [path, body] of repoArtifacts) assert.equal(bytes(join(f.root, path)), body);
  noPromotedValues(sharedText(f));
  assert.deepEqual(await f.a.snapshot(), []); assert.deepEqual(await f.b.snapshot(), []);
  const stable = tree(f.root); passed(await migrate(f)); assert.deepEqual(tree(f.root), stable, 'a second apply changes no bytes or modes');
  const old = knowledge(f, 'unsorted').operations[looseOp];
  passed(await command(f, ['stack', 'move', '--to', 'npm', looseOp, '--json']));
  assert.equal(knowledge(f, 'unsorted').operations[looseOp], undefined);
  assert.deepEqual(knowledge(f, 'npm').operations[looseOp], old);
  const shown = passed(await command(f, ['show', looseOp, '--stack', 'npm']));
  assert.deepEqual(shown.notes, old.notes);
  noPromotedValues(sharedText(f));
});

test('STACKS-1B(a) different origins are not split without an explicit split flag', async t => {
  const f = await motivating(t);
  passed(await migrate(f, ['--dry-run'])); passed(await migrate(f));
  assert.deepEqual(Object.keys(stack(f, 'billing').environments).sort(), ['npm', 'production']);
  assert.equal(existsSync(join(folder(f, 'npm'), 'stack.json')), false);
  assert.equal(records(knowledge(f, 'billing')).length, 2);
});

test('STACKS-1B(b) dev, staging and production with one contract become one stack with three environments', async t => {
  const f = project(t), c = join(LAYOUT.config, 'billing.openapi.json');
  const config = { v: 1, default: 'production', environments: Object.fromEntries(['dev', 'staging', 'production'].map(name => [name,
    { baseUrl: `https://${name}.example.test`, contract: c, auth: 'bearer:FIXTURE_ALPHA_TOKEN', production: name === 'production' }])) };
  const { contractFile } = legacy(f, config), expected = bytes(contractFile);
  passed(await migrate(f, ['--dry-run'])); passed(await migrate(f));
  const doc = stack(f, 'billing');
  assert.deepEqual(Object.keys(doc.environments).sort(), ['dev', 'production', 'staging']);
  assert.equal(doc.default_environment, 'production');
  assert.equal(doc.environments.production.production, true);
  for (const environment of Object.values(doc.environments)) {
    assert.equal(environment.auth, 'bearer:FIXTURE_ALPHA_TOKEN');
    assert.equal(bytes(resolve(folder(f, 'billing'), environment.contract ?? doc.contract)), expected);
  }
  assert.deepEqual(readdirSync(join(f.root, LAYOUT.collection)).filter(name => existsSync(join(folder(f, name), 'stack.json'))), ['billing']);
  noPromotedValues(sharedText(f));
});

test('STACKS-1B(c) top-level and environment-scoped hosts become named stacks with their original environment identities', async t => {
  const f = project(t), c = join(LAYOUT.config, 'billing.openapi.json');
  const config = { v: 1, default: 'production', environments: {
    production: { baseUrl: 'https://primary.example.test', contract: c, hosts: {
      identity: { baseUrl: 'https://identity.example.test', auth: 'bearer:FIXTURE_BETA_TOKEN', contract: c } } },
    staging: { baseUrl: 'https://primary-stage.example.test', contract: c, hosts: {
      identity: { baseUrl: 'https://identity-stage.example.test', auth: 'bearer:FIXTURE_BETA_TOKEN', contract: c } } },
  }, hosts: { ledger: { baseUrl: 'https://ledger.example.test', auth: 'bearer:FIXTURE_ALPHA_TOKEN', contract: c } } };
  legacy(f, config);
  passed(await migrate(f, ['--dry-run'])); passed(await migrate(f));
  assert.deepEqual(Object.keys(stack(f, 'ledger').environments), ['default']);
  assert.deepEqual(Object.keys(stack(f, 'identity').environments).sort(), ['production', 'staging']);
  assert.equal(stack(f, 'identity').environments.staging.baseUrl, 'https://identity-stage.example.test');
  assert.equal(stack(f, 'ledger').environments.default.auth, 'bearer:FIXTURE_ALPHA_TOKEN');
  for (const environment of Object.values(stack(f, 'identity').environments))
    assert.equal(environment.auth, 'bearer:FIXTURE_BETA_TOKEN');
  const contractPaths = new Set();
  for (const name of ['billing', 'ledger', 'identity']) {
    const doc = stack(f, name), contractPath = doc.contract ?? Object.values(doc.environments)[0].contract;
    const absolute = resolve(folder(f, name), contractPath);
    contractPaths.add(absolute);
    assert.deepEqual(json(absolute), contract());
  }
  assert.equal(contractPaths.size, 3, 'the primary and both upstream stacks own separate contract files');
  noPromotedValues(sharedText(f));
});

test('STACKS-1B(d) legacy CLI and MCP requests execute but skip capture; note refuses while show, map and view remain readable', async t => {
  const f = project(t), a = await server(t, 'alpha'), c = join(LAYOUT.config, 'billing.openapi.json');
  legacy(f, { v: 1, default: 'local', environments: { local: { baseUrl: a.origin,
    auth: 'bearer:FIXTURE_ALPHA_TOKEN', contract: c } } });
  const before = bytes(join(f.root, LAYOUT.context)), initial = await request(f, '/users');
  const result = passed(initial);
  assert.equal(result.ok, true, initial.stdout); assert.equal((await a.snapshot()).length, 1);
  assert.equal((await a.snapshot())[0].authorization, `Bearer ${secrets[0]}`);
  assert.match(JSON.stringify(result.context_capture), /STACKS_MIGRATION_REQUIRED/);
  assert.match(JSON.stringify(result.context_capture), SOURCE_CLI_MIGRATE);
  assert.equal(bytes(join(f.root, LAYOUT.context)), before);
  const mcp = await host(t, f), remote = await mcp.call({ method: 'GET', path: '/users', expect: [{ status: 200 }] });
  assert.equal(remote.ok, true, JSON.stringify(remote));
  assert.match(JSON.stringify(remote.context_capture), /STACKS_MIGRATION_REQUIRED/);
  assert.equal((await a.snapshot()).length, 2);
  assert.equal(bytes(join(f.root, LAYOUT.context)), before);
  const note = await command(f, ['note', op, 'This new note must wait for migration.']);
  refused(note, 'STACKS_MIGRATION_REQUIRED'); assert.match(note.stdout + note.stderr, SOURCE_CLI_MIGRATE);
  assert.equal(bytes(join(f.root, LAYOUT.context)), before);
  assert.deepEqual(passed(await command(f, ['show', op])).notes, ['Use the declared readiness field.']);
  passed(await command(f, ['map', '.', '--json', '--no-execute']));
  passed(await command(f, ['view', '--json']));
  assert.equal(bytes(join(f.root, LAYOUT.context)), before);
  assert.equal((await a.snapshot()).length, 2, 'legacy read surfaces execute no additional API calls');
});

test('STACKS-1B(d) legacy authored notes independently refuse with the exact dry-run recovery command', async t => {
  const f = project(t), c = join(LAYOUT.config, 'billing.openapi.json');
  legacy(f, { v: 1, default: 'local', environments: { local: { baseUrl: 'https://billing.example.test', contract: c } } });
  const before = bytes(join(f.root, LAYOUT.context));
  const result = await command(f, ['note', op, 'This new note must wait for migration.']);
  refused(result, 'STACKS_MIGRATION_REQUIRED');
  assert.match(result.stdout + result.stderr, SOURCE_CLI_MIGRATE);
  assert.equal(bytes(join(f.root, LAYOUT.context)), before);
});

test('STACKS-1B(d) a fresh stdio MCP host independently runs the legacy request but names skipped capture', async t => {
  const f = project(t), a = await server(t, 'alpha'), c = join(LAYOUT.config, 'billing.openapi.json');
  legacy(f, { v: 1, default: 'local', environments: { local: { baseUrl: a.origin,
    auth: 'bearer:FIXTURE_ALPHA_TOKEN', contract: c } } });
  const before = bytes(join(f.root, LAYOUT.context)), mcp = await host(t, f);
  const result = await mcp.call({ method: 'GET', path: '/users', expect: [{ status: 200 }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(JSON.stringify(result.context_capture), /STACKS_MIGRATION_REQUIRED/);
  assert.match(JSON.stringify(result.context_capture), new RegExp(`${CLI_NAME} migrate --dry-run`));
  assert.equal(bytes(join(f.root, LAYOUT.context)), before);
  const calls = await a.snapshot();
  assert.equal(calls.length, 1); assert.equal(calls[0].authorization, `Bearer ${secrets[0]}`);
});

test('STACKS-1B(e) reconnect after migration carries no API environment, contract or config pins and capture resumes', async t => {
  const f = project(t), a = await server(t, 'alpha'), c = join(LAYOUT.config, 'billing.openapi.json');
  legacy(f, { v: 1, default: 'local', environments: { local: { baseUrl: a.origin,
    auth: 'bearer:FIXTURE_ALPHA_TOKEN', contract: c } } });
  passed(await migrate(f, ['--dry-run'])); passed(await migrate(f));
  passed(await command(f, ['connect', '--json']));
  const registrations = discoverMcpRegistrations(f.root);
  assert.deepEqual(registrations.map(row => row.host).sort(), ['claude-code', 'codex']);
  for (const row of registrations) {
    assert.equal(row.key, MCP_SERVER_KEY);
    for (const key of ['API_ENV', 'API_CONFIG', 'API_CONTRACT']) assert.equal(row.env[key], undefined, `${row.host} registration still pins ${key}`);
  }
  assert.deepEqual(await a.snapshot(), [], 'migration and reconnect execute no requests');
  const result = passed(await request(f, '/users', ['--stack', 'billing']));
  assert.equal(result.ok, true); assert.equal(result.context_capture?.state, 'captured', JSON.stringify(result));
  assert.equal(records(knowledge(f, 'billing')).length, 1);
  const migratedRecord = records(knowledge(f, 'billing'))[0];
  assert.equal(migratedRecord.identity.stack, 'billing');
  assert.ok(migratedRecord.observations[0].evidence.every(ref => ref.path.startsWith(`${LAYOUT.evidence}/billing/`)));
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false);
});

test('STACKS-1B migration conflicts preserve source, existing destination and private evidence before any writes', async t => {
  const f = project(t), c = join(LAYOUT.config, 'billing.openapi.json');
  legacy(f, { v: 1, default: 'local', environments: { local: { baseUrl: 'https://billing.example.test', contract: c } } });
  writeJson(join(folder(f, 'billing'), 'stack.json'), { v: 1, name: 'billing', title: 'Authored destination', environments: {} });
  const before = tree(f.root), result = await migrate(f, ['--dry-run']);
  refused(result, 'MIGRATION_CONFLICT|STACKS_MIGRATION_CONFLICT|STACK_CONFLICT');
  assert.match(result.stdout + result.stderr, /billing/);
  assert.deepEqual(tree(f.root), before);
  refused(await migrate(f), 'MIGRATION_CONFLICT|STACKS_MIGRATION_CONFLICT|STACK_CONFLICT');
  assert.deepEqual(tree(f.root), before);
});
