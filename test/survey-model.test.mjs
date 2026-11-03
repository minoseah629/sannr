import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurveySnapshot, validateSurvey, surveyId, canonicalSurveyJson, querySurveySnapshot } from '../lib/survey-model.mjs';

const nodes = () => [
  { id: surveyId('file', ['src/app.js']), kind: 'file', label: 'src/app.js', file: 'src/app.js' },
  { id: surveyId('operation', ['orders', 'GET /orders/{id}']), kind: 'operation', label: 'GET /orders/{id}', stack: 'orders', operation: 'GET /orders/{id}' },
];
const specimen = () => {
  const [file, operation] = nodes();
  return createSurveySnapshot({ nodes: [operation, file], relationships: [{
    id: surveyId('defines', [file.id, operation.id]), kind: 'defines', from: file.id, to: operation.id,
    declarations: [{ kind: 'code', file: file.file, line: 2, code_path: '/orders/:id', contract_path: '/orders/{id}' }],
    observations: [], operator_attributions: [],
  }] }, { now: '2026-10-17T00:00:00Z' });
};

test('survey model preserves stable identities and provenance while refusing unsafe or invented model fields', () => {
  const value = specimen();
  assert.equal(validateSurvey(value), value);
  assert.equal(canonicalSurveyJson(value), canonicalSurveyJson({ ...value, nodes: [...value.nodes].reverse() }));
  for (const change of [
    next => { next.v = 99; },
    next => { next.nodes[0].label = 'Bearer ghp_' + 'a'.repeat(36); },
    next => { next.nodes[0].file = ['', 'Users', 'private', 'repo', 'app.js'].join('/'); },
    next => { next.nodes[0].body = { private: 'response value' }; },
    next => { next.relationships[0].kind = 'imports'; },
    next => { next.relationships[0].to = 'missing'; },
    next => { next.nodes.push(structuredClone(next.nodes[0])); },
    next => { next.nodes[0].file = 'src/%73k_live_' + 'x'.repeat(32) + '.js'; },
    next => { next.nodes[0].file = '%2Fworkspace%2Fprivate.js'; },
    next => { next.nodes.find(node => node.kind === 'operation').operation = 'GET /items?account=private-account'; },
    next => { next.nodes.find(node => node.kind === 'operation').operation = 'POST /destroy'; },
    next => { next.relationships[0].kind = 'supplies'; },
    next => { const edge = next.relationships[0]; [edge.from, edge.to] = [edge.to, edge.from]; },
  ]) {
    const bad = structuredClone(value); change(bad);
    assert.throws(() => validateSurvey(bad), error => /^SURVEY_/.test(error.code));
  }
  for (const edge of [
    { ...value.relationships[0], kind: 'supplies' },
    { ...value.relationships[0], from: value.relationships[0].to, to: value.relationships[0].from },
  ]) assert.throws(() => createSurveySnapshot({ nodes: value.nodes, relationships: [edge] }), error => /^SURVEY_/.test(error.code));
  const privatePath = ['', 'Users', 'alice', 'private-file'].join('/');
  for (const author of [`file://${privatePath}`, 'file:%2F%2F%2FUsers%2Falice%2Fprivate-file', `prefix:${privatePath}`,
    'https://example.test/?customer=ordinary-private-account', 'Reviewer https://example.test/%3Fcustomer=ordinary-private-account']) {
    const edge = { ...value.relationships[0], operator_attributions: [{ kind: 'operator-annotation', author, at: '2026-10-17' }] };
    assert.throws(() => createSurveySnapshot({ nodes: value.nodes, relationships: [edge] }), error => /^SURVEY_/.test(error.code));
  }
});

test('bounded operation query preserves snapshot identity, declared meaning and honest omissions without scanning', () => {
  const snapshot = specimen();
  const query = querySurveySnapshot(snapshot, { stack: 'orders', operation: 'GET /orders/{id}', maxBytes: 4096 });
  assert.equal(query.state, 'ready');
  assert.equal(query.snapshot.id, snapshot.snapshot.id);
  assert.equal(query.current_inputs.state, 'not-checked');
  assert.equal(query.relationships.length, 1);
  assert.equal(query.relationships[0].observations.length, 0);
  const small = querySurveySnapshot(snapshot, { stack: 'orders', operation: 'GET /orders/{id}', maxBytes: 768 });
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 768);
  assert.ok(small.omitted.relationships > 0);
  assert.deepEqual(querySurveySnapshot(snapshot, { stack: 'other', operation: 'GET /orders/{id}' }).relationships, []);
  assert.equal(snapshot.relationships.length, 1, 'queries never mutate the snapshot');
  const unsafeStatus = querySurveySnapshot(snapshot, { status: { checked_at: 'not-a-date', state: ['', 'Users', 'private', 'credentials'].join('/') } });
  assert.deepEqual(unsafeStatus.current_inputs, { state: 'not-checked' });
});
