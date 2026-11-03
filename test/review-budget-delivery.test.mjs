// Public CLI/MCP presentation checks with an in-process fetch stub. No socket
// is opened. These supplement, not replace, the existing loopback wire tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { CONTEXT_FILE } from '../lib/context.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { PRODUCT } from '../lib/brand.mjs';

const execute = promisify(execFile), pkg = fileURLToPath(new URL('../', import.meta.url));
const notes = ['page size caps at 100 even when per_page asks for more', 'the cursor expires after 60 seconds of inactivity'];
const write = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const entry = () => ({ source_file: null, verified_at: '2026-08-21T10:00:00.000Z', contract_digest: null,
  shape_hash: 'abc', status_codes: [200], effect: 'read', fields: { id: { type: 'string' } }, notes });
async function fixture(t, { feedback = false, tempBase = tmpdir() } = {}) {
  const parent = realpathSync(mkdtempSync(join(tempBase, 'review-budget-'))), root = join(parent, 'consumer');
  mkdirSync(root);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:API_|SANNR_|NODE_OPTIONS)/u.test(key)));
  // Test registry state stays isolated from both the developer and other tests.
  env.HOME = join(parent, 'home'); mkdirSync(env.HOME);
  Object.assign(env, { API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', API_USAGE_LOG: join(parent, 'usage.jsonl'), NO_COLOR: '1' });
  const calls = join(parent, 'calls.jsonl'), preload = join(parent, 'fetch-stub.mjs');
  const url = feedback ? `https://${PRODUCT}.dev/api/v1/feedback` : 'http://127.0.0.1:1';
  write(preload, `import {appendFileSync} from 'node:fs';
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url instanceof Request ? url.url : url);
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({href, method:init.method})+'\\n');
      if (${feedback ? `href !== ${JSON.stringify(url)}` : `!href.startsWith(${JSON.stringify(url + '/')})`}) throw new Error('Unexpected fixture target');
      const body = ${feedback ? "{id:'01K6ZZZZZZ0000000000000000',received_at:'2026-10-07T12:00:00.000Z'}"
        : "Array.from({length:80},(_,i)=>({id:'row-'+i,name:'widget number '+i,padding:'x'.repeat(48)}))"};
      const response = new Response(JSON.stringify(body), {status:${feedback ? 202 : 200},headers:{'content-type':'application/json'}});
      Object.defineProperty(response, 'url', {value:href}); return response;
    };`);
  env.NODE_OPTIONS = `--import=${preload}`;
  await execute('git', ['init', '--quiet'], { cwd: root, env });
  const cli = async args => {
    const result = await execute(process.execPath, [join(pkg, 'bin/cli.mjs'), ...args], { cwd: root, env, timeout: 15000 });
    return args[0] === 'grant' ? result.stdout : JSON.parse(result.stdout);
  };
  const mcp = (args, extra = {}, name = 'api_request') => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [join(pkg, 'server.mjs')], { cwd: root, env: { ...env, ...extra }, timeout: 15000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      const reply = stdout.trim().split('\n').map(JSON.parse).find(row => row.id === 1);
      const text = reply.result.content[0].text;
      resolve({ value: JSON.parse(text), text });
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  return { root, parent, env, cli, mcp, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
const labels = known => known.note_projection?.reviews ?? known.note_projection?.records?.map(row => row.review.label);

test('300-token MCP envelopes withhold projection metadata before local or granted notes under long provenance', async t => {
  // Fix the canonical root length independently of the caller's TMPDIR. The
  // default-temp-path loopback scenario remains in cross-context.test.mjs.
  const f = await fixture(t, { tempBase: join('/', 'tmp') });
  const padding = 'p'.repeat(112 - join(f.parent, '', 'billing-api').length - 1);
  const provider = join(f.parent, padding, 'billing-api');
  assert.equal(provider.length, 112);
  mkdirSync(provider, { recursive: true }); await execute('git', ['init', '--quiet'], { cwd: provider, env: f.env });
  write(join(provider, CONTEXT_FILE), { v: 0, api: { name: 'billing-api', contract: null, contract_digest: null },
    generated_at: '2026-08-21', operations: { 'GET /big-cross': entry() } });
  createFixtureStack(f.root, { baseUrl: 'http://127.0.0.1:1' });
  write(fixtureContextFile(f.root), { v: 0, api: { name: 'consumer' }, operations: { 'GET /big-local': entry() } });
  await f.cli(['grant', provider, '--json']);
  const saved = readFileSync(join(provider, CONTEXT_FILE), 'utf8');
  for (const kind of ['cross', 'local']) {
    const { value, text } = await f.mcp({ path: `/big-${kind}` }, { API_BUDGET: '300' });
    t.diagnostic(`${kind}: ${text.length}/1200 characters, ${value.known?.notes?.length ?? 0} notes, ${value.known?.withheld?.note_projection ?? 0} projections withheld`);
    assert.equal(value.status, 200);
    assert.deepEqual(value.known?.notes, notes, JSON.stringify(value));
    if (kind === 'cross') {
      assert.equal(value.known.note_projection, undefined);
      assert.equal(value.known.withheld.note_projection, notes.length);
    } else assert.deepEqual(labels(value.known), ['unreviewed', 'unreviewed']);
    assert.equal(value.known.withheld?.notes, undefined);
    assert.ok(value.discovery?.truncated);
    assert.ok(text.length <= 1200, `${text.length} chars exceeds the promised 300 tokens`);
    if (kind === 'cross') assert.deepEqual(value.known.from, { repo: 'billing-api', root: provider });
    else assert.equal(value.known.from, undefined);
    const full = await f.mcp({ path: `/big-${kind}` }, { API_BUDGET: '16000' });
    assert.deepEqual(full.value.known.notes, notes);
    assert.deepEqual(full.value.known.note_projection.records.map(row => row.review.label), ['unreviewed', 'unreviewed']);
    assert.equal(full.value.known.withheld?.note_projection, undefined);
    assert.ok(full.text.length <= 16000 * 4);
  }
  assert.equal(readFileSync(join(provider, CONTEXT_FILE), 'utf8'), saved);
  assert.equal(f.calls().length, 4);
});

test('tight MCP envelopes retain contradiction flags and count withheld labels while full read tools retain decisions', async t => {
  const f = await fixture(t);
  write(join(f.root, 'openapi.json'), { openapi: '3.0.0', info: { title: 'Fixture', version: '1' },
    paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } } });
  createFixtureStack(f.root, { baseUrl: 'http://127.0.0.1:1', contract: 'openapi.json' });
  write(fixtureContextFile(f.root), { v: 0, api: {}, operations: {} });
  const claim = await f.cli(['note', 'GET /items', 'Returns HTTP 201.', '--json']);
  await f.cli(['review', 'GET /items', '--note', claim.note_id, '--decision', 'trusted', '--by', 'Reviewer', '--actor', 'person', '--limits', 'local only', '--json']);
  await f.cli(['note', 'GET /items', notes[1], '--alongside', '--json']);
  const observed = await f.mcp({ path: '/items' }, { API_BUDGET: '16000' });
  assert.equal(observed.value.status, 200);
  const saved = readFileSync(fixtureContextFile(f.root), 'utf8');
  const full = await f.cli(['show', 'GET /items', '--json']);
  const record = full.note_projection.records.find(row => row.id === claim.note_id);
  assert.deepEqual(record.contradictions, ['status']);
  assert.equal(record.review.state, 'contradicted-since-trusted');
  const { value, text } = await f.mcp({ path: '/items', capture_context: false }, { API_BUDGET: '250' });
  t.diagnostic(`contradiction: ${text.length}/1000 characters, ${value.known?.notes?.length ?? 0} notes, ${value.known?.withheld?.note_projection ?? 0} projections withheld`);
  assert.equal(value.status, 200);
  assert.deepEqual(value.known.notes, full.active_notes);
  const noteIndex = value.known.notes.indexOf('Returns HTTP 201.');
  assert.deepEqual(value.known.note_projection, { contradictions: [{ note_index: noteIndex, kinds: ['status'] }], details_omitted: true });
  assert.equal(value.known.withheld.note_projection, 2);
  assert.equal(value.known.withheld.notes, undefined);
  assert.ok(text.length <= 1000, `${text.length} chars exceeds the promised 250 tokens`);
  const context = await f.mcp({ operation: 'GET /items' }, {}, 'api_note_context');
  assert.equal(context.value.note_context.records.find(row => row.id === claim.note_id).review.label, record.review.label);
  assert.equal(readFileSync(fixtureContextFile(f.root), 'utf8'), saved);
  assert.equal(f.calls().length, 2, 'full read tools never execute a request');
});

test('feedback CLI keeps substantive 202 and cooldown guidance, with labels whenever they fit', async t => {
  for (const budget of [undefined, '16000']) {
    const f = await fixture(t, { feedback: true });
    if (budget) f.env.API_BUDGET = budget;
    write(join(f.root, LAYOUT.directory, 'defaults.json'), { feedback: { send: 'allow' } });
    const result = await f.cli(['feedback', '--send', '--json']);
    assert.equal(result.status, 202);
    assert.ok(result.known.notes.length >= 4);
    assert.match(JSON.stringify(result.known.notes), /202/, JSON.stringify(result));
    assert.match(JSON.stringify(result.known.notes), /30/);
    const reviews = labels(result.known);
    if (budget || reviews) assert.equal(reviews.length, result.known.notes.length);
    else assert.equal(result.known.withheld.note_projection, result.known.notes.length + (result.known.withheld.notes ?? 0));
    assert.equal(f.calls().length, 1);
    assert.equal(f.calls()[0].href, `https://${PRODUCT}.dev/api/v1/feedback`);
  }
});

test('credential refusal preserves masking and a measured budget without calling the fetch stub', async t => {
  const f = await fixture(t);
  createFixtureStack(f.root, { name: 'beta', baseUrl: 'http://127.0.0.1:1/beta/v2', environmentConfig: { auth: 'bearer:CODE1_FIXTURE_SECRET' } });
  write(fixtureContextFile(f.root, 'beta'), { v: 0, api: { name: 'Beta API' }, operations: {
    'GET /users': { ...entry(), notes: ['Beta excludes archived records.'], notes_provenance: [{ by: 'fixture-author', at: '2026-10-07' }] },
  } });
  for (let n = 0; n < 5; n++) write(join(f.root, `${'a'.repeat(60)}-${n}.mjs`),
    'const BASE = "http://127.0.0.1:1/beta/v2";\nfetch(`${BASE}/users`);\n');
  const { value, text } = await f.mcp({ stack: 'beta', path: '/users', headers: { authorization: 'Bearer synthetic-fixture-credential' } },
    { API_BUDGET: '500', CODE1_FIXTURE_SECRET: 'a' });
  assert.equal(value.error.code, 'CREDENTIAL_IN_REQUEST');
  assert.deepEqual(f.calls(), []);
  assert.ok(!text.includes('synthetic-fixture-credential'));
  assert.ok(!text.includes('a'.repeat(60)));
  assert.deepEqual(value.known.notes, ['Bet[redacted] excludes [redacted]rchived records.']);
  assert.ok(text.length <= 2000 || value.budget_min >= Math.ceil(text.length / 4), text);
  if (value.known?.notes?.length) assert.equal(labels(value.known).length, value.known.notes.length);
});

test('budgeted MCP review labels keep decisions while masking configured credentials in limits and reasons', async t => {
  const f = await fixture(t);
  createFixtureStack(f.root, { baseUrl: 'http://127.0.0.1:1', environmentConfig: { auth: 'bearer:REVIEW_FIXTURE_SECRET' } });
  write(fixtureContextFile(f.root), { v: 0, api: {}, operations: {} });
  const trusted = await f.cli(['note', 'GET /reviewed', 'Documented: pagination uses a cursor.', '--json']);
  await f.cli(['review', 'GET /reviewed', '--note', trusted.note_id, '--decision', 'trusted', '--by', 'Reviewer', '--actor', 'person', '--limits', 'local banana', '--json']);
  const disputed = await f.cli(['note', 'GET /reviewed', 'Pagination is always enabled.', '--alongside', '--json']);
  await f.cli(['review', 'GET /reviewed', '--note', disputed.note_id, '--decision', 'disputed', '--by', 'Reviewer', '--actor', 'person', '--reason', 'No run covers banana pagination.', '--json']);
  const { value, text } = await f.mcp({ path: '/reviewed', capture_context: false }, { API_BUDGET: '500', REVIEW_FIXTURE_SECRET: 'banana' });
  assert.equal(value.status, 200);
  assert.ok(text.length <= 2000);
  assert.equal(value.known.notes.length, 2);
  const reviews = labels(value.known);
  assert.equal(reviews.length, 2);
  assert.ok(reviews.some(label => /trusted by Reviewer.*no run.*local \[redacted\]/u.test(label)));
  assert.ok(reviews.some(label => /disputed by Reviewer.*No run covers \[redacted\]/u.test(label)));
  assert.ok(!text.includes('banana'));
});
