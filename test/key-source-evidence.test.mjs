// MAP-1C capture-time linking over synthetic private evidence: the window of
// newest earlier runs, the per-file size bound, the time budget, read problems
// and scope. Evidence files are fixtures built here; nothing leaves the temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkCapturedRun } from '../lib/key-source-evidence.mjs';
import { KEY_SOURCE_BOUNDS } from '../lib/key-sources.mjs';
import { captureOperationContext as captureRaw, operationId, queryOperationContext as queryRaw, recordKeySources as keysRaw } from '../lib/operation-context.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { readFileSync, statSync } from 'node:fs';

import { createFixtureStack, fixtureContextFile, inFixtureStack } from './helpers/stack-fixture.mjs';
const captureOperationContext = (root, ...args) => inFixtureStack(root, () => captureRaw(root, ...args));
const queryOperationContext = (root, ...args) => inFixtureStack(root, () => queryRaw(root, ...args));
const recordKeySources = (root, ...args) => inFixtureStack(root, () => keysRaw(root, ...args));

const provider = 'http://127.0.0.1:4100';
const contractDigest = `sha256:${'c'.repeat(64)}`;
const identity = { v: 1, stack: 'fixture', provider, environment: 'local', protocol: 'http', operation: 'GET /things/{id}',
  endpoint: `${provider}/things/{id}`, contractDigest };
const VALUE = 'thing-MKR-41a7c9';
const second = n => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 1000).toISOString();

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-evidence-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'evidence');
  mkdirSync(dir);
  const write = (id, { at, operation = 'GET /things', status = 200, url = `${provider}/things`, body = {},
    environment = 'local', origin = provider, transport = 'api_request:http', request = {} } = {}) => {
    const file = join(dir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ runId: id, origin: { v: 1, initiator: 'cli.request', transport, observed_at: second(at),
      scope: { operation, protocol: 'http', environment, provider: origin, contract_digest: contractDigest } },
      request: { method: operation.split(' ')[0], url, headers: {}, body: null, ...request },
      response: { status, headers: {}, body } }));
    utimesSync(file, new Date(second(at)), new Date(second(at)));
    return file;
  };
  // The run being captured: the newest, a 2xx detail request for VALUE.
  const current = (at = 10_000) => write('run-current', { at, operation: 'GET /things/{id}', url: `${provider}/things/${VALUE}`,
    body: { id: VALUE } });
  const link = (options = {}) => linkCapturedRun({ evidenceDir: dir, runId: 'run-current', identity, ...options });
  return { root, dir, write, current, link };
}

test('MAP-1C the window is the newest 64 earlier runs in the same provider and environment', t => {
  const f = scratch(t);
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  for (let index = 0; index < KEY_SOURCE_BOUNDS.windowRuns - 1; index++) f.write(`run-filler-${index}`, { at: 100 + index, body: { data: [{ id: `other-${index}0000` }] } });
  // Runs outside the provider/environment scope never take a window slot.
  for (let index = 0; index < 5; index++) f.write(`run-staging-${index}`, { at: 500 + index, environment: 'staging', body: { data: [] } });
  f.current();
  const inside = f.link();
  assert.equal(inside.state, 'linked');
  assert.deepEqual(inside.links.map(item => [item.param, item.location, item.source.operation, item.source.field, item.evidence.run_id]),
    [['id', 'path', 'GET /things', 'data[].id', 'run-source']]);
  assert.equal(inside.links[0].first_observed_at, second(10_000));
  f.write('run-filler-last', { at: 300, body: { data: [] } });
  const outside = f.link();
  assert.equal(outside.state, 'no-source', 'a 65th earlier run pushes the oldest source out of the window');
  assert.deepEqual(outside.links, []);
});

test('MAP-1C evidence files over 2 MiB are skipped, neither searched nor counted as a problem', t => {
  const f = scratch(t);
  const padding = 'p'.repeat(KEY_SOURCE_BOUNDS.maxEvidenceBytes);
  f.write('run-large', { at: 5, body: { data: [{ id: VALUE }], padding } });
  f.current();
  assert.equal(f.link().state, 'no-source', 'the only response holding the value was over the size bound');
  f.write('run-small', { at: 6, body: { data: [{ id: VALUE }] } });
  const linked = f.link();
  assert.equal(linked.state, 'linked');
  assert.equal(linked.links[0].evidence.run_id, 'run-small');
  // The run being captured is held to the same bound: an oversized one links nothing.
  f.write('run-current', { at: 10_000, operation: 'GET /things/{id}', url: `${provider}/things/${VALUE}`, body: { id: VALUE, padding } });
  assert.equal(f.link().state, 'evidence-oversized');
});

test('MAP-1C over the time budget, linking records nothing and never throws', t => {
  const f = scratch(t);
  for (let index = 0; index < 20; index++) f.write(`run-list-${index}`, { at: index + 1, body: { data: [{ id: VALUE }] } });
  f.current();
  assert.equal(f.link().state, 'linked');
  let now = 0;
  const slow = f.link({ clock: () => (now += 40) });
  assert.deepEqual(slow, { state: 'over-budget', links: [] }, `${KEY_SOURCE_BOUNDS.budgetMs} ms budget`);
  // A large body is checked inside the walk as well, not only between files.
  f.write('run-big', { at: 50, body: { rows: Array.from({ length: 20000 }, (_, index) => ({ id: `row-${index}9000` })) } });
  let tick = 0;
  assert.equal(f.link({ clock: () => (tick++ > 3 ? 1e9 : 0) }).state, 'over-budget');
});

test('MAP-1C any evidence read problem in the window records nothing for that request', t => {
  const f = scratch(t);
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  f.current();
  assert.equal(f.link().state, 'linked');
  const broken = join(f.dir, 'run-broken.json');
  writeFileSync(broken, '{"runId": "run-broken", "origin": ');
  utimesSync(broken, new Date(second(500)), new Date(second(500)));
  assert.deepEqual(f.link(), { state: 'evidence-read-problem', links: [] });
  rmSync(broken);
  const outside = join(f.root, 'outside.json');
  writeFileSync(outside, '{}');
  symlinkSync(outside, join(f.dir, 'run-linked.json'));
  lutimesSync(join(f.dir, 'run-linked.json'), new Date(second(500)), new Date(second(500)));
  assert.deepEqual(f.link(), { state: 'evidence-read-problem', links: [] }, 'a symlinked run file is never followed');
  rmSync(join(f.dir, 'run-linked.json'));
  linkSync(join(f.dir, 'run-source.json'), join(f.root, 'second-name.json'));
  assert.deepEqual(f.link(), { state: 'evidence-read-problem', links: [] }, 'a hard-linked run file is refused');
  rmSync(join(f.root, 'second-name.json'));
  assert.equal(f.link().state, 'linked');
  // A file newer than the captured run (another request still writing) cannot
  // be an earlier run: it is skipped unread and blocks nothing.
  const writing = join(f.dir, 'run-concurrent.json');
  writeFileSync(writing, '{"runId": "run-concur');
  utimesSync(writing, new Date(second(20_000)), new Date(second(20_000)));
  assert.equal(f.link().state, 'linked');
  rmSync(writing);
  // Malformed inputs never throw.
  for (const options of [{ runId: '../escape' }, { identity: null }, { identity: { ...identity, protocol: 'graphql' } },
    { evidenceDir: join(f.root, 'outside.json') }, { evidenceDir: join(f.root, 'missing') }, { evidenceDir: 42 }])
    assert.deepEqual(f.link(options).links, [], JSON.stringify(options));
});

test('MAP-1C only earlier 2xx runs in scope are sources; later runs, other scopes and echoes are not', t => {
  const f = scratch(t);
  f.write('run-later', { at: 20_000, body: { data: [{ id: VALUE }] } });
  f.write('run-other-env', { at: 2, environment: 'staging', body: { data: [{ id: VALUE }] } });
  f.write('run-other-provider', { at: 3, origin: 'http://127.0.0.1:4200', body: { data: [{ id: VALUE }] } });
  f.write('run-error', { at: 4, status: 500, body: { data: [{ id: VALUE }] } });
  f.write('run-echo', { at: 5, operation: 'GET /things/{id}', url: `${provider}/things/${VALUE}`, body: { id: VALUE } });
  f.write('run-graphql', { at: 6, transport: 'api_request:graphql', body: { data: [{ id: VALUE }] } });
  f.current();
  assert.equal(f.link().state, 'no-source');
  f.write('run-list', { at: 7, body: { data: [{ id: VALUE }] } });
  f.write('run-page', { at: 8, url: `${provider}/things?page=2`, body: { data: [{ id: VALUE }] } });
  const linked = f.link();
  assert.equal(linked.links[0].evidence.run_id, 'run-list', 'the earliest qualifying response');
  assert.equal(linked.links[0].also_seen, 0, 'the second page holds the same (operation, field) pair');
  // A non-2xx request is not linked at all.
  f.write('run-current', { at: 10_000, operation: 'GET /things/{id}', status: 404, url: `${provider}/things/${VALUE}`, body: {} });
  assert.equal(f.link().state, 'no-keys');
});

test('MAP-1C linking results and states never carry a value', t => {
  const f = scratch(t);
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE, label: 'PLANTED-LABEL-MKR' }] } });
  f.current();
  const results = [f.link(), f.link({ clock: (() => { let now = 0; return () => (now += 200); })() })];
  writeFileSync(join(f.dir, 'run-broken.json'), 'not json');
  results.push(f.link());
  for (const result of results) assert.doesNotMatch(JSON.stringify(result), /MKR/);
});

test('MAP-1C key_sources persist on the record: capture merges them in its own write, older records stay valid, unchanged links are not rewritten', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFixtureStack(root, { baseUrl: provider });
  const env = { [HOME_ENV_NAME]: join(root, 'isolated-registry') };
  const id = operationId(identity);
  const observed = { identity, source: { tool: 'api_request:http' }, basis: 'observed', outcome: 'success', complete: true, status: 200 };
  const entry = () => queryOperationContext(root, { operation: identity.operation }, { env }).operations[0];
  const linkAt = (n, overrides = {}) => ({ param: 'id', location: 'path', source: { operation: 'GET /things', field: 'data[].id' },
    first_observed_at: second(n), last_observed_at: second(n), also_seen: 0,
    evidence: { run_id: `run-source-${n}`, digest: `sha256:${'d'.repeat(64)}` }, ...overrides });

  // A record written before the field existed is valid and projects without it.
  captureOperationContext(root, observed, { internal: true });
  assert.equal(Object.hasOwn(entry(), 'key_sources'), false);
  // Capture-time links land in the same write as their observation.
  captureOperationContext(root, observed, { internal: true, keySources: [linkAt(1)] });
  assert.equal(entry().observations.length, 2);
  assert.deepEqual(entry().key_sources, [linkAt(1)]);
  // External captures cannot supply links, by option or by JSON input.
  captureOperationContext(root, { ...observed, key_sources: [linkAt(2)] }, { keySources: [linkAt(2)] });
  assert.deepEqual(entry().key_sources, [linkAt(1)]);
  assert.equal(entry().observations.length, 3);
  // A link that fails validation never costs the observation it rode with.
  captureOperationContext(root, observed, { internal: true, keySources: [linkAt(3, { source: { operation: 'GET /things', field: 'data[].sk_live_abcdefghijklmnop' } })] });
  assert.equal(entry().observations.length, 4);
  assert.deepEqual(entry().key_sources, [linkAt(1)]);
  // Recording links that are already present does not rewrite the file.
  const inode = statSync(fixtureContextFile(root)).ino, bytes = readFileSync(fixtureContextFile(root), 'utf8');
  assert.deepEqual(recordKeySources(root, new Map([[id, [linkAt(1)]]])), { changed: [], replaced_damaged: [] });
  assert.equal(statSync(fixtureContextFile(root)).ino, inode);
  assert.equal(readFileSync(fixtureContextFile(root), 'utf8'), bytes);
  assert.deepEqual(recordKeySources(root, new Map([[id, [linkAt(4)]]])), { changed: [id], replaced_damaged: [] });
  assert.equal(entry().key_sources[0].first_observed_at, second(1));
  assert.equal(entry().key_sources[0].last_observed_at, second(4));
  // Damaged stored links are derived data, never store damage: the links are
  // absent, the record is named, observations and writes stay available, and
  // the next merge replaces the list instead of merging into it.
  const damage = value => {
    const ctx = JSON.parse(readFileSync(fixtureContextFile(root), 'utf8'));
    ctx.api_context.operations[id].key_sources = value;
    writeFileSync(fixtureContextFile(root), JSON.stringify(ctx));
  };
  damage([{ ...linkAt(5), location: 'header' }]);
  const queried = queryOperationContext(root, {}, { env });
  assert.deepEqual(queried.issues, []);
  assert.deepEqual(queried.record_issues, [{ repository: 'local', operation_id: id, code: 'KEY_SOURCES_INVALID' }]);
  assert.equal(queried.operations[0].observations.length, 4);
  assert.equal(Object.hasOwn(queried.operations[0], 'key_sources'), false);
  // A capture that derived no links is recorded and leaves the list for a merge to replace.
  captureOperationContext(root, observed, { internal: true });
  assert.equal(entry().observations.length, 5);
  assert.deepEqual(recordKeySources(root, new Map([[id, [linkAt(6)]]])), { changed: [id], replaced_damaged: [id] });
  assert.deepEqual(entry().key_sources, [linkAt(6)], 'replaced, not merged with the damaged entries');
  damage('not-an-array');
  captureOperationContext(root, observed, { internal: true, keySources: [linkAt(7)] });
  assert.deepEqual(entry().key_sources, [linkAt(7)], 'a capture with links replaces a damaged list');
  assert.equal(entry().observations.length, 6);
  // With nothing derived for the record, the damaged list is removed.
  damage(null);
  assert.deepEqual(recordKeySources(root, new Map()), { changed: [id], replaced_damaged: [id] });
  assert.equal(Object.hasOwn(entry(), 'key_sources'), false);
  assert.equal(queryOperationContext(root, {}, { env }).record_issues, undefined);
});

// MAP-1 F1 (fix round 3) reserves room for record_issues: a record that sits
// near the budget no longer trims its record's issue out. This test was
// "a damaged key_sources list never costs an observation its place in a
// bounded query", which pinned the opposite at 10 bytes to spare.
test('MAP-1C a damaged key_sources list is named in every bounded query: the record keeps its place when its issue fits beside it, and a record near the budget never trims its issue out', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-budget-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFixtureStack(root, { baseUrl: provider });
  const env = { [HOME_ENV_NAME]: join(root, 'isolated-registry') };
  const id = operationId(identity);
  captureOperationContext(root, { identity, source: { tool: 'api_request:http' }, basis: 'observed', outcome: 'success',
    complete: true, status: 200 }, { internal: true });
  const clean = queryOperationContext(root, {}, { env });
  const size = Buffer.byteLength(JSON.stringify(clean));
  const ctx = JSON.parse(readFileSync(fixtureContextFile(root), 'utf8'));
  ctx.api_context.operations[id].key_sources = 'not-an-array';
  writeFileSync(fixtureContextFile(root), JSON.stringify(ctx));
  const issue = { repository: 'local', operation_id: id, code: 'KEY_SOURCES_INVALID' };
  const reserve = Buffer.byteLength(`,"record_issues":${JSON.stringify([issue])}`);
  // With exactly the room for the record and its issue, both are returned.
  const exact = queryOperationContext(root, {}, { env, maxBytes: size + reserve });
  assert.deepEqual(exact.operations, clean.operations);
  assert.deepEqual(exact.record_issues, [issue]);
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), size + reserve);
  // Room for the record but not for its issue (one byte short, or 10 bytes to
  // spare): the issue is never trimmed out. The record, which has no
  // key_sources left to give up, is left out and counted.
  for (const maxBytes of [size + reserve - 1, size + 10]) {
    const near = queryOperationContext(root, {}, { env, maxBytes });
    assert.deepEqual(near.record_issues, [issue], `${maxBytes}: the record is named`);
    assert.deepEqual([near.operations.length, near.omissions.operations], [0, 1], `${maxBytes}: the record is left out and counted`);
    assert.ok(Buffer.byteLength(JSON.stringify(near)) <= maxBytes);
  }
  // With room, the record is named, within the bound.
  const roomy = queryOperationContext(root, {}, { env, maxBytes: size + 200 });
  assert.deepEqual(roomy.operations, clean.operations);
  assert.deepEqual(roomy.record_issues, [issue]);
  assert.ok(Buffer.byteLength(JSON.stringify(roomy)) <= size + 200);
});

test('MAP-1C API_CONTEXT_OFF=1 disables linking before any evidence is touched', t => {
  const f = scratch(t);
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  f.current();
  // A regular file as the evidence root would be refused if it were opened.
  assert.deepEqual(f.link({ env: { API_CONTEXT_OFF: '1' }, evidenceDir: join(f.dir, 'run-source.json') }),
    { state: 'disabled', links: [] });
  assert.equal(f.link({ evidenceDir: join(f.dir, 'run-source.json') }).state, 'evidence-read-problem');
});
