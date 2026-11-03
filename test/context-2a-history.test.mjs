import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { CONTEXT_FILE, saveContext, loadContextSnapshot, saveContextNote, acceptNoteHistory, updateContext } from '../lib/context.mjs';
import { inspectNoteHistory, noteIdentity } from '../lib/note-history.mjs';
import { requestEvidenceOrigin, resolveNoteEvidence } from '../lib/note-evidence.mjs';

const stamp = { by: 'fixture-author', at: '2026-10-09' };
const key = { kind: 'stack' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'context-stack-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, CONTEXT_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ v: 0, api: { name: 'Fixture', contract: null, contract_digest: null }, operations: { 'GET /items': { notes: [] } } }));
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const append = (note, extra = {}) => saveContextNote(root, loadContextSnapshot(root), { key, note, stamp, ...extra });
  return { root, file, read, append, raw: () => readFileSync(file, 'utf8') };
}

test('CONTEXT-2a stack and operation typed keys share identity, supersession, explicit relationships and audit history', t => {
  const f = fixture(t);
  const first = f.append('The shared envelope carries a code.');
  assert.deepEqual(first.key, key);
  assert.equal(first.target, 'stack');
  assert.equal(first.history.state, 'healthy');
  assert.equal(first.note_id, noteIdentity('The shared envelope carries a code.', stamp));
  assert.throws(() => f.append('Inspect code before branching.'), { code: 'NOTE_RELATION_REQUIRED' });
  const corrected = f.append('Inspect code before branching.', { relation: { supersedes: first.note_id } });
  assert.deepEqual(corrected.history.active.map(r => r.text), ['Inspect code before branching.']);
  assert.equal(corrected.history.history[0].text, 'The shared envelope carries a code.');
  const before = f.raw();
  assert.equal(f.append('Inspect code before branching.', { relation: { supersedes: first.note_id } }).unchanged, true);
  assert.equal(f.raw(), before);
  const op = saveContextNote(f.root, loadContextSnapshot(f.root), { key: { kind: 'operation', op: 'GET /items' }, note: 'Inspect code before branching.', stamp });
  assert.equal(op.note_id, corrected.note_id);
  assert.equal(op.target, 'GET /items');
  assert.equal(f.read().operations['GET /items'].note_replacements, undefined);
});

test('CONTEXT-2a applicability is immutable note provenance and does not collapse same text on different operation scopes', t => {
  const f = fixture(t);
  const a = f.append('Use the shared beta header.', { operations: ['POST /items', 'GET /items', 'POST /items'] });
  assert.deepEqual(a.history.active[0].provenance.operations, ['GET /items', 'POST /items']);
  const b = f.append('Use the shared beta header.', { operations: ['GET /other'], relation: { alongside: true } });
  assert.notEqual(a.note_id, b.note_id);
  assert.equal(b.history.active.length, 2);
  assert.equal(f.append('Use the shared beta header.', { operations: ['POST /items', 'GET /items'] }).unchanged, true);
  const next = f.read(); next.stack_facts.notes_provenance[0].operations = ['GET /revised'];
  assert.throws(() => saveContext(f.root, next), { code: 'NOTE_HISTORY_PROTECTED' });
  assert.throws(() => f.append('Invalid scope.', { operations: ['GET /items?token=secret'] }), { code: 'NOTE_OPERATIONS_INVALID' });
  assert.throws(() => saveContextNote(f.root, loadContextSnapshot(f.root), { operation: 'GET /items', operations: ['GET /other'], note: 'Cannot add stack applicability to an operation.', stamp }), { code: 'NOTE_OPERATIONS_INVALID' });
});

test('CONTEXT-2a stack history is protected from stale whole-file writes and hand-edited deletion', t => {
  const f = fixture(t); f.append('One API-wide fact.');
  const stale = f.read();
  f.append('Another API-wide fact.', { relation: { alongside: true } });
  assert.throws(() => saveContext(f.root, stale), { code: 'NOTE_HISTORY_PROTECTED' });
  const removed = f.read(); delete removed.stack_facts;
  assert.throws(() => saveContext(f.root, removed), { code: 'NOTE_HISTORY_PROTECTED' });
  const changed = f.read(); changed.stack_facts.notes[0] = 'Externally changed fact.';
  writeFileSync(f.file, JSON.stringify(changed));
  assert.throws(() => f.append('A new fact.', { relation: { alongside: true } }), { code: 'NOTE_HISTORY_CHANGED' });
  const accepted = acceptNoteHistory(f.root, loadContextSnapshot(f.root), { key, stamp, expectedDigest: inspectNoteHistory(changed.stack_facts).digest });
  assert.equal(accepted.history.prior_integrity, 'unknown');
  assert.equal(accepted.acknowledgement.reason, 'baseline_mismatch');
});

test('CONTEXT-2a stack writes rebase unrelated operation writes and refuse concurrent stack edits', t => {
  const f = fixture(t); f.append('Original stack fact.');
  const beforeOp = loadContextSnapshot(f.root);
  saveContextNote(f.root, beforeOp, { operation: 'GET /items', note: 'Operation-specific fact.', stamp });
  const saved = saveContextNote(f.root, beforeOp, { key, note: 'Second stack fact.', stamp, relation: { alongside: true } });
  assert.deepEqual(saved.ctx.operations['GET /items'].notes, ['Operation-specific fact.']);
  assert.equal(saved.history.active.length, 2);
  assert.throws(() => saveContextNote(f.root, beforeOp, { key, note: 'Stale stack fact.', stamp, relation: { alongside: true } }), { code: 'CONTEXT_NOTE_CONFLICT' });
  updateContext(f.root, ctx => { ctx.extra = 'unrelated'; });
  assert.equal(inspectNoteHistory(f.read().stack_facts).state, 'healthy');
});

test('CONTEXT-2a stack facts retain the same bounded evidence projection and digest-bound immutable identity', t => {
  const f = fixture(t), evidenceDir = join(f.root, 'evidence'); mkdirSync(evidenceDir);
  const origin = requestEvidenceOrigin('cli.request', 'http', { operation: 'GET /items', environment: 'fixture', provider: 'https://example.test', contract_digest: null });
  writeFileSync(join(evidenceDir, 'run-stack-fixture.json'), JSON.stringify({ runId: 'run-stack-fixture', origin, response: { body: 'private-response-value' } }));
  const resolved = resolveNoteEvidence(['run-stack-fixture'], { evidenceDir, key, operations: ['GET /items', 'POST /items'], provider: 'https://example.test', environment: 'fixture' });
  assert.deepEqual(resolved.warnings, []);
  const saved = f.append('The shared envelope has a code.', { operations: ['GET /items', 'POST /items'], stamp: { ...stamp, evidence: resolved.references } });
  assert.equal(saved.history.state, 'healthy');
  assert.equal(saved.history.active[0].provenance.evidence[0].provenance.initiator, 'cli.request');
  assert.equal(f.raw().includes('private-response-value'), false);
  const mismatch = resolveNoteEvidence(['run-stack-fixture'], { evidenceDir, key, operations: ['GET /other'] });
  assert.equal(mismatch.references[0].state, 'scope_mismatch');
  assert.ok(mismatch.warnings.some(w => w.fields?.includes('operation')));
  const missing = resolveNoteEvidence(['run-absent'], { evidenceDir, key });
  assert.equal(missing.references[0].state, 'unavailable');
});

test('CONTEXT-2a all typed note writes share the secret guard and refuse unsupported future key kinds', t => {
  const f = fixture(t), before = f.raw();
  for (const target of [key, { kind: 'operation', op: 'GET /items' }]) {
    assert.throws(() => saveContextNote(f.root, loadContextSnapshot(f.root), { key: target, note: 'Token: ghp_fixturecredential012345678901234567890', stamp }), { code: 'SECRET_IN_NOTE' });
  }
  assert.throws(() => saveContextNote(f.root, loadContextSnapshot(f.root), { key: { kind: 'command', command: 'future' }, note: 'Future key.', stamp }), { code: 'NOTE_KEY_UNSUPPORTED' });
  assert.equal(f.raw(), before);
});

test('CONTEXT-2a malformed stack entry or provenance is refused without erasing the specimen', t => {
  for (const value of [null, false, 3, [], 'invalid']) {
    const f = fixture(t), ctx = f.read(); ctx.stack_facts = value; writeFileSync(f.file, JSON.stringify(ctx));
    const before = f.raw();
    assert.throws(() => f.append('Cannot overwrite malformed history.'), { code: 'NOTE_HISTORY_INVALID' });
    assert.equal(f.raw(), before);
  }
  const f = fixture(t); let accessed = false;
  const unsafe = { ...stamp, get operations() { accessed = true; return ['GET /items']; } };
  assert.throws(() => f.append('Accessor metadata cannot become a receipt.', { stamp: unsafe }), { code: 'NOTE_INPUT_INVALID' });
  assert.equal(accessed, false);
});
