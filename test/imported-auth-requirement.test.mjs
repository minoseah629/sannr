// Independent end-to-end auth requirements and inherited setup provenance.
// Controlled loopback fixtures only; every credential below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPostman, importBrunoDirectory } from '../lib/import.mjs';
import { prepareImportedTestClaims, saveImportedTestClaims } from '../lib/imported-test-claims.mjs';
import { loadContext } from '../lib/context.mjs';

const client = new URL('../lib/client.mjs', import.meta.url).href;
const request = patch => ({ method: 'GET', path: '/health', expect: [{ status: 200 }], ...patch });
const tokens = { FIXTURE_REQUIRED: 'synthetic-required-not-real', FIXTURE_OTHER: 'synthetic-other-not-real' };

async function fixture(t, configure = {}, handler) {
  const root = mkdtempSync(join(tmpdir(), 'policy-auth-qa-'));
  const received = join(root, 'request-received');
  const seen = [];
  const server = createServer(async (req, res) => {
    writeFileSync(received, 'received');
    seen.push({ path: req.url, hasAuthorization: Boolean(req.headers.authorization),
      hasCookie: Boolean(req.headers.cookie),
      requiredBearer: req.headers.authorization === `Bearer ${tokens.FIXTURE_REQUIRED}`,
      requiredHeader: req.headers['x-fixture-key'] === tokens.FIXTURE_REQUIRED,
      otherBearer: req.headers.authorization === `Bearer ${tokens.FIXTURE_OTHER}`,
      requiredQuery: new URL(req.url, 'http://fixture.invalid').searchParams.get('api_key') === tokens.FIXTURE_REQUIRED });
    const reply = handler ? await handler(req, res) : null;
    res.writeHead(reply?.status ?? 200, { 'content-type': 'application/json', ...reply?.headers });
    res.end(JSON.stringify(reply?.body ?? { ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ default: 'fixture', environments: { fixture: { baseUrl, ...configure } } }));
  return { root, seen, baseUrl, config, received };
}

async function child(f, code, env = tokens) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', `import { apiRequest, runEnvelope } from ${JSON.stringify(client)};\n${code}`], {
    cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root, API_CONFIG: f.config,
      API_CONTEXT_OFF: '1', API_CONTEXT_DIR: f.root, API_EVIDENCE: join(f.root, 'evidence'),
      API_FRICTION_OFF: '1', API_TIMEOUT_MS: '3000', ...env }, timeout: 10_000,
  });
  let stdout = '', stderr = '';
  p.stdout.on('data', chunk => stdout += chunk);
  p.stderr.on('data', chunk => stderr += chunk);
  const exit = await new Promise((resolve, reject) => { p.once('error', reject); p.once('close', resolve); });
  assert.equal(exit, 0, `Child exit ${exit}; stderr bytes ${stderr.length}`);
  for (const token of Object.values(tokens)) assert.equal(stdout.includes(token), false, 'Client output must not disclose fixture credential values');
  return JSON.parse(stdout);
}
async function run(f, step, env) {
  return child(f, `console.log(JSON.stringify(await runEnvelope(${JSON.stringify({ requests: [step] })})));`, env);
}
function refused(result, f, code = 'IMPORTED_AUTH_BINDING_REQUIRED') {
  assert.equal(result.ok, false);
  assert.equal(result.attempted, 0);
  assert.equal(result.results[0].mode, 'refused');
  if (Array.isArray(code)) assert.ok(code.includes(result.results[0].error?.code), 'Expected an explicit config or auth-absence refusal');
  else assert.equal(result.results[0].error?.code, code);
  assert.equal(f.seen.length, 0);
}

test('required auth refuses an unconfigured provider despite a matching environment variable', async t => {
  const f = await fixture(t);
  refused(await run(f, request({ auth: 'bearer:FIXTURE_REQUIRED' })), f);
});

test('required auth refuses a configured reference with an unset credential', async t => {
  const f = await fixture(t, { auth: 'bearer:FIXTURE_REQUIRED' });
  refused(await run(f, request({ auth: 'bearer:FIXTURE_REQUIRED' }), {}), f, 'IMPORTED_AUTH_VALUE_REQUIRED');
});

test('required auth refuses a different configured environment reference', async t => {
  const f = await fixture(t, { auth: 'bearer:FIXTURE_OTHER' });
  refused(await run(f, request({ auth: 'bearer:FIXTURE_REQUIRED' })), f);
});

test('required auth refuses a different credential placement', async t => {
  const f = await fixture(t, { auth: 'header:X-Fixture-Key:FIXTURE_REQUIRED' });
  refused(await run(f, request({ auth: 'bearer:FIXTURE_REQUIRED' })), f);
});

test('credential header names are case insensitive and query names are case sensitive', async t => {
  const header = await fixture(t, { auth: 'header:x-fixture-key:FIXTURE_REQUIRED' });
  assert.equal((await run(header, request({ auth: 'header:X-Fixture-Key:FIXTURE_REQUIRED' }))).ok, true);
  assert.equal(header.seen[0].requiredHeader, true);
  const query = await fixture(t, { auth: 'query:API_KEY:FIXTURE_REQUIRED' });
  refused(await run(query, request({ auth: 'query:api_key:FIXTURE_REQUIRED' })), query);
});

test('malformed and unsupported credential references are refused before traffic', async t => {
  for (const auth of ['', null, 42, 'basic:FIXTURE_REQUIRED', 'bearer:FIXTURE_REQUIRED:extra']) {
    const f = await fixture(t, { auth: 'bearer:FIXTURE_REQUIRED' });
    refused(await run(f, request({ auth })), f);
  }
});

test('a non-HTTP step cannot silently ignore an imported auth requirement', async t => {
  const f = await fixture(t, { auth: 'bearer:FIXTURE_REQUIRED' });
  const result = await run(f, { protocol: 'graphql', path: '/graphql', auth: 'bearer:FIXTURE_REQUIRED',
    graphql: { query: '{ health }' }, expect: [{ status: 200 }] });
  refused(result, f, 'IMPORTED_AUTH_PROTOCOL_UNSUPPORTED');
});

for (const [auth, received] of [
  ['bearer:FIXTURE_REQUIRED', 'requiredBearer'],
  ['header:X-Fixture-Key:FIXTURE_REQUIRED', 'requiredHeader'],
  ['query:api_key:FIXTURE_REQUIRED', 'requiredQuery'],
]) test(`matching provider configuration dispatches the required ${auth.split(':')[0]} credential`, async t => {
  const f = await fixture(t, { auth });
  const result = await run(f, request({ auth }));
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0][received], true);
});

test('an upstream requirement cannot borrow the primary provider credential', async t => {
  const secondary = await fixture(t);
  const primary = await fixture(t, { auth: 'bearer:FIXTURE_REQUIRED', hosts: { secondary: { baseUrl: secondary.baseUrl } } });
  const result = await run(primary, request({ upstream: 'secondary', auth: 'bearer:FIXTURE_REQUIRED' }));
  refused(result, secondary);
  assert.equal(primary.seen.length, 0);
});

test('ordinary unauthenticated read behavior is preserved when no step requirement exists', async t => {
  const f = await fixture(t, { auth: 'bearer:FIXTURE_REQUIRED' });
  const result = await run(f, request({}), {});
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(f.seen[0].hasAuthorization, false);
});

test('an explicit no-auth step dispatches once on a clean provider with ordinary static headers', async t => {
  const f = await fixture(t, { headers: { 'X-Fixture-Trace': 'public-trace-label' } });
  const result = await run(f, request({ auth: 'none' }));
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].hasAuthorization, false);
  assert.equal(f.seen[0].hasCookie, false);
});

test('an explicit no-auth step refuses configured bearer, header and query credentials without suppressing them', async t => {
  for (const auth of ['bearer:FIXTURE_REQUIRED', 'header:X-Fixture-Key:FIXTURE_REQUIRED', 'query:api_key:FIXTURE_REQUIRED']) {
    const f = await fixture(t, { auth });
    refused(await run(f, request({ auth: 'none' })), f, 'IMPORTED_AUTH_ABSENCE_REQUIRED');
  }
});

test('an explicit no-auth step refuses credential-bearing static headers before traffic', async t => {
  for (const headers of [{ Authorization: `Bearer ${tokens.FIXTURE_REQUIRED}` },
    { 'X-API-Key': tokens.FIXTURE_REQUIRED }, { Cookie: 'fixture_session=synthetic-session' }]) {
    const f = await fixture(t, { headers });
    refused(await run(f, request({ auth: 'none' })), f, ['CONFIG_SECRET_LITERAL', 'IMPORTED_AUTH_ABSENCE_REQUIRED']);
  }
});

test('an explicit no-auth step refuses a session cookie without making another request', async t => {
  const f = await fixture(t, {}, (req, res) => {
    if (req.url === '/seed') res.setHeader('Set-Cookie', 'fixture_session=synthetic-session; Path=/');
  });
  const result = await child(f, `
const seed = await apiRequest(${JSON.stringify(request({ path: '/seed' }))});
const suite = await runEnvelope(${JSON.stringify({ requests: [request({ auth: 'none' })] })});
console.log(JSON.stringify({ seed, suite }));`);
  assert.equal(result.seed.ok, true);
  assert.equal(result.suite.ok, false);
  assert.equal(result.suite.attempted, 0);
  assert.equal(result.suite.results[0].mode, 'refused');
  assert.equal(result.suite.results[0].error?.code, 'IMPORTED_AUTH_ABSENCE_REQUIRED');
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].path, '/seed');
});

test('a no-auth upstream can run while the primary provider retains its own credentials', async t => {
  const secondary = await fixture(t);
  const primary = await fixture(t, { auth: 'bearer:FIXTURE_REQUIRED', hosts: { secondary: { baseUrl: secondary.baseUrl } } });
  const result = await run(primary, request({ upstream: 'secondary', auth: 'none' }));
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(primary.seen.length, 0);
  assert.equal(secondary.seen.length, 1);
  assert.equal(secondary.seen[0].hasAuthorization, false);
});

test('a non-HTTP step cannot silently ignore its explicit no-auth requirement', async t => {
  const f = await fixture(t);
  const result = await run(f, { protocol: 'graphql', path: '/graphql', auth: 'none',
    graphql: { query: '{ health }' }, expect: [{ status: 200 }] });
  refused(result, f, 'IMPORTED_AUTH_PROTOCOL_UNSUPPORTED');
});

test('a no-auth step cannot acquire cookie authentication through a redirect', async t => {
  const f = await fixture(t, {}, req => req.url === '/health'
    ? { status: 302, headers: { location: '/final', 'set-cookie': 'fixture_session=synthetic-session; Path=/' } }
    : { status: 200 });
  const result = await run(f, request({ auth: 'none' }));
  assert.equal(f.seen.length, 1, 'The authenticated redirect must not be sent');
  assert.equal(result.ok, false);
  assert.equal(result.results[0].mode, 'refused');
  assert.equal(result.results[0].error?.code, 'IMPORTED_AUTH_ABSENCE_REQUIRED');
  assert.equal(result.attempted, 1);
});

test('a no-auth step cannot acquire cookie authentication while following pages', async t => {
  const f = await fixture(t, {}, req => req.url === '/health'
    ? { headers: { link: '</next>; rel="next"', 'set-cookie': 'fixture_session=synthetic-session; Path=/' }, body: [{ id: 1 }] }
    : { body: [{ id: 2 }] });
  const result = await run(f, request({ auth: 'none', paginate: 'all' }));
  assert.equal(f.seen.length, 1, 'The authenticated next page must not be sent');
  assert.equal(result.ok, false);
  assert.equal(result.attempted, 1);
});

test('inherited prerequisites retain bounded source provenance and stay unverified after a passing call', async t => {
  const f = await fixture(t);
  const collection = { info: { name: 'setup provenance fixture' },
    event: [{ listen: 'prerequest', script: { exec: ['setup("fixture-setup-body-must-not-persist");'] } }],
    item: [{ name: 'health', request: { method: 'GET', url: f.baseUrl + '/health' },
      event: [{ listen: 'test', script: { exec: ['pm.response.to.have.status(200);'] } }] }] };
  const imported = importPostman(collection, { sourceText: JSON.stringify(collection) });
  assert.equal(imported.suite.requests.length, 1);
  const prepared = prepareImportedTestClaims(imported);
  assert.equal(prepared.prerequisites.length, 1);
  const prerequisite = prepared.prerequisites[0];
  assert.equal(prerequisite.source, 'collection:prerequest');
  assert.match(prerequisite.source_sha256, /^[a-f0-9]{64}$/);
  assert.equal(prerequisite.status, 'unverified');
  assert.equal(prerequisite.verification, 'unverified');
  assert.equal(prerequisite.executable, false);
  assert.equal(JSON.stringify(prepared).includes('fixture-setup-body-must-not-persist'), false);
  saveImportedTestClaims(f.root, prepared);
  const result = await run(f, imported.suite.requests[0], { ...tokens, API_CONTEXT_OFF: '0' });
  assert.equal(result.ok, true);
  assert.equal(result.results[0].test_claim_capture?.verified ?? 0, 0);
  const stored = Object.values(loadContext(f.root).imported_test_claims.sources)[0];
  assert.ok(stored.claims.every(claim => claim.state === 'unverified'));
  assert.ok(stored.prerequisites.every(item => item.verification === 'unverified' && item.executable === false));
});

test('inherited ancillary authentication alone stays unverified after a passing authenticated request', async t => {
  const f = await fixture(t, { auth: 'bearer:POSTMAN_BEARER_TOKEN' });
  writeFileSync(join(f.root, 'collection.bru'), 'auth {\n mode: bearer\n}\nheaders {\n X-Session-Token: synthetic-ancillary-must-not-persist\n}\n');
  writeFileSync(join(f.root, 'health.bru'), `meta {\n name: health\n}\nget {\n url: ${f.baseUrl}/health\n}\nassert {\n res.status: eq 200\n}\n`);
  const imported = importBrunoDirectory(f.root);
  assert.equal(imported.suite.requests.length, 1);
  assert.equal(imported.suite.requests[0].auth, 'bearer:POSTMAN_BEARER_TOKEN');
  const prepared = prepareImportedTestClaims(imported);
  assert.ok(prepared.prerequisites.some(item => item.kind === 'inherited-auth'));
  assert.equal(prepared.prerequisites.some(item => item.kind === 'inherited-setup'), false);
  assert.ok(prepared.claims.every(claim => !claim.conditions.request_case_digest));
  assert.equal(JSON.stringify(prepared).includes('synthetic-ancillary-must-not-persist'), false);
  saveImportedTestClaims(f.root, prepared);
  const result = await run(f, imported.suite.requests[0], { ...tokens, POSTMAN_BEARER_TOKEN: tokens.FIXTURE_REQUIRED, API_CONTEXT_OFF: '0' });
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 1);
  assert.equal(f.seen[0].requiredBearer, true);
  assert.equal(result.results[0].test_claim_capture?.verified ?? 0, 0);
  const stored = Object.values(loadContext(f.root).imported_test_claims.sources)[0];
  assert.ok(stored.claims.every(claim => claim.state === 'unverified'));
  assert.ok(stored.prerequisites.every(item => item.verification === 'unverified' && item.executable === false));
});

test('required-auth refusal cannot borrow a concurrently running ordinary GET', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {}, () => held);
  // Both calls are made in one client instance. The ordinary request starts
  // first; an incorrect coalesced required request would time out this race.
  try {
    const result = await child(f, `
const first = apiRequest(${JSON.stringify(request({}))});
const { existsSync } = await import('node:fs');
const deadline = Date.now() + 2000;
while (!existsSync(${JSON.stringify(f.received)}) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
if (!existsSync(${JSON.stringify(f.received)})) throw new Error('Ordinary request did not reach the loopback fixture');
const second = await Promise.race([
  runEnvelope(${JSON.stringify({ requests: [request({ auth: 'bearer:FIXTURE_REQUIRED' })] })}),
  new Promise(resolve => setTimeout(() => resolve({ wrongCoalescing: true }), 350)),
]);
console.log(JSON.stringify(second));
process.exit(0);`);
    assert.equal(result.wrongCoalescing, undefined);
    assert.equal(result.attempted, 0);
    assert.equal(result.results[0].mode, 'refused');
    assert.equal(result.results[0].error?.code, 'IMPORTED_AUTH_BINDING_REQUIRED');
    assert.equal(f.seen.length, 1);
    assert.equal(f.seen[0].hasAuthorization, false);
  } finally { release(); }
});
