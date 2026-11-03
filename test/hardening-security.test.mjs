import { LAYOUT } from "../lib/layout.mjs";
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, mkdirSync,  readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { promoteObservation } from '../lib/promote.mjs';
import { promotionPreview } from '../lib/context.mjs';
import { unsafePattern, checkOne, PATTERN_INPUT_MAX_CHARS } from '../lib/assertions.mjs';
import { validateToolArgs } from '../lib/mcp-facts.mjs';
import { normalizeSuite } from '../lib/suites.mjs';
import { importKong, importPostman } from '../lib/import.mjs';
import { createPostmanClient, scrubCaptured, capturePostman } from '../lib/postman.mjs';
import { flattenPostmanWorkspace, writeFlattenedWorkspace } from '../lib/postman-workspace.mjs';
import { buildFeedback, renderFeedback } from '../lib/feedback.mjs';
import { inspectShellHttp } from '../lib/claude-hook.mjs';
import { appendCiSummary } from '../lib/ci.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const synthetic = 'PMAK-' + 'fixture-only-credential';
const project = t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hardening-security-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const cleanEnv = root => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:API_|SANNR_|FLEET_|POSTMAN_)/.test(k))),
  HOME: root, USERPROFILE: root, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '1', API_FRICTION_OFF: '1',
  API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_BASE_URL: 'https://api.example.test',
});
function probe(t, body, extra = {}, prepare = () => {}) {
  const root = project(t); prepare(root);
  const script = `import assert from 'node:assert/strict';
    import * as fs from 'node:fs'; import { join } from 'node:path';
    const root = process.cwd(); ${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { ...cleanEnv(root), ...extra }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.error?.code ?? result.stderr);
  return root;
}
const clientImport = `const { apiRequest, TOKEN_CACHE } = await import(${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)});`;
const collection = { info: { name: 'sample', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [
  { name: 'read', request: { method: 'GET', url: '/items' }, response: [{ code: 200 }] },
] };
function setEnv(t, name, value) {
  const previous = process.env[name]; process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test('H1-01 promotion scans enum values, shape keys, and refusal identities', () => {
  const out = promoteObservation({ observed: { fieldValues: { state: [synthetic] } }, contract: { properties: { state: { enum: [synthetic] } } } });
  assert.equal(JSON.stringify(out).includes(synthetic), false);
  const preview = promotionPreview({ op: 'GET /items', body: { [synthetic]: 'ordinary', nested: { [synthetic]: true } }, status: 200 });
  assert.equal(JSON.stringify(preview).includes(synthetic), false);
});

test('H1-02 assertion and MCP patterns refuse ambiguous repetition before evaluation', t => {
  for (const pattern of ['(a|aa)+$', '(a{1,3})+$', 'a+a+a+a+$', 'a?'.repeat(40) + 'a'.repeat(40)]) {
    assert.notEqual(unsafePattern(pattern), null, pattern);
    assert.equal(normalizeSuite('unsafe', { requests: [{ path: '/', expect: [{ json: 'x', matches: pattern }] }] }).problems[0]?.code, 'SUITE_PATTERN_REFUSED');
    assert.throws(() => validateToolArgs({ x: 'a'.repeat(40) + '!' }, { type: 'object', properties: { x: { type: 'string', pattern } } }), { code: 'MCP_ARGS_INVALID' });
  }
  probe(t, `const { checkOne } = await import(${JSON.stringify(new URL('../lib/assertions.mjs', import.meta.url).href)});
    const result = checkOne({ json: 'x', matches: '(a|aa)+$' }, { body: { x: 'a'.repeat(48) + '!' } });
    assert.equal(result.ok, false);`);
});

test('H1-02b MCP tool argument pattern accepts the input bound and refuses one more before evaluation', t => {
  const pattern = '^[a-z]+$';
  const schema = { type: 'object', properties: { q: { type: 'string', pattern } }, required: ['q'] };
  const evaluatedLengths = [], original = RegExp.prototype.test;
  t.mock.method(RegExp.prototype, 'test', function (value) {
    if (this.source === pattern) evaluatedLengths.push(value.length);
    return original.call(this, value);
  });
  assert.doesNotThrow(() => validateToolArgs({ q: 'a'.repeat(PATTERN_INPUT_MAX_CHARS) }, schema));
  assert.throws(() => validateToolArgs({ q: 'a'.repeat(PATTERN_INPUT_MAX_CHARS + 1) }, schema), error => {
    assert.equal(error.code, 'MCP_ARGS_INVALID');
    assert.match(error.message, /unsupported pattern input length at 'q'/);
    assert.equal(error.message.includes('a'.repeat(32)), false);
    return true;
  });
  assert.deepEqual(evaluatedLengths, [PATTERN_INPUT_MAX_CHARS]);
});

test('H1-03 assertions never accept inherited fields or operator names', () => {
  assert.equal(checkOne({ json: 'constructor', exists: true }, { body: {} }).ok, false);
  assert.equal(checkOne({ json: 'x', toString: true }, { body: { x: 1 } }).ok, false);
  assert.equal(checkOne({ json: '__proto__.accepted', exists: true }, { body: Object.create({ accepted: true }) }).ok, false);
});

test('H1-04 save_to refuses a symlink above an existing parent before fetching', t => {
  probe(t, `let calls = 0; globalThis.fetch = async () => { calls++; return new Response('bytes', { headers: { 'content-type': 'application/octet-stream' } }); };
    ${clientImport}
    await assert.rejects(apiRequest({ path: '/file', save_to: join(root, 'alias', 'nested', 'out.bin') }), { code: 'SAVE_TO_UNSAFE_PATH' });
    assert.equal(calls, 0); assert.equal(fs.existsSync(join(root, 'outside', 'nested', 'out.bin')), false);`, {}, root => {
    mkdirSync(join(root, 'outside', 'nested'), { recursive: true }); symlinkSync(join(root, 'outside'), join(root, 'alias'));
  });
});

test('H1-04 CLI feedback and map outputs refuse linked leaves', t => {
  const root = project(t), target = join(root, 'protected'); writeFileSync(target, 'preserve');
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture', version: '1' }, paths: { '/items': { get: { responses: { '200': { description: 'ok' } } } } } }));
  for (const command of [['feedback', '--out', 'out.md'], ['map', '.', '--no-execute', '--out', 'out.md']]) {
    symlinkSync(target, join(root, 'out.md'));
    const result = spawnSync(process.execPath, [join(repo, 'bin/cli.mjs'), ...command], { cwd: root, env: cleanEnv(root), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /OUTPUT_UNSAFE_PATH/);
    assert.equal(readFileSync(target, 'utf8'), 'preserve'); rmSync(join(root, 'out.md'));
  }
});

test('H1-04 importer preflights every sidecar before writing the suite', t => {
  const root = project(t), target = join(root, 'protected'); writeFileSync(target, '{}');
  mkdirSync(join(root, LAYOUT.suites), { recursive: true }); writeFileSync(join(root, 'source.json'), JSON.stringify(collection));
  symlinkSync(target, join(root, LAYOUT.suites, 'sample.provenance.json'));
  const result = spawnSync(process.execPath, [join(repo, 'bin/cli.mjs'), 'import', 'source.json'], { cwd: root, env: cleanEnv(root), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /OUTPUT_UNSAFE_PATH/);
  assert.equal(readFileSync(target, 'utf8'), '{}'); assert.equal(existsSync(join(root, LAYOUT.suites, 'sample.json')), false);
});

test('H1-04 workspace writer refuses linked sidecars without a partial batch', t => {
  const root = project(t), target = join(root, 'protected'); writeFileSync(target, 'preserve');
  const out = join(root, 'out'); mkdirSync(out); symlinkSync(target, join(out, 'sample.report.md'));
  assert.throws(() => writeFlattenedWorkspace(out, flattenPostmanWorkspace({ collections: [collection] }), { direct: true }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(readFileSync(target, 'utf8'), 'preserve'); assert.equal(existsSync(join(out, 'sample.json')), false);
});

test('H1-04 CI summary refuses a symlink above its parent', t => {
  const root = project(t); mkdirSync(join(root, 'outside', 'nested'), { recursive: true });
  symlinkSync(join(root, 'outside'), join(root, 'alias'));
  assert.throws(() => appendCiSummary(join(root, 'alias', 'nested', 'summary.md'), 'section'), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(existsSync(join(root, 'outside', 'nested', 'summary.md')), false);
});

test('H1-05 Kong suite names cannot escape the declared directory', t => {
  const root = project(t); writeFileSync(join(root, 'kong.json'), JSON.stringify({ _format_version: '3.0', routes: [{ paths: ['/items'] }] }));
  const result = spawnSync(process.execPath, [join(repo, 'bin/cli.mjs'), 'import', 'kong', 'kong.json', '--suite', '../escaped'], { cwd: root, env: cleanEnv(root), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /SUITE_NAME_INVALID/); assert.equal(existsSync(join(root, 'escaped.json')), false);
});

test('H1-06 Postman refuses redirects before a credential can follow', async t => {
  setEnv(t, 'POSTMAN_API_KEY', 'synthetic-private-key'); let calls = 0;
  const client = createPostmanClient({ retries: 0, fetchImpl: async (url, init) => {
    calls++; assert.equal(init.redirect, 'manual'); return new Response(null, { status: 307, headers: { location: 'https://untrusted.example.test/' } });
  } });
  await assert.rejects(client.me, { code: 'POSTMAN_REDIRECT_REFUSED' }); assert.equal(calls, 1);
});

const oauthEnv = { API_AUTH: 'oauth:TEST_CLIENT_ID:TEST_CLIENT_SECRET', TEST_CLIENT_ID: 'fixture-client', TEST_CLIENT_SECRET: 'opaque-private-fixture', API_OAUTH_TOKEN_URL: 'https://auth.example.test/token' };
test('H1-06 OAuth refuses redirects before a credential can follow', t => {
  probe(t, `globalThis.fetch = async (url, init) => { assert.equal(init.redirect, 'manual'); return new Response(null, { status: 307 }); };
    ${clientImport} const result = await apiRequest({ path: '/items' }); assert.equal(result.error.code, 'OAUTH_REDIRECT_REFUSED');`, oauthEnv);
});

test('H1-07 OAuth refusal never repeats server diagnostics or echoed credentials', t => {
  probe(t, `globalThis.fetch = async () => new Response(JSON.stringify({ error: 'private-upstream-diagnostic', error_description: process.env.TEST_CLIENT_SECRET }), { status: 400 });
    ${clientImport} const result = await apiRequest({ path: '/items' }); assert.equal(result.error.code, 'OAUTH_GRANT_REJECTED');
    assert.equal(JSON.stringify(result).includes(process.env.TEST_CLIENT_SECRET), false);
    assert.equal(JSON.stringify(result).includes('private-upstream-diagnostic'), false);`, oauthEnv);
});

test('H1-08 session cookies and their echoes never enter evidence or envelopes', t => {
  probe(t, `const value = 'opaque-cookie-fixture'; let calls = 0;
    globalThis.fetch = async (url, init) => { calls++; if (calls === 2) assert.equal(init.headers.cookie, 'sid=' + value);
      return new Response(JSON.stringify({ echo: value }), { headers: { 'content-type': 'application/json', 'set-cookie': 'sid=' + value + '; Path=/' } }); };
    ${clientImport} for (const path of ['/login', '/items']) { const result = await apiRequest({ path }); assert.equal(JSON.stringify(result).includes(value), false); }
    for (const file of fs.readdirSync(join(root, 'evidence')).filter(x => x.endsWith('.json'))) assert.equal(fs.readFileSync(join(root, 'evidence', file), 'utf8').includes(value), false);`);
});

test('H1-09 cookie jar respects origin, secure, path and expiry boundaries', t => {
  probe(t, `let calls = 0; globalThis.fetch = async (url, init) => {
    calls++; if (calls === 1) return new Response('{}', { headers: { 'set-cookie': 'sid=opaque-fixture; Secure; Path=/private', 'content-type': 'application/json' } });
    assert.equal(init.headers.cookie, undefined); return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }; ${clientImport} await apiRequest({ path: '/private/login' }); await apiRequest({ path: '/public' });
    await apiRequest({ path: 'http://api.example.test/private' });`, {}, root => {
    writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ hosts: { insecure: { baseUrl: 'http://api.example.test' } } }));
  });
});

test('H1-10 Postman capture scans keys, environment metadata and credential locations', () => {
  const out = scrubCaptured({ collections: [{ [synthetic]: 'x', password: 'opaque-private-fixture' }], environments: [{ values: [{ key: synthetic, type: synthetic, value: 'discard' }] }] });
  assert.equal(JSON.stringify(out).includes(synthetic), false); assert.equal(JSON.stringify(out).includes('opaque-private-fixture'), false);
});

test('H1-10 capture README uses only scanned account metadata and preflights destinations', async t => {
  setEnv(t, 'POSTMAN_API_KEY', 'synthetic-private-key'); const root = project(t);
  await capturePostman({ outputDir: root, account: synthetic, fetchImpl: async () => new Response('{}') });
  assert.equal(readFileSync(join(root, 'README.md'), 'utf8').includes(synthetic), false);
  const target = join(root, 'protected'); writeFileSync(target, 'preserve'); rmSync(join(root, 'capture.json')); symlinkSync(target, join(root, 'capture.json'));
  let calls = 0;
  await assert.rejects(capturePostman({ outputDir: root, fetchImpl: async () => { calls++; return new Response('{}'); } }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(calls, 0); assert.equal(readFileSync(target, 'utf8'), 'preserve');
});

test('H1-10 import and feedback metadata cannot promote secret-shaped identities', () => {
  for (const make of [
    () => importKong({ _format_version: '3.0', routes: [{ paths: ['/' + synthetic] }] }),
    () => flattenPostmanWorkspace({ workspaces: [{ name: synthetic }], collections: [] }),
    () => importPostman({ ...collection, item: [{ ...collection.item[0], name: synthetic }] }),
  ]) {
    let out; try { out = make(); } catch (error) { assert.match(error.code, /SECRET_REFUSED/); continue; }
    assert.equal(JSON.stringify(out).includes(synthetic), false);
  }
  assert.equal(renderFeedback(buildFeedback({ map: { services: [{ name: synthetic }] } })).includes(synthetic), false);
});

test('H1-11 hook recognizes static env split-string shell HTTP without executing it', () => {
  const base = 'https://api.example.test';
  for (const command of [`env -S 'curl ${base}/items'`, `env --split-string='wget ${base}/items'`, `env -S 'curl -s' ${base}/items`, `env -S curl ${base}/items`])
    assert.equal(inspectShellHttp(command, [base]).deny, true);
  assert.equal(inspectShellHttp(`env -S 'curl https://other.example.test/'`, [base]).deny, false);
});

test('H1-12 token cache refuses links and replaces permissive cache modes', t => {
  probe(t, `const { createHash } = await import('node:crypto');
    globalThis.fetch = async url => String(url).includes('/token') ? new Response(JSON.stringify({ access_token: 'opaque-access-fixture', expires_in: 3600 })) : new Response('{}');
    ${clientImport} fs.mkdirSync(TOKEN_CACHE, { recursive: true });
    const key = join(TOKEN_CACHE, createHash('sha256').update(JSON.stringify([process.env.API_OAUTH_TOKEN_URL, process.env.TEST_CLIENT_ID, process.env.TEST_CLIENT_SECRET, null, null])).digest('hex').slice(0,32) + '.json');
    const target = join(root, 'protected'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, key);
    await apiRequest({ path: '/items' }); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
    assert.equal(fs.lstatSync(key).isSymbolicLink(), true);`, oauthEnv);
  probe(t, `const { createHash } = await import('node:crypto');
    globalThis.fetch = async url => String(url).includes('/token') ? new Response(JSON.stringify({ access_token: 'opaque-access-fixture', expires_in: 3600 })) : new Response('{}');
    ${clientImport} fs.mkdirSync(TOKEN_CACHE, { recursive: true });
    const key = join(TOKEN_CACHE, createHash('sha256').update(JSON.stringify([process.env.API_OAUTH_TOKEN_URL, process.env.TEST_CLIENT_ID, process.env.TEST_CLIENT_SECRET, null, null])).digest('hex').slice(0,32) + '.json');
    fs.writeFileSync(key, '{}', { mode: 0o644 }); await apiRequest({ path: '/items' });
    assert.equal(fs.statSync(key).mode & 0o777, 0o600);`, oauthEnv);
});

test('H1-04 evidence protection and usage logging never follow linked files', t => {
  probe(t, `globalThis.fetch = async () => new Response('{}'); ${clientImport}
    await assert.rejects(apiRequest({ path: '/items' }), { code: 'OUTPUT_UNSAFE_PATH' });
    assert.equal(fs.readFileSync(join(root, 'protected-ignore'), 'utf8'), 'preserve');
    fs.unlinkSync(join(root, 'evidence', '.gitignore'));
    await apiRequest({ path: '/items' });
    assert.equal(fs.readFileSync(join(root, 'protected-log'), 'utf8'), 'preserve');`, {}, root => {
    mkdirSync(join(root, 'evidence'));
    for (const [target, link] of [['protected-ignore', 'evidence/.gitignore'], ['protected-log', 'usage.jsonl']]) {
      writeFileSync(join(root, target), 'preserve'); symlinkSync(join(root, target), join(root, link));
    }
  });
});

test('H1-13 CI summary does not delete a foreign temporary-file collision', t => {
  const root = project(t), summary = join(root, 'summary.md');
  const timestamp = 123456789;
  const foreign = join(root, `.summary.md.tmp-${process.pid}-${timestamp}`);
  writeFileSync(foreign, 'preserve'); t.mock.method(Date, 'now', () => timestamp);
  assert.throws(() => appendCiSummary(summary, 'section'));
  assert.equal(readFileSync(foreign, 'utf8'), 'preserve'); assert.equal(existsSync(summary), false);
});

test('H1-02 oversized regex inputs fail with a named limit', () => {
  assert.throws(() => checkOne({ json: 'x', matches: 'a+$' }, { body: { x: 'a'.repeat(5000) + '!' } }), { code: 'ASSERTION_INPUT_OVERSIZED' });
});

test('H1-09 expired cookies and cookies on another port are withheld', t => {
  probe(t, `let calls = 0; globalThis.fetch = async (url, init) => {
    calls++; if (calls === 1) return new Response('{}', { headers: { 'set-cookie': 'sid=opaque-fixture; Max-Age=0; Path=/' } });
    assert.equal(init.headers.cookie, undefined);
    return new Response('{}', { headers: { 'set-cookie': 'sid=opaque-fixture; Path=/' } });
  }; ${clientImport} await apiRequest({ path: '/login' }); await apiRequest({ path: '/items' });
    await apiRequest({ path: 'https://api.example.test:8443/items' });`, {}, root => {
    writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ hosts: { other: { baseUrl: 'https://api.example.test:8443' } } }));
  });
});

test('H1-08 short cookie values are scrubbed without corrupting numeric JSON', t => {
  probe(t, `globalThis.fetch = async () => new Response(JSON.stringify({ echo: '12', count: 12, nested: { '12': 'value' } }), { headers: { 'set-cookie': 'sid=12; Path=/' } });
    ${clientImport} const result = await apiRequest({ path: '/login' });
    assert.equal(result.data.echo, '[redacted]'); assert.equal(result.data.count, 12);
    assert.equal(Object.hasOwn(result.data.nested, '12'), false);`);
});

test('H1-08 pagination cookies are scrubbed before publication', t => {
  probe(t, `const pageCookie = 'page-cookie-fixture'; let calls = 0;
    globalThis.fetch = async () => { calls++; return calls === 1
      ? new Response(JSON.stringify([{ id: 1 }]), { headers: { link: '</items?page=2>; rel="next"' } })
      : new Response(JSON.stringify([{ echo: pageCookie }]), { headers: { 'set-cookie': 'sid=' + pageCookie + '; Path=/' } }); };
    ${clientImport} const result = await apiRequest({ path: '/items', paginate: true });
    assert.equal(calls, 2); assert.equal(JSON.stringify(result).includes(pageCookie), false);
    for (const file of fs.readdirSync(join(root, 'evidence')).filter(x => x.endsWith('.json'))) {
      const text = fs.readFileSync(join(root, 'evidence', file), 'utf8'); assert.equal(text.includes(pageCookie), false);
    }`);
});

test('H1-09 pagination rebuilds scoped jar cookies for each page', t => {
  probe(t, `let calls = 0; globalThis.fetch = async (url, init) => {
    calls++; if (calls === 1) return new Response('{}', { headers: { 'set-cookie': 'sid=scoped-cookie-fixture; Path=/private' } });
    if (calls === 2) { assert.equal(init.headers.cookie, 'sid=scoped-cookie-fixture'); return new Response('[{}]', { headers: { link: '</public?page=2>; rel="next"' } }); }
    assert.equal(init.headers.cookie, undefined); return new Response('[{}]');
  }; ${clientImport} await apiRequest({ path: '/private/login' }); const result = await apiRequest({ path: '/private/items', paginate: true }); assert.equal(calls, 3); assert.equal(result.data.length, 2);`);
});

test('H1-08 long numeric cookie values never corrupt numeric JSON', t => {
  probe(t, `globalThis.fetch = async () => new Response(JSON.stringify({ echo: '123456', count: 123456 }), { headers: { 'set-cookie': 'sid=123456; Path=/' } });
    ${clientImport} const result = await apiRequest({ path: '/login' }); assert.equal(result.data.echo, '[redacted]'); assert.equal(result.data.count, 123456);`);
});
