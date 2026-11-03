// Doctor must exercise the shipped client with announced, bounded fixture reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const CLIENT = pathToFileURL(join(ROOT, 'lib/client.mjs')).href;
const runFile = promisify(execFile);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-client-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, [HOME_ENV_NAME]: join(dir, 'private-home') };
  for (const key of Object.keys(env)) if (key.startsWith('API_') || key === 'NODE_OPTIONS') delete env[key];
  env.API_EVIDENCE = join(dir, 'probe-evidence');
  env.API_USAGE_LOG = join(dir, 'usage.jsonl');
  return { dir, env };
}
async function server(t, handle) {
  const hits = [];
  const srv = createServer((req, res) => { hits.push({ method: req.method, url: req.url, headers: req.headers }); handle(req, res); });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { hits, url: `http://127.0.0.1:${srv.address().port}` };
}
async function execute(f, args, before = []) {
  try {
    const { stdout, stderr } = await runFile(process.execPath, [...before, ...args], {
      cwd: f.dir, env: f.env, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
async function doctor(f, extra = [], before = []) {
  const result = await execute(f, [CLI, 'doctor', '--json', ...extra], before);
  return { ...result, report: JSON.parse(result.stdout) };
}
const baseCheck = result => result.report.checks.find(row => row.name === 'base-url');
function configure(f, value) {
  mkdirSync(join(f.dir, LAYOUT.config), { recursive: true });
  writeFileSync(join(f.dir, LAYOUT.environments), JSON.stringify(value));
}

// Observe the announcement's completed stream write inside the CLI process,
// before fetch itself. This avoids comparing parent-side pipe/network events,
// whose delivery order is an OS scheduling detail rather than the guarantee.
function announcementGuard(f) {
  const path = join(f.dir, 'announcement-guard.mjs');
  writeFileSync(path, `
    import assert from 'node:assert/strict';
    let pending = 0;
    const stream = process.stderr;
    const write = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      return write(chunk, typeof encoding === 'string' ? encoding : undefined, (error) => {
        if (!error && String(chunk).startsWith('About to request: ')) pending++;
        done?.(error);
      });
    };
    const original = globalThis.fetch;
    globalThis.fetch = (...args) => {
      assert.ok(pending > 0, 'fetch happened before its announcement completed');
      pending--;
      return original(...args);
    };
  `);
  return ['--import', pathToFileURL(path).href];
}

test('offline doctor skips both fresh onboarding and configured API without requests or observations', async t => {
  const f = fixture(t);
  const fresh = await doctor(f, ["--offline"]);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(baseCheck(fresh).state, 'WARN');
  assert.match(baseCheck(fresh).detail, /--offline/);
  assert.equal(fresh.report.request_target, undefined);
  assert.equal(fresh.report.api_probe, undefined);
  assert.equal(fresh.stderr, '');
  const srv = await server(t, (_req, res) => res.end('ok'));
  f.env.API_BASE_URL = srv.url;
  const offline = await doctor(f, ['--offline']);
  assert.equal(baseCheck(offline).state, 'WARN');
  assert.equal(srv.hits.length, 0);
  assert.equal(offline.report.api_probe, undefined);
  assert.equal(offline.stderr, '');
});

test('announced HEAD goes through actual client with exact selected path, bounded evidence and no context promotion', async t => {
  const f = fixture(t);
  const srv = await server(t, (_req, res) => { res.setHeader('x-fixture-secret', 'response-secret-not-for-output'); res.end('response-secret-not-for-output'); });
  configure(f, { v: 1, default: 'other', environments: {
    other: { baseUrl: 'http://127.0.0.1:1' },
    chosen: { baseUrl: `${srv.url}/prefix/health?tenant=private-tenant`, production: true },
  } });
  const result = await doctor(f, ['--env', 'chosen'], announcementGuard(f));
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(baseCheck(result).state, 'PASS');
  assert.deepEqual(srv.hits.map(({ method, url }) => ({ method, url })), [{ method: 'HEAD', url: '/prefix/health?tenant=private-tenant' }]);
  assert.match(result.stderr, /About to request: HEAD/);
  assert.match(baseCheck(result).detail, /API assertions and authentication were not verified/);
  assert.equal(result.report.request_target.environment, 'chosen');
  assert.equal(result.report.api_probe.authentication, 'not_sent');
  assert.equal(result.report.api_probe.assertions, 'not_run');
  assert.equal(result.report.api_probe.attempts.length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /private-tenant|response-secret-not-for-output/);
  const evidence = JSON.parse(readFileSync(join(f.env.API_EVIDENCE, `${result.report.api_probe.evidence}.json`)));
  assert.equal(evidence.request.method, 'HEAD');
  assert.equal(evidence.request.authUsed, null);
  assert.equal(evidence.response.status, 200);
  assert.equal(evidence.request.url, `${srv.url}/prefix/health?tenant=private-tenant`);
  assert.equal(existsSync(join(f.dir, LAYOUT.context)), false);
});

for (const status of [301, 401, 405, 429, 500]) {
  test(`HTTP ${status} proves transport only, with no redirect, retry, credential or OAuth request`, async t => {
    const f = fixture(t);
    const srv = await server(t, (_req, res) => {
      res.writeHead(status, { location: '/should-not-follow', 'retry-after': '0', 'set-cookie': 'private=fixture-cookie' });
      res.end('private-body');
    });
    configure(f, { v: 1, default: 'local', environments: { local: {
      baseUrl: `${srv.url}/probe`, auth: 'oauth:FIXTURE_ID:FIXTURE_SECRET', headers: { 'x-private-header': 'fixture-value' },
    } } });
    Object.assign(f.env, { API_OAUTH_TOKEN_URL: `${srv.url}/token`, FIXTURE_ID: 'fixture-client', FIXTURE_SECRET: 'fixture-secret' });
    const result = await doctor(f, [], announcementGuard(f));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(baseCheck(result).state, 'WARN');
    assert.match(baseCheck(result).detail, new RegExp(`HTTP ${status}`));
    assert.equal(srv.hits.length, 1);
    assert.equal(srv.hits[0].method, 'HEAD');
    assert.equal(srv.hits[0].headers.authorization, undefined);
    assert.equal(srv.hits[0].headers.cookie, undefined);
    assert.equal(srv.hits[0].headers['x-private-header'], undefined);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret|fixture-value|fixture-cookie|private-body/);
  });
}

test('HEAD transport failure permits just one announced GET and never prints the response', async t => {
  const f = fixture(t);
  const srv = await server(t, (req, res) => {
    if (req.method === 'HEAD') req.socket.destroy();
    else res.end('private-response-content');
  });
  f.env.API_BASE_URL = `${srv.url}/exact`;
  const result = await doctor(f, [], announcementGuard(f));
  assert.equal(baseCheck(result).state, 'PASS', result.stdout + result.stderr);
  assert.deepEqual(srv.hits.map(hit => `${hit.method} ${hit.url}`), ['HEAD /exact', 'GET /exact']);
  assert.deepEqual(result.report.api_probe.attempts.map(hit => hit.method), ['HEAD', 'GET']);
  assert.equal((result.stderr.match(/About to request:/g) ?? []).length, 2);
  assert.doesNotMatch(result.stdout + result.stderr, /private-response-content/);
  const evidence = JSON.parse(readFileSync(join(f.env.API_EVIDENCE, `${result.report.api_probe.evidence}.json`)));
  assert.equal(evidence.request.method, 'GET');
});

for (const credential of ['userinfo', 'query']) {
  test(`literal ${credential} credential is refused before announcement and never echoed`, async t => {
    const f = fixture(t);
    const srv = await server(t, (_req, res) => res.end('unexpected'));
    f.env.API_BASE_URL = credential === 'userinfo'
      ? srv.url.replace('://', '://fixture-user:fixture-private-password@') + '/probe'
      : `${srv.url}/probe?access_token=fixture-private-password`;
    const result = await doctor(f);
    assert.equal(result.code, 1);
    assert.equal(baseCheck(result).state, 'FAIL');
    assert.equal(result.report.api_probe.code, 'CREDENTIAL_IN_REQUEST');
    assert.equal(result.report.request_target, undefined);
    assert.equal(srv.hits.length, 0);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /fixture-user|fixture-private-password/);
  });
}

test('invalid auth diagnosis omits its literal value; missing referenced auth remains a separate failure', async t => {
  const f = fixture(t);
  const srv = await server(t, (_req, res) => res.end('ok'));
  Object.assign(f.env, { API_BASE_URL: srv.url, API_AUTH: 'basic:fixture-user:fixture-private-password' });
  const invalid = await doctor(f);
  assert.equal(baseCheck(invalid).state, 'PASS');
  assert.equal(invalid.report.checks.find(row => row.name === 'auth').state, 'FAIL');
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /fixture-user|fixture-private-password/);
  f.env.API_AUTH = 'bearer:NEVER_CONFIGURED_FIXTURE_AUTH';
  const missing = await doctor(f);
  assert.equal(baseCheck(missing).state, 'PASS');
  assert.equal(missing.report.checks.find(row => row.name === 'auth').state, 'FAIL');
  assert.match(missing.stdout, /NEVER_CONFIGURED_FIXTURE_AUTH/);
  assert.ok(srv.hits.every(hit => !hit.headers.authorization));
});

test('local evidence refusal sends no request and never falls back to raw transport', async t => {
  const f = fixture(t);
  const srv = await server(t, (_req, res) => res.end('unexpected'));
  const outside = join(f.dir, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, f.env.API_EVIDENCE, 'dir');
  f.env.API_BASE_URL = srv.url;
  const result = await doctor(f);
  assert.equal(baseCheck(result).state, 'FAIL');
  assert.equal(result.report.api_probe.code, 'CLIENT_PROBE_FAILED');
  assert.equal(result.report.request_target, undefined);
  assert.equal(srv.hits.length, 0);
  assert.equal(result.stderr, '');
});

test('concurrent ordinary client read stays authenticated and does not coalesce with probe', async t => {
  const f = fixture(t);
  const pending = [];
  const srv = await server(t, (_req, res) => {
    pending.push(res);
    if (pending.length === 2) for (const response of pending) response.end('ok');
  });
  Object.assign(f.env, { API_BASE_URL: srv.url, API_AUTH: 'bearer:FIXTURE_TOKEN', FIXTURE_TOKEN: 'fixture-auth-value', API_CONCURRENCY: '2' });
  const script = `
    import assert from 'node:assert/strict';
    import { apiRequest, apiReadProbe } from ${JSON.stringify(CLIENT)};
    let announcements = 0;
    const [normal, probe] = await Promise.all([
      apiRequest({method:'HEAD',path:'/same',capture_context:false}),
      apiReadProbe({path:'/same',onRequest:async()=>{ announcements++; }})
    ]);
    assert.equal(normal.status,200); assert.equal(probe.result.status,200);
    assert.equal(announcements,1); assert.equal(probe.attempted,true);
    console.log('independent-client-reads');
  `;
  const result = await execute(f, ['--input-type=module', '-e', script]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(srv.hits.length, 2);
  assert.deepEqual(srv.hits.map(hit => hit.headers.authorization ?? 'none').sort(), ['Bearer fixture-auth-value', 'none']);
});

test('an announcement write failure refuses the probe before any fetch', async t => {
  const f = fixture(t);
  const srv = await server(t, (_req, res) => res.end('unexpected'));
  f.env.API_BASE_URL = srv.url;
  const script = `
    import assert from 'node:assert/strict';
    import { apiReadProbe } from ${JSON.stringify(CLIENT)};
    const result=await apiReadProbe({path:'/probe',onRequest:()=>{throw new Error('private output error');}});
    assert.equal(result.attempted,false); assert.equal(result.transportFailed,false);
    assert.equal(result.error.code,'CLIENT_PROBE_FAILED');
  `;
  const result = await execute(f, ['--input-type=module', '-e', script]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(srv.hits.length, 0);
});

test('probe deadline stays bounded despite a long configured API timeout', async t => {
  const f = fixture(t);
  const srv = await server(t, (req, res) => { if (req.method === 'GET') res.end('ok'); });
  Object.assign(f.env, { API_BASE_URL: srv.url, API_TIMEOUT_MS: '60000' });
  const started = Date.now();
  const result = await doctor(f, [], announcementGuard(f));
  assert.ok(Date.now() - started < 7000, 'doctor inherited a long API timeout');
  assert.equal(baseCheck(result).state, 'PASS', result.stdout + result.stderr);
  assert.deepEqual(srv.hits.map(hit => hit.method), ['HEAD', 'GET']);
});

test('oversized GET fallback fails the client bound without additional requests or a response dump', async t => {
  const f = fixture(t);
  const srv = await server(t, (req, res) => {
    if (req.method === 'HEAD') req.socket.destroy();
    else res.end('private-body-prefix' + 'x'.repeat(8 * 1024 * 1024));
  });
  f.env.API_BASE_URL = srv.url;
  const result = await doctor(f);
  assert.equal(baseCheck(result).state, 'FAIL');
  assert.equal(result.report.api_probe.code, 'RESPONSE_OVERSIZED');
  assert.deepEqual(srv.hits.map(hit => hit.method), ['HEAD', 'GET']);
  assert.doesNotMatch(result.stdout + result.stderr, /private-body-prefix/);
});

test('ordinary JSON arguments cannot activate probe mode or suppress normal client authentication', async t => {
  const f = fixture(t);
  const srv = await server(t, (req, res) => {
    if (req.url === '/start') res.writeHead(302, { location: '/end' });
    res.end('ok');
  });
  Object.assign(f.env, { API_BASE_URL: srv.url, API_AUTH: 'bearer:FIXTURE_TOKEN', FIXTURE_TOKEN: 'fixture-auth-value' });
  const script = `
    import assert from 'node:assert/strict';
    import { apiRequest } from ${JSON.stringify(CLIENT)};
    const result=await apiRequest(JSON.parse('{"method":"HEAD","path":"/start","capture_context":false,"_probe":true,"READ_PROBE":true}'));
    assert.equal(result.status,200);
  `;
  const result = await execute(f, ['--input-type=module', '-e', script]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(srv.hits.map(hit => hit.url), ['/start', '/end']);
  assert.ok(srv.hits.every(hit => hit.headers.authorization === 'Bearer fixture-auth-value'));
});
