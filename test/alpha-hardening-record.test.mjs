import { withFixtureProjection, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {  PRODUCT } from "../lib/brand.mjs";
import { materializeRecordedSnapshot } from '../lib/graph-snapshot-write.mjs';
import { normalizeGraphManifest } from '../lib/dependency-graph.mjs';
import { graphRecordTool, recordGraphContext as recordRaw } from '../lib/graph-record.mjs';

const recordGraphContext = (root,...args) => withFixtureProjection(root, () => recordRaw(root,...args));
const manifest = () => ({ v: 1, repository: { id: 'fixture/service', name: 'Service' }, nodes: [],
  context: { providers: [{ node: 'repo', provider: 'fixture', environment: 'test', protocol: 'http' }] } });
const lesson = { node: 'repo', operation: 'GET /widgets', note: 'An authored fixture claim; execution remains unverified.' };
function setup(t, input = manifest()) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-record-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify(input));
  writeFileSync(join(root, fixtureEvidencePath(), 'evidence.json'), '{}');
  return root;
}

test('AH-1 locator refuses an absolute workstation path by name without changing knowledge bytes', t => {
  const root = setup(t);
  recordGraphContext(root, lesson);
  const path = join(root, LAYOUT.context), before = readFileSync(path);
  const locator = ['','Users','workstation-fixture','evidence.json'].join('/');
  assert.throws(() => recordGraphContext(root, { ...lesson, evidence: [{ path: `${fixtureEvidencePath()}/evidence.json`, locator }] }), error => {
    assert.equal(error.code, 'GRAPH_PATH_REFUSED');
    assert.ok(!error.message.includes(locator));
    return true;
  });
  assert.deepEqual(readFileSync(path), before);
});

test('AH-1 locator pointer errors precede workstation checks and valid escaped pointers remain accepted', t => {
  const root = setup(t);
  for (const locator of ['C:' + String.raw`\workstation-fixture\evidence.json`, ('/' + 'Users/workstation-fixture/bad~2')]) {
    assert.throws(() => recordGraphContext(root, { ...lesson, evidence: [{ path: 'missing.json', locator }] }),
      { code: 'GRAPH_EVIDENCE_LOCATOR_INVALID' });
  }
  assert.equal(existsSync(join(root, LAYOUT.context)), false);
  assert.doesNotThrow(() => recordGraphContext(root, { ...lesson,
    evidence: [{ path: `${fixtureEvidencePath()}/evidence.json`, locator: '/response/body/literal~0tilde~1slash' }] }));
});

test('AH-1 committed manifest refuses absolute catalog paths by name while retaining portable relative catalogs', () => {
  const absolutePaths = [
    ['', 'Users', 'workstation-fixture', 'catalog'].join('/'),
    '/catalog', 'C:' + String.raw`\workstation-fixture\catalog`,
    String.raw`\\workstation-fixture\catalog`, '~/catalog',
  ];
  for (const catalog of absolutePaths) {
    assert.throws(() => normalizeGraphManifest({ ...manifest(), catalog }), error => {
      assert.equal(error.code, 'GRAPH_PATH_REFUSED');
      assert.ok(!error.message.includes(catalog));
      return true;
    });
  }
  for (const catalog of ['catalog', 'catalog/provider.json', '../shared-catalog'])
    assert.equal(normalizeGraphManifest({ ...manifest(), catalog }).catalog, catalog);
});

test('AH-1 api_context_record declares destructiveHint when a configured snapshot is replaced', async t => {
  const input = manifest(); input.context.snapshot = 'snapshot.json';
  const root = setup(t, input);
  const first = recordGraphContext(root, lesson);
  assert.equal(first.snapshot.state, 'deferred');
  assert.equal(first.snapshot.code, 'STACK_GRAPH_EXPORT_DEFERRED');
  // Snapshot aggregation is deferred for stacks. Exercise the existing
  // replacement/annotation control against the saved historical projection.
  const materialize = receipt => materializeRecordedSnapshot(root, () => normalizeGraphManifest(input), receipt);
  assert.equal(materialize(first).state, 'written');
  const target = join(root, 'snapshot.json'), before = readFileSync(target);
  const tool = await graphRecordTool(root);
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.readOnlyHint, false);
  const next = recordGraphContext(root, { ...lesson, note: 'A second authored fixture claim; execution remains unverified.' });
  assert.equal(next.snapshot.state, 'deferred');
  assert.equal(materialize(next).state, 'written');
  assert.notDeepEqual(readFileSync(target), before);
  const plain = await graphRecordTool(setup(t));
  assert.equal(plain.annotations.destructiveHint, false);
});
