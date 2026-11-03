import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSurveySupplies } from '../lib/survey-flows.mjs';
import { createSurveySnapshot, validateSurvey, canonicalSurveyJson, surveyId } from '../lib/survey-model.mjs';

const provider = 'https://inventory.example.test/v1';
const at = '2026-10-17T00:00:00.000Z';
const digest = `sha256:${'a'.repeat(64)}`;
const operation = (id, op, extra = {}) => ({ id, stack: 'inventory', operation: op,
  provider, environment: 'test', ...extra });
const operations = [operation('list', 'GET /things'), operation('get', 'GET /things/{id}'),
  operation('search', 'GET /search'), operation('other', 'GET /other')];
const retained = (extra = {}) => ({ stack: 'inventory', file: '.context/inventory.json',
  entries: [{ id: digest, entry: { identity: { stack: 'inventory', protocol: 'http', provider,
    environment: 'test', operation: 'GET /things/{id}' }, key_sources: [{ param: 'id', location: 'path',
      source: { operation: 'GET /things', field: 'data[].id' }, first_observed_at: at,
      last_observed_at: at, also_seen: 2, evidence: { run_id: 'run-source', digest } }] } }], ...extra });
const suite = (requests, extra = {}) => ({ file: '.context/suites/flow.json', stack: 'inventory',
  environment: 'test', suite: { requests }, ...extra });
const capture = { method: 'GET', path: '/things', capture: { item: 'data.0.id' } };
const consume = { method: 'GET', path: '/things/{item}' };
const reason = (result, name) => result.unresolved.find(row => row.reason === name)?.count ?? 0;

test('supplies keeps declaration and retained inference together without claiming proof or operation behavior', () => {
  const result = projectSurveySupplies({ operations, retainedEntries: [retained({ evidenceAvailability: { 'run-source': 'unavailable' } })],
    suites: [suite([capture, consume])] });
  assert.equal(result.relationships.length, 1);
  const relation = result.relationships[0];
  assert.deepEqual([relation.kind, relation.from, relation.to, relation.source_field], ['supplies', 'list', 'get', 'data[].id']);
  assert.deepEqual(relation.target_parameter, { location: 'path', name: 'id' });
  assert.deepEqual(relation.scope, { source_stack: 'inventory', target_stack: 'inventory', environment: 'test' });
  assert.equal(relation.declarations[0].kind, 'suite-capture');
  assert.equal(relation.observations[0].kind, 'retained-value-match');
  assert.equal(relation.observations[0].also_seen, 2);
  assert.equal(relation.observations[0].proof.state, 'unavailable');
  assert.equal(relation.observations[0].evidence.run_id, 'run-source');
  assert.equal(result.coverage.observed_relationships, 1);
  assert.equal(result.coverage.declared_relationships, 1);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(digest));
  assert.ok(!Object.hasOwn(relation, 'evidence_class'));
});

test('retained source ambiguity, unknown scope and damaged lists stay unresolved', () => {
  const ambiguous = projectSurveySupplies({ operations: [...operations,
    operation('other-list', 'GET /things', { stack: 'shared' })], retainedEntries: [retained()] });
  assert.equal(ambiguous.relationships.length, 0);
  assert.equal(reason(ambiguous, 'retained-source-ambiguous'), 1);
  const broken = retained(); broken.entries[0].keySourcesDamaged = true;
  const unknown = retained(); delete unknown.entries[0].entry.identity.provider;
  const result = projectSurveySupplies({ operations, retainedEntries: [broken, unknown] });
  assert.equal(reason(result, 'retained-links-damaged'), 1);
  assert.equal(reason(result, 'retained-scope-unavailable'), 1);
  assert.equal(result.relationships.length, 0);
});

test('suite capture declarations honor order, replacement, scope, query and cleanup without implying execution', () => {
  const scenario = suite([
    consume, capture, consume,
    { method: 'GET', path: '/other', capture: { item: 'owner.id' } },
    { method: 'GET', path: '/search', params: { owner: '{item}', ignored: 'ordinary-private-query' },
      body: { raw: 'ordinary-private-body' }, headers: { 'x-note': 'ordinary-private-header' } },
  ]);
  scenario.suite.finally = [consume];
  const result = projectSurveySupplies({ operations, suites: [scenario] });
  assert.equal(reason(result, 'capture-not-declared-before-use'), 1);
  assert.equal(result.relationships.length, 3);
  assert.ok(result.relationships.some(row => row.from === 'other' && row.to === 'search'
    && row.target_parameter.location === 'query' && row.target_parameter.name === 'owner'));
  assert.ok(result.relationships.some(row => row.from === 'other' && row.to === 'get'
    && row.declarations[0].consumer.phase === 'finally'));
  assert.ok(result.relationships.every(row => row.observations.length === 0));
  assert.doesNotMatch(JSON.stringify(result), /ordinary-private/);
});

test('cross-stack supplies resolve explicit suite scope and retained sources only when unique', () => {
  const across = operations.map(row => row.id === 'list' ? { ...row, stack: 'catalog' } : row);
  const result = projectSurveySupplies({ operations: across, retainedEntries: [retained()], suites: [suite([
    { ...capture, stack: 'catalog' }, consume,
  ])] });
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0].scope.source_stack, 'catalog');
  assert.equal(result.relationships[0].declarations.length, 1);
  assert.equal(result.relationships[0].observations.length, 1);
  const missing = projectSurveySupplies({ operations, suites: [suite([capture, consume], { stack: undefined, environment: undefined })] });
  assert.equal(missing.relationships.length, 1, 'one unique binding can identify a declaration');
  const envs = projectSurveySupplies({ operations: [...operations, ...operations.map(row => ({ ...row, environment: 'production' }))],
    suites: [suite([capture, consume], { environment: undefined })] });
  assert.equal(envs.relationships.length, 0, 'two environment bindings cannot be guessed');
  assert.ok(reason(envs, 'suite-operation-ambiguous') > 0);
});

test('unsupported transformations and secret-shaped metadata are withheld without returning input values', () => {
  const secret = `sk_live_${'x'.repeat(32)}`;
  const result = projectSurveySupplies({ operations, suites: [suite([capture,
    { method: 'GET', path: '/search', params: { q: 'prefix-{item}' }, body: { id: '{item}' } },
    { method: 'GET', path: '/things/{item}', capture: { next: `data.${secret}` } },
  ]), suite([capture, consume], { file: ['', 'Users', 'person', `${secret}.json`].join('/') })],
    retainedEntries: [retained({ file: '.context/unsafe\u202e.json' })] });
  assert.ok(reason(result, 'capture-consumer-unsupported') > 0);
  assert.ok(reason(result, 'capture-field-unsupported') > 0);
  assert.equal(reason(result, 'input-metadata-withheld'), 2);
  const shown = JSON.stringify(result);
  assert.doesNotMatch(shown, /sk_live_|\/Users\/|\u202e|prefix-/u);
  for (const file of ['%2Fworkspace%2Fprivate.json', 'nested/%252e%252e/%252e%252e/private.json', 'nested/%2573k_live_' + 'x'.repeat(32)]) {
    const unsafe = projectSurveySupplies({ operations, suites: [suite([capture, consume], { file })] });
    assert.equal(unsafe.relationships.length, 0, 'encoded path metadata cannot bypass the portable boundary');
    assert.equal(reason(unsafe, 'input-metadata-withheld'), 1);
  }
});

test('absolute mounted suite URLs and attributed existing relationships use one stable projection', () => {
  const input = { operations, suites: [suite([capture, { ...consume, path: `${provider}/things/{item}` }])],
    operatorBindings: [{ from: 'list', to: 'get', source_field: 'data[].id', target_parameter: { location: 'path', name: 'id' },
      environment: 'test', file: 'graph-input.json', author: 'operator', at }] };
  const result = projectSurveySupplies(input);
  assert.equal(result.relationships.length, 1);
  assert.deepEqual(result.relationships[0].operator_attributions, [{ kind: 'operator-annotation', file: 'graph-input.json', author: 'operator', at }]);
  assert.equal(result.relationships[0].observations.length, 0);
  assert.deepEqual(projectSurveySupplies({ ...input, operations: [...input.operations].reverse() }), result);
  const wrong = projectSurveySupplies({ ...input, suites: [suite([capture, { ...consume, path: 'https://unbound.example.test/things/{item}' }])] });
  assert.equal(wrong.relationships.length, 0);
  assert.equal(reason(wrong, 'suite-operation-unresolved'), 1);
  assert.equal(reason(wrong, 'operator-binding-unmatched'), 1);
  const privatePath = ['', 'Users', 'alice', 'private-file'].join('/');
  for (const author of [`file://${privatePath}`, 'file:%2F%2F%2FUsers%2Falice%2Fprivate-file',
    `prefix:${privatePath}`, 'file:///workspace/private-file',
    'https://example.test/?customer=ordinary-private-account',
    'reviewed by https://example.test/%3Fcustomer%3Dordinary-private-account',
    'https://example.test/#ordinary-private-account']) {
    const withheld = projectSurveySupplies({ ...input, operatorBindings: [{ ...input.operatorBindings[0], author }] });
    assert.equal(withheld.relationships[0].operator_attributions.length, 0, 'authorship cannot carry a machine path or URL query value');
    assert.equal(reason(withheld, 'operator-attribution-withheld'), 1);
    assert.ok(!JSON.stringify(withheld).includes(author));
  }
  const linked = projectSurveySupplies({ ...input,
    operatorBindings: [{ ...input.operatorBindings[0], author: 'https://example.test' }] });
  assert.equal(linked.relationships[0].operator_attributions[0].author, 'https://example.test');
  const usersPath = ['', 'users'].join('/');
  const users = projectSurveySupplies({ operations: [operation('users', `GET ${usersPath}`), operation('user', `GET ${usersPath}/{id}`)],
    suites: [suite([{ method: 'GET', path: usersPath, capture: { user: 'data.0.id' } },
      { method: 'GET', path: `${usersPath}/{user}` }])] });
  assert.equal(users.relationships.length, 1, 'ordinary lowercase user routes are not workstation paths');
});

test('real supplies projections round-trip through the strict portable model with separate and unknown environments', () => {
  const shared = { operations, retainedEntries: [retained()], suites: [suite([capture, consume])],
    operatorBindings: [{ from: 'list', to: 'get', source_field: 'data[].id', target_parameter: { location: 'path', name: 'id' },
      file: 'graph-input.json', author: 'operator', at: '2026-10-17' }] };
  const crossEnvironment = { operations: operations.map(row => row.id === 'list' ? { ...row, environment: 'catalog' } : row),
    suites: [suite([{ ...capture, environment: 'catalog' }, consume])] };
  const unknown = { operations: operations.map(({ environment: _unknown, ...row }) => row),
    suites: [suite([capture, consume], { environment: undefined })] };
  for (const input of [shared, crossEnvironment, unknown]) {
    const result = projectSurveySupplies(input);
    assert.equal(result.relationships.length, 1);
    const snapshot = createSurveySnapshot({
      nodes: input.operations.map(({ id, stack, operation }) => ({ id, kind: 'operation', label: operation, stack, operation })),
      relationships: result.relationships.map(edge => ({ ...edge, id: surveyId('supplies', [edge.from, edge.to, edge.source_field, edge.target_parameter, edge.scope]) })),
      unresolved: result.unresolved, coverage: { flow: result.coverage },
    }, { now: at });
    assert.deepEqual(validateSurvey(JSON.parse(canonicalSurveyJson(snapshot))), snapshot);
    const edge = snapshot.relationships[0];
    if (input === shared) {
      assert.deepEqual(edge.declarations[0].source, { phase: 'requests', step: 1 });
      assert.deepEqual(edge.declarations[0].consumer, { phase: 'requests', step: 2 });
      assert.equal(edge.observations[0].proof.state, 'not-checked');
      assert.equal(edge.operator_attributions[0].at, '2026-10-17');
    } else if (input === crossEnvironment) {
      assert.equal(edge.scope.source_environment, 'catalog');
      assert.equal(edge.scope.target_environment, 'test');
    } else {
      assert.ok(!Object.hasOwn(edge.scope, 'environment'));
      assert.equal(reason(result, 'relationship-environment-unavailable'), 1);
    }
  }
});
