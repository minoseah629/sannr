import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { createFixtureStack, inFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT as REPO_LAYOUT } from '../lib/layout.mjs';
import { captureOperationContext } from '../lib/operation-context.mjs';
import { loadHttpContract } from '../lib/http-operation-context.mjs';
import { showObservationSummary } from '../lib/show-observations.mjs';
import { resolveConfig } from '../lib/config.mjs';

const LAYOUT = { ...REPO_LAYOUT, context: join(REPO_LAYOUT.collection,'fixture','sannr.json') };
const execute = promisify(execFile);
const cli = process.env.HOUSEHOLD_SHOW_CLI ?? fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const client = new URL('../lib/client.mjs', import.meta.url).href;
const operation = 'GET /v1/hubs/{hubId}/tasks';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'household-show-'));
  let status = 200, requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tasks: [{ label: 'PRIVATE_HOUSEHOLD_VALUE', ready: true }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const provider = `http://127.0.0.1:${server.address().port}`;
  const contract = join(root, 'openapi.json');
  writeFileSync(contract, JSON.stringify({ openapi: '3.0.0', paths: {
    '/v1/hubs/{hubId}/tasks': { get: {} }, '/unobserved': { get: {} },
  } }));
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local', environments: {
    local: { baseUrl: provider, contract: 'openapi.json' },
    staging: { baseUrl: provider, contract: 'openapi.json' },
  }, hosts: { alternate: { baseUrl: `${provider}/alternate`, contract: 'openapi.json', contractPathPrefix: '/alternate' } } }));
  const primaryScope = createFixtureStack(root, { contract, environments:{
    local:{baseUrl:provider},staging:{baseUrl:provider},
  } });
  createFixtureStack(root,{name:'alternate',contract,baseUrl:`${provider}/alternate`,
    environmentConfig:{contractPathPrefix:'/alternate'} });
  writeFileSync(join(root,REPO_LAYOUT.directory,'defaults.json'),JSON.stringify({default_stack:'fixture'}));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { SANNR_HOME: join(root, 'isolated-home'), API_CONTEXT_DIR: root,
    API_CONFIG: join(root, LAYOUT.environments), API_EVIDENCE: join(root, LAYOUT.evidence),
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_BUDGET: '4000', API_FRICTION_OFF: '1' });
  const command = async (args, overrides = {}) => execute(process.execPath, [cli, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  });
  await command(['init']);
  const request = async (args = { path: '/v1/hubs/private-id/tasks' }, overrides = {}) => {
    const result = await execute(process.execPath, ['--input-type=module', '-e',
      `const { apiRequest } = await import(${JSON.stringify(client)}); process.stdout.write(JSON.stringify(await apiRequest(${JSON.stringify(args)})));`],
    { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout);
  };
  const context = () => JSON.parse(readFileSync(join(root, LAYOUT.context), 'utf8'));
  const changeContext = mutate => { const value = context(); mutate(value); writeFileSync(join(root, LAYOUT.context), JSON.stringify(value)); };
  const show = async (...args) => JSON.parse((await command(['show', operation, ...args])).stdout);
  return { root, provider, env, contract:primaryScope.config.contract, command, request, context, changeContext, show,
    setStatus: value => { status = value; }, requests: () => requests };
}

test('show classifies two real client responses as observed without certifying legacy fields or making a request', async t => {
  const f = await fixture(t);
  const first = await f.request(), second = await f.request();
  assert.equal(first.context_capture.state, 'captured');
  assert.equal(second.context_capture.state, 'captured');
  const before = readFileSync(join(f.root, LAYOUT.context), 'utf8');
  const shown = await f.show();
  if (process.env.HOUSEHOLD_SHOW_RECEIPT) writeFileSync(process.env.HOUSEHOLD_SHOW_RECEIPT, JSON.stringify({
    calls: f.requests(), first_capture: first.context_capture, second_capture: second.context_capture,
    first_evidence: first.evidence, second_evidence: second.evidence, shown,
    source_note: 'Two actual client GETs against the controlled loopback fixture; show sends no API request.',
  }, null, 2));
  assert.equal(shown.confidence, 'observed');
  assert.equal(shown.legacy_confidence, 'unverified');
  assert.equal(shown.verified_at, null);
  assert.deepEqual(shown.status_codes, []);
  const summary = shown.observation_summary;
  assert.equal(summary.state, 'observed');
  assert.equal(summary.observation_count, 2);
  assert.equal(summary.successful_response_count, 2);
  assert.deepEqual(summary.observed_status_codes, [200]);
  assert.equal(summary.scope.environment, 'local');
  assert.equal(summary.scope.provider, f.provider);
  assert.equal(summary.scope.operation, operation);
  assert.equal(summary.scope.contractDigest, first.context_capture.identity.contractDigest);
  assert.deepEqual(new Set(summary.observations.map(item => item.observation_id)),
    new Set([first.context_capture.observation_id, second.context_capture.observation_id]));
  assert.ok(summary.observations.every(item => item.assertions === null && item.evidence[0].state === 'matching'));
  assert.equal(summary.observed_at, second.context_capture.observed_at ?? summary.observations[0].observed_at);
  const human = (await f.command(['show', operation, '--human'])).stdout;
  assert.match(human, /— observed/);
  assert.match(human, /Legacy execution verification: unverified; verified_at: none/);
  assert.match(human, /2 retained response\(s\); statuses: 200/);
  assert.match(human, /not asserted/);
  assert.doesNotMatch(JSON.stringify(shown), /PRIVATE_HOUSEHOLD_VALUE|private-id/);
  assert.equal(readFileSync(join(f.root, LAYOUT.context), 'utf8'), before);
  assert.equal(f.requests(), 2, 'show performs zero API requests');
});

test('show keeps other environment, provider and old-contract history separate from its exact selected scope', async t => {
  const f = await fixture(t);
  await f.request();
  await f.request(undefined, { API_ENV: 'staging' });
  await f.request({ upstream: 'alternate', path: '/v1/hubs/private-id/tasks' });
  const other = await f.show('--env', 'staging');
  assert.equal(other.observation_summary.scope.environment, 'staging');
  assert.equal(other.observation_summary.observation_count, 1);
  const local = await f.show();
  assert.equal(local.observation_summary.observation_count, 1);
  assert.equal(local.scoped.operations.length, 2, 'other environments remain available within the selected stack');
  const alternate = await f.show('--stack','alternate');
  assert.equal(alternate.scoped.operations.length, 1, 'the other provider remains available through its own stack');
  writeFileSync(f.contract, JSON.stringify({ openapi: '3.0.0', info: { title: 'New contract bytes' }, paths: {
    '/v1/hubs/{hubId}/tasks': { get: {} }, '/unobserved': { get: {} },
  } }));
  const changed = await f.show();
  assert.equal(changed.confidence, 'unverified');
  assert.equal(changed.observation_summary.state, 'none');
  assert.equal(changed.observation_summary.observation_count, 0);
  assert.equal(changed.scoped.operations.length, 2);
  assert.notEqual(changed.observation_summary.scope.contractDigest, local.observation_summary.scope.contractDigest);
});

test('show refuses missing, changed, unchecked, stale, future or incomplete observations for its positive label', async t => {
  const f = await fixture(t);
  const response = await f.request();
  const saved = f.context(), entry = Object.values(saved.api_context.operations)[0];
  const evidenceFile = join(f.root, entry.observations[0].evidence[0].path);
  const originalEvidence = readFileSync(evidenceFile, 'utf8');
  unlinkSync(evidenceFile);
  let shown = await f.show();
  assert.equal(shown.confidence, 'unverified');
  assert.equal(shown.observation_summary.excluded['evidence-not-matching'], 1);
  assert.equal(shown.scoped.operations[0].observations[0].evidence[0].state, 'missing-or-unavailable');
  writeFileSync(evidenceFile, originalEvidence + ' ');
  shown = await f.show();
  assert.equal(shown.confidence, 'unverified');
  assert.equal(shown.scoped.operations[0].observations[0].evidence[0].state, 'changed');
  writeFileSync(evidenceFile, originalEvidence);
  for (const [reason, mutate] of [
    ['stale-observation', observation => { observation.observed_at = '2020-01-01T00:00:00.000Z'; }],
    ['future-observation', observation => { observation.observed_at = '2099-01-01T00:00:00.000Z'; }],
    ['incomplete-or-status-unavailable', observation => { observation.complete = false; observation.outcome = 'partial'; }],
  ]) {
    writeFileSync(join(f.root, LAYOUT.context), JSON.stringify(saved));
    f.changeContext(value => mutate(Object.values(value.api_context.operations)[0].observations[0]));
    shown = await f.show();
    assert.equal(shown.confidence, 'unverified', reason);
    assert.equal(shown.observation_summary.excluded[reason], 1);
    assert.equal(shown.scoped.operations[0].observations.length, 1);
  }
  writeFileSync(join(f.root, LAYOUT.context), JSON.stringify(saved));
  // More than twenty references share the existing bounded evidence checker.
  // A duplicated fixture record is not independent execution; the test checks
  // that the unchecked references are excluded, rather than inflating proof.
  f.changeContext(value => {
    const current = Object.values(value.api_context.operations)[0];
    current.observations = Array.from({ length: 20 }, (_, index) => ({ ...current.observations[0],
      id: `fixture-${index}`, evidence: Array.from({ length: 8 }, () => ({ ...current.observations[0].evidence[0] })) }));
  });
  shown = await f.show();
  assert.equal(shown.observation_summary.observation_count, 2);
  assert.equal(shown.observation_summary.excluded['evidence-not-matching'], 18);
  assert.equal(shown.observation_summary.omissions.evidence_checks, 140);
  assert.equal(f.requests(), 1);
  assert.equal(response.status, 200);
});

test('authored assertions and a later authentication failure never become execution verification', async t => {
  const f = await fixture(t);
  const real = await f.request({ path: '/v1/hubs/private-id/tasks', expect: [{ status: 200 }] });
  const identity = real.context_capture.identity;
  inFixtureStack(f.root, () => captureOperationContext(f.root, { identity, basis: 'authored', source: { tool: 'external-test-claim' },
    complete: true, outcome: 'success', assertions: { passed: 99, failed: 0 }, notes: ['An author claims the response was checked.'] }));
  let shown = await f.show();
  assert.equal(shown.observation_summary.observation_count, 1);
  assert.equal(shown.observation_summary.excluded['authored-or-non-http-client'], 1);
  assert.equal(shown.confidence, 'observed');
  f.setStatus(401);
  await f.request({ path: '/v1/hubs/private-id/tasks', expect: [{ status: 401 }] });
  shown = await f.show();
  assert.equal(shown.confidence, 'unverified');
  assert.equal(shown.verified_at, null);
  assert.equal(shown.observation_summary.latest_response_status, 401);
  assert.deepEqual(shown.observation_summary.observed_status_codes, [200, 401]);
  assert.deepEqual(shown.observation_summary.latest_assertions, { passed: 1, failed: 0 });
  f.setStatus(200);
  await f.request({ path: '/v1/hubs/private-id/tasks', expect: [{ status: 201 }] });
  shown = await f.show();
  assert.equal(shown.confidence, 'unverified', 'an unexpected 200 does not turn a failed check into successful observation status');
  assert.deepEqual(shown.observation_summary.latest_assertions, { passed: 0, failed: 1 });
});

test('scoped-only observations use the human renderer and summary while unknown operations remain unobserved', async t => {
  const f = await fixture(t);
  await f.request();
  f.changeContext(value => { value.operations = {}; });
  const shown = await f.show();
  assert.equal(shown.confidence, 'observed');
  assert.equal(shown.legacy, null);
  assert.equal('verified_at' in shown, false);
  assert.match((await f.command(['show', operation, '--human'])).stdout, /— observed/);
  const config = resolveConfig(f.root);
  config.baseUrl = f.provider;
  config.baseUrlSource = 'config';
  config.baseUrlOverride = false;
  config.name = 'local';
  const unknown = inFixtureStack(f.root, () => showObservationSummary(f.root, 'GET /unobserved', { config, contract: loadHttpContract(f.contract) }));
  assert.equal(unknown.state, 'none');
  assert.equal(unknown.observation_count, 0);
});

test('latest observation time is chronological and retention omissions are explicit', async t => {
  const f = await fixture(t);
  await f.request();
  await f.request();
  f.changeContext(value => {
    const entry = Object.values(value.api_context.operations)[0];
    entry.observations[0].observed_at = new Date(Date.now() - 1000).toISOString();
    entry.observations[1].observed_at = new Date(Date.now() - 2000).toISOString();
    entry.omitted_observations = 4;
  });
  const shown = await f.show();
  const history = Object.values(f.context().api_context.operations)[0].observations;
  assert.equal(shown.observation_summary.observed_at, history[0].observed_at);
  assert.equal(shown.observation_summary.omissions.observations, 4);
  assert.equal(shown.observation_summary.observation_count, 2, 'count names retained responses, not total lifetime requests');
});

test('unknown saved entry fields cannot overwrite the computed observation or confidence projection', async t => {
  const f = await fixture(t);
  await f.request();
  f.changeContext(value => {
    value.operations[operation].confidence = 'verified';
    value.operations[operation].observation_summary = { state: 'unverified' };
    value.operations[operation].unknown_metadata = { retained: true };
  });
  const shown = await f.show();
  assert.equal(shown.confidence, 'observed');
  assert.equal(shown.legacy_confidence, 'unverified');
  assert.equal(shown.observation_summary.state, 'observed');
  assert.deepEqual(shown.unknown_metadata, { retained: true });
  assert.match((await f.command(['show', operation, '--human'])).stdout, /— observed/);
});

test('newest tied error or failed assertion and unavailable newer evidence cannot hide behind an earlier successful response', async t => {
  const f = await fixture(t);
  await f.request();
  f.setStatus(401);
  await f.request({ path: '/v1/hubs/private-id/tasks', expect: [{ status: 401 }] });
  const saved = f.context();
  f.changeContext(value => {
    const observations = Object.values(value.api_context.operations)[0].observations;
    const sameTime = new Date(Date.now() - 1000).toISOString();
    for (const observation of observations) observation.observed_at = sameTime;
    observations[0].id = 'a-positive';
    observations[1].id = 'z-authentication-error';
  });
  let shown = await f.show();
  assert.equal(shown.confidence, 'unverified');
  assert.deepEqual(shown.observation_summary.latest_recorded_status_codes, [200, 401]);
  assert.equal(shown.observation_summary.latest_tied_observations, 2);
  assert.equal(shown.observation_summary.latest_response_eligible, false);
  f.changeContext(value => {
    const observations = Object.values(value.api_context.operations)[0].observations;
    observations[1].response_status = 200;
    observations[1].outcome = 'success';
    observations[1].assertions = { passed: 0, failed: 1 };
  });
  shown = await f.show();
  assert.equal(shown.confidence, 'unverified');
  assert.equal(shown.observation_summary.latest_response_eligible, false);
  writeFileSync(join(f.root, LAYOUT.context), JSON.stringify(saved));
  const newer = Object.values(saved.api_context.operations)[0].observations[1];
  unlinkSync(join(f.root, newer.evidence[0].path));
  shown = await f.show();
  assert.equal(shown.observation_summary.observation_count, 1);
  assert.equal(shown.confidence, 'unverified', 'newer unavailable error evidence cannot renew an older successful response');
  assert.deepEqual(shown.observation_summary.latest_recorded_status_codes, [401]);
  assert.equal(shown.observation_summary.latest_response_eligible, false);
});
