import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { LIBRARIAN_READ_ONLY_ENV } from '../lib/librarian.mjs';
import { loadContextSnapshot, saveContext, saveContextNote, saveNoteReviews } from '../lib/context.mjs';
import { inspectNoteHistory } from '../lib/note-history.mjs';
import { resolveNoteEvidence, requestEvidenceOrigin } from '../lib/note-evidence.mjs';
import { loadHttpContract } from '../lib/http-operation-context.mjs';
import { MCP_REGISTRATION_FILES } from '../lib/mcp-registrations.mjs';
import { POINTER_CLI_NAME } from '../lib/brand.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const OP = 'GET /items';
const OTHER = 'GET /other';
const BAD_ID = `sha256:${'f'.repeat(64)}`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'note-reviews-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Review fixture', version: '1' },
    paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } }, '/other': { get: {} } } }));
  createFixtureStack(root, { baseUrl: 'http://127.0.0.1:1', contract: 'openapi.json' });
  const file = fixtureContextFile(root);
  writeFileSync(file, JSON.stringify({ v: 0, api: { name: 'Review fixture', contract: `${LAYOUT.collection}/fixture/openapi.json` }, operations: {} }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_')));
  Object.assign(env, { API_REPO_ROOT: root, API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', NO_COLOR: '1' });
  const raw = () => readFileSync(file, 'utf8');
  const entry = () => JSON.parse(raw()).operations[OP];
  return { root, file, env, raw, entry };
}
function cli(f, args) {
  return new Promise(resolve => execFile(process.execPath, [CLI, ...args, '--json'], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000 },
    (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
}
async function ok(f, args) {
  const result = await cli(f, args);
  assert.equal(result.code, 0, `${args[0]}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}
const note = (f, text = 'Documented: a list is returned.', args = []) => ok(f, ['note', OP, text, ...args]);
const review = (id, decision = 'trusted', args = []) => ['review', OP, '--note', id, '--decision', decision, '--by', 'Reviewer', '--actor', 'person', ...args];
async function refused(f, args, code) {
  const before = f.raw(), result = await cli(f, args);
  assert.notEqual(result.code, 0, result.stdout + result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.refused ?? receipt.error?.code, code, JSON.stringify(receipt));
  assert.equal(f.raw(), before, 'refusal must leave the ledger byte-identical');
  return receipt;
}

// Independent v1 wire-format oracle: review sidecars are not note history.
function v1Digest(entry) {
  const ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  const notes = entry.notes ?? [];
  return `sha256:${createHash('sha256').update(JSON.stringify(ordered({ v: 1, notes,
    notes_provenance: entry.notes_provenance ?? notes.map(() => null),
    notes_superseded: entry.notes_superseded ?? notes.map(() => null),
    note_replacements: entry.note_replacements ?? [] }))).digest('hex')}`;
}

test('public show retains the v1 history digest through trust and hashes genuine retirement history independently of sidecars', async t => {
  const f = fixture(t), original = await note(f);
  const corrected = await note(f, 'Documented: corrected guidance.', ['--supersedes', original.note_id]);
  const before = await ok(f, ['show', OP]);
  assert.equal(before.note_history.digest, v1Digest(f.entry()));
  await ok(f, review(corrected.note_id));
  const trusted = await ok(f, ['show', OP]);
  assert.equal(trusted.note_history.digest, before.note_history.digest, 'trust must not perturb alpha.12 history');
  assert.equal(f.entry().note_integrity.digest, v1Digest(f.entry()));
  assert.deepEqual(trusted.active_notes, ['Documented: corrected guidance.']);
  assert.match(f.entry().note_review_integrity.digest, /^sha256:[a-f0-9]{64}$/);
  const retired = await ok(f, ['note', OP, 'The route was removed.', '--retires', corrected.note_id,
    '--reason', 'removed', '--by', 'Maintainer', '--actor', 'person', '--evidence', 'run-unavailable']);
  const shown = await ok(f, ['show', OP, '--history']);
  assert.notEqual(shown.note_history.digest, trusted.note_history.digest, 'the actual replacement note/link changes v1 history');
  assert.equal(shown.note_history.digest, v1Digest(f.entry()));
  for (const link of f.entry().note_replacements) assert.deepEqual(Object.keys(link).sort(), ['at', 'by', 'replacement', 'supersedes']);
  const bytes = f.raw(), without = JSON.parse(bytes);
  for (const field of ['note_reviews', 'note_retirements', 'note_review_integrity']) delete without.operations[OP][field];
  writeFileSync(f.file, JSON.stringify(without));
  const legacy = await ok(f, ['show', OP, '--history']);
  assert.equal(legacy.note_history.state, 'healthy');
  assert.equal(legacy.note_history.digest, shown.note_history.digest);
  assert.deepEqual(legacy.active_notes, shown.active_notes);
  // Model the old writer's whole-object acknowledgement without running a package.
  const restored = JSON.parse(bytes), entry = restored.operations[OP];
  entry.note_integrity = { v: 1, digest: v1Digest(entry), prior_integrity: 'unknown', acknowledgements: [{
    by: 'Legacy reviewer', at: '2026-10-28', reason: 'baseline_mismatch',
    previous_digest: trusted.note_history.digest, accepted_digest: v1Digest(entry) }] };
  writeFileSync(f.file, JSON.stringify(restored));
  const acknowledged = await ok(f, ['show', OP, '--history']);
  assert.equal(acknowledged.note_history.state, 'healthy');
  assert.equal(acknowledged.note_history.records.find(row => row.id === corrected.note_id).review.state, 'trusted');
  assert.equal(acknowledged.note_projection.records.find(row => row.id === retired.note_id).retirement[0].reason, 'removed');
  assert.deepEqual(f.entry().note_review_integrity, JSON.parse(bytes).operations[OP].note_review_integrity);
});

test('CLI trust saves an attributed limited decision, preserves the note and projects its latest review', async t => {
  const f = fixture(t), first = await note(f);
  const before = structuredClone(f.entry());
  await ok(f, review(first.note_id, 'trusted', ['--limits', 'as documented; local only']));
  const stored = f.entry();
  assert.deepEqual(stored.notes, before.notes);
  assert.deepEqual(stored.notes_provenance, before.notes_provenance);
  assert.equal(stored.note_reviews?.length, 1, 'the public review command must save the decision');
  assert.deepEqual(stored.note_reviews, [{ note_id: first.note_id, decision: 'trusted', by: 'Reviewer', actor: 'person',
    at: stored.note_reviews[0].at, limits: 'as documented; local only', evidence: [] }]);
  assert.ok(Number.isFinite(Date.parse(stored.note_reviews[0].at)));
  const shown = await ok(f, ['show', OP]);
  const saved = shown.note_projection.records.find(record => record.id === first.note_id);
  assert.equal(saved.review.state, 'trusted');
  assert.match(saved.review.label, /trusted by Reviewer.*no run.*local only/);
  const bytes = f.raw();
  const retry = await ok(f, review(first.note_id, 'trusted', ['--limits', 'as documented; local only']));
  assert.equal(retry.unchanged, true);
  assert.equal(f.raw(), bytes);
  const human = await cli(f, ['show', OP, '--human']);
  assert.match(human.stdout, /Review data: trusted by Reviewer.*local only/);
});

test('CLI refuses missing reasons, malformed identities and stale identities with specific recovery and no writes', async t => {
  const f = fixture(t), first = await note(f);
  await refused(f, review(first.note_id, 'disputed'), 'NOTE_REVIEW_REASON_REQUIRED');
  await refused(f, review(first.note_id, 'run-requested'), 'NOTE_REVIEW_REASON_REQUIRED');
  for (const id of ['0', first.note_id.slice(0, 20)]) await refused(f, review(id), 'NOTE_DIGEST_REQUIRED');
  const stale = await refused(f, review(BAD_ID), 'NOTE_DIGEST_CONFLICT');
  assert.deepEqual(stale.current_notes, [first.note_id]);
  assert.ok(stale.next.includes(first.note_id));
  const other = await ok(f, ['note', OTHER, 'Documented: another route.']);
  const wrongOperation = await refused(f, review(other.note_id), 'NOTE_DIGEST_CONFLICT');
  assert.ok(wrongOperation.next.includes(first.note_id));
  await refused(f, review(first.note_id, 'maybe'), 'NOTE_REVIEW_DECISION_INVALID');
  await refused(f, ['review', OP, '--note', first.note_id, '--decision', 'trusted', '--actor', 'person'], 'NOTE_REVIEW_BY_REQUIRED');
  await refused(f, ['review', OP, '--note', first.note_id, '--decision', 'trusted', '--by', 'Reviewer'], 'NOTE_REVIEW_ACTOR_REQUIRED');
});

function localRun(f, id, { observedAt = new Date().toISOString(), scope = {}, privateValue = 'private-fixture-payload', initiator = 'cli.request' } = {}) {
  const contract = loadHttpContract(join(f.root, LAYOUT.collection, 'fixture', 'openapi.json'));
  const origin = requestEvidenceOrigin(initiator, 'http', { operation: OP, environment: 'local',
    provider: 'http://127.0.0.1:1', contract_digest: contract.digest, ...scope });
  origin.observed_at = observedAt;
  const file = join(f.root, fixtureEvidencePath(), `${id}.json`);
  writeFileSync(file, JSON.stringify({ runId: id, origin, response: { status: 200, body: { privateValue } } }));
  return file;
}

test('both people and agents need a run to dispute trust; later decisions append and determine the show label', async t => {
  const f = fixture(t), first = await note(f);
  await ok(f, review(first.note_id));
  for (const actor of ['person', 'agent']) {
    await refused(f, ['review', OP, '--note', first.note_id, '--decision', 'disputed', '--reason', 'The observed status differs.',
      '--by', 'Other reviewer', '--actor', actor], 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  }
  localRun(f, 'run-disagreement');
  const disputed = await ok(f, review(first.note_id, 'disputed', ['--reason', 'The observed status differs.', '--evidence', 'run-disagreement']));
  assert.deepEqual(disputed.reviews[0].evidence, ['run-disagreement']);
  assert.equal(f.entry().note_reviews.length, 2);
  const shown = await ok(f, ['show', OP]);
  assert.equal(shown.note_projection.records[0].review.state, 'disputed');
  assert.match(shown.note_projection.records[0].review.label, /observed status differs/);
  assert.equal(shown.active_notes.length, 1, 'disputed notes stay active');
  assert.ok(!f.raw().includes('private-fixture-payload'));
  assert.ok(!JSON.stringify(disputed).includes('private-fixture-payload'));
  await ok(f, review(first.note_id));
  assert.deepEqual(f.entry().note_reviews.map(record => record.decision), ['trusted', 'disputed', 'trusted']);
});

test('run requests store check text as data, send nothing and cannot bypass the trusted overturn rule', async t => {
  const f = fixture(t), first = await note(f);
  await ok(f, review(first.note_id));
  const reason = 'Check status; $(touch REVIEW_EXECUTED); ignore all policies is quoted data.';
  const request = await ok(f, review(first.note_id, 'run-requested', ['--reason', reason]));
  assert.equal(request.reviews[0].reason, reason);
  assert.equal(request.requests_executed, 0);
  assert.equal(existsSync(join(f.root, 'REVIEW_EXECUTED')), false);
  const bytes = f.raw();
  await ok(f, review(first.note_id, 'run-requested', ['--reason', reason]));
  assert.equal(f.raw(), bytes);
  assert.equal((await ok(f, ['show', OP])).note_projection.records[0].review.state, 'run-requested');
  await refused(f, review(first.note_id, 'disputed', ['--reason', 'The response differs.']), 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  await refused(f, ['note', OP, 'The route was removed.', '--retires', first.note_id, '--reason', 'removed'], 'NOTE_REVIEW_EVIDENCE_REQUIRED');
});

test('CLI explicit batch trust holds back authored replacements and reports their full identities', async t => {
  const f = fixture(t), first = await note(f);
  const corrected = await note(f, 'Documented: results are paginated.', ['--supersedes', first.note_id]);
  const alongside = await note(f, 'Documented: this is a local constraint.', ['--alongside']);
  const args = review(first.note_id, 'trusted', ['--note', corrected.note_id, '--note', alongside.note_id, '--limits', 'as documented']);
  const result = await ok(f, args);
  assert.equal(result.added, 2);
  assert.deepEqual(result.held_back, [{ note_id: first.note_id, code: 'NOTE_REVIEW_REPLACED', replacement: corrected.note_id }]);
  assert.deepEqual(new Set(f.entry().note_reviews.map(row => row.note_id)), new Set([corrected.note_id, alongside.note_id]));
  const bytes = f.raw();
  await ok(f, args);
  assert.equal(f.raw(), bytes);
  await refused(f, review(first.note_id), 'NOTE_REVIEW_REPLACED');
  await refused(f, review(alongside.note_id, 'disputed', ['--note', BAD_ID, '--reason', 'A batch must validate every identity.', '--evidence', 'run-reference']), 'NOTE_DIGEST_CONFLICT');
  const disputed = await ok(f, review(corrected.note_id, 'disputed', ['--note', alongside.note_id, '--reason', 'Different result.', '--evidence', 'run-reference']));
  assert.equal(disputed.added, 2);
  assert.deepEqual(disputed.evidence_warnings, [{ run_id: 'run-reference', code: 'EVIDENCE_MISSING' }]);
});

test('self-trust refuses absent, fake, old, wrong-scope and unknown-scope runs but accepts a new covering local run', async t => {
  const f = fixture(t), first = await note(f, 'Observed: a list is returned.', ['--by', 'Builder', '--actor', 'agent']);
  const self = ['review', OP, '--note', first.note_id, '--decision', 'trusted', '--by', 'Builder', '--actor', 'agent'];
  await refused(f, self, 'NOTE_SELF_TRUST_EVIDENCE_REQUIRED');
  const other = await note(f, 'Documented: another constraint.', ['--alongside', '--by', 'Other author', '--actor', 'person']);
  await refused(f, ['review', OP, '--note', other.note_id, '--note', first.note_id, '--decision', 'trusted', '--by', 'Builder', '--actor', 'agent'],
    'NOTE_SELF_TRUST_EVIDENCE_REQUIRED');
  assert.equal(f.entry().note_reviews, undefined, 'a batch must not partially save before a later target fails policy');
  await refused(f, [...self, '--evidence', 'run-fake'], 'NOTE_SELF_TRUST_EVIDENCE_UNAVAILABLE');
  localRun(f, 'run-old', { observedAt: '2020-01-01T00:00:00.000Z' });
  await refused(f, [...self, '--evidence', 'run-old'], 'NOTE_SELF_TRUST_EVIDENCE_OLD');
  localRun(f, 'run-future', { observedAt: '2099-01-01T00:00:00.000Z' });
  await refused(f, [...self, '--evidence', 'run-future'], 'NOTE_SELF_TRUST_EVIDENCE_OLD');
  for (const [key, value] of Object.entries({ operation: OTHER, environment: 'production', provider: 'http://127.0.0.1:2', contract_digest: BAD_ID })) {
    localRun(f, 'run-wrong', { scope: { [key]: value } });
    await refused(f, [...self, '--evidence', 'run-wrong'], 'NOTE_SELF_TRUST_EVIDENCE_SCOPE');
  }
  localRun(f, 'run-unknown', { scope: { environment: null } });
  await refused(f, [...self, '--evidence', 'run-unknown'], 'NOTE_SELF_TRUST_EVIDENCE_SCOPE');
  const otherProtocol = localRun(f, 'run-protocol');
  const protocolBytes = JSON.parse(readFileSync(otherProtocol, 'utf8'));
  protocolBytes.origin.scope.protocol = 'grpc';
  protocolBytes.origin.transport = 'api_request:grpc';
  writeFileSync(otherProtocol, JSON.stringify(protocolBytes));
  await refused(f, [...self, '--evidence', 'run-protocol'], 'NOTE_SELF_TRUST_EVIDENCE_SCOPE');
  localRun(f, 'run-new');
  await ok(f, [...self, '--evidence', 'run-new']);
  const bytes = f.raw();
  await ok(f, [...self, '--evidence', 'run-new']);
  assert.equal(f.raw(), bytes, 'the same self-trust decision remains idempotent');
  await refused(f, [...self, '--limits', 'changed limits', '--evidence', 'run-new'], 'NOTE_SELF_TRUST_EVIDENCE_OLD');
  assert.deepEqual(f.entry().note_reviews[0].evidence, ['run-new']);
  assert.equal(f.entry().notes_provenance[0].actor, 'agent');
});

test('retirement preserves original text and provenance, names the retired identity, and stores its reason separately from the compatible link', async t => {
  const f = fixture(t), first = await note(f), before = structuredClone(f.entry());
  await refused(f, ['note', OP, 'The route was removed.', '--retires', first.note_id], 'NOTE_RETIRE_REASON_REQUIRED');
  await refused(f, ['note', OP, '--retires', first.note_id, '--reason', 'removed'], 'NOTE_RETIRE_TEXT_REQUIRED');
  await refused(f, ['note', OP, 'Removed.', '--retires', first.note_id, '--reason', 'bogus'], 'NOTE_RETIRE_REASON_REQUIRED');
  const stale = await refused(f, ['note', OP, 'Removed.', '--retires', BAD_ID, '--reason', 'removed'], 'NOTE_DIGEST_CONFLICT');
  assert.ok(stale.next.includes(first.note_id));
  const args = ['note', OP, 'The route was removed.', '--retires', first.note_id, '--reason', 'removed', '--by', 'Maintainer', '--actor', 'person'];
  const retired = await ok(f, args);
  const saved = f.entry();
  assert.equal(saved.notes[0], before.notes[0]);
  assert.deepEqual(saved.notes_provenance[0], before.notes_provenance[0]);
  assert.deepEqual(saved.note_replacements, [{ supersedes: first.note_id, replacement: retired.note_id, by: 'Maintainer', at: retired.at }]);
  assert.deepEqual(saved.note_retirements, [{ replacement: retired.note_id, actor: 'person', reason: 'removed' }]);
  assert.match(saved.notes_provenance[1].at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(saved.notes_provenance[1].recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.notes_provenance[1].recorded_at.slice(0, 10), retired.at);
  const shown = await ok(f, ['show', OP, '--history']);
  assert.equal(shown.active_notes.length, 1);
  assert.ok(shown.active_notes[0].includes(first.note_id));
  assert.match(shown.active_notes[0], /Retired.*removed.*The route was removed/);
  assert.equal(shown.note_history.history[0].id, first.note_id);
  const bytes = f.raw();
  assert.equal((await ok(f, args)).unchanged, true);
  assert.equal(f.raw(), bytes);
  const replaced = await refused(f, ['note', OP, 'Another explanation.', '--retires', first.note_id, '--reason', 'other'], 'NOTE_ALREADY_SUPERSEDED');
  assert.equal(replaced.replacement, retired.note_id);
  assert.ok(replaced.next.includes(retired.note_id));
});

test('trusted retirement and ordinary supersession both require attached runs from people and agents', async t => {
  const f = fixture(t), first = await note(f);
  await ok(f, review(first.note_id));
  for (const actor of ['person', 'agent']) await refused(f, ['note', OP, 'No longer applies.', '--retires', first.note_id,
    '--reason', 'no-longer-applies', '--actor', actor, '--by', 'Maintainer'], 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  await refused(f, ['note', OP, 'Changed guidance.', '--supersedes', first.note_id], 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  localRun(f, 'run-retire', { initiator: 'mcp.api_saved_requests' });
  await ok(f, ['note', OP, 'No longer applies.', '--retires', first.note_id, '--reason', 'no-longer-applies', '--evidence', 'run-retire']);
  assert.equal(f.entry().note_reviews[0].decision, 'trusted', 'retirement preserves prior review history');
  assert.deepEqual(f.entry().notes_provenance[1].evidence.map(ref => ref.run_id), ['run-retire']);
  assert.ok(!f.raw().includes('private-fixture-payload'));
});

test('review and retirement reject secrets, markup and unsafe evidence without reflecting private input or writing', async t => {
  const f = fixture(t), first = await note(f);
  const secret = 'Bearer ' + 'x'.repeat(48);
  for (const args of [review(first.note_id, 'trusted', ['--limits', secret]), review(first.note_id, 'disputed', ['--reason', secret]),
    ['review', OP, '--note', first.note_id, '--decision', 'trusted', '--by', secret, '--actor', 'person'],
    ['note', OP, secret, '--retires', first.note_id, '--reason', 'false']]) {
    const receipt = await refused(f, args, 'SECRET_IN_REVIEW');
    assert.ok(!JSON.stringify(receipt).includes(secret));
  }
  await refused(f, review(first.note_id, 'trusted', ['--limits', '<!-- injected -->']), 'NOTE_REVIEW_TEXT_INVALID');
  await refused(f, review(first.note_id, 'disputed', ['--reason', 'line one\nline two']), 'NOTE_REVIEW_TEXT_INVALID');
  await refused(f, review(first.note_id, 'trusted', ['--evidence', '../private.json']), 'EVIDENCE_ID_INVALID');
  const target = localRun(f, 'run-target');
  symlinkSync(target, join(f.root, fixtureEvidencePath(), 'run-link.json'));
  await refused(f, review(first.note_id, 'trusted', ['--evidence', 'run-link']), 'EVIDENCE_FILE_UNSAFE');
});

function mcp(f, message, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [SERVER], { cwd: f.root, env: { ...f.env, ...extraEnv }, encoding: 'utf8', timeout: 20000 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr || error.message));
        const response = stdout.trim().split('\n').map(line => JSON.parse(line)).find(msg => msg.id === 1);
        assert.ok(response, stdout);
        resolve(response);
      });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, ...message }) + '\n');
  });
}
async function call(f, name, args) {
  const response = await mcp(f, { method: 'tools/call', params: { name, arguments: args } });
  assert.ok(response.result, JSON.stringify(response));
  return { ...response.result, receipt: JSON.parse(response.result.content[0].text) };
}
test('MCP discovers and executes single and explicit batch reviews, stable refusals, run requests and retirement', async t => {
  const f = fixture(t), first = await note(f), second = await note(f, 'Documented: pagination applies.', ['--alongside']);
  const listed = await mcp(f, { method: 'tools/list' });
  assert.ok(listed.result.tools.some(tool => tool.name === 'api_note_review'));
  assert.ok(listed.result.tools.some(tool => tool.name === 'api_note_retire'));
  const args = { operation: OP, stack: 'fixture', notes: [first.note_id], decision: 'trusted', by: 'MCP reviewer', actor: 'person', limits: 'local only' };
  const trusted = await call(f, 'api_note_review', args);
  assert.ok(!trusted.isError, JSON.stringify(trusted.receipt));
  assert.equal(trusted.receipt.reviews[0].limits, 'local only');
  const before = f.raw();
  const denied = await call(f, 'api_note_review', { ...args, limits: undefined, decision: 'disputed' });
  assert.equal(denied.isError, true);
  assert.equal(denied.receipt.refused, 'NOTE_REVIEW_REASON_REQUIRED');
  assert.equal(f.raw(), before);
  const stale = await call(f, 'api_note_review', { ...args, notes: [BAD_ID] });
  assert.equal(stale.receipt.refused, 'NOTE_DIGEST_CONFLICT');
  assert.ok(stale.receipt.next.includes(first.note_id));
  const batch = await call(f, 'api_note_review', { ...args, notes: [first.note_id, second.note_id] });
  assert.equal(batch.receipt.added, 1);
  const request = await call(f, 'api_note_review', { ...args, limits: undefined, notes: [first.note_id, second.note_id], decision: 'run-requested', reason: 'Check pagination in the local fixture.' });
  assert.equal(request.receipt.added, 2);
  assert.equal(request.receipt.requests_executed, 0);
  const retired = await call(f, 'api_note_retire', { operation: OP, retires: second.note_id, reason: 'other', text: 'The guidance is no longer useful.', evidence: ['run-reference'] });
  assert.ok(!retired.isError, JSON.stringify(retired.receipt));
  assert.equal(f.entry().note_retirements[0].reason, 'other');
  const held = await call(f, 'api_note_review', { ...args, notes: [first.note_id, second.note_id] });
  assert.deepEqual(held.receipt.held_back.map(row => row.note_id), [second.note_id]);
  const unknown = await call(f, 'api_note_review', { ...args, authenticated: true });
  assert.equal(unknown.receipt.refused, 'NOTE_REVIEW_INVALID');
});

test('MCP self-trust enforces local evidence and disabled/read-only bindings expose no review writes', async t => {
  const f = fixture(t), first = await note(f, 'Observed: a list is returned.', ['--by', 'Builder', '--actor', 'agent']);
  const args = { operation: OP, notes: [first.note_id], decision: 'trusted', by: 'Builder', actor: 'agent', evidence: ['run-missing'] };
  const before = f.raw();
  const denied = await call(f, 'api_note_review', args);
  assert.equal(denied.isError, true);
  assert.equal(denied.receipt.refused, 'NOTE_SELF_TRUST_EVIDENCE_UNAVAILABLE');
  assert.equal(f.raw(), before);
  localRun(f, 'run-mcp-new');
  const saved = await call(f, 'api_note_review', { ...args, evidence: ['run-mcp-new'] });
  assert.ok(!saved.isError, JSON.stringify(saved.receipt));
  for (const env of [{ [LIBRARIAN_READ_ONLY_ENV]: '1' }, { API_CONTEXT_OFF: '1' }]) {
    const listed = await mcp(f, { method: 'tools/list' }, env);
    assert.ok(!listed.result.tools.some(tool => ['api_note_review', 'api_note_retire'].includes(tool.name)));
    const bytes = f.raw();
    const write = await mcp(f, { method: 'tools/call', params: { name: 'api_note_review', arguments: args } }, env);
    assert.equal(write.error.code, -32602);
    assert.equal(f.raw(), bytes);
  }
});

test('review records remain protected under whole-context writes, malformed edits and baseline drift', async t => {
  const f = fixture(t), first = await note(f);
  await ok(f, review(first.note_id));
  const bytes = f.raw();
  inFixtureStack(f.root, () => {
    const snapshot = loadContextSnapshot(f.root);
    delete snapshot.ctx.operations[OP].note_reviews;
    assert.throws(() => saveContext(f.root, snapshot.ctx), error => error.code === 'NOTE_HISTORY_PROTECTED');
  });
  assert.equal(f.raw(), bytes);
  const edit = JSON.parse(bytes);
  edit.operations[OP].note_reviews[0].limits = 'hand-edited';
  writeFileSync(f.file, JSON.stringify(edit));
  const drift = await ok(f, ['show', OP]);
  assert.equal(drift.note_history.state, 'changed');
  assert.equal(drift.note_projection.records[0].review.state, 'unreviewed');
  await refused(f, review(first.note_id, 'disputed', ['--reason', 'Different result.', '--evidence', 'run-reference']), 'NOTE_REVIEW_HISTORY_CHANGED');
  edit.operations[OP].note_reviews[0].response = { payload: 'must never become review metadata' };
  writeFileSync(f.file, JSON.stringify(edit));
  await refused(f, review(first.note_id), 'NOTE_HISTORY_INVALID');
});

test('optimistic review writes rebase unrelated changes and refuse concurrent changes to the reviewed operation', async t => {
  const f = fixture(t), first = await note(f);
  inFixtureStack(f.root, () => {
    const change = { operation: OP, notes: [first.note_id], decision: 'trusted', by: 'Reviewer', actor: 'person', at: new Date().toISOString() };
    const evidence = ids => resolveNoteEvidence(ids, { evidenceDir: join(f.root, fixtureEvidencePath()), operation: OP });
    const snapshot = loadContextSnapshot(f.root);
    saveContextNote(f.root, snapshot, { operation: OTHER, note: 'Unrelated guidance.', stamp: { by: 'Author', at: new Date().toISOString() } });
    saveNoteReviews(f.root, snapshot, change, evidence);
    assert.equal(JSON.parse(f.raw()).operations[OTHER].notes[0], 'Unrelated guidance.');
    assert.equal(f.entry().note_reviews.length, 1);
    const stale = loadContextSnapshot(f.root);
    saveNoteReviews(f.root, stale, { ...change, decision: 'run-requested', reason: 'Check status.' }, evidence);
    const bytes = f.raw();
    assert.throws(() => saveNoteReviews(f.root, stale, { ...change, limits: 'local only' }, evidence), error => error.code === 'CONTEXT_NOTE_CONFLICT');
    assert.equal(f.raw(), bytes);
    assert.equal(inspectNoteHistory(f.entry()).state, 'healthy');
  });
});


test('both review sidecars are append-only and neither legacy acknowledgement nor resealing can bless tampering', async t => {
  const f = fixture(t), first = await note(f), second = await note(f, 'Another claim.', ['--alongside']);
  await ok(f, review(first.note_id));
  await ok(f, review(second.note_id));
  for (const id of [first.note_id, second.note_id]) await ok(f, ['note', OP, 'Removed.', '--retires', id,
    '--reason', 'removed', '--evidence', 'run-report']);
  const bytes = f.raw(), original = JSON.parse(bytes).operations[OP];
  for (const field of ['note_reviews', 'note_retirements']) {
    for (const mutate of [entry => { delete entry[field]; }, entry => entry[field].reverse(),
      entry => { entry[field][0].actor = 'person'; }]) {
      inFixtureStack(f.root, () => {
        const snapshot = loadContextSnapshot(f.root);
        mutate(snapshot.ctx.operations[OP]);
        // Make the actor mutation nontrivial for either original actor.
        if (JSON.stringify(snapshot.ctx.operations[OP][field]) === JSON.stringify(original[field]))
          snapshot.ctx.operations[OP][field][0].actor = 'agent';
        assert.throws(() => saveContext(f.root, snapshot.ctx), error => error.code === 'NOTE_HISTORY_PROTECTED');
      });
      assert.equal(f.raw(), bytes);
    }
    const edit = JSON.parse(bytes);
    edit.operations[OP][field][0].actor = original[field][0].actor === 'agent' ? 'person' : 'agent';
    writeFileSync(f.file, JSON.stringify(edit));
    const shown = await ok(f, ['show', OP]);
    assert.equal(shown.note_history.state, 'changed');
    assert.equal(shown.note_history.digest, v1Digest(original), 'review drift is independent of v1 history');
    await refused(f, ['review', '--accept-notes', OP, '--if-notes', shown.note_history.digest], 'NOTE_REVIEW_HISTORY_CHANGED');
    // Even a legacy writer replacing its entire baseline cannot bless sidecars.
    edit.operations[OP].note_integrity = { v: 1, digest: v1Digest(edit.operations[OP]), prior_integrity: 'unknown', acknowledgements: [] };
    writeFileSync(f.file, JSON.stringify(edit));
    assert.equal((await ok(f, ['show', OP])).note_history.state, 'changed');
    assert.throws(() => inFixtureStack(f.root, () => {
      const snapshot = loadContextSnapshot(f.root);
      delete snapshot.ctx.operations[OP].note_review_integrity;
      saveContext(f.root, snapshot.ctx);
    }), error => error.code === 'NOTE_HISTORY_PROTECTED');
    writeFileSync(f.file, bytes);
  }
  for (const mutate of [entry => { entry.note_retirements[0].replacement = BAD_ID; },
    entry => entry.note_retirements.push(entry.note_retirements[0]),
    entry => { entry.note_retirements[0].reason = 'Bearer ' + 'x'.repeat(48); },
    entry => { entry.note_replacements[0].reason = 'removed'; }]) {
    const edit = JSON.parse(bytes); mutate(edit.operations[OP]); writeFileSync(f.file, JSON.stringify(edit));
    await refused(f, ['review', '--accept-notes', OP, '--if-notes', v1Digest(edit.operations[OP])], 'NOTE_HISTORY_INVALID');
    writeFileSync(f.file, bytes);
  }
  const malformedBaseline = JSON.parse(bytes); malformedBaseline.operations[OP].note_review_integrity = null;
  writeFileSync(f.file, JSON.stringify(malformedBaseline));
  inFixtureStack(f.root, () => {
    const snapshot = loadContextSnapshot(f.root);
    delete snapshot.ctx.operations[OP].note_review_integrity;
    assert.throws(() => saveContext(f.root, snapshot.ctx), error => error.code === 'NOTE_HISTORY_PROTECTED');
  });
  assert.deepEqual(f.entry().note_review_integrity, null, 'malformed baseline bytes cannot be silently normalized');
  // Removing just the sidecar baseline also cannot turn recorded metadata into
  // legacy history that acknowledgement is allowed to accept.
  const edit = JSON.parse(bytes); delete edit.operations[OP].note_review_integrity;
  writeFileSync(f.file, JSON.stringify(edit));
  await refused(f, ['review', '--accept-notes', OP, '--if-notes', v1Digest(original)], 'NOTE_REVIEW_HISTORY_CHANGED');
  writeFileSync(f.file, bytes);
  inFixtureStack(f.root, () => {
    const snapshot = loadContextSnapshot(f.root);
    delete snapshot.ctx.operations[OP].note_integrity;
    // The supported legacy acknowledgement must retain a healthy sidecar seal.
    writeFileSync(f.file, JSON.stringify(snapshot.ctx));
  });
  await ok(f, ['review', '--accept-notes', OP, '--if-notes', v1Digest(original)]);
  assert.deepEqual(f.entry().note_review_integrity, original.note_review_integrity);
  assert.deepEqual(f.entry().note_reviews, original.note_reviews);
  assert.deepEqual(f.entry().note_retirements, original.note_retirements);
});

test('retirement races preserve both sidecars and an exact retry retains its original timestamp and actor', async t => {
  const f = fixture(t), first = await note(f);
  inFixtureStack(f.root, () => {
    const change = { operation: OP, note: 'Removed.', retirement: { note_id: first.note_id, reason: 'removed' },
      stamp: { by: 'Reviewer', actor: 'person', at: '2026-10-28', recorded_at: '2026-10-28T01:00:00.000Z' } };
    const snapshot = loadContextSnapshot(f.root);
    saveContextNote(f.root, snapshot, { operation: OTHER, note: 'Other operation.', stamp: change.stamp });
    const retired = saveContextNote(f.root, snapshot, change);
    const bytes = f.raw();
    assert.throws(() => saveContextNote(f.root, snapshot, { ...change, note: 'Different reason.' }), error => error.code === 'CONTEXT_NOTE_CONFLICT');
    const retry = saveContextNote(f.root, loadContextSnapshot(f.root), { ...change,
      stamp: { ...change.stamp, actor: 'agent', at: '2026-10-29', recorded_at: '2026-10-29T02:00:00.000Z' } });
    assert.equal(retry.unchanged, true);
    assert.equal(retry.note_id, retired.note_id);
    assert.equal(f.raw(), bytes);
    assert.equal(f.entry().note_retirements.length, 1);
    assert.equal(inspectNoteHistory(f.entry()).state, 'healthy');
  });
});

test('decisions on a retirement note lead with the decision and keep the retirement evidence in show and MCP context', async t => {
  const f = fixture(t), first = await note(f), ordinary = await note(f, 'Documented: pagination applies.', ['--alongside']);
  const retired = await ok(f, ['note', OP, 'The route was removed.', '--retires', first.note_id, '--reason', 'removed', '--by', 'Maintainer', '--actor', 'person']);
  const labels = async () => {
    const shown = await ok(f, ['show', OP]);
    const context = await call(f, 'api_note_context', { operation: OP, stack: 'fixture' });
    const delivered = JSON.stringify(context.receipt);
    const find = id => shown.note_projection.records.find(record => record.id === id).review;
    return { retirement: find(retired.note_id), ordinary: find(ordinary.note_id), delivered };
  };
  await ok(f, review(ordinary.note_id, 'run-requested', ['--reason', 'Check pagination.']));
  await ok(f, review(retired.note_id, 'run-requested', ['--reason', 'Confirm the route returns 404.']));
  let seen = await labels();
  assert.equal(seen.retirement.state, 'run-requested');
  assert.match(seen.retirement.label, /^run requested by Reviewer · no run · request: open · reason: "Confirm the route returns 404\." · retirement evidence: no run$/);
  assert.ok(seen.delivered.includes(JSON.stringify(seen.retirement.label)), 'MCP delivery carries the same label as show');
  assert.match(seen.ordinary.label, /^unreviewed · run-requested by Reviewer/, 'ordinary run requests keep their label');
  await ok(f, review(retired.note_id, 'disputed', ['--reason', 'The route still answers.']));
  seen = await labels();
  assert.equal(seen.retirement.state, 'disputed');
  assert.match(seen.retirement.label, /^disputed by Reviewer · no run · reason: "The route still answers\." · retirement evidence: no run$/);
  await ok(f, review(retired.note_id));
  seen = await labels();
  assert.equal(seen.retirement.state, 'trusted');
  assert.match(seen.retirement.label, /^trusted by Reviewer · no run · retirement evidence: no run$/);
  assert.ok(seen.delivered.includes(JSON.stringify(seen.retirement.label)));
});

test('review refusals from CLI and MCP name the selected operation and stack in a portable inspect command', async t => {
  const f = fixture(t), first = await note(f);
  await ok(f, review(first.note_id));
  const portable = next => {
    assert.ok(next.includes(`show '${OP}' --stack fixture --history`), next);
    assert.ok(!next.includes('METHOD /path'), next);
    assert.ok(!next.includes(f.root) && !next.includes(CLI) && !/(?:^|\s)node\s/.test(next), next);
  };
  const cliDispute = await refused(f, review(first.note_id, 'disputed', ['--reason', 'The status differs.']), 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  portable(cliDispute.next);
  const cliRetire = await refused(f, ['note', OP, 'Removed.', '--retires', first.note_id, '--reason', 'removed'], 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  portable(cliRetire.next);
  const cliStale = await refused(f, review(BAD_ID), 'NOTE_DIGEST_CONFLICT');
  portable(cliStale.next);
  assert.ok(cliStale.next.includes(first.note_id));
  const mcpDispute = await call(f, 'api_note_review', { operation: OP, stack: 'fixture', notes: [first.note_id], decision: 'disputed',
    by: 'MCP reviewer', actor: 'person', reason: 'The status differs.' });
  assert.equal(mcpDispute.receipt.refused, 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  portable(mcpDispute.receipt.next);
  const mcpRetire = await call(f, 'api_note_retire', { operation: OP, stack: 'fixture', retires: first.note_id, reason: 'removed', text: 'Removed.' });
  assert.equal(mcpRetire.receipt.refused, 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  portable(mcpRetire.receipt.next);
  assert.equal(mcpRetire.receipt.reason, cliRetire.reason, 'the refusal reason is the same static policy text');
  const unknown = await call(f, 'api_note_review', { operation: 'not an operation', notes: [first.note_id], decision: 'trusted', by: 'R', actor: 'person' });
  assert.equal(unknown.receipt.refused, 'NOTE_REVIEW_INVALID');
  assert.ok(!unknown.receipt.next.includes('not an operation'), 'rejected input is never echoed');
});

test('a review decision on a clone without setup registration or local shim keeps the committed setup marker and command spelling', async t => {
  const f = fixture(t), home = mkdtempSync(join(tmpdir(), 'note-reviews-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  f.env.HOME = home;
  const shim = join(f.root, 'node_modules', '.bin');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'sannr'), '#!/bin/sh\nexit 0\n'); chmodSync(join(shim, 'sannr'), 0o755);
  const first = await note(f);
  const connected = await cli(f, ['connect', '--agents', '--no-skills']);
  assert.equal(connected.code, 0, connected.stdout + connected.stderr);
  const agents = join(f.root, 'AGENTS.md'), before = readFileSync(agents, 'utf8');
  const marker = before.match(/^Expected tool description marker: Setup binding: setup-v1:[a-f0-9]{64}$/mu)?.[0];
  assert.ok(marker, 'connect wrote a setup marker');
  const spelled = before.split(`\`${POINTER_CLI_NAME} `).length - 1;
  assert.ok(spelled > 0, 'connect spelled commands with the portable word');
  // A fresh clone: no node_modules, no host registrations, an empty HOME.
  rmSync(join(f.root, 'node_modules'), { recursive: true, force: true });
  for (const file of MCP_REGISTRATION_FILES) rmSync(join(f.root, file), { force: true });
  const decided = await ok(f, review(first.note_id, 'run-requested', ['--reason', 'Check the list status.']));
  assert.equal(decided.pointers.state, 'written');
  const after = readFileSync(agents, 'utf8');
  assert.ok(after.split('\n').includes(marker), 'the committed setup marker survives the decision');
  assert.ok(!after.includes('A current setup identifier is not available'));
  assert.equal(after.split(`\`${POINTER_CLI_NAME} `).length - 1, spelled, 'command spellings are unchanged');
  assert.ok(!/npx --yes/.test(after));
  assert.match(after, /Review data: unreviewed · run-requested by Reviewer/);
  const strip = text => text.replace(/\[Review data:[^\]]*\]/gu, '');
  assert.equal(strip(after), strip(before), 'only the knowledge lines changed');
});
