import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT as REPO_LAYOUT } from '../lib/layout.mjs';
import { createFixtureStack, inFixtureStack } from './helpers/stack-fixture.mjs';
const LAYOUT = { ...REPO_LAYOUT, context: join(REPO_LAYOUT.collection,'fixture','sannr.json'), evidence: join(REPO_LAYOUT.evidence,'fixture') };
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { captureHttpContext as captureHttp } from '../lib/http-operation-context.mjs';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const operation = 'GET /slots/{slotId}';
const captureHttpContext = (root,...args) => inFixtureStack(root, () => captureHttp(root,...args));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'show-observations-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFixtureStack(root, { environments: Object.fromEntries(['local','prod','staging'].map(name => [name,{baseUrl:'https://fixture.example.test'}])) });
  mkdirSync(join(root, LAYOUT.collection), { recursive: true });
  mkdirSync(join(root, LAYOUT.evidence), { recursive: true });
  const env = { ...process.env, [HOME_ENV_NAME]: join(root, 'isolated-home') };
  const entry = { verified_at: null, contract_digest: null, shape_hash: null,
    status_codes: [], fields: {}, notes: ['The date range is required.'] };
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0,
    api: { name: 'fixture', contract: null, contract_digest: null }, operations: { [operation]: entry } }));
  return { root, env, entry };
}

test('show reveals recorded HTTP observations without promoting legacy verification or payload values', t => {
  const { root, env, entry } = fixture(t);
  const identity = { provider: 'https://fixture.example.test', environment: 'prod', protocol: 'http',
    operation, endpoint: 'https://fixture.example.test/slots/{slotId}', contractDigest: null };
  for (const status of [422, 200]) {
    const path = join(root, LAYOUT.evidence, `response-${status}.json`);
    writeFileSync(path, JSON.stringify({ private: 'PRIVATE_EVIDENCE_VALUE', status }));
    assert.equal(captureHttpContext(root, { capture_context: true, identity, status, complete: true,
      response: { field: 'PRIVATE_RESPONSE_VALUE' }, evidencePath: path,
      assertions: status === 200 ? { passed: 1, failed: 0 } : { passed: 0, failed: 1 },
    }, { env }).state, 'captured');
  }
  const before = readFileSync(join(root, LAYOUT.context), 'utf8');
  const stdout = execFileSync(process.execPath, [cli, 'show', operation], { cwd: root, env, encoding: 'utf8' });
  const shown = JSON.parse(stdout);
  assert.equal(shown.verified_at, null);
  assert.deepEqual(shown.status_codes, []);
  assert.deepEqual(shown.notes, entry.notes);
  assert.equal(shown.scoped.operations.length, 1);
  const observed = shown.scoped.operations[0];
  assert.equal(observed.identity.environment, 'prod');
  assert.deepEqual(observed.observations.map(o => o.response_status), [422, 200]);
  assert.deepEqual(observed.observations.map(o => o.assertions), [{ passed: 0, failed: 1 }, { passed: 1, failed: 0 }]);
  assert.ok(observed.observations.every(o => o.verification === 'client-observation'));
  assert.ok(observed.observations.every(o => o.evidence[0].state === 'matching'));
  assert.doesNotMatch(stdout, /PRIVATE_EVIDENCE_VALUE|PRIVATE_RESPONSE_VALUE/);
  assert.equal(readFileSync(join(root, LAYOUT.context), 'utf8'), before, 'inspection does not rewrite knowledge');
});

test('show retains notes while reporting damaged scoped history rather than presenting it as absent', t => {
  const { root, env, entry } = fixture(t);
  const path = join(root, LAYOUT.context), ctx = JSON.parse(readFileSync(path, 'utf8'));
  ctx.api_context = { v: 999, operations: {} };
  writeFileSync(path, JSON.stringify(ctx));
  const shown = JSON.parse(execFileSync(process.execPath, [cli, 'show', operation], { cwd: root, env, encoding: 'utf8' }));
  assert.deepEqual(shown.notes, entry.notes);
  assert.equal(shown.scoped.operations.length, 0);
  assert.ok(shown.scoped.issues.length > 0);
});

test('show can retrieve an exact scoped operation with no legacy entry', t => {
  const { root, env } = fixture(t);
  const path = join(root, LAYOUT.context), ctx = JSON.parse(readFileSync(path, 'utf8'));
  ctx.operations = {};
  writeFileSync(path, JSON.stringify(ctx));
  const identity = { provider: 'https://fixture.example.test', environment: 'staging', protocol: 'http',
    operation, endpoint: 'https://fixture.example.test/slots/{slotId}', contractDigest: null };
  assert.equal(captureHttpContext(root, { capture_context: true, identity, status: 200,
    complete: true, response: { ready: true } }, { env }).state, 'captured');
  const shown = JSON.parse(execFileSync(process.execPath, [cli, 'show', operation], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(shown.legacy, null);
  assert.equal('verified_at' in shown, false);
  assert.equal('confidence' in shown, false);
  assert.equal(shown.scoped.operations[0].identity.environment, 'staging');
  assert.equal(shown.scoped.operations[0].observations[0].response_status, 200);
});

test('show reports malformed knowledge as unavailable instead of claiming there is no history', t => {
  const { root, env } = fixture(t);
  writeFileSync(join(root, LAYOUT.context), '{private-damaged-content');
  let failure;
  try { execFileSync(process.execPath, [cli, 'show', operation], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }); }
  catch (error) { failure = error; }
  assert.equal(failure?.status, 1);
  const shown = JSON.parse(failure.stdout);
  assert.equal(shown.legacy, null);
  assert.ok(shown.scoped.issues.length > 0);
  assert.doesNotMatch(failure.stdout, /private-damaged-content/);
});

test('show reports unusable or oversized knowledge without crashing or reading unbounded input', t => {
  const { root, env } = fixture(t), path = join(root, LAYOUT.context);
  for (const input of [{}, { v: 0, operations: null }, { v: 0, operations: [] }]) {
    writeFileSync(path, JSON.stringify(input));
    let failure;
    try { execFileSync(process.execPath, [cli, 'show', operation], { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }); }
    catch (error) { failure = error; }
    assert.equal(failure?.status, 1);
    assert.ok(JSON.parse(failure.stdout).scoped.issues.length > 0);
    assert.doesNotMatch(failure.stderr, /TypeError|Cannot convert/);
  }
  truncateSync(path, 16 * 1024 * 1024 + 1);
  assert.throws(() => execFileSync(process.execPath, [cli, 'show', operation],
    { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /CONTEXT_TOO_LARGE/);
    return true;
  });
});
