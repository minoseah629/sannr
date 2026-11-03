import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const ZEN = 'https://api.github.com/zen';

async function fixture(t, { status = 200, headers = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'request-onboarding-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const cwd = join(base, 'repo'), home = join(base, 'home');
  mkdirSync(cwd); mkdirSync(home);
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8',
      'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59',
      'set-cookie': 'fixture-cookie=private; Path=/', ...headers });
    res.end('Keep fixture knowledge close to code.');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const local = 'http://127.0.0.1:' + server.address().port;
  // The child only remaps this logical target; no external traffic is possible.
  const guard = join(base, 'fixture-transport.mjs');
  writeFileSync(guard, [
    "import assert from 'node:assert/strict';",
    "let announcements = 0;",
    "const write = process.stderr.write.bind(process.stderr);",
    "process.stderr.write = (chunk, encoding, callback) => {",
    "  const done = typeof encoding === 'function' ? encoding : callback;",
    "  return write(chunk, typeof encoding === 'string' ? encoding : undefined, error => {",
    "    if (!error && String(chunk).startsWith('About to request: ')) announcements++;",
    "    done?.(error);",
    "  });",
    "};",
    "const original = globalThis.fetch;",
    "globalThis.fetch = (url, init) => {",
    "  if (String(url) === " + JSON.stringify(local + '/health') + ") return original(url, init);",
    "  assert.equal(String(url), " + JSON.stringify(ZEN) + ", 'unexpected logical network target');",
    "  assert.equal(announcements, 1, 'request must follow one completed announcement');",
    "  assert.equal(init.redirect, 'manual');",
    "  assert.equal(init.headers.authorization, undefined);",
    "  assert.equal(init.headers.cookie, undefined);",
    "  return original(" + JSON.stringify(local + '/zen') + ", init);",
    "};",
  ].join('\n'));
  const env = { PATH: process.env.PATH, HOME: home, API_USAGE_LOG: '' };
  const run = async (args, extra = {}) => {
    try {
      const out = await execute(process.execPath, ['--import', pathToFileURL(guard).href, CLI, 'request', ...args],
        { cwd, env: { ...env, ...extra }, timeout: 10000 });
      return { code: 0, ...out, result: JSON.parse(out.stdout) };
    } catch (error) {
      let result;
      try { result = JSON.parse(error.stdout); } catch {}
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', result };
    }
  };
  return { cwd, hits, run, local };
}

test('fresh exact onboarding GET announces first, asserts status, records only local evidence and leaves config absent', async t => {
  const f = await fixture(t);
  const out = await f.run(['GET', ZEN, '--expect-status', '200']);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(f.hits.length, 1);
  assert.deepEqual(f.hits.map(({ method, url }) => ({ method, url })), [{ method: 'GET', url: '/zen' }]);
  assert.equal(f.hits[0].headers.authorization, undefined);
  assert.equal(f.hits[0].headers.cookie, undefined);
  assert.equal(f.hits[0].headers.accept, 'application/vnd.github+json');
  assert.equal(out.result.mode, 'assert');
  assert.deepEqual(out.result.assertions, { passed: 1, failed: 0, failures: [] });
  assert.equal(out.result.data, null);
  assert.equal(out.result.status, 200);
  assert.equal(out.result.context_capture.state, 'disabled');
  assert.deepEqual(out.result.onboarding, { purpose: 'onboarding', authentication: 'not_sent',
    repo_contract: null, observation: 'private-execution-evidence', shared_context: 'not-recorded' });
  assert.ok(Number.isInteger(out.result.duration_ms));
  assert.deepEqual(out.result.rate_limit_headers, { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59' });
  const evidence = JSON.parse(readFileSync(join(f.cwd, LAYOUT.evidence, out.result.evidence + '.json'), 'utf8'));
  assert.equal(evidence.request.url, ZEN);
  assert.equal(evidence.request.authUsed, null);
  assert.equal(evidence.response.body, 'Keep fixture knowledge close to code.');
  assert.equal(evidence.repo_contract, null);
  assert.equal(existsSync(join(f.cwd, LAYOUT.environments)), false);
  assert.equal(existsSync(join(f.cwd, LAYOUT.context)), false);
  assert.equal(readdirSync(join(f.cwd, LAYOUT.evidence)).filter(name => name.endsWith('.json')).length, 1);
});

test('the onboarding example without expect-status is explicitly unasserted', async t => {
  const f = await fixture(t);
  const out = await f.run(['GET', ZEN]);
  assert.equal(out.code, 0, out.stdout + out.stderr);
  assert.equal(out.result.assertions, null);
  assert.equal(out.result.mode, 'summary');
  assert.equal(out.result.data, 'Keep fixture knowledge close to code.');
});

test('expect-status also checks an ordinary configured request without changing its authentication', async t => {
  const f = await fixture(t);
  const env = { API_BASE_URL: f.local, API_AUTH: 'bearer:FIXTURE_TOKEN', FIXTURE_TOKEN: 'fixture-private-value' };
  const pass = await f.run(['GET', '/health', '--expect-status', '200'], env);
  assert.equal(pass.code, 0, pass.stdout + pass.stderr);
  assert.deepEqual(pass.result.assertions, { passed: 1, failed: 0, failures: [] });
  assert.equal(f.hits[0].headers.authorization, 'Bearer fixture-private-value');
  assert.equal(pass.result.onboarding, undefined);
  assert.doesNotMatch(pass.stderr, /About to request:/);
  const fail = await f.run(['GET', '/health', '--expect-status=201'], env);
  assert.equal(fail.code, 1);
  assert.equal(fail.result.assertions.failed, 1);
  assert.equal(fail.result.assertions.failures[0].actual, 200);
  assert.equal(f.hits.length, 2);
});

test('an explicit failed status assertion fails the command with expected and actual', async t => {
  const f = await fixture(t, { status: 503 });
  const out = await f.run(['GET', ZEN, '--expect-status=200']);
  assert.equal(out.code, 1);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.assertions.passed, 0);
  assert.equal(out.result.assertions.failed, 1);
  assert.equal(out.result.assertions.failures[0].expected, 200);
  assert.equal(out.result.assertions.failures[0].actual, 503);
  assert.equal(f.hits.length, 1);
  assert.equal(out.result.onboarding.observation, 'private-execution-evidence');
});

for (const status of [302, 429]) {
  test('onboarding HTTP ' + status + ' never follows a redirect or retries', async t => {
    const f = await fixture(t, { status, headers: { location: 'http://127.0.0.1/private', 'retry-after': '0' } });
    const out = await f.run(['GET', ZEN, '--expect-status', '200']);
    assert.equal(out.code, 1);
    assert.equal(out.result.status, status);
    assert.equal(f.hits.length, 1);
  });
}

test('existing provider configuration and credential references never activate the onboarding exception', async t => {
  const cases = [
    { API_BASE_URL: 'https://other.example.test', API_AUTH: 'bearer:FIXTURE_TOKEN', FIXTURE_TOKEN: 'fixture-private-value' },
    { API_AUTH: 'bearer:FIXTURE_TOKEN', FIXTURE_TOKEN: 'fixture-private-value' },
    { API_CONTRACT: './openapi.json' },
    { API_ENV: 'local' },
  ];
  for (const env of cases) {
    const f = await fixture(t);
    const out = await f.run(['GET', ZEN, '--expect-status', '200'], env);
    assert.equal(out.code, 1, JSON.stringify(env) + out.stdout + out.stderr);
    assert.equal(f.hits.length, 0);
    assert.equal(out.result?.error?.code, 'ORIGIN_NOT_CONFIGURED');
    assert.doesNotMatch(out.stdout + out.stderr, /fixture-private-value|About to request:/);
  }
  const f = await fixture(t);
  mkdirSync(join(f.cwd, LAYOUT.config), { recursive: true });
  writeFileSync(join(f.cwd, LAYOUT.environments), JSON.stringify({ v: 1, defaults: { budget: 800 } }));
  const out = await f.run(['GET', ZEN]);
  assert.equal(out.code, 1);
  assert.equal(out.result.error.code, 'ORIGIN_NOT_CONFIGURED');
  assert.equal(f.hits.length, 0);
});

test('unconfigured private, altered, and non-GET targets retain the normal refusal', async t => {
  for (const args of [
    ['GET', 'https://127.0.0.1/zen'], ['GET', 'http://api.github.com/zen'],
    ['GET', ZEN + '?q=1'], ['GET', ZEN + '#fragment'], ['GET', 'https://api.github.com/users'],
    ['HEAD', ZEN], ['POST', ZEN], ['GET', ZEN, '{}'],
  ]) {
    const f = await fixture(t);
    const out = await f.run(args);
    assert.equal(out.code, 1, args.join(' ') + out.stdout + out.stderr);
    assert.equal(out.result?.error?.code, 'ORIGIN_NOT_CONFIGURED');
    assert.equal(f.hits.length, 0);
    assert.doesNotMatch(out.stderr, /About to request:/);
  }
});

test('invalid and duplicate expectation options refuse before any request', async t => {
  for (const args of [
    ['GET', ZEN, '--expect-status'], ['GET', ZEN, '--expect-status', '0'],
    ['GET', ZEN, '--expect-status=600'], ['GET', ZEN, '--expect-status=200', '--expect-status', '201'],
    ['envelope', '{"v":2,"requests":[]}', '--expect-status=200'],
  ]) {
    const f = await fixture(t);
    const out = await f.run(args);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /REQUEST_ASSERTION_(INVALID|DUPLICATE|MODE)/);
    assert.equal(f.hits.length, 0);
  }
});
