import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { createFixtureStack, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { normalizeSuite } from '../lib/suites.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const returned = 'ek_fixtureReturnedSecret123456789';
const opaque = 'fixtureOpaqueCredential123456789';
const supplied = 'fixtureConfiguredCredential123456789';
const awsUrl = 'https://uploads.example.test/object?X-Amz-Credential=AKIAFIXTURE1234567890%2F20261022%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=' + 'a'.repeat(64);
const googleUrl = 'https://uploads.example.test/object?X-Goog-Credential=upload%40fixture.iam.gserviceaccount.com%2F20261022%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Signature=' + 'b'.repeat(64);
const legacyAwsUrl = 'https://uploads.example.test/object?AWSAccessKeyId=AKIAFIXTURE1234567890&Expires=1800000000&Signature=' + 'A'.repeat(32);
const legacyGoogleUrl = 'https://uploads.example.test/object?GoogleAccessId=upload%40fixture.iam.gserviceaccount.com&Expires=1800000000&Signature=' + 'B'.repeat(32);
const azureUrl = 'https://uploads.example.test/object?sv=2025-01-05&se=2026-10-23T00%3A00%3A00Z&sp=cw&sr=b&sig=' + 'C'.repeat(32);
const signedPayload = { presignedUrl: awsUrl, googleUrl, legacyAwsUrl, legacyGoogleUrl, azureUrl, badUrl: awsUrl + '&access_token=fixtureOtherCredential123456', token: opaque };
const payload = { client_secret: returned, token: opaque, echo: opaque, harmless: 'ordinary response text' };
async function fixture(t, { auth = false, staticType, credential = supplied, budget = '8000' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-addendum-'));
  mkdirSync(join(root, 'home'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    import { appendFileSync } from 'node:fs';
    const server = createServer(async (req, res) => {
      appendFileSync(${JSON.stringify(join(root, 'calls'))}, req.url + '\\n');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = req.url.endsWith('/keys') ? { [${JSON.stringify(returned)}]: 'ordinary', [req.headers.authorization?.slice(7) ?? 'safe']: 'other', harmless: 'ordinary' }
        : req.url.endsWith('/many') ? Array.from({length: 40}, () => ({ token: ${JSON.stringify(opaque)}, payload: 'x'.repeat(1300) }))
        : req.url.endsWith('/signed') ? ${JSON.stringify(signedPayload)}
        : req.url.endsWith('/configured') ? { echo: req.headers.authorization, literal: '[redacted]' }
        : req.url.endsWith('/clean') ? { literal: '[withheld: secret; salted-sha256:' + 'a'.repeat(64) + ']', harmless: 'ordinary' }
        : { ...${JSON.stringify(payload)}, ...(req.headers.authorization ? { auth_echo: req.headers.authorization } : {}) };
      if (req.url === '/slow') await new Promise(resolve => setTimeout(resolve, 100));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/summary' ? { token: body.token, message: body.echo, count: 120, results: Array.from({ length: 120 }, () => ({ state: 'ready', [body.client_secret]: 'ordinary', content: 'x'.repeat(1000) })) }
        : req.url.startsWith('/graphql') ? { data: body }
        : req.url === '/echo' ? { type: req.headers['content-type'], raw } : body));
    });
    server.listen(0, '127.0.0.1', () => process.send({ origin: 'http://127.0.0.1:' + server.address().port }));
    process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit()); });
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const [{ origin }] = await once(child, 'message');
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } rmSync(root, { recursive: true, force: true }); });
  createFixtureStack(root, { name: 'one', baseUrl: origin, environmentConfig: {
    ...(auth ? { auth: 'bearer:FIXTURE_TOKEN' } : {}), ...(staticType ? { headers: { 'content-type': staticType } } : {}) } });
  createFixtureStack(root, { name: 'two', baseUrl: `${origin}/second` });
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'), API_CONTEXT_DIR: root,
    API_BUDGET: budget, API_CONTEXT_OFF: '1', API_FRICTION_OFF: '1', API_USAGE_LOG: join(root, 'usage.jsonl'), NO_COLOR: '1',
    ...(auth ? { FIXTURE_TOKEN: credential } : {}) };
  async function execute(input, { cli = false, flags = [], cliArgs } = {}) {
    const args = cliArgs ? [join(source, 'bin/cli.mjs'), ...cliArgs] : cli ? [join(source, 'bin/cli.mjs'), 'protocol', join(root, 'input.json'), ...flags]
      : ['--input-type=module', '-e', `const {apiRequest,runEnvelope}=await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)}); let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);console.log(JSON.stringify(await (input.parallel?Promise.all(input.parallel.map(request=>apiRequest(request))):input.requests?runEnvelope(input):apiRequest(input))));`];
    if (cli) writeFileSync(join(root, 'input.json'), JSON.stringify(input));
    const proc = spawn(process.execPath, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; proc.stdout.on('data', c => stdout += c); proc.stderr.on('data', c => stderr += c);
    proc.stdin.end(cli ? '' : JSON.stringify(input)); const [code] = await once(proc, 'close');
    return { code, stderr, stdout, result: stdout.trim() ? JSON.parse(stdout) : null };
  }
  return { root, execute, evidence: result => JSON.parse(readFileSync(join(root, fixtureEvidencePath(result.stack), `${result.evidence}.json`), 'utf8')) };
}
function masked(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(returned), 'returned secret reached the agent');
  assert.ok(!text.includes(opaque), 'opaque token or its alias reached the agent');
  assert.match(text, /withheld: secret/);
}
const http = { stack: 'one', protocol: 'http', path: '/response' };
const graphql = { stack: 'one', protocol: 'graphql', path: '/graphql', graphql: { document: 'query { client_secret token echo harmless }' } };

for (const [name, request] of [['HTTP', http], ['GraphQL', graphql]]) {
  test(`CONTEXT-2a addendum: ${name} data masks returned credentials by default; explicit reveal never unmasks evidence`, async t => {
    const f = await fixture(t, { auth: true });
    const hidden = await f.execute(request); assert.equal(hidden.result.ok, true, hidden.stdout + hidden.stderr); masked(hidden.result.data);
    assert.equal((hidden.result.data.data ?? hidden.result.data).harmless, payload.harmless);
    masked(f.evidence(hidden.result).response.body);
    const visible = await f.execute({ ...request, reveal_secrets: true });
    const data = visible.result.data.data ?? visible.result.data;
    assert.equal(data.client_secret, returned); assert.equal(data.token, opaque);
    assert.ok(!JSON.stringify(visible.result).includes(supplied), 'configured auth must stay scrubbed even with reveal');
    masked(f.evidence(visible.result).response.body);
  });
  test(`CONTEXT-2a addendum: ${name} projections and failed assertions cannot bypass returned-secret masking`, async t => {
    const f = await fixture(t);
    const projected = await f.execute({ ...request, fields: [name === 'HTTP' ? 'echo' : 'data'] });
    masked(projected.result.data);
    const failed = await f.execute({ ...request, expect: [{ json: name === 'HTTP' ? 'client_secret' : 'data.client_secret', equals: 'different' }] });
    assert.equal(failed.result.assertions.failed, 1); masked(failed.result.data);
    assert.ok(!JSON.stringify(failed.result.assertions).includes(returned), 'failed assertion echoed returned credential');
    const checked = await f.execute({ ...request, expect: [{ json: name === 'HTTP' ? 'client_secret' : 'data.client_secret', equals: returned }] });
    assert.equal(checked.result.assertions.passed, 1, 'assertions must see the original response');
  });
}

test('CONTEXT-2a addendum: batch reveal is explicit, inherited and can be disabled per request', async t => {
  const f = await fixture(t);
  const out = await f.execute({ stack: 'one', reveal_secrets: true, requests: [{ path: '/response' }, { path: '/response', reveal_secrets: false }] });
  assert.equal(out.result.results[0].data.client_secret, returned);
  masked(out.result.results[1].data); out.result.results.forEach(result => masked(f.evidence(result).response.body));
});
test('CONTEXT-2a addendum: malformed reveal refuses before any traffic, including later batch steps', async t => {
  const f = await fixture(t);
  for (const input of [{ ...http, reveal_secrets: 'yes' }, { stack: 'one', requests: [{ path: '/response' }, { path: '/response', reveal_secrets: 'yes' }] }]) {
    const out = await f.execute(input); assert.equal(out.result.error?.code, 'REVEAL_SECRETS_INVALID');
  }
  assert.throws(() => readFileSync(join(f.root, 'calls')), { code: 'ENOENT' });
});
test('CONTEXT-2a addendum: CLI protocol accepts envelope stack with no default, just like the client', async t => {
  const f = await fixture(t);
  const input = { stack: 'two', requests: [{ protocol: 'http', path: '/response', expect: [{ status: 200 }] }] };
  const direct = await f.execute(input), cli = await f.execute(input, { cli: true });
  assert.equal(cli.code, 0, cli.stdout + cli.stderr); assert.equal(cli.result.results[0].stack, 'two');
  assert.equal(direct.result.results[0].stack, cli.result.results[0].stack);
});
test('CONTEXT-2a addendum: CLI protocol honors a single-request stack and refuses conflicting CLI selection', async t => {
  const f = await fixture(t);
  const good = await f.execute({ ...http, expect: [{ status: 200 }] }, { cli: true });
  assert.equal(good.code, 0, good.stdout + good.stderr);
  const conflict = await f.execute(http, { cli: true, flags: ['--stack', 'two'] });
  assert.notEqual(conflict.code, 0); assert.match(conflict.stderr + conflict.stdout, /STACK_SELECTOR_CONFLICT/);
});
test('CONTEXT-2a addendum: explicit request or static stack content type overrides JSON/form defaults without changing encoding', async t => {
  const f = await fixture(t, { staticType: 'application/custom-static' });
  for (const body_type of ['json', 'form']) {
    const request = { stack: 'one', method: 'POST', path: '/echo', body_type, body: { hello: 'world' } };
    const inherited = await f.execute(request), explicit = await f.execute({ ...request, headers: { 'Content-Type': 'application/custom-request' } });
    assert.equal(inherited.result.data.type, 'application/custom-static'); assert.equal(explicit.result.data.type, 'application/custom-request');
    assert.equal(inherited.result.data.raw, body_type === 'form' ? 'hello=world' : JSON.stringify(request.body));
    assert.equal(explicit.result.data.raw, inherited.result.data.raw);
  }
});

test('CONTEXT-2a addendum: concurrent revealed and masked requests never share an unmasked envelope', async t => {
  const f = await fixture(t);
  const out = await f.execute({ parallel: [{ ...http, path: '/slow', reveal_secrets: true }, { ...http, path: '/slow' }] });
  assert.equal(out.result[0].data.client_secret, returned); masked(out.result[1].data);
});

test('CONTEXT-2a addendum: response summaries mask pagination metadata and credential-shaped property names', async t => {
  const f = await fixture(t), out = await f.execute({ ...http, path: '/summary' });
  assert.equal(out.result.mode, 'summary'); masked(out.result);
  assert.equal(out.result.discovery.pagination.count, 120);
});
test('CONTEXT-2a addendum: saved suites preserve explicit reveal through run and verify', async t => {
  const f = await fixture(t);
  const input = { stack: 'one', reveal_secrets: true, requests: [
    { path: '/response', expect: [{ json: 'client_secret', exists: false }] },
    { path: '/response', reveal_secrets: false, expect: [{ json: 'client_secret', exists: false }] },
  ] };
  assert.equal(normalizeSuite('reveal', input).suite.reveal_secrets, true);
  writeFileSync(join(f.root, 'suite-input.json'), JSON.stringify(input));
  const saved = await f.execute(null, { cliArgs: ['suite', 'save', 'reveal', 'suite-input.json', '--stack', 'one'] });
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  for (const args of [['suite', 'run', 'reveal'], ['verify', 'reveal', '--read-only']]) {
    const ran = await f.execute(null, { cliArgs: [...args, '--stack', 'one', '--json'] });
    assert.equal(ran.code, 1, 'both assertions intentionally fail');
    const steps = ran.result.suites[0].steps;
    assert.equal(steps[0].failures[0].actual, returned); masked(steps[1].failures);
  }
});

for (const protocol of ['http', 'graphql']) {
  const request = path => protocol === 'http' ? { stack: 'one', path }
    : { stack: 'one', protocol, path: '/graphql' + path, graphql: { document: 'query { presignedUrl googleUrl token }' } };
  const dataOf = result => protocol === 'http' ? result.data : result.data?.data;
  test(`MASK-1 ${protocol}: signed upload URLs remain usable while evidence and unrelated credentials stay masked`, async t => {
    const f = await fixture(t), result = (await f.execute(request('/signed'))).result;
    const data = dataOf(result);
    assert.equal(data.presignedUrl, awsUrl); assert.equal(data.googleUrl, googleUrl);
    assert.equal(data.legacyAwsUrl, legacyAwsUrl); assert.equal(data.legacyGoogleUrl, legacyGoogleUrl); assert.equal(data.azureUrl, azureUrl);
    assert.match(data.badUrl, /withheld: secret/); assert.match(data.token, /withheld: secret/);
    assert.deepEqual(result.data_secrets, { replacements: 2, reveal: 'reveal_secrets' });
    const record = JSON.stringify(f.evidence(result));
    assert.ok(!record.includes('AKIAFIXTURE')); assert.ok(!record.includes('gserviceaccount.com'));
    assert.ok(!record.includes(opaque));
  });
  test(`MASK-1 ${protocol}: receipts describe visible masking, including configured auth, without trusting marker-looking content`, async t => {
    const f = await fixture(t, { auth: true });
    const masked = (await f.execute(request('/response'))).result;
    assert.equal(masked.data_secrets.reveal, 'reveal_secrets'); assert.equal(masked.data_secrets.replacements, 4);
    const configured = (await f.execute({ ...request('/configured'), reveal_secrets: true })).result;
    assert.deepEqual(configured.data_secrets, { replacements: 1, reveal: 'reveal_secrets' });
    assert.ok(!JSON.stringify(configured).includes(supplied)); assert.equal(dataOf(configured).literal, '[redacted]');
    const clean = (await f.execute(request('/clean'))).result; assert.equal(clean.data_secrets, undefined);
    const checked = (await f.execute({ ...request('/response'), expect: [{ status: 200 }] })).result;
    assert.equal(checked.data, null); assert.equal(checked.data_secrets, undefined);
  });
}
test('MASK-1 HTTP: a clean projection has no receipt and a masked projection counts only its own replacements', async t => {
  const f = await fixture(t);
  const clean = (await f.execute({ ...http, fields: ['harmless'] })).result;
  assert.equal(clean.data_secrets, undefined);
  const masked = (await f.execute({ ...http, fields: ['token'] })).result;
  assert.deepEqual(masked.data_secrets, { replacements: 1, reveal: 'reveal_secrets' });
  const revealed = (await f.execute({ ...http, reveal_secrets: true })).result;
  assert.equal(revealed.data_secrets, undefined);
});

test('MASK-1: signed URL allowance does not bypass userinfo, unrelated credentials, aliases or credential-named fields', async () => {
  const { sanitizeResponsePresentation } = await import('../lib/response-redaction.mjs');
  for (const url of [awsUrl + '&password=x', awsUrl + '&auth=Bearer%20' + supplied,
    awsUrl.replace('uploads.example.test', 'user:password@uploads.example.test'), awsUrl + '&X-Amz-Credential=duplicate',
    awsUrl + '#token=' + opaque, awsUrl + '&other=' + opaque,
    'https://uploads.example.test/object?sig=' + 'a'.repeat(64)]) {
    const shown = sanitizeResponsePresentation({ url, token: opaque }, null);
    assert.match(shown.body.url, /withheld: secret/);
  }
  const named = sanitizeResponsePresentation({ access_token: awsUrl, upload: awsUrl }, null);
  assert.match(named.body.access_token, /withheld: secret/); assert.equal(named.body.upload, awsUrl);
});
for (const protocol of ['http', 'graphql']) {
  test(`MASK-1 ${protocol}: key replacements and short configured auth are counted without corrupting receipt names`, async t => {
    const f = await fixture(t, { auth: true, credential: 'reveal_secrets' });
    const request = protocol === 'http' ? { stack: 'one', path: '/keys' }
      : { stack: 'one', protocol, path: '/graphql/keys', graphql: { document: 'query { harmless }' } };
    const result = (await f.execute(request)).result;
    // HTTP masks the credential-named reveal_secrets value before its final
    // configured-auth scrub; adapters scrub that key first. Both key changes
    // count, plus the additional value actually withheld by HTTP.
    assert.deepEqual(result.data_secrets, { replacements: protocol === 'http' ? 3 : 2, reveal: 'reveal_secrets' });
    assert.ok(!JSON.stringify(result.data).includes(returned));
    const short = await fixture(t, { auth: true, credential: 'ab' });
    const configured = (await short.execute({ ...request, path: protocol === 'http' ? '/configured' : '/graphql/configured', reveal_secrets: true })).result;
    assert.deepEqual(configured.data_secrets, { replacements: 1, reveal: 'reveal_secrets' });
  });
}
test('MASK-1: budget trimming removes receipts when data is omitted and counts only retained sample rows', async t => {
  const f = await fixture(t, { budget: '800' });
  const trimmed = (await f.execute({ stack: 'one', path: '/many' })).result;
  assert.equal(trimmed.data.length, 1);
  assert.deepEqual(trimmed.data_secrets, { replacements: 1, reveal: 'reveal_secrets' });
  const small = await fixture(t, { budget: '200' });
  for (const request of [{ stack: 'one', path: '/many' }, { stack: 'one', protocol: 'graphql', path: '/graphql/many', graphql: { document: 'query { token }' } }]) {
    const result = (await small.execute(request)).result;
    assert.equal(result.data, null); assert.equal(result.data_secrets, undefined);
  }
});
