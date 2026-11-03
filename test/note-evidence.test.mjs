import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, truncateSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveNoteEvidence, requestEvidenceOrigin } from '../lib/note-evidence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'note-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const evidenceDir = join(root, 'evidence'); mkdirSync(evidenceDir);
  const save = (id, value) => { const file = join(evidenceDir, `${id}.json`); writeFileSync(file, JSON.stringify(value)); return file; };
  return { root, evidenceDir, save };
}
const scope = { operation: 'GET /members/{id}', protocol: 'http', environment: 'local', provider: 'https://fixture.example', contractDigest: `sha256:${'a'.repeat(64)}` };

test('note evidence projects only bounded provenance and verifies exact bytes', t => {
  const { evidenceDir, save } = fixture(t);
  const file = save('run-fixture', { runId: 'run-fixture', origin: requestEvidenceOrigin('cli.learn', 'http', scope), request: { headers: { authorization: 'private-value' }, url: 'https://fixture.example/members/123?personal=private-value' }, response: { body: 'private-value' } });
  const { references, warnings } = resolveNoteEvidence(['run-fixture', 'run-fixture'], { evidenceDir, ...scope });
  assert.equal(references.length, 1); assert.deepEqual(warnings, []);
  assert.equal(references[0].state, 'available');
  assert.equal(references[0].provenance.initiator, 'cli.learn');
  assert.equal(references[0].digest, `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`);
  const shared = JSON.stringify(references);
  for (const value of ['private-value', 'authorization', '/members/123', evidenceDir]) assert.equal(shared.includes(value), false);
});

test('legacy evidence never infers producer from auth headers or onboarding purpose', t => {
  const { evidenceDir, save } = fixture(t);
  save('run-old', { purpose: 'onboarding', request: { authUsed: 'bearer:ENV_NAME', headers: { authorization: '[redacted]' } } });
  const { references, warnings } = resolveNoteEvidence(['run-old', 'run-missing'], { evidenceDir, operation: scope.operation });
  assert.equal(references[0].state, 'available');
  assert.equal(references[0].provenance.initiator, 'unknown');
  assert.equal(references[0].scope.operation, null);
  assert.equal(references[1].state, 'unavailable');
  assert.equal(references[1].code, 'EVIDENCE_MISSING');
  assert.ok(warnings.some(x => x.code === 'EVIDENCE_ORIGIN_UNKNOWN'));
  assert.ok(warnings.some(x => x.code === 'EVIDENCE_SCOPE_UNKNOWN'));
});

test('known scope mismatches are explicit, never verified by a valid digest', t => {
  const { evidenceDir, save } = fixture(t);
  save('run-other', { origin: requestEvidenceOrigin('cli.request', 'http', scope) });
  const result = resolveNoteEvidence(['run-other'], { evidenceDir, operation: 'POST /members', environment: 'prod', provider: 'https://other.example', contractDigest: `sha256:${'b'.repeat(64)}` });
  assert.equal(result.references[0].state, 'scope_mismatch');
  assert.deepEqual(result.warnings[0].fields, ['operation', 'environment', 'provider', 'contract_digest']);
  assert.equal(Object.hasOwn(result.references[0], 'verified'), false);
});

test('resolver refuses traversal, non-IDs, oversized batches and unsafe evidence entries', t => {
  const { root, evidenceDir, save } = fixture(t);
  for (const id of ['../run-secret', 'run-../../secret', 'run-fixture.json', 'run-x/secret', 'run-x\\secret', 'run-\0x', 'run-', 'run-ghp_syntheticfixture12345']) assert.throws(() => resolveNoteEvidence([id], { evidenceDir }), { code: 'EVIDENCE_ID_INVALID' });
  assert.throws(() => resolveNoteEvidence(Array(17).fill('run-x'), { evidenceDir }), { code: 'EVIDENCE_ID_INVALID' });
  const target = save('run-original', {});
  symlinkSync(target, join(evidenceDir, 'run-symlink.json'));
  linkSync(target, join(evidenceDir, 'run-hardlink.json'));
  mkdirSync(join(evidenceDir, 'run-directory.json'));
  for (const id of ['run-symlink', 'run-hardlink', 'run-directory']) assert.throws(() => resolveNoteEvidence([id], { evidenceDir }), { code: 'EVIDENCE_FILE_UNSAFE' });
  symlinkSync(evidenceDir, join(root, 'linked-root'));
  assert.throws(() => resolveNoteEvidence(['run-original'], { evidenceDir: join(root, 'linked-root') }), { code: 'EVIDENCE_ROOT_UNSAFE' });
  symlinkSync(root, join(root, 'linked-parent'));
  assert.throws(() => resolveNoteEvidence(['run-original'], { evidenceDir: join(root, 'linked-parent', 'evidence') }), { code: 'EVIDENCE_ROOT_UNSAFE' });
  const big = save('run-big', {}); truncateSync(big, 16 * 1024 * 1024 + 1);
  assert.throws(() => resolveNoteEvidence(['run-big'], { evidenceDir }), { code: 'EVIDENCE_TOO_LARGE' });
});

test('resolver labels malformed files and rejects mismatched embedded identity', t => {
  const { root, evidenceDir, save } = fixture(t);
  writeFileSync(join(evidenceDir, 'run-invalid.json'), '{not json');
  save('run-array', []);
  const result = resolveNoteEvidence(['run-invalid', 'run-array'], { evidenceDir });
  assert.deepEqual(result.references.map(x => x.code), ['EVIDENCE_INVALID_JSON', 'EVIDENCE_INVALID_RECORD']);
  save('run-wrong', { runId: 'run-somewhere-else' });
  assert.throws(() => resolveNoteEvidence(['run-wrong'], { evidenceDir }), { code: 'EVIDENCE_RUN_ID_MISMATCH' });
  assert.equal(resolveNoteEvidence(['run-absent'], { evidenceDir: join(root, 'absent') }).references[0].code, 'EVIDENCE_MISSING');
});

test('untrusted metadata is projected through closed bounded fields', t => {
  const { evidenceDir, save } = fixture(t);
  save('run-spoof', { origin: { v: 1, initiator: 'response-secret', transport: 'body-value', observed_at: 'yesterday', package_version: '1.2.3-ghp-syntheticfixture12345', build_id: 'private-value', scope: { operation: 'bearer:ghp_syntheticfixture12345', environment: 'private@example.test', provider: 'https://user:password@fixture.test/', contract_digest: 'private-value' }, payload: 'private-value' } });
  const { references } = resolveNoteEvidence(['run-spoof'], { evidenceDir });
  assert.equal(references[0].provenance.initiator, 'unknown');
  assert.equal(references[0].scope.operation, null);
  assert.equal(references[0].provenance.package_version, null);
  assert.equal(JSON.stringify(references).includes('private-value'), false);
});
