// VIEW-2a: the session ledger, one test per acceptance scenario. Real host
// processes (the MCP server) run against a loopback fixture server in its own
// process; earlier sessions are synthetic run files with the client's shape.
// Every CLI run uses an isolated HOME and machine-state directory.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { escapeText } from '../lib/api-map.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
// The fixture server returns this SID-shaped value as every created id.
const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'ghp_' + 'b'.repeat(36);
const DAY = 86_400_000;

let server, origin;
before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'test/fixtures/field-batch-server.mjs')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  [{ origin }] = await once(server, 'message');
});
after(async () => { if (server.exitCode === null) { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; } });

const contract = { openapi: '3.0.0', info: { title: 'Files', version: '1' }, paths: {
  '/health': { get: { responses: { 200: { description: 'ok' } } } },
  '/files': { post: { responses: { 201: { description: 'created' } } } },
  '/files/{fileId}': {
    get: { parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } },
    delete: { parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } } } };

function project(t, { stacks = ['alpha', 'beta'] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'session-ledger-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'home'));
  for (const name of stacks) {
    const dir = join(root, LAYOUT.collection, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'openapi.json'), JSON.stringify(contract));
    writeFileSync(join(dir, 'stack.json'), JSON.stringify({ v: 1, name, default_environment: 'local', contract: 'openapi.json',
      environments: { local: { baseUrl: `${origin}/${name}`, auth: 'bearer:LEDGER_TEST_TOKEN' } } }));
    writeFileSync(join(dir, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name },
      operations: { 'GET /health': { notes: ['Health answers before the database is ready.'], notes_provenance: [{ by: 'human', at: '2026-10-01' }] } } }));
  }
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'home', 'machine'), TZ: 'UTC', NO_COLOR: '1',
    API_CONTEXT_DIR: root, API_TIMEOUT_MS: '2000', LEDGER_TEST_TOKEN: TOKEN };
  return { root, env };
}

// One MCP host process: initialize, then each call in order, then exit.
async function mcpSession({ root, env }, calls) {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.resume();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const answered = async id => {
    for (let waited = 0; !out.split('\n').some(line => line.includes(`"id":${id},`)); waited += 10) {
      if (waited > 20_000) throw new Error(`MCP call ${id} did not answer`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ledger-test', version: '1' } } });
  await answered(1);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const [index, args] of calls.entries()) {
    send({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'api_request', arguments: args } });
    await answered(index + 2);
  }
  child.stdin.end();
  await once(child, 'exit');
  return out.trim().split('\n').map(line => JSON.parse(line)).filter(message => message.id > 1)
    .map(message => JSON.parse(message.result.content[0].text));
}

// A run file with the client's shape. The URL and bodies carry values the
// ledger must never show.
function writeRun(root, stack, { at, origin: fields = {}, operation = 'GET /files/{fileId}', method = 'GET', status = 200, drift = [] }) {
  const runId = `run-${randomUUID()}`;
  const dir = join(root, LAYOUT.evidence, ...(stack ? [stack] : []));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId,
    origin: { v: 1, initiator: 'cli.request', transport: 'api_request:http', observed_at: new Date(at).toISOString(), package_version: '0.1.0',
      build_id: null, ...fields, scope: { operation, protocol: 'http', environment: 'local', provider: `${origin}/${stack}`, contract_digest: null } },
    request: { method, url: `${origin}/${stack}/files/${SID}?token=${TOKEN}`, headers: { authorization: '[redacted]' }, body: { secret: TOKEN } },
    response: { status, headers: {}, body: { id: SID, private: 'RESPONSE_VALUE_MUST_NOT_APPEAR' } }, drift, durationMs: 4 }, null, 2));
  return runId;
}

const cli = ({ root, env }, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
const ledger = (fixture, args = []) => {
  const result = cli(fixture, ['sessions', '--json', ...args]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const callRows = session => session.rows.flatMap(row => row.kind === 'batch' ? row.rows : [row]);
// Captured ids, credentials and response values never appear; the ledger
// itself names no request URL either (the view's API map shows configured base
// URLs, so a page is checked for the URL inside its sessions section only).
const assertNoValues = (text, { urls = true } = {}) => {
  for (const value of [SID, TOKEN, 'RESPONSE_VALUE_MUST_NOT_APPEAR', ...(urls ? ['127.0.0.1'] : [])])
    assert.equal(text.includes(value), false, `a value reached the output: ${value.slice(0, 6)}…`);
};
const sessionsSection = html => html.slice(html.indexOf('<section id="sessions"'), html.indexOf('</section>', html.indexOf('<section id="sessions"')));
const assertNoPageValues = html => { assertNoValues(html, { urls: false }); assertNoValues(sessionsSection(html)); };

// The shared scenario: an MCP host session today with an asserted GET, a
// batch whose cleanup leaves one resource behind, and a refused POST; and an
// earlier CLI host process two days ago.
async function twoSessions(t) {
  const fixture = project(t);
  const answers = await mcpSession(fixture, [
    { stack: 'alpha', method: 'GET', path: '/health', expect: [{ status: 200 }] },
    { stack: 'alpha', requests: [{ id: 'create', method: 'POST', path: '/files', expect: [{ status: 201 }], capture: { fileId: 'id' } }],
      finally: [{ id: 'cleanup', method: 'DELETE', path: '/files/{fileId}?refused=1', expect: [{ status: 200 }] }] },
    { stack: 'beta', method: 'POST', path: '/files', reveal_secrets: 'yes' },
  ]);
  assert.equal(answers[1].left_behind.length, 1, 'the fixture batch leaves one resource behind');
  assert.equal(answers[2].error.code, 'REVEAL_SECRETS_INVALID');
  const earlier = { session_id: randomUUID() };
  const at = Date.now() - 2 * DAY;
  writeRun(fixture.root, 'beta', { at, origin: earlier, status: 200 });
  writeRun(fixture.root, 'beta', { at: at + 60_000, origin: earlier, status: 404, drift: [{ kind: 'undeclared-status' }] });
  return fixture;
}

test('sessions lists two host processes newest first, with each call, the batch cleanup and leftover, and the refusal', async t => {
  const fixture = await twoSessions(t);
  const model = ledger(fixture);
  assert.equal(model.sessions.length, 2);
  const [latest, earlier] = model.sessions;
  assert.deepEqual(latest.hosts, ['mcp.api_request']);
  assert.deepEqual(earlier.hosts, ['cli.request']);
  assert.ok(latest.started_at > earlier.ended_at, 'newest first');

  const [get, batch, refused] = latest.rows;
  assert.equal(get.operation, 'GET /health');
  assert.equal(get.stack, 'alpha');
  assert.equal(get.status, 200);
  assert.deepEqual(get.assertions, { passed: 1, failed: 0 });
  assert.equal(get.delivered.notes, 1);
  assert.ok(get.produced.observation, 'the asserted GET produced an observation');
  assert.match(get.basis.run_id, /^run-/);

  assert.equal(batch.kind, 'batch');
  assert.equal(batch.left_behind, 1);
  assert.deepEqual(batch.rows.map(row => row.phase), ['requests', 'cleanup']);
  assert.equal(batch.rows[1].operation, 'DELETE /files/{fileId}');
  assert.equal(batch.rows[1].status, 401);

  assert.equal(refused.method, 'POST');
  assert.equal(refused.status, null);
  assert.deepEqual(refused.left, { refusal: 'REVEAL_SECRETS_INVALID', attempted: 0, error: null });

  for (const session of model.sessions) {
    const rows = callRows(session);
    assert.equal(session.totals.calls, rows.length);
    assert.equal(session.totals.assertions.passed, rows.reduce((n, row) => n + (row.assertions?.passed ?? 0), 0));
    assert.equal(session.totals.assertions.failed, rows.reduce((n, row) => n + (row.assertions?.failed ?? 0), 0));
    assert.equal(session.totals.notes_delivered, rows.reduce((n, row) => n + (row.delivered.notes ?? 0), 0));
    assert.equal(session.totals.refusals, rows.filter(row => row.left.refusal).length);
    assert.equal(session.totals.leftovers, session.rows.reduce((n, row) => n + (row.left_behind ?? 0), 0));
    assert.equal(session.totals.drift_records, rows.reduce((n, row) => n + row.produced.drift.length, 0));
  }
  assert.equal(earlier.totals.drift_records, 1);

  const text = cli(fixture, ['sessions']);
  assert.equal(text.status, 0, text.stderr);
  for (const shown of ['GET /health', 'REVEAL_SECRETS_INVALID', 'cleanup', 'left behind 1', get.basis.run_id, '1 passed, 0 failed'])
    assert.ok(text.stdout.includes(shown), shown);
  assert.ok(text.stdout.indexOf('mcp.api_request') < text.stdout.indexOf('host cli.request'), 'newest session printed first');
  assertNoValues(text.stdout);
});

test('sessions --json carries sessions, rows and totals, reserves host telemetry, and holds no response value or credential', async t => {
  const fixture = await twoSessions(t);
  const result = cli(fixture, ['sessions', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const model = JSON.parse(result.stdout);
  assert.equal(model.sessions.length, 2);
  for (const session of model.sessions) {
    assert.equal(session.host_telemetry, null);
    assert.ok(session.rows.length && session.totals.calls > 0);
  }
  assert.equal(model.totals.calls, model.sessions.reduce((n, session) => n + session.totals.calls, 0));
  assertNoValues(result.stdout);
  assert.equal(result.stdout.includes('Bearer'), false);
});

test('sessions --since and --stack filter rows and recompute totals; an empty result says so', async t => {
  const fixture = await twoSessions(t);
  const recent = ledger(fixture, ['--since', new Date(Date.now() - DAY).toISOString()]);
  assert.equal(recent.sessions.length, 1);
  assert.deepEqual(recent.sessions[0].hosts, ['mcp.api_request']);
  assert.equal(recent.totals.calls, 4);

  const beta = ledger(fixture, ['--stack', 'beta']);
  const rows = beta.sessions.flatMap(callRows);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every(row => row.stack === 'beta'));
  assert.equal(beta.totals.calls, rows.length);
  assert.equal(beta.totals.refusals, 1);
  assert.equal(beta.totals.leftovers, 0);

  const none = ledger(fixture, ['--stack', 'gamma']);
  assert.equal(none.sessions.length, 0);
  assert.equal(none.totals.calls, 0);
  assert.equal(none.empty.reason, 'filtered-out');
  const text = cli(fixture, ['sessions', '--since', new Date(Date.now() + DAY).toISOString()]);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(none.empty.populate));
});

test('view --out gains the sessions section with the theme controls and CSP, no script, and no request', async t => {
  const fixture = await twoSessions(t);
  const trace = async () => (await (await fetch(`${origin}/trace`)).json()).length;
  const before = await trace();
  const page = join(fixture.root, 'page.html');
  const result = cli(fixture, ['view', '--out', page]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await trace(), before + 1, 'only the trace read itself reached the fixture server');
  const html = readFileSync(page, 'utf8');
  const model = ledger(fixture);
  assert.match(html, /<section id="sessions"/);
  assert.match(html, /<a href="#sessions">Sessions<\/a>/);
  for (const session of model.sessions) for (const row of callRows(session))
    if (row.basis.run_id) assert.ok(html.includes(row.basis.run_id), row.basis.run_id);
  for (const shown of ['REVEAL_SECRETS_INVALID', 'cleanup', 'left behind 1']) assert.ok(html.includes(shown), shown);
  assert.match(html, /id="report-theme-system" checked/);
  assert.match(html, /id="report-theme-light"/);
  assert.match(html, /id="report-theme-dark"/);
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.doesNotMatch(html, /<script|<link|<iframe|src\s*=|@import|url\s*\(/i);
  assert.doesNotMatch(html, /href="(?!#)/);
  assertNoPageValues(html);

  const standalone = join(fixture.root, 'sessions.html');
  const written = cli(fixture, ['sessions', '--out', standalone]);
  assert.equal(written.status, 0, written.stderr);
  const own = readFileSync(standalone, 'utf8');
  assert.match(own, /<section id="sessions"/);
  assert.match(own, /content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.match(own, /id="report-theme-system" checked/);
  assert.doesNotMatch(own, /<script|<link|<iframe|src\s*=|@import|url\s*\(/i);
  assertNoValues(own);
});

test('evidence without a process or build id is grouped by host and local day, and the header says so', t => {
  const fixture = project(t);
  const day1 = Date.parse('2026-10-10T09:00:00.000Z'), day2 = Date.parse('2026-10-11T09:00:00.000Z');
  writeRun(fixture.root, 'alpha', { at: day1 });
  writeRun(fixture.root, 'alpha', { at: day1 + 3_600_000 });
  writeRun(fixture.root, 'alpha', { at: day2 });
  writeRun(fixture.root, 'beta', { at: day2 + 60_000, origin: { initiator: 'mcp.api_request' } });
  const build = randomUUID();
  writeRun(fixture.root, 'beta', { at: day2 + 120_000, origin: { initiator: 'mcp.api_request', build_id: build } });
  const model = ledger(fixture);
  const byDay = model.sessions.filter(session => session.grouping === 'host-and-day');
  assert.deepEqual(byDay.map(session => [session.hosts[0], session.local_day, session.totals.calls]),
    [['mcp.api_request', '2026-10-11', 1], ['cli.request', '2026-10-11', 1], ['cli.request', '2026-10-10', 2]]);
  const byBuild = model.sessions.find(session => session.grouping === 'build-and-day');
  assert.equal(byBuild.build_id, build);
  assert.equal(byBuild.local_day, '2026-10-11');
  const text = cli(fixture, ['sessions']).stdout;
  for (const session of byDay) {
    assert.ok(text.includes(`by day ${session.local_day}`));
    assert.ok(text.includes(session.grouping_basis));
  }
});

test('a secret-shaped path and a batch with withheld captures show the withheld markers and never a value', async t => {
  const fixture = project(t);
  await mcpSession(fixture, [{ stack: 'alpha', requests: [
    { method: 'POST', path: '/files', expect: [{ status: 201 }], capture: { fileId: 'id' } },
    { method: 'GET', path: '/files/{fileId}', expect: [{ json: 'id', equals: '{fileId}' }] },
    { method: 'GET', path: '/files/{missing}' },
  ] }]);
  writeRun(fixture.root, 'alpha', { at: Date.now(), origin: { session_id: randomUUID() }, operation: `GET /keys/${TOKEN}` });
  const json = cli(fixture, ['sessions', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const model = JSON.parse(json.stdout);
  const rows = model.sessions.flatMap(callRows);
  assert.ok(rows.some(row => row.operation === 'withheld'), 'the secret-shaped operation reads withheld');
  assert.equal(model.withheld['operation-key'], 1);
  const batch = model.sessions.flatMap(session => session.rows).find(row => row.kind === 'batch');
  assert.deepEqual(batch.rows.map(row => row.operation), ['POST /files', 'GET /files/{fileId}', null]);
  assert.equal(batch.rows[2].left.error, 'UNRESOLVED_PLACEHOLDER');
  const text = cli(fixture, ['sessions']).stdout;
  const page = join(fixture.root, 'page.html');
  assert.equal(cli(fixture, ['view', '--out', page]).status, 0);
  const html = readFileSync(page, 'utf8');
  for (const output of [json.stdout, text, html]) assert.equal(output.includes('ghp_'), false);
  assertNoValues(json.stdout);
  assertNoValues(text);
  assertNoPageValues(html);
  assert.ok(text.includes('withheld'));
  assert.ok(html.includes('<code>withheld</code>'));
});

test('a repository with no evidence and no usage log renders an empty state that names what would populate it', t => {
  const fixture = project(t, { stacks: [] });
  const text = cli(fixture, ['sessions']);
  assert.equal(text.status, 0, text.stderr);
  const model = ledger(fixture);
  assert.equal(model.sessions.length, 0);
  assert.equal(model.empty.reason, 'no-evidence');
  assert.ok(text.stdout.includes(model.empty.populate));
  const page = join(fixture.root, 'page.html');
  const view = cli(fixture, ['view', '--out', page]);
  assert.equal(view.status, 0, view.stderr);
  const html = readFileSync(page, 'utf8');
  assert.match(html, /<section id="sessions"/);
  assert.ok(html.includes(escapeText(model.empty.populate)));
});

test('2,000 run files complete and bound the rows per session with a named omission count', t => {
  const fixture = project(t, { stacks: ['alpha'] });
  const big = { session_id: randomUUID(), initiator: 'mcp.api_request' };
  const start = Date.now() - DAY;
  for (let i = 0; i < 2000; i++) writeRun(fixture.root, 'alpha', { at: start + i * 1000, origin: big, status: i % 10 ? 200 : 500 });
  const small = { session_id: randomUUID() };
  writeRun(fixture.root, 'alpha', { at: start - DAY, origin: small });
  const model = ledger(fixture);
  assert.equal(model.sessions.length, 2);
  const [large, other] = model.sessions;
  assert.equal(large.totals.calls, 2000);
  assert.equal(large.totals.status_classes['5xx'], 200);
  assert.equal(large.rows.length, model.row_bound);
  assert.equal(large.rows_shown, model.row_bound);
  assert.equal(large.rows_omitted, 2000 - model.row_bound);
  assert.equal(large.rows.at(-1).at, new Date(start + 1999 * 1000).toISOString(), 'the newest rows are the ones shown');
  assert.equal(other.rows_omitted, 0);
  assert.equal(model.totals.calls, 2001);
  const text = cli(fixture, ['sessions']);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(String(2000 - model.row_bound)));
});
