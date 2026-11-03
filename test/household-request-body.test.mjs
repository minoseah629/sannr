import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const REQUEST = fileURLToPath(new URL('../bin/request.mjs', import.meta.url));
const PRIVATE = 'fixture-private-body-value';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'household-request-body-'));
  const home = join(dir, 'home'); mkdirSync(home);
  const hits = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      let body; try { body = JSON.parse(text); } catch { body = text; }
      hits.push({ method: req.method, path: req.url, headers: req.headers, body, rawBody: text });
      const authorized = req.headers.authorization === 'Bearer ' + PRIVATE && req.headers['x-fixture-tenant'] === 'blue';
      res.writeHead(authorized ? 201 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ created: authorized, ignored: true }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = join(dir, 'config.json'), evidence = join(dir, 'evidence');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  writeFileSync(config, JSON.stringify({ default: 'wrong', environments: {
    wrong: { baseUrl, headers: { 'X-Fixture-Tenant': 'wrong' } },
    fixture: { baseUrl, auth: 'bearer:FIXTURE_TOKEN', headers: { 'X-Fixture-Tenant': 'blue' } },
  } }));
  const env = { PATH: process.env.PATH, HOME: home, API_CONFIG: config, API_CONTEXT_OFF: '1',
    API_EVIDENCE: evidence, API_USAGE_LOG: '', API_FRICTION_OFF: '1', FIXTURE_TOKEN: PRIVATE };
  const run = async (lowLevel, args) => {
    try {
      const out = await execute(process.execPath, [lowLevel ? REQUEST : CLI, ...(lowLevel ? [] : ['request']), ...args],
        { cwd: dir, env: { ...env, ...(lowLevel ? { API_ENV: 'fixture' } : {}) }, timeout: 10000 });
      let result; try { result = JSON.parse(out.stdout); } catch {}
      return { code: 0, ...out, result };
    } catch (error) {
      let result; try { result = JSON.parse(error.stdout); } catch {}
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', result };
    }
  };
  const records = () => {
    try { return readdirSync(evidence).filter(name => /^run-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(evidence, name), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const markProduction = () => {
    const current = JSON.parse(readFileSync(config, 'utf8'));
    current.environments.fixture.production = true;
    writeFileSync(config, JSON.stringify(current));
  };
  const runUnconfigured = async (lowLevel, args) => {
    const guard = join(dir, 'no-fetch.mjs');
    writeFileSync(guard, "globalThis.fetch = () => { throw new Error('UNEXPECTED_FIXTURE_DISPATCH'); };\n");
    const freshEnv = { PATH: process.env.PATH, HOME: home, API_USAGE_LOG: '' };
    try {
      const out = await execute(process.execPath, ['--import', pathToFileURL(guard).href,
        lowLevel ? REQUEST : CLI, ...(lowLevel ? [] : ['request']), ...args], { cwd: dir, env: freshEnv, timeout: 10000 });
      return { code: 0, ...out, result: JSON.parse(out.stdout) };
    } catch (error) {
      let result; try { result = JSON.parse(error.stdout); } catch {}
      return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '', result };
    }
  };
  return { hits, run, runUnconfigured, records, markProduction };
}

for (const lowLevel of [false, true]) {
  const label = lowLevel ? 'low-level request' : 'main request';
  const select = lowLevel ? [] : ['--env', 'fixture'];

  test(label + ' JSON body options use the authenticated client, assertions and evidence', async t => {
    const f = await fixture(t);
    const body = { completed: false, labels: ['one', 'two'], metadata: { count: 2 } };
    for (const bodyArgs of [['--body', JSON.stringify(body)], ['--body=' + JSON.stringify(body)]]) {
      const out = await f.run(lowLevel, ['POST', '/chores', ...bodyArgs, '--expect-status', '201', ...select]);
      assert.equal(out.code, 0, out.stdout + out.stderr);
      assert.equal(out.result.status, 201);
      assert.equal(out.result.mode, 'assert');
      assert.deepEqual(out.result.assertions, { passed: 1, failed: 0, failures: [] });
      assert.match(out.result.evidence, /^run-/);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(PRIVATE));
    }
    assert.equal(f.hits.length, 2);
    for (const hit of f.hits) {
      assert.equal(hit.method, 'POST'); assert.equal(hit.path, '/chores');
      assert.equal(hit.headers.authorization, 'Bearer ' + PRIVATE);
      assert.equal(hit.headers['x-fixture-tenant'], 'blue');
      assert.equal(hit.headers['content-type'], 'application/json');
      assert.deepEqual(hit.body, body);
    }
    const records = f.records(); assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(record.origin.initiator, 'cli.request');
      assert.equal(record.origin.scope.environment, 'fixture');
      assert.equal(record.request.headers.authorization, '[redacted]');
      assert.deepEqual(record.request.body, body); assert.equal(record.response.status, 201);
      assert.doesNotMatch(JSON.stringify(record), new RegExp(PRIVATE));
    }
  });

  test(label + ' retains positional JSON bodies and detects a failing status assertion', async t => {
    const f = await fixture(t);
    const body = { completed: true };
    const out = await f.run(lowLevel, ['POST', '/chores', JSON.stringify(body), '--expect-status=200', ...select]);
    assert.equal(out.code, 1);
    assert.equal(out.result.status, 201); assert.equal(out.result.assertions.failed, 1);
    assert.deepEqual(f.hits[0].body, body); assert.equal(f.records().length, 1);
  });

  test(label + ' accepts JSON scalar and array bodies through the equals option', async t => {
    const f = await fixture(t);
    for (const value of [null, -1, true, ['one', 2], 'plain string body']) {
      const out = await f.run(lowLevel, ['POST', '/chores', '--body=' + JSON.stringify(value), '--expect-status=201', ...select]);
      assert.equal(out.code, 0, out.stdout + out.stderr);
      assert.deepEqual(f.hits.at(-1).body, value);
    }
    const negative = await f.run(lowLevel, ['POST', '/chores', '--body', '-1', '--expect-status=201', ...select]);
    assert.equal(negative.code, 0, negative.stdout + negative.stderr);
    assert.equal(f.hits.at(-1).body, -1);
  });

  test(label + ' preserves positional projection and idempotency key indices', async t => {
    const f = await fixture(t);
    const out = await f.run(lowLevel, ['POST', '/chores', '{"completed":true}', 'created', 'fixture-idempotency-key', ...select]);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.equal(out.result.mode, 'projection');
    assert.deepEqual(out.result.data, { created: true });
    assert.equal(f.hits[0].headers['idempotency-key'], 'fixture-idempotency-key');
    assert.equal(f.records().length, 1);
  });

  test(label + ' body option preserves the production write refusal', async t => {
    const f = await fixture(t); f.markProduction();
    const out = await f.run(lowLevel, ['POST', '/chores', '--body={}', '--expect-status=201', ...select]);
    assert.equal(out.code, 1); assert.equal(out.result.error.code, 'PRODUCTION_WRITE_REFUSED');
    assert.equal(f.hits.length, 0); assert.equal(f.records().length, 0);
  });

  test(label + ' body option cannot activate the fresh unauthenticated Zen exception', async t => {
    const f = await fixture(t);
    const out = await f.runUnconfigured(lowLevel, ['GET', 'https://api.github.com/zen', '--body={}', '--expect-status=200']);
    assert.equal(out.code, 1); assert.equal(out.result.error.code, 'ORIGIN_NOT_CONFIGURED');
    assert.doesNotMatch(out.stdout + out.stderr, /UNEXPECTED_FIXTURE_DISPATCH|About to request:/);
    assert.equal(f.hits.length, 0); assert.equal(f.records().length, 0);
  });

  test(label + ' rejects missing, invalid, duplicate, conflicting and envelope body options before execution', async t => {
    const f = await fixture(t);
    for (const [args, code] of [
      [['POST', '/chores', '--body'], 'REQUEST_BODY_REQUIRED'],
      [['POST', '/chores', '--body', '--expect-status=201'], 'REQUEST_BODY_REQUIRED'],
      [['POST', '/chores', '--body='], 'REQUEST_BODY_REQUIRED'],
      [['POST', '/chores', '--body', '{"secret":"' + PRIVATE + '"'], 'REQUEST_BODY_INVALID'],
      [['POST', '/chores', '--body={}', '--body', '{}'], 'REQUEST_BODY_DUPLICATE'],
      [['POST', '/chores', '{}', '--body={}'], 'REQUEST_BODY_CONFLICT'],
      [['POST', '/chores', '-', '--body={}'], 'REQUEST_BODY_CONFLICT'],
      [['envelope', '{"v":2,"requests":[]}', '--body={}'], 'REQUEST_BODY_MODE'],
      [['--body={}', 'envelope', '{"v":2,"requests":[]}'], 'REQUEST_BODY_MODE'],
      [['envelope', '{"v":2,"requests":[]}', '--body'], 'REQUEST_BODY_REQUIRED'],
    ]) {
      const out = await f.run(lowLevel, [...args, ...select]);
      assert.equal(out.code, 1, out.stdout + out.stderr);
      assert.equal(JSON.parse(out.stderr).error.code, code);
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(PRIVATE));
      assert.equal(f.hits.length, 0); assert.equal(f.records().length, 0);
    }
  });

  test(label + ' refuses unknown options without echoing their values or executing envelopes', async t => {
    const f = await fixture(t);
    for (const args of [
      ['POST', '/chores', '--unknown=' + PRIVATE],
      ['POST', '/chores', '--body={}', '--unknown=' + PRIVATE],
      ['envelope', '{"v":2,"requests":[]}', '--unknown=' + PRIVATE],
    ]) {
      const out = await f.run(lowLevel, [...args, ...select]);
      assert.equal(out.code, 1, out.stdout + out.stderr);
      assert.equal(JSON.parse(out.stderr).error.code, lowLevel ? 'REQUEST_OPTION_UNKNOWN' : 'UNKNOWN_FLAG');
      assert.doesNotMatch(out.stdout + out.stderr, new RegExp(PRIVATE));
      assert.equal(f.hits.length, 0); assert.equal(f.records().length, 0);
    }
  });

  test(label + ' help documents JSON body without executing', async t => {
    const f = await fixture(t);
    const out = await f.run(lowLevel, ['--help']);
    assert.equal(out.code, 0); assert.match(out.stdout, /--body <json>/);
    assert.equal(f.hits.length, 0); assert.equal(f.records().length, 0);
  });
}
