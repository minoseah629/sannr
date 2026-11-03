import { captureGraphStackFixture } from './helpers/graph-stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_FILE, MAX_CONTEXT_BYTES } from '../lib/context.mjs';
import { operationId } from '../lib/operation-context.mjs';
import { buildGraphCatalog, graphNeighborhood, loadGraphCatalog } from '../lib/dependency-graph.mjs';
import { exportGraphSnapshot } from '../lib/graph-export.mjs';

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sannr-graph-export-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const save = (root, name, value) => writeFileSync(join(root, name), JSON.stringify(value));
const load = root => JSON.parse(readFileSync(join(root, CONTEXT_FILE), 'utf8'));
const manifest = (overrides = {}) => ({ v: 1, repository: { id: 'acme/billing', name: 'Billing', url: 'https://example.invalid/billing' },
  nodes: [{ id: 'api', kind: 'service', name: 'Billing API', protocol: 'http' }], dependencies: [], context: { legacy: 'api' }, ...overrides });
const identity = (overrides = {}) => ({ provider: 'billing', environment: 'staging', protocol: 'graphql', operation: 'query Invoice',
  endpoint: 'https://api.example.invalid/graphql', contractDigest: `sha256:${'a'.repeat(64)}`, ...overrides });
const binding = { node: 'api', provider: 'billing', environment: 'staging', protocol: 'graphql' };
const context = (overrides = {}) => ({ v: 0, operations: {}, ...overrides });
function setup(t, ctx = context(), config = manifest()) {
  const root = scratch(t); save(root, LAYOUT.graphManifest, config); save(root, CONTEXT_FILE, ctx); return root;
}
const note = snapshot => snapshot.knowledge.find(record => record.notes.length);
const errorWithoutInputs = (code, privateText) => error => {
  assert.equal(error.code, code); assert.ok(!error.message.includes(privateText)); return true;
};

test('a saved client observation reaches an isolated checkout without source scanning, requests, or evidence bodies', async t => {
  let requests = 0;
  const server = createServer((request, response) => { requests++; response.end('must not be requested'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/graphql`;
  const root = setup(t, context(), manifest({ catalog: 'missing-catalog-must-not-be-read', context: { providers: [binding] } }));
  save(root, `${LAYOUT.evidence}/fixture/evidence.json`, { secret: 'private-evidence-body' });
  captureGraphStackFixture(root, { identity: identity({ endpoint }), source: { kind: 'client', tool: 'fixture-client' },
    basis: 'observed', outcome: 'success', complete: true, observed_at: '2024-01-03T04:05:06.000Z',
    notes: ['An invoice requires an account before creation.'], request: { account: 'private-request-value' },
    response: { invoice: { id: 'private-response-value', status: 'private-enum-value' } }, evidence: [{ path: `${LAYOUT.evidence}/fixture/evidence.json` }] }, { internal: true });
  const original = load(root), stored = Object.values(original.api_context.operations)[0].observations[0];
  const snapshot = exportGraphSnapshot(root);
  const consumer = scratch(t), file = join(consumer, 'billing.json');
  save(consumer, 'billing.json', snapshot);
  rmSync(root, { recursive: true, force: true });
  const catalog = await loadGraphCatalog(file), result = graphNeighborhood(catalog, { node: 'acme/billing#api' });
  const knowledge = result.knowledge[0];
  assert.equal(requests, 0);
  assert.deepEqual(knowledge.notes, ['An invoice requires an account before creation.']);
  assert.equal(knowledge.verification, 'client-observation');
  assert.equal(knowledge.basis, 'observed');
  assert.equal(knowledge.recorded_at, stored.recorded_at);
  assert.equal(knowledge.observed_at, '2024-01-03T04:05:06.000Z');
  assert.equal(knowledge.freshness.state, 'stale');
  assert.equal(knowledge.source.author, 'fixture-client');
  assert.equal(knowledge.source.path, CONTEXT_FILE);
  assert.equal(knowledge.source.claim_kind, 'client');
  assert.equal(knowledge.evidence[0].state, 'unavailable');
  assert.deepEqual(knowledge.response_shape, { type: 'object', properties: {
    invoice: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } } } });
  assert.doesNotMatch(JSON.stringify(result), /private-evidence|private-request|private-response|private-enum|127\.0\.0\.1|missing-catalog/);
  assert.ok(!JSON.stringify(result).includes(root));
});

test('legacy authored notes preserve their own dates and attribution without inheriting API verification', t => {
  const root = setup(t, context({ api: { contract_digest: `sha256:${'a'.repeat(16)}` }, operations: { 'GET /invoices': {
    verified_at: new Date().toISOString(), contract_digest: `sha256:${'a'.repeat(16)}`, notes: ['Requires an account first.', 'Expired guidance.'],
    notes_provenance: [{ by: 'backend-agent', at: '2024-01-02' }, { by: 'other-agent', at: '2024-01-01' }],
    notes_superseded: [null, { at: '2025-01-01', reason: 'successful_verification' }],
    fields: { customer: { values: ['private-customer-value'] } }, body: 'private-raw-body', source_file: 'src/invoices.mjs',
    shape: { count: 'number', rows: [{ id: 'string' }] } } } }));
  const snapshot = exportGraphSnapshot(root), entry = note(snapshot);
  assert.equal(snapshot.knowledge.length, 2);
  assert.deepEqual(entry.notes, ['Requires an account first.']);
  assert.equal(entry.recorded_at, '2024-01-02');
  assert.equal(entry.observed_at, undefined);
  assert.equal(entry.source.author, 'backend-agent');
  assert.equal(entry.verification, 'legacy-unverified');
  assert.equal(entry.basis, 'authored');
  assert.equal(entry.freshness.state, 'stale');
  assert.equal(entry.freshness.recorded_at, '2024-01-02');
  assert.match(snapshot.omissions.join(' '), /1 superseded legacy note/);
  assert.match(snapshot.knowledge[0].omissions.join(' '), /truncated/);
  assert.doesNotMatch(JSON.stringify(snapshot), /Expired guidance|private-customer|private-raw/);
});

test('legacy notes without provenance remain unknown and stored divergence remains stale on re-export', t => {
  const root = setup(t, context({ api: { contract_digest: `sha256:${'b'.repeat(16)}` }, operations: { 'GET /invoices': {
    contract_digest: `sha256:${'a'.repeat(16)}`, notes: ['Account scope is required.'] } } }));
  const first = exportGraphSnapshot(root), second = exportGraphSnapshot(root);
  for (const snapshot of [first, second]) {
    const entry = note(snapshot);
    assert.equal(entry.basis, 'unknown'); assert.equal(entry.recorded_at, undefined);
    assert.equal(entry.freshness.state, 'stale'); assert.equal(entry.verification, 'legacy-unverified');
    assert.match(entry.freshness.reason, /saved context records contract/);
    assert.match(entry.omissions.join(' '), /no author or recorded date/);
  }
  assert.deepEqual(first.knowledge, second.knowledge);
});

test('unbound legacy and protocol material is counted instead of inferred from provider or repository names', t => {
  const root = setup(t, context({ operations: { 'GET /invoices': { notes: ['Unbound legacy note.'] } },
    verdicts: { service: { reason: 'private-verdict-data' } }, mcp_inspections: [{ raw: 'private-mcp-data' }] }), manifest({ context: {} }));
  captureGraphStackFixture(root, { identity: identity(), source: { tool: 'other-agent' }, basis: 'authored',
    outcome: 'unknown', complete: false, notes: ['Unbound protocol note.'] });
  const snapshot = exportGraphSnapshot(root);
  assert.deepEqual(snapshot.knowledge, []);
  assert.match(snapshot.omissions.join(' '), /1 legacy HTTP operation\(s\) omitted/);
  assert.match(snapshot.omissions.join(' '), /1 protocol operation\(s\) omitted/);
  assert.match(snapshot.omissions.join(' '), /1 legacy MCP inspection record/);
  assert.match(snapshot.omissions.join(' '), /1 verdict record/);
  assert.doesNotMatch(JSON.stringify(snapshot), /Unbound legacy|Unbound protocol|private-/);
});

test('exact provider bindings preserve authored external claims and separate environments', t => {
  const root = setup(t, context(), manifest({ context: { providers: [binding] } }));
  for (const environment of ['staging', 'production']) captureGraphStackFixture(root, {
    identity: identity({ environment }), source: { tool: 'frontend-agent' }, basis: 'authored', outcome: 'unknown', complete: false,
    notes: [`${environment} requires account context.`] });
  const snapshot = exportGraphSnapshot(root), entry = note(snapshot);
  assert.equal(snapshot.knowledge.length, 1);
  assert.equal(entry.environment, 'staging'); assert.equal(entry.basis, 'authored');
  assert.equal(entry.verification, 'external-claim'); assert.equal(entry.source.author, 'frontend-agent');
  assert.equal(entry.freshness.state, 'unverified');
  assert.match(snapshot.omissions.join(' '), /1 protocol operation\(s\) omitted/);
  assert.match(entry.omissions.join(' '), /saved observation was unknown/);
});

test('a consumer can publish a scoped provider gotcha for another consumer without claiming provider ownership or verification', t => {
  const consumerManifest = id => ({ v: 1, repository: { id, name: id },
    nodes: [{ id: 'ui', kind: 'component', name: 'Invoice UI', file: 'src/Invoice.tsx' }],
    dependencies: [{ from: 'ui', to: 'acme/billing#api', kind: 'calls', protocol: 'graphql', environment: 'staging', operations: ['query Invoice'] }],
    context: { providers: [{ ...binding, node: 'acme/billing#api' }] } });
  const consumer = setup(t, context(), consumerManifest('acme/storefront'));
  captureGraphStackFixture(consumer, { identity: identity(), source: { kind: 'client', tool: 'storefront-agent' }, basis: 'observed',
    outcome: 'success', complete: true, notes: ['Invoice selection requires account scope even when the query is otherwise valid.'] }, { internal: true });
  const provider = setup(t), nextConsumer = setup(t, context(), consumerManifest('acme/checkout'));
  const consumerSnapshot = exportGraphSnapshot(consumer);
  const catalog = buildGraphCatalog([exportGraphSnapshot(provider), consumerSnapshot, exportGraphSnapshot(nextConsumer)]);
  rmSync(consumer, { recursive: true, force: true });
  const result = graphNeighborhood(catalog, { node: 'acme/checkout#repo', depth: 1, includeForeignClaims: true }), entry = result.foreign_claims.find(row => row.notes.length);
  assert.equal(entry.node, 'acme/billing#api');
  assert.equal(entry.publisher, 'acme/storefront');
  assert.equal(entry.source.author, 'storefront-agent');
  assert.equal(entry.basis, 'unknown');
  assert.equal(entry.verification, 'external-claim');
  assert.equal(entry.source.verification, 'external-claim');
  assert.match(entry.notes[0], /requires account scope/);
  assert.ok(!consumerSnapshot.nodes.some(node => node.id === 'acme/billing#api'));
  assert.equal(catalog.nodes.filter(node => node.id === 'acme/billing#api').length, 1);
});

test('secret-shaped notes are rejected without echoing content or modifying saved files', t => {
  const secret = 'sk_test_very_private_fixture_value';
  const root = setup(t, context({ operations: { 'GET /invoices': { notes: [`Use ${secret} here.`] } } }));
  const before = readFileSync(join(root, CONTEXT_FILE), 'utf8');
  assert.throws(() => exportGraphSnapshot(root), errorWithoutInputs('GRAPH_CONTEXT_SECRET_REFUSED', secret));
  assert.equal(readFileSync(join(root, CONTEXT_FILE), 'utf8'), before);
});

test('absolute workstation paths are refused in notes, author attribution, source files, and evidence references', t => {
  for (const entry of [
    { notes: [('Read /' + 'Users/private-person/project/config.json first.')] },
    { notes: ['Needs account scope.'], notes_provenance: [{ by: ('C:' + '\\private-person\\agent'), at: '2025-01-01' }] },
    { notes: [], source_file: '/etc/private-config' },
  ]) {
    const root = setup(t, context({ operations: { 'GET /invoices': entry } }));
    assert.throws(() => exportGraphSnapshot(root), error => /^GRAPH_.*PATH_REFUSED$/u.test(error.code));
  }
  const root = setup(t, context(), manifest({ context: { providers: [binding] } }));
  captureGraphStackFixture(root, { identity: identity(), source: { tool: 'agent' }, basis: 'authored', outcome: 'unknown', complete: false });
  const ctx = load(root), entry = Object.values(ctx.api_context.operations)[0];
  entry.observations[0].evidence = [{ path: '../private-evidence.json', digest: `sha256:${'a'.repeat(64)}` }];
  save(root, CONTEXT_FILE, ctx);
  assert.throws(() => exportGraphSnapshot(root), { code: 'GRAPH_CONTEXT_PATH_REFUSED' });
});

test('malformed saved identities, dates, notes, and protocol provenance fail with fixed diagnostics', t => {
  for (const ctx of [null, [], context({ operations: [] }), context({ v: 999 }),
    context({ operations: { 'private-operation': {} } }), context({ operations: { 'GET /invoices': { notes: 'private-note' } } }),
    context({ operations: { 'GET /invoices': { notes: [], verified_at: 'private-invalid-date' } } })]) {
    const root = setup(t, ctx);
    assert.throws(() => exportGraphSnapshot(root), error => {
      assert.equal(error.code, 'GRAPH_CONTEXT_INVALID'); assert.doesNotMatch(error.message, /private-/); return true;
    });
  }
  const root = setup(t, context(), manifest({ context: { providers: [binding] } }));
  captureGraphStackFixture(root, { identity: identity(), source: { tool: 'agent' }, outcome: 'success', complete: true });
  const ctx = load(root); ctx.api_context.operations[operationId({ ...identity(), stack: 'fixture' })].observations[0].verification = 'verified'; save(root, CONTEXT_FILE, ctx);
  assert.throws(() => exportGraphSnapshot(root), { code: 'GRAPH_CONTEXT_INVALID' });
});

test('bindings must reference declared local nodes and cannot assign one provider scope twice', t => {
  for (const contextBinding of [{ legacy: 'missing' }, { legacy: 'other/repo#api' },
    { providers: [{ ...binding, node: 'missing' }] }, { providers: [binding, binding] }]) {
    const root = setup(t, context(), manifest({ context: contextBinding }));
    assert.throws(() => exportGraphSnapshot(root), error => /^GRAPH_/u.test(error.code));
  }
});

test('missing context and oversized saved context yield explicit omissions without inventing knowledge', t => {
  const root = setup(t); rmSync(join(root, CONTEXT_FILE));
  assert.match(exportGraphSnapshot(root).omissions.join(' '), /No saved .* was present/);
  writeFileSync(join(root, CONTEXT_FILE), 'x'.repeat(MAX_CONTEXT_BYTES + 1));
  const snapshot = exportGraphSnapshot(root);
  assert.deepEqual(snapshot.knowledge, []);
  assert.match(snapshot.omissions.join(' '), /exceeds .* all saved context was omitted/);
});

test('the record bound is reported and re-export never changes the saved store', t => {
  const root = setup(t, context({ operations: { 'GET /invoices': { notes: Array.from({ length: 2050 }, (_, index) => `Recorded note ${index}.`) } } }));
  const before = readFileSync(join(root, CONTEXT_FILE));
  const snapshot = exportGraphSnapshot(root);
  assert.equal(snapshot.knowledge.length, 2000);
  assert.match(snapshot.omissions.join(' '), /51 knowledge record\(s\) omitted/);
  assert.deepEqual(readFileSync(join(root, CONTEXT_FILE)), before);
});

test('local context and manifest cannot escape the repo through paths or symlinks', t => {
  const root = setup(t), outside = setup(t);
  assert.throws(() => exportGraphSnapshot(root, { manifestPath: join(outside, LAYOUT.graphManifest) }), { code: 'GRAPH_CONTEXT_PATH_REFUSED' });
  rmSync(join(root, CONTEXT_FILE)); symlinkSync(join(outside, CONTEXT_FILE), join(root, CONTEXT_FILE));
  assert.throws(() => exportGraphSnapshot(root), { code: 'GRAPH_CONTEXT_PATH_REFUSED' });
});

test('unknown response shape fields cannot publish values or examples', t => {
  const root = setup(t, context(), manifest({ context: { providers: [binding] } }));
  captureGraphStackFixture(root, { identity: identity(), source: { tool: 'agent' }, outcome: 'success', complete: true, response: { id: 'private-id' } });
  const ctx = load(root), observation = Object.values(ctx.api_context.operations)[0].observations[0];
  observation.response_shape.properties.id.value = 'private-shape-value';
  observation.response_shape.example = { id: 'private-example' };
  observation.response = { id: 'private-raw-response' }; observation.request = { key: 'private-request' };
  save(root, CONTEXT_FILE, ctx);
  const snapshot = exportGraphSnapshot(root);
  assert.deepEqual(snapshot.knowledge[0].response_shape, { type: 'object', properties: { id: { type: 'string' } } });
  assert.match(snapshot.knowledge[0].omissions.join(' '), /2 response_shape item/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-/);
});

test('oversized and deep structural samples are projected within portable bounds with visible losses', t => {
  const root = setup(t, context(), manifest({ context: { providers: [binding] } }));
  captureGraphStackFixture(root, { identity: identity(), source: { tool: 'agent' }, outcome: 'success', complete: true });
  const ctx = load(root), observation = Object.values(ctx.api_context.operations)[0].observations[0];
  let nested = { type: 'string' };
  for (let index = 0; index < 20; index++) nested = { type: 'object', properties: { nested } };
  observation.request_shape = nested;
  observation.response_shape = { type: 'object', properties: Object.fromEntries(Array.from({ length: 100 }, (_, index) =>
    [`group${index}`, { type: 'object', properties: Object.fromEntries(Array.from({ length: 100 }, (_, child) => [`field${child}`, { type: 'number' }])) }])) };
  save(root, CONTEXT_FILE, ctx);
  const snapshot = exportGraphSnapshot(root), entry = snapshot.knowledge[0];
  assert.match(entry.omissions.join(' '), /request_shape item\(s\) omitted/);
  assert.match(entry.omissions.join(' '), /response_shape item\(s\) omitted/);
  assert.ok(JSON.stringify(entry).length < 50000);
  assert.doesNotThrow(() => buildGraphCatalog([snapshot]));
});


test('graph export refuses FIFO manifests and saved context without blocking the process', {
  skip: process.platform === 'win32' ? 'FIFO fixture requires the macOS/Linux alpha platform.' : false,
}, t => {
  for (const file of [LAYOUT.graphManifest, CONTEXT_FILE]) {
    const root = setup(t);
    rmSync(join(root, file));
    const fifo = spawnSync('mkfifo', [join(root, file)], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr || fifo.error?.message);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { exportGraphSnapshot } from ${JSON.stringify(new URL('../lib/graph-export.mjs', import.meta.url).href)};
      try { exportGraphSnapshot(${JSON.stringify(root)}); process.exitCode = 2; }
      catch (error) { process.stdout.write(error.code); }
    `], { encoding: 'utf8', timeout: 2000 });
    assert.equal(child.error, undefined, `${file} must fail before a FIFO read can block: ${child.error?.code}`);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, 'GRAPH_CONTEXT_INVALID');
  }
});
