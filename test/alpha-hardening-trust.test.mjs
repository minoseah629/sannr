import { withFixtureProjection } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync,  realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT } from '../lib/brand.mjs';
import { createGraphSnapshot } from '../lib/dependency-graph.mjs';
import { graphContext, graphTool } from '../lib/agent-graph-context.mjs';
import { captureOperationContext as captureRaw } from '../lib/operation-context.mjs';
import { recordGraphContext as recordRaw } from '../lib/graph-record.mjs';

const captureOperationContext = (root,...args) => withFixtureProjection(root, () => captureRaw(root,...args));
const recordGraphContext = (root,...args) => withFixtureProjection(root, () => recordRaw(root,...args));
const sha = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const AT = '2026-08-01T12:00:00.000Z';
const json = (path, data) => writeFileSync(path, JSON.stringify(data));
function fact(id, overrides = {}) {
  return { id: sha(id), node: 'provider#api', operation: 'GET /health', protocol: 'http', environment: 'staging',
    basis: 'observed', verification: 'client-observation', notes: ['Saved response has a count field.'], observed_at: AT,
    response_shape: { type: 'object', properties: { count: { type: 'number' } } }, evidence: [],
    source: { kind: 'protocol-context', path: LAYOUT.context, record_id: id, digest: sha('source'), claim_kind: 'client', verification: 'client-observation' },
    freshness: { state: 'unknown', reason: 'Saved data is not current verification.' }, omissions: [], ...overrides };
}
function fixture(t, { publishers } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-trust-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'catalog')); mkdirSync(join(root, 'evidence'));
  const manifest = { v: 1, repository: { id: 'local', name: 'Local' }, catalog: 'catalog',
    nodes: [{ id: 'api', kind: 'service', name: 'Local API' }],
    dependencies: [{ from: 'api', to: 'provider#api', kind: 'calls' }],
    context: { providers: [{ node: 'local#api', provider: 'fixture-api', environment: 'staging', protocol: 'http' }] },
    ...(publishers ? { publishers } : {}) };
  json(join(root, LAYOUT.graphManifest), manifest);
  const publish = (publisher, records, { fingerprint = sha('publisher pin'), foreign = false } = {}) => {
    const declaration = { v: 1, repository: { id: publisher, name: publisher, fingerprint },
      nodes: [{ id: 'api', kind: 'service', name: 'Published API' }],
      ...(foreign ? { dependencies: [{ from: 'api', to: 'local#api', kind: 'calls' }] } : {}) };
    json(join(root, 'catalog', `${publisher}.json`), createGraphSnapshot(declaration, { knowledge: records, at: AT }));
  };
  const capture = () => captureOperationContext(root, {
    identity: { provider: 'fixture-api', environment: 'staging', protocol: 'http', operation: 'GET /health', endpoint: 'https://fixture.invalid', contractDigest: sha('contract') },
    basis: 'observed', source: { tool: 'api_request' }, observed_at: AT, response: { count: 1 }, outcome: 'success', complete: true,
  }, { internal: true });
  const query = args => graphContext(root, { action: 'context', node: 'local#api', max_bytes: 64000, ...args });
  return { root, manifest, publish, capture, query };
}

test('AH-4 unlisted publisher is an external claim and local observation outranks authored lessons in every response format', async t => {
  const f = fixture(t);
  f.publish('provider', [fact('unlisted-observation')]);
  f.capture();
  recordGraphContext(f.root, { node: 'local#api', operation: 'GET /health', note: 'Recheck the count field before relying on this lesson.', observed_at: AT });
  for (const response_format of ['concise', 'detailed']) {
    const result = await f.query({ response_format });
    assert.equal(result.ok, true);
    const imported = result.knowledge.find(record => record.publisher === 'provider');
    assert.equal(imported.verification, 'external-claim');
    assert.notEqual(imported.basis, 'observed');
    assert.notEqual(imported.source.verification, 'client-observation');
    assert.equal(result.knowledge[0].publisher, 'local');
    assert.equal(result.knowledge[0].basis, 'observed');
    assert.equal(result.knowledge[0].verification, 'client-observation');
    assert.ok(result.knowledge.find(record => record.publisher === 'local' && record.basis === 'authored'));
  }
});

test('AH-4 mismatched publisher fingerprint is reported by name without publishing fingerprint values', async t => {
  const expected = sha('consumer pin'), actual = sha('different publisher pin');
  const f = fixture(t, { publishers: [{ id: 'provider', fingerprint: expected }] });
  f.publish('provider', [fact('mismatch')], { fingerprint: actual });
  const result = await f.query({ response_format: 'detailed' });
  const issue = result.issues.find(item => item.code === 'GRAPH_PUBLISHER_FINGERPRINT_MISMATCH');
  assert.equal(issue?.publisher, 'provider');
  assert.ok(issue.message.includes('provider'));
  assert.equal(result.knowledge[0].verification, 'external-claim');
  assert.notEqual(result.knowledge[0].basis, 'observed');
  assert.doesNotMatch(JSON.stringify(result.issues), new RegExp(`${expected}|${actual}`));
});

test('AH-4 matching manifest publisher fingerprint preserves attributed observation without claiming current verification', async t => {
  const f = fixture(t, { publishers: [{ id: 'provider', fingerprint: sha('publisher pin') }] });
  f.publish('provider', [fact('pinned-observation')]);
  const result = await f.query({ response_format: 'detailed' });
  assert.equal(result.knowledge[0].verification, 'client-observation');
  assert.equal(result.knowledge[0].basis, 'observed');
  assert.equal(result.knowledge[0].publisher_trust, 'manifest-fingerprint-match');
  assert.equal(result.knowledge[0].freshness.state, 'unknown');
});

test('AH-4 foreign-node claims require opt-in and remain in their own labeled section through concise inspection', async t => {
  const f = fixture(t, { publishers: [{ id: 'reader', fingerprint: sha('publisher pin') }] });
  f.publish('reader', [fact('foreign-claim', { node: 'local#api' })], { foreign: true });
  const ordinary = await f.query();
  assert.equal(ordinary.knowledge.some(record => record.publisher === 'reader'), false);
  assert.equal(ordinary.foreign_claims?.length ?? 0, 0);
  const opted = await f.query({ include_foreign_claims: true });
  assert.equal(opted.ok, true);
  assert.equal(opted.knowledge.some(record => record.publisher === 'reader'), false);
  assert.equal(opted.foreign_claims.length, 1);
  assert.match(opted.foreign_claims_meaning, /foreign.*unverified/iu);
  assert.equal(opted.foreign_claims[0].verification, 'external-claim');
  assert.notEqual(opted.foreign_claims[0].basis, 'observed');
  assert.notEqual(opted.foreign_claims[0].source.verification, 'client-observation');
  const ref = opted.foreign_claims[0].detail_ref;
  assert.equal((await graphContext(f.root, { action: 'inspect', ref })).issues[0].code, 'GRAPH_FOREIGN_CLAIMS_OPT_IN_REQUIRED');
  const inspected = await graphContext(f.root, { action: 'inspect', ref, include_foreign_claims: true });
  assert.equal(inspected.knowledge.length, 0);
  assert.equal(inspected.foreign_claims.length, 1);
  assert.equal(inspected.foreign_claims[0].verification, 'external-claim');
  assert.ok((await graphTool(f.root)).inputSchema.properties.include_foreign_claims);
});

test('AH-4 catalog claim to the consumer identity cannot replace or outrank a fresh local observation', async t => {
  const f = fixture(t);
  f.publish('local', [fact('local-identity-spoof', { node: 'local#api' })]);
  f.capture();
  const result = await f.query({ response_format: 'detailed' });
  assert.equal(result.ok, true);
  assert.equal(result.knowledge[0].publisher_trust, 'local');
  assert.equal(result.knowledge[0].verification, 'client-observation');
  const imported = result.knowledge.find(record => record.source.record_id === 'local-identity-spoof');
  assert.equal(imported?.verification, 'external-claim');
  assert.notEqual(imported.basis, 'observed');
  assert.ok(result.issues.some(item => item.code === 'GRAPH_LOCAL_PUBLISHER_CLAIM'));
});

test('AH-4 unlisted authored claims never precede a second local observation or displace it from a bounded context', async t => {
  const f = fixture(t);
  f.publish('provider', Array.from({ length: 20 }, (_, index) => fact(`authored-${index}`, {
    basis: 'authored', verification: 'external-claim', notes: ['Recheck the count field.'],
  })));
  f.capture(); f.capture();
  const complete = await f.query();
  assert.deepEqual(complete.knowledge.slice(0, 2).map(record => [record.publisher, record.verification]),
    [['local', 'client-observation'], ['local', 'client-observation']]);
  const bounded = await f.query({ max_bytes: 4000 });
  assert.deepEqual(bounded.knowledge.slice(0, 2).map(record => [record.publisher, record.verification]),
    [['local', 'client-observation'], ['local', 'client-observation']]);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4000);
});

test('AH-4 impact delivery also places local observations before unlisted publisher claims', async t => {
  const f = fixture(t);
  f.publish('provider', [fact('impact-claim')], { foreign: true });
  f.capture();
  const result = await f.query({ action: 'impact', response_format: 'detailed' });
  assert.equal(result.ok, true);
  assert.equal(result.knowledge[0].publisher_trust, 'local');
  assert.equal(result.knowledge[0].verification, 'client-observation');
  assert.equal(result.knowledge.find(record => record.publisher === 'provider').verification, 'external-claim');
});
