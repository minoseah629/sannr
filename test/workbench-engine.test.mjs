import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { operationId } from '../lib/operation-context.mjs';
import { workbenchSnapshot, workbenchHandlers, WORKBENCH_SNAPSHOT_BYTES } from '../lib/workbench-engine.mjs';
import { WORKBENCH_LIMITS } from '../lib/workbench-server.mjs';
import { createWorkbenchAgent } from '../lib/workbench-agent.mjs';
import { appendWorkbenchEvent } from '../lib/workbench-handoff.mjs';
import { inspectRecordedResponse } from '../lib/response-inspection.mjs';
import { sanitizeEvidenceBody } from '../lib/response-redaction.mjs';
import { createFixtureStack, fixtureEvidencePath, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT, layoutFor } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
function isolatedSnapshot(root) {
  const home = join(root, 'test-home'); mkdirSync(home, { recursive: true });
  const source = `const {workbenchSnapshot}=await import(${JSON.stringify(new URL('../lib/workbench-engine.mjs', import.meta.url).href)}); console.log(JSON.stringify(await workbenchSnapshot(process.cwd())));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root,
    env: { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(root, 'test-machine'), API_CONTEXT_DIR: root,
      API_USAGE_LOG: join(root, 'test-machine', 'usage.jsonl'), API_FRICTION_OFF: '1' }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
}
function retainedCall(root, { id, at, initiator = 'cli.request', session = randomUUID(), operation = 'GET /health', status = 200 }) {
  const runId = `run-${id}`, record = { runId, origin: { v: 1, initiator, session_id: session, observed_at: at,
    scope: { protocol: 'http', operation } }, request: { method: operation.split(' ')[0] },
    response: { status, body: { fixture_private_value: 'BODY_MUST_NOT_REACH_INDEX' } } };
  writeFileSync(join(root, fixtureEvidencePath(), `${runId}.json`), JSON.stringify(record));
  return { runId, session };
}

test('inspector re-masks old private evidence, bounds output and never trusts redaction metadata', t => {
  const root = fixture(t); createFixtureStack(root);
  const runId = 'run-inspector', dir = join(root, fixtureEvidencePath());
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, response: { status: 200,
    body: { password: 'abc', echo: 'prefix abc suffix', download: 'https://files.example.test/o?X-Amz-Signature=short', message: '<img src=x onerror=alert(1)>', long: 'x'.repeat(40_000) },
    body_secrets: { replaced: false, replacements: 'private-metadata', body: 'private-metadata' },
  } }));
  const read = inspectRecordedResponse(root, { runId, stack: 'fixture' });
  assert.equal(read.status, 200); assert.ok(read.omitted_bytes > 0); assert.ok(Buffer.byteLength(read.body_text) <= 32768);
  assert.ok(!read.body_text.includes('prefix abc')); assert.ok(!read.body_text.includes('X-Amz-Signature'));
  assert.ok(!JSON.stringify(read).includes('private-metadata'));
  assert.equal(read.recorded_redactions.replacements, null);
  assert.throws(() => inspectRecordedResponse(root, { runId: '../escape', stack: 'fixture' }), { code: 'EVIDENCE_ID_INVALID' });
  symlinkSync(join(dir, `${runId}.json`), join(dir, 'run-link.json'));
  assert.throws(() => inspectRecordedResponse(root, { runId: 'run-link', stack: 'fixture' }), { code: 'EVIDENCE_FILE_UNSAFE' });
});

test('response masking covers short credential aliases and wrapped signed URLs without claiming arbitrary PII detection', () => {
  for (const value of ['https://files.example.test/o?sig=a', 'https://files.example.test/o?X-Goog-Signature=a', 'https://files.example.test/o?x=1&amp;signature=a']) {
    const masked = sanitizeEvidenceBody({ password: 'ab', echo: 'ab', nested: JSON.stringify({ download: value }), value64: Buffer.from(value).toString('base64'), safe: 'fixture' });
    assert.equal(masked.body.safe, 'fixture');
    assert.match(masked.body.password, /withheld/); assert.match(masked.body.echo, /withheld/);
    assert.match(masked.body.nested, /withheld/); assert.match(masked.body.value64, /withheld/);
  }
});

test('snapshot opens read-only, exposes safe auth reference names and missing setup honestly', async t => {
  const root = fixture(t);
  const blank = await workbenchSnapshot(root);
  assert.equal(blank.setup.state, 'not configured'); assert.equal(existsSync(join(root, LAYOUT.directory)), false);
  createFixtureStack(root, { environmentConfig: { auth: 'bearer:WORKBENCH_TEST_TOKEN' } });
  const before = readFileSync(join(root, LAYOUT.collection, 'fixture', 'stack.json'), 'utf8');
  const snapshot = await workbenchSnapshot(root);
  assert.equal(snapshot.stacks[0].environments[0].credential_reference, 'bearer:WORKBENCH_TEST_TOKEN');
  assert.deepEqual(snapshot.stacks[0].environments[0].credential_readiness.vars, ['WORKBENCH_TEST_TOKEN']);
  assert.equal(readFileSync(join(root, LAYOUT.collection, 'fixture', 'stack.json'), 'utf8'), before);
  assert.equal(snapshot.setup.survey.state, 'not available');
  assert.throws(() => layoutFor('fixture', 'requests'), { code: 'LAYOUT_COLLECTION_CONFLICT' });
});

test('local appearance preserves custom ignore text; unsafe settings refuses before changing it', async t => {
  const root = fixture(t), dir = join(root, LAYOUT.evidence, 'workbench');
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.gitignore'), '# custom comment\n');
  const handlers = workbenchHandlers(root);
  assert.deepEqual(await handlers.settings.run({ theme: 'paper' }), { theme: 'paper' });
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^# custom comment\n/);
  assert.equal((await workbenchSnapshot(root)).settings.theme, 'paper');
  await assert.rejects(handlers.settings.run({ theme: 'paper', path: '../escape' }), { code: 'WORKBENCH_PARAMETERS_INVALID' });
  rmSync(join(dir, 'settings.json')); const outside = join(root, 'outside.json'); writeFileSync(outside, '{}');
  symlinkSync(outside, join(dir, 'settings.json')); const before = readFileSync(join(dir, '.gitignore'), 'utf8');
  await assert.rejects(handlers.settings.run({ theme: 'ink' }));
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), before); assert.equal(readFileSync(outside, 'utf8'), '{}');
  await assert.rejects(handlers.saved.run({ action: 'run', ref: 'a', inputFile: '../outside.json' }), { code: 'SAVED_ACTION_FIELD_INVALID' });
});

test('one noisy receipt cannot make the snapshot exceed the HTTP byte limit; totals and omission basis survive', t => {
  const root = fixture(t); createFixtureStack(root);
  const runId = 'run-noisy-review';
  const record = { runId, origin: { v: 1, initiator: 'cli.request', observed_at: '2026-10-17T12:00:00Z',
    scope: { protocol: 'http', operation: 'GET /health' } }, request: { method: 'GET' }, response: { status: 503 },
    drift: Array.from({ length: 30000 }, () => ({ kind: 'undeclared-status' })) };
  const bytes = JSON.stringify(record); assert.ok(Buffer.byteLength(bytes) < 8 * 1024 * 1024);
  writeFileSync(join(root, fixtureEvidencePath(), `${runId}.json`), bytes);
  const snapshot = isolatedSnapshot(root), row = snapshot.activity.sessions[0].rows[0];
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: snapshot })) <= WORKBENCH_SNAPSHOT_BYTES);
  assert.equal(snapshot.activity.totals.calls, 1); assert.equal(snapshot.activity.totals.drift_records, 30000);
  assert.equal(row.operation, 'GET /health'); assert.match(row.operation_anchor, /^operation-/);
  assert.equal(row.produced.drift_total, 30000); assert.equal(row.produced.drift.length, 16);
  assert.equal(row.produced.drift_omitted, 29984);
  assert.equal(snapshot.snapshot_omissions.array_items, 29984);
  assert.match(snapshot.snapshot_omissions.details[0].path, /produced\.drift$/);
  assert.ok(snapshot.activity.needs_attention.groups.some(group => group.kind === 'http-failure'));
});

test('Workbench groups consecutive command-line processes before its card bound and preserves row identities and omissions', t => {
  const root = fixture(t); createFixtureStack(root);
  const ids = Array.from({ length: 120 }, (_, i) => retainedCall(root, { id: `group-${i}`,
    at: new Date(Date.parse('2026-10-22T10:00:00Z') + i * 1000).toISOString() }));
  const snapshot = isolatedSnapshot(root), activity = snapshot.activity;
  assert.equal(activity.totals.calls, 120);
  assert.equal(activity.totals.sessions, 120, 'canonical process-session totals are not rewritten as display groups');
  assert.equal(activity.sessions.length, 1, 'grouping must precede the previous twenty-process display limit');
  const group = activity.sessions[0];
  assert.equal(group.grouping, 'activity-window');
  assert.equal(group.source_session_count, 120);
  assert.equal(group.totals.calls, 120);
  assert.equal(group.rows_shown, 100);
  assert.equal(group.rows_omitted, 20);
  assert.equal(activity.ledger_rows_omitted, 0);
  assert.deepEqual(group.rows.map(row => row.basis.run_id), ids.slice(20).map(item => item.runId));
  assert.deepEqual(group.rows.map(row => row.attribution.session_id), ids.slice(20).map(item => item.session));
  assert.deepEqual(group.rows.map(row => row.ledger_session_id), ids.slice(20).map(item => `process:${item.session}`));
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: snapshot })) <= WORKBENCH_SNAPSHOT_BYTES);
  assert.ok(!JSON.stringify(snapshot).includes('BODY_MUST_NOT_REACH_INDEX'));
  const sharedRoot = fixture(t); createFixtureStack(sharedRoot);
  const sharedSession = randomUUID();
  for (let i = 0; i < 120; i++) retainedCall(sharedRoot, { id: `shared-${i}`, session: sharedSession,
    at: new Date(Date.parse('2026-10-22T10:00:00Z') + i * 1000).toISOString() });
  const shared = isolatedSnapshot(sharedRoot).activity;
  assert.equal(shared.totals.calls, 120);
  assert.equal(shared.totals.sessions, 1);
  assert.equal(shared.ledger_rows_omitted, 20, 'the canonical per-process limit stays visible separately from display omissions');
  assert.equal(shared.sessions[0].totals.calls, 100, 'a presentation group never invents membership for rows already omitted upstream');
  assert.equal(shared.sessions[0].rows_shown, 100);
  assert.equal(shared.sessions[0].rows_omitted, 0, 'upstream omissions must not be counted again as Workbench omissions');
});

test('presentation groups break on another initiator, a ten-minute gap, and unknown attribution', t => {
  const root = fixture(t); createFixtureStack(root);
  const rows = [
    ['a', '10:00:00', 'cli.request'], ['b', '10:01:00', 'cli.request'],
    ['c', '10:02:00', 'mcp.api_request'], ['d', '10:03:00', 'cli.request'],
    ['e', '10:14:00', 'cli.request'], ['f', '10:15:00', 'unknown'],
    ['g', '10:16:00', 'unknown'], ['h', '10:17:00', 'cli.request'],
  ];
  for (const [id, time, initiator] of rows) retainedCall(root, { id, at: `2026-10-22T${time}Z`, initiator });
  const groups = isolatedSnapshot(root).activity.sessions;
  assert.deepEqual(groups.map(group => group.rows.map(row => row.basis.run_id)), [
    ['run-h'], ['run-g'], ['run-f'], ['run-e'], ['run-d'], ['run-c'], ['run-a', 'run-b'],
  ]);
  assert.equal(groups.at(-1).initiator, 'cli.request');
  assert.equal(groups[1].initiator, 'unknown');
});

test('API index distinguishes retained failures and notes from absent or unreadable call history without exposing bodies', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Index fixture', version: '1' },
    paths: { '/failed': { get: { responses: { 404: { description: 'missing' } } } }, '/uncalled': { get: { responses: { 200: { description: 'ok' } } } } } }));
  createFixtureStack(root, { contract: 'openapi.json' });
  retainedCall(root, { id: 'failed-index', at: '2026-10-22T10:00:00Z', operation: 'GET /failed', status: 404 });
  writeFileSync(fixtureContextFile(root), JSON.stringify({ v: 0, api: { name: 'Index fixture' }, operations: {
    'GET /uncalled': { notes: ['Keep this note visible without a call.'], notes_provenance: [{ by: 'agent', at: '2026-10-22' }] },
  } }));
  const before = isolatedSnapshot(root), get = (snapshot, op) => snapshot.stacks[0].operations.find(row => row.operation === op);
  assert.equal(get(before, 'GET /failed').has_recorded_activity, true);
  assert.equal(get(before, 'GET /failed').has_recorded_failure, true);
  assert.equal(get(before, 'GET /failed').recorded_call_state, 'recorded');
  assert.equal(get(before, 'GET /uncalled').has_recorded_activity, true, 'authored notes keep an operation in With activity');
  assert.equal(get(before, 'GET /uncalled').recorded_call_state, 'not-recorded');
  assert.equal(get(before, 'GET /uncalled').has_recorded_failure, false);
  writeFileSync(join(root, fixtureEvidencePath(), 'run-unreadable.json'), '{');
  const after = isolatedSnapshot(root);
  assert.equal(get(after, 'GET /uncalled').recorded_call_state, 'unknown', 'an unreadable receipt cannot prove no calls were retained');
  assert.ok(!JSON.stringify(after).includes('BODY_MUST_NOT_REACH_INDEX'));
});

test('snapshot byte fallback keeps exact navigation identities and truthful totals for long operation inventories', t => {
  const root = fixture(t), paths = {};
  for (let index = 0; index < 500; index++) paths[`/route-${index}/${'segment/'.repeat(145)}resource`] = { get: { responses: { 200: { description: 'ok' } } } };
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Long path fixture', version: '1' }, paths }));
  createFixtureStack(root, { contract: 'openapi.json' });
  const snapshot = isolatedSnapshot(root), stack = snapshot.stacks[0];
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: snapshot })) <= WORKBENCH_SNAPSHOT_BYTES);
  assert.equal(snapshot.snapshot_limits.byte_fallback, true);
  assert.equal(stack.operations_total, 500); assert.ok(stack.operations.length > 0 && stack.operations.length < 500);
  assert.equal(stack.operations_omitted, 500 - stack.operations.length);
  for (const row of stack.operations) assert.ok(Object.hasOwn(paths, row.operation.slice(4)), 'navigation retains the complete canonical path');
  assert.match(snapshot.activity.display_basis, /byte budget/);
});

test('snapshot inbox and optional presence fit the reserved bytes while polling retains the wider presence list', async t => {
  const root = fixture(t), sessionId = `wb-${randomUUID()}`, agents = [];
  createFixtureStack(root);
  // Character limits alone do not bound UTF-8 bytes: these valid labels and
  // five operator records previously exceeded the snapshot's 64-KiB reserve.
  for (let index = 0; index < 5; index++) appendWorkbenchEvent(root, sessionId, {
    kind: 'follow_up', message: '界'.repeat(1000), stack: 's'.repeat(63), environment: 'e'.repeat(128),
    operation: `GET /${'路'.repeat(1035)}`, saved_ref: Array(7).fill('r'.repeat(64)).join('/'),
    run_id: `run-${'a'.repeat(128)}`,
  });
  try {
    for (let index = 0; index < 32; index++) agents.push(await createWorkbenchAgent({
      root, host: '主'.repeat(120), task: '任'.repeat(120),
    }));
    const handlers = workbenchHandlers(root, { sessionId }), snapshot = await handlers.snapshot({});
    const metadataBytes = Buffer.byteLength(JSON.stringify({ agent: snapshot.agent }));
    assert.ok(metadataBytes <= WORKBENCH_LIMITS.responseBytes - WORKBENCH_SNAPSHOT_BYTES,
      `inbox and presence metadata must fit the snapshot reserve; received ${metadataBytes} bytes`);
    assert.equal(snapshot.agent.pending, 5);
    assert.equal(snapshot.agent.events.length, 5);
    assert.equal(snapshot.agent.agents.length, 8);
    assert.equal(snapshot.agent.presence.omitted, 24, 'snapshot names the presence records omitted for its byte bound');
    assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: snapshot })) <= WORKBENCH_LIMITS.responseBytes);
    const polled = await handlers.agent({});
    assert.equal(polled.agents.length, 32, 'the separate agent poll retains its own wider bound');
    assert.equal(polled.presence.omitted, 0);
    assert.equal(polled.pending, 5);
  } finally { await Promise.all(agents.map(agent => agent.close())); }
});


test('operation detail lists scoped retained responses outside the activity window and names missing evidence without exposing bodies', async t => {
  const root = fixture(t), operation = 'POST /decisions';
  const contract = JSON.stringify({ openapi: '3.0.3', info: { title: 'Decision fixture', version: '1' },
    paths: { '/decisions': { post: { responses: { 200: { description: 'ok' } } } } } });
  writeFileSync(join(root, 'openapi.json'), contract);
  createFixtureStack(root, { contract: 'openapi.json' });
  createFixtureStack(root, { name: 'other', contract: 'openapi.json' });
  const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const at = new Date(Date.now() - 86400000).toISOString();
  const identity = { stack: 'fixture', provider: 'https://fixture.example.test', environment: 'local',
    protocol: 'http', operation, endpoint: 'https://fixture.example.test/decisions', contractDigest: hash(contract) };
  const observation = (runId, status, offset = 0) => {
    const path = `${fixtureEvidencePath()}/${runId}.json`, bytes = JSON.stringify({ runId,
      origin: { v: 1, initiator: 'cli.request', observed_at: at, scope: { protocol: 'http', operation } },
      request: { method: 'POST', body: { private: 'REQUEST_PRIVATE_VALUE' } },
      response: { status, body: { private: 'RESPONSE_PRIVATE_VALUE', password: 'FIXTURE_CREDENTIAL' } } });
    writeFileSync(join(root, path), bytes);
    return { id: runId.replace('run-', 'obs-'), recorded_at: at, observed_at: new Date(Date.parse(at) + offset).toISOString(),
      basis: 'observed', source: { kind: 'client', tool: 'api_request:http' }, verification: 'client-observation',
      outcome: status >= 200 && status < 300 ? 'success' : 'error', complete: true,
      response_status: status, assertions: { passed: status === 200 ? 1 : 0, failed: status === 200 ? 0 : 1 },
      evidence: [{ path, digest: hash(bytes) }], notes: [], omissions: [] };
  };
  const responses = [observation('run-first-decision', 422), observation('run-second-decision', 200, 1),
    observation('run-missing-decision', 200, 2)];
  rmSync(join(root, fixtureEvidencePath(), 'run-missing-decision.json'));
  const notes = Array.from({ length: 7 }, (_, i) => `Decision note ${i + 1}.`);
  const store = { v: 0, api: { name: 'Decision fixture' }, operations: { [operation]: { notes,
    notes_provenance: notes.map(() => ({ by: 'agent', at: '2026-10-17' })) } }, api_context: { v: 1, operations: {
      [operationId(identity)]: { identity, observations: responses, omitted_observations: 0 },
    } } };
  writeFileSync(fixtureContextFile(root), JSON.stringify(store));
  const other = { ...identity, stack: 'other' };
  writeFileSync(fixtureContextFile(root, 'other'), JSON.stringify({ ...store,
    api_context: { v: 1, operations: { [operationId(other)]: { identity: other,
      observations: [{ ...responses[0], id: 'obs-another-stack' }], omitted_observations: 0 } } } }));
  // More recent unrelated receipts hide the original call in Activity. Its
  // operation context must still be navigable without scanning that window.
  for (let i = 0; i < 110; i++) writeFileSync(join(root, fixtureEvidencePath(), `run-newer-${i}.json`), JSON.stringify({
    runId: `run-newer-${i}`, origin: { v: 1, initiator: 'cli.request', observed_at: new Date().toISOString(),
      scope: { protocol: 'http', operation: 'GET /health' } }, request: { method: 'GET' }, response: { status: 200 } }));
  const result = await workbenchHandlers(root).operation.run({ stack: 'fixture', operation });
  const detail = result.operation.recorded_responses;
  assert.ok(detail, 'operation detail exposes retained response summaries');
  assert.deepEqual([detail.total, detail.shown, detail.omitted], [3, 3, 0]);
  assert.equal(detail.current_scope_count, 2);
  assert.equal(result.operation.notes.filter(note => !note.superseded).length, 7);
  assert.deepEqual(detail.items.map(row => row.run_id), ['run-missing-decision', 'run-second-decision', 'run-first-decision']);
  assert.equal(detail.items[0].evidence.state, 'missing-or-unavailable');
  assert.equal(detail.items[1].evidence.state, 'available');
  assert.deepEqual(detail.items[1].assertions, { passed: 1, failed: 0 });
  assert.equal(detail.items[2].status, 422); assert.ok(detail.items.every(row => row.in_current_scope));
  assert.ok(detail.items.every(row => row.scope.stack === 'fixture'));
  const serialized = JSON.stringify(detail);
  for (const privateValue of ['REQUEST_PRIVATE_VALUE', 'RESPONSE_PRIVATE_VALUE', 'FIXTURE_CREDENTIAL', 'obs-another-stack'])
    assert.ok(!serialized.includes(privateValue), privateValue);
  assert.equal(inspectRecordedResponse(root, { stack: 'fixture', runId: detail.items[1].run_id }).status, 200);
  const compact = isolatedSnapshot(root).stacks.find(stack => stack.name === 'fixture').operations.find(row => row.operation === operation);
  assert.deepEqual(compact.latest_status_codes, [200]);
  assert.equal(compact.latest_observed_at, responses[2].observed_at);
  assert.equal(compact.has_recorded_activity, true);
  assert.equal(compact.has_recorded_failure, true);

  // Keep display limits separate from the number of retained observations;
  // old contract scopes remain explicit rather than becoming current proof.
  for (let scope = 0; scope < 3; scope++) {
    const oldIdentity = { ...identity, contractDigest: hash(`old contract ${scope}`) };
    store.api_context.operations[operationId(oldIdentity)] = { identity: oldIdentity,
      observations: Array.from({ length: 20 }, (_, i) => ({ ...responses[0], id: `obs-old-${scope}-${i}` })), omitted_observations: 2 };
  }
  writeFileSync(fixtureContextFile(root), JSON.stringify(store));
  const bounded = (await workbenchHandlers(root).operation.run({ stack: 'fixture', operation })).operation.recorded_responses;
  assert.deepEqual([bounded.total, bounded.shown, bounded.omitted, bounded.history_omitted], [63, 50, 13, 6]);
  assert.ok(bounded.items.some(row => !row.in_current_scope));
  assert.equal(bounded.current_scope_count, 2);
});

test('workbench refusal keeps the safe missing-field diagnosis instead of hiding it behind a generic repair instruction', async t => {
  const root = fixture(t);
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Input fixture', version: '1' },
    paths: { '/end': { post: { requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['session_token'], properties: { session_token: { type: 'string' } },
    } } } }, responses: { 200: { description: 'ok' } } } } } }));
  createFixtureStack(root, { contract: 'openapi.json' });
  const handlers = workbenchHandlers(root);
  const result = await handlers.saved.run({ action: 'draft', stack: 'fixture', environment: 'local', operation: 'POST /end' });
  delete result.document.request.bindings.body; result.document.inputs = {};
  await assert.rejects(handlers.saved.run({ action: 'run', document: result.document, inputs: {} }), error => {
    assert.equal(error.code, 'SAVED_BINDING_MISSING');
    assert.match(error.nextAction, /session_token/);
    assert.match(error.nextAction, /body/i);
    return true;
  });
});

test('the snapshot and the presence poll carry the latest agent session with the fixed summary line, or null without one', async t => {
  const root = fixture(t); createFixtureStack(root);
  retainedCall(root, { id: 'cli-only', at: '2026-10-22T10:00:00Z' });
  const handlers = workbenchHandlers(root);
  assert.equal(isolatedSnapshot(root).activity.latest_session, null, 'a command-line process is not an agent session');
  assert.equal((await handlers.agent({})).latest_session, null);
  const session = randomUUID();
  retainedCall(root, { id: 'agent-1', at: '2026-10-22T11:00:00Z', initiator: 'mcp.api_request', session, status: 200 });
  retainedCall(root, { id: 'agent-2', at: '2026-10-22T11:00:05Z', initiator: 'mcp.api_request', session, status: 500 });
  retainedCall(root, { id: 'later-cli', at: '2026-10-22T12:00:00Z' });
  const latest = isolatedSnapshot(root).activity.latest_session;
  assert.equal(latest.session, `process:${session}`);
  assert.deepEqual(latest.hosts, ['mcp.api_request']);
  assert.equal(latest.calls, 2); assert.equal(latest.failed, 1); assert.equal(latest.unasserted, 2);
  assert.deepEqual(latest.notes, { added: 0, corrected: 0 });
  assert.match(latest.line, /^\S+: 2 requests · 1 failed · no notes added$/);
  assert.equal(latest.ended_at, '2026-10-22T11:00:05.000Z');
  // The poll's copy is cached briefly so polling never rereads every run file.
  const fresh = workbenchHandlers(root);
  assert.equal((await fresh.agent({})).latest_session.session, `process:${session}`);
  retainedCall(root, { id: 'agent-3', at: '2026-10-22T11:00:09Z', initiator: 'mcp.api_request', session, status: 200 });
  assert.equal((await fresh.agent({})).latest_session.calls, 2, 'within the cache window the poll repeats the last read');
  assert.equal(isolatedSnapshot(root).activity.latest_session.calls, 3, 'the snapshot reads the ledger again');
});
