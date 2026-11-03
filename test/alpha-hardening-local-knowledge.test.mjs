import { withFixtureProjection } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { graphContext } from '../lib/agent-graph-context.mjs';
import { exportGraphSnapshot } from '../lib/graph-export.mjs';
import { captureOperationContext as captureRaw } from '../lib/operation-context.mjs';
import { PRODUCT } from '../lib/brand.mjs';
import { createConsumerFixture, consumerManifest, NODE, OPERATION, AT, LOCAL_NOTE, THIRD_NOTE, json } from './fixtures/ah4b-consumer.mjs';

const captureOperationContext = (root,...args) => withFixtureProjection(root, () => captureRaw(root,...args));
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ah4b-consumer-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return createConsumerFixture(parent);
}
const query = { action: 'context', node: NODE, operation: OPERATION, environment: 'staging', max_bytes: 64000 };
function localLesson(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.requests_executed, 0);
  const local = result.knowledge.find(record => record.notes.includes(LOCAL_NOTE));
  assert.ok(local, 'the consumer lesson belongs in knowledge by default');
  assert.equal(local.publisher, 'consumer');
  assert.equal(local.publisher_trust, 'local');
  assert.equal(local.basis, 'authored');
  assert.equal(local.verification, 'external-claim');
  assert.equal(result.foreign_claims?.some(record => record.notes.includes(LOCAL_NOTE)) ?? false, false);
  return local;
}
function thirdParty(result, opted) {
  assert.equal(result.knowledge.some(record => record.publisher === 'third'), false);
  if (opted) {
    assert.equal(result.foreign_claims.length, 1);
    assert.deepEqual(result.foreign_claims[0].notes, [THIRD_NOTE]);
    assert.equal(result.foreign_claims[0].verification, 'external-claim');
  } else {
    assert.equal(result.foreign_claims, undefined);
    assert.equal(result.omitted_foreign_claims, 1, 'only the catalog-delivered third-party claim is omitted');
  }
}

for (const response_format of ['concise', 'detailed']) for (const opted of [false, true]) {
  test(`AH-4b ${response_format} ${opted ? 'opt-in' : 'default'} context keeps the consumer lesson in knowledge`, async t => {
    const { root } = fixture(t);
    const result = await graphContext(root, { ...query, response_format, include_foreign_claims: opted });
    localLesson(result); thirdParty(result, opted);
    assert.equal(result.knowledge.length, 1);
  });
}

test('AH-4b local provider lessons inspect without opt-in while third-party references still require it', async t => {
  const { root } = fixture(t);
  const result = await graphContext(root, { ...query, include_foreign_claims: true });
  const local = localLesson(result);
  localLesson(await graphContext(root, { action: 'inspect', ref: local.detail_ref }));
  const ref = result.foreign_claims[0].detail_ref;
  assert.equal((await graphContext(root, { action: 'inspect', ref })).issues[0].code, 'GRAPH_FOREIGN_CLAIMS_OPT_IN_REQUIRED');
  const inspected = await graphContext(root, { action: 'inspect', ref, include_foreign_claims: true });
  assert.deepEqual(inspected.knowledge, []);
  thirdParty(inspected, true);
});

test('AH-4b graph context and impact CLI JSON agree on local knowledge and third-party omissions', t => {
  const { root } = fixture(t);
  for (const action of ['context', 'impact']) for (const opted of [false, true]) {
    const run = spawnSync(process.execPath, [CLI, 'graph', action, NODE,
      ...(action === 'context' ? ['--operation', OPERATION, '--environment', 'staging'] : []),
      '--max-bytes', '64000', '--json', ...(opted ? ['--include-foreign-claims'] : [])],
    { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, API_CONTEXT_OFF: '0' } });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    localLesson(result); thirdParty(result, opted);
    assert.equal(result.knowledge.length, 1);
  }
});

test('AH-4b local observations rank before the consumer authored provider lesson', async t => {
  const { root } = fixture(t);
  const manifest = consumerManifest('consumer');
  manifest.context.providers.push({ node: 'consumer#repo', provider: 'local-api', environment: 'staging', protocol: 'http' });
  json(join(root, LAYOUT.graphManifest), manifest);
  captureOperationContext(root, { identity: { provider: 'local-api', environment: 'staging', protocol: 'http', operation: OPERATION,
    endpoint: 'https://fixture.invalid', contractDigest: `sha256:${'a'.repeat(64)}` }, basis: 'observed', source: { tool: 'api_request' },
  observed_at: AT, response: { count: 1 }, outcome: 'success', complete: true }, { internal: true });
  for (const [action, response_format] of [['context', 'concise'], ['context', 'detailed'], ['impact', 'detailed']]) {
    const result = await graphContext(root, { ...query, action, response_format });
    const local = localLesson(result);
    assert.equal(result.knowledge[0].basis, 'observed');
    assert.equal(result.knowledge[0].verification, 'client-observation');
    assert.equal(result.knowledge[1], local);
    thirdParty(result, false);
  }
});

test('AH-4b compact responses retain the local lesson and count only third-party omissions', async t => {
  const { root } = fixture(t);
  for (const [response_format, max_bytes] of [['concise', 2000], ['detailed', 2500]]) {
    const result = await graphContext(root, { ...query, response_format, max_bytes });
    localLesson(result); thirdParty(result, false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= max_bytes);
    assert.equal(result.truncated.response_bytes, true);
  }
});

test('AH-4b an exported consumer lesson becomes an opt-in foreign claim in another consumer', async t => {
  const f = fixture(t), reader = f.create('reader');
  json(join(reader, 'catalog', 'consumer.json'), exportGraphSnapshot(f.root));
  const ordinary = await graphContext(reader, query);
  assert.equal(ordinary.ok, true);
  assert.deepEqual(ordinary.knowledge, []);
  assert.equal(ordinary.omitted_foreign_claims, 1);
  const opted = await graphContext(reader, { ...query, include_foreign_claims: true });
  assert.deepEqual(opted.knowledge, []);
  assert.equal(opted.foreign_claims.length, 1);
  assert.deepEqual(opted.foreign_claims[0].notes, [LOCAL_NOTE]);
  assert.equal(opted.foreign_claims[0].verification, 'external-claim');
});

test('AH-4b a catalog snapshot claiming the consumer identity cannot make a provider claim local', async t => {
  const f = fixture(t), imported = exportGraphSnapshot(f.root);
  // Imported metadata cannot confer the provenance assigned to the fresh local projection.
  for (const record of imported.knowledge) record.publisher_trust = 'local';
  json(join(f.root, 'catalog', 'impostor.json'), imported);
  const result = await graphContext(f.root, query);
  localLesson(result);
  assert.equal(result.knowledge.length, 1);
  assert.equal(result.omitted_foreign_claims, 2);
  assert.ok(result.issues.some(issue => issue.code === 'GRAPH_LOCAL_PUBLISHER_CLAIM'));
});
