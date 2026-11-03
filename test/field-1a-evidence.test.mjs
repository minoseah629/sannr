import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';

const ephemeral = 'ek_fixtureEphemeralSecret123456789';
const webhook = 'whsec_fixtureSigningSecret123456789';
const opaque = 'fixtureOpaqueCredential123456789';
const payload = { client_secret: { value: ephemeral, expires_at: 100 }, nested: [{ signing_secret: webhook }],
  token: opaque, echoed_opaque: opaque, harmless: 'keep this ordinary response text' };

async function fixture(t, { credential } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'field-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const payload = ${JSON.stringify(payload)};
    const server = createServer((req, res) => {
      let type = 'application/json', body = JSON.stringify(payload);
      if (req.url === '/text') { type = 'text/plain'; body = 'secret: ${opaque}'; }
      if (req.url === '/json-string') body = JSON.stringify(JSON.stringify(payload));
      if (req.url === '/base64') body = JSON.stringify({ raw_base64: Buffer.from(JSON.stringify(payload)).toString('base64') });
      if (req.url === '/binary') { type = 'application/octet-stream'; body = '${webhook}'; }
      if (req.url === '/raw-base64') { type = 'application/octet-stream'; body = Buffer.from(JSON.stringify(payload)).toString('base64'); }
      if (req.url.startsWith('/pages')) body = JSON.stringify({ data: [{ secret: '${opaque}' }], next: req.url.includes('?') ? null : '/pages?page=2' });
      if (req.url === '/safe') body = JSON.stringify({ okay: true });
      if (req.url === '/graphql') body = JSON.stringify({ data: payload });
      if (req.url === '/graphql-dense') body = JSON.stringify({ data: { rows: Array.from({length:129}, (_, i) => ({token:'syntheticOpaque'+i+'Credential'})) } });
      res.writeHead(200, {'content-type': type}); res.end(body);
    });
    server.listen(0, '127.0.0.1', () => process.send({ origin: 'http://127.0.0.1:' + server.address().port }));
    process.on('message', () => server.close(() => process.exit()));
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
  const origin = await new Promise((resolve, reject) => { server.once('message', x => resolve(x.origin)); server.once('error', reject); });
  t.after(async () => { const stopped = new Promise(resolve => server.once('exit', resolve)); server.send('stop'); await stopped; });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture', version: '1' }, paths: {
    '/safe': { get: { responses: { 200: { description: 'okay' } } } },
    '/bad?variant=one': { get: { responses: { 200: { description: 'unsupported literal query' } } } },
  } }));
  createFixtureStack(root, { baseUrl: origin, contract: 'openapi.json',
    ...(credential ? { environmentConfig: { auth: 'bearer:FIXTURE_EVIDENCE_TOKEN' } } : {}) });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine/usage.jsonl'), API_FRICTION_OFF: '1', NO_COLOR: '1' };
  if (credential) env.FIXTURE_EVIDENCE_TOKEN = credential;
  mkdirSync(env.HOME);
  return { root, env };
}

async function requests(f, paths, options = {}) {
  const script = `${options.closeStderr ? "import { closeSync } from 'node:fs'; closeSync(2);" : ''}
    const { apiRequest } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});
    const results = [];
    for (const path of ${JSON.stringify(paths)}) results.push(await apiRequest({ path, method:'GET', stack:'fixture',
      expect:[{status:200}], ...(path === '/pages' ? {paginate:'all'} : {}),
      ...${JSON.stringify(options.saveTo ? { save_to: options.saveTo } : {})},
      ...(path === '/graphql' ? {method:undefined, protocol:'graphql', graphql:{document:'query { client_secret { value } }'},
        expect:[{json:'data.client_secret.value', equals:'different'}]} : {}),
      ...(path === '/graphql-dense' ? {method:undefined, protocol:'graphql', graphql:{document:'query { rows { token } }'}} : {}) }));
    process.stdout.write(JSON.stringify(results));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const exit = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  return { exit, stdout, stderr, results: exit === 0 ? JSON.parse(stdout) : null };
}
const evidence = (f, id) => JSON.parse(readFileSync(join(f.root, '.sannr/evidence/fixture', `${id}.json`), 'utf8'));
function sanitized(record) {
  const text = JSON.stringify(record);
  for (const value of [ephemeral, webhook, opaque]) assert.ok(!text.includes(value), 'a synthetic credential leaked into evidence');
  assert.equal(record.response.body_secrets?.replaced, true);
  assert.ok(record.response.body_secrets.replacements > 0);
  assert.match(text, /\[withheld: secret; salted-sha256:[a-f0-9]{64}\]/);
}

test('FIELD-1a evidence scrubs returned client and signing secrets, keeps ordinary structure, salts every run', async t => {
  const f = await fixture(t), result = await requests(f, ['/json', '/json']);
  assert.equal(result.exit, 0, result.stderr);
  const records = result.results.map(x => evidence(f, x.evidence));
  records.forEach(sanitized);
  assert.equal(records[0].response.body.harmless, payload.harmless);
  assert.equal(records[0].response.body.token, records[0].response.body.echoed_opaque);
  assert.notEqual(records[0].response.body.client_secret.value, records[1].response.body.client_secret.value);
  assert.ok(result.results.every(x => x.assertions.passed === 1), 'sanitization must not alter assertion inputs');
});

test('FIELD-1a evidence replacement metadata keeps its schema when a configured credential matches its field name', async t => {
  const f = await fixture(t, { credential: 'replaced' }), result = await requests(f, ['/json']);
  assert.equal(result.exit, 0, result.stderr);
  sanitized(evidence(f, result.results[0].evidence));
});

for (const path of ['/text', '/json-string', '/base64', '/binary', '/raw-base64']) {
  test(`FIELD-1a evidence secret scanning cannot be bypassed through ${path}`, async t => {
    const f = await fixture(t), result = await requests(f, [path]);
    assert.equal(result.exit, 0, result.stderr);
    const record = evidence(f, result.results[0].evidence);
    sanitized(record);
    if (result.results[0].binary?.saved_to) {
      const saved = readFileSync(result.results[0].binary.saved_to, 'utf8');
      assert.match(saved, /withheld: secret/); assert.ok(!saved.includes(webhook));
    }
  });
}

test('FIELD-1a every pagination page applies evidence secret protection', async t => {
  const f = await fixture(t), result = await requests(f, ['/pages']);
  assert.equal(result.exit, 0, result.stderr);
  sanitized(evidence(f, result.results[0].evidence));
  sanitized(evidence(f, `${result.results[0].evidence}-p2`));
});

test('FIELD-1a explicit binary save_to preserves requested bytes while automatic evidence remains sanitized', async t => {
  const f = await fixture(t), target = join(f.root, 'download.bin');
  const result = await requests(f, ['/binary'], { saveTo: target });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(readFileSync(target, 'utf8'), webhook);
  sanitized(evidence(f, result.results[0].evidence));
  assert.equal(result.results[0].binary.saved_unredacted, true);
  assert.equal(result.results[0].binary.sha256, null);
  assert.equal(result.results[0].binary.sha256_withheld, true);
});

test('FIELD-1a protocol evidence also scrubs response-derived failed assertion values', async t => {
  const f = await fixture(t), result = await requests(f, ['/graphql']);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.results[0].assertions?.failed, 1, result.stdout);
  sanitized(evidence(f, result.results[0].evidence));
});

test('FIELD-1a dense protocol evidence retains status, assertion counts and its whole-body marker', async t => {
  const f = await fixture(t), result = await requests(f, ['/graphql-dense']);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[0].assertions.passed, 1);
  const record = evidence(f, result.results[0].evidence);
  assert.equal(record.response.status, 200);
  assert.equal(record.response.ok, true);
  assert.equal(record.response.outcome, 'success');
  assert.equal(record.response.complete, true);
  assert.equal(record.assertions.passed, 1);
  assert.equal(record.assertions.failed, 0);
  assert.equal(record.response.body_secrets.replaced, true);
  assert.match(record.response.body, /^\[withheld: secret; salted-sha256:/);
  assert.equal(record.assertions.details_withheld, record.response.body);
  assert.doesNotMatch(JSON.stringify(record), /syntheticOpaque\d+Credential/);
});

test('CLI-001 contract diagnostics print once per process across repeated runtime bindings', async t => {
  const f = await fixture(t), result = await requests(f, ['/safe', '/safe', '/safe']);
  assert.equal(result.exit, 0, result.stderr);
  assert.equal((result.stderr.match(/HTTP_CONTRACT_ROUTE_SKIPPED/g) ?? []).length, 1, result.stderr);
  result.results.forEach(x => assert.equal(evidence(f, x.evidence).response.status, 200));
});

test('CLI-001 closing stderr cannot abort the request or its evidence write', async t => {
  const f = await fixture(t), result = await requests(f, ['/safe'], { closeStderr: true });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(evidence(f, result.results[0].evidence).response.status, 200);
});

test('FIELD-1a evidence scanner bounds dense credential aliases and preserves clean binary bytes', async () => {
  const { sanitizeEvidenceBody } = await import('../lib/response-redaction.mjs');
  const rows = Array.from({ length: 129 }, (_, i) => ({ token: `syntheticOpaque${i}Credential` }));
  const dense = sanitizeEvidenceBody({ response: rows });
  assert.equal(typeof dense.body, 'string');
  assert.match(dense.body, /^\[withheld: secret; salted-sha256:/);
  assert.equal(dense.body_secrets.replaced, true);
  const bytes = Buffer.from([0, 1, 2, 255, 128]);
  assert.deepEqual(sanitizeEvidenceBody(bytes), { body: bytes, body_secrets: { replaced: false, replacements: 0 } });
  const unicode = sanitizeEvidenceBody({ token: 'syntheticOpaqueCredential\ud800', echo: 'syntheticOpaqueCredential\ud800' });
  assert.equal(unicode.body.token, unicode.body.echo);
});
