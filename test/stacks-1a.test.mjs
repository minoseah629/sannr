import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createMcpSession } from '../lib/mcp-transport.mjs';
import { HOME_ENV_NAME, TOOL_NAME, MCP_SERVER_KEY, POINTER_BEGIN } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { discoverMcpRegistrations } from '../lib/mcp-registrations.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = join(packageRoot, 'bin', 'cli.mjs');
const op = 'GET /users';
const keys = { FIXTURE_ALPHA_KEY: 'synthetic-alpha-key', FIXTURE_BETA_KEY: 'synthetic-beta-key' };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };

function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-1a-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), NO_COLOR: '1', ...keys };
  mkdirSync(env.HOME, { recursive: true });
  return { root, env };
}

async function command(f, args, extra = {}) {
  const p = spawn(process.execPath, [cliPath, ...args], { cwd: f.root,
    env: { ...f.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  p.stdout.on('data', data => stdout += data); p.stderr.on('data', data => stderr += data);
  return await new Promise((resolve, reject) => {
    p.once('error', reject); p.once('close', exit => {
      let value; try { value = JSON.parse(stdout); } catch { /* command may report text */ }
      resolve({ exit, stdout, stderr, value });
    });
  });
}
const passed = r => { assert.equal(r.exit, 0, `${r.stdout}\n${r.stderr}`); assert.ok(r.value, r.stdout); return r.value; };
const refused = (r, code) => { assert.notEqual(r.exit, 0, r.stdout); assert.match(`${r.stdout}\n${r.stderr}`, new RegExp(code)); };
const request = (f, path, args = []) => command(f, ['request', 'GET', path, '--expect-status', '200', ...args]);

async function server(t, label) {
  const p = spawn(process.execPath, [join(packageRoot, 'test', 'fixtures', 'stacks-1a-server.mjs'), label],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => {
    if (p.exitCode !== null) return;
    const exited = new Promise(resolve => p.once('exit', resolve));
    if (p.connected) p.send({ command: 'stop' }); else p.kill();
    await exited;
  });
  const origin = await new Promise((resolve, reject) => {
    p.once('error', reject); p.once('message', data => resolve(data.origin));
    p.once('exit', code => reject(new Error(`Loopback fixture exited before ready (${code})`)));
  });
  let serial = 0;
  return { origin, snapshot: () => new Promise(resolve => {
    const id = ++serial;
    const receive = data => { if (data.id === id) { p.off('message', receive); resolve(data.requests); } };
    p.on('message', receive); p.send({ command: 'snapshot', id });
  }) };
}

const contract = title => ({ openapi: '3.0.3', info: { title, version: '1' }, paths: {
  '/users': { get: { responses: { '200': { description: 'Synthetic users', content: { 'application/json': {
    schema: { type: 'object', properties: { ready: { type: 'boolean' } } },
  } } } } } },
} });

function stack(f, name, origin, { withContract = true, prefix = '', authKey,
  environments = {} } = {}) {
  const folder = join(f.root, '.sannr', 'stacks', name);
  const doc = { v: 1, name, title: `${name} API`, default_environment: 'local',
    ...(withContract ? { contract: 'openapi.json' } : {}), environments: {
      local: { baseUrl: origin + prefix, auth: `bearer:${authKey ?? (name === 'alpha' ? 'FIXTURE_ALPHA_KEY' : 'FIXTURE_BETA_KEY')}`,
        headers: { 'X-Fixture-Stack': name }, ...(prefix ? { contractPathPrefix: prefix } : {}) }, ...environments,
    } };
  writeJson(join(folder, 'stack.json'), doc);
  if (withContract) {
    writeJson(join(folder, 'openapi.json'), contract(`${name} API`));
    const bytes = readFileSync(join(folder, 'openapi.json'));
    writeJson(join(folder, 'sannr.json'), { v: 0, api: { name: `${name} API`, contract: relative(f.root, join(folder, 'openapi.json')),
      contract_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }, operations: {
      [op]: { verified_at: null, contract_digest: null, shape_hash: null, status_codes: [], effect: 'read', fields: {}, notes: [] },
    } });
  }
  return { folder, doc };
}

async function pair(t, options = {}) {
  const f = project(t), a = await server(t, 'alpha'), b = await server(t, 'beta');
  stack(f, 'alpha', a.origin, options.alpha); stack(f, 'beta', b.origin, options.beta);
  return { ...f, a, b };
}

async function mcp(t, f) {
  const session = createMcpSession({ command: process.execPath, args: [join(packageRoot, 'server.mjs')],
    cwd: f.root, env: f.env, timeoutMs: 15_000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stacks-fixture', version: '1' } });
  await session.notify('notifications/initialized');
  return { session, call: async args => {
    const reply = await session.request('tools/call', { name: TOOL_NAME, arguments: args });
    assert.ok(reply.result, JSON.stringify(reply));
    return JSON.parse(reply.result.content.find(block => block.type === 'text').text);
  } };
}

test('STACKS-1A creation: stack add creates portable config, copied contract and a truthful list', async t => {
  const f = project(t), c = join(f.root, 'source.openapi.json');
  writeJson(c, contract('Alpha API'));
  passed(await command(f, ['stack', 'add', 'alpha', '--base-url', 'https://alpha.example.test/v1',
    '--auth', 'bearer:FIXTURE_ALPHA_KEY', '--contract', c, '--env', 'local', '--json']));
  const folder = join(f.root, '.sannr', 'stacks', 'alpha'), doc = json(join(folder, 'stack.json'));
  assert.equal(doc.v, 1); assert.equal(doc.name, 'alpha'); assert.equal(doc.default_environment, 'local');
  assert.equal(doc.environments.local.auth, 'bearer:FIXTURE_ALPHA_KEY');
  assert.ok(doc.contract && !doc.contract.startsWith('/'));
  assert.deepEqual(json(resolve(folder, doc.contract)), contract('Alpha API'));
  const inventory = passed(await command(f, ['stacks', '--json'])).stacks;
  // Feedback is a packaged read-only stack, never the repository's default.
  const listed = inventory.filter(row => row.name !== 'sannr-feedback');
  assert.equal(inventory.filter(row => row.name === 'sannr-feedback').length, 1);
  assert.equal(listed.length, 1); assert.equal(listed[0].name, 'alpha');
  assert.deepEqual(listed[0].environments, ['local']);
  assert.ok(listed[0].contract && listed[0].counts);
  assert.equal(existsSync(join(f.root, LAYOUT.environments)), false, 'new stacks do not create the retired API config');
  const before = readFileSync(join(folder, 'stack.json'), 'utf8');
  refused(await command(f, ['stack', 'add', 'alpha', '--base-url', 'https://changed.example.test', '--json']), 'STACK');
  assert.equal(readFileSync(join(folder, 'stack.json'), 'utf8'), before, 'duplicate names cannot replace an integration');
});

test('STACKS-1A creation: fresh init and start create a first stack from title or explicit name', async t => {
  for (const [verb, requested, expected] of [['init', null, 'invoice-service'], ['start', 'billing', 'billing']]) {
    const f = project(t), c = join(f.root, 'source.openapi.json');
    writeJson(c, contract('Invoice Service API'));
    passed(await command(f, [verb, '--contract', c, ...(requested ? ['--stack', requested] : []), ...(verb === 'start' ? ['--json'] : [])]));
    const folder = join(f.root, '.sannr', 'stacks', expected);
    assert.equal(json(join(folder, 'stack.json')).name, expected);
    assert.ok(json(join(folder, 'sannr.json')).operations[op]);
    assert.equal(existsSync(join(f.root, LAYOUT.context)), false, 'fresh setup must not create a parallel legacy store');
    if (verb === 'start') {
      const entry = json(join(f.root, '.mcp.json')).mcpServers[MCP_SERVER_KEY];
      for (const key of ['API_ENV', 'API_CONFIG', 'API_CONTRACT']) assert.equal(key in entry.env, false, `${key} must not pin the server to one stack`);
    }
  }
});

test('STACKS-1A(a) absolute URLs route to each stack and never cross credentials', async t => {
  const f = await pair(t);
  assert.equal(passed(await request(f, `${f.a.origin}/users`)).ok, true);
  assert.equal(passed(await request(f, `${f.b.origin}/users`)).ok, true);
  refused(await request(f, `${f.b.origin}/users`, ['--stack', 'alpha']), 'ORIGIN_NOT_CONFIGURED|STACK_TARGET');
  assert.deepEqual(await f.a.snapshot(), [{ method: 'GET', path: '/users', authorization: 'Bearer synthetic-alpha-key', fixtureHeader: 'alpha' }]);
  assert.deepEqual(await f.b.snapshot(), [{ method: 'GET', path: '/users', authorization: 'Bearer synthetic-beta-key', fixtureHeader: 'beta' }]);
});

test('STACKS-1A(b) shared origin and segment-bounded base path refuse ambiguity before traffic', async t => {
  const f = project(t), a = await server(t, 'alpha');
  stack(f, 'alpha', a.origin, { prefix: '/v1' }); stack(f, 'beta', a.origin, { prefix: '/v1' });
  const r = await request(f, `${a.origin}/v1/users`);
  refused(r, 'STACK_AMBIGUOUS'); assert.match(`${r.stdout}${r.stderr}`, /alpha/); assert.match(`${r.stdout}${r.stderr}`, /beta/);
  assert.deepEqual(await a.snapshot(), []);
});

test('STACKS-1A(c) relative paths require a stack or default before any traffic', async t => {
  const f = await pair(t);
  refused(await request(f, '/users'), 'STACK_REQUIRED');
  assert.deepEqual(await f.a.snapshot(), []); assert.deepEqual(await f.b.snapshot(), []);
  writeJson(join(f.root, '.sannr', 'defaults.json'), { default_stack: 'beta' });
  assert.equal(passed(await request(f, '/users')).ok, true);
  assert.deepEqual(await f.a.snapshot(), []);
  assert.equal((await f.b.snapshot())[0].authorization, 'Bearer synthetic-beta-key');
});

test('STACKS-1A(d) missing requested environment refuses before any traffic', async t => {
  const f = await pair(t);
  const r = await request(f, '/users', ['--stack', 'alpha', '--env', 'staging']);
  refused(r, 'ENVIRONMENT_NOT_FOUND'); assert.match(`${r.stdout}${r.stderr}`, /local/);
  refused(await command(f, ['request', 'GET', '/users', '--stack', 'alpha'], { API_ENV: 'staging' }), 'ENVIRONMENT_NOT_FOUND');
  assert.deepEqual(await f.a.snapshot(), []); assert.deepEqual(await f.b.snapshot(), []);
});

test('STACKS-1A(e) identical operation keys keep independent notes, observations and show results', async t => {
  const f = await pair(t);
  for (const [name, lesson] of [['alpha', 'Alpha requires a date range.'], ['beta', 'Beta excludes archived records.']]) {
    passed(await command(f, ['note', op, lesson, '--stack', name]));
    passed(await request(f, '/users', ['--stack', name]));
    const shown = passed(await command(f, ['show', op, '--stack', name]));
    assert.deepEqual(shown.notes, [lesson]);
    assert.equal(shown.scoped.operations.length, 1);
    assert.equal(shown.scoped.operations[0].identity.stack, name);
    assert.equal(shown.scoped.operations[0].observations.length, 1);
    const stored = json(join(f.root, '.sannr', 'stacks', name, 'sannr.json'));
    assert.deepEqual(stored.operations[op].notes, [lesson]);
    assert.doesNotMatch(JSON.stringify(stored), /synthetic-private-response|synthetic-alpha-key|synthetic-beta-key/);
  }
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false);
});

test('STACKS-1A(f) MCP stack/environment select the route and upstream reports its alias', async t => {
  const f = await pair(t), alpha = json(join(f.root, '.sannr', 'stacks', 'alpha', 'stack.json'));
  alpha.environments.staging = { baseUrl: `${f.b.origin}/staging`, auth: 'bearer:FIXTURE_BETA_KEY', contractPathPrefix: '/staging' };
  writeJson(join(f.root, '.sannr', 'stacks', 'alpha', 'stack.json'), alpha);
  const host = await mcp(t, f), listed = (await host.session.request('tools/list')).result.tools;
  const tool = listed.find(row => row.name === TOOL_NAME);
  assert.ok(tool.inputSchema.properties.stack); assert.ok(tool.inputSchema.properties.environment);
  assert.match(tool.description, /alpha/); assert.match(tool.description, /beta/);
  const explicit = await host.call({ method: 'GET', path: '/users', stack: 'alpha', environment: 'staging', expect: [{ status: 200 }] });
  assert.equal(explicit.ok, true, JSON.stringify(explicit));
  assert.deepEqual(await f.a.snapshot(), []);
  assert.equal((await f.b.snapshot())[0].path, '/staging/users');
  assert.equal((await f.b.snapshot())[0].authorization, 'Bearer synthetic-beta-key');
  const alias = await host.call({ method: 'GET', path: '/users', upstream: 'beta', expect: [{ status: 200 }] });
  assert.equal(alias.ok, true, JSON.stringify(alias));
  assert.match(JSON.stringify(alias), /upstream/i); assert.match(JSON.stringify(alias), /alias|deprecated/i);
  assert.equal((await f.b.snapshot())[1].path, '/users');
  // A running MCP process resolves current config, rather than its startup list.
  const betaPath = join(f.root, '.sannr', 'stacks', 'beta', 'stack.json'), beta = json(betaPath);
  beta.environments.local.headers['X-Fixture-Stack'] = 'beta-updated'; writeJson(betaPath, beta);
  const current = await host.call({ method: 'GET', path: '/users', stack: 'beta', expect: [{ status: 200 }] });
  assert.equal(current.ok, true, JSON.stringify(current));
  assert.equal((await f.b.snapshot())[2].fixtureHeader, 'beta-updated');
  beta.environments.secondary = beta.environments.local; delete beta.environments.local;
  beta.default_environment = 'secondary'; writeJson(betaPath, beta);
  const batch = await host.call({ requests: [
    { id: 'first', method: 'GET', path: '/users', stack: 'alpha', expect: [{ status: 200 }] },
    { id: 'second', method: 'GET', path: '/users', stack: 'beta', expect: [{ status: 200 }] },
  ] });
  assert.equal(batch.ok, true, JSON.stringify(batch));
  assert.deepEqual(batch.results.map(row => row.stack), ['alpha', 'beta']);
  assert.equal(batch.results[1].environment, 'secondary', 'a different stack uses its own default environment');
  assert.equal((await f.a.snapshot())[0].authorization, 'Bearer synthetic-alpha-key');
  assert.equal((await f.b.snapshot())[3].authorization, 'Bearer synthetic-beta-key');
});

test('STACKS-1A(g) each capture binds its contract and retains evidence under its stack only', async t => {
  const f = await pair(t);
  for (const name of ['alpha', 'beta']) {
    const result = passed(await request(f, '/users', ['--stack', name]));
    assert.equal(result.ok, true); assert.equal(result.context_capture?.state, 'captured', JSON.stringify(result.context_capture));
    const folder = join(f.root, '.sannr', 'stacks', name), stored = json(join(folder, 'sannr.json'));
    const records = Object.values(stored.api_context.operations);
    assert.equal(records.length, 1); assert.equal(records[0].identity.stack, name);
    assert.equal(records[0].identity.contractDigest, `sha256:${createHash('sha256').update(readFileSync(join(folder, 'openapi.json'))).digest('hex')}`);
    const evidence = records[0].observations[0].evidence;
    assert.ok(evidence.length > 0);
    for (const ref of evidence) {
      assert.ok(ref.path.startsWith(`.sannr/evidence/${name}/`), JSON.stringify(ref));
      assert.ok(existsSync(join(f.root, ref.path)), ref.path);
    }
    assert.ok(readdirSync(join(f.root, '.sannr', 'evidence', name)).length > 0);
  }
});

test('STACKS-1A(h) a contractless stack executes while naming the uncaptured-context limitation', async t => {
  const f = project(t), a = await server(t, 'alpha'); stack(f, 'alpha', a.origin, { withContract: false });
  const result = passed(await request(f, '/users'));
  assert.equal(result.ok, true); assert.equal((await a.snapshot()).length, 1);
  assert.ok(result.context_capture, 'successful traffic must not silently imply context capture');
  assert.notEqual(result.context_capture.state, 'captured');
  assert.match(JSON.stringify(result.context_capture), /CONTRACT|HTTP_CONTEXT_ROUTE_UNRESOLVED/);
  assert.equal(existsSync(join(f.root, '.sannr', 'stacks', 'alpha', 'sannr.json')), false);
  assert.ok(existsSync(join(f.root, '.sannr', 'evidence', 'alpha')));
});

test('STACKS-1A(i) a frozen single-store layout keeps authenticated requests and reads but now requires migration for writes', async t => {
  const f = project(t), a = await server(t, 'alpha'), c = join(f.root, 'legacy.openapi.json');
  writeJson(c, contract('Legacy API'));
  writeJson(join(f.root, LAYOUT.marker), { kind: 'repo-api-layout', v: 1, product: 'sannr', collection: 'stacks' });
  writeJson(join(f.root, LAYOUT.environments), { v: 1, default: 'local', environments: {
    local: { baseUrl: a.origin, auth: 'bearer:FIXTURE_ALPHA_KEY', contract: relative(f.root, c) },
  } });
  writeJson(join(f.root, LAYOUT.context), { v: 0, api: { name: 'Legacy API', contract: relative(f.root, c) },
    operations: { [op]: { verified_at: null, contract_digest: null, shape_hash: null, status_codes: [], effect: 'read', fields: {}, notes: [] } } });
  const before = readFileSync(join(f.root, LAYOUT.context), 'utf8');
  refused(await command(f, ['note', op, 'Legacy writes now require migration.']), 'STACKS_MIGRATION_REQUIRED');
  const result = passed(await request(f, '/users'));
  assert.equal(result.ok, true); assert.equal(result.context_capture?.state, 'skipped', JSON.stringify(result.context_capture));
  assert.equal(result.context_capture.code, 'STACKS_MIGRATION_REQUIRED');
  const shown = passed(await command(f, ['show', op]));
  assert.deepEqual(shown.notes, []);
  assert.equal(readFileSync(join(f.root, LAYOUT.context), 'utf8'), before);
  assert.equal((await a.snapshot())[0].authorization, 'Bearer synthetic-alpha-key');
});

test('STACKS-1A R1/R2 invalid names, literal auth, unknown fields and contract escapes refuse safely', async t => {
  const f = project(t);
  for (const name of ['suites', '../escape', 'Bad_Name']) {
    refused(await command(f, ['stack', 'add', name, '--base-url', 'https://fixture.example.test', '--json']), 'STACK');
  }
  refused(await command(f, ['stack', 'add', 'alpha', '--base-url', 'https://fixture.example.test', '--auth', 'synthetic-literal-secret', '--json']), 'AUTH|CREDENTIAL');
  assert.equal(existsSync(join(f.root, '.sannr', 'stacks', 'alpha', 'stack.json')), false);
  for (const bad of [{ typo: true }, { contract: '../../../../escape.json' }]) {
    const s = stack(f, 'alpha', 'https://fixture.example.test');
    writeJson(join(s.folder, 'stack.json'), { ...s.doc, ...bad });
    const r = await command(f, ['stacks', '--json']);
    refused(r, 'STACK|CONTRACT');
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /synthetic-literal-secret/);
  }
});

test('STACKS-1A R4 a selected production environment retains its write guard', async t => {
  const f = project(t), a = await server(t, 'alpha');
  const s = stack(f, 'alpha', a.origin);
  s.doc.environments.local.production = true; writeJson(join(s.folder, 'stack.json'), s.doc);
  const r = await command(f, ['request', 'POST', '/users', '--stack', 'alpha', '--body', '{"ready":true}']);
  refused(r, 'PRODUCTION|PROD_');
  assert.deepEqual(await a.snapshot(), []);
});


test('STACKS-1A R6 repository-wide connect leaves two stack routes unpinned and no legacy store', async t => {
  const f = await pair(t);
  const result = passed(await command(f, ['connect', '--json']));
  assert.equal(result.stack_selection?.code, 'STACK_REQUIRED');
  const registrations = discoverMcpRegistrations(f.root);
  assert.deepEqual(registrations.map(row => row.host).sort(), ['claude-code', 'codex']);
  for (const row of registrations) {
    assert.equal(row.key, MCP_SERVER_KEY);
    for (const key of ['API_ENV', 'API_CONFIG', 'API_CONTRACT']) assert.equal(row.env[key], undefined,
      `${row.host} cannot bind the shared client to one stack`);
  }
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false);
  assert.equal(existsSync(join(f.root, LAYOUT.environments)), false);
  assert.deepEqual(await f.a.snapshot(), []); assert.deepEqual(await f.b.snapshot(), []);
});

test('STACKS-1A R5 offline doctor reports each stack environment, credential reference and reserved-field note', async t => {
  const f = await pair(t), path = join(f.root, '.sannr', 'stacks', 'alpha', 'stack.json'), alpha = json(path);
  alpha.environments.staging = { ...alpha.environments.local, auth: 'bearer:FIXTURE_UNSET_KEY' };
  alpha.cli = { binary: 'fixture-cli' };
  writeJson(path, alpha);
  const result = await command(f, ['doctor', '--offline', '--json']);
  assert.ok(result.value, `${result.stdout}\n${result.stderr}`);
  const rows = result.value.stacks;
  assert.deepEqual(rows.map(row => `${row.stack}/${row.environment}`).sort(), ['alpha/local', 'alpha/staging', 'beta/local']);
  for (const row of rows) {
    assert.ok(row.checks.some(check => /contract/i.test(check.name)), 'every environment names its contract state');
    assert.ok(row.checks.some(check => /auth|credential/i.test(check.name)), 'every environment names its credential state');
  }
  assert.match(JSON.stringify(rows.find(row => row.stack === 'alpha' && row.environment === 'staging')), /FIXTURE_UNSET_KEY/);
  assert.match(JSON.stringify(result.value), /STACKS-3|reserved|ignored/i);
  assert.doesNotMatch(JSON.stringify(result.value), /synthetic-alpha-key|synthetic-beta-key/);
  assert.deepEqual(await f.a.snapshot(), []); assert.deepEqual(await f.b.snapshot(), []);
});

test('STACKS-1A integration: offline doctor validates Basic values per environment without borrowing another stack env file', async t => {
  const f = project(t), alpha = stack(f, 'alpha', 'https://alpha.example.test'), beta = stack(f, 'beta', 'https://beta.example.test');
  const auth = 'basic:FIXTURE_STACK_USER:FIXTURE_STACK_PASS';
  alpha.doc.environments.local = { ...alpha.doc.environments.local, auth, envFile: 'local.env' };
  alpha.doc.environments.staging = { ...alpha.doc.environments.local, envFile: 'staging.env' };
  beta.doc.environments.local = { ...beta.doc.environments.local, auth, envFile: 'local.env' };
  writeJson(join(alpha.folder, 'stack.json'), alpha.doc); writeJson(join(beta.folder, 'stack.json'), beta.doc);
  writeFileSync(join(alpha.folder, 'local.env'), 'FIXTURE_STACK_USER=synthetic-alpha-user\nFIXTURE_STACK_PASS=synthetic-alpha-pass\n');
  writeFileSync(join(alpha.folder, 'staging.env'), 'FIXTURE_STACK_USER=synthetic:invalid-user\nFIXTURE_STACK_PASS=synthetic-staging-pass\n');
  writeFileSync(join(beta.folder, 'local.env'), 'FIXTURE_STACK_USER=synthetic-beta-user\n');
  const result = await command(f, ['doctor', '--offline', '--json']);
  assert.equal(result.exit, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(result.value, `${result.stdout}\n${result.stderr}`);
  const authFor = (name, environment) => result.value.stacks.find(row => row.stack === name && row.environment === environment)
    ?.checks.find(check => check.name === 'auth');
  assert.equal(authFor('alpha', 'staging')?.state, 'FAIL');
  assert.match(authFor('alpha', 'staging').detail, /Basic usernames cannot contain a colon/);
  assert.equal(authFor('alpha', 'local')?.state, 'PASS');
  assert.match(authFor('alpha', 'local').detail, /FIXTURE_STACK_USER.*FIXTURE_STACK_PASS.*authentication is unverified/);
  assert.equal(authFor('beta', 'local')?.state, 'FAIL');
  assert.match(authFor('beta', 'local').detail, /FIXTURE_STACK_PASS.*not set/);
  assert.doesNotMatch(authFor('beta', 'local').detail, /FIXTURE_STACK_USER/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /synthetic-(?:alpha|beta|staging|invalid)/);
  assert.doesNotMatch(result.stdout, /About to request/);
  assert.equal(existsSync(join(f.root, '.sannr', 'evidence')), false, 'offline diagnostics cannot capture a request');
});

test('STACKS-1A integration: offline doctor keeps partial-contract and prefix diagnostics scoped to each stack', async t => {
  const f = project(t), alpha = stack(f, 'alpha', 'https://alpha.example.test', { prefix: '/v1' });
  const beta = stack(f, 'beta', 'https://beta.example.test', { prefix: '/v2' });
  beta.doc.environments.local.contractPathPrefix = '/v2/beta';
  writeJson(join(beta.folder, 'stack.json'), beta.doc);
  const partial = contract('Alpha API');
  partial.paths['/responses?mode=DO_NOT_LOG_STACK_QUERY'] = { post: {} };
  writeJson(join(alpha.folder, 'openapi.json'), partial);
  const result = passed(await command(f, ['doctor', '--offline', '--json']));
  const checksFor = name => result.stacks.find(row => row.stack === name)?.checks;
  const skipped = checksFor('alpha').find(check => check.name === 'contract-routes');
  assert.equal(skipped?.state, 'WARN');
  assert.match(skipped.detail, /1 path keys.*1 operations.*literal-query-suffix/);
  assert.equal(checksFor('beta').find(check => check.name === 'contract-routes'), undefined,
    'one stack cannot inherit another stack route diagnostics');
  assert.match(checksFor('alpha').find(check => check.name === 'contract-mount')?.detail ?? '', /"\/v1".*contractPathPrefix/);
  assert.match(checksFor('beta').find(check => check.name === 'contract-mount')?.detail ?? '', /"\/v2\/beta".*contractPathPrefix/);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LOG_STACK_QUERY|mode=/);
  assert.equal(existsSync(join(f.root, '.sannr', 'evidence')), false);
});


test('STACKS-1A fresh init preflights pointer conflicts before creating a stack', async t => {
  for (const scenario of ['malformed managed block', 'unwritable pointer file']) await t.test(scenario, async t => {
    const f = project(t), contractFile = join(f.root, 'openapi.json'), pointerFile = join(f.root, 'AGENTS.md');
    writeJson(contractFile, contract('Preflight API'));
    const original = scenario === 'malformed managed block' ? `# Project rules\n${POINTER_BEGIN}\nIncomplete managed block\n`
      : '# Project rules\nKeep this team-authored instruction.\n';
    writeFileSync(pointerFile, original);
    if (scenario === 'unwritable pointer file') {
      chmodSync(pointerFile, 0o444);
    }
    const result = await command(f, ['init', '--agents']);
    refused(result, scenario === 'malformed managed block' ? 'POINTER_CONFLICT' : 'WRITE_PLAN_CONFLICT');
    assert.equal(readFileSync(pointerFile, 'utf8'), original);
    assert.deepEqual(readdirSync(f.root).sort(), ['AGENTS.md', 'home', 'openapi.json'],
      'a refused fresh init cannot leave a stack, copied contract, evidence, skills or wiring behind');
  });
});
