// The common context stores scoped shapes and provenance, never payload values.
// All repositories, registries, and evidence files are disposable local fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { captureOperationContext as captureRaw, contextShape, loadOperationContextSources, migrateOperationContext as migrateRaw, operationId, operationIdentity, queryLoadedOperationContext, queryOperationContext as queryRaw } from '../lib/operation-context.mjs';
import { CONTEXT_FILE, MAX_CONTEXT_BYTES, saveContext as saveContextRaw, updateContext as updateContextRaw } from '../lib/context.mjs';
import { emptyRegistry, grant, registerRepo, revoke, saveRegistry } from '../lib/registry.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { resolveStack } from '../lib/stacks.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';

const baseIdentity = { stack: 'fixture', provider: 'fixture-provider', environment: 'local', protocol: 'graphql',
  operation: 'query Devices', endpoint: 'http://fixture.invalid/graphql', contractDigest: `sha256:${'a'.repeat(64)}` };
const observation = (overrides = {}) => ({ identity: { ...baseIdentity }, source: { tool: 'fixture-client' },
  outcome: 'success', complete: true, request: { id: 'private-request-value' }, response: { value: 'private-response-value' }, ...overrides });
// Current writes use a real, resolver-validated named stack. Only the grant
// read controls below retain historical single-store snapshots, authored as
// fixtures rather than captured through a now read-only legacy installation.
const scopes = new Map();
const scoped = (root, fn) => scopes.has(root) ? withStackScope(scopes.get(root), fn) : fn();
const captureOperationContext = (root, ...args) => scoped(root, () => captureRaw(root, ...args));
const migrateOperationContext = (root, ...args) => scoped(root, () => migrateRaw(root, ...args));
const queryOperationContext = (root, ...args) => scoped(root, () => queryRaw(root, ...args));
const saveContext = (root, ...args) => scoped(root, () => saveContextRaw(root, ...args));
const updateContext = (root, ...args) => scoped(root, () => updateContextRaw(root, ...args));
const contextPath = root => join(root, scopes.get(root)?.contextFile ?? CONTEXT_FILE);
const evidencePath = name => posix.join(LAYOUT.evidence, 'fixture', name);
function scratch(t, { legacy = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sannr-op-context-')));
  t.after(() => { scopes.delete(root); rmSync(root, { recursive: true, force: true }); });
  if (!legacy) {
    const folder = join(root, LAYOUT.collection, 'fixture');
    writeFileSync(join(folder, 'stack.json'), JSON.stringify({ v: 1, name: 'fixture', title: 'Fixture API',
      default_environment: 'local', environments: { local: { baseUrl: 'http://fixture.invalid' } } }));
    mkdirSync(join(root, LAYOUT.evidence, 'fixture'), { recursive: true });
    scopes.set(root, resolveStack(root, { stack: 'fixture' }));
  }
  const env = { [HOME_ENV_NAME]: join(root, 'isolated-registry') };
  const query = (input = {}, options = {}) => queryOperationContext(root, input, { env, ...options });
  return { root, env, query };
}
const load = root => JSON.parse(readFileSync(contextPath(root), 'utf8'));
const save = (root, value) => writeFileSync(contextPath(root), JSON.stringify(value));
const bytes = root => readFileSync(contextPath(root), 'utf8');
function appendHistoricalObservation(root, { provider = baseIdentity.provider, notes = [] } = {}) {
  const { stack: _stack, ...legacyIdentity } = baseIdentity;
  const identity = operationIdentity({ ...legacyIdentity, provider });
  const id = operationId(identity);
  let context;
  try { context = load(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  context ??= { v: 0, api: { name: 'Historical fixture API' }, operations: {}, api_context: { v: 1, operations: {} } };
  const entry = context.api_context.operations[id] ??= { identity, observations: [], omitted_observations: 0 };
  entry.observations.push({ id: `historical-${entry.observations.length + 1}`,
    recorded_at: '2026-09-01T00:00:00.000Z', observed_at: '2026-09-01T00:00:00.000Z',
    basis: 'observed', source: { kind: 'external', tool: 'fixture-client' }, verification: 'external-claim',
    outcome: 'success', complete: true, evidence: [], notes, omissions: [],
    request_shape: { type: 'object', properties: { id: { type: 'string' } } },
    response_shape: { type: 'object', properties: { value: { type: 'string' } } } });
  save(root, context);
}

test('exact context queries retain their index with optional stack identities and preserve stack wildcards', t => {
  const f = scratch(t, { legacy: true });
  const { stack: _stack, ...legacyIdentity } = baseIdentity;
  appendHistoricalObservation(f.root);
  const legacy = loadOperationContextSources(f.root, { env: f.env });
  // The map asks one exact question per operation. A full scan here turns a
  // 2,000-operation projection into four million candidate comparisons.
  Object.defineProperty(legacy.sources[0], 'projected', { get() { assert.fail('An exact legacy identity scanned the store.'); } });
  assert.deepEqual(queryLoadedOperationContext(legacy, legacyIdentity).operations.map(row => row.operation_id), [operationId(legacyIdentity)]);

  // Stored snapshots can legitimately contain older stackless identities
  // beside stack identities. Reading them needs no legacy write permission.
  const context = load(f.root), original = context.api_context.operations[operationId(legacyIdentity)];
  for (const stack of ['primary', 'secondary']) {
    const identity = operationIdentity({ ...legacyIdentity, stack });
    context.api_context.operations[operationId(identity)] = { ...structuredClone(original), identity };
  }
  save(f.root, context);
  const mixed = loadOperationContextSources(f.root, { env: f.env });
  assert.deepEqual(queryLoadedOperationContext(mixed, legacyIdentity).operations.map(row => row.identity.stack ?? 'legacy'), ['legacy', 'primary', 'secondary']);
  Object.defineProperty(mixed.sources[0], 'projected', { get() { assert.fail('An exact stack identity scanned the store.'); } });
  assert.deepEqual(queryLoadedOperationContext(mixed, { ...legacyIdentity, stack: 'secondary' }).operations.map(row => row.identity.stack), ['secondary']);
});

test('context writes allow the exact serialized byte limit and preserve the old file on overflow', (t) => {
  const f = scratch(t);
  captureOperationContext(f.root, observation());
  updateContext(f.root, ctx => {
    ctx.fixture_padding = 'é';
    const serializedBytes = Buffer.byteLength(`${JSON.stringify(ctx, null, 2)}\n`, 'utf8');
    ctx.fixture_padding += 'a'.repeat(MAX_CONTEXT_BYTES - serializedBytes);
  });
  const before = readFileSync(contextPath(f.root));
  assert.equal(before.length, MAX_CONTEXT_BYTES);
  assert.equal(f.query().operations.length, 1);
  const filesBefore = readdirSync(dirname(contextPath(f.root))).sort();
  assert.throws(() => updateContext(f.root, ctx => { ctx.fixture_padding += 'a'; }),
    { code: 'CONTEXT_CAPACITY_REACHED' });
  assert.deepEqual(readFileSync(contextPath(f.root)), before);
  assert.throws(() => captureOperationContext(f.root, observation({ notes: ['Another observation exceeds storage capacity.'] })),
    { code: 'CONTEXT_CAPACITY_REACHED' });
  assert.deepEqual(readFileSync(contextPath(f.root)), before);
  const oversized = load(f.root);
  oversized.fixture_padding += 'a';
  assert.throws(() => saveContext(f.root, oversized), { code: 'CONTEXT_CAPACITY_REACHED' });
  assert.deepEqual(readFileSync(contextPath(f.root)), before);
  assert.deepEqual(readdirSync(dirname(contextPath(f.root))).sort(), filesBefore);

  // Legacy-only snapshots obey the same storage boundary as extensions.
  delete oversized.api_context;
  oversized.fixture_padding = 'a'.repeat(MAX_CONTEXT_BYTES);
  assert.throws(() => saveContext(f.root, oversized), { code: 'CONTEXT_CAPACITY_REACHED' });
  assert.deepEqual(readFileSync(contextPath(f.root)), before);
  assert.deepEqual(readdirSync(dirname(contextPath(f.root))).sort(), filesBefore);
});

test('capture keeps payload shapes, omissions and external provenance without storing raw values', (t) => {
  const f = scratch(t);
  const result = captureOperationContext(f.root, observation({ source: { kind: 'client', tool: 'other-agent', headers: { raw: 'private-metadata' } },
    verification: 'client-observation', request: { token: 'sk_test_very_private_fixture_value', email: 'person@example.invalid' },
    response: { 'person@example.invalid': 'private-dynamic-key-value', rows: [{ id: 'private-row-value' }, { id: 'another-private-row' }] } }));
  assert.equal(result.state, 'captured');
  const queried = f.query();
  assert.equal(queried.operations.length, 1);
  const observed = queried.operations[0].observations[0];
  assert.equal(observed.verification, 'external-claim');
  assert.equal(observed.source.kind, 'external');
  assert.equal(observed.source.tool, 'other-agent');
  assert.deepEqual(observed.request_shape, { type: 'object', properties: { token: { type: 'string' }, email: { type: 'string' } } });
  assert.equal(observed.response_shape.properties.rows.type, 'array');
  assert.ok(observed.omissions.some(text => text.includes('structure omitted')));
  assert.doesNotMatch(bytes(f.root) + JSON.stringify(queried), /private-|person@example|sk_test/);
});

test('internal observations retain scoped declaration checks while dropping variables values and arbitrary adapter metadata', (t) => {
  const f = scratch(t);
  captureOperationContext(f.root, observation({ declaration: {
    protocol: 'graphql', operationType: 'query', operationName: 'Devices', schemaValidated: true,
    validationScope: 'request-document-and-variables', responseValidated: false,
    variables: [{ name: 'org', type: 'ID!', value: 'private-variable-value' }],
    payload: { password: 'private-adapter-password' },
  } }), { internal: true });
  const value = f.query().operations[0].observations[0];
  assert.equal(value.verification, 'client-observation'); assert.equal(value.source.kind, 'client');
  assert.equal(value.declaration.schemaValidated, true); assert.equal(value.declaration.responseValidated, false);
  assert.deepEqual(value.declaration.variables, [{ name: 'org', type: 'ID!' }]);
  assert.ok(value.omissions.includes('Only supported declaration metadata was retained.'));
  assert.doesNotMatch(bytes(f.root), /private-variable|private-adapter|password|"payload"/);
  for (const basis of ['declared', 'authored']) captureOperationContext(f.root, observation({ basis }));
  assert.deepEqual(f.query().operations[0].observations.map(row => row.basis), ['observed', 'declared', 'authored']);
});

test('internal 2 MiB responses produce compact shapes while external captures retain the 1 MiB bound', (t) => {
  const f = scratch(t), input = observation({ response: { huge: 'z'.repeat(2 * 1024 * 1024) } });
  assert.throws(() => captureOperationContext(f.root, input), { code: 'CONTEXT_INPUT_INVALID' });
  captureOperationContext(f.root, input, { internal: true });
  assert.ok(Buffer.byteLength(bytes(f.root)) < 3000);
  assert.deepEqual(f.query().operations[0].observations[0].response_shape, { type: 'object', properties: { huge: { type: 'string' } } });
  assert.throws(() => captureOperationContext(f.root, observation({ response: 'z'.repeat(16 * 1024 * 1024) }), { internal: true }), { code: 'CONTEXT_INPUT_INVALID' });
});

test('operation identities separate provider, environment, protocol, operation, endpoint and contract revision', (t) => {
  const f = scratch(t), identities = [baseIdentity,
    { ...baseIdentity, provider: 'other-provider' }, { ...baseIdentity, environment: 'staging' },
    { ...baseIdentity, protocol: 'grpc' }, { ...baseIdentity, operation: 'query Other' },
    { ...baseIdentity, endpoint: 'http://other.invalid/graphql' }, { ...baseIdentity, contractDigest: `sha256:${'b'.repeat(64)}` },
    { ...baseIdentity, contractDigest: null }];
  assert.equal(new Set(identities.map(operationId)).size, identities.length);
  assert.equal(operationId(baseIdentity), operationId(Object.fromEntries(Object.entries(baseIdentity).reverse())));
  for (const identity of identities) captureOperationContext(f.root, observation({ identity }));
  assert.equal(f.query().operations.length, identities.length);
  assert.equal(f.query(baseIdentity).operations.length, 1);
  assert.equal(f.query({ provider: 'other-provider' }).operations.length, 1);
  for (const identity of [
    { ...baseIdentity, endpoint: 'wss://name:private-password@fixture.invalid/stream' },
    { ...baseIdentity, endpoint: 'http://fixture.invalid/?query=private' },
    { ...baseIdentity, contractDigest: 'sha256:aaaaaaaaaaaaaaaa' },
    { ...baseIdentity, operation: 'Bearer abcdef0123456789secret' },
  ]) assert.throws(() => operationIdentity(identity), error => /^CONTEXT_/.test(error.code));
});

test('history appends preserve the newest twenty observations and count omitted history', (t) => {
  const f = scratch(t);
  for (let i = 0; i < 25; i += 1) captureOperationContext(f.root, observation({ notes: [`Observation number ${i}.`] }));
  const entry = f.query({}, { maxBytes: 64000 }).operations[0];
  assert.equal(entry.observations.length, 20); assert.equal(entry.omitted_observations, 5);
  assert.equal(entry.observations[0].notes[0], 'Observation number 5.');
  assert.equal(entry.observations.at(-1).notes[0], 'Observation number 24.');
  assert.equal(new Set(entry.observations.map(row => row.id)).size, 20);
});

test('operation capacity and legacy binding history are bounded without changing original records', (t) => {
  const f = scratch(t), operations = {};
  for (let n = 0; n < 2000; n += 1) {
    const identity = { ...baseIdentity, operation: `query Fixture${n}` };
    operations[operationId(identity)] = { identity, observations: [], omitted_observations: 0 };
  }
  save(f.root, { v: 0, operations: {}, api_context: { v: 1, operations } });
  const before = bytes(f.root);
  assert.throws(() => captureOperationContext(f.root, observation()), { code: 'CONTEXT_CAPACITY_REACHED' });
  assert.equal(bytes(f.root), before);
  captureOperationContext(f.root, observation({ identity: { ...baseIdentity, operation: 'query Fixture0' } }));
  assert.equal(Object.keys(load(f.root).api_context.operations).length, 2000);

  const old = Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`GET /legacy${n}`, { notes: [`Original note ${n}.`] }]));
  save(f.root, { v: 0, operations: old });
  migrateOperationContext(f.root, { bindings: Object.keys(old).map(legacy_operation => ({ legacy_operation, identity: baseIdentity })) });
  const value = f.query().operations[0];
  assert.equal(value.legacy_bindings.length, 20); assert.equal(value.omitted_legacy_bindings, 5);
  assert.deepEqual(load(f.root).operations, old);
});

test('malformed arrays, sources, assertions and non-JSON inputs fail with fixed errors before changing context', (t) => {
  const f = scratch(t); captureOperationContext(f.root, observation()); const before = bytes(f.root);
  const cyclic = observation(); cyclic.response = cyclic;
  for (const input of [
    null, [], observation({ evidence: {} }), observation({ notes: 'private-input-text' }), observation({ omissions: {} }),
    observation({ source: [] }), observation({ source: null }), observation({ assertions: [] }),
    observation({ assertions: { passed: -1, failed: 0 } }), observation({ complete: 'true' }),
    observation({ declaration: [] }), observation({ declaration: { variables: ['private-variable'] } }),
    observation({ declaration: { schemaValidated: 'true' } }), observation({ response: undefined }),
    observation({ response: Infinity }), observation({ response: 1n }), observation({ response: () => 'private' }), cyclic,
  ]) {
    assert.throws(() => captureOperationContext(f.root, input), error => {
      assert.equal(error.code, 'CONTEXT_INPUT_INVALID'); assert.doesNotMatch(error.message, /private-/); return true;
    });
    assert.equal(bytes(f.root), before);
  }
});

test('evidence identity is checked on each read and never upgrades an external claim', (t) => {
  const f = scratch(t), reference = evidencePath('evidence.json'), evidence = join(f.root, reference);
  writeFileSync(evidence, JSON.stringify({ private: 'private-evidence-body' }));
  captureOperationContext(f.root, observation({ evidence: [{ path: reference, locator: '/response' }] }));
  const record = () => f.query().operations[0].observations[0];
  assert.equal(record().evidence[0].state, 'matching'); assert.equal(record().verification, 'external-claim');
  assert.equal(record().evidence[0].meaning, 'artifact-identity-only');
  writeFileSync(evidence, 'changed evidence'); assert.equal(record().evidence[0].state, 'changed');
  rmSync(evidence); assert.equal(record().evidence[0].state, 'missing-or-unavailable');
  assert.doesNotMatch(bytes(f.root) + JSON.stringify(record()), /private-evidence-body|changed evidence/);
  const other = scratch(t); writeFileSync(join(other.root, 'outside.json'), 'private-outside');
  symlinkSync(join(other.root, 'outside.json'), evidence);
  assert.throws(() => captureOperationContext(f.root, observation({ evidence: [{ path: reference }] })), { code: 'CONTEXT_EVIDENCE_INVALID' });
});

test('evidence references, author text, shapes, and query item counts report their limits', (t) => {
  const f = scratch(t), reference = evidencePath('evidence.json'); writeFileSync(join(f.root, reference), '{}');
  const input = observation({ evidence: Array.from({ length: 9 }, () => ({ path: reference })),
    notes: Array.from({ length: 11 }, (_, i) => `Note ${i}.`),
    omissions: Array.from({ length: 21 }, (_, i) => `Omission ${i}.`), response: Array.from({ length: 8 }, () => ({ value: 1 })) });
  for (let n = 0; n < 3; n += 1) captureOperationContext(f.root, input);
  const result = f.query({}, { maxBytes: 64000 });
  assert.equal(result.operations[0].observations[0].evidence.length, 8);
  assert.equal(result.operations[0].observations[0].notes.length, 10);
  assert.equal(result.omissions.evidence_checks, 4);
  assert.equal(result.operations[0].observations[2].evidence.filter(ref => ref.state === 'unchecked').length, 4);
  captureOperationContext(f.root, observation({ identity: { ...baseIdentity, operation: 'query Other' } }));
  assert.equal(f.query({}, { maxItems: 1, maxBytes: 64000 }).omissions.operations, 1);
  const small = f.query({}, { maxBytes: 512 });
  assert.equal(small.operations.length, 0); assert.equal(small.omissions.operations, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 512);
  for (const options of [{ maxItems: NaN }, { maxItems: 101 }, { maxBytes: Infinity }, { maxBytes: 0 }])
    assert.throws(() => f.query({}, options), { code: 'CONTEXT_INPUT_INVALID' });
  const shaped = contextShape({ rows: Array.from({ length: 8 }, () => ({ a: 1 })) });
  assert.equal(shaped.omitted, 3); assert.equal(shaped.shape.properties.rows.sampled, 5);
});

test('cross-repository queries reread directional grants and provider context on every call', (t) => {
  const consumer = scratch(t), provider = scratch(t, { legacy: true }), other = scratch(t, { legacy: true });
  appendHistoricalObservation(provider.root);
  appendHistoricalObservation(other.root, { provider: 'ungranted-provider' });
  const registry = emptyRegistry();
  const consumerId = registerRepo(registry, consumer.root).id, providerId = registerRepo(registry, provider.root).id;
  registerRepo(registry, other.root); saveRegistry(registry, consumer.env);
  assert.equal(consumer.query().operations.length, 0);
  grant(registry, consumerId, providerId); saveRegistry(registry, consumer.env);
  assert.equal(consumer.query().operations.length, 1);
  assert.equal(consumer.query().operations[0].repository, providerId);
  appendHistoricalObservation(provider.root, { notes: ['A newly authored provider note.'] });
  assert.equal(consumer.query().operations[0].observations.length, 2);
  assert.equal(provider.query({}, { env: consumer.env }).operations.filter(row => row.repository !== 'local').length, 0);
  revoke(registry, consumerId, providerId); saveRegistry(registry, consumer.env);
  assert.equal(consumer.query().operations.length, 0);
});

test('diagnostics from many damaged granted repositories share the query byte budget', (t) => {
  const f = scratch(t), registry = emptyRegistry(), consumer = registerRepo(registry, f.root).id;
  for (let n = 0; n < 25; n += 1) {
    const provider = scratch(t, { legacy: true }); writeFileSync(contextPath(provider.root), '{broken json');
    grant(registry, consumer, registerRepo(registry, provider.root).id);
  }
  saveRegistry(registry, f.env);
  const result = f.query({}, { maxBytes: 512 });
  assert.equal(result.operations.length, 0); assert.ok(result.omissions.issues > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 512);
});

test('explicit HTTP and MCP migration preserves originals, appends digest bindings, and never invents observations', (t) => {
  const f = scratch(t), legacy = { v: 0, operations: { 'GET /devices': { notes: ['Existing legacy note.'], last_called: '2026-09-01' } },
    mcp_inspections: [{ id: 'explicit-inspection', at: '2026-09-01T00:00:00.000Z', declared: { tools: [] }, measured: [] },
      { at: '2026-09-02T00:00:00.000Z', declared: { tools: [{ name: 'inspect' }] }, measured: [] }] };
  save(f.root, legacy);
  const identity = { ...baseIdentity, protocol: 'http', operation: 'GET /devices' };
  const mcpIdentity = { ...baseIdentity, protocol: 'mcp', operation: 'inspect' };
  const bindings = [{ legacy_operation: 'GET /devices', identity },
    { legacy_mcp_id: 'explicit-inspection', identity: mcpIdentity },
    { legacy_mcp_id: '2026-09-02T00:00:00.000Z', identity: mcpIdentity }];
  const result = migrateOperationContext(f.root, { bindings });
  assert.equal(result.originals_preserved, true);
  assert.deepEqual(load(f.root).operations, legacy.operations); assert.deepEqual(load(f.root).mcp_inspections, legacy.mcp_inspections);
  const queried = f.query(); assert.equal(queried.operations.length, 2);
  assert.ok(queried.operations.every(entry => entry.observations.length === 0));
  const mcp = queried.operations.find(entry => entry.identity.protocol === 'mcp');
  assert.equal(mcp.legacy_bindings.length, 2);
  assert.deepEqual(mcp.legacy_bindings.map(row => row.identity_field), ['id', 'at']);
  assert.ok(mcp.legacy_bindings.every(row => row.state === 'matching'));
  const before = bytes(f.root); migrateOperationContext(f.root, { bindings }); assert.equal(bytes(f.root), before);
  const changed = load(f.root); changed.mcp_inspections[0].declared.tools.push({ name: 'later' }); save(f.root, changed);
  assert.equal(f.query({ protocol: 'mcp' }).operations[0].legacy_bindings[0].state, 'changed');
  const missing = load(f.root); missing.mcp_inspections.splice(1, 1); save(f.root, missing);
  assert.equal(f.query({ protocol: 'mcp' }).operations[0].legacy_bindings[1].state, 'missing');
});

test('missing or ambiguous legacy selectors and damaged target entries refuse migration without writes', (t) => {
  const f = scratch(t);
  const legacy = { v: 0, operations: { 'GET /x': {} }, mcp_inspections: [{ id: 'duplicate' }, { id: 'duplicate' }] };
  save(f.root, legacy);
  for (const bindings of [[], [null], [{ identity: baseIdentity }],
    [{ legacy_operation: 'GET /x', legacy_mcp_id: 'duplicate', identity: baseIdentity }],
    [{ legacy_operation: 'GET /missing', identity: baseIdentity }], [{ legacy_mcp_id: 'duplicate', identity: baseIdentity }]]) {
    const before = bytes(f.root);
    assert.throws(() => migrateOperationContext(f.root, { bindings }), error => /^CONTEXT_/.test(error.code));
    assert.equal(bytes(f.root), before);
  }
  const broken = { ...legacy, api_context: { v: 1, operations: { [operationId(baseIdentity)]: { identity: baseIdentity, observations: 'bad', omitted_observations: 0 } } } };
  save(f.root, broken); const before = bytes(f.root);
  assert.throws(() => migrateOperationContext(f.root, { bindings: [{ legacy_operation: 'GET /x', identity: baseIdentity }] }), { code: 'CONTEXT_INVALID' });
  assert.equal(bytes(f.root), before);
});

test('damaged or unsupported context remains untouched and query reports the problem', (t) => {
  for (const value of ['{bad json', { v: 99, operations: {} }, { v: 0, operations: [] },
    { v: 0, operations: {}, api_context: null }, { v: 0, operations: {}, api_context: { v: 2, operations: {} } }]) {
    const f = scratch(t);
    writeFileSync(contextPath(f.root), typeof value === 'string' ? value : JSON.stringify(value));
    const before = bytes(f.root);
    assert.throws(() => captureOperationContext(f.root, observation()), error => /^CONTEXT_/.test(error.code));
    assert.equal(bytes(f.root), before);
    assert.equal(f.query().operations.length, 0); assert.ok(f.query().issues.length);
  }
});

test('query never returns arbitrary persisted payloads and rejects malformed stored shape data', (t) => {
  const f = scratch(t); captureOperationContext(f.root, observation());
  const context = load(f.root), entry = context.api_context.operations[operationId(baseIdentity)];
  entry.raw_payload = 'private-root-payload'; entry.observations[0].response = 'private-stored-response';
  entry.observations[0].source.headers = { raw: 'private-source-header' }; save(f.root, context);
  assert.doesNotMatch(JSON.stringify(f.query()), /private-root|private-stored|private-source/);
  entry.observations[0].response_shape = { type: 'string', value: 'private-shape-value' }; save(f.root, context);
  const before = bytes(f.root);
  assert.equal(f.query().operations.length, 0); assert.ok(f.query().issues.some(issue => issue.code === 'CONTEXT_INVALID'));
  assert.throws(() => captureOperationContext(f.root, observation()), { code: 'CONTEXT_INVALID' });
  assert.equal(bytes(f.root), before);
});

test('unusable JSON field names are omitted consistently before storing and retrieving shapes', (t) => {
  const f = scratch(t);
  captureOperationContext(f.root, observation({ response: { '': 'private-empty-key', '\n': 'private-control-key', good: 'private-good-value' } }));
  const result = f.query(); assert.equal(result.issues.length, 0);
  assert.deepEqual(result.operations[0].observations[0].response_shape, { type: 'object', properties: { good: { type: 'string' } } });
  assert.ok(result.operations[0].observations[0].omissions.some(note => note.includes('2 items')));
});
