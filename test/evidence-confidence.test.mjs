import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { evidenceClass, evidenceClassCounts, formatEvidenceClasses, evidenceOperations,
  rankNoteRecords, projectKnownNotes, deriveNoteContradictions } from '../lib/evidence-confidence.mjs';
import { inspectNoteHistory } from '../lib/note-history.mjs';
import { captureOperationContext, queryOperationContext } from '../lib/operation-context.mjs';
import { captureHttpContext, loadHttpContract } from '../lib/http-operation-context.mjs';
import { showObservationSummary } from '../lib/show-observations.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';

const now = Date.parse('2026-10-09T12:00:00Z');
const at = new Date(now - 1000).toISOString();
const digest = `sha256:${'a'.repeat(64)}`;
function summary(overrides = {}) {
  const observation = { observation_id: 'one', observed_at: at, response_status: 200,
    outcome: 'success', assertions: null, evidence: [{ path: '.sannr/evidence/run-one.json', digest, state: 'matching' }] };
  return { state: 'observed', scope: {}, latest_recorded_observed_at: at,
    latest_tied_observations: 1, latest_response_eligible: true,
    observations: [observation], issues: [], omissions: {}, ...overrides };
}
test('four exclusive evidence classes require actual passing assertions and fresh learn', () => {
  assert.equal(evidenceClass({ now }).class, 'written');
  assert.equal(evidenceClass({ summary: summary(), now }).class, 'observed');
  const asserted = summary(); asserted.observations[0].assertions = { passed: 2, failed: 0 };
  assert.equal(evidenceClass({ summary: asserted, now }).class, 'asserted');
  asserted.observations[0].assertions = { passed: 0, failed: 0 };
  assert.equal(evidenceClass({ summary: asserted, now }).class, 'observed');
  assert.equal(evidenceClass({ entry: { verified_at: at, status_codes: [200] }, freshness: { confidence: 'verified' }, now }).class, 'verified');
  const counts = evidenceClassCounts(['written','observed','asserted','verified'].map(value => ({ class: value })));
  assert.deepEqual(counts, { written: 1, observed: 1, asserted: 1, verified: 1 });
  assert.equal(formatEvidenceClasses(counts), '1 written, 1 observed, 1 asserted, 1 verified');
});
test('latest failures, tied failures, stale and unavailable evidence never become green', () => {
  const failed = summary({ latest_response_eligible: false });
  failed.observations[0].response_status = 401; failed.observations[0].outcome = 'error';
  const result = evidenceClass({ summary: failed, entry: { verified_at: new Date(now - 2000).toISOString() }, freshness: { confidence: 'verified' }, now });
  assert.equal(result.class, 'observed'); assert.equal(result.current_success, false);
  const tied = summary({ latest_tied_observations: 2, latest_response_eligible: false });
  tied.observations.push(failed.observations[0]);
  assert.equal(evidenceClass({ summary: tied, now }).current_success, false);
  assert.equal(evidenceClass({ summary: summary({ observations: [], latest_response_eligible: false }), now }).class, 'written');
  assert.equal(evidenceClass({ summary: summary({ issues: [{ code: 'CONTEXT_INVALID' }] }), now }).class, 'written');
  assert.equal(evidenceClass({ entry: { verified_at: '2020-01-01' }, freshness: { confidence: 'verified' }, now }).class, 'written');
  assert.equal(evidenceClass({ summary: summary(), now: now + 181 * 86400000 }).class, 'written');
  assert.equal(evidenceClass({ entry: { verified_at: at, status_codes: [500] }, freshness: { confidence: 'verified' }, now }).class, 'written');
});
test('operation union excludes captured identities from another stack or environment', () => {
  const config = { stack: 'a', name: 'local', baseUrl: 'https://example.test' };
  const identity = { stack: 'a', environment: 'local', protocol: 'http', provider: config.baseUrl, contractDigest: 'abc', operation: 'GET /captured' };
  const ctx = { operations: { 'GET /saved': {} }, api_context: { operations: {
    a: { identity }, b: { identity: { ...identity, stack: 'b', operation: 'GET /wrong-stack' } },
    c: { identity: { ...identity, environment: 'prod', operation: 'GET /wrong-env' } },
  } } };
  assert.deepEqual(evidenceOperations(ctx, { config, contract: { digest: 'abc', routes: [{ op: 'GET /declared' }] } }),
    ['GET /captured', 'GET /declared', 'GET /saved']);
  ctx.api_context.operations.d = { identity: { ...identity, environment: 'unresolved', contractDigest: null, operation: 'GET /authored' }, observations: [{ basis: 'authored' }] };
  ctx.api_context.operations.e = { identity: { ...identity, stack: 'b', operation: 'GET /other-authored' }, observations: [{ basis: 'authored' }] };
  assert.deepEqual(evidenceOperations(ctx, { config, contract: null }), ['GET /authored', 'GET /saved']);
});
test('notes rank linked evidence before recency; explicit contradictions are retained and flagged', () => {
  const entry = { notes: ['Newest prose.', 'Returns HTTP 201.', 'Returns HTTP 401 without authentication.'], notes_provenance: [
    { by: 'agent', at: '2026-10-09' }, { by: 'agent', at: '2026-10-08', evidence: [{ run_id: 'run-one', state: 'available', digest }] },
    { by: 'agent', at: '2026-10-07' },
  ] };
  // Use records directly: evidence provenance scope validation belongs to the writer.
  const records = entry.notes.map((text, index) => ({ text, index, id: String(index), kind: 'authored', provenance: entry.notes_provenance[index] }));
  const ranked = rankNoteRecords(records, { summary: summary(), now });
  assert.equal(ranked[0].text, 'Returns HTTP 201.');
  assert.equal(ranked[0].evidence_class.class, 'observed');
  assert.deepEqual(ranked[0].contradictions, ['status']);
  assert.deepEqual(ranked.find(item => item.index === 2).contradictions, []);
  assert.equal(ranked.length, 3);
  for (const state of ['invalid', 'changed']) {
    const untrusted = rankNoteRecords(records, { summary: summary(), now, history: { state } });
    assert.ok(untrusted.every(record => record.evidence_class.class === 'written'));
    assert.ok(untrusted.every(record => record.evidence_class.reason === 'note-history-review-required'));
  }
  const damaged = projectKnownNotes(entry, { summary: summary(), now });
  assert.equal(damaged.history.state, 'invalid', 'incomplete author evidence is malformed, not a supported receipt');
  assert.ok(damaged.records.every(record => record.evidence_class.class === 'written'));
});
test('derived contradiction metadata holds immutable IDs and kinds, never response values', () => {
  const entry = { notes: ['Returns error code OLD_CODE.', 'Returns HTTP 201.', 'Returns HTTP 401 without authentication.'],
    notes_provenance: Array.from({ length: 3 }, () => ({ by: 'agent', at: '2026-10-09' })) };
  const ctx = { operations: { 'GET /items': entry }, stack_facts: { notes: ['Returns error code OLD_CODE.'],
    notes_provenance: [{ by: 'agent', at: '2026-10-08', operations: ['GET /other'] }] } };
  const flags = deriveNoteContradictions(ctx, { operation: 'GET /items', status: 200, response: { error: { code: 'PRIVATE_NEW_CODE' } } });
  assert.equal(flags.length, 2);
  assert.deepEqual(new Set(flags.map(item => item.kind)), new Set(['status', 'error-code']));
  assert.ok(flags.every(item => /^sha256:[a-f0-9]{64}$/u.test(item.note_id)));
  assert.doesNotMatch(JSON.stringify(flags), /PRIVATE_NEW_CODE|OLD_CODE|201/);
  const active = inspectNoteHistory(entry).active;
  const saved = summary(); saved.observations[0].note_contradictions = flags;
  assert.ok(rankNoteRecords(active, { summary: saved, now }).find(item => item.text.includes('OLD_CODE')).contradictions.includes('error-code'));
  saved.observations[0].note_contradictions = [];
  assert.deepEqual(rankNoteRecords(active, { summary: saved, now }).find(item => item.text.includes('OLD_CODE')).contradictions, []);
});
test('numeric error codes compare without values in metadata; unconditional responds with is supported', () => {
  const ctx = { operations: { 'GET /items': { notes: ['Error code is 1001.', 'Responds with HTTP 201.', 'Responds with 401 with invalid authentication.'],
    notes_provenance: Array.from({ length: 3 }, () => ({ by: 'agent', at: '2026-10-09' })) } } };
  const flags = deriveNoteContradictions(ctx, { operation: 'GET /items', status: 200, response: { error: { code: 1002 } } });
  assert.equal(flags.length, 2);
  assert.doesNotMatch(JSON.stringify(flags), /1001|1002|201/);
  assert.equal(deriveNoteContradictions(ctx, { operation: 'GET /items', status: 201, response: { code: 1001 } }).length, 0);
});
test('conditional, alternative and negated prose is not mechanically asserted as an unconditional claim', () => {
  const texts = ['Returns HTTP 200 or 201.', 'Never returns HTTP 200.', 'Does not return HTTP 200.',
    'Returns HTTP 200 on success.', 'An authenticated request returns HTTP 200.', 'Should return HTTP 200.',
    'Returns error code FIRST or SECOND.'];
  const ctx = { operations: { 'GET /items': { notes: texts,
    notes_provenance: texts.map(() => ({ by: 'agent', at: '2026-10-09' })) } } };
  assert.deepEqual(deriveNoteContradictions(ctx, { operation: 'GET /items', status: 422, response: { code: 'SECOND' } }), []);
});

function captureFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-confidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contractFile = join(root, 'openapi.json');
  writeFileSync(contractFile, JSON.stringify({ openapi: '3.0.3', info: { title: 'Fixture', version: '1' },
    paths: { '/items': { get: { responses: { 200: { description: 'OK' } } } } } }));
  createFixtureStack(root, { contract: 'openapi.json' });
  const contract = loadHttpContract(contractFile);
  const entry = { notes: ['Returns error code OLD_CODE.'], notes_provenance: [{ by: 'agent', at: '2026-10-09' }] };
  const ctx = { v: 0, api: {}, operations: { 'GET /items': entry } };
  writeFileSync(fixtureContextFile(root), JSON.stringify(ctx));
  const evidencePath = join(root, fixtureEvidencePath(), 'run-fixture.json');
  writeFileSync(evidencePath, JSON.stringify({ safe: 'already masked evidence' }));
  const identity = { provider: 'https://fixture.example.test', environment: 'local', protocol: 'http',
    operation: 'GET /items', endpoint: 'https://fixture.example.test/items', contractDigest: contract.digest, stack: 'fixture' };
  return { root, ctx, entry, identity, contract, evidencePath };
}
test('client contradiction metadata survives capture and projection but carries no response code values', t => {
  const { root, ctx, entry, identity, contract, evidencePath } = captureFixture(t);
  inFixtureStack(root, () => {
    const flags = deriveNoteContradictions(ctx, { operation: identity.operation, status: 200, response: { code: 'PRIVATE_NEW_CODE' } });
    assert.equal(captureHttpContext(root, { identity, capture_context: true, status: 200, complete: true,
      evidencePath, note_contradictions: flags }).state, 'captured');
    const saved = JSON.parse(readFileSync(fixtureContextFile(root), 'utf8'));
    const observation = Object.values(saved.api_context.operations)[0].observations[0];
    assert.deepEqual(observation.note_contradictions, flags);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_NEW_CODE/);
    const summary = showObservationSummary(root, identity.operation, { config: resolveConfig(root), contract });
    assert.deepEqual(rankNoteRecords(inspectNoteHistory(entry).active, { summary })[0].contradictions, ['error-code']);
    writeFileSync(evidencePath, 'changed');
    const broken = showObservationSummary(root, identity.operation, { config: resolveConfig(root), contract });
    assert.deepEqual(rankNoteRecords(inspectNoteHistory(entry).active, { summary: broken })[0].contradictions, []);
  });
});
test('external callers cannot manufacture client contradiction flags; legacy captures remain readable', t => {
  const { root, identity, evidencePath } = captureFixture(t);
  inFixtureStack(root, () => {
    const input = { identity, source: { tool: 'api_request:http' }, basis: 'observed', status: 200,
      outcome: 'success', complete: true, evidence: [{ path: relative(root, evidencePath) }] };
    assert.throws(() => captureOperationContext(root, { ...input, note_contradictions: [{ note_id: digest, kind: 'status' }] }),
      error => error.code === 'CONTEXT_INPUT_INVALID');
    assert.throws(() => captureOperationContext(root, { ...input, note_contradictions: [{ note_id: digest, kind: 'status', code: 'PRIVATE_CODE' }] }, { internal: true }),
      error => error.code === 'CONTEXT_INPUT_INVALID');
    captureOperationContext(root, input, { internal: true });
    const query = queryOperationContext(root, identity);
    assert.equal(query.operations.length, 1);
    assert.equal(query.operations[0].observations[0].note_contradictions, undefined);
  });
});
