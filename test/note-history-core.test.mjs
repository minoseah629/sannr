import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  CONTEXT_FILE, saveContext, loadContextSnapshot, saveContextNote, acceptNoteHistory,
  activeNotes, recordLearnFailure, mergeVerifiedEntry, updateContext,
} from '../lib/context.mjs';
import { inspectNoteHistory, noteIdentity, baselineNoteHistory } from '../lib/note-history.mjs';

const op = 'GET /items', stamp = { by: 'fixture-author', at: '2026-09-30' };
const original = 'Alpha.7 did not send the configured header.';
const replacement = 'Alpha.8 sends the configured header through the shared client.';
function fixture(entry = { notes: [] }) {
  const root = mkdtempSync(join(tmpdir(), 'note-history-'));
  const file = join(root, CONTEXT_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 0, operations: { [op]: entry }, untouched: { a: 1 } }));
  return { root, file, read: () => JSON.parse(readFileSync(file, 'utf8')), raw: () => readFileSync(file, 'utf8') };
}
const append = (f, text, relation, extraStamp = {}) => saveContextNote(f.root, loadContextSnapshot(f.root),
  { operation: op, note: text, stamp: { ...stamp, ...extraStamp }, ...(relation ? { relation } : {}) });
const accept = f => acceptNoteHistory(f.root, loadContextSnapshot(f.root), {
  operation: op, expectedDigest: inspectNoteHistory(f.read().operations[op]).digest, stamp,
});
const fails = (code, fn) => assert.throws(fn, error => error.code === code);

test('first note acquires a full stable identity and baseline; whitespace JSON changes do not alter either', () => {
  const f = fixture();
  const saved = append(f, original);
  assert.match(saved.note_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(saved.history.state, 'healthy');
  const before = inspectNoteHistory(f.read().operations[op]);
  writeFileSync(f.file, JSON.stringify(f.read(), null, 7));
  assert.equal(inspectNoteHistory(f.read().operations[op]).digest, before.digest);
  assert.equal(noteIdentity('x', { at: stamp.at, by: stamp.by }), noteIdentity('x', { by: stamp.by, at: stamp.at }));
  assert.notEqual(noteIdentity('x', stamp), noteIdentity('x', { ...stamp, by: 'someone-else' }));
});

test('existing authored notes require an explicit relationship; alongside keeps both active', () => {
  const f = fixture(); append(f, original);
  const before = f.raw();
  fails('NOTE_RELATION_REQUIRED', () => append(f, replacement));
  assert.equal(f.raw(), before);
  const saved = append(f, replacement, { alongside: true });
  assert.deepEqual(saved.history.active.map(r => r.text), [original, replacement]);
});

test('correction retains text and provenance, changes only active guidance, and is idempotent', () => {
  const f = fixture(); const first = append(f, original);
  const prior = structuredClone(f.read().operations[op].notes_provenance[0]);
  const saved = append(f, replacement, { supersedes: first.note_id });
  assert.deepEqual(f.read().operations[op].notes, [original, replacement]);
  assert.deepEqual(f.read().operations[op].notes_provenance[0], prior);
  assert.deepEqual(activeNotes(f.read().operations[op]), [replacement]);
  assert.equal(saved.history.history[0].superseded.kind, 'authored');
  const before = f.raw();
  const retried = append(f, replacement, { supersedes: first.note_id }, { at: '2026-10-01' });
  assert.equal(retried.unchanged, true);
  assert.equal(f.raw(), before);
  fails('NOTE_ALREADY_SUPERSEDED', () => append(f, 'Different replacement.', { supersedes: first.note_id }));
});

test('active duplicate is a no-op, but does not swallow a requested relationship', () => {
  const f = fixture(); const old = append(f, original);
  append(f, replacement, { alongside: true });
  assert.equal(append(f, replacement).unchanged, true);
  const saved = append(f, replacement, { supersedes: old.note_id });
  assert.equal(saved.unchanged, false);
  assert.equal(saved.history.history.length, 1);
  assert.equal(saved.history.records.length, 3);
  assert.notEqual(saved.history.records[1].id, saved.history.records[2].id);
});

test('selectors are full, exact, operation-bound and cannot target themselves or absent notes', () => {
  const f = fixture(); const first = append(f, original);
  fails('NOTE_RELATION_INVALID', () => append(f, replacement, { supersedes: '0' }));
  fails('NOTE_NOT_FOUND', () => append(f, replacement, { supersedes: `sha256:${'a'.repeat(64)}` }));
  fails('NOTE_SELF_SUPERSESSION', () => append(f, original, { supersedes: first.note_id }));
  fails('NOTE_RELATION_INVALID', () => append(f, replacement, { alongside: true, supersedes: first.note_id }));
});

test('legacy notes require reviewed first baseline with original attribution left unknown', () => {
  const f = fixture({ notes: [original] });
  assert.equal(inspectNoteHistory(f.read().operations[op]).state, 'unbaselined');
  const before = f.raw();
  assert.equal(append(f, original).unchanged, true);
  assert.equal(f.raw(), before, 'a duplicate read/no-op does not establish a baseline');
  fails('NOTE_BASELINE_REQUIRED', () => append(f, replacement, { alongside: true }));
  const saved = accept(f);
  assert.equal(saved.history.prior_integrity, 'unknown');
  assert.equal(saved.acknowledgement.reason, 'first_baseline');
  assert.equal(f.read().operations[op].notes_provenance, undefined);
  append(f, replacement, { alongside: true });
  assert.equal(f.read().operations[op].notes_provenance[0], null);
  assert.equal(inspectNoteHistory(f.read().operations[op]).prior_integrity, 'unknown');
});

test('an aligned deletion is detectable; acceptance preserves mismatch receipt but cannot restore text', () => {
  const f = fixture(); append(f, original); append(f, replacement, { alongside: true });
  const ctx = f.read();
  const oldDigest = ctx.operations[op].note_integrity.digest;
  for (const field of ['notes', 'notes_provenance', 'notes_superseded']) ctx.operations[op][field].pop();
  writeFileSync(f.file, JSON.stringify(ctx));
  assert.equal(inspectNoteHistory(f.read().operations[op]).state, 'changed');
  fails('NOTE_HISTORY_CHANGED', () => append(f, replacement, { alongside: true }));
  const saved = accept(f);
  assert.equal(saved.acknowledgement.previous_digest, oldDigest);
  assert.equal(saved.acknowledgement.reason, 'baseline_mismatch');
  assert.deepEqual(f.read().operations[op].notes, [original]);
  assert.equal(saved.history.prior_integrity, 'unknown');
});

test('marker edits are hashed and do not hide text under a changed baseline', () => {
  const f = fixture(); append(f, original);
  const ctx = f.read();
  ctx.operations[op].notes_superseded[0] = { reason: 'successful_verification', at: stamp.at };
  writeFileSync(f.file, JSON.stringify(ctx));
  const inspected = inspectNoteHistory(ctx.operations[op]);
  assert.equal(inspected.state, 'changed');
  assert.deepEqual(activeNotes(ctx.operations[op]), [original]);
});

test('malformed parallel arrays and malformed relationships cannot be accepted or normalized by learning', () => {
  for (const entry of [
    { notes: [original], notes_provenance: [] },
    { notes: [original], notes_superseded: [true] },
    { notes: [original], notes_provenance: null },
    { notes: [original], note_replacements: [{ supersedes: 'broken' }] },
  ]) {
    const f = fixture(entry); const before = f.raw();
    assert.equal(inspectNoteHistory(entry).state, 'invalid');
    fails('NOTE_HISTORY_INVALID', () => accept(f));
    fails('NOTE_HISTORY_INVALID', () => mergeVerifiedEntry(entry, { verified_at: '2026-09-30T00:00:00Z' }, stamp));
    assert.equal(f.raw(), before);
  }
});

test('ambiguous note identities, dangling links and cycles are visible integrity failures', () => {
  const a = noteIdentity('a', stamp), b = noteIdentity('b', stamp);
  const entries = [
    { notes: ['a', 'a'], notes_provenance: [stamp, stamp] },
    { notes: ['a'], notes_provenance: [stamp], note_replacements: [{ supersedes: a, replacement: b, ...stamp }] },
    { notes: ['a', 'b'], notes_provenance: [stamp, stamp], note_replacements: [
      { supersedes: a, replacement: b, ...stamp }, { supersedes: b, replacement: a, ...stamp },
    ] },
  ];
  for (const entry of entries) {
    const out = inspectNoteHistory(entry);
    assert.equal(out.state, 'invalid');
    assert.equal(out.history.length, 0);
    assert.equal(out.active.length, entry.notes.length);
  }
});

test('concurrent same-operation corrections refuse; unrelated-operation write rebases once', () => {
  const f = fixture(); const first = append(f, original);
  const stale = loadContextSnapshot(f.root);
  append(f, replacement, { supersedes: first.note_id });
  fails('CONTEXT_NOTE_CONFLICT', () => saveContextNote(f.root, stale, {
    operation: op, note: 'Concurrent correction.', stamp, relation: { supersedes: first.note_id },
  }));
  const before = loadContextSnapshot(f.root);
  updateContext(f.root, ctx => { ctx.operations['GET /other'] = { notes: [] }; });
  const saved = saveContextNote(f.root, before, { operation: op, note: 'An additional fact.', stamp, relation: { alongside: true } });
  assert.ok(saved.ctx.operations['GET /other']);
  assert.equal(saved.history.active.length, 2);
});

test('a second injected write after unrelated rebase refuses without overwriting it', () => {
  const f = fixture(); append(f, original);
  const snapshot = loadContextSnapshot(f.root);
  updateContext(f.root, ctx => { ctx.untouched.a = 2; });
  fails('CONTEXT_WRITE_CONFLICT', () => saveContextNote(f.root, snapshot, {
    operation: op, note: replacement, stamp, relation: { alongside: true },
  }, { afterReapply() { const next = f.read(); next.untouched.a = 3; writeFileSync(f.file, JSON.stringify(next)); } }));
  assert.equal(f.read().untouched.a, 3);
  assert.deepEqual(f.read().operations[op].notes, [original]);
});

test('whole-operation deletion protects authored and unattributed history', () => {
  for (const attributed of [true, false]) {
    const f = fixture(attributed ? { notes: [] } : { notes: [original] });
    if (attributed) append(f, original);
    const next = f.read(); delete next.operations[op];
    fails('NOTE_HISTORY_PROTECTED', () => saveContext(f.root, next));
    assert.ok(f.read().operations[op]);
  }
  const f = fixture({ notes: ['Unreachable at https://api.example.test: ECONNREFUSED'] });
  const next = f.read(); delete next.operations[op];
  fails('NOTE_HISTORY_PROTECTED', () => saveContext(f.root, next));
});

test('shared writers preserve unrelated suspect history without resealing it', () => {
  const f = fixture(); append(f, original);
  const next = f.read(); next.operations[op].notes[0] = 'Changed outside the recorded baseline.';
  writeFileSync(f.file, JSON.stringify(next));
  const priorBaseline = next.operations[op].note_integrity;
  updateContext(f.root, ctx => { ctx.api_context = { observations: [] }; });
  assert.deepEqual(f.read().operations[op].note_integrity, priorBaseline);
  assert.equal(inspectNoteHistory(f.read().operations[op]).state, 'changed');
  const proposed = f.read(); proposed.operations[op].notes.push('Another change.');
  proposed.operations[op].notes_provenance.push(stamp); proposed.operations[op].notes_superseded.push(null);
  fails('NOTE_HISTORY_CHANGED', () => saveContext(f.root, proposed));
});

test('stale whole-file writes cannot drop an intervening authored append', () => {
  const f = fixture(); append(f, original);
  const stale = f.read(); append(f, replacement, { alongside: true });
  stale.untouched.a = 2;
  fails('NOTE_HISTORY_PROTECTED', () => saveContext(f.root, stale));
  assert.equal(f.read().operations[op].notes.length, 2);
});

test('machine recovery preserves authored claims even when their text matches legacy failure format', () => {
  const text = 'Unreachable at https://api.example.test: ECONNREFUSED';
  const entry = baselineNoteHistory({ notes: [text], notes_provenance: [stamp] });
  const next = mergeVerifiedEntry(entry, { verified_at: '2026-09-30T00:00:00Z', verified_by: stamp.by }, stamp);
  assert.deepEqual(activeNotes(next), [text]);
  assert.equal(inspectNoteHistory(next).state, 'healthy');
  const unattributed = baselineNoteHistory({ notes: [text] }, { prior: 'unknown' });
  const legacy = mergeVerifiedEntry(unattributed, { verified_at: '2026-09-30T00:00:00Z' }, stamp);
  assert.deepEqual(activeNotes(legacy), [text], 'text resemblance does not establish machine ownership');
});

test('machine failure/recovery preserves authored relationships and produces distinct repeated-note identities', () => {
  const f = fixture(); const first = append(f, original); append(f, replacement, { supersedes: first.note_id });
  let entry = f.read().operations[op];
  entry = recordLearnFailure(entry, { status: 401, stamp });
  assert.equal(inspectNoteHistory(entry).state, 'healthy');
  entry = mergeVerifiedEntry(entry, { verified_at: '2026-09-30T00:00:00Z', verified_by: stamp.by }, stamp);
  entry = recordLearnFailure(entry, { status: 401, stamp });
  assert.equal(inspectNoteHistory(entry).state, 'healthy');
  assert.equal(new Set(inspectNoteHistory(entry).records.map(r => r.id)).size, 4);
  assert.equal(entry.note_replacements.length, 1);
  assert.ok(!activeNotes(entry).includes(original));
});

test('the additive relationship survives the alpha.8 machine-marker normalization algorithm', () => {
  const f = fixture(); const first = append(f, original); append(f, replacement, { supersedes: first.note_id });
  const before = f.read().operations[op];
  // Frozen shape of alpha.8 merge: spread entry, normalize only its three
  // parallel arrays. This checks compatibility mechanics, not a native pilot.
  const older = { ...before, notes: [...before.notes], notes_provenance: [...before.notes_provenance],
    notes_superseded: before.notes_superseded.map(marker => marker?.reason === 'successful_verification' || marker?.reason === 'maintenance_staleness' ? marker : null) };
  assert.deepEqual(older.note_replacements, before.note_replacements);
  assert.deepEqual(activeNotes(older), [replacement]);
  assert.equal(inspectNoteHistory(older).state, 'healthy');
});

test('baseline acceptance is digest-bound, rejects races, and is idempotent', () => {
  const f = fixture({ notes: [original] });
  const snapshot = loadContextSnapshot(f.root);
  fails('NOTE_DIGEST_CONFLICT', () => acceptNoteHistory(f.root, snapshot, { operation: op, expectedDigest: `sha256:${'f'.repeat(64)}`, stamp }));
  const saved = accept(f); const bytes = f.raw();
  assert.equal(accept(f).unchanged, true); assert.equal(f.raw(), bytes);
  fails('CONTEXT_NOTE_CONFLICT', () => acceptNoteHistory(f.root, snapshot, { operation: op, expectedDigest: saved.history.digest, stamp }));
});

test('evidence metadata participates in identity and baseline; payloads and malformed references are refused', () => {
  const evidence = [{ run_id: 'run-local-fixture', state: 'available', digest: `sha256:${'a'.repeat(64)}`,
    provenance: { initiator: 'cli.learn', transport: 'api_request:http', observed_at: '2026-09-30T00:00:00.000Z',
      package_version: '0.1.0-alpha.8', build_id: null },
    scope: { operation: op, protocol: 'http', environment: 'fixture', provider: 'https://api.example.test', contract_digest: null } }];
  const f = fixture(); const saved = append(f, original, undefined, { evidence });
  assert.equal(saved.history.state, 'healthy');
  assert.deepEqual(saved.history.active[0].provenance.evidence, evidence);
  assert.notEqual(saved.note_id, noteIdentity(original, stamp));
  for (const change of [
    ref => { ref.body = { private: 'payload' }; },
    ref => { ref.scope.provider = 'https://name:password@api.example.test'; },
    ref => { ref.scope.operation = 'GET /items?token=xoxb-1234567890abcdef'; },
    ref => { ref.provenance.initiator = 'inferred-from-headers'; },
    ref => { ref.digest = 'sha256:short'; },
  ]) {
    const bad = structuredClone(evidence); change(bad[0]);
    const entry = { notes: [original], notes_provenance: [{ ...stamp, evidence: bad }] };
    assert.equal(inspectNoteHistory(entry).state, 'invalid');
    const next = fixture(); const before = next.raw();
    fails('NOTE_INPUT_INVALID', () => append(next, original, undefined, { evidence: bad }));
    assert.equal(next.raw(), before);
  }
});

test('an authored append cannot forge machine ownership or persist arbitrary provenance payloads', () => {
  const f = fixture(); const before = f.raw();
  fails('NOTE_INPUT_INVALID', () => append(f, original, undefined, { kind: 'learn_verification_failure' }));
  fails('NOTE_INPUT_INVALID', () => append(f, original, undefined, { body: { response: 'private' } }));
  assert.equal(f.raw(), before);
});

test('whole-file writers cannot quietly normalize malformed raw arrays or erase an invalid baseline', () => {
  for (const field of ['notes_provenance', 'notes_superseded', 'note_integrity']) {
    const f = fixture({ notes: [], [field]: null });
    const next = f.read(); delete next.operations[op][field];
    assert.throws(() => saveContext(f.root, next), error => ['NOTE_HISTORY_INVALID', 'NOTE_HISTORY_PROTECTED'].includes(error.code));
    assert.equal(f.read().operations[op][field], null);
  }
});

test('accepting an empty edited history retains a protected acknowledgement of the loss', () => {
  const f = fixture(); append(f, original);
  const edited = f.read();
  for (const field of ['notes', 'notes_provenance', 'notes_superseded']) edited.operations[op][field] = [];
  writeFileSync(f.file, JSON.stringify(edited));
  const accepted = accept(f);
  assert.equal(accepted.history.state, 'empty');
  assert.equal(accepted.history.prior_integrity, 'unknown');
  assert.equal(accepted.ctx.operations[op].note_integrity.acknowledgements[0].reason, 'baseline_mismatch');
  const next = f.read(); delete next.operations[op];
  fails('NOTE_HISTORY_PROTECTED', () => saveContext(f.root, next));
});

test('a new operation key cannot mutate the operations object prototype', () => {
  const f = fixture();
  fails('NOTE_NOT_FOUND', () => acceptNoteHistory(f.root, loadContextSnapshot(f.root), {
    operation: '__proto__', expectedDigest: inspectNoteHistory({}).digest, stamp,
  }));
  assert.equal(Object.prototype.note_integrity, undefined);
  const saved = saveContextNote(f.root, loadContextSnapshot(f.root), {
    operation: '__proto__', note: original, stamp,
  });
  assert.equal(Object.hasOwn(saved.ctx.operations, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(saved.ctx.operations), Object.prototype);
  assert.deepEqual(f.read().operations.__proto__.notes, [original]);
  assert.equal(Object.prototype.notes, undefined);
});
