import { LAYOUT, layoutFor } from "../lib/layout.mjs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as brand from '../lib/brand.mjs';
import { productMentionPattern, unlistedProseSurfaces } from './brand-guard-helpers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const renamed = 'zzBrand', renamedCollection = 'zzCollection';
const renamedLayout = layoutFor(renamed, renamedCollection);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-seam-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function child(root, source, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_') && !key.startsWith(brand.PRODUCT.toUpperCase() + '_')));
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8',
    env: { ...clean, API_CONTEXT_PRODUCT_NAME: renamed, API_CONTEXT_COLLECTION_NAME: renamedCollection, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0',
      API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'),
      [`${renamed.toUpperCase()}_HOME`]: join(root, 'home'), ...env } });
}
const moduleUrl = name => new URL(`../lib/${name}.mjs`, import.meta.url).href;

test('AH5 seam manifest basename snapshot path and kind derive together under rename', t => {
  const root = fixture(t);
  const result = child(root, `import * as b from ${JSON.stringify(moduleUrl('brand'))};
    import assert from 'node:assert/strict';
    import { createGraphSnapshot, buildGraphCatalog } from ${JSON.stringify(moduleUrl('dependency-graph'))};
    assert.equal(b.GRAPH_MANIFEST_BASENAME, '.zzBrand-graph.json');
    const { LAYOUT } = await import(${JSON.stringify(moduleUrl('layout'))});
    assert.equal(LAYOUT.graphSnapshot, ${JSON.stringify(renamedLayout.graphSnapshot)});
    assert.equal(LAYOUT.directory, '.zzBrand');
    assert.equal(b.COLLECTION, 'zzCollection');
    assert.equal(b.GRAPH_SNAPSHOT_KIND, 'zzBrand-graph');
    const snapshot = createGraphSnapshot({ v: 1, repository: { id: 'fixture/service', name: 'Service' }, nodes: [] });
    assert.equal(snapshot.kind, b.GRAPH_SNAPSHOT_KIND);
    assert.equal(buildGraphCatalog([snapshot]).repositories[0].id, snapshot.repository.id);`);
  assert.equal(result.status, 0, result.stderr);
});

test('AH5 seam renamed graph export finds the manifest and writes the default snapshot', t => {
  const root = fixture(t);
  writeFileSync(join(root, renamedLayout.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/service', name: 'Service' }, nodes: [] }));
  const result = child(root, `import { execFileSync, spawnSync } from 'node:child_process';
    import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict';
    const run = spawnSync(process.execPath, [${JSON.stringify(join(ROOT, 'bin/cli.mjs'))}, 'graph', 'export', '--json'], { encoding: 'utf8', env: process.env });
    assert.equal(run.status, 0, run.stderr);
    const snapshot = JSON.parse(readFileSync(${JSON.stringify(renamedLayout.graphSnapshot)}));
    assert.equal(snapshot.kind, 'zzBrand-graph');`);
  assert.equal(result.status, 0, result.stderr);
});

test('AH5 seam graph tools and remediation omit every case of the former product name', t => {
  const root = fixture(t);
  writeFileSync(join(root, renamedLayout.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/service', name: 'Service' }, nodes: [] }));
  const result = child(root, `import { graphRecordTool, graphRecordFailure } from ${JSON.stringify(moduleUrl('graph-record'))};
    import assert from 'node:assert/strict';
    const tool = graphRecordTool(process.cwd()); assert.ok(tool);
    const failures = ['GRAPH_RECORD_SCOPE_MISSING','GRAPH_BINDING_CONFLICT','GRAPH_MANIFEST_UNREADABLE','CONTEXT_INVALID','CONTEXT_VERSION_UNSUPPORTED'].map(code => graphRecordFailure({code}));
    assert.doesNotMatch(JSON.stringify({tool, failures}), new RegExp(${JSON.stringify(brand.PRODUCT)}, 'i'));`);
  assert.equal(result.status, 0, result.stderr);
});

test('AH5 seam inventory catches a lowercase product mention in a new tracked prose file', t => {
  const root = fixture(t), file = 'new-guide.md';
  writeFileSync(join(root, file), `Use ${brand.PRODUCT.toLowerCase()} here.\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', file], { cwd: root });
  const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(unlistedProseSurfaces(tracked, [], name => readFileSync(join(root, name), 'utf8'), brand.PRODUCT.toUpperCase()), [file]);
});

test('AH5 seam rename output guard catches lowercase uppercase and mixed-case mentions', () => {
  for (const mention of [brand.PRODUCT.toLowerCase(), brand.PRODUCT.toUpperCase(), brand.PRODUCT[0].toUpperCase() + brand.PRODUCT.slice(1)])
    assert.ok(productMentionPattern(brand.PRODUCT).test(`Use ${mention}.`), 'a case variant escaped the rename output guard');
});

test('AH5 seam renamed outside-save variable authorizes only the renamed client switch', t => {
  const root = fixture(t), outside = fixture(t);
  const result = child(root, `import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    globalThis.fetch = async () => new Response('fixture', {status: 200, headers: {'content-type': 'application/octet-stream'}});
    const { apiRequest } = await import(${JSON.stringify(moduleUrl('client'))});
    const target = ${JSON.stringify(join(outside, 'saved.txt'))};
    delete process.env[${JSON.stringify(renamed.toUpperCase() + '_ALLOW_SAVE_OUTSIDE')}];
    process.env[${JSON.stringify(brand.ALLOW_SAVE_OUTSIDE_ENV_NAME ?? brand.PRODUCT.toUpperCase() + '_ALLOW_SAVE_OUTSIDE')}] = '1';
    await assert.rejects(apiRequest({ method: 'GET', path: '/', save_to: target }), {code: 'SAVE_TO_OUTSIDE_PROJECT'});
    process.env[${JSON.stringify(renamed.toUpperCase() + '_ALLOW_SAVE_OUTSIDE')}] = '1';
    const result = await apiRequest({ method: 'GET', path: '/', save_to: target });
    assert.equal(result.ok, true); assert.equal(readFileSync(target, 'utf8'), 'fixture');`,
  { API_BASE_URL: 'http://127.0.0.1:9101', [`${renamed.toUpperCase()}_ALLOW_SAVE_OUTSIDE`]: '1' });
  assert.equal(result.status, 0, result.stderr);
});
