import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createSurveySnapshot, canonicalSurveyJson } from '../lib/survey-model.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { buildWorkbenchMap, WORKBENCH_MAP_BYTES } from '../lib/workbench-map.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, LAYOUT.directory, 'graph', 'survey.json');
  return { root, file, put(value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : canonicalSurveyJson(value)); } };
}
function specimen(count = 1) {
  const nodes = [], relationships = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: `file-${i}`, kind: 'file', label: `src/routes-${i}.js`, file: `src/routes-${i}.js` },
      { id: `op-${i}`, kind: 'operation', label: `GET /items-${i}`, operation: `GET /items-${i}`, stack: 'items' });
    relationships.push({ id: `defines-${i}`, kind: 'defines', from: `file-${i}`, to: `op-${i}`,
      declarations: [{ kind: 'code', file: `src/routes-${i}.js`, line: 4 }], observations: [], operator_attributions: [] });
  }
  return createSurveySnapshot({ nodes, relationships }, { now: '2026-10-19T12:00:00Z' });
}

test('workbench map reads only retained survey bytes; missing and stale states do not generate or execute', t => {
  const f = fixture(t), before = readdirSync(f.root);
  const blank = buildWorkbenchMap(f.root);
  assert.equal(blank.state, 'not-generated'); assert.match(blank.commands.generate, /survey generate$/);
  assert.deepEqual(readdirSync(f.root), before, 'opening an absent map writes nothing');
  const snapshot = specimen(); f.put(snapshot);
  const bytes = readFileSync(f.file, 'utf8');
  const current = buildWorkbenchMap(f.root);
  assert.equal(current.state, 'ready'); assert.deepEqual(current.current_inputs, { state: 'not-checked' });
  assert.deepEqual(current.totals, { nodes: 2, relationships: 1, unresolved: 0 });
  assert.equal(current.relationships[0].support_counts.declarations, 1);
  assert.equal(current.relationships[0].support_counts.observations, 0);
  assert.equal(current.snapshot.id, snapshot.snapshot.id);
  assert.equal(readFileSync(f.file, 'utf8'), bytes);
  const key = createHash('sha256').update(resolve(f.file)).digest('hex').slice(0, 24);
  const state = join(f.root, LAYOUT.evidence, 'survey'); mkdirSync(state, { recursive: true });
  writeFileSync(join(state, `${key}.status.json`), JSON.stringify({ snapshot_id: snapshot.snapshot.id,
    state: 'stale', checked_at: '2026-10-19T13:00:00Z', source: { state: 'changed' } }));
  const stale = buildWorkbenchMap(f.root);
  assert.equal(stale.current_inputs.state, 'stale'); assert.equal(stale.nodes.length, 2);
  assert.deepEqual(readFileSync(f.file, 'utf8'), bytes, 'historical snapshots remain unchanged and inspectable');
});

test('workbench map refuses unsafe graph data and never echoes absolute paths, secret fields or invalid bytes', t => {
  const f = fixture(t), value = specimen();
  value.nodes[0].label = ['Bearer', 'ghp_' + 'x'.repeat(36)].join(' '); f.put(JSON.stringify(value));
  const result = buildWorkbenchMap(f.root);
  assert.equal(result.state, 'invalid');
  assert.ok(!JSON.stringify(result).includes('ghp_')); assert.ok(!JSON.stringify(result).includes(f.root));
  assert.equal(result.nodes.length, 0); assert.equal(result.relationships.length, 0);
  assert.match(result.diagnostic.code, /^SURVEY_/);
});

test('workbench map bounds nodes, complete-endpoint edges and bytes while retaining exact total and omission counts', t => {
  const f = fixture(t); f.put(specimen(700));
  const value = buildWorkbenchMap(f.root), ids = new Set(value.nodes.map(node => node.id));
  assert.equal(value.totals.nodes, 1400); assert.equal(value.totals.relationships, 700);
  assert.ok(value.omitted.nodes > 0); assert.ok(value.omitted.relationships > 0);
  assert.equal(value.nodes.length + value.omitted.nodes, 1400);
  assert.equal(value.relationships.length + value.omitted.relationships, 700);
  for (const edge of value.relationships) assert.ok(ids.has(edge.from) && ids.has(edge.to));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= WORKBENCH_MAP_BYTES);
  assert.deepEqual(value, buildWorkbenchMap(f.root), 'bounded display selection is deterministic');

  // Valid metadata can be large before even one node is selected. The initial
  // unresolved/limitations projection shares the display byte budget too.
  const long = 'x'.repeat(1000), source = specimen();
  const unresolved = Array.from({ length: 24 }, () => ({ kind: long, reason: long, file: `src/${long}.mjs`,
    stack: long, operation: `GET /${long}`, host: long, path: `/${long}`, state: long, extent: long }));
  f.put(createSurveySnapshot({ nodes: source.nodes, relationships: source.relationships, unresolved,
    coverage: { limitations: Array.from({ length: 12 }, () => long) } }));
  const metadataHeavy = buildWorkbenchMap(f.root);
  assert.ok(Buffer.byteLength(JSON.stringify(metadataHeavy)) <= WORKBENCH_MAP_BYTES, 'base metadata cannot exceed the map cap');
  assert.equal(metadataHeavy.unresolved.length + metadataHeavy.omitted.unresolved, unresolved.length);
  assert.equal(metadataHeavy.limitations.length + metadataHeavy.limitations_omitted, 12);
  assert.ok(metadataHeavy.omitted.unresolved > 12, 'large unresolved records are omitted by bytes as well as count');
  assert.equal(metadataHeavy.nodes.length, 2, 'reserve room for the graph after bounding the diagnostic metadata');
});
