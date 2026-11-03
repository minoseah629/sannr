import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureOperationContext as captureRaw, queryOperationContext as queryRaw } from '../lib/operation-context.mjs';

import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
const captureOperationContext = (root, ...args) => inFixtureStack(root, () => captureRaw(root, ...args));
const queryOperationContext = (root, ...args) => inFixtureStack(root, () => queryRaw(root, ...args));

const identity = { stack: 'fixture', provider: 'http://fixture.invalid', environment: 'local', protocol: 'http',
  operation: 'GET /health', endpoint: 'http://fixture.invalid/health', contractDigest: `sha256:${'a'.repeat(64)}` };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'response-change-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFixtureStack(root, { baseUrl: identity.provider });
  let index = 0;
  const capture = (overrides = {}, options = { internal: true }) => {
    const path = `${fixtureEvidencePath()}/evidence-${++index}.json`;
    writeFileSync(join(root, path), JSON.stringify({ record: index, private: 'evidence-payload-private' }));
    const input = { identity, source: { tool: 'api_request:http' }, basis: 'observed',
      outcome: 'success', complete: true, status: 200, request: { params: {}, body: null },
      response: { counts: { deployment_events: 41 } }, notes: ['HTTP response status 200.'],
      evidence: [{ path }], ...overrides };
    for (const key of Object.keys(input)) if (input[key] === undefined) delete input[key];
    return captureOperationContext(root, input, options);
  };
  const stored = () => JSON.parse(readFileSync(fixtureContextFile(root), 'utf8'));
  return { root, capture, stored };
}

test('numeric → string → numeric observations produce scoped structural advisories, without changing history or creating lessons', t => {
  const f = fixture(t);
  const numeric = f.capture();
  assert.equal(numeric.change_notice, undefined);
  const firstStored = f.stored().api_context.operations[numeric.operation_id].observations[0];
  const string = f.capture({ response: { counts: { deployment_events: 'value-private-string' } } });
  const restored = f.capture({ response: { counts: { deployment_events: 42 } }, assertions: { passed: 0, failed: 1 } });
  for (const [result, previous, previousType, currentType] of [
    [string, numeric, 'number', 'string'], [restored, string, 'string', 'number'],
  ]) {
    const notice = result.change_notice;
    assert.equal(notice.code, 'RESPONSE_STRUCTURE_CHANGED');
    assert.equal(notice.previous.observation_id, previous.observation_id);
    assert.equal(notice.current.observation_id, result.observation_id);
    assert.deepEqual(notice.changes, [{ path: '/counts/deployment_events', previous_type: previousType, current_type: currentType }]);
    assert.equal(notice.previous.status_basis, 'response_status');
    assert.ok(notice.previous.evidence.path);
    assert.ok(notice.current.evidence.path);
    assert.match(notice.next, /api_context_record/);
    assert.match(notice.meaning, /not schema validation or a semantic conclusion/);
    assert.doesNotMatch(JSON.stringify(notice), /value-private|payload-private/);
  }
  const observations = f.stored().api_context.operations[numeric.operation_id].observations;
  assert.equal(observations.length, 3);
  assert.deepEqual(observations[0], firstStored);
  assert.ok(observations.every(observation => !Object.hasOwn(observation, 'change_notice')));
  assert.equal(f.capture({ response: { counts: { deployment_events: 43 } } }).change_notice, undefined);
  assert.doesNotMatch(readFileSync(fixtureContextFile(f.root), 'utf8'), /value-private|payload-private/);
});

test('old HTTP client records use only their unique canonical status note, with explicit legacy basis and no migration', t => {
  const f = fixture(t);
  const old = f.capture({ status: undefined, response: { counts: { deployment_events: 'old-private-string' } } });
  const before = f.stored().api_context.operations[old.operation_id].observations[0];
  assert.equal(before.response_status, undefined);
  const next = f.capture();
  assert.equal(next.change_notice.previous.observation_id, old.observation_id);
  assert.equal(next.change_notice.previous.status_basis, 'legacy_note');
  assert.equal(next.change_notice.current.status_basis, 'response_status');
  assert.deepEqual(f.stored().api_context.operations[old.operation_id].observations[0], before);
  const [queried] = queryOperationContext(f.root, identity, { env: { SANNR_HOME: join(f.root, 'home') } }).operations;
  assert.equal(queried.observations.find(observation => observation.id === next.observation_id).response_status, 200);
});

test('provider, environment, endpoint, operation, protocol and digest changes cannot borrow another identity', t => {
  for (const changed of [
    { provider: 'another-provider' }, { environment: 'staging' }, { endpoint: 'http://fixture.invalid/other-health' },
    { operation: 'GET /other-health' }, { protocol: 'graphql' }, { contractDigest: `sha256:${'b'.repeat(64)}` },
    { contractDigest: null },
  ]) {
    const f = fixture(t); f.capture();
    const result = f.capture({ identity: { ...identity, ...changed }, response: { counts: { deployment_events: 'changed-private-value' } } });
    assert.equal(result.change_notice, undefined, JSON.stringify(changed));
  }
});

test('incomplete, error, authored, request-incompatible and status-incompatible records do not supply a comparison', t => {
  const differences = [
    { complete: false }, { outcome: 'error' }, { outcome: 'partial' }, { basis: 'authored' },
    { request: { params: { filter: 'private' }, body: null } }, { status: 201 },
    { status: undefined, notes: ['Status is 200, probably.'] },
    { status: undefined, notes: ['HTTP response status 200.', 'HTTP response status 201.'] },
    { status: undefined, source: { tool: 'another-client' } },
  ];
  for (const baseline of differences) {
    const f = fixture(t); f.capture(baseline);
    assert.equal(f.capture({ response: { counts: { deployment_events: 'changed-private-value' } } }).change_notice, undefined,
      JSON.stringify(baseline));
  }
  for (const current of [{ complete: false }, { outcome: 'error', status: 500 }, { basis: 'declared' },
    { outcome: 'timeout' }]) {
    const f = fixture(t); f.capture();
    assert.equal(f.capture({ response: { counts: { deployment_events: 'changed-private-value' } }, ...current }).change_notice, undefined);
  }
  const f = fixture(t); f.capture({}, { internal: false });
  assert.equal(f.capture({ response: { counts: { deployment_events: 'changed-private-value' } } }).change_notice, undefined);
  assert.equal(f.capture({ response: { counts: { deployment_events: 'changed-private-value' } } }, { internal: false }).change_notice, undefined);
});

test('only matched type paths are compared; field absence, nulls, array samples and omitted nodes do not infer changes', t => {
  const f = fixture(t);
  f.capture({ response: { keep: true, removed: 1, optional: null, rows: [{ count: 1 }] } });
  const result = f.capture({ response: { keep: false, added: 'private-value', optional: 'private-value', rows: [{ count: 'private-value' }] } });
  assert.equal(result.change_notice, undefined);
  let before = { value: 1 }, after = { value: 'private-value' };
  for (let i = 0; i < 12; i++) { before = { deep: before }; after = { deep: after }; }
  const deep = fixture(t); deep.capture({ response: before });
  assert.equal(deep.capture({ response: after }).change_notice, undefined);
});

test('type notices escape JSON pointers, cap changed paths, and use the most recent comparable shape', t => {
  const f = fixture(t);
  const before = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key/${i}~`, i]));
  const after = Object.fromEntries(Object.keys(before).map(key => [key, 'changed-private-value']));
  f.capture({ response: before });
  const latest = f.capture({ request: { body: null, params: {} }, response: before });
  const result = f.capture({ response: after });
  assert.equal(result.change_notice.previous.observation_id, latest.observation_id);
  assert.equal(result.change_notice.changes.length, 8);
  assert.equal(result.change_notice.omitted_changes, 12);
  assert.ok(result.change_notice.changes.every(change => /^\/key~1\d+~0$/.test(change.path)));
  assert.doesNotMatch(JSON.stringify(result.change_notice), /changed-private-value/);
});
