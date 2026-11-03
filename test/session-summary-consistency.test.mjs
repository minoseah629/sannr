// SESSION-1: every surface that prints a summary line prints the same one for
// the same ledger: the api_workbench summary action, the Workbench rail and
// snapshot (latest_session) and the session view. Checked with
// complete evidence and with an unreadable run file, where every surface must
// say "not recorded" rather than a count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';

// The engine reads the ledger with this process's environment: isolate it
// before the modules load, and give buildSessionSummary the same one.
const machine = realpathSync(mkdtempSync(join(tmpdir(), 'summary-consistency-home-')));
process.env.HOME = machine; process.env[HOME_ENV_NAME] = join(machine, 'machine');
process.env.API_USAGE_LOG = join(machine, 'machine', 'usage.jsonl'); process.env.API_FRICTION_OFF = '1';
const { buildSessionSummary, NOT_RECORDED } = await import('../lib/session-summary.mjs');
const { workbenchHandlers, workbenchSnapshot } = await import('../lib/workbench-engine.mjs');
const { workbenchSessionModel } = await import('../lib/workbench-session.mjs');

function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'summary-consistency-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, LAYOUT.collection, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stack.json'), JSON.stringify({ v: 1, name: 'alpha', default_environment: 'local', environments: { local: { baseUrl: 'https://alpha.example.test' } } }));
  writeFileSync(join(dir, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name: 'alpha' }, operations: {} }));
  return root;
}
function writeRun(root, { sessionId, at, status = 200, assertions }) {
  const runId = `run-${randomUUID()}`, dir = join(root, LAYOUT.evidence, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, origin: { v: 1, initiator: 'mcp.api_request', observed_at: new Date(at).toISOString(), session_id: sessionId,
    scope: { protocol: 'http', operation: 'GET /health' } }, request: { method: 'GET' }, response: { status }, ...(assertions ? { assertions } : {}) }));
  return runId;
}

// The lines every surface prints for one process session.
async function lines(root, session) {
  const summary = buildSessionSummary(root, { processSessionId: session, env: process.env });
  const snapshot = await workbenchSnapshot(root);
  const polled = await workbenchHandlers(root).agent({});
  const view = workbenchSessionModel(root, `process:${session}`, { env: process.env }).summary;
  return { summary, snapshot: snapshot.activity.latest_session, polled: polled.latest_session, view };
}

test('the rail, the snapshot, the session view and the summary action print the same line and counts, complete or not recorded', async t => {
  const root = project(t), session = randomUUID(), start = Date.now() - 60_000;
  writeRun(root, { sessionId: session, at: start, assertions: { passed: 1, failed: 0 } });
  writeRun(root, { sessionId: session, at: start + 1000, status: 500 });
  writeRun(root, { sessionId: session, at: start + 2000 });
  const complete = await lines(root, session);
  assert.match(complete.summary.line, /^\S+: 3 requests · 1 failed · no notes added$/);
  for (const surface of [complete.snapshot, complete.polled, complete.view]) {
    assert.equal(surface.session, complete.summary.session);
    assert.equal(surface.line, complete.summary.line);
    for (const key of ['calls', 'failed', 'unasserted', 'drift', 'refusals', 'left_behind']) assert.equal(surface[key], complete.summary[key], key);
    assert.deepEqual(surface.notes, complete.summary.notes);
  }

  // One unreadable run file: the ledger cannot say which session it belongs
  // to, so every surface withholds the counts instead of printing a total.
  writeFileSync(join(root, LAYOUT.evidence, 'alpha', `run-${randomUUID()}.json`), '{not json');
  const partial = await lines(root, session);
  assert.equal(partial.summary.calls, NOT_RECORDED);
  assert.match(partial.summary.line, /requests not recorded · failures not recorded · notes not recorded$/);
  assert.equal(partial.summary.recorded.calls, 3);
  assert.equal(partial.summary.recorded.failed, 1);
  assert.equal(partial.snapshot.line, partial.summary.line);
  assert.equal(partial.snapshot.calls, NOT_RECORDED);
  assert.equal(partial.view.line, partial.summary.line);
  assert.equal(partial.view.calls, NOT_RECORDED);
  // The poll's ledger read is cached briefly; a fresh handler reads it again.
  assert.equal(partial.polled.line, partial.summary.line);
});
