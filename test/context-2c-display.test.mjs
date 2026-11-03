import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME_ENV_NAME, ENV_PREFIX, PRODUCT } from '../lib/brand.mjs';
import { contextShape, operationId } from '../lib/operation-context.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { buildApiMapModel, renderApiMapHtml, renderApiMapText } from '../lib/api-map.mjs';
import { buildViewModel, renderViewHtml } from '../lib/view.mjs';
import { footprintModel, renderMapHtml } from '../lib/map.mjs';
import { renderStackContext } from '../lib/pointer-context.mjs';
import { readFeedbackContexts, buildFeedback, renderFeedback } from '../lib/feedback.mjs';
import { buildFeedbackPayload } from '../lib/feedback-payload.mjs';

for (const key of Object.keys(process.env))
  if (key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`)) delete process.env[key];
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const SECRET_BODY = 'PRIVATE_RESPONSE_VALUE_NOT_FOR_REPORTS';
const PATHS = ['written', 'observed', 'asserted', 'verified', 'failed', 'stale', 'broken', 'doc-only'];
const expectedAlpha = { written: 4, observed: 2, asserted: 1, verified: 1 };
const expectedTotal = { written: 5, observed: 2, asserted: 1, verified: 1 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'context-2c-display-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.now(), at = new Date(now).toISOString();
  const env = { [HOME_ENV_NAME]: join(root, 'machine'), API_CONTEXT_DIR: root };
  const contract = { openapi: '3.0.3', info: { title: 'Confidence fixture', version: '1' },
    paths: Object.fromEntries(PATHS.map(path => [`/${path}`, { get: { responses: { 200: { description: 'Synthetic response' } } } }])) };
  write(join(root, 'openapi.json'), contract);
  const contractBytes = readFileSync(join(root, 'openapi.json')), digest = hash(contractBytes);
  createFixtureStack(root, { name: 'alpha', baseUrl: 'https://alpha.example.test', contract: 'openapi.json' });
  createFixtureStack(root, { name: 'beta', baseUrl: 'https://beta.example.test' });
  const store = { v: 0, api: { name: 'Alpha', contract: '.sannr/stacks/alpha/openapi.json', contract_digest: digest.slice(0, 23) },
    operations: Object.fromEntries(PATHS.filter(path => path !== 'doc-only').map(path => [`GET /${path}`, {
      verified_at: null, contract_digest: null, status_codes: [], notes: path === 'written' ? ['Keep the existing operation fact.'] : [],
      fields: {}, effect: 'read' }])), api_context: { v: 1, operations: {} } };
  for (const path of ['observed', 'asserted', 'verified', 'failed', 'stale', 'broken']) {
    const op = `GET /${path}`, status = path === 'failed' ? 401 : 200;
    const date = path === 'stale' ? '2000-01-01T00:00:00.000Z' : at;
    const identity = { stack: 'alpha', provider: 'https://alpha.example.test', environment: 'local', protocol: 'http',
      operation: op, endpoint: `https://alpha.example.test/${path}`, contractDigest: digest };
    const id = `run-confidence-${path}`, file = `.sannr/evidence/alpha/${id}.json`;
    const evidence = JSON.stringify({ runId: id, request: { method: 'GET', url: identity.endpoint },
      response: { status, body: { private_value: SECRET_BODY } } });
    if (path !== 'broken') writeFileSync(join(root, file), evidence);
    const observation = { id: `obs-${path}`, recorded_at: date, observed_at: date, basis: 'observed',
      source: { kind: 'client', tool: 'api_request:http' }, verification: 'client-observation',
      outcome: status === 200 ? 'success' : 'error', complete: true, response_status: status,
      evidence: [{ path: file, digest: hash(evidence) }], notes: [], omissions: [], attempts: 1,
      request_shape: contextShape({}).shape, response_shape: contextShape({ private_value: 'synthetic' }).shape,
      ...(path !== 'observed' ? { assertions: { passed: path === 'failed' ? 0 : 1, failed: path === 'failed' ? 1 : 0 } } : {}) };
    store.api_context.operations[operationId(identity)] = { identity, observations: [observation], omitted_observations: 0 };
    if (path === 'verified') Object.assign(store.operations[op], { verified_at: at, verified_by: 'learn',
      contract_digest: digest.slice(0, 23), status_codes: [200], environment: 'local' });
  }
  write(fixtureContextFile(root, 'alpha'), store);
  write(fixtureContextFile(root, 'beta'), { v: 0, api: { name: 'Beta' }, operations: {
    'GET /written': { notes: ['Beta-only operation fact.'], verified_at: null, fields: {}, status_codes: [] } } });
  return { root, now, at, env, store };
}

test('CONTEXT-2c map and view classify the same evidence once per operation, with no values or active content', t => {
  const f = fixture(t), model = buildApiMapModel(f.root, { now: f.now, env: f.env });
  assert.deepEqual(model.counts.evidence_classes, expectedTotal);
  assert.deepEqual(model.stack_index[0].evidence_classes, expectedAlpha);
  assert.deepEqual(model.stacks[0].api_map.counts.evidence_classes, expectedAlpha);
  const view = buildViewModel(f.root, { generatedAt: f.at, env: f.env });
  assert.deepEqual(view.api_map.counts.evidence_classes, expectedTotal);
  const text = renderApiMapText(model), html = renderApiMapHtml(model), page = renderViewHtml(view);
  for (const kind of Object.keys(expectedTotal)) {
    assert.ok(text.includes(kind), kind);
    assert.ok(html.includes(kind), kind);
    assert.ok(page.includes(kind), kind);
  }
  for (const value of [JSON.stringify(model), text, html, page]) assert.ok(!value.includes(SECRET_BODY));
  assert.doesNotMatch(page, /<script\b/i);
  assert.match(page, /Content-Security-Policy/);
});

test('CONTEXT-2c managed headline agrees with the map and preserves operation fact bytes', t => {
  const f = fixture(t);
  const block = renderStackContext(f.root, null, { portable: PRODUCT, containsMachineLocalPath: () => false }).join('\n');
  assert.match(block, /4 written, 2 observed, 1 asserted, 1 verified/);
  assert.match(block, /1 written, 0 observed, 0 asserted, 0 verified/);
  assert.ok(block.includes('- `GET /written` — Keep the existing operation fact.'));
  assert.ok(block.includes('- `GET /written` — Beta-only operation fact.'));
  assert.doesNotMatch(block, /8 operations, 1 verified by execution/);
});

test('CONTEXT-2c local feedback uses the same four classes while the Worker payload stays fixed', t => {
  const f = fixture(t), gathered = readFeedbackContexts(f.root);
  const report = buildFeedback({ ...gathered, now: new Date(f.now), anonymize: true });
  assert.deepEqual(report.did_anything_accumulate.evidence_classes, expectedTotal);
  assert.equal(report.did_anything_accumulate.operations_known, 9);
  assert.equal(report.did_anything_accumulate.verified_by_execution, 1);
  assert.ok(renderFeedback(report).includes('asserted'));
  const payload = buildFeedbackPayload(report, { version: '0.1.0-alpha.10' });
  assert.deepEqual(Object.keys(payload.report.did_anything_accumulate), [
    'operations_known', 'verified_by_execution', 'gotchas_written', 'verdicts_recorded', 'friction_prompts_fired']);
  assert.equal(payload.report.did_anything_accumulate.verified_by_execution, 1);
  assert.doesNotMatch(JSON.stringify(payload), /evidence_classes|PRIVATE_RESPONSE_VALUE|alpha\.example|beta\.example/);
});

test('CONTEXT-2c a written status claim contradicted by the latest response is flagged and retained in human views', t => {
  const f = fixture(t), note = 'Returns status 200.';
  f.store.operations['GET /failed'].notes = [note];
  write(fixtureContextFile(f.root, 'alpha'), f.store);
  const model = buildApiMapModel(f.root, { now: f.now, env: f.env });
  const retained = model.stacks[0].api_map.notes.find(item => item.op === 'GET /failed');
  assert.equal(retained.text, note);
  assert.deepEqual(retained.contradictions, ['status']);
  assert.match(renderApiMapHtml(model), /Contradicted.*status/);
  const view = buildViewModel(f.root, { generatedAt: f.at, env: f.env });
  assert.match(renderViewHtml(view), /Contradicted.*status/);
  const block = renderStackContext(f.root, null, { portable: PRODUCT, containsMachineLocalPath: () => false }).join('\n');
  assert.ok(block.includes('- `GET /failed` — Returns status 200.'));
  assert.match(block, /Contradicted authored note.*GET \/failed/);
});

// Retained audit snapshots predate the four classes and cannot supply the
// observed/asserted distinction. Preserve compatibility data, not stale green
// totals beside the current per-stack class counts.
test('CONTEXT-2c footprint preserves legacy audit metadata without rendering it as current verification', () => {
  const model = footprintModel({ root: '.', surfaces: [{ name: 'synthetic', kind: 'documented', declared: 3,
    known: { verified: 2, suspect: 1, unverified: 0 } }], edges: [], external: [], platform: [] });
  assert.deepEqual(model.services[0].knowledge, { verified: 2, suspect: 1, unverified: 0 });
  const page = renderMapHtml(model);
  assert.doesNotMatch(page, /2 verified, 1 suspect, 0 unverified/);
  assert.match(page, /Legacy audit classification retained/);
});
