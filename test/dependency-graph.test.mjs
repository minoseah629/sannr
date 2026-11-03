import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync,  mkdirSync, symlinkSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGraphManifest, createGraphSnapshot, buildGraphCatalog, loadGraphCatalog, graphNeighborhood, graphImpact } from '../lib/dependency-graph.mjs';

const at = '2026-09-11T10:00:00.000Z';
const sha = char => `sha256:${char.repeat(64)}`;
const manifest = (id = 'acme/catalog', extra = {}) => ({ v: 1, repository: { id, name: id.split('/').at(-1) },
  nodes: [{ id: 'api', kind: 'service', name: 'API' }], dependencies: [], ...extra });
const snapshot = (id, extra = {}, options = {}) => createGraphSnapshot(manifest(id, extra), { at, ...options });
const knowledge = (node = 'acme/catalog#api', extra = {}) => ({ id: sha('a'), node, operation: 'GET /items', protocol: 'http',
  basis: 'authored', verification: 'legacy-unverified', notes: ['Only published items are returned.'], observed_at: '2026-08-15',
  evidence: [{ path: 'evidence/check.json', digest: sha('b'), state: 'unavailable' }], omissions: [],
  source: { kind: 'legacy-http', path: LAYOUT.context, record_id: '/operations/GET ~1items/notes/0', digest: sha('c'), author: 'maintainer' },
  freshness: { state: 'unknown', reason: 'The provider source is unavailable.', observed_at: '2026-08-15' }, ...extra });
function temp(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sannr-graph-')));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
const write = (dir, name, value) => { const path = join(dir, name); writeFileSync(path, JSON.stringify(value)); return path; };
const errorCode = code => error => error.code === code && !error.message.includes('sensitive');

test('manifest creates stable owned identities and retains only local catalog and context configuration', () => {
  const input = manifest('acme/catalog', { repository: { id: 'acme/catalog', name: 'Catalog', url: 'https://github.com/acme/catalog' },
    catalog: '../shared-catalog', metrics: false, context: { legacy: 'api', providers: [{ node: 'api', provider: 'https://catalog.example', environment: 'development', protocol: 'graphql' }] },
    nodes: [{ id: 'api', kind: 'service', name: 'API', file: 'src/api.mjs', ignored: 'not published' }],
    dependencies: [{ from: 'api', to: 'acme/identity#api', kind: 'calls', protocol: 'http', environment: 'production', operations: ['GET /user', 'GET /user'], file: 'src/client.mjs' }] });
  const normalized = normalizeGraphManifest(input);
  assert.deepEqual(normalized.nodes.map(node => node.id), ['acme/catalog#repo', 'acme/catalog#api']);
  assert.equal(normalized.nodes[1].ignored, undefined);
  assert.equal(normalized.context.legacy, 'acme/catalog#api');
  assert.equal(normalized.context.providers[0].node, 'acme/catalog#api');
  assert.equal(normalized.metrics, false);
  assert.deepEqual(normalizeGraphManifest(normalized), normalized);
  const portable = createGraphSnapshot(normalized, { at });
  assert.equal(portable.catalog, undefined); assert.equal(portable.context, undefined); assert.equal(portable.metrics, undefined);
  assert.equal(portable.edges[0].basis, 'declared');
  assert.deepEqual(portable.edges[0].operations, ['GET /user']);
  assert.deepEqual(createGraphSnapshot({ ...input, repository: { ...input.repository, name: 'New name' } }, { at }).edges, portable.edges);
});

test('identity validation prevents foreign ownership, duplicate nodes and unresolved local targets', () => {
  for (const input of [
    manifest('acme/catalog', { nodes: [{ id: 'other/repo#api', name: 'API', kind: 'service' }] }),
    manifest('acme/catalog', { nodes: [{ id: 'api', name: 'API', kind: 'service' }, { id: 'api', name: 'Again', kind: 'service' }] }),
    manifest('acme/catalog', { dependencies: [{ from: 'other/repo#api', to: 'acme/catalog#api', kind: 'calls' }] }),
    manifest('acme/catalog', { dependencies: [{ from: 'api', to: 'acme/catalog#missing', kind: 'calls' }] }),
    manifest('acme/catalog', { nodes: [{ id: 'repo', name: 'Misclassified', kind: 'service' }] }),
    manifest('../catalog'), manifest('acme/catalog#api'),
  ]) assert.throws(() => normalizeGraphManifest(input), error => /^GRAPH_/u.test(error.code));
});

test('declarations cannot claim observed execution or silently repeat an identical edge', () => {
  const edge = { from: 'api', to: 'acme/provider#api', kind: 'calls' };
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { dependencies: [{ ...edge, basis: 'observed' }] })), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { dependencies: [edge, edge] })), errorCode('GRAPH_EDGE_CONFLICT'));
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { dependencies: [{ ...edge, id: sha('f') }] })), errorCode('GRAPH_INPUT_INVALID'));
});

test('context bindings require one exact provider scope and a real owned node', () => {
  const binding = { node: 'api', provider: 'https://catalog.example', environment: 'development', protocol: 'http' };
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { context: { providers: [binding, binding] } })), errorCode('GRAPH_BINDING_CONFLICT'));
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { context: { legacy: 'missing' } })), errorCode('GRAPH_NODE_MISSING'));
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { context: { providers: [{ ...binding, provider: 'https://user:pass@catalog.example' }] } })), error => /^GRAPH_/u.test(error.code));
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { metrics: 'true' })), errorCode('GRAPH_INPUT_INVALID'));
  assert.equal(normalizeGraphManifest(manifest('acme/catalog', { context: { providers: [{ ...binding, provider: 'dns:///workspace-api', protocol: 'grpc' }] } })).context.providers[0].provider, 'dns:///workspace-api');
});

test('metadata rejects terminal controls, credentials, unsafe URLs and source paths without echoing them', () => {
  for (const name of ['sensitive\u001b[31m', 'sensitive Bearer abcdefghijklmnopqrstuvwxyz', ('/' + 'Users/sensitive/project')])
    assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { repository: { id: 'acme/catalog', name } })), error => /^GRAPH_/u.test(error.code) && !error.message.includes('sensitive'));
  for (const file of ['../sensitive', '/etc/sensitive', 'file:///sensitive', 'src/../../sensitive', ('C:' + '\\sensitive'), 'src\\sensitive', 'src/file?key=value'])
    assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { nodes: [{ id: 'api', kind: 'service', name: 'API', file }] })), errorCode('GRAPH_PATH_REFUSED'));
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://github.com/repo?token=sensitive', 'https://github.com/repo#fragment'])
    assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { repository: { id: 'acme/catalog', name: 'Catalog', url } })), error => /^GRAPH_/u.test(error.code));
});

test('manifest input is bounded JSON and optional metadata is projected', () => {
  const cyclic = manifest(); cyclic.circular = cyclic;
  assert.throws(() => normalizeGraphManifest(cyclic), errorCode('GRAPH_INPUT_BOUNDS'));
  assert.throws(() => normalizeGraphManifest({ ...manifest(), other: new Date() }), errorCode('GRAPH_INPUT_BOUNDS'));
  assert.throws(() => normalizeGraphManifest({ ...manifest(), other: 'x'.repeat(4 * 1024 * 1024) }), errorCode('GRAPH_INPUT_BOUNDS'));
  assert.throws(() => normalizeGraphManifest(manifest('acme/catalog', { nodes: Array.from({ length: 2001 }, (_, id) => ({ id: `n${id}`, kind: 'component', name: 'Node' })) })), errorCode('GRAPH_INPUT_INVALID'));
  assert.equal(normalizeGraphManifest({ ...manifest(), headers: { authorization: 'ignored payload' } }).headers, undefined);
});

test('knowledge keeps dated author claims and structural shapes without exporting payload values or freshness upgrades', () => {
  const original = knowledge(undefined, { response_shape: { type: 'object', properties: { id: { type: 'string' } } }, payload: { id: 'never export' },
    source: { ...knowledge().source, claim_kind: 'note' } });
  const value = createGraphSnapshot(manifest(), { at, head: 'a'.repeat(40), knowledge: [original] });
  const record = value.knowledge[0];
  assert.equal(record.observed_at, '2026-08-15'); assert.equal(record.freshness.observed_at, '2026-08-15');
  assert.equal(record.basis, 'authored'); assert.equal(record.verification, 'legacy-unverified');
  assert.equal(record.freshness.state, 'unknown'); assert.equal(record.source.author, 'maintainer');
  assert.equal(record.payload, undefined); assert.equal(record.evidence[0].state, 'unavailable');
  assert.deepEqual(buildGraphCatalog([value]).knowledge, value.knowledge);
  assert.throws(() => createGraphSnapshot(manifest(), { knowledge: [{ ...original, response_shape: { type: 'string', value: 'sensitive' } }] }), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => createGraphSnapshot(manifest(), { knowledge: [{ ...original, freshness: { state: 'verified', reason: 'fresh' } }] }), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => createGraphSnapshot(manifest(), { knowledge: [{ ...original, evidence: [{ ...original.evidence[0], state: 'matching' }] }] }), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => createGraphSnapshot(manifest(), { knowledge: [{ ...original, observed_at: '2026-02-30' }] }), errorCode('GRAPH_INPUT_INVALID'));
});

test('knowledge refuses foreign bindings, duplicate identities, secrets and absolute evidence references', () => {
  const record = knowledge();
  for (const entry of [{ ...record, node: 'acme/other#api' }, { ...record, notes: ['token=sensitive-credential'] },
    { ...record, notes: [('Read /' + 'Users/sensitive/config')] }, { ...record, evidence: [{ ...record.evidence[0], path: '/etc/sensitive' }] }])
    assert.throws(() => createGraphSnapshot(manifest(), { knowledge: [entry] }), error => /^GRAPH_/u.test(error.code) && !error.message.includes('sensitive'));
  assert.throws(() => createGraphSnapshot(manifest(), { knowledge: [record, record] }), errorCode('GRAPH_KNOWLEDGE_CONFLICT'));
});

test('a consumer can publish a provider claim only through an exact declared target without gaining node ownership', () => {
  const manifestInput = manifest('acme/frontend', { dependencies: [{ from: 'api', to: 'acme/catalog#api', kind: 'calls' }],
    context: { legacy: 'acme/catalog#api', providers: [{ node: 'acme/catalog#api', provider: 'https://catalog.example', environment: 'development', protocol: 'http' }] } });
  const normalized = normalizeGraphManifest(manifestInput);
  assert.equal(normalized.context.legacy, 'acme/catalog#api');
  assert.equal(normalized.context.providers[0].node, 'acme/catalog#api');
  const foreignClaim = createGraphSnapshot(normalized, { at, knowledge: [knowledge('acme/catalog#api', { basis: 'observed', verification: 'client-observation' })] });
  assert.ok(foreignClaim.nodes.every(node => node.repository === 'acme/frontend'));
  assert.equal(foreignClaim.knowledge[0].publisher, 'acme/frontend');
  assert.equal(foreignClaim.knowledge[0].verification, 'external-claim');
  assert.equal(foreignClaim.knowledge[0].basis, 'unknown');
  assert.equal(foreignClaim.knowledge[0].source.verification, 'external-claim');
  const catalog = buildGraphCatalog([snapshot('acme/catalog', {}, { knowledge: [knowledge()] }), foreignClaim]);
  const result = graphNeighborhood(catalog, { node: 'acme/catalog#api', depth: 0, includeForeignClaims: true });
  assert.deepEqual(result.knowledge.map(record => record.publisher), ['acme/catalog']);
  assert.deepEqual(result.foreign_claims.map(record => record.publisher), ['acme/frontend']);
  assert.deepEqual(result.repositories.map(repo => repo.id), ['acme/catalog', 'acme/frontend']);
  assert.deepEqual(catalog.snapshots[1].knowledge, foreignClaim.knowledge);
  const unresolved = graphNeighborhood(buildGraphCatalog([foreignClaim]), { node: 'acme/catalog#api', depth: 0, includeForeignClaims: true });
  assert.equal(unresolved.foreign_claims.length, 1); assert.equal(unresolved.nodes[0].unresolved, true);
  assert.throws(() => createGraphSnapshot(normalized, { knowledge: [knowledge('acme/catalog#other')] }), errorCode('GRAPH_NODE_MISSING'));
  assert.throws(() => createGraphSnapshot(normalized, { knowledge: [knowledge('acme/catalog#api', { publisher: 'acme/catalog' })] }), errorCode('GRAPH_OWNERSHIP_INVALID'));
});

test('catalog loads exact flat snapshots, projects fields and does not read nested files or repository URLs', async t => {
  const dir = temp(t);
  write(dir, 'catalog.json', snapshot('acme/catalog', { repository: { id: 'acme/catalog', name: 'Catalog', url: 'https://unreachable.invalid/catalog' } }));
  write(dir, 'frontend.json', snapshot('acme/frontend', { dependencies: [{ from: 'api', to: 'acme/catalog#api', kind: 'calls' }] }));
  mkdirSync(join(dir, 'nested')); writeFileSync(join(dir, 'nested', 'bad.json'), 'invalid'); writeFileSync(join(dir, 'ignored.txt'), 'invalid');
  const result = await loadGraphCatalog(dir);
  assert.equal(result.repositories.length, 2); assert.equal(result.snapshots.length, 2); assert.equal(result.edges.length, 1);
  assert.equal(result.coverage, 'partial'); assert.deepEqual(result.unresolved, []);
  assert.ok(result.omissions.some(value => typeof value === 'string' && value.includes('other entries')));
  assert.ok(!JSON.stringify(result).includes(dir));
  assert.equal((await loadGraphCatalog(join(dir, 'catalog.json'))).repositories.length, 1);
});

test('duplicate repository snapshots conflict regardless of export date and replacements work by selecting one snapshot', async t => {
  const dir = temp(t), first = snapshot('acme/catalog');
  write(dir, 'old.json', first); write(dir, 'new.json', { ...first, generated_at: '2027-01-01T00:00:00.000Z' });
  await assert.rejects(loadGraphCatalog(dir), errorCode('GRAPH_OWNERSHIP_CONFLICT'));
  assert.throws(() => buildGraphCatalog([first, first]), errorCode('GRAPH_OWNERSHIP_CONFLICT'));
  rmSync(join(dir, 'old.json'));
  assert.equal((await loadGraphCatalog(dir)).repositories[0].generated_at, '2027-01-01T00:00:00.000Z');
});

test('catalog refuses symlinks including ancestor aliases and snapshot links', async t => {
  const dir = temp(t), real = join(dir, 'real'); mkdirSync(real);
  const source = write(real, 'snapshot.json', snapshot('acme/catalog'));
  symlinkSync(real, join(dir, 'alias'), 'dir'); symlinkSync(source, join(dir, 'linked.json'));
  await assert.rejects(loadGraphCatalog(join(dir, 'alias', 'snapshot.json')), errorCode('GRAPH_SYMLINK_REFUSED'));
  await assert.rejects(loadGraphCatalog(join(dir, 'linked.json')), errorCode('GRAPH_SYMLINK_REFUSED'));
  assert.ok((await loadGraphCatalog(dir)).issues.some(issue => issue.code === 'GRAPH_SYMLINK_REFUSED' && issue.file === 'linked.json'));
});

test('catalog rejects oversized files, excessive files and invalid JSON with fixed diagnostics', async t => {
  const dir = temp(t), oversized = join(dir, 'oversized.json');
  writeFileSync(oversized, 'sensitive'.repeat(600000));
  assert.ok((await loadGraphCatalog(oversized)).issues.some(issue => issue.code === 'GRAPH_CATALOG_BOUNDS' && issue.file === 'oversized.json')); rmSync(oversized);
  writeFileSync(join(dir, 'invalid.json'), 'sensitive invalid json');
  assert.ok((await loadGraphCatalog(dir)).issues.some(issue => issue.code === 'GRAPH_CATALOG_INVALID' && issue.file === 'invalid.json')); rmSync(join(dir, 'invalid.json'));
  for (let i = 0; i < 101; i++) writeFileSync(join(dir, `${i}.json`), '{}');
  await assert.rejects(loadGraphCatalog(dir), errorCode('GRAPH_CATALOG_BOUNDS'));
  await assert.rejects(loadGraphCatalog('https://sensitive.invalid/catalog'), errorCode('GRAPH_CATALOG_INVALID'));
});

test('snapshot reads require the portable shape and revalidate ownership instead of trusting claimed edges', () => {
  const value = snapshot('acme/catalog');
  assert.throws(() => buildGraphCatalog([{ ...value, knowledge: undefined }]), error => /^GRAPH_/u.test(error.code));
  assert.throws(() => buildGraphCatalog([{ ...value, nodes: value.nodes.filter(node => node.kind !== 'repository') }]), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => buildGraphCatalog([{ ...value, nodes: value.nodes.map(node => ({ ...node, repository: 'acme/foreign' })) }]), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => buildGraphCatalog([{ ...value, kind: 'other' }]), errorCode('GRAPH_VERSION_UNSUPPORTED'));
});

test('missing provider snapshots remain explicit unresolved nodes and support reverse impact', () => {
  const catalog = buildGraphCatalog([snapshot('acme/frontend', { dependencies: [{ from: 'api', to: 'acme/missing#api', kind: 'calls' }] })]);
  assert.equal(catalog.unresolved[0].id, 'acme/missing#api');
  const view = graphNeighborhood(catalog, { node: 'acme/frontend#api' });
  assert.ok(view.nodes.some(node => node.id === 'acme/missing#api' && node.unresolved));
  assert.deepEqual(view.unresolved, catalog.unresolved);
  const impact = graphImpact(catalog, { node: 'acme/missing#api' });
  assert.equal(impact.paths[0].node, 'acme/frontend#api'); assert.deepEqual(impact.paths[0].edges, [catalog.edges[0].id]);
  assert.equal(impact.callers.count, 1); assert.equal(impact.coverage, 'partial');
  const limited = graphImpact(catalog, { node: 'acme/missing#api', maxNodes: 1 });
  assert.deepEqual(limited.unresolved, [{ id: 'acme/missing#api', referenced_by: [], omitted_references: 1 }]);
});

test('repository neighborhood seeds owned nodes and scoped knowledge without fabricating ownership edges', () => {
  const catalog = buildGraphCatalog([snapshot('acme/catalog', {}, { knowledge: [knowledge()] }),
    snapshot('acme/frontend', { dependencies: [{ from: 'api', to: 'acme/catalog#api', kind: 'calls' }] }), snapshot('acme/unrelated')]);
  const view = graphNeighborhood(catalog, { node: 'acme/catalog#repo' });
  assert.deepEqual(new Set(view.nodes.map(node => node.id)), new Set(['acme/catalog#repo', 'acme/catalog#api', 'acme/frontend#api']));
  assert.equal(view.knowledge.length, 1); assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].kind, 'calls'); assert.equal(view.paths[0].seed, 'acme/catalog#api');
  assert.deepEqual(view.paths[0].nodes, ['acme/catalog#api', 'acme/frontend#api']);
  assert.equal(view.repositories.length, 2); assert.deepEqual(view.callers.repositories, ['acme/frontend']);
});

test('reverse impact follows actual declared paths across repos and local components while terminating cycles', () => {
  const frontend = snapshot('acme/frontend', { nodes: [{ id: 'page', kind: 'component', name: 'Page' }, { id: 'cart', kind: 'component', name: 'Cart' }], dependencies: [
    { from: 'cart', to: 'acme/catalog#api', kind: 'calls' }, { from: 'page', to: 'acme/frontend#cart', kind: 'imports' },
    { from: 'cart', to: 'acme/frontend#page', kind: 'imports' }] });
  const catalog = buildGraphCatalog([snapshot('acme/catalog'), frontend, snapshot('acme/shell', { dependencies: [{ from: 'api', to: 'acme/frontend#page', kind: 'depends_on' }] })]);
  const result = graphImpact(catalog, { node: 'acme/catalog#api' });
  const path = result.paths.find(path => path.node === 'acme/shell#api');
  assert.deepEqual(path.nodes, ['acme/catalog#api', 'acme/frontend#cart', 'acme/frontend#page', 'acme/shell#api']);
  assert.equal(path.edges.length, 3); assert.equal(result.nodes.length, 4);
  for (let i = 0; i < path.edges.length; i++) {
    const edge = result.edges.find(edge => edge.id === path.edges[i]);
    assert.equal(edge.to, path.nodes[i]); assert.equal(edge.from, path.nodes[i + 1]); assert.equal(edge.basis, 'declared');
  }
  assert.match(result.meaning, /potential impact/u); assert.match(result.meaning, /not proof/u);
  assert.deepEqual(result.callers.repositories, ['acme/frontend']);
});

test('bounded neighborhood and impact expose truncation and never turn absent callers into complete coverage', () => {
  const catalog = buildGraphCatalog([snapshot('acme/catalog'), snapshot('acme/frontend', { dependencies: [{ from: 'api', to: 'acme/catalog#api', kind: 'calls' }] })]);
  const only = graphNeighborhood(catalog, { node: 'acme/catalog#repo', maxNodes: 1 });
  assert.equal(only.nodes.length, 1); assert.equal(only.truncated.max_nodes, true); assert.equal(only.callers.count, 1);
  assert.equal(graphNeighborhood(catalog, { node: 'acme/catalog#api', depth: 0 }).nodes.length, 1);
  assert.equal(graphImpact(catalog, { node: 'acme/catalog#api', maxNodes: 1 }).truncated.max_nodes, true);
  const emptyCallers = graphImpact(catalog, { node: 'acme/frontend#api' });
  assert.equal(emptyCallers.callers.count, 0); assert.equal(emptyCallers.callers.coverage, 'partial');
  assert.match(emptyCallers.callers.meaning, /unknown/u);
  assert.throws(() => graphNeighborhood(catalog, { node: 'acme/catalog#api', depth: 11 }), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => graphImpact(catalog, { node: 'acme/catalog#api', maxNodes: 501 }), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => graphImpact(catalog, { node: 'acme/absent#api' }), errorCode('GRAPH_NODE_NOT_FOUND'));
  assert.throws(() => graphImpact(catalog, null), errorCode('GRAPH_INPUT_INVALID'));
  assert.throws(() => graphNeighborhood({ ...catalog, nodes: [null] }, { node: 'acme/catalog#api' }), errorCode('GRAPH_INPUT_INVALID'));
});

test('edge and knowledge query limits preserve supporting paths and report omitted facts', () => {
  const nodes = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, kind: 'component', name: `Node ${i}` }));
  const dependencies = nodes.flatMap(a => nodes.filter(b => a.id !== b.id).map(b => ({ from: a.id, to: `acme/dense#${b.id}`, kind: 'imports' })));
  const records = Array.from({ length: 250 }, (_, i) => knowledge('acme/dense#n0', { id: `sha256:${i.toString(16).padStart(64, '0')}` }));
  const catalog = buildGraphCatalog([snapshot('acme/dense', { nodes, dependencies }, { knowledge: records })]);
  const view = graphNeighborhood(catalog, { node: 'acme/dense#n0', maxNodes: 100 });
  assert.equal(view.edges.length, 2000); assert.equal(view.truncated.max_edges, true);
  assert.equal(view.knowledge.length, 200); assert.equal(view.truncated.knowledge, true);
  const kept = new Set(view.edges.map(edge => edge.id));
  assert.ok(view.paths.every(path => path.edges.every(id => kept.has(id))));
});

test('an empty catalog remains a partial inventory with an explicit issue', async t => {
  const value = await loadGraphCatalog(temp(t));
  assert.equal(value.coverage, 'partial'); assert.equal(value.repositories.length, 0);
  assert.equal(value.issues[0].code, 'GRAPH_CATALOG_EMPTY');
});
