// The public onboarding target is intercepted at fetch; this suite never calls
// GitHub. The original method/URL/announcement and real client evidence remain
// asserted, while response bytes come only from controlled loopback fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME_ENV_NAME, PRODUCT } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { ONBOARDING_OBSERVATION_PATH, queryDoctorObservation, recordDoctorObservation } from '../lib/doctor-observation.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const CLIENT = pathToFileURL(join(ROOT, 'lib/client.mjs')).href;
const execute = promisify(execFile);
const ZEN = 'https://api.github.com/zen';
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-onboarding-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, [HOME_ENV_NAME]: join(root, 'private-home') };
  for (const key of Object.keys(env)) if (/^(API_|NODE_OPTIONS)/.test(key)) delete env[key];
  return { root, env };
}
async function fixture(t, respond = (_req, res) => res.end('a controlled fixture response')) {
  const hits = [];
  const server = createServer((req, res) => { hits.push({ method: req.method, url: req.url, headers: req.headers }); respond(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}
async function run(f, args) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [CLI, ...args], { cwd: f.root, env: f.env, timeout: 12000 });
    return { code: 0, stdout, stderr, json: JSON.parse(stdout) };
  } catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', json: error.stdout ? JSON.parse(error.stdout) : null }; }
}
function mockDefault(f, url) {
  const hook = join(f.root, 'controlled-fetch.mjs');
  writeFileSync(hook, `
    import assert from 'node:assert/strict';
    let announced = 0;
    const originalWrite=process.stderr.write.bind(process.stderr);
    process.stderr.write=(chunk,encoding,cb)=>{
      const done=typeof encoding==='function'?encoding:cb;
      return originalWrite(chunk,typeof encoding==='string'?encoding:undefined,error=>{
        if(!error && String(chunk).startsWith('About to request: '))announced++;
        done?.(error);
      });
    };
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(target,init)=>{
      assert.ok(announced>0,'fetch preceded completed announcement');announced--;
      const actual=String(target);
      if(actual===${JSON.stringify(ZEN)}){
        assert.equal(init.method,'GET');
        assert.equal(init.headers.accept,'application/vnd.github+json');
        assert.equal(init.headers['user-agent'],${JSON.stringify(PRODUCT)});
        assert.equal(init.headers.authorization,undefined);
        return originalFetch(${JSON.stringify(url + '/zen-fixture')},init);
      }
      assert.equal(new URL(actual).hostname,'127.0.0.1','unexpected external request');
      return originalFetch(target,init);
    };
  `);
  f.env.NODE_OPTIONS = `--import=${pathToFileURL(hook).href}`;
}
function configure(f, baseUrl) {
  mkdirSync(join(f.root, LAYOUT.config), { recursive: true });
  writeFileSync(join(f.root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: { local: { baseUrl } } }));
}
const check = (result, name) => result.json.checks.find(row => row.name === name);

for (const shape of ['empty', 'monorepo with API routes']) {
test(`fresh ${shape} announces exact Zen GET and records the first observation without requiring a contract`, async t => {
  const f = scratch(t);
  if (shape !== 'empty') {
    mkdirSync(join(f.root, 'packages/api/src'), { recursive: true });
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }));
    writeFileSync(join(f.root, 'packages/api/src/server.js'), 'const app = express(); app.get("/orders", handler);');
  }
  const srv = await fixture(t, (req, res) => {
    // The real endpoint returned 415 for text/plain despite returning a text
    // body. Model its media-type boundary, not merely a permissive HTTP server.
    if (req.headers.accept !== 'application/vnd.github+json') {
      res.writeHead(415); res.end("Unsupported Accept header; must accept application/json"); return;
    }
    res.writeHead(200, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1790040000',
      'x-ratelimit-resource': 'core', 'x-private-header': 'private-response-header' });
    res.end('private-response-body');
  });
  mockDefault(f, srv.url);
  const result = await run(f, ['doctor', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(check(result, 'contract').state, 'WARN');
  assert.equal(srv.hits.length, 1);
  assert.match(result.stderr, /^About to request: GET https:\/\/api\.github\.com\/zen/m);
  assert.equal(result.json.api_probe.target_source, 'default');
  assert.equal(result.json.api_probe.status, 200);
  assert.equal(result.json.api_probe.http_ok, true);
  assert.ok(Number.isInteger(result.json.api_probe.duration_ms));
  assert.deepEqual(result.json.api_probe.rate_limit_headers, {
    'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1790040000', 'x-ratelimit-resource': 'core',
  });
  const observed = result.json.api_probe.observation;
  assert.equal(observed.state, 'recorded');
  assert.equal(observed.path, ONBOARDING_OBSERVATION_PATH);
  assert.equal(observed.evidence_id, result.json.api_probe.evidence);
  const retrieved = await run(f, ['context', 'query', '--onboarding']);
  assert.equal(retrieved.code, 0, retrieved.stderr);
  assert.equal(srv.hits.length, 1, 'retrieval must not send requests');
  assert.equal(retrieved.json.first.evidence_id, observed.evidence_id);
  assert.deepEqual(retrieved.json.first, retrieved.json.latest);
  assert.equal(retrieved.json.first.provider, 'https://api.github.com');
  assert.equal(retrieved.json.first.repo_contract, null);
  assert.equal(retrieved.json.first.authentication, 'not_sent');
  assert.equal(retrieved.json.first.assertions, 'not_run');
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false, 'onboarding must not create repository API knowledge');
  const record = readFileSync(join(f.root, observed.path), 'utf8');
  assert.doesNotMatch(record + result.stdout + result.stderr + retrieved.stdout, /private-response-body|private-response-header/);
  const evidence = JSON.parse(readFileSync(join(f.root, LAYOUT.evidence, `${observed.evidence_id}.json`)));
  assert.equal(evidence.request.url, ZEN);
  assert.equal(evidence.purpose, 'onboarding');
  assert.equal(evidence.repo_contract, null);
});

}

test('override GET wins over configured HEAD, preserves first observation, and offline preserves both without traffic', async t => {
  const f = scratch(t), configured = await fixture(t), override = await fixture(t);
  configure(f, `${configured.url}/configured`);
  const first = await run(f, ['doctor', '--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(configured.hits.map(row => row.method), ['HEAD']);
  assert.equal(configured.hits[0].headers.accept, '*/*', 'configured API inherits no forced media type');
  const result = await run(f, ['doctor', '--probe', `${override.url}/chosen?tenant=private-query`, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.api_probe.target_source, 'override');
  assert.deepEqual(override.hits.map(row => [row.method, row.url]), [['GET', '/chosen?tenant=private-query']]);
  assert.equal(override.hits[0].headers.accept, '*/*', 'override API inherits no forced media type');
  const record = queryDoctorObservation(f.root);
  assert.equal(record.first.evidence_id, first.json.api_probe.evidence);
  assert.equal(record.latest.evidence_id, result.json.api_probe.evidence);
  assert.equal(record.latest.url.includes('private-query'), false);
  const bytes = readFileSync(join(f.root, ONBOARDING_OBSERVATION_PATH));
  const offline = await run(f, ['doctor', '--probe', `${override.url}/unused`, '--offline', '--json']);
  assert.equal(offline.code, 0);
  assert.equal(offline.json.api_probe, undefined);
  assert.deepEqual(readFileSync(join(f.root, ONBOARDING_OBSERVATION_PATH)), bytes);
  assert.equal(configured.hits.length, 1); assert.equal(override.hits.length, 1);
});

for (const status of [301, 403, 429, 500]) test(`default HTTP ${status} is saved truthfully with a warning and no followup request`, async t => {
  const f = scratch(t), srv = await fixture(t, (_req, res) => {
    res.writeHead(status, { location: '/never-follow', 'retry-after': '0', 'x-ratelimit-remaining': '0' }); res.end('private');
  });
  mockDefault(f, srv.url);
  const result = await run(f, ['doctor', '--json']);
  assert.equal(check(result, 'base-url').state, 'WARN');
  assert.equal(check(result, 'probe-http').state, 'WARN');
  assert.equal(result.json.api_probe.http_ok, false);
  assert.equal(result.json.api_probe.assertions, 'not_run');
  assert.equal(result.json.api_probe.status, status);
  assert.equal(queryDoctorObservation(f.root).latest.status, status);
  assert.equal(srv.hits.length, 1);
});

test('unsafe override refuses before network and an invalid configured URL never falls back to the public API', async t => {
  const f = scratch(t), srv = await fixture(t);
  mockDefault(f, srv.url);
  for (const target of ['file:///etc/passwd', 'http://user:private-pass@127.0.0.1/', `${srv.url}/?token=private-token`, 'not-a-url', `${srv.url}/bad\npath`]) {
    const result = await run(f, ['doctor', '--probe', target, '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.json.request_target, undefined);
    assert.equal(result.json.api_probe.attempts.length, 0);
    assert.doesNotMatch(result.stdout + result.stderr, /private-pass|private-token/);
  }
  configure(f, 'not-a-url');
  const invalid = await run(f, ['doctor', '--json']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.json.api_probe.target_source, 'configured');
  assert.equal(srv.hits.length, 0);
  assert.equal(existsSync(join(f.root, ONBOARDING_OBSERVATION_PATH)), false);
});

test('only bounded safe rate-limit values enter onboarding output; arbitrary headers and bodies stay out', async t => {
  const f = scratch(t), srv = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'x-ratelimit-limit': 'opaque-private-limit', 'x-ratelimit-resource': 'opaque-private-resource',
      'retry-after': 'opaque-private-retry', 'x-private': 'opaque-private-header' }); res.end('opaque-private-body');
  });
  const result = await run(f, ['doctor', '--probe', srv.url, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(result.json.api_probe.rate_limit_headers, {
    'x-ratelimit-limit': '[withheld]', 'retry-after': '[withheld]', 'x-ratelimit-resource': '[withheld]',
  });
  assert.doesNotMatch(result.stdout + result.stderr + readFileSync(join(f.root, ONBOARDING_OBSERVATION_PATH)), /opaque-private-/);
});

test('a failed receipt write preserves the HTTP result, reports a distinct failure, and never retries', async t => {
  const f = scratch(t), srv = await fixture(t);
  configure(f, srv.url);
  mkdirSync(join(f.root, LAYOUT.evidence), { recursive: true });
  const outside = join(f.root, 'sentinel'); writeFileSync(outside, 'preserve');
  symlinkSync(outside, join(f.root, ONBOARDING_OBSERVATION_PATH));
  const result = await run(f, ['doctor', '--json']);
  assert.equal(result.code, 1);
  assert.equal(check(result, 'base-url').state, 'PASS');
  assert.equal(check(result, 'onboarding').state, 'FAIL');
  assert.equal(result.json.api_probe.status, 200);
  assert.equal(result.json.api_probe.observation.state, 'failed');
  assert.match(result.json.api_probe.evidence, /^run-/);
  assert.equal(readFileSync(outside, 'utf8'), 'preserve');
  assert.equal(srv.hits.length, 1);
});

test('probe-only origin permission never changes ordinary client routing or repository environment', async t => {
  const f = scratch(t), configured = await fixture(t), other = await fixture(t);
  Object.assign(f.env, { API_BASE_URL: configured.url, API_AUTH: 'bearer:FIXTURE_TOKEN', FIXTURE_TOKEN: 'private-fixture-auth' });
  const script = `
    import assert from 'node:assert/strict';
    import {apiRequest,apiReadProbe} from ${JSON.stringify(CLIENT)};
    const probe=await apiReadProbe({path:${JSON.stringify(other.url)},method:'GET',targetSource:'override',onRequest:async()=>{}});
    assert.equal(probe.result.status,200);assert.equal(probe.result.known,null);assert.equal(probe.result.environment,null);
    const denied=await apiRequest({method:'GET',path:${JSON.stringify(other.url)}});
    assert.equal(denied.error.code,'ORIGIN_NOT_CONFIGURED');
    const own=await apiRequest({method:'GET',path:'/own',capture_context:false});assert.equal(own.status,200);
  `;
  const { stderr } = await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: f.env });
  assert.equal(stderr, '');
  assert.equal(other.hits.length, 1); assert.equal(other.hits[0].headers.authorization, undefined);
  assert.equal(configured.hits.length, 1); assert.equal(configured.hits[0].headers.authorization, 'Bearer private-fixture-auth');
});

test('an explicit Zen override uses its supported media type without changing ordinary client headers', async t => {
  const f = scratch(t), srv = await fixture(t, (req, res) => {
    res.writeHead(req.headers.accept === 'application/vnd.github+json' ? 200 : 415);
    res.end('controlled representation');
  });
  mockDefault(f, srv.url);
  const result = await run(f, ['doctor', '--probe', ZEN, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.api_probe.target_source, 'override');
  assert.equal(result.json.api_probe.status, 200);
  assert.equal(srv.hits.length, 1);
  // The ordinary client still sends exactly the caller's Accept. This models
  // the original real 415 and keeps the special case confined to doctor.
  delete f.env.NODE_OPTIONS;
  f.env.API_BASE_URL = srv.url;
  const script = `
    import assert from 'node:assert/strict';
    import {apiRequest} from ${JSON.stringify(CLIENT)};
    const result=await apiRequest({method:'GET',path:'/zen-fixture',headers:{accept:'text/plain'},capture_context:false});
    assert.equal(result.status,415);
  `;
  await execute(process.execPath, ['--input-type=module', '-e', script], { cwd: f.root, env: f.env });
  assert.equal(srv.hits.length, 2);
  assert.equal(srv.hits[1].headers.accept, 'text/plain');
});

// H5 walk, 2026-11-01: an exhausted anonymous quota printed
// `PASS probe-rate-limits ... x-ratelimit-remaining: 0` under "all checks passed".
// The row must say the quota is exhausted, and must not claim it for a 403
// that carries no rate-limit signal.
for (const [status, headers, exhausted] of [
  [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793609612' }, true],
  [429, { 'retry-after': '60' }, true],
  [403, { 'x-ratelimit-remaining': '41' }, false],
]) test(`HTTP ${status} with ${Object.keys(headers).join(', ')} ${exhausted ? 'is' : 'is not'} labelled an exhausted rate limit`, async t => {
  const f = scratch(t), srv = await fixture(t, (_req, res) => { res.writeHead(status, headers); res.end('private'); });
  mockDefault(f, srv.url);
  const result = await run(f, ['doctor', '--json']);
  const row = check(result, 'probe-rate-limits');
  if (exhausted) {
    assert.equal(row.state, 'WARN');
    assert.match(row.detail, /rate limit exhausted/);
    assert.match(row.fix, /--offline/);
    if (headers['x-ratelimit-reset']) assert.match(row.detail, /resets 2026-11-02T08:53:32Z/);
  } else {
    assert.equal(row.state, 'PASS');
    assert.doesNotMatch(row.detail, /exhausted/);
  }
  assert.equal(srv.hits.length, 1);
});
