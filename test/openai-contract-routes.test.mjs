import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operationsFrom } from '../lib/context.mjs';
import { loadHttpContract, matchHttpOperation } from '../lib/http-operation-context.mjs';
import { LAYOUT } from '../lib/layout.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
// Synthetic only: seven query-bearing keys, eight operations (one GET/DELETE
// pair), alongside a usable route. No upstream document is copied or changed.
const spec = () => ({ openapi: '3.1.0', info: { title: 'fixture', version: '1' }, paths: {
  '/models': { get: {} },
  '/responses?beta=true': { post: {} },
  '/responses/{response_id}?beta=true': { get: {}, delete: {} },
  '/responses/{response_id}/cancel?beta=true': { post: {} },
  '/responses/compact?beta=true': { post: {} },
  '/responses/{response_id}/input_items?beta=true': { get: {} },
  '/responses/input_tokens?beta=true': { post: {} },
  '/synthetic?credential=DO_NOT_LOG_QUERY_VALUE': { get: {} },
} });

function fixture(t, doc = spec()) {
  const root = mkdtempSync(join(tmpdir(), 'contract-routes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const file = join(root, 'openapi.json');
  writeFileSync(file, JSON.stringify(doc));
  mkdirSync(dirname(join(root, LAYOUT.environments)), { recursive: true });
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: 'http://127.0.0.1:1/v1', contract: 'openapi.json' },
  } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: join(root, 'home'), SANNR_HOME: join(root, 'home/state'),
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_FRICTION_OFF: '1' });
  return { root, file, env };
}

test('one query-bearing key never discards the usable HTTP contract', t => {
  const { file } = fixture(t), diagnostics = [];
  const contract = loadHttpContract(file, { onDiagnostic: item => diagnostics.push(item) });
  assert.ok(contract, 'mixed contract must load instead of returning null');
  assert.equal(matchHttpOperation(contract, 'GET', '/models')?.op, 'GET /models');
  assert.equal(diagnostics.length, 7, 'one diagnostic per skipped key');
  assert.equal(diagnostics.reduce((n, d) => n + d.methods.length, 0), 8);
  assert.ok(diagnostics.every(d => d.code === 'HTTP_CONTRACT_ROUTE_SKIPPED' && d.reason === 'literal-query-suffix'));
  assert.match(JSON.stringify(diagnostics), /\/responses/);
  assert.doesNotMatch(JSON.stringify(diagnostics), /beta=true|DO_NOT_LOG_QUERY_VALUE/);
  assert.deepEqual(contract.skippedRoutes, diagnostics);
});

test('operation inventory and runtime agree on skipped query routes', t => {
  const { file } = fixture(t), skipped = [];
  const operations = operationsFrom(spec(), { onSkipped: item => skipped.push(item) });
  assert.deepEqual(operations.map(o => o.op), ['GET /models']);
  assert.equal(skipped.length, 7);
  assert.deepEqual(loadHttpContract(file).routes.map(({ endpointPath, ...op }) => op), operations);
});

test('all invalid route forms skip individually, including effective Swagger base paths', t => {
  const doc = { openapi: '3.0.0', paths: { '/ok': { get: {} }, 'relative': { get: {} },
    '/white space': { get: {} }, '/fragment#value': { get: {} }, '/back\\slash': { get: {} },
    '/dot/../escape': { get: {} } } };
  const { file } = fixture(t, doc), diagnostics = [];
  const contract = loadHttpContract(file, { onDiagnostic: d => diagnostics.push(d) });
  assert.ok(contract);
  assert.deepEqual(contract.routes.map(o => o.op), ['GET /ok']);
  assert.equal(diagnostics.length, 5);
  assert.deepEqual(operationsFrom({ swagger: '2.0', basePath: '/bad/../mount', paths: { '/ok': { get: {} } } }), []);
});

test('init inventory and offline doctor report precisely what the client skips', t => {
  const { root, env } = fixture(t);
  const output = execFileSync(process.execPath, [CLI, 'init'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(JSON.parse(output).operations, 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, LAYOUT.context), 'utf8')).operations), ['GET /models']);
  const report = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--offline', '--json'], { cwd: root, env, encoding: 'utf8' }));
  const routes = report.checks.find(c => c.name === 'contract-routes');
  assert.equal(routes?.state, 'WARN');
  assert.match(routes.detail, /7 path keys.*8 operations.*skipped/);
  assert.match(routes.detail, /\/responses.*literal-query-suffix/);
  const mount = report.checks.find(c => c.name === 'contract-mount');
  assert.equal(mount?.state, 'PASS');
  assert.match(mount.detail, /\/v1.*base-url-path/);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_LOG_QUERY_VALUE|beta=true/);
});

test('all-skipped contracts have a named rejection and doctor failure', t => {
  const { root, file, env } = fixture(t, { openapi: '3.0.0', paths: { '/bad?beta=true': { get: {} } } });
  const diagnostics = [];
  assert.equal(loadHttpContract(file, { onDiagnostic: d => diagnostics.push(d) }), null);
  assert.equal(diagnostics.at(-1)?.reason, 'no-matchable-routes');
  let report;
  try { execFileSync(process.execPath, [CLI, 'doctor', '--offline', '--json'], { cwd: root, env, encoding: 'utf8' }); }
  catch (error) { report = JSON.parse(error.stdout); }
  assert.ok(report, 'doctor must fail when all declared operations are skipped');
  assert.equal(report.checks.find(c => c.name === 'contract-routes')?.state, 'FAIL');
});

test('offline doctor diagnoses named contracts independently of a missing primary contract', t => {
  const { root, file, env } = fixture(t);
  const vendor = join(root, 'vendor.json');
  writeFileSync(vendor, readFileSync(file));
  rmSync(file);
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: 'http://127.0.0.1:1' },
  }, hosts: { vendor: { baseUrl: 'http://127.0.0.1:2/v1', contract: 'vendor.json' } } }));
  const report = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--offline', '--json'], { cwd: root, env, encoding: 'utf8' }));
  assert.equal(report.checks.find(c => c.name === 'contract-routes:vendor')?.state, 'WARN');
  assert.match(report.checks.find(c => c.name === 'contract-mount:vendor')?.detail, /base-url-path/);
});

test('a broken diagnostic sink never rejects an otherwise usable contract', t => {
  const { file } = fixture(t);
  const contract = loadHttpContract(file, { onDiagnostic() { throw new Error('synthetic sink failure'); } });
  assert.equal(matchHttpOperation(contract, 'GET', '/models')?.op, 'GET /models');
  assert.equal(contract.skippedRoutes.length, 7);
});

test('skipped-route diagnostics withhold credential-shaped path text before any output', t => {
  const planted = `ghp_${'X'.repeat(30)}`;
  const { file } = fixture(t, { openapi: '3.0.0', paths: {
    '/models': { get: {} }, [`/${planted}?beta=true`]: { get: {} },
  } });
  const diagnostics = [];
  const contract = loadHttpContract(file, { onDiagnostic: item => diagnostics.push(item) });
  assert.ok(contract);
  assert.equal(diagnostics.length, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(planted));
  assert.match(diagnostics[0].path, /redacted|withheld/i);
});
