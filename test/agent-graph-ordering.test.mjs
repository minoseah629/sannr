import { captureGraphStackFixture, recordGraphStackFixture } from './helpers/graph-stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync,  readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { graphContext, graphTool } from '../lib/agent-graph-context.mjs';
import { createGraphSnapshot, buildGraphCatalog } from '../lib/dependency-graph.mjs';

const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const AT = '2026-08-01T12:00:00.000Z', LATER = '2026-08-02T12:00:00.000Z';
const JSONwrite = (path, value) => writeFileSync(path, JSON.stringify(value));
const healthShape = type => ({ type: 'object', properties: { counts: { type: 'object', properties: { deployment_events: { type } } } } });
const healthType = item => item.response_shape?.properties?.counts?.properties?.deployment_events?.type;
const query = { action: 'context', response_format: 'detailed', node: 'local#api', operation: 'GET /health', environment: 'staging', max_bytes: 12000 };
function fact(id, overrides = {}) {
  return { id: sha(id), node: 'local#api', operation: 'GET /health', protocol: 'http', environment: 'staging', basis: 'observed', verification: 'client-observation', notes: [], observed_at: AT, recorded_at: AT,
    response_shape: healthShape('string'), evidence: [{ path: 'evidence/old.json', digest: sha('old'), state: 'unavailable' }],
    source: { kind: 'protocol-context', path: LAYOUT.context, record_id: id, digest: sha('source'), author: 'fixture-client' },
    freshness: { state: 'unknown', reason: 'Saved observation does not establish current behavior.', observed_at: AT }, omissions: ['Evidence file contents were not copied or rechecked.'], ...overrides };
}
function fixture(t, records = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-ordering-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'catalog')); mkdirSync(join(root, 'evidence'));
  const manifest = { v: 1, repository: { id: 'local', name: 'Local' }, catalog: 'catalog', nodes: [{ id: 'api', kind: 'service', name: 'API' }], context: { providers: [{ node: 'local#api', provider: 'fixture-api', environment: 'staging', protocol: 'http' }] } };
  JSONwrite(join(root, LAYOUT.graphManifest), manifest);
  const publish = (publisher, items, filename = `${publisher}.json`) => {
    manifest.publishers = [...(manifest.publishers ?? []).filter(pin => pin.id !== publisher), { id: publisher, fingerprint: sha(publisher) }];
    JSONwrite(join(root, LAYOUT.graphManifest), manifest);
    const snapshot = createGraphSnapshot({ v: 1, repository: { id: publisher, name: publisher, fingerprint: sha(publisher) }, nodes: [{ id: 'api', kind: 'service', name: 'Publisher API' }], dependencies: [{ from: 'api', to: 'local#api', kind: 'calls' }] }, { knowledge: items.map(item => ({ ...item, node: `${publisher}#api` })), at: AT });
    JSONwrite(join(root, 'catalog', filename), snapshot); return snapshot;
  };
  if (records.length) publish('reader', records);
  const capture = (type, at, extra = {}) => captureGraphStackFixture(root, {
    identity: { provider: 'fixture-api', environment: 'staging', protocol: 'http', operation: 'GET /health', endpoint: 'https://fixture.invalid', contractDigest: sha('contract') },
    basis: 'observed', source: { tool: 'api_request' }, observed_at: at, response: { counts: { deployment_events: type === 'number' ? 240 : '240' } }, outcome: 'success', complete: true, ...extra,
  }, { internal: true });
  const note = (text, at) => recordGraphStackFixture(root, { node: 'local#api', operation: 'GET /health', note: text, observed_at: at });
  return { root, publish, capture, note };
}

test('bounded focused retrieval prioritizes local observations and explicitly omits authored claims after verified lanes', async t => {
  const oldClaim = 'Previous response represented the event count as a string.';
  const f = fixture(t, [
    ...Array.from({ length: 30 }, (_, index) => fact(`old-${index}`)),
    fact('reader-claim', { basis: 'authored', verification: 'external-claim', notes: [oldClaim], response_shape: undefined }),
  ].map(item => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined))));
  f.capture('string', AT); f.capture('string', '2026-08-01T13:00:00.000Z');
  f.note('An earlier local observation also returned a string.', AT);
  f.capture('number', LATER);
  f.note('The new observation returned a number; the earlier string observation described the previous response.', LATER);
  const beforeContext = readFileSync(join(f.root, LAYOUT.context));
  const result = await graphContext(f.root, query);
  assert.equal(result.ok, true); assert.equal(result.knowledge_ordering, 'verification-first-fair-diverse-v2');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= query.max_bytes);
  assert.equal(result.knowledge[0].publisher, 'local'); assert.equal(healthType(result.knowledge[0]), 'number');
  assert.equal(result.knowledge[0].observed_at, LATER); assert.equal(result.knowledge[0].freshness.state, 'unknown');
  assert.ok(result.knowledge.some(item => healthType(item) === 'string'), 'contrast survives alongside new evidence');
  assert.equal(result.knowledge.some(item => item.basis === 'authored'), false, 'verification lanes precede authored claims under a byte cap');
  const complete = await graphContext(f.root, { ...query, max_bytes: 64000 });
  assert.ok(complete.knowledge.some(item => item.publisher === 'reader' && item.notes.includes(oldClaim)), 'authored claims remain accessible after the verification lanes with a larger budget');
  const correction = complete.knowledge.find(item => item.publisher === 'local' && item.basis === 'authored' && item.observed_at === LATER);
  assert.ok(correction); assert.equal(correction.verification, 'external-claim'); assert.equal(correction.freshness.state, 'unverified');
  assert.ok(result.knowledge.some(item => item.evidence.some(ref => ref.state === 'unavailable')));
  assert.equal(result.truncated.response_bytes, true); assert.ok(result.omitted_response_items.knowledge > 0);
  assert.deepEqual(readFileSync(join(f.root, LAYOUT.context)), beforeContext, 'ranking cannot rewrite captured history');
  assert.equal(result.requests_executed, 0);
});

test('future imported timestamps and one publisher flood cannot starve local knowledge or another publisher', async t => {
  const f = fixture(t);
  const flooded = Array.from({ length: 205 }, (_, index) => fact(`flood-${index}`, { observed_at: '9999-01-01T00:00:00.000Z', recorded_at: '9999-01-01T00:00:00.000Z' }));
  flooded.push(fact('plausible-time', { observed_at: AT, recorded_at: AT }));
  f.publish('a-flood', flooded);
  f.publish('z-other', [fact('other-publisher', { response_shape: healthShape('boolean') })]);
  f.capture('number', LATER);
  const result = await graphContext(f.root, query);
  assert.equal(healthType(result.knowledge[0]), 'number'); assert.equal(result.knowledge[0].publisher, 'local');
  assert.equal(result.knowledge.find(item => item.publisher === 'a-flood')?.source.record_id, 'plausible-time', 'future timestamps do not outrank valid observed time');
  assert.ok(result.knowledge.some(item => item.publisher === 'z-other'), 'one publisher cannot consume every imported turn');
  assert.equal(result.truncated.knowledge, true, 'ranking precedes and still discloses the 200-record traversal cap');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= query.max_bytes);
});

test('catalog file order and repeated shape keys do not change scoped ranking, while distinct contract evidence remains separate', async t => {
  const f = fixture(t);
  const newer = fact('new-shape', { observed_at: LATER, contractDigest: sha('new-contract'), response_shape: healthShape('number') });
  const oldContract = fact('old-contract-same-shape', { contractDigest: sha('old-contract'), response_shape: healthShape('number') });
  const repeated = fact('new-contract-repeat', { observed_at: AT, contractDigest: sha('new-contract'), response_shape: healthShape('number') });
  const a = f.publish('a', [repeated, oldContract, newer], 'first.json');
  const b = f.publish('b', [fact('other-scope', { operation: 'GET /other' }), fact('wrong-env', { environment: 'production' }), fact('other-protocol', { protocol: 'graphql' })], 'last.json');
  const snapshotBefore = JSON.stringify(buildGraphCatalog([a, b]).knowledge);
  const before = await graphContext(f.root, { ...query, max_bytes: 64000 });
  JSONwrite(join(f.root, 'catalog/first.json'), b); JSONwrite(join(f.root, 'catalog/last.json'), a);
  const after = await graphContext(f.root, { ...query, max_bytes: 64000 });
  assert.deepEqual(after.knowledge.map(item => item.id), before.knowledge.map(item => item.id));
  assert.equal(JSON.stringify(buildGraphCatalog([a, b]).knowledge), snapshotBefore, 'static catalogs retain their original records/order');
  const publisherRecords = after.knowledge.filter(item => item.publisher === 'a');
  assert.deepEqual(publisherRecords.map(item => item.source.record_id), ['new-shape', 'old-contract-same-shape', 'new-contract-repeat']);
  assert.ok(after.knowledge.every(item => item.operation === 'GET /health' && item.environment === 'staging'));
  assert.ok(after.knowledge.some(item => item.protocol === 'graphql'), 'protocol scopes remain distinct; no unsupported protocol filter is invented');
});

test('a record too large for the requested budget does not suppress a smaller intact authored claim', async t => {
  const largeShape = { type: 'object', properties: Object.fromEntries(Array.from({ length: 75 }, (_, index) => [`long_field_name_${index}_${'x'.repeat(25)}`, { type: 'string' }])) };
  const f = fixture(t, [fact('too-large', { response_shape: largeShape }), fact('short-claim', { basis: 'authored', verification: 'external-claim', notes: ['Recheck the current response.'], response_shape: healthShape('string') })]);
  const result = await graphContext(f.root, { ...query, max_bytes: 2000 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2000);
  assert.equal(result.knowledge.length, 1, JSON.stringify(result));
  assert.equal(result.knowledge[0].source.record_id, 'short-claim');
  assert.equal(result.knowledge[0].verification, 'external-claim');
  assert.ok(result.omitted_response_items.knowledge > 0);
  assert.match((await graphTool(f.root)).description, /Ordering does not resolve disagreements or verify truth/);
});
