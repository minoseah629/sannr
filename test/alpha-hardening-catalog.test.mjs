import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync,  rmSync, symlinkSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT, } from "../lib/brand.mjs";
import { createGraphSnapshot, normalizeGraphManifest, loadGraphCatalog, buildGraphCatalog, graphNeighborhood, graphImpact } from '../lib/dependency-graph.mjs';
import { graphTool } from '../lib/agent-graph-context.mjs';

const sha = char => `sha256:${char.repeat(64)}`;
const manifest = id => ({ v: 1, repository: { id, name: 'Fixture' } });
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-catalog-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const catalog = join(root, 'catalog'); mkdirSync(catalog);
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ ...manifest('consumer'), catalog: 'catalog' }));
  return { root, catalog };
}
const write = (dir, name, value) => writeFileSync(join(dir, name), JSON.stringify(value));

test('AH-4 malformed catalog file is skipped by name while valid snapshots load', async t => {
  const f = fixture(t);
  write(f.catalog, 'good.json', createGraphSnapshot(manifest('provider')));
  writeFileSync(join(f.catalog, 'broken.json'), '{');
  const catalog = await loadGraphCatalog(f.catalog);
  assert.deepEqual(catalog.repositories.map(repo => repo.id), ['provider']);
  assert.ok(catalog.issues.some(issue => issue.file === 'broken.json' && issue.code === 'GRAPH_CATALOG_INVALID'));
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(f.root));
});

test('AH-4 macOS temporary-directory aliases pass catalog symlink refusal', { skip: process.platform !== 'darwin' && 'macOS system alias specimen' }, async t => {
  const root = mkdtempSync(('/' + 'tmp/alpha-catalog-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'provider.json', createGraphSnapshot(manifest('provider')));
  assert.equal((await loadGraphCatalog(root)).repositories[0].id, 'provider');
  assert.equal((await loadGraphCatalog(join(root, 'provider.json'))).repositories[0].id, 'provider');
});

test('AH-4 linked catalog entry is skipped by name without following it', async t => {
  const f = fixture(t);
  write(f.catalog, 'good.json', createGraphSnapshot(manifest('provider')));
  symlinkSync(join(f.catalog, 'good.json'), join(f.catalog, 'linked.json'));
  const catalog = await loadGraphCatalog(f.catalog);
  assert.deepEqual(catalog.repositories.map(repo => repo.id), ['provider']);
  assert.ok(catalog.issues.some(issue => issue.file === 'linked.json' && issue.code === 'GRAPH_SYMLINK_REFUSED'));
  await assert.rejects(loadGraphCatalog(join(f.catalog, 'linked.json')), { code: 'GRAPH_SYMLINK_REFUSED' });
});

test('AH-4 publisher fingerprints survive manifest normalization and snapshot export', () => {
  const input = { ...manifest('consumer'), repository: { ...manifest('consumer').repository, fingerprint: sha('a') },
    publishers: [{ id: 'team/provider', fingerprint: sha('b') }] };
  const normalized = normalizeGraphManifest(input);
  assert.deepEqual(normalized.publishers, input.publishers);
  assert.equal(normalized.repository.fingerprint, sha('a'));
  const snapshot = createGraphSnapshot(input);
  assert.equal(snapshot.repository.fingerprint, sha('a'));
  assert.equal(snapshot.publishers, undefined, 'consumer trust pins stay in the consumer manifest');
  assert.equal(buildGraphCatalog([snapshot]).repositories[0].fingerprint, sha('a'));
  for (const publishers of [[{ id: 'provider', fingerprint: 'invalid' }], [input.publishers[0], input.publishers[0]]])
    assert.throws(() => normalizeGraphManifest({ ...input, publishers }), error => ['GRAPH_INPUT_INVALID', 'GRAPH_PUBLISHER_CONFLICT'].includes(error.code));
});

test('AH-4 non-slug catalog repository id never reaches a tool description', async t => {
  const f = fixture(t), invalid = 'team/not/a/slug';
  // Construct raw bytes: a caller cannot depend on our writer to validate an imported file.
  const snapshot = createGraphSnapshot(manifest('provider'));
  snapshot.repository.id = invalid;
  snapshot.nodes[0].id = `${invalid}#repo`; snapshot.nodes[0].repository = invalid;
  write(f.catalog, 'bad-id.json', snapshot);
  const tool = await graphTool(f.root);
  assert.ok(!tool.description.includes(invalid));
  const catalog = await loadGraphCatalog(f.catalog);
  assert.ok(catalog.issues.some(issue => issue.file === 'bad-id.json' && issue.code === 'GRAPH_REPOSITORY_ID_INVALID'));
});

test('AH-4 catalog record format and bidi controls are refused by name', async t => {
  const f = fixture(t);
  for (const [name, control] of [['format', '\u200b'], ['bidi', '\u202e']]) {
    const value = createGraphSnapshot(manifest('provider'));
    value.repository.name = `Fixture${control}`;
    write(f.catalog, `${name}.json`, value);
  }
  const catalog = await loadGraphCatalog(f.catalog);
  assert.equal(catalog.repositories.length, 0);
  for (const file of ['format.json', 'bidi.json'])
    assert.ok(catalog.issues.some(issue => issue.file === file && issue.code === 'GRAPH_TEXT_CONTROL_REFUSED'));
});

test('AH-4 foreign-node claims require opt-in and never enter owned-node knowledge', () => {
  const provider = manifest('provider');
  const consumer = { ...manifest('consumer'), dependencies: [{ from: 'repo', to: 'provider#repo', kind: 'calls' }] };
  const record = { id: sha('c'), node: 'provider#repo', operation: 'GET /items', protocol: 'http', basis: 'observed', verification: 'client-observation', notes: [],
    evidence: [], omissions: [], source: { kind: 'protocol-context', path: LAYOUT.context, record_id: 'fixture', digest: sha('d') },
    freshness: { state: 'unknown', reason: 'Evidence unavailable.' } };
  const catalog = buildGraphCatalog([createGraphSnapshot(provider), createGraphSnapshot(consumer, { knowledge: [record] })]);
  for (const query of [graphNeighborhood, graphImpact]) {
    const hidden = query(catalog, { node: 'provider#repo' });
    assert.deepEqual(hidden.knowledge, []);
    assert.equal(hidden.foreign_claims, undefined);
    assert.equal(hidden.omitted_foreign_claims, 1);
    const opted = query(catalog, { node: 'provider#repo', includeForeignClaims: true });
    assert.deepEqual(opted.knowledge, []);
    assert.equal(opted.foreign_claims.length, 1);
    assert.equal(opted.foreign_claims[0].basis, 'unknown');
    assert.equal(opted.foreign_claims[0].verification, 'external-claim');
    assert.equal(opted.foreign_claims[0].source.verification, 'external-claim');
    assert.match(opted.foreign_claims_meaning, /foreign nodes/i);
  }
});
