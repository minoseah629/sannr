// Native Basic authentication, using synthetic credentials and loopback only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';
import { suiteSecretProblems, normalizeSuite } from '../lib/suites.mjs';
import { operationId } from '../lib/operation-context.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = new URL('../lib/client.mjs', import.meta.url).href;
const AUTH = 'basic:FIXTURE_BASIC_USER:FIXTURE_BASIC_PASS';
const CREDS = { FIXTURE_BASIC_USER: 'synthetic-basic-user', FIXTURE_BASIC_PASS: 'synthetic-basic-password' };
const header = (env = CREDS) => `Basic ${Buffer.from(`${env.FIXTURE_BASIC_USER}:${env.FIXTURE_BASIC_PASS}`, 'utf8').toString('base64')}`;

async function fixture(t, configure = {}, handler) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-basic-')));
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ path: req.url, headers: req.headers, body });
    const reply = handler ? await handler(req, body) : {};
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = join(root, LAYOUT.environments);
  writeFileSync(config, JSON.stringify({ v: 1, default: 'fixture', environments: { fixture: { baseUrl, auth: AUTH, ...configure } } }));
  return { root, seen, baseUrl, config };
}

async function child(f, code, env = CREDS, cliArgs) {
  const p = spawn(process.execPath, cliArgs ? [join(ROOT, 'bin/cli.mjs'), ...cliArgs] : ['--input-type=module', '-e',
    `import { apiRequest, runEnvelope } from ${JSON.stringify(CLIENT)};\n${code}`], {
    cwd: f.root, timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: f.root, API_CONFIG: f.config, API_CONTEXT_OFF: '1',
      API_CONTEXT_DIR: f.root, API_USAGE_LOG: join(f.root, 'usage.jsonl'), API_EVIDENCE: join(f.root, 'evidence'),
      API_FRICTION_OFF: '1', API_TIMEOUT_MS: '3000', ...env },
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', chunk => stdout += chunk);
  p.stderr.on('data', chunk => stderr += chunk);
  const exit = await new Promise((resolve, reject) => { p.once('error', reject); p.once('close', resolve); });
  if (!cliArgs) assert.equal(exit, 0, `Child exit ${exit}; stderr bytes ${stderr.length}`);
  return { result: JSON.parse(stdout), stdout, stderr, exit };
}
// R7: only the tests that promote observations use a real stack. Auth-only
// controls below intentionally retain their legacy provider configuration.
function captureStack(f) {
  const environment = { ...JSON.parse(readFileSync(f.config, 'utf8')).environments.fixture, contract: '../../../openapi.json' };
  writeFileSync(join(f.root, LAYOUT.collection, 'fixture', 'stack.json'), JSON.stringify({
    v: 1, name: 'fixture', default_environment: 'fixture', environments: { fixture: environment },
  }));
  f.contextFile = join(f.root, LAYOUT.collection, 'fixture', 'sannr.json');
  f.evidenceDir = join(f.root, LAYOUT.evidence, 'fixture');
}
const run = (f, request = {}, env) => child(f, `console.log(JSON.stringify(await apiRequest(${JSON.stringify({ path: '/health', ...request })})));`, env);
const records = f => existsSync(join(f.root, 'evidence'))
  ? readdirSync(join(f.root, 'evidence')).filter(name => /^run-.*\.json$/.test(name)).map(name => readFileSync(join(f.root, 'evidence', name), 'utf8')).join('\n') : '';

test('native Basic sends the exact header and redacts both values and their combined encodings in echo paths', async t => {
  const combined = `${CREDS.FIXTURE_BASIC_USER}:${CREDS.FIXTURE_BASIC_PASS}`;
  const encoded = Buffer.from(combined, 'utf8').toString('base64');
  const f = await fixture(t, {}, req => ({ headers: { etag: header() }, body: {
    user: CREDS.FIXTURE_BASIC_USER, password: CREDS.FIXTURE_BASIC_PASS, combined, encoded,
    header: req.headers.authorization, [encoded]: combined,
  } }));
  // A request path can contain a previously echoed credential too. It is private
  // execution input, but neither local evidence nor usage should retain it.
  const { result, stdout } = await run(f, { path: `/${encoded}`, mode: 'full', budget: 10000 });
  assert.equal(result.ok, true);
  assert.equal(f.seen[0].headers.authorization, header());
  const evidence = records(f), usage = readFileSync(join(f.root, 'usage.jsonl'), 'utf8');
  assert.ok(evidence.length > 0);
  for (const output of [stdout, evidence, usage])
    for (const secret of [...Object.values(CREDS), combined, encoded, header()])
      assert.equal(output.includes(secret), false, 'Configured Basic credential form must be scrubbed');
  assert.match(usage, /basic:FIXTURE_BASIC_USER:FIXTURE_BASIC_PASS/);
});

test('Basic encodes non-ASCII credentials explicitly as UTF-8 and permits colons in passwords', async t => {
  const env = { FIXTURE_BASIC_USER: 'Jäsøn', FIXTURE_BASIC_PASS: 'päss:wörd' };
  const f = await fixture(t);
  assert.equal((await run(f, {}, env)).result.ok, true);
  assert.equal(f.seen[0].headers.authorization, header(env));
});

test('Basic rejects missing variables and invalid characters before any dispatch', async t => {
  const f = await fixture(t);
  for (const [env, code] of [
    [{ FIXTURE_BASIC_PASS: CREDS.FIXTURE_BASIC_PASS }, 'AUTH_ENV_MISSING'],
    [{ FIXTURE_BASIC_USER: CREDS.FIXTURE_BASIC_USER }, 'AUTH_ENV_MISSING'],
    [{ ...CREDS, FIXTURE_BASIC_USER: '' }, 'AUTH_ENV_MISSING'],
    [{ ...CREDS, FIXTURE_BASIC_PASS: '' }, 'AUTH_ENV_MISSING'],
    [{ ...CREDS, FIXTURE_BASIC_USER: 'invalid:user' }, 'AUTH_VALUE_INVALID'],
    [{ ...CREDS, FIXTURE_BASIC_USER: 'invalid\tuser' }, 'AUTH_VALUE_INVALID'],
    [{ ...CREDS, FIXTURE_BASIC_PASS: 'invalid\npassword' }, 'AUTH_VALUE_INVALID'],
    [{ ...CREDS, FIXTURE_BASIC_PASS: 'invalid\x7fpassword' }, 'AUTH_VALUE_INVALID'],
  ]) {
    const { result, stdout } = await run(f, {}, env);
    assert.equal(result.ok, false);
    assert.equal(result.mode, 'refused');
    assert.equal(result.error?.code, code);
    assert.equal(f.seen.length, 0);
    for (const value of Object.values(env).filter(Boolean)) assert.equal(stdout.includes(value), false);
  }
});

test('malformed Basic references refuse before dispatch', async t => {
  for (const auth of ['basic:FIXTURE_BASIC_USER', 'basic:FIXTURE_BASIC_USER:FIXTURE_BASIC_PASS:EXTRA', 'basic:user-name:password-value']) {
    const f = await fixture(t, { auth });
    assert.equal((await run(f)).result.error?.code, 'AUTH_SPEC_INVALID');
    assert.equal(f.seen.length, 0);
  }
});

test('Basic uses provider-local credential files and rereads rotations without borrowing another provider', async t => {
  const secondary = await fixture(t);
  const primary = await fixture(t, { envFile: join(secondary.root, 'primary.env'), hosts: {
    secondary: { baseUrl: secondary.baseUrl, auth: AUTH, envFile: join(secondary.root, 'secondary.env') },
  } });
  writeFileSync(join(secondary.root, 'primary.env'), 'FIXTURE_BASIC_USER=primary-user\nFIXTURE_BASIC_PASS=primary-password\n');
  writeFileSync(join(secondary.root, 'secondary.env'), 'FIXTURE_BASIC_USER=secondary-user\nFIXTURE_BASIC_PASS=secondary-password\n');
  const code = `import { writeFileSync } from 'node:fs';
    const first = await apiRequest({ path:'/first' });
    const other = await apiRequest({ path:'/other', upstream:'secondary' });
    writeFileSync(process.env.FIXTURE_ROTATE_FILE, process.env.FIXTURE_ROTATE_VALUES);
    const rotated = await apiRequest({ path:'/rotated' });
    console.log(JSON.stringify([first, other, rotated]));`;
  const { result } = await child(primary, code, { FIXTURE_ROTATE_FILE: join(secondary.root, 'primary.env'),
    FIXTURE_ROTATE_VALUES: 'FIXTURE_BASIC_USER=rotated-user\nFIXTURE_BASIC_PASS=rotated-password\n' });
  assert.ok(result.every(item => item.ok));
  assert.equal(primary.seen[0].headers.authorization, `Basic ${Buffer.from('primary-user:primary-password').toString('base64')}`);
  assert.equal(secondary.seen[0].headers.authorization, `Basic ${Buffer.from('secondary-user:secondary-password').toString('base64')}`);
  assert.equal(primary.seen[1].headers.authorization, `Basic ${Buffer.from('rotated-user:rotated-password').toString('base64')}`);
});

test('Basic credentials are dropped across origins and same-origin provider scopes, and explicit upstream calls use their own pair', async t => {
  const secondary = await fixture(t);
  const primary = await fixture(t, { hosts: {
    secondary: { baseUrl: secondary.baseUrl, auth: 'basic:SECOND_USER:SECOND_PASS' },
  } }, req => req.url === '/redirect' ? { status: 302, headers: { location: `${secondary.baseUrl}/after` } } : {});
  const env = { ...CREDS, SECOND_USER: 'secondary-user', SECOND_PASS: 'secondary-password' };
  assert.equal((await run(primary, { path: '/redirect' }, env)).result.ok, true);
  assert.equal(primary.seen[0].headers.authorization, header());
  assert.equal(secondary.seen[0].headers.authorization, undefined);
  assert.equal((await run(primary, { upstream: 'secondary' }, env)).result.ok, true);
  assert.equal(secondary.seen[1].headers.authorization, `Basic ${Buffer.from('secondary-user:secondary-password').toString('base64')}`);
  const sameOrigin = await fixture(t, {}, req => req.url === '/a/start'
    ? { status: 302, headers: { location: '/b/after' } } : {});
  writeFileSync(sameOrigin.config, JSON.stringify({ v: 1, default: 'fixture', environments: { fixture: {
    baseUrl: `${sameOrigin.baseUrl}/a`, auth: AUTH, hosts: { sibling: { baseUrl: `${sameOrigin.baseUrl}/b`, auth: 'basic:SECOND_USER:SECOND_PASS' } },
  } } }));
  assert.equal((await run(sameOrigin, { path: '/start' }, env)).result.ok, true);
  assert.equal(sameOrigin.seen[1].headers.authorization, undefined);
});

test('Basic imported-step equivalence requires both reference names', async t => {
  const f = await fixture(t);
  for (const required of [AUTH, 'basic:OTHER_USER:FIXTURE_BASIC_PASS', 'basic:FIXTURE_BASIC_USER:OTHER_PASS']) {
    const { result } = await child(f, `console.log(JSON.stringify(await runEnvelope({ requests: [{ path:'/health', auth:${JSON.stringify(required)}, expect:[{status:200}] }] })));`,
      { ...CREDS, OTHER_USER: CREDS.FIXTURE_BASIC_USER, OTHER_PASS: CREDS.FIXTURE_BASIC_PASS });
    assert.equal(result.ok, required === AUTH);
    assert.equal(result.attempted, required === AUTH ? 1 : 0);
    if (required !== AUTH) assert.equal(result.results[0].error?.code, 'IMPORTED_AUTH_BINDING_REQUIRED');
  }
  assert.equal(f.seen.length, 1);
});

test('Basic requests independently resolve both credentials while the same read is in flight', async t => {
  const f = await fixture(t, {}, async () => { await new Promise(resolve => setTimeout(resolve, 40)); return {}; });
  const { result } = await child(f, `
    const first = apiRequest({ path:'/same' });
    process.env.FIXTURE_BASIC_USER = process.env.FIXTURE_NEXT_USER;
    process.env.FIXTURE_BASIC_PASS = process.env.FIXTURE_NEXT_PASS;
    const second = apiRequest({ path:'/same' });
    console.log(JSON.stringify(await Promise.all([first, second])));`,
  { ...CREDS, FIXTURE_NEXT_USER: 'rotated-user', FIXTURE_NEXT_PASS: 'rotated-password' });
  assert.ok(result.every(item => item.ok));
  assert.equal(f.seen.length, 2);
  assert.deepEqual(new Set(f.seen.map(item => item.headers.authorization)), new Set([
    header(), `Basic ${Buffer.from('rotated-user:rotated-password').toString('base64')}`,
  ]));
});

test('suite typed auth accepts two-var Basic only and keeps payload/prose secret guards strict', () => {
  const suite = auth => normalizeSuite('fixture', [{ path: '/health', auth, expect: [{ status: 200 }] }]).suite;
  assert.deepEqual(suiteSecretProblems(suite(AUTH)), []);
  for (const auth of ['basic:FIXTURE_BASIC_USER', 'basic:USER_ENV:PASS_ENV:EXTRA', 'basic:USER_ENV:AKIA1234567890123456'])
    assert.ok(suiteSecretProblems(suite(auth)).length > 0, 'Malformed or secret-shaped Basic must not be saved');
  for (const field of ['body', 'note']) {
    const value = suite(AUTH);
    value.requests[0][field] = AUTH;
    assert.ok(suiteSecretProblems(value).length > 0, 'Typed auth exemption must not apply to executable payloads or prose');
  }
});

test('JSON-RPC HTTP adapter shares Basic dispatch and scrubs echoed forms', async t => {
  const f = await fixture(t, {}, (_req, body) => ({ body: { jsonrpc: '2.0', id: JSON.parse(body).id,
    result: { echoed: header(), encoded: header().slice(6), user: CREDS.FIXTURE_BASIC_USER } } }));
  const { result, stdout } = await run(f, { protocol: 'jsonrpc', rpc: { method: 'fixture.echo', params: {} }, budget: 10000 });
  assert.equal(result.ok, true);
  assert.equal(f.seen[0].headers.authorization, header());
  for (const output of [stdout, records(f)]) for (const secret of [...Object.values(CREDS), header(), header().slice(6)])
    assert.equal(output.includes(secret), false);
});

test('short Basic credentials preserve HTTP and protocol structure while scrubbing provider keys and values', async t => {
  for (const credentials of [{ ...CREDS, FIXTURE_BASIC_USER: 'ok' }, { ...CREDS, FIXTURE_BASIC_PASS: 'status' }]) {
    const short = credentials.FIXTURE_BASIC_USER === 'ok' ? 'ok' : 'status';
    const f = await fixture(t, {}, (_req, body) => ({ body: body
      ? { jsonrpc: '2.0', id: JSON.parse(body).id, result: { [short]: short } }
      : { [short]: short } }));
    const http = (await run(f, { budget: 10000 }, credentials)).result;
    assert.equal(http.ok, true);
    assert.equal(http.status, 200);
    assert.deepEqual(http.data, { '[redacted]': '[redacted]' });
    const rpc = (await run(f, { protocol: 'jsonrpc', rpc: { method: 'fixture.echo', params: {} }, budget: 10000 }, credentials)).result;
    assert.equal(rpc.ok, true);
    assert.equal(rpc.status, 200);
    assert.equal(rpc.protocol.outcome, 'success');
    assert.deepEqual(rpc.data.result, { '[redacted]': '[redacted]' });
    const evidence = readdirSync(join(f.root, 'evidence')).filter(name => /^run-.*\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(f.root, 'evidence', name), 'utf8')));
    assert.ok(evidence.every(record => record.response.status === 200));
    const protocol = evidence.find(record => record.identity);
    assert.equal(protocol.response.ok, true);
    assert.deepEqual(protocol.response.body.result, { '[redacted]': '[redacted]' });
  }
});

test('redaction expansion from a short Basic username still fits the HTTP presentation budget', async t => {
  const f = await fixture(t, {}, () => ({ body: { echoed: 'a'.repeat(700) } }));
  const { result } = await run(f, {}, { ...CREDS, FIXTURE_BASIC_USER: 'a', API_BUDGET: '300' });
  assert.equal(result.ok, true);
  assert.ok(JSON.stringify(result).length <= 1200, 'Redaction expansion must participate in budget measurement');
  assert.ok(result.discovery?.truncated, 'Omitted echo content must remain visible as an omission');
});

test('enabled HTTP context never promotes Basic credentials echoed as response property names', async t => {
  const f = await fixture(t, {}, () => ({ body: { [CREDS.FIXTURE_BASIC_USER]: { [CREDS.FIXTURE_BASIC_PASS]: 'echoed-value' } } }));
  const contract = join(f.root, 'openapi.json');
  writeFileSync(contract, JSON.stringify({ openapi: '3.0.0', paths: { '/health': { get: { responses: { 200: { description: 'fixture' } } } } } }));
  const config = JSON.parse(readFileSync(f.config, 'utf8'));
  config.environments.fixture.contract = contract;
  writeFileSync(f.config, JSON.stringify(config));
  captureStack(f);
  const { result } = await run(f, {}, { ...CREDS, API_CONTEXT_OFF: '0' });
  assert.equal(result.context_capture?.state, 'captured');
  const context = readFileSync(f.contextFile, 'utf8');
  for (const value of Object.values(CREDS)) assert.equal(context.includes(value), false, 'Committed shape must scrub echoed credential keys');
});

test('Basic + mounted HTTP capture preserves its fixed receipt schema without trusting provider lookalikes or private prefixes', async t => {
  for (const [explicit, password] of [[false, CREDS.FIXTURE_BASIC_PASS], [true, 'contractPathPrefix'], [true, '/v1']]) {
    const username = 'path', source = explicit ? 'contractPathPrefix' : 'base-url-path';
    const f = await fixture(t, {}, () => ({ body: { context_capture: { mount: {
      pathPrefix: username, source, [password]: password,
    } } } }));
    const contract = join(f.root, 'openapi.json');
    writeFileSync(contract, JSON.stringify({ openapi:'3.0.0', paths:{ '/health':{ get:{} } } }));
    const config = JSON.parse(readFileSync(f.config, 'utf8'));
    Object.assign(config.environments.fixture, { baseUrl:`${f.baseUrl}/v1`, contract,
      ...(explicit ? { contractPathPrefix:'/v1' } : {}) });
    writeFileSync(f.config, JSON.stringify(config));
  captureStack(f);
    const { result } = await run(f, { mode:'full', budget:4000 }, {
      FIXTURE_BASIC_USER:username, FIXTURE_BASIC_PASS:password, API_CONTEXT_OFF:'0',
    });
    assert.equal(result.ok, true);
    assert.equal(result.context_capture?.state, 'captured');
    assert.deepEqual(result.context_capture.mount, {
      pathPrefix:password === '/v1' ? null : '/v1', source,
      ...(password === '/v1' ? { pathPrefix_withheld:true } : {}),
    });
    const lookalike = result.data.context_capture.mount;
    assert.equal(Object.hasOwn(lookalike, 'pathPrefix'), false, 'Provider maps cannot impersonate the trusted receipt schema');
    assert.equal(lookalike['[redacted]Prefix'], '[redacted]');
    // Secret-shaped response fields receive opaque markers before configured
    // Basic values are scrubbed; both passes must also protect echoed keys.
    const passwordKey = Object.keys(lookalike).find(key => key !== '[redacted]Prefix' && key !== 'source');
    assert.equal(Object.keys(lookalike).length, 3);
    if (password === CREDS.FIXTURE_BASIC_PASS) assert.match(passwordKey, /^\[withheld: secret; salted-sha256:[a-f0-9]{64}\]$/);
    else assert.equal(passwordKey, '[redacted]');
    assert.equal(lookalike[passwordKey], passwordKey);
    assert.equal(lookalike.source, source === password ? '[redacted]' : source.replaceAll(username, '[redacted]'));
    assert.equal(f.seen[0].headers.authorization, header({ FIXTURE_BASIC_USER:username, FIXTURE_BASIC_PASS:password }),
      'Response masking must not change the credential sent to the fixture');
    assert.equal(JSON.stringify(lookalike).includes(password), false);
    if (password === '/v1') assert.equal(JSON.stringify(result).includes(password), false, 'Private configured prefix is withheld, not fabricated as a usable mount');
  }
});

test('budgeted Basic HTTP capture keeps exact saved receipt identities while provider lookalikes remain scrubbed', async t => {
  let lookalike;
  const f = await fixture(t, {}, () => ({ body:{ echoed:'a'.repeat(700), context_capture:lookalike } }));
  const contract = join(f.root, 'openapi.json');
  const raw = JSON.stringify({ openapi:'3.0.0', paths:{ '/health':{ get:{} } } });
  writeFileSync(contract, raw);
  const config = JSON.parse(readFileSync(f.config, 'utf8'));
  Object.assign(config.environments.fixture, { baseUrl:`${f.baseUrl}/v1`, contract });
  writeFileSync(f.config, JSON.stringify(config));
  captureStack(f);
  lookalike = { state:'captured', observation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operation_id:operationId({ stack:'fixture', provider:`${f.baseUrl}/v1`, environment:'fixture', protocol:'http',
      operation:'GET /health', endpoint:`${f.baseUrl}/v1/health`,
      contractDigest:`sha256:${createHash('sha256').update(raw).digest('hex')}` }) };
  const { result } = await run(f, {}, { ...CREDS, FIXTURE_BASIC_USER:'a', API_CONTEXT_OFF:'0', API_BUDGET:'300' });
  assert.equal(result.ok, true);
  assert.equal(result.context_capture?.state, 'captured');
  assert.equal(result.context_capture.operation_id, lookalike.operation_id);
  const stored = JSON.parse(readFileSync(f.contextFile, 'utf8'));
  const entry = stored.api_context.operations[result.context_capture.operation_id];
  assert.ok(entry, 'Returned operation receipt resolves the exact saved record');
  assert.ok(entry.observations.some(observation => observation.id === result.context_capture.observation_id), 'Returned observation receipt resolves the exact saved record');
  assert.equal(result.context_capture.details_omitted, true, 'The tiny presentation keeps a compact receipt');
  assert.ok(JSON.stringify(result).length <= 1200);
  const evidence = JSON.parse(readFileSync(join(f.evidenceDir, `${result.evidence}.json`), 'utf8'));
  const provider = evidence.response.body['context_c[redacted]pture'];
  assert.equal(provider['st[redacted]te'], 'c[redacted]ptured');
  assert.equal(provider['oper[redacted]tion_id'], lookalike.operation_id.replaceAll('a', '[redacted]'), 'Even an exact generated ID echoed by the provider stays private');
  assert.equal(provider['observ[redacted]tion_id'], lookalike.observation_id.replaceAll('a', '[redacted]'));
});

test('short Basic names preserve generated evidence identity and fixed provenance while dynamic echoes remain scrubbed', async t => {
  for (const username of ['run', 'http', 'library.apiRequest', 'api_request:http']) {
    const f = await fixture(t, {}, () => ({ body: { echo: username, nested: { transport: username } } }));
    const credentials = username.includes(':') ? { ...CREDS, FIXTURE_BASIC_PASS: username } : { ...CREDS, FIXTURE_BASIC_USER: username };
    const { result } = await run(f, {}, credentials);
    assert.equal(result.ok, true);
    assert.match(result.evidence, /^run-[a-f0-9-]+$/);
    const record = JSON.parse(readFileSync(join(f.root, 'evidence', `${result.evidence}.json`), 'utf8'));
    assert.equal(record.runId, result.evidence);
    assert.equal(record.origin.initiator, 'library.apiRequest');
    assert.equal(record.origin.transport, 'api_request:http');
    assert.equal(record.origin.scope.protocol, 'http');
    assert.equal(record.origin.scope.provider, f.baseUrl);
    assert.equal(record.request.url, `${f.baseUrl}/health`);
    assert.equal(record.response.body.echo, '[redacted]');
    assert.equal(record.response.body.nested.transport, '[redacted]');
    assert.equal(result.data.echo, '[redacted]');
    assert.equal(JSON.parse(readFileSync(join(f.root, 'usage.jsonl'), 'utf8').trim()).runId, result.evidence);
  }
});

test('a provider scope containing credential text is explicitly withheld while its request URL stays scrubbed', async t => {
  const f = await fixture(t);
  const config = JSON.parse(readFileSync(f.config, 'utf8'));
  config.environments.fixture.baseUrl = `${f.baseUrl}/${CREDS.FIXTURE_BASIC_USER}`;
  writeFileSync(f.config, JSON.stringify(config));
  const { result } = await run(f);
  assert.equal(result.ok, true);
  const record = JSON.parse(readFileSync(join(f.root, 'evidence', `${result.evidence}.json`), 'utf8'));
  assert.equal(record.origin.scope.provider, null);
  assert.equal(record.origin.scope.provider_withheld, true);
  assert.equal(record.request.url.includes(CREDS.FIXTURE_BASIC_USER), false);
  assert.equal(record.request.url.includes('[redacted]'), true);
});

test('known URL scheme handling never restores credentials spanning scheme delimiters or authority', async t => {
  const f = await fixture(t);
  for (const password of [f.baseUrl, '/127', 'tp://127', '//127', 'http://']) {
    const { result } = await run(f, {}, { ...CREDS, FIXTURE_BASIC_PASS: password });
    assert.equal(result.ok, true);
    const record = JSON.parse(readFileSync(join(f.root, 'evidence', `${result.evidence}.json`), 'utf8'));
    assert.equal(record.origin.scope.provider, null);
    assert.equal(record.origin.scope.provider_withheld, true);
    assert.equal(record.request.url.includes(password), false, 'Scheme exception must not reconstruct any complete credential');
    assert.equal(JSON.stringify(record).includes(password), false);
  }
});

test('protocol evidence treats every supplied protocol input block as untrusted including unknown keys', async t => {
  const f = await fixture(t);
  const { result } = await child(f, `import { scrubForTest } from ${JSON.stringify(CLIENT)};
    const secret = process.env.FIXTURE_BASIC_PASS;
    const blocks = Object.fromEntries(['graphql','rpc','grpc','websocket'].map(name => [name, { [secret]: 'extra', method: secret }]));
    console.log(scrubForTest(JSON.stringify({ request: blocks }), [secret], 'protocolEvidence'));`);
  for (const block of Object.values(result.request)) {
    assert.equal(Object.hasOwn(block, CREDS.FIXTURE_BASIC_PASS), false);
    assert.equal(block['[redacted]'], 'extra');
    assert.equal(block.method, '[redacted]');
  }
});

test('Basic binary responses preserve schema keys and explicitly withhold redacted paths or hashes', async t => {
  const bytes = Buffer.from([0, 1, 2, 3, 4]);
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`;
  const f = await fixture(t, {}, () => ({ headers: { 'content-type': 'application/octet-stream' }, raw: bytes }));
  for (const [username, password, hashWithheld] of [
    ['a', CREDS.FIXTURE_BASIC_PASS, true],
    ['bytes', CREDS.FIXTURE_BASIC_PASS, false],
    [CREDS.FIXTURE_BASIC_USER, hash, true],
  ]) {
    const filename = `download-${username}.bin`;
    const { result } = await run(f, { save_to: filename }, { FIXTURE_BASIC_USER: username, FIXTURE_BASIC_PASS: password });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'binary');
    assert.equal(result.binary.bytes, bytes.length);
    assert.equal(Object.hasOwn(result.binary, 'sha256'), true);
    if (hashWithheld) {
      assert.equal(result.binary.sha256, null);
      assert.equal(result.binary.sha256_withheld, true);
    } else assert.equal(result.binary.sha256, hash);
    assert.equal(result.binary.saved_to, null);
    assert.equal(result.binary.saved_to_withheld, true);
    assert.equal(JSON.stringify(result).includes(filename), false);
    if (username === 'a') assert.notEqual(result.binary.content_type, 'application/octet-stream');
    assert.deepEqual(readFileSync(join(f.root, filename)), bytes);
  }
});

test('offline doctor reports both Basic references and invalid values without requests', async t => {
  const f = await fixture(t);
  const present = await child(f, '', CREDS, ['doctor', '--offline', '--json']);
  const auth = present.result.checks.find(row => row.name === 'auth');
  assert.equal(auth.state, 'PASS');
  assert.match(auth.detail, /FIXTURE_BASIC_USER.*FIXTURE_BASIC_PASS/);
  const invalid = await child(f, '', { ...CREDS, FIXTURE_BASIC_USER: 'invalid:user' }, ['doctor', '--offline', '--json']);
  assert.equal(invalid.result.checks.find(row => row.name === 'auth').state, 'FAIL');
  assert.equal(f.seen.length, 0);
});
