// FIELD-1b EXIT-001 / CLI-009: offline synthetic note/refusal receipts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { requestEvidenceOrigin } from '../lib/note-evidence.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const OP = 'GET /widgets';
const FIRST = 'The fixture accepts a cursor documented by its provider.';
const NEXT = 'The fixture requires the cursor returned by the preceding page.';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'field-1b-notes-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Synthetic fixture author'], { cwd: root });
  createFixtureStack(root, { baseUrl: 'https://fixture.example.test' });
  writeFileSync(fixtureContextFile(root), JSON.stringify({ v: 0, api: { name: 'Fixture API' }, operations: {} }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_')));
  Object.assign(env, { HOME: root, [HOME_ENV_NAME]: root, API_REPO_ROOT: root, API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', NO_COLOR: '1' });
  const cli = (...args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const note = (...args) => {
    const result = cli('note', OP, ...args);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const saveEvidence = (id, operation = OP) => writeFileSync(join(root, fixtureEvidencePath(), `${id}.json`), JSON.stringify({ runId: id,
    origin: requestEvidenceOrigin('cli.request', 'http', { operation, environment: 'local', provider: 'https://fixture.example.test' }) }));
  return { root, cli, note, saveEvidence, bytes: () => readFileSync(fixtureContextFile(root), 'utf8'),
    entry: () => JSON.parse(readFileSync(fixtureContextFile(root), 'utf8')).operations[OP] };
}

test('FIELD-1b non-secret note relationship refusals use exit 3 and leave history unchanged', t => {
  const f = fixture(t); f.note(FIRST); const bytes = f.bytes();
  const refused = f.cli('note', OP, NEXT);
  assert.equal(refused.code, 3);
  assert.equal(JSON.parse(refused.stderr).refused, 'NOTE_RELATION_REQUIRED');
  assert.equal(f.bytes(), bytes);
});

test('FIELD-1b note accepts --json before or after operands and returns JSON refusals on stdout', t => {
  const f = fixture(t);
  const saved = f.cli('note', '--json', OP, FIRST);
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  assert.equal(JSON.parse(saved.stdout).recorded, FIRST);
  const bytes = f.bytes();
  const refused = f.cli('note', OP, NEXT, '--json');
  assert.equal(refused.code, 3);
  assert.equal(refused.stderr, '');
  assert.equal(JSON.parse(refused.stdout).refused, 'NOTE_RELATION_REQUIRED');
  assert.equal(f.bytes(), bytes);
});

test('FIELD-1b note JSON secret and usage refusals keep their distinct exit codes', t => {
  const f = fixture(t), bytes = f.bytes();
  for (const [text, flags, code, named] of [
    ['Synthetic ghp_' + 'x'.repeat(40), [], 2, 'SECRET_IN_NOTE'],
    [FIRST, ['--unknown-option'], 1, 'NOTE_OPTION_INVALID'],
    ['', [], 1, 'NOTE_ARGUMENTS_REQUIRED'],
  ]) {
    const refused = f.cli('note', OP, text, ...flags, '--json');
    assert.equal(refused.code, code);
    assert.equal(refused.stderr, '');
    const payload = JSON.parse(refused.stdout);
    assert.equal(payload.refused ?? payload.error?.code, named);
    assert.equal(f.bytes(), bytes);
  }
});

test('FIELD-1b history policy refusals use exit 3 across note, review and prune', t => {
  const f = fixture(t); const first = f.note(FIRST); f.note(NEXT, '--supersedes', first.note_id);
  for (const args of [
    ['note', OP, 'A different replacement.', '--supersedes', first.note_id],
    ['note', OP, 'A missing target.', '--supersedes', `sha256:${'f'.repeat(64)}`],
    ['review', '--drop', OP], ['prune', OP],
  ]) {
    const bytes = f.bytes(), refused = f.cli(...args);
    assert.equal(refused.code, 3, refused.stdout + refused.stderr);
    assert.equal(f.bytes(), bytes);
  }
});

for (const attachNewEvidence of [false, true]) test(`FIELD-1b replacement and retry receipts name exact saved evidence (new evidence: ${attachNewEvidence})`, t => {
  const f = fixture(t);
  f.saveEvidence('run-original', 'GET /unrelated');
  f.saveEvidence('run-replacement');
  const first = f.note(FIRST, '--evidence', 'run-original');
  const previous = structuredClone(f.entry().notes_provenance[0]);
  const args = [NEXT, '--supersedes', first.note_id, ...(attachNewEvidence ? ['--evidence', 'run-replacement'] : [])];
  const replacement = f.note(...args);
  const saved = f.entry().notes_provenance[1].evidence ?? [];
  assert.deepEqual(replacement.evidence, saved);
  assert.deepEqual(replacement.evidence.map(ref => ref.run_id), attachNewEvidence ? ['run-replacement'] : []);
  assert.match(replacement.evidence_attachment, /not inherited/);
  assert.deepEqual(f.entry().notes_provenance[0], previous);
  const bytes = f.bytes();
  const retry = f.note(...args, '--evidence', 'run-unattached');
  assert.deepEqual(retry.evidence, saved);
  assert.match(retry.evidence_attachment, /unchanged/);
  assert.equal(retry.evidence_warnings, undefined, 'warnings from the retry must not look like warnings about saved evidence');
  assert.deepEqual(retry.requested_evidence_warnings, [{ run_id: 'run-unattached', code: 'EVIDENCE_MISSING' }]);
  assert.equal(f.bytes(), bytes);
});

test('FIELD-1b every help page documents the same distinct policy-refusal exit code', t => {
  const f = fixture(t), top = f.cli('--help');
  assert.equal(top.code, 0);
  const expected = top.stdout.slice(top.stdout.indexOf('Exit codes'));
  assert.match(expected, /^  2   refused .*secret/m);
  assert.match(expected, /^  3   policy refused .*non-secret/m);
  const commands = [...top.stdout.matchAll(/^  ([a-z]+) +\S/gm)].map(match => match[1]);
  assert.ok(commands.includes('note'));
  for (const command of commands) {
    const result = f.cli(command, '--help');
    assert.equal(result.code, 0);
    assert.equal(result.stdout.slice(result.stdout.indexOf('Exit codes')), expected, command);
  }
  assert.match(f.cli('note', '--help').stdout, /--json/);
});
