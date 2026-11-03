import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchAgentTools } from '../lib/workbench-agent-tools.mjs';
import { appendWorkbenchEvent, readWorkbenchHandoff, acknowledgeWorkbenchHandoff } from '../lib/workbench-handoff.mjs';
import { workbenchHandlers } from '../lib/workbench-engine.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { listWorkbenchAgents } from '../lib/workbench-agent.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-agent-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = `wb-${randomUUID()}`;
  const controller = () => {
    const tools = createWorkbenchAgentTools({ root, host: 'Fixture coding host' });
    t.after(() => tools.close());
    return tools;
  };
  return { root, session, controller };
}
const refused = (promise, code) => assert.rejects(promise, error => error.code === code);
function seed(root, session, count) {
  for (let index = 0; index < count; index++) appendWorkbenchEvent(root, session, { kind: 'follow_up', message: `Review fixture change ${index + 1}.` });
}

test('presence is optional, peer-owned and distinct from repository inbox discovery', async t => {
  const { root, session, controller } = fixture(t);
  seed(root, session, 1);
  const peer = controller(), other = controller();
  assert.equal((await peer.call({ action: 'status' })).connection, null);
  assert.equal(JSON.parse(other.pendingHint()).workbench_handoffs[0].session_id, session);
  const attached = await peer.call({ action: 'attach', task: 'Debug GET /orders/{id}' });
  assert.equal(attached.host, 'Fixture coding host');
  assert.equal(attached.task, 'Debug GET /orders/{id}');
  assert.notEqual(attached.session_id, session);
  assert.equal(attached.url, undefined);
  const replaced = await peer.call({ action: 'attach', task: 'Review POST /orders' });
  assert.equal(replaced.session_id, attached.session_id);
  assert.equal(replaced.task, 'Review POST /orders');
  assert.equal(replaced.task_updated, true);
  assert.equal(replaced.previous_task, attached.task);
  const unchanged = await peer.call({ action: 'attach', task: 'Review POST /orders' });
  assert.equal(unchanged.task_updated, false);
  assert.equal(unchanged.previous_task, undefined);
  const status = await other.call({ action: 'status' });
  assert.equal(status.connection, null);
  assert.equal(status.agents[0].session_id, attached.session_id);
  assert.equal(status.agents[0].task, 'Review POST /orders');
  assert.deepEqual(status.sessions.map(inbox => inbox.session_id), [session]);
  await refused(other.call({ action: 'detach', session: attached.session_id }), 'WORKBENCH_SESSION_NOT_ATTACHED');
  await peer.call({ action: 'detach', session: attached.session_id });
  assert.deepEqual((await listWorkbenchAgents(root)).agents, []);
  assert.equal((await other.call({ action: 'read', session })).events.length, 1);
  assert.equal((await other.call({ action: 'ack', session, through: 1 })).pending, 0);
  assert.deepEqual(readdirSync(join(root, LAYOUT.evidence, 'workbench', 'handoffs')).filter(file => file.endsWith('.json')), [`${session}.json`]);
});

test('a fresh peer can receive and acknowledge new entries after the previously acknowledged prefix', async t => {
  const { root, session, controller } = fixture(t);
  seed(root, session, 3); acknowledgeWorkbenchHandoff(root, session, 1);
  const peer = controller();
  const first = await peer.call({ action: 'read', session, after: 1, limit: 1 });
  assert.deepEqual(first.events.map(event => event.seq), [2]);
  assert.equal(first.retrieved_through, 2);
  assert.equal(first.pending, 2, 'reading leaves acknowledgment unchanged');
  assert.equal(readWorkbenchHandoff(root, session).acknowledged_through, 1);
  const ack = await peer.call({ action: 'ack', session, through: 2 });
  assert.equal(ack.acknowledged_through, 2); assert.equal(ack.pending, 1);
  assert.equal(ack.meaning, 'received, not completed');
  await refused(controller().call({ action: 'ack', session, through: 3 }), 'WORKBENCH_HANDOFF_NOT_READ');
  const nextPeer = controller();
  const remaining = await nextPeer.call({ action: 'read', session, after: 2 });
  assert.deepEqual(remaining.events.map(event => event.seq), [3]);
  assert.equal((await nextPeer.call({ action: 'ack', session, through: 3 })).pending, 0);
});

test('a noncontiguous read cannot acknowledge skipped operator changes', async t => {
  const { root, session, controller } = fixture(t);
  seed(root, session, 3);
  const peer = controller();
  const skipped = await peer.call({ action: 'read', session, after: 2 });
  assert.deepEqual(skipped.events.map(event => event.seq), [3]);
  assert.equal(skipped.retrieved_through, 0);
  await refused(peer.call({ action: 'ack', session, through: 3 }), 'WORKBENCH_HANDOFF_NOT_READ');
  assert.equal(readWorkbenchHandoff(root, session).acknowledged_through, 0);
  assert.equal((await peer.call({ action: 'read', session, after: 0, limit: 1 })).retrieved_through, 1);
  await refused(peer.call({ action: 'ack', session, through: 2 }), 'WORKBENCH_HANDOFF_NOT_READ');
  assert.equal((await peer.call({ action: 'read', session, after: 1, limit: 2 })).retrieved_through, 3);
  assert.equal((await peer.call({ action: 'ack', session, through: 3 })).pending, 0);
});

test('pending hint names omitted older inboxes when the five newest sessions are already acknowledged', async t => {
  const { root, session: older, controller } = fixture(t);
  const sessions = [older, ...Array.from({ length: 5 }, () => `wb-${randomUUID()}`)];
  for (const [index, session] of sessions.entries()) {
    seed(root, session, 1);
    const file = join(root, LAYOUT.evidence, 'workbench', 'handoffs', `${session}.json`);
    const document = JSON.parse(readFileSync(file, 'utf8'));
    document.events[0].at = `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`;
    writeFileSync(file, JSON.stringify(document));
    if (index) acknowledgeWorkbenchHandoff(root, session, 1);
  }
  const peer = controller(), hint = JSON.parse(peer.pendingHint());
  assert.equal(hint.sessions_omitted, 1);
  assert.deepEqual(hint.workbench_handoffs, []);
  assert.equal(hint.scan_omitted, false);
  const status = await peer.call({ action: 'status' });
  assert.equal(status.connection, null, 'discovering inboxes does not attach an agent session');
  assert.equal(status.sessions.find(row => row.session_id === older).pending, 1);
  assert.equal(readWorkbenchHandoff(root, older).pending, 1, 'hints and status do not acknowledge');
});

test('controller enforces its 50-event read limit independently of the MCP schema', async t => {
  const { root, session, controller } = fixture(t);
  seed(root, session, 1);
  const peer = controller();
  for (const limit of [51, 100, 0, -1, 1.5, '20'])
    await refused(peer.call({ action: 'read', session, limit }), 'WORKBENCH_HANDOFF_LIMIT_INVALID');
  assert.equal((await peer.call({ action: 'read', session, limit: 50 })).events.length, 1);
  assert.equal(readWorkbenchHandoff(root, session).pending, 1);
});

test('recording a malformed request refusal preserves the original validation error without inventing execution', async t => {
  const { root, session } = fixture(t);
  const baseline = await workbenchHandlers(root).saved.run({ action: 'run', document: {}, inputs: {} }).catch(error => error);
  assert.ok(baseline.code?.startsWith('SAVED_'));
  const bound = workbenchHandlers(root, { sessionId: session });
  const error = await bound.saved.run({ action: 'run', document: {}, inputs: {} }).catch(error => error);
  assert.equal(error.code, baseline.code);
  assert.equal(error.nextAction, baseline.nextAction);
  const captured = readWorkbenchHandoff(root, session);
  assert.equal(captured.total, 1);
  assert.equal(captured.events[0].kind, 'request_result');
  assert.equal(captured.events[0].error_code, baseline.code);
  for (const field of ['run_id', 'status', 'operation', 'request_id']) assert.equal(captured.events[0][field], undefined);
});


test('replacing a presence task validates the new label and preserves the current label on refusal', async t => {
  const { root, controller } = fixture(t), peer = controller();
  const attached = await peer.call({ action: 'attach', task: 'Review GET /orders/{id}' });
  const credential = 'abcdefghijklmnopqrstuvwxyz123456';
  await assert.rejects(peer.call({ action: 'attach', task: `Authorization: Bearer ${credential}` }), error => {
    assert.equal(error.code, 'WORKBENCH_PRESENCE_LABEL_PRIVATE');
    assert.ok(!`${error.message} ${error.next}`.includes(credential), 'the refusal must not echo the rejected label');
    return true;
  });
  const current = (await peer.call({ action: 'status' })).connection;
  assert.equal(current.session_id, attached.session_id);
  assert.equal(current.task, attached.task);
  assert.equal((await listWorkbenchAgents(root)).agents[0].task, attached.task);
});

test('summary needs no attachment, inbox or running workbench, takes no other field, and withholds unrecorded note attribution', async t => {
  const { root, controller } = fixture(t), peer = controller();
  const summary = await peer.call({ action: 'summary' });
  assert.deepEqual(Object.keys(summary), ['session', 'since', 'calls', 'failed', 'unasserted', 'notes', 'drift', 'refusals', 'left_behind', 'line', 'open']);
  assert.match(summary.session, /^process:[a-f0-9-]{36}$/);
  assert.equal(summary.calls, 0);
  assert.deepEqual(summary.notes, { added: 0, corrected: 0 });
  assert.equal((await peer.call({ action: 'status' })).connection, null, 'a summary does not attach presence');
  await refused(peer.call({ action: 'summary', session: 'wb-00000000-0000-0000-0000-000000000000' }), 'WORKBENCH_ACTION_INVALID');
  const id = `sha256:${'a'.repeat(64)}`;
  peer.noteWritten({ id }); peer.noteWritten({ id, corrected: true }); peer.noteWritten({ id: `sha256:${'b'.repeat(64)}`, corrected: true }); peer.noteWritten({});
  assert.deepEqual((await peer.call({ action: 'summary' })).notes, { added: 'not recorded', corrected: 'not recorded' });
});
