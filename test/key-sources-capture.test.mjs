// MAP-1C acceptance through the real client and CLI against a loopback server:
// a list endpoint returns ids, a detail endpoint takes one in its path, and the
// detail operation's record learns which response field supplied the key. All
// data is synthetic; marker values must never reach the store or any output
// except the API response the agent asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
// Namespace imports, so a missing export fails its own test rather than the file.
import * as keySources from '../lib/key-sources.mjs';
import * as operationContext from '../lib/operation-context.mjs';
// The 19 damaged forms are shared with the API map's rendering test.
import { storedLink, DAMAGED_FORMS, DAMAGED_TEXT } from './fixtures/key-sources/damaged-forms.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const client = new URL('../lib/client.mjs', import.meta.url).href;

// Synthetic markers. Each is an eligible key value or a payload value that must
// stay in private evidence and the agent's own response.
const ID = 'thing-MKR-9a1f02', ID2 = 'thing-MKR-9a1f03', DYN = 'dyn-MKR-77c1e4', TZ = 'MKR/Lisbon-zone';
const NAME = 'PLANTED-NAME-MKR', TOKEN = 'sk_live_MKRabcdefghijklmn', UUID_KEY = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
const MARKERS = [ID, ID2, DYN, TZ, NAME, TOKEN, 'MKR'];
const DETAIL = 'GET /things/{id}';

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-capture-')));
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    const url = new URL(req.url, 'http://fixture.invalid');
    const segments = url.pathname.split('/').filter(Boolean);
    let body;
    if (url.pathname === '/things') body = { data: [
      { id: ID, created_at: '2026-10-05T00:00:00Z', active: true, code: 'ab', small: 999, ref: '0999', day: '2026-10-05',
        timezone: TZ, region: TZ, token: TOKEN, label: NAME },
      { id: ID2 },
    ], byId: { [UUID_KEY]: { id: DYN } }, total: 2 };
    else if (url.pathname === '/others') body = { items: [{ thing_ref: ID }] };
    else if (segments[0] === 'things' && segments.length === 2) body = { id: decodeURIComponent(segments[1]), name: NAME };
    else if (url.pathname === '/zones') body = { zone: 'ok' };
    else if (segments[0] === 'reports') body = { report: 'ok' };
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const provider = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Things', version: '1' }, paths: {
    '/things': { get: {} }, '/others': { get: {} }, '/things/{id}': { get: {} },
    '/zones': { get: { parameters: [{ name: 'timezone', in: 'query' }] } }, '/reports/{day}': { get: {} },
  } }));
  createFixtureStack(root, { baseUrl: provider, contract: 'openapi.json' });
  const evidenceDir = join(root, fixtureEvidencePath()), readLog = join(root, 'evidence-reads.log');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_|MAP1C_)/.test(key)) delete env[key];
  Object.assign(env, { SANNR_HOME: join(root, 'isolated-home'), API_CONTEXT_DIR: root,
    API_EVIDENCE: evidenceDir,
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_BUDGET: '4000', API_FRICTION_OFF: '1',
    MAP1C_EVIDENCE_DIR: evidenceDir, MAP1C_READ_LOG: readLog });
  // Counts reads of evidence run files and listings of the evidence directory.
  // Evidence writes (the client recording its own run) are not counted.
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const dir = process.env.MAP1C_EVIDENCE_DIR, log = process.env.MAP1C_READ_LOG, append = fs.appendFileSync;
    const run = p => typeof p === 'string' && (p.startsWith(dir + '/') || p.startsWith(dir + '\\\\')) && /run-[^\\\\/]*\\.json$/.test(p);
    const { readdirSync, openSync, readFileSync } = fs;
    fs.readdirSync = function (p, ...rest) { if (String(p) === dir) append(log, 'list\\n'); return readdirSync.call(this, p, ...rest); };
    fs.openSync = function (p, flags, ...rest) {
      const writing = typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : /[wa+]/.test(String(flags ?? 'r'));
      if (run(String(p)) && !writing) append(log, 'open\\n');
      return openSync.call(this, p, flags, ...rest); };
    fs.readFileSync = function (p, ...rest) { if (run(String(p))) append(log, 'read\\n'); return readFileSync.call(this, p, ...rest); };
    syncBuiltinESMExports();`;
  const counted = ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
  const options = overrides => ({ cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  const outputs = [];
  const command = async (args, overrides = {}) => {
    try {
      const result = await execute(process.execPath, [...counted, cli, ...args], options(overrides));
      outputs.push(result.stdout, result.stderr);
      return { ...result, code: 0 };
    } catch (error) {
      outputs.push(error.stdout ?? '', error.stderr ?? '');
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
    }
  };
  await command(['init']);
  const request = async (args, overrides = {}) => {
    const result = await execute(process.execPath, [...counted, '--input-type=module', '-e',
      `const { apiRequest } = await import(${JSON.stringify(client)}); process.stdout.write(JSON.stringify(await apiRequest(${JSON.stringify(args)})));`],
    options(overrides));
    // The response body belongs to the agent that asked for it; diagnostics do not.
    outputs.push(result.stderr);
    return JSON.parse(result.stdout);
  };
  const storeText = () => readFileSync(fixtureContextFile(root), 'utf8');
  const store = () => JSON.parse(storeText());
  const record = operation => Object.values(store().api_context?.operations ?? {}).find(entry => entry.identity.operation === operation);
  const evidenceFile = runId => join(evidenceDir, `${runId}.json`);
  const reads = () => existsSync(readLog) ? readFileSync(readLog, 'utf8').split('\n').filter(Boolean).length : 0;
  const sweep = (label, text) => { for (const marker of MARKERS) assert.ok(!text.includes(marker), `${label} must not contain ${marker}`); };
  return { root, provider, evidenceDir, command, request, storeText, store, record, evidenceFile, reads, sweep, outputs,
    requests: () => requests };
}

test('MAP-1C list then detail through the real client records the detail key source on the detail record', async t => {
  const f = await fixture(t);
  const list = await f.request({ path: '/things' });
  const detail = await f.request({ path: `/things/${ID}` });
  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(detail.context_capture.state, 'captured');
  const listEvidence = readFileSync(f.evidenceFile(list.evidence));
  const detailOrigin = JSON.parse(readFileSync(f.evidenceFile(detail.evidence), 'utf8')).origin;
  assert.deepEqual(f.record(DETAIL).key_sources, [{
    param: 'id', location: 'path', source: { operation: 'GET /things', field: 'data[].id' },
    first_observed_at: detailOrigin.observed_at, last_observed_at: detailOrigin.observed_at, also_seen: 0,
    evidence: { run_id: list.evidence, digest: `sha256:${createHash('sha256').update(listEvidence).digest('hex')}` },
  }]);
  assert.equal(f.record('GET /things').key_sources, undefined, 'a route without parameters records no key sources');
  // Readers see the field: show --json and context query return it from the store.
  const shown = JSON.parse((await f.command(['show', DETAIL])).stdout);
  assert.deepEqual(shown.scoped.operations[0].key_sources, f.record(DETAIL).key_sources);
  writeFileSync(join(f.root, 'query.json'), JSON.stringify({ operation: DETAIL }));
  const queried = JSON.parse((await f.command(['context', 'query', 'query.json'])).stdout);
  assert.deepEqual(queried.operations[0].key_sources, f.record(DETAIL).key_sources);
  f.sweep('store', f.storeText());
  f.sweep('command output', f.outputs.join('\n'));
});

test('MAP-1C also_seen counts other fields that held the value; dynamic object keys are recorded as {}', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: '/others' });
  await f.request({ path: `/things/${ID}` });
  await f.request({ path: `/things/${DYN}` });
  const sources = f.record(DETAIL).key_sources;
  assert.deepEqual(sources.map(item => [item.param, item.source.operation, item.source.field, item.also_seen]).sort(), [
    ['id', 'GET /things', 'byId.{}.id', 0],
    ['id', 'GET /things', 'data[].id', 1],
  ]);
  assert.ok(!JSON.stringify(sources).includes(UUID_KEY), 'the dynamic key itself is not recorded');
  f.sweep('store key sources', JSON.stringify(sources));
});

test('MAP-1C query parameters link only to a field whose last name equals the parameter name', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: '/zones', params: { timezone: TZ } });
  await f.request({ path: '/zones', params: { zone: TZ } });
  assert.deepEqual(f.record('GET /zones').key_sources.map(item => [item.param, item.location, item.source.field, item.also_seen]),
    [['timezone', 'query', 'data[].timezone', 0]], 'region held the value too, but its last name differs; zone matched no field');
  f.sweep('store', f.storeText());
});

test('MAP-1C ineligible values never link: dates, booleans, short strings, small integers, secret-shaped values', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  for (const path of ['/things/999', '/things/0999', '/things/true', '/things/ab', `/things/${encodeURIComponent('2026-10-05T00:00:00Z')}`,
    '/reports/2026-10-05'])
    assert.equal((await f.request({ path })).status, 200);
  await f.request({ path: '/zones', params: { timezone: TOKEN } });
  for (const operation of [DETAIL, 'GET /reports/{day}', 'GET /zones']) assert.equal(f.record(operation)?.key_sources, undefined, operation);
  // Positive control: an eligible key on the same record links, and only it.
  // Had any value above linked (999 → data[].small, the date → data[].day,
  // true → data[].active), the parameter would carry a second source here.
  await f.request({ path: `/things/${ID}` });
  assert.deepEqual(f.record(DETAIL).key_sources.map(item => [item.param, item.source.field]), [['id', 'data[].id']]);
  assert.equal(f.record('GET /reports/{day}').key_sources, undefined);
  f.sweep('store', f.storeText());
});

test('MAP-1C an evidence read problem records no links and never fails the request; the backfill links once it is gone', async t => {
  const f = await fixture(t);
  const list = await f.request({ path: '/things' });
  const broken = join(f.evidenceDir, 'run-broken.json');
  writeFileSync(broken, '{"runId":');
  const now = new Date();
  utimesSync(broken, now, now);
  const detail = await f.request({ path: `/things/${ID}` });
  assert.equal(detail.ok, true);
  assert.equal(detail.context_capture.state, 'captured', 'the observation is still recorded');
  assert.equal(f.record(DETAIL).key_sources, undefined);
  const blocked = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(blocked.runs.blocked_by_read_problems, 1);
  assert.equal(blocked.evidence.unreadable, 1);
  assert.equal(f.record(DETAIL).key_sources, undefined);
  rmSync(broken);
  const recorded = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(recorded.state, 'recorded');
  assert.equal(f.record(DETAIL).key_sources[0].evidence.run_id, list.evidence);
  f.sweep('command output', f.outputs.join('\n'));
});

test('MAP-1C context keys backfills from existing evidence: dry run is names only, the write is idempotent, no requests run', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: '/others' });
  await f.request({ path: `/things/${ID}` });
  await f.request({ path: '/zones', params: { timezone: TZ } });
  const captured = { detail: f.record(DETAIL).key_sources, zones: f.record('GET /zones').key_sources };
  // A store recorded before key sources existed: the same captures without the field.
  const stripped = f.store();
  for (const entry of Object.values(stripped.api_context.operations)) delete entry.key_sources;
  writeFileSync(fixtureContextFile(f.root), `${JSON.stringify(stripped, null, 2)}\n`);
  const before = f.storeText(), requests = f.requests();

  const dry = await f.command(['context', 'keys', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /dry run; nothing written; no requests executed/);
  assert.match(dry.stdout, /id \(path\) ← GET \/things data\[\]\.id · also seen 1/);
  assert.match(dry.stdout, /timezone \(query\) ← GET \/things data\[\]\.timezone/);
  assert.match(dry.stdout, /2 operation record\(s\) would change/);
  const dryJson = JSON.parse((await f.command(['context', 'keys', '--dry-run', '--json'])).stdout);
  assert.equal(dryJson.state, 'would-change');
  assert.equal(dryJson.requests_executed, 0);
  assert.deepEqual(dryJson.operations.find(item => item.operation === DETAIL).key_sources, captured.detail);
  assert.equal(f.storeText(), before, 'a dry run writes nothing');

  const written = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(written.state, 'recorded');
  assert.equal(written.changed_operations, 2);
  assert.deepEqual(f.record(DETAIL).key_sources, captured.detail, 'the backfill derives the same links capture recorded');
  assert.deepEqual(f.record('GET /zones').key_sources, captured.zones);
  const after = f.storeText(), identity = statSync(fixtureContextFile(f.root)).ino;
  const again = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(again.state, 'unchanged');
  assert.equal(again.changed_operations, 0);
  assert.equal(f.storeText(), after, 'a second backfill leaves the store byte-identical');
  assert.equal(statSync(fixtureContextFile(f.root)).ino, identity, 'and does not rewrite it');
  assert.equal(f.requests(), requests, 'the backfill executed no requests');
  f.sweep('store', f.storeText());
  f.sweep('command output', f.outputs.join('\n'));
});

test('MAP-1C a damaged store is refused by the backfill and by capture-time validation, with value-free errors', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: `/things/${ID}` });
  const damaged = f.store();
  const entry = Object.values(damaged.api_context.operations).find(item => item.identity.operation === DETAIL);
  // Store damage outside key_sources (a damaged key_sources list is derived
  // data and never refuses the store; see the replacement test below). The
  // damaged value is a marker, so no refusal may echo it.
  entry.observations[0].recorded_at = NAME;
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(damaged));
  const before = f.storeText();
  for (const args of [['context', 'keys'], ['context', 'keys', '--dry-run', '--json']]) {
    const refused = await f.command(args);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /CONTEXT_INVALID/);
  }
  assert.equal(f.storeText(), before, 'the damaged store is preserved');
  const response = await f.request({ path: `/things/${ID2}` });
  assert.equal(response.status, 200, 'a damaged store never fails the request');
  assert.equal(response.context_capture.state, 'failed');
  assert.equal((await f.command(['context', 'keys', '--force'])).code, 1, 'unknown flags are refused');
  // The planted field above is the only marker in the damaged file; outputs stay clean.
  f.sweep('command output', f.outputs.join('\n'));
});


test('MAP-1C stored key_sources are validated: names only, bounded, well-formed or the entry is damaged', async t => {
  const { storedKeySources, projectKeySources } = keySources;
  assert.equal(typeof projectKeySources, 'function', 'lib/key-sources.mjs exports the reader projection');
  assert.deepEqual(storedKeySources([storedLink()]), [storedLink()]);
  assert.deepEqual(storedKeySources([{ ...storedLink(), unknown: 'ignored' }]), [storedLink()], 'only the schema is projected');
  assert.deepEqual(projectKeySources({ key_sources: [storedLink()] }), { state: 'valid', key_sources: [storedLink()] });
  assert.deepEqual(projectKeySources({}), { state: 'absent' }, 'older records omit the field');
  assert.equal(DAMAGED_FORMS.length, 19);
  // The record issue's code is a named public diagnostic.
  const { contextCommandError } = await import('../lib/context-errors.mjs');
  assert.equal(contextCommandError({ code: 'KEY_SOURCES_INVALID' }).code, 'KEY_SOURCES_INVALID');

  // A real record, observed through the client, with its key sources.
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: `/things/${ID}` });
  const clean = f.store();
  const [operationId, record] = Object.entries(clean.api_context.operations).find(([, entry]) => entry.identity.operation === DETAIL);
  assert.ok(record.key_sources.length, 'positive control: the record has links');
  const observationIds = record.observations.map(item => item.id);
  const shownClean = JSON.parse((await f.command(['show', DETAIL])).stdout);
  assert.equal(shownClean.observation_summary.state, 'observed');
  const env = { [HOME_ENV_NAME]: join(f.root, 'isolated-home') };

  for (const value of DAMAGED_FORMS) {
    const label = JSON.stringify(value).slice(0, 120);
    assert.throws(() => storedKeySources(value), { code: 'KEY_SOURCES_INVALID' }, label);
    assert.deepEqual(projectKeySources({ key_sources: value }), { state: 'damaged', code: 'KEY_SOURCES_INVALID' }, label);
    const store = structuredClone(clean);
    store.api_context.operations[operationId].key_sources = value;
    writeFileSync(fixtureContextFile(f.root), JSON.stringify(store));
    // Through the query: the record and every observation are returned, the links are absent, the record is named.
    const queried = inFixtureStack(f.root, () => operationContext.queryOperationContext(f.root, { operation: DETAIL }, { env }));
    assert.deepEqual(queried.issues, [], `${label}: no source is unavailable`);
    assert.deepEqual(queried.record_issues, [{ repository: 'local', operation_id: operationId, code: 'KEY_SOURCES_INVALID' }], label);
    assert.equal(queried.operations.length, 1, label);
    assert.deepEqual(queried.operations[0].observations.map(item => item.id), observationIds, label);
    assert.equal(Object.hasOwn(queried.operations[0], 'key_sources'), false, `${label}: no links`);
    // Through show: the observed standing and its history are unchanged.
    const shown = await f.command(['show', DETAIL]);
    assert.equal(shown.code, 0, label);
    const detail = JSON.parse(shown.stdout);
    assert.equal(detail.observation_summary.state, 'observed', label);
    assert.deepEqual(detail.observation_summary.observations.map(item => item.observation_id),
      shownClean.observation_summary.observations.map(item => item.observation_id), label);
    assert.equal(detail.observation_summary.latest_response_eligible, shownClean.observation_summary.latest_response_eligible, label);
    assert.deepEqual(detail.scoped.record_issues, queried.record_issues, label);
    assert.equal(Object.hasOwn(detail.scoped.operations[0], 'key_sources'), false, label);
    for (const text of DAMAGED_TEXT) assert.ok(!shown.stdout.includes(text) && !shown.stderr.includes(text), `${label}: show never prints ${text}`);
  }
  f.sweep('command output', f.outputs.join('\n'));
});

test('MAP-1C a damaged key_sources list is replaced by capture and by context keys, which reports it', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: `/things/${ID}` });
  const operationId = Object.entries(f.store().api_context.operations).find(([, entry]) => entry.identity.operation === DETAIL)[0];
  const plant = value => {
    const store = f.store();
    store.api_context.operations[operationId].key_sources = value;
    writeFileSync(fixtureContextFile(f.root), JSON.stringify(store));
  };
  const damagedLink = [storedLink({ source: { operation: 'GET /things', field: `data[].${TOKEN}` } })];

  // Capture: the next request on the operation replaces the list with the links it derived.
  plant(damagedLink);
  const response = await f.request({ path: `/things/${ID2}` });
  assert.equal(response.status, 200);
  assert.equal(response.context_capture.state, 'captured', 'a damaged list never fails a capture');
  const origin = JSON.parse(readFileSync(f.evidenceFile(response.evidence), 'utf8')).origin;
  assert.deepEqual(f.record(DETAIL).key_sources.map(item => [item.param, item.source.field, item.first_observed_at, item.last_observed_at]),
    [['id', 'data[].id', origin.observed_at, origin.observed_at]], 'replaced by this capture\'s links, not merged with the damaged entries');
  assert.equal(f.record(DETAIL).observations.length, 2);
  // Another operation's capture is never refused because of it either.
  plant('not-an-array');
  assert.equal((await f.request({ path: '/things' })).context_capture.state, 'captured');

  // context keys: the replacement equals what the backfill derives for an absent list.
  const absent = f.store();
  delete absent.api_context.operations[operationId].key_sources;
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(absent));
  assert.equal(JSON.parse((await f.command(['context', 'keys', '--json'])).stdout).state, 'recorded');
  const derived = f.record(DETAIL).key_sources;
  assert.ok(derived.length, 'positive control: the backfill derives links for the record');
  plant('not-an-array');
  const before = f.storeText();
  const dryJson = JSON.parse((await f.command(['context', 'keys', '--dry-run', '--json'])).stdout);
  assert.equal(dryJson.state, 'would-change');
  assert.equal(dryJson.replaced_damaged, 1);
  assert.deepEqual(dryJson.operations.find(item => item.operation === DETAIL).key_sources, derived);
  const dryText = await f.command(['context', 'keys', '--dry-run']);
  assert.match(dryText.stdout, /1 damaged key_sources list\(s\) would be replaced/);
  assert.equal(f.storeText(), before, 'a dry run writes nothing');
  const written = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(written.state, 'recorded');
  assert.equal(written.replaced_damaged, 1);
  assert.deepEqual(f.record(DETAIL).key_sources, derived);
  plant(damagedLink);
  const text = await f.command(['context', 'keys']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /1 damaged key_sources list\(s\) were replaced/);
  assert.deepEqual(f.record(DETAIL).key_sources, derived);
  assert.equal(JSON.parse((await f.command(['context', 'keys', '--json'])).stdout).replaced_damaged, 0, 'nothing damaged remains');

  // With no evidence to derive from, the damaged list is removed; the observations stay.
  plant(damagedLink);
  const requests = f.requests();
  rmSync(f.evidenceDir, { recursive: true });
  const removed = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(removed.replaced_damaged, 1);
  assert.equal(Object.hasOwn(f.record(DETAIL), 'key_sources'), false);
  assert.equal(f.record(DETAIL).observations.length, 2);
  assert.equal(f.requests(), requests, 'the backfill executed no requests');
  f.sweep('store', f.storeText());
  f.sweep('command output', f.outputs.join('\n'));
});

test('MAP-1C API_CONTEXT_OFF=1 disables linking and evidence reads in capture and the backfill', async t => {
  const f = await fixture(t);
  await f.request({ path: '/things' });
  await f.request({ path: `/things/${ID}` });
  assert.ok(f.reads() > 0, 'positive control: linking reads evidence when enabled');
  assert.ok(f.record(DETAIL).key_sources.length);
  const before = f.storeText(), counted = f.reads();
  const off = { API_CONTEXT_OFF: '1' };
  await f.request({ path: '/things' }, off);
  const detail = await f.request({ path: `/things/${ID2}` }, off);
  assert.equal(detail.status, 200);
  assert.equal(detail.context_capture, undefined);
  const refused = await f.command(['context', 'keys'], off);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /CONTEXT_DISABLED/);
  assert.equal(f.reads(), counted, 'no evidence run file was read or listed with API_CONTEXT_OFF=1');
  assert.equal(f.storeText(), before);
});
