// SESSION-1 part 1: the session summary an agent quotes. The counting rules
// are pinned against synthetic ledger fixtures with the client's file shapes,
// and the end-to-end shape against a real MCP host process whose numbers must
// equal `sessions --json` for the same session. No request leaves loopback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CONTEXT_BASENAME, HOME_ENV_NAME, POINTER_CLI_NAME, PRODUCT, PROSE_PRODUCT_TITLE } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { buildSessionSummary, summaryLine, NOT_RECORDED } from '../lib/session-summary.mjs';
import { buildSessionLedger } from '../lib/session-ledger.mjs';
import { WORKBENCH_AGENT_TOOL } from '../lib/workbench-agent-tools.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const SID = 'AC' + 'a'.repeat(32);
const TOKEN = 'ghp_' + 'b'.repeat(36);
const SUMMARY_KEYS = ['session', 'since', 'calls', 'failed', 'unasserted', 'notes', 'drift', 'refusals', 'left_behind', 'line', 'open'];

let server, origin;
before(async () => {
  server = spawn(process.execPath, [join(ROOT, 'test/fixtures/field-batch-server.mjs')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  [{ origin }] = await once(server, 'message');
});
after(async () => { if (server.exitCode === null) { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; } });

const contract = { openapi: '3.0.0', info: { title: 'Files', version: '1' }, paths: {
  '/health': { get: { responses: { 200: { description: 'ok' } } } },
  '/files': { post: { responses: { 201: { description: 'created' } } } },
  // The fixture server answers 500 on a path containing 'error'; the route is
  // declared so the client records the failed assertion as an observation.
  '/files/error': { post: { responses: { 201: { description: 'created' } } } },
  '/files/{fileId}': { get: { parameters: [{ name: 'fileId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } } } } };

function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'session-summary-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'home'));
  const dir = join(root, LAYOUT.collection, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify(contract));
  writeFileSync(join(dir, 'stack.json'), JSON.stringify({ v: 1, name: 'alpha', default_environment: 'local', contract: 'openapi.json',
    environments: { local: { baseUrl: `${origin}/alpha`, auth: 'bearer:SUMMARY_TEST_TOKEN' } } }));
  writeFileSync(join(dir, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name: 'alpha' }, operations: {} }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'home', 'machine'), TZ: 'UTC', NO_COLOR: '1',
    API_CONTEXT_DIR: root, API_TIMEOUT_MS: '2000', SUMMARY_TEST_TOKEN: TOKEN };
  return { root, env };
}

// A run file with the client's shape; the URL and bodies carry values the
// summary must never show.
function writeRun(root, { at, sessionId, initiator = 'mcp.api_request', operation = 'GET /health', method = 'GET', status = 200, assertions, error, drift = [] }) {
  const runId = `run-${randomUUID()}`;
  const dir = join(root, LAYOUT.evidence, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId,
    origin: { v: 1, initiator, transport: 'api_request:http', observed_at: new Date(at).toISOString(), package_version: '0.1.0',
      build_id: null, session_id: sessionId, scope: { operation, protocol: 'http', environment: 'local', provider: `${origin}/alpha`, contract_digest: null } },
    request: { method, url: `${origin}/alpha/files/${SID}?token=${TOKEN}`, headers: { authorization: '[redacted]' }, body: { secret: TOKEN } },
    response: status === null ? undefined : { status, headers: {}, body: { id: SID, private: 'RESPONSE_VALUE_MUST_NOT_APPEAR' } },
    ...(assertions ? { assertions } : {}), ...(error ? { error: { code: error } } : {}), drift, durationMs: 4 }, null, 2));
  return runId;
}
// An envelope-outcome record: a refusal that sent nothing, or a batch.
function writeEnvelope(root, { at, sessionId, batch = false, refusal = null, left_behind = null, steps = [] }) {
  const id = `envelope-${randomUUID()}`;
  const dir = join(root, LAYOUT.evidence, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ v: 1, kind: 'envelope-outcome', id, stack: 'alpha',
    origin: { v: 1, initiator: 'mcp.api_request', observed_at: new Date(at).toISOString(), package_version: '0.1.0', build_id: null, session_id: sessionId },
    started_at: new Date(at).toISOString(), batch, attempted: batch ? steps.length : 0, stopped_early: false, ok: false,
    refusal: batch ? null : refusal, error: null, protocol: batch ? null : 'http', method: batch ? null : 'POST',
    steps, requests_declared: batch ? steps.length : 1, cleanup_declared: 0, left_behind }));
  return id;
}

const cli = ({ root, env }, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
function note({ root, env }, text, flags) {
  const result = cli({ root, env }, ['note', '--stack', 'alpha', 'GET /health', text, '--json', ...flags]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).note_id;
}
const ledgerSession = (fixture, id) => {
  const result = cli(fixture, ['sessions', '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).sessions.find(session => session.id === id);
};
const assertNoValues = text => {
  for (const value of [SID, TOKEN, 'RESPONSE_VALUE_MUST_NOT_APPEAR', '127.0.0.1', 'Bearer'])
    assert.equal(text.includes(value), false, `a value reached the summary: ${value.slice(0, 6)}…`);
};

test('the summary has the fixed shape, merges failures once per call and counts notes from the ledger, not the agent', t => {
  const fixture = project(t);
  const session = randomUUID(), start = Date.parse('2026-11-03T16:02:11.000Z');
  const ok = writeRun(fixture.root, { at: start, sessionId: session, assertions: { passed: 1, failed: 0 } });
  writeRun(fixture.root, { at: start + 1000, sessionId: session, status: 404 });                                     // failed, unasserted
  writeRun(fixture.root, { at: start + 2000, sessionId: session, status: 409, assertions: { passed: 0, failed: 1 } }); // failed once, not twice
  writeRun(fixture.root, { at: start + 3000, sessionId: session, status: 200, assertions: { passed: 1, failed: 1 } }); // failed assertion only
  const plain = writeRun(fixture.root, { at: start + 4000, sessionId: session, status: 200, drift: [{ kind: 'undeclared-status' }] });
  writeRun(fixture.root, { at: start + 5000, sessionId: session, status: null, error: 'REQUEST_TIMEOUT' });           // failed, no response
  writeEnvelope(fixture.root, { at: start + 6000, sessionId: session, refusal: 'PRODUCTION_WRITE_REFUSED' });
  // Another process's run and note never count toward this session.
  const other = writeRun(fixture.root, { at: start + 7000, sessionId: randomUUID(), assertions: { passed: 1, failed: 0 } });

  const first = note(fixture, 'Health answers before the database is ready.', ['--evidence', ok]);
  const second = note(fixture, 'Health is unauthenticated.', ['--alongside', '--evidence', plain]);
  const correction = note(fixture, 'Health answers after the database is ready.', ['--supersedes', first, '--evidence', plain]);
  note(fixture, 'A note from another process.', ['--alongside', '--evidence', other]);

  const summary = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.deepEqual(Object.keys(summary), SUMMARY_KEYS, 'the shape is fixed');
  assert.equal(summary.session, `process:${session}`);
  assert.equal(summary.since, '2026-11-03T16:02:11.000Z');
  assert.equal(summary.calls, 7, 'six runs and the refusal');
  assert.equal(summary.failed, 4, '404, 409 with a failed assertion (once), a failed assertion on a 200, and a timeout');
  assert.equal(summary.unasserted, 2, 'the 404 and the plain 200; the refusal and the timeout reached no response');
  assert.deepEqual(summary.notes, { added: 2, corrected: 1 });
  assert.equal(summary.drift, 1);
  assert.equal(summary.refusals, 1);
  assert.equal(summary.left_behind, 0);
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: 7 requests · 4 failed · 2 notes added, 1 corrected`);
  assert.match(summary.open, /^Open in Workbench: .*workbench$/);
  assert.ok(![first, second, correction].some(id => JSON.stringify(summary).includes(id)), 'note identities stay in the ledger');
  assertNoValues(JSON.stringify(summary));

  // The same numbers the person sees in the ledger for that session.
  const ledger = ledgerSession(fixture, summary.session);
  assert.equal(ledger.totals.calls, summary.calls);
  assert.equal(ledger.totals.calls_failed, summary.failed);
  assert.equal(ledger.totals.calls_unasserted, summary.unasserted);
  assert.equal(ledger.totals.notes_written, 3, 'the ledger counts every note citing the session; the summary splits corrections out');
  assert.equal(ledger.totals.notes_corrected, 1);
  assert.equal(ledger.totals.refusals, summary.refusals);
  assert.equal(ledger.totals.drift_records, summary.drift);
  // A successful save without durable run attribution cannot be added to
  // the ledger's number from an in-memory claim alone.
  const merged = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env, written: [
    { id: first }, { id: correction, corrected: true }, { id: 'observation:abc123', corrected: false }, { id: 'observation:abc123' }, { id: 'not an id' }] });
  assert.deepEqual(merged.notes, { added: NOT_RECORDED, corrected: NOT_RECORDED });
  assert.equal(merged.line, `${PROSE_PRODUCT_TITLE}: 7 requests · 4 failed · notes ${NOT_RECORDED}`);
});

test('every recorded non-2xx response fails once, including an asserted redirect', t => {
  const fixture = project(t), session = randomUUID();
  writeRun(fixture.root, { at: Date.now(), sessionId: session, status: 302, assertions: { passed: 1, failed: 0 } });
  writeRun(fixture.root, { at: Date.now(), sessionId: session, status: 101 });
  const summary = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.equal(summary.failed, 2);
  assert.equal(ledgerSession(fixture, summary.session).totals.calls_failed, 2);
});

test('an unreadable call receipt does not turn incomplete request totals into zero', t => {
  const fixture = project(t), session = randomUUID();
  const run = writeRun(fixture.root, { at: Date.now(), sessionId: session, status: 500 });
  writeFileSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${run}.json`), '{bad json');
  const summary = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  for (const field of ['calls', 'failed', 'unasserted', 'drift', 'refusals', 'left_behind']) assert.equal(summary[field], NOT_RECORDED, field);
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: requests not recorded · failures not recorded · notes not recorded`);
});

test('a leftover count the record did not carry reads not recorded, never zero, and unreadable knowledge withholds note counts', t => {
  const fixture = project(t);
  const session = randomUUID(), start = Date.now() - 60_000;
  const step = writeRun(fixture.root, { at: start, sessionId: session, method: 'POST', operation: 'POST /files', status: 201, assertions: { passed: 1, failed: 0 } });
  writeEnvelope(fixture.root, { at: start, sessionId: session, batch: true, left_behind: null,
    steps: [{ phase: 'requests', index: 0, protocol: 'http', method: 'POST', stack: 'alpha', evidence: step, status: 201, ok: true, refused: false, error: null, assertions: { passed: 1, failed: 0 } }] });
  const summary = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.equal(summary.calls, 1);
  assert.equal(summary.left_behind, NOT_RECORDED);
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: 1 request · 0 failed · no notes added`);
  const ledger = ledgerSession(fixture, summary.session);
  assert.equal(ledger.totals.leftovers_not_recorded, 1);
  assert.equal(ledger.totals.leftovers, 0);

  writeFileSync(join(fixture.root, LAYOUT.collection, 'alpha', CONTEXT_BASENAME), '{not json');
  const withheld = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env, written: [{ id: 'observation:x' }] });
  assert.deepEqual(withheld.notes, { added: NOT_RECORDED, corrected: NOT_RECORDED });
  assert.equal(withheld.line, `${PROSE_PRODUCT_TITLE}: 1 request · 0 failed · notes ${NOT_RECORDED}`);
});

test('a process that made no call summarizes honestly as zero with no start time', t => {
  const fixture = project(t);
  const summary = buildSessionSummary(fixture.root, { processSessionId: randomUUID(), env: fixture.env });
  assert.deepEqual(Object.keys(summary), SUMMARY_KEYS);
  assert.equal(summary.since, null);
  assert.deepEqual([summary.calls, summary.failed, summary.unasserted, summary.drift, summary.refusals, summary.left_behind], [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(summary.notes, { added: 0, corrected: 0 });
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: 0 requests · 0 failed · no notes added`);
  assert.equal(summaryLine({ calls: 1, failed: 1, notes: { added: 1, corrected: 0 } }), `${PROSE_PRODUCT_TITLE}: 1 request · 1 failed · 1 note added`);
  assert.equal(summaryLine({ calls: 2, failed: 0, notes: { added: 0, corrected: 1 } }), `${PROSE_PRODUCT_TITLE}: 2 requests · 0 failed · 0 notes added, 1 corrected`);
});

test('the Workbench hint advertises a verified portable CLI or a terminal instruction without inventing a bare executable', t => {
  const fixture = project(t);
  const empty = buildSessionSummary(fixture.root, { env: fixture.env });
  assert.equal(empty.open, "Open in Workbench: use your installed CLI from a terminal in this repository to run workbench");
  const shim = join(fixture.root, 'node_modules', '.bin', PRODUCT);
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, '#!/bin/sh\nexit 0\n'); chmodSync(shim, 0o755);
  const installed = buildSessionSummary(fixture.root, { env: fixture.env });
  assert.equal(installed.open, `Open in Workbench: ${POINTER_CLI_NAME} workbench`);
  assert.ok(!installed.open.includes('--show'));
});

test('the ledger totals keep their earlier fields and add the merged failure, unasserted and correction counts', t => {
  const fixture = project(t);
  const session = randomUUID();
  writeRun(fixture.root, { at: Date.now(), sessionId: session, status: 500 });
  const model = buildSessionLedger(fixture.root, { env: fixture.env });
  const totals = model.sessions.find(entry => entry.id === `process:${session}`).totals;
  for (const key of ['calls', 'sent', 'status_classes', 'assertions', 'notes_delivered', 'notes_written', 'refusals', 'leftovers', 'envelope_tokens',
    'calls_failed', 'calls_unasserted', 'notes_corrected', 'leftovers_not_recorded']) assert.ok(Object.hasOwn(totals, key), key);
  assert.equal(totals.calls_failed, 1); assert.equal(totals.calls_unasserted, 1);
  assert.equal(model.totals.calls_failed, 1, 'range totals sum the new fields');
  assert.deepEqual(model.sessions[0].rows[0].produced.notes_corrected, []);
});

// One MCP host process: initialize, then calls in any order interleaved with
// CLI notes, then exit. The summary is asked for inside the same process.
async function mcpHost({ root, env }) {
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', next = 1;
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.resume();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const answered = async id => {
    for (let waited = 0; ; waited += 10) {
      const line = out.split('\n').find(line => line.includes(`"id":${id},`));
      if (line) return JSON.parse(line);
      if (waited > 20_000) throw new Error(`MCP call ${id} did not answer`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const request = async (method, params) => { const id = next++; send({ jsonrpc: '2.0', id, method, params }); return answered(id); };
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'summary-test', version: '1' } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    request,
    async call(name, args) { const message = await request('tools/call', { name, arguments: args }); return { ...message.result, value: JSON.parse(message.result.content[0].text) }; },
    async close() { child.stdin.end(); await once(child, 'exit'); },
  };
}

test('an MCP host process reports its own session: the counts equal sessions --json and the envelope carries only counts and the fixed lines', async t => {
  const fixture = project(t);
  const host = await mcpHost(fixture);
  t.after(() => host.close());
  const tools = (await host.request('tools/list')).result.tools.find(tool => tool.name === WORKBENCH_AGENT_TOOL.name);
  assert.ok(tools.inputSchema.properties.action.enum.includes('summary'));

  const empty = await host.call('api_workbench', { action: 'summary' });
  assert.equal(empty.isError, undefined);
  assert.equal(empty.value.calls, 0);
  assert.equal(empty.content.length, 1, 'no pending-handoff hint rides on a summary');

  const health = (await host.call('api_request', { stack: 'alpha', method: 'GET', path: '/health', expect: [{ status: 200 }] })).value;
  const failed = (await host.call('api_request', { stack: 'alpha', method: 'POST', path: '/files/error', expect: [{ status: 201 }] })).value;
  assert.equal(failed.status, 500, 'one 500 with a failed assertion counts once');
  const wrong = (await host.call('api_request', { stack: 'alpha', method: 'GET', path: '/health', expect: [{ status: 404 }] })).value;
  assert.equal(wrong.status, 200);
  const plain = (await host.call('api_request', { stack: 'alpha', method: 'GET', path: '/files/one' })).value;
  const refused = (await host.call('api_request', { stack: 'alpha', method: 'POST', path: '/files', reveal_secrets: 'yes' })).value;
  assert.equal(refused.error.code, 'REVEAL_SECRETS_INVALID');

  const first = note(fixture, 'Health answers before the database is ready.', ['--evidence', health.evidence]);
  note(fixture, 'Health is unauthenticated.', ['--alongside', '--evidence', plain.evidence]);
  note(fixture, 'Health answers after the database is ready.', ['--supersedes', first, '--evidence', plain.evidence]);

  const result = await host.call('api_workbench', { action: 'summary' });
  const summary = result.value;
  assert.deepEqual(Object.keys(summary), SUMMARY_KEYS);
  assert.match(summary.session, /^process:[a-f0-9-]{36}$/);
  assert.equal(summary.calls, 5);
  assert.equal(summary.failed, 2);
  assert.equal(summary.unasserted, 1);
  assert.deepEqual(summary.notes, { added: 2, corrected: 1 });
  assert.equal(summary.refusals, 1);
  assert.equal(summary.left_behind, 0);
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: 5 requests · 2 failed · 2 notes added, 1 corrected`);
  assert.ok(result.content[0].text.length < 600, `about 150 tokens, not ${result.content[0].text.length} bytes`);
  assertNoValues(result.content[0].text);
  assert.ok(!result.content[0].text.includes(health.evidence), 'run ids are not repeated in the summary');

  const ledger = ledgerSession(fixture, summary.session);
  assert.deepEqual(ledger.hosts, ['mcp.api_request']);
  assert.equal(ledger.started_at, summary.since);
  assert.equal(ledger.totals.calls, summary.calls);
  assert.equal(ledger.totals.calls_failed, summary.failed);
  assert.equal(ledger.totals.calls_unasserted, summary.unasserted);
  assert.equal(ledger.totals.notes_written - ledger.totals.notes_corrected, summary.notes.added);
  assert.equal(ledger.totals.notes_corrected, summary.notes.corrected);
  assert.equal(ledger.totals.refusals, summary.refusals);
  assert.equal(ledger.totals.leftovers, summary.left_behind);
});

test('MCP authored operation lessons agree with the ledger when evidence is attributable, otherwise notes are not recorded', async t => {
  const fixture = project(t);
  writeFileSync(join(fixture.root, LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture', name: 'Fixture' }, nodes: [{ id: 'api', kind: 'service', name: 'API' }], dependencies: [],
    context: { providers: [{ node: 'fixture#api', provider: 'alpha', environment: 'local', protocol: 'http' }] } }));
  const host = await mcpHost(fixture);
  t.after(() => host.close());
  const health = (await host.call('api_request', { stack: 'alpha', method: 'GET', path: '/health', expect: [{ status: 200 }] })).value;
  const saved = await host.call('api_context_record', { node: 'fixture#api', operation: 'GET /health',
    note: 'The fixture health route is available before other requests.', evidence: [{ path: `${LAYOUT.evidence}/alpha/${health.evidence}.json` }] });
  assert.equal(saved.isError, undefined, JSON.stringify(saved.value));
  assert.equal(saved.value.state, 'captured');
  const summary = (await host.call('api_workbench', { action: 'summary' })).value;
  assert.deepEqual(summary.notes, { added: 1, corrected: 0 });
  assert.equal(ledgerSession(fixture, summary.session).totals.notes_written, summary.notes.added);

  const unlinked = await host.call('api_context_record', { node: 'fixture#api', operation: 'GET /health',
    note: 'The fixture documentation describes health as a lightweight check.' });
  assert.equal(unlinked.isError, undefined, JSON.stringify(unlinked.value));
  assert.equal(unlinked.value.state, 'captured');
  const incomplete = (await host.call('api_workbench', { action: 'summary' })).value;
  assert.deepEqual(incomplete.notes, { added: NOT_RECORDED, corrected: NOT_RECORDED });
  assert.equal(incomplete.calls, 1);
  assert.match(incomplete.line, /notes not recorded$/);
});

test('a failed HTTP assertion remains a failure when shared capture is disabled', async t => {
  const fixture = project(t);
  const host = await mcpHost(fixture);
  t.after(() => host.close());
  const result = (await host.call('api_request', { stack: 'alpha', method: 'GET', path: '/health',
    capture_context: false, expect: [{ status: 201 }] })).value;
  assert.equal(result.status, 200);
  assert.equal(result.assertions.failed, 1);
  assert.equal(result.context_capture.state, 'disabled');
  const summary = (await host.call('api_workbench', { action: 'summary' })).value;
  assert.deepEqual([summary.calls, summary.failed, summary.unasserted], [1, 1, 0]);
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: 1 request · 1 failed · no notes added`);
  const ledger = ledgerSession(fixture, summary.session);
  assert.equal(ledger.totals.calls_failed, 1);
  assert.deepEqual(ledger.totals.assertions, { passed: 0, failed: 1, calls_asserted: 1 });
});

test('a missing HTTP receipt with surviving records cannot turn a known failure into zero', async t => {
  const fixture = project(t);
  fixture.env.API_USAGE_LOG = join(fixture.env.HOME, 'usage.jsonl');
  const host = await mcpHost(fixture);
  t.after(() => host.close());
  const result = (await host.call('api_request', { stack: 'alpha', method: 'GET', path: '/health', expect: [{ status: 201 }] })).value;
  assert.equal(result.status, 200);
  assert.equal(result.assertions.failed, 1);
  const receipt = JSON.parse(readFileSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${result.evidence}.json`)));
  const usage = readFileSync(fixture.env.API_USAGE_LOG, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(usage.find(row => row.runId === result.evidence).session_id, receipt.origin.session_id);
  rmSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${result.evidence}.json`));
  const summary = (await host.call('api_workbench', { action: 'summary' })).value;
  for (const key of ['calls', 'failed', 'unasserted', 'drift', 'refusals', 'left_behind']) assert.equal(summary[key], NOT_RECORDED, key);
  assert.deepEqual(summary.notes, { added: NOT_RECORDED, corrected: NOT_RECORDED });
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: requests not recorded · failures not recorded · notes not recorded`);
});

test('a retained batch envelope keeps missing receipt counts unknown when usage and shared capture are absent', t => {
  const fixture = project(t), session = randomUUID(), at = Date.now();
  fixture.env.API_USAGE_LOG = '';
  const run = writeRun(fixture.root, { at, sessionId: session, status: 200,
    assertions: { passed: 1, failed: 0 }, drift: [{ kind: 'undeclared-status' }] });
  writeEnvelope(fixture.root, { at, sessionId: session, batch: true, left_behind: 0,
    steps: [{ phase: 'requests', protocol: 'http', method: 'GET', stack: 'alpha', evidence: run,
      status: 200, ok: true, refused: false, error: null, assertions: { passed: 1, failed: 0 } }] });
  const before = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.equal(before.calls, 1); assert.equal(before.drift, 1);
  rmSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${run}.json`));
  const ledger = buildSessionLedger(fixture.root, { env: fixture.env });
  assert.equal(ledger.sessions[0].rows[0].rows[0].basis.receipt_state, 'missing');
  assert.equal(ledger.sources.incomplete_call_records, 1);
  const after = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  for (const key of ['calls', 'failed', 'unasserted', 'drift', 'refusals', 'left_behind'])
    assert.equal(after[key], NOT_RECORDED, key);
  assert.deepEqual(after.notes, { added: NOT_RECORDED, corrected: NOT_RECORDED });
  const other = randomUUID();
  writeRun(fixture.root, { at: at + 1000, sessionId: other, assertions: { passed: 1, failed: 0 } });
  assert.equal(buildSessionSummary(fixture.root, { processSessionId: other, env: fixture.env }).line,
    `${PROSE_PRODUCT_TITLE}: 1 request · 0 failed · no notes added`);
});

test('a clone ignores inherited missing receipts and counts its own healthy request and new note', t => {
  const fixture = project(t), inheritedSession = randomUUID(), session = randomUUID();
  fixture.env.API_USAGE_LOG = '';
  const oldRun = writeRun(fixture.root, { at: Date.now() - 60_000, sessionId: inheritedSession, status: 500 });
  note(fixture, 'This inherited lesson has a private receipt on the original machine.', ['--evidence', oldRun]);
  rmSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${oldRun}.json`));
  const ownRun = writeRun(fixture.root, { at: Date.now(), sessionId: session, status: 200, assertions: { passed: 1, failed: 0 } });
  const summary = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.equal(summary.calls, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.notes, { added: 0, corrected: 0 });
  assert.equal(summary.line, `${PROSE_PRODUCT_TITLE}: 1 request · 0 failed · no notes added`);
  note(fixture, 'This new lesson belongs to the current session.', ['--alongside', '--evidence', ownRun]);
  const after = buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.equal(after.line, `${PROSE_PRODUCT_TITLE}: 1 request · 0 failed · 1 note added`);
  assert.equal(buildSessionLedger(fixture.root, { env: fixture.env }).sources.incomplete_call_records, 1,
    'the repository-wide missing receipt remains visible as a diagnostic');
});

test('missing and unreadable runs affect their attributed session; unattributed files still withhold every summary', t => {
  const fixture = project(t), session = randomUUID(), other = randomUUID(), at = Date.now();
  writeRun(fixture.root, { at, sessionId: session, assertions: { passed: 1, failed: 0 } });
  const missing = writeRun(fixture.root, { at, sessionId: other, status: 500 });
  const corrupt = writeRun(fixture.root, { at, sessionId: other, status: 500 });
  const log = join(fixture.env.HOME, 'usage.jsonl');
  fixture.env.API_USAGE_LOG = log;
  const rows = [missing, corrupt].map(runId => ({ runId, session_id: other, project: basename(fixture.root), ts: new Date(at).toISOString() }));
  writeFileSync(log, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  rmSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${missing}.json`));
  writeFileSync(join(fixture.root, LAYOUT.evidence, 'alpha', `${corrupt}.json`), '{bad json');
  const own = () => buildSessionSummary(fixture.root, { processSessionId: session, env: fixture.env });
  assert.equal(own().line, `${PROSE_PRODUCT_TITLE}: 1 request · 0 failed · no notes added`);
  const incomplete = buildSessionSummary(fixture.root, { processSessionId: other, env: fixture.env });
  assert.equal(incomplete.line, `${PROSE_PRODUCT_TITLE}: requests not recorded · failures not recorded · notes not recorded`);
  // Old usage rows without process attribution cannot prove which session lost a receipt.
  writeFileSync(log, rows.map(({ session_id, ...row }) => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(own().failed, NOT_RECORDED);
  writeFileSync(log, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(fixture.root, LAYOUT.evidence, 'alpha', `run-${randomUUID()}.json`), '{bad json');
  assert.equal(own().line, `${PROSE_PRODUCT_TITLE}: requests not recorded · failures not recorded · notes not recorded`);
});
