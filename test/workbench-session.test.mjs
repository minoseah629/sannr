// SESSION-1 part 3: the Workbench session view model. Synthetic run files
// with the client's shape, real notes written by the CLI citing them, and a
// real git repository for the uncommitted-knowledge footer. No request leaves
// the machine; no value from a request or response may reach the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CONTEXT_BASENAME, HOME_ENV_NAME, PROSE_PRODUCT_TITLE } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { workbenchHandlers } from '../lib/workbench-engine.mjs';
import { workbenchSessionModel, projectDirectoryState, SESSION_ID } from '../lib/workbench-session.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'ghp_' + 'b'.repeat(36);
const contract = { openapi: '3.0.0', info: { title: 'Files', version: '1' }, paths: {
  '/health': { get: { responses: { 200: { description: 'ok' } } } },
  '/files/{fileId}': { get: { parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } } } };

function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-session-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'home'));
  const dir = join(root, LAYOUT.collection, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify(contract));
  writeFileSync(join(dir, 'stack.json'), JSON.stringify({ v: 1, name: 'alpha', default_environment: 'local', contract: 'openapi.json',
    environments: { local: { baseUrl: 'https://alpha.example.test', auth: 'bearer:SESSION_TEST_TOKEN' } } }));
  writeFileSync(join(dir, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name: 'alpha' }, operations: {} }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'home', 'machine'), TZ: 'UTC', NO_COLOR: '1',
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'home', 'machine', 'usage.jsonl'), API_FRICTION_OFF: '1', SESSION_TEST_TOKEN: TOKEN };
  return { root, env };
}
function writeRun(root, { at, sessionId, operation = 'GET /health', method = 'GET', status = 200, assertions }) {
  const runId = `run-${randomUUID()}`;
  const dir = join(root, LAYOUT.evidence, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId,
    origin: { v: 1, initiator: 'mcp.api_request', transport: 'api_request:http', observed_at: new Date(at).toISOString(), package_version: '0.1.0',
      build_id: null, session_id: sessionId, scope: { operation, protocol: 'http', environment: 'local', provider: 'https://alpha.example.test', contract_digest: null } },
    request: { method, url: `https://alpha.example.test/files/${SID}?token=${TOKEN}`, headers: { authorization: '[redacted]' }, body: { secret: TOKEN } },
    response: { status, headers: {}, body: { id: SID, private: 'RESPONSE_VALUE_MUST_NOT_APPEAR' } }, ...(assertions ? { assertions } : {}), drift: [], durationMs: 4 }, null, 2));
  return runId;
}
const cli = ({ root, env }, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
function note(fixture, text, flags) {
  const result = cli(fixture, ['note', '--stack', 'alpha', 'GET /health', text, '--json', ...flags]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).note_id;
}
const git = (root, args) => spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root, encoding: 'utf8' });
const assertNoValues = text => {
  for (const value of [SID, TOKEN, 'RESPONSE_VALUE_MUST_NOT_APPEAR', 'alpha.example.test', 'Bearer'])
    assert.equal(text.includes(value), false, `a value reached the session view: ${value.slice(0, 6)}…`);
};

test('the session view carries the fixed summary, the notes diff from note history, this session’s attention, its rows and the project directory state', t => {
  const fixture = project(t), session = randomUUID(), start = Date.parse('2026-11-03T16:02:11.000Z');
  const ok = writeRun(fixture.root, { at: start, sessionId: session, assertions: { passed: 1, failed: 0 } });
  const missing = writeRun(fixture.root, { at: start + 1000, sessionId: session, operation: 'GET /files/{fileId}', status: 404 });
  const other = writeRun(fixture.root, { at: start + 2000, sessionId: randomUUID() });
  const first = note(fixture, 'Health answers before the database is ready.', ['--evidence', ok]);
  note(fixture, 'Health is unauthenticated.', ['--alongside', '--evidence', missing]);
  const correction = note(fixture, 'Health answers after the database is ready.', ['--supersedes', first, '--evidence', ok]);
  note(fixture, 'Written by another process.', ['--alongside', '--evidence', other]);
  note(fixture, 'Not attributable: no evidence cited.', ['--alongside']);

  const model = workbenchSessionModel(fixture.root, `process:${session}`, { env: fixture.env });
  assert.equal(model.session.id, `process:${session}`);
  assert.deepEqual(model.session.hosts, ['mcp.api_request']);
  assert.equal(model.session.started_at, '2026-11-03T16:02:11.000Z');
  assert.deepEqual(model.session.stacks, ['alpha']);
  assert.equal(model.summary.line, `${PROSE_PRODUCT_TITLE}: 2 requests · 1 failed · 2 notes added, 1 corrected`);
  assert.equal(model.rows_shown, 2); assert.equal(model.rows_omitted, 0);
  assert.deepEqual(model.rows.map(row => row.basis.run_id), [ok, missing]);

  const changes = model.changes;
  assert.equal(changes.added, 2); assert.equal(changes.corrected, 1); assert.equal(changes.omitted, 0);
  assert.deepEqual(changes.unavailable, []);
  assert.equal(changes.stacks.length, 1); assert.equal(changes.stacks[0].stack, 'alpha');
  const [operation] = changes.stacks[0].operations;
  assert.equal(operation.operation, 'GET /health'); assert.match(operation.operation_anchor, /^operation-/);
  const kinds = operation.items.map(item => [item.kind, item.text]);
  assert.deepEqual(kinds, [['added', 'Health answers before the database is ready.'], ['added', 'Health is unauthenticated.'], ['corrected', 'Health answers after the database is ready.']]);
  const corrected = operation.items[2];
  assert.equal(corrected.id, correction);
  assert.equal(corrected.superseded.id, first);
  assert.equal(corrected.superseded.text, 'Health answers before the database is ready.');
  assert.deepEqual(corrected.evidence, [ok]);
  assert.ok(corrected.by && corrected.at && corrected.superseded.at, 'author and dates travel with each side of the diff');
  assert.deepEqual(operation.items[1].evidence, [missing]);
  assert.ok(!JSON.stringify(changes).includes('another process'), 'a note citing another session’s run is not this session’s change');
  assert.ok(!JSON.stringify(changes).includes('Not attributable'), 'a note without evidence is not attributed to any session');

  assert.deepEqual(model.attention.items.map(item => [item.kind, item.basis.run_id]), [['http-failure', missing]]);
  assert.equal(model.repository.state, 'unavailable', 'not a git repository');
  assert.equal(model.repository.changed, null);
  assertNoValues(JSON.stringify(model));

  assert.equal(git(fixture.root, ['init', '-q']).status, 0);
  const uncommitted = workbenchSessionModel(fixture.root, `process:${session}`, { env: fixture.env }).repository;
  assert.equal(uncommitted.state, 'uncommitted');
  assert.ok(uncommitted.changed > 0);
  assert.equal(uncommitted.directory, LAYOUT.directory);
  assert.ok(!JSON.stringify(uncommitted).includes('stack.json'), 'the footer carries a count, never a path');
  assert.equal(git(fixture.root, ['add', '-A']).status, 0);
  assert.equal(git(fixture.root, ['commit', '-q', '-m', 'knowledge']).status, 0);
  assert.equal(workbenchSessionModel(fixture.root, `process:${session}`, { env: fixture.env }).repository.state, 'clean');
});

test('a forged or malformed session id is refused with a named code and the handler takes only the session field', async t => {
  const fixture = project(t), session = randomUUID();
  writeRun(fixture.root, { at: Date.now(), sessionId: session });
  const handlers = workbenchHandlers(fixture.root);
  const model = await handlers.session.run({ session: `process:${session}` });
  assert.equal(model.session.id, `process:${session}`);
  await assert.rejects(handlers.session.run({ session: `process:${randomUUID()}` }), { code: 'WORKBENCH_SESSION_UNKNOWN' });
  await assert.rejects(handlers.session.run({ session: '../evidence' }), { code: 'WORKBENCH_SESSION_ID_INVALID' });
  await assert.rejects(handlers.session.run({ session: `process:${session}`, path: 'x' }), { code: 'WORKBENCH_PARAMETERS_INVALID' });
  await assert.rejects(handlers.session.run({}), { code: 'WORKBENCH_SESSION_ID_INVALID' });
  assert.ok(SESSION_ID.test('day:cli.request:date not recorded'));
  assert.ok(!SESSION_ID.test('process:x'));
});

test('the project directory state never carries a path and reads unavailable when git cannot answer', () => {
  const unavailable = projectDirectoryState('/nonexistent', { run: () => ({ status: 128, stdout: '' }) });
  assert.deepEqual([unavailable.state, unavailable.changed], ['unavailable', null]);
  const thrown = projectDirectoryState('/nonexistent', { run: () => { throw new Error('ENOENT'); } });
  assert.equal(thrown.state, 'unavailable');
  const dirty = projectDirectoryState('/nonexistent', { run: () => ({ status: 0, stdout: ' M .sannr/stacks/alpha/sannr.json\n?? .sannr/evidence/secret-path.json\n' }) });
  assert.deepEqual([dirty.state, dirty.changed], ['uncommitted', 2]);
  assert.ok(!JSON.stringify(dirty).includes('secret-path'));
  assert.deepEqual([projectDirectoryState('/nonexistent', { run: () => ({ status: 0, stdout: '' }) }).state], ['clean']);
});
