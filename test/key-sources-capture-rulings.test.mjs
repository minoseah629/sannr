// MAP-1C fix round 1 through the real client and CLI against a loopback server:
// the echo rule (QA's four variants), map keys and contract-declared names,
// contract-pinned parameters and response fields (capture and backfill), every
// run-file writer going through a temporary file and a rename, and the CLI's
// flag refusal on a healthy store. Fix round 2: a capture that replaces a
// damaged key_sources list says so (N1), valid lists survive a clone without
// evidence (N3), identifiers that only resemble dates link again (N2), and a
// JSON:API document keeps its member, attribute and relationship names (A1,
// A2). All data is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
import { contextCommandError } from '../lib/context-errors.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const client = new URL('../lib/client.mjs', import.meta.url).href;

async function fixture(t, { paths, handler }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-rulings-cli-')));
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://fixture.invalid');
    const out = handler({ method: req.method, url, raw, port: server.address().port }) ?? { status: 404, body: { error: 'not found' } };
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
    res.end(JSON.stringify(out.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const provider = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Rulings', version: '1' }, paths }));
  createFixtureStack(root, { baseUrl: provider, contract: 'openapi.json' });
  const evidenceDir = join(root, fixtureEvidencePath()), writeLog = join(root, 'evidence-writes.log');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_|MAP1C_)/.test(key)) delete env[key];
  Object.assign(env, { SANNR_HOME: join(root, 'isolated-home'), API_CONTEXT_DIR: root,
    API_EVIDENCE: evidenceDir,
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_BUDGET: '4000', API_FRICTION_OFF: '1',
    MAP1C_EVIDENCE_DIR: evidenceDir, MAP1C_WRITE_LOG: writeLog });
  // Records every write-mode open and every rename under the evidence directory.
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const dir = process.env.MAP1C_EVIDENCE_DIR, log = process.env.MAP1C_WRITE_LOG, append = fs.appendFileSync;
    const inside = p => typeof p === 'string' && (p.startsWith(dir + '/') || p.startsWith(dir + '\\\\'));
    const name = p => p.slice(dir.length + 1);
    const { openSync, renameSync } = fs;
    fs.openSync = function (p, flags, ...rest) {
      const writing = typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : /[wa+]/.test(String(flags ?? 'r'));
      if (writing && inside(String(p))) append(log, JSON.stringify({ open: name(String(p)) }) + '\\n');
      return openSync.call(this, p, flags, ...rest); };
    fs.renameSync = function (from, to) {
      if (inside(String(to))) append(log, JSON.stringify({ from: name(String(from)), to: name(String(to)) }) + '\\n');
      return renameSync.call(this, from, to); };
    syncBuiltinESMExports();`;
  const traced = ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
  const options = overrides => ({ cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const outputs = [];
  const command = async (args, overrides = {}) => {
    try {
      const result = await execute(process.execPath, [cli, ...args], options(overrides));
      outputs.push(result.stdout, result.stderr);
      return { ...result, code: 0 };
    } catch (error) {
      outputs.push(error.stdout ?? '', error.stderr ?? '');
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code };
    }
  };
  await command(['init']);
  const request = async (args, overrides = {}) => {
    const result = await execute(process.execPath, [...traced, '--input-type=module', '-e',
      `const { apiRequest } = await import(${JSON.stringify(client)}); process.stdout.write(JSON.stringify(await apiRequest(${JSON.stringify(args)})));`],
    options(overrides));
    outputs.push(result.stderr);
    return JSON.parse(result.stdout);
  };
  const storeText = () => readFileSync(fixtureContextFile(root), 'utf8');
  const store = () => JSON.parse(storeText());
  const record = operation => Object.values(store().api_context?.operations ?? {}).find(entry => entry.identity.operation === operation);
  const observedAt = runId => JSON.parse(readFileSync(join(evidenceDir, `${runId}.json`), 'utf8')).origin.observed_at;
  // The links a request recorded (its own observed time), as [param, location, source operation, field].
  const linkedBy = async (args, operation) => {
    const response = await request(args);
    const at = observedAt(response.evidence);
    return (record(operation)?.key_sources ?? []).filter(item => item.last_observed_at === at)
      .map(item => [item.param, item.location, item.source.operation, item.source.field]);
  };
  const writes = () => existsSync(writeLog) ? readFileSync(writeLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { root, provider, evidenceDir, command, request, store, storeText, record, linkedBy, writes, outputs, requests: () => requests };
}

test('MAP-1C B1 through the client: a request is never the source of a value it carried anywhere (QA\'s four variants)', async t => {
  const ID = 'thing-QA12-0a1b2c';
  const f = await fixture(t, {
    paths: { '/things/{id}.json': { get: {} }, '/jobs/{id}:cancel': { post: {} }, '/items/{id}': { get: {} }, '/search': { get: {} } },
    handler: ({ url }) => {
      if (url.pathname === '/search') return { body: { data: [{ id: ID }] } };
      const last = decodeURIComponent(url.pathname.split('/').pop());
      return { body: { id: last.replace(/\.json$|:cancel$/u, ''), state: 'ok' } };
    },
  });
  await f.request({ path: `/things/${ID}.json` });
  assert.deepEqual(await f.linkedBy({ path: `/things/${ID}.json` }, 'GET /things/{id}.json'), [],
    'a repeated {id}.json call is not the source of its own id');
  assert.deepEqual(await f.linkedBy({ method: 'POST', path: `/jobs/${ID}:cancel` }, 'POST /jobs/{id}:cancel'), [],
    'an {id}:cancel call does not take the .json echo as its source');
  assert.deepEqual(await f.linkedBy({ path: `/items/${ID}` }, 'GET /items/{id}'), [],
    'a plain /items/{id} call does not take the .json echo as its source');
  await f.request({ path: '/search', params: { filter: `id:${ID}` } });
  assert.deepEqual(await f.linkedBy({ path: `/items/${ID}` }, 'GET /items/{id}'), [],
    'a search whose filter carried the id is not its source');
  assert.equal(f.record('GET /items/{id}').key_sources, undefined);
});

const ORDER = { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'shipped'] },
  state: { type: 'string', enum: ['pending', 'done'] }, day: { type: 'string', format: 'date' }, compact: { type: 'string' },
  address_line_2: { type: 'string' } } };
const CONTRACT = {
  '/orders': { get: { parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'shipped'] } }],
    responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ORDER } } } } } } } } },
  '/workflows/{state}': { get: { parameters: [{ name: 'state', in: 'path', required: true, schema: { type: 'string', enum: ['pending', 'done'] } }] } },
  '/days/{day}': { get: { parameters: [{ name: 'day', in: 'path', required: true, schema: { type: 'string', format: 'date' } }] } },
  '/kinds/{kind}': { get: {} }, '/lines/{line}': { get: {} }, '/things/{id}': { get: {} },
  '/users': { get: {} }, '/teams/{teamId}': { get: {} },
};
const ordersHandler = ({ url }) => {
  if (url.pathname === '/orders') return { body: { data: [{ id: 'ord-B4-0001', status: 'pending', state: 'pending', day: '20261005',
    compact: '20261005', address_line_2: 'line-B2-0777' }] } };
  if (url.pathname === '/users') return { body: { members: { U024BE7LH: { team_id: 'team-B2-0001' } } } };
  return { body: { ok: true } };
};

test('MAP-1C B4 through the client: contract-pinned parameters never link and pinned response fields are never sources', async t => {
  const f = await fixture(t, { paths: CONTRACT, handler: ordersHandler });
  await f.request({ path: '/orders' });
  assert.deepEqual(await f.linkedBy({ path: '/orders', params: { status: 'pending' } }, 'GET /orders'), [], 'enum query parameter');
  assert.deepEqual(await f.linkedBy({ path: '/workflows/pending' }, 'GET /workflows/{state}'), [], 'enum path parameter');
  assert.deepEqual(await f.linkedBy({ path: '/days/20261005' }, 'GET /days/{day}'), [],
    'a compact date links nowhere when the contract declares a date format');
  assert.deepEqual(await f.linkedBy({ path: '/kinds/pending' }, 'GET /kinds/{kind}'), [],
    'enum response fields are not sources for an unconstrained parameter');
  // Controls: unconstrained parameters still link, and a declared property keeps its name.
  assert.deepEqual(await f.linkedBy({ path: '/things/ord-B4-0001' }, 'GET /things/{id}'), [['id', 'path', 'GET /orders', 'data[].id']]);
  assert.deepEqual(await f.linkedBy({ path: '/lines/line-B2-0777' }, 'GET /lines/{line}'),
    [['line', 'path', 'GET /orders', 'data[].address_line_2']], 'a contract-declared property is kept verbatim');
  // B2: an undeclared map key keyed by an id is recorded as {}.
  await f.request({ path: '/users' });
  assert.deepEqual(await f.linkedBy({ path: '/teams/team-B2-0001' }, 'GET /teams/{teamId}'),
    [['teamId', 'path', 'GET /users', 'members.{}.team_id']]);
  // (The pre-existing response_shape still records the key; the shape-recorder follow-up covers it.)
  assert.ok(!JSON.stringify(Object.values(f.store().api_context.operations).map(entry => entry.key_sources ?? [])).includes('U024BE7LH'),
    'the map key never enters key_sources');

  // The backfill applies the same contract rules: from a stripped store it
  // derives exactly what capture recorded.
  const captured = Object.fromEntries(Object.values(f.store().api_context.operations)
    .map(entry => [entry.identity.operation, entry.key_sources ?? null]));
  const stripped = f.store();
  for (const entry of Object.values(stripped.api_context.operations)) delete entry.key_sources;
  writeFileSync(fixtureContextFile(f.root), `${JSON.stringify(stripped, null, 2)}\n`);
  const report = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(report.state, 'recorded');
  const derived = Object.fromEntries(Object.values(f.store().api_context.operations)
    .map(entry => [entry.identity.operation, entry.key_sources ?? null]));
  assert.deepEqual(derived, captured);
});

test('MAP-1C B3 every run-file writer (HTTP, page follows, protocol) goes through a temporary file and a rename', async t => {
  const f = await fixture(t, {
    paths: { '/pages': { get: {} }, '/things/{id}': { get: {} } },
    handler: ({ url, raw, port }) => {
      if (url.pathname === '/rpc') return { body: { jsonrpc: '2.0', id: JSON.parse(raw).id, result: { ok: true } } };
      const page = Number(url.searchParams.get('page') ?? 1);
      return { body: { data: [{ id: `page-${page}-1234` }] },
        headers: page === 1 ? { link: `<http://127.0.0.1:${port}/pages?page=2>; rel="next"` } : {} };
    },
  });
  const http = await f.request({ path: '/things/page-1-1234' });
  const paged = await f.request({ path: '/pages', paginate: 'all' });
  const rpc = await f.request({ protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'fixture.read', params: {} } });
  assert.equal(paged.discovery.pages.fetched, 2);
  const finals = [`${http.evidence}.json`, `${paged.evidence}.json`, `${paged.evidence}-p2.json`, `${rpc.evidence}.json`];
  const writes = f.writes();
  for (const final of finals) {
    assert.ok(!writes.some(item => item.open === final), `${final} was never opened for writing under its final name`);
    const rename = writes.find(item => item.to === final);
    assert.ok(rename, `${final} appeared by a rename`);
    assert.ok(writes.some(item => item.open === rename.from), `${final} was written to its temporary file first`);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.evidenceDir, final), 'utf8')), `${final} is complete JSON`);
  }
});

test('MAP-1C context keys refuses an unknown flag on a healthy store; its help, hint and evidence-root message are named', async t => {
  const f = await fixture(t, { paths: { '/things': { get: {} }, '/things/{id}': { get: {} } }, handler: () => ({ body: { data: [] } }) });
  await f.request({ path: '/things' });
  const before = f.storeText();
  const refused = await f.command(['context', 'keys', '--force']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /CONTEXT_ARGUMENTS_INVALID/u);
  assert.ok(!refused.stderr.includes('--force'), 'the unknown flag is not echoed');
  assert.equal(f.storeText(), before);
  assert.equal((await f.command(['context', 'keys', '--json'])).code, 0, 'control: the known flag on the same store');
  const help = await f.command(['context', '--help']);
  assert.match(help.stdout, /context keys \[--dry-run\] \[--json\]/u);
  const unknown = await f.command(['context', 'keyz']);
  assert.match(unknown.stderr, /CONTEXT_ACTION_UNKNOWN/u);
  assert.match(unknown.stderr, /context keys/u);
  const rootError = contextCommandError({ code: 'CONTEXT_EVIDENCE_ROOT_UNSAFE' });
  assert.equal(rootError.code, 'CONTEXT_EVIDENCE_ROOT_UNSAFE');
  assert.match(rootError.message, /evidence directory/u);
});

// --- fix round 2 --------------------------------------------------------------

const operationIdOf = (store, operation) => Object.keys(store.api_context.operations)
  .find(key => store.api_context.operations[key].identity.operation === operation);
const plantKeySources = (f, operation, value) => {
  const store = f.store();
  store.api_context.operations[operationIdOf(store, operation)].key_sources = value;
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(store));
};

test('MAP-1C N1 a capture that replaces a damaged key_sources list says so in its context_capture', async t => {
  const A = 'thing-N1-0a1b2c', B = 'thing-N1-0d4e5f';
  const f = await fixture(t, { paths: { '/things': { get: {} }, '/things/{id}': { get: {} } },
    handler: ({ url }) => ({ body: url.pathname === '/things' ? { data: [{ id: A }, { id: B }] } : { ok: 'yes' } }) });
  await f.request({ path: '/things' });
  const first = await f.request({ path: `/things/${A}` });
  assert.equal(Object.hasOwn(first.context_capture, 'key_sources'), false, 'a plain capture reports nothing about key sources');
  plantKeySources(f, 'GET /things/{id}', 'not-an-array');
  const replacing = await f.request({ path: `/things/${B}` });
  assert.equal(replacing.context_capture.state, 'captured');
  assert.deepEqual(replacing.context_capture.key_sources, { replaced_damaged: true });
  assert.deepEqual(f.record('GET /things/{id}').key_sources.map(item => item.source.field), ['data[].id'], 'the list was replaced');
  const next = await f.request({ path: `/things/${A}` });
  assert.equal(Object.hasOwn(next.context_capture, 'key_sources'), false, 'only the capture that replaced it says so');
  // A capture that derives no links leaves a damaged list (still named) and says nothing.
  plantKeySources(f, 'GET /things/{id}', 'not-an-array');
  const unlinked = await f.request({ path: '/things/thing-N1-ffff00' });
  assert.equal(Object.hasOwn(unlinked.context_capture, 'key_sources'), false);
  assert.equal(f.record('GET /things/{id}').key_sources, 'not-an-array');
  // Under a tight envelope budget the signal survives the compacted capture.
  const tight = await f.request({ path: `/things/${B}` }, { API_BUDGET: '120' });
  assert.equal(tight.context_capture.details_omitted, true, 'the capture was compacted');
  assert.deepEqual(tight.context_capture.key_sources, { replaced_damaged: true });
});

test('MAP-1C N3 valid key_sources survive a clone without evidence: context keys, its dry run and an unrelated capture keep them', async t => {
  const A = 'thing-N3-0a1b2c', B = 'owner-N3-0d4e5f';
  const f = await fixture(t, { paths: { '/things': { get: {} }, '/things/{id}': { get: {} }, '/owners/{ownerId}': { get: {} },
    '/status': { get: {} } },
  handler: ({ url }) => ({ body: url.pathname === '/things' ? { data: [{ id: A, owner_id: B }] } : { ok: 'yes' } }) });
  await f.request({ path: '/things' });
  await f.request({ path: `/things/${A}` });
  await f.request({ path: `/owners/${B}` });
  const valid = { things: JSON.stringify(f.record('GET /things/{id}').key_sources),
    owners: JSON.stringify(f.record('GET /owners/{ownerId}').key_sources) };
  assert.ok(f.record('GET /things/{id}').key_sources.length && f.record('GET /owners/{ownerId}').key_sources.length,
    'positive control: two records hold valid links');
  const inode = () => statSync(fixtureContextFile(f.root)).ino;
  const backfills = [['context', 'keys', '--dry-run'], ['context', 'keys', '--dry-run', '--json'], ['context', 'keys'], ['context', 'keys', '--json']];
  const untouched = async label => {
    const bytes = f.storeText(), ino = inode();
    for (const args of backfills) {
      assert.equal((await f.command(args)).code, 0, `${label}: ${args.join(' ')}`);
      assert.equal(f.storeText(), bytes, `${label}: ${args.join(' ')} leaves the store byte-identical`);
      assert.equal(inode(), ino, `${label}: ${args.join(' ')} does not rewrite it`);
    }
  };
  // A teammate's clone: the knowledge file without the private evidence.
  renameSync(f.evidenceDir, `${f.evidenceDir}.elsewhere`);
  await untouched('evidence directory missing');
  mkdirSync(f.evidenceDir);
  await untouched('evidence directory empty');
  // A capture of an unrelated operation keeps both lists exactly.
  assert.equal((await f.request({ path: '/status' })).context_capture.state, 'captured');
  assert.equal(JSON.stringify(f.record('GET /things/{id}').key_sources), valid.things);
  assert.equal(JSON.stringify(f.record('GET /owners/{ownerId}').key_sources), valid.owners);
  await untouched('only the clone\'s own new run');
  // A damaged list elsewhere makes context keys write; the valid lists are kept byte for byte.
  plantKeySources(f, 'GET /status', 'not-an-array');
  const written = JSON.parse((await f.command(['context', 'keys', '--json'])).stdout);
  assert.equal(written.state, 'recorded');
  assert.equal(written.replaced_damaged, 1);
  assert.equal(Object.hasOwn(f.record('GET /status'), 'key_sources'), false, 'the damaged list with none derived is removed');
  assert.equal(JSON.stringify(f.record('GET /things/{id}').key_sources), valid.things);
  assert.equal(JSON.stringify(f.record('GET /owners/{ownerId}').key_sources), valid.owners);
});

test('MAP-1C N2 through the client: identifiers that only resemble dates link again; complete dates never link', async t => {
  const IDS = ['APR-721', 'MAY-1001', '1.2.10', '2026-278'];
  const DATES = ['2026/10/05', '05.10.2026', 'Oct 5, 2026', '05-Oct-2026'];
  const f = await fixture(t, { paths: { '/items': { get: {} }, '/items/{key}': { get: {} } },
    handler: ({ url }) => ({ body: url.pathname === '/items' ? { data: [...IDS, ...DATES].map(key => ({ key })) } : { ok: 'yes' } }) });
  await f.request({ path: '/items' });
  for (const value of IDS)
    assert.deepEqual(await f.linkedBy({ path: `/items/${encodeURIComponent(value)}` }, 'GET /items/{key}'),
      [['key', 'path', 'GET /items', 'data[].key']], value);
  for (const value of DATES)
    assert.deepEqual(await f.linkedBy({ path: `/items/${encodeURIComponent(value)}` }, 'GET /items/{key}'), [], value);
});

test('MAP-1C A1/A2 through the client: a JSON:API document records data[].id, included[].id and relationship paths', async t => {
  const ARTICLE = 'art-JSN-0001', CATEGORY = 'cat-JSN-0002', AUTHOR = 'ppl-JSN-0003', TAG = 'tag-JSN-0004', MEMBER = 'team-JSN-0005';
  const document = { data: [{ type: 'articles', id: ARTICLE,
    attributes: { title: { en: 'title-JSN-en', de: 'title-JSN-de' }, summary: { en: 'sum-JSN-en', de: 'sum-JSN-de' } },
    relationships: { category: { data: { type: 'categories', id: CATEGORY } }, author: { data: { type: 'people', id: AUTHOR } } } }],
  included: [{ type: 'tags', id: TAG }] };
  // A generic id-keyed map (object values with identical key sets) stays data.
  const members = { members: { alice: { team_id: MEMBER }, bob: { team_id: 'team-JSN-0006' } } };
  // An envelope of arrays under names JSON:API does not define (A1 alone).
  const ITEM = 'itm-JSN-0007', search = { items: [{ id: ITEM }], results: [] };
  const bodies = { '/articles': document, '/members': members, '/search': search };
  const f = await fixture(t, { paths: { '/articles': { get: {} }, '/members': { get: {} }, '/search': { get: {} },
    '/articles/{articleId}': { get: {} }, '/categories/{categoryId}': { get: {} }, '/people/{personId}': { get: {} },
    '/tags/{tagId}': { get: {} }, '/teams/{teamId}': { get: {} }, '/items/{itemId}': { get: {} } },
  handler: ({ url }) => ({ body: bodies[url.pathname] ?? { ok: 'yes' } }) });
  for (const path of Object.keys(bodies)) await f.request({ path });
  const linked = {
    article: await f.linkedBy({ path: `/articles/${ARTICLE}` }, 'GET /articles/{articleId}'),
    category: await f.linkedBy({ path: `/categories/${CATEGORY}` }, 'GET /categories/{categoryId}'),
    author: await f.linkedBy({ path: `/people/${AUTHOR}` }, 'GET /people/{personId}'),
    tag: await f.linkedBy({ path: `/tags/${TAG}` }, 'GET /tags/{tagId}'),
    team: await f.linkedBy({ path: `/teams/${MEMBER}` }, 'GET /teams/{teamId}'),
    item: await f.linkedBy({ path: `/items/${ITEM}` }, 'GET /items/{itemId}'),
  };
  assert.deepEqual(linked, {
    article: [['articleId', 'path', 'GET /articles', 'data[].id']],
    category: [['categoryId', 'path', 'GET /articles', 'data[].relationships.category.data.id']],
    author: [['personId', 'path', 'GET /articles', 'data[].relationships.author.data.id']],
    tag: [['tagId', 'path', 'GET /articles', 'included[].id']],
    team: [['teamId', 'path', 'GET /members', 'members.{}.team_id']],
    item: [['itemId', 'path', 'GET /search', 'items[].id']],
  });
  // (The response-shape recorder still records map keys verbatim; the shape-recorder follow-up covers it.)
  const allSources = JSON.stringify(Object.values(f.store().api_context.operations).map(entry => entry.key_sources ?? []));
  assert.ok(!allSources.includes('alice') && !allSources.includes('bob'), 'the generic map\'s keys never enter key_sources');
  // The backfill derives the same fields from the same evidence.
  const captured = Object.fromEntries(['GET /articles/{articleId}', 'GET /categories/{categoryId}', 'GET /tags/{tagId}']
    .map(operation => [operation, f.record(operation).key_sources]));
  const stripped = f.store();
  for (const entry of Object.values(stripped.api_context.operations)) delete entry.key_sources;
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(stripped));
  assert.equal(JSON.parse((await f.command(['context', 'keys', '--json'])).stdout).state, 'recorded');
  for (const [operation, sources] of Object.entries(captured)) assert.deepEqual(f.record(operation).key_sources, sources, operation);
});
