// Independent acceptance checks for authored correction and history retention.
// Only scratch repositories and a loopback HTTP fixture are used. The real
// customer repositories and the npm registry are never read or changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(SOURCE, 'bin/cli.mjs');
const OP = 'GET /api/user';
const OLD = 'Alpha.7: learn omitted the Authorization header; the resulting 401 did not prove the token was invalid.';
const NEW = 'Alpha.8: learn sends the configured Authorization header. Ordinary request evidence does not establish what alpha.7 learn sent.';
const EXTRA = 'This historical explanation remains an author claim; the cited request alone does not establish the cause.';
const FULL_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TOKEN = 'local-fixture-credential-not-for-promotion';
const raw = fixture => readFileSync(fixtureContextFile(fixture.root), 'utf8');
const ctx = fixture => JSON.parse(raw(fixture));
const entry = fixture => ctx(fixture).operations[OP];

function scratch(t, { operations = {} } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'note-supersession-acceptance-')));
  const machine = mkdtempSync(join(tmpdir(), 'note-supersession-machine-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(machine, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Independent fixture author'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'loopback fixture', version: '1' }, paths: {
    '/api/user': { get: { responses: { '200': { description: 'ok', content: { 'application/json': { schema: {
      type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'],
    } } } } } } },
  } }));
  createFixtureStack(root, { environment: 'fixture', baseUrl: 'http://127.0.0.1:1', contract: 'openapi.json' });
  writeFileSync(fixtureContextFile(root), JSON.stringify({ v: 0, api: { name: 'acceptance fixture', contract: `${LAYOUT.collection}/fixture/openapi.json` }, operations }, null, 2) + '\n');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_') && key !== HOME_ENV_NAME));
  Object.assign(environment, { HOME: machine, [HOME_ENV_NAME]: machine, API_REPO_ROOT: root, API_CONTEXT_DIR: root,
    API_USAGE_LOG: join(root, LAYOUT.evidence, 'usage.jsonl'), API_EVIDENCE: join(root, LAYOUT.evidence),
    API_BUDGET: '220', API_FRICTION_OFF: '1', NO_COLOR: '1' });
  return { root, machine, environment };
}

function cli(fixture, args, extra = {}) {
  if (args[0] === 'doctor') args = [...args, '--stack', 'fixture'];
  return new Promise(resolve => execFile(process.execPath, [CLI, ...args], {
    cwd: fixture.root, encoding: 'utf8', timeout: 20000,
    env: { ...fixture.environment, ...extra },
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr, output: stdout + stderr })));
}
async function success(fixture, args, extra) {
  const result = await cli(fixture, args, extra);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.output}`);
  return result;
}
async function show(fixture) { return JSON.parse((await success(fixture, ['show', OP])).stdout); }
function record(shown, text, which = 'active') {
  const found = shown.note_history?.[which]?.find(note => note.text === text);
  assert.ok(found, `${which} projection must carry ${text}`);
  assert.match(found.id, FULL_DIGEST, 'selectors are full stable note identities');
  return found;
}
async function firstNote(fixture, text = OLD, options = []) {
  const result = await success(fixture, ['note', OP, text, ...options]);
  const shown = await show(fixture);
  assert.equal(shown.note_history.state, 'healthy');
  return { result, shown, note: record(shown, text) };
}
function mutate(fixture, change) {
  const current = ctx(fixture); change(current);
  writeFileSync(fixtureContextFile(fixture.root), JSON.stringify(current, null, 2) + '\n');
}
async function acknowledge(fixture) {
  const shown = await show(fixture);
  assert.match(shown.note_history.digest, FULL_DIGEST);
  return success(fixture, ['review', '--accept-notes', OP, '--if-notes', shown.note_history.digest, '--json']);
}
async function assertRefusedWithoutWrite(fixture, args, pattern) {
  const before = raw(fixture), result = await cli(fixture, args);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, pattern);
  assert.equal(raw(fixture), before, 'a refusal must leave knowledge bytes unchanged');
  return result;
}

test('QA a historical alpha.7 claim survives correction, active pointers refresh, and a replacement retry is byte-idempotent', async t => {
  const f = scratch(t);
  writeFileSync(join(f.root, 'AGENTS.md'), 'A team-owned instruction remains here.\n');
  await success(f, ['connect', '--agents', '--no-skills']);
  const initial = await firstNote(f), prior = structuredClone(entry(f));
  assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /Alpha\.7: learn omitted/);

  const refusal = await assertRefusedWithoutWrite(f, ['note', OP, NEW], /NOTE_RELATION_REQUIRED/u);
  assert.ok(refusal.output.includes(initial.note.id), 'refusal supplies the existing selector');
  assert.match(refusal.output, /--supersedes/u);
  assert.match(refusal.output, /--alongside/u);

  const correction = await success(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  const now = await show(f), saved = entry(f);
  assert.deepEqual(saved.notes, [OLD, NEW], 'raw historical order is preserved');
  assert.deepEqual(saved.notes_provenance[0], prior.notes_provenance[0], 'original attribution is not rewritten');
  assert.deepEqual(now.active_notes, [NEW]);
  assert.equal(record(now, OLD, 'history').id, initial.note.id);
  const current = record(now, NEW);
  assert.notEqual(current.id, initial.note.id);
  const output = JSON.parse(correction.stdout);
  assert.equal(output.note_id, current.id);
  assert.notEqual(output.pointers.state, 'failed');
  const pointer = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(pointer.includes(NEW), pointer);
  assert.ok(!pointer.includes(OLD), 'default guidance must not resurrect the historical claim');
  assert.ok(pointer.includes('A team-owned instruction remains here.'));

  const bytes = raw(f);
  const retry = await success(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  assert.equal(raw(f), bytes, 'exact replacement retry does not append or reseal');
  assert.ok(JSON.parse(retry.stdout).unchanged, retry.stdout);
  const liveHuman = await success(f, ['show', OP, '--human']);
  assert.ok(liveHuman.stdout.includes(NEW));
  assert.ok(!liveHuman.stdout.includes(OLD));
  const fullHuman = await success(f, ['show', OP, '--human', '--history']);
  assert.ok(fullHuman.stdout.includes(NEW) && fullHuman.stdout.includes(OLD));
});

test('QA alongside records an unresolved competing claim and an active duplicate remains a no-op', async t => {
  const f = scratch(t), initial = await firstNote(f);
  await success(f, ['note', OP, EXTRA, '--alongside']);
  const shown = await show(f);
  assert.deepEqual(shown.active_notes, [OLD, EXTRA]);
  assert.equal(shown.note_history.history.length, 0, 'alongside does not silently adjudicate truth');
  assert.equal(record(shown, OLD).id, initial.note.id);
  const bytes = raw(f);
  await success(f, ['note', OP, OLD]);
  assert.equal(raw(f), bytes, 'an already active note needs no relationship choice');
  assert.equal(entry(f).verified_at, null, 'authored explanations are not execution verification');
});

test('QA pointer failure is separate from a successful knowledge save and an exact retry repairs guidance without another note', async t => {
  const f = scratch(t);
  writeFileSync(join(f.root, 'AGENTS.md'), 'Keep the team instruction.\n');
  await success(f, ['connect', '--agents', '--no-skills']);
  const initial = await firstNote(f), goodPointer = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  // Duplicate the existing closing delimiter: an edited managed block is a
  // conflict, and Sannr must not overwrite it merely because history saved.
  const end = goodPointer.match(/<!--[^\n]*:end\s*-->/u)?.[0];
  assert.ok(end, 'fixture has a managed closing delimiter');
  writeFileSync(join(f.root, 'AGENTS.md'), goodPointer + '\n' + end + '\n');
  const replacement = await cli(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  assert.notEqual(replacement.code, 0, replacement.output);
  assert.deepEqual(entry(f).notes, [OLD, NEW], 'a pointer conflict must not pretend the saved note was rolled back');
  const output = JSON.parse(replacement.stdout);
  assert.equal(output.pointers.state, 'failed');
  assert.ok(output.pointers.retry, 'partial completion has an actionable idempotent recovery path');
  const bytes = raw(f);
  writeFileSync(join(f.root, 'AGENTS.md'), goodPointer);
  const retry = await success(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  assert.equal(raw(f), bytes);
  assert.ok(JSON.parse(retry.stdout).unchanged);
  const repaired = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(repaired.includes(NEW) && !repaired.includes(OLD));
  assert.ok(repaired.includes('Keep the team instruction.'));
});

test('QA note identities are operation scoped and malformed, shifted-index, absent and inactive targets cannot replace guidance', async t => {
  const f = scratch(t), initial = await firstNote(f);
  await success(f, ['note', 'GET /other', 'An unrelated operation has its own distinct constraint.']);
  const other = JSON.parse((await success(f, ['show', 'GET /other'])).stdout).note_history.active[0];
  assert.notEqual(other.id, initial.note.id);
  for (const selector of ['0', 'sha256:abc', other.id, 'sha256:' + '0'.repeat(64)]) {
    await assertRefusedWithoutWrite(f, ['note', OP, NEW, '--supersedes', selector], /NOTE_|SUPERSESSION/u);
  }
  await success(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  await assertRefusedWithoutWrite(f, ['note', OP, EXTRA, '--supersedes', initial.note.id], /NOTE_|SUPERSESSION/u);
});

test('QA an existing unbaselined history needs a reviewed acknowledgement and retains its integrity limit', async t => {
  const legacy = { notes: [OLD], notes_provenance: [{ by: 'prior-author', at: '2026-09-29' }], notes_superseded: [null] };
  const f = scratch(t, { operations: { [OP]: legacy } });
  const shown = await show(f);
  assert.equal(shown.note_history.state, 'unbaselined');
  assert.deepEqual(shown.notes, [OLD]);
  await assertRefusedWithoutWrite(f, ['note', OP, NEW, '--alongside'], /NOTE_|INTEGRITY|BASELINE/u);
  const before = raw(f);
  await assertRefusedWithoutWrite(f, ['review', '--accept-notes', OP, '--if-notes', 'sha256:' + '0'.repeat(64)], /NOTE_|INTEGRITY|CONFLICT/u);
  assert.equal(raw(f), before);
  const accepted = JSON.parse((await acknowledge(f)).stdout);
  assert.equal(accepted.accepted_notes, OP);
  const reviewed = await show(f);
  assert.equal(reviewed.note_history.state, 'healthy');
  assert.match(JSON.stringify(reviewed.note_history.prior_integrity), /unknown/u, 'first review cannot certify the earlier history');
  assert.deepEqual(entry(f).notes_provenance, legacy.notes_provenance);
  const bytes = raw(f);
  await acknowledge(f);
  assert.equal(raw(f), bytes, 'acknowledgement retry is idempotent');
  await success(f, ['note', OP, NEW, '--supersedes', record(reviewed, OLD).id]);
  assert.deepEqual((await show(f)).active_notes, [NEW]);
});

test('QA formatting-only edits preserve the baseline; aligned deletion is visible and requires explicit recovery', async t => {
  const f = scratch(t), initial = await firstNote(f);
  await success(f, ['note', OP, EXTRA, '--alongside']);
  const healthy = await show(f);
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(ctx(f)));
  const reformatted = await show(f);
  assert.equal(reformatted.note_history.state, 'healthy');
  assert.equal(reformatted.note_history.digest, healthy.note_history.digest);

  mutate(f, current => {
    const e = current.operations[OP];
    for (const key of ['notes', 'notes_provenance', 'notes_superseded']) e[key].splice(0, 1);
  });
  const removedBytes = raw(f), changed = await show(f);
  assert.equal(changed.note_history.state, 'changed');
  assert.ok(changed.active_notes.includes(EXTRA), 'suspect remaining guidance is still inspectable');
  assert.match(JSON.stringify(changed.note_history.issues), /note history differs from its recorded baseline/iu);
  assert.ok(!JSON.stringify(changed.note_history.issues).match(/edited outside|external actor|on or before/u), 'a digest cannot identify the edit actor or time');
  await assertRefusedWithoutWrite(f, ['note', OP, NEW, '--alongside'], /NOTE_|INTEGRITY/u);
  await assertRefusedWithoutWrite(f, ['review', '--confirm', OP], /NOTE_|INTEGRITY/u);
  const doctor = await cli(f, ['doctor', '--offline', '--json']);
  assert.ok(doctor.stdout.trim(), `doctor must return its diagnostic ledger\n${doctor.output}`);
  const report = JSON.parse(doctor.stdout);
  const notes = report.checks.filter(check => /note/u.test(check.name));
  assert.ok(notes.some(check => check.state === 'WARN' && /recorded baseline/u.test(check.detail)), doctor.output);
  assert.equal(raw(f), removedBytes, 'inspection never silently reseals deleted history');
  await acknowledge(f);
  const acknowledged = await show(f);
  assert.equal(acknowledged.note_history.state, 'healthy');
  assert.ok(JSON.stringify(entry(f)).includes(healthy.note_history.baseline_digest), 'recovery keeps the previous baseline in a receipt');
  assert.ok(!entry(f).notes.includes(OLD), 'acknowledgement must not pretend to reconstruct lost text');
  assert.ok(!acknowledged.note_history.active.some(note => note.id === initial.note.id));
});

for (const scenario of [
  { name: 'different parallel-array lengths', change: e => { e.notes_provenance = []; } },
  { name: 'a non-array marker field', change: e => { e.notes_superseded = {}; } },
  { name: 'missing author/time within a present attribution', change: e => { e.notes_provenance[0] = { by: 'fixture' }; } },
  { name: 'an invalid present machine marker', change: e => { e.notes_superseded[0] = { reason: 'unknown', by: 'fixture', at: '2026-09-30' }; } },
  { name: 'duplicate note identities', change: e => {
    e.notes.push(e.notes[0]); e.notes_provenance.push(structuredClone(e.notes_provenance[0])); e.notes_superseded.push(null);
  } },
]) test(`QA raw ${scenario.name} is reported before normalization and cannot be accepted as healthy`, async t => {
  const f = scratch(t); await firstNote(f);
  mutate(f, current => scenario.change(current.operations[OP]));
  const bytes = raw(f), shownResult = await cli(f, ['show', OP]);
  const shown = JSON.parse(shownResult.stdout);
  assert.equal(shown.note_history.state, 'invalid');
  assert.ok(shown.notes.includes(OLD), 'malformed metadata must not hide the raw claim');
  const doctor = await cli(f, ['doctor', '--offline', '--json']);
  assert.notEqual(doctor.code, 0);
  assert.ok(doctor.stdout.trim(), `doctor must return its diagnostic ledger\n${doctor.output}`);
  assert.ok(JSON.parse(doctor.stdout).checks.some(check => /note/u.test(check.name) && check.state === 'FAIL'), doctor.output);
  await assertRefusedWithoutWrite(f, ['note', OP, NEW, '--alongside'], /NOTE_|INTEGRITY/u);
  await assertRefusedWithoutWrite(f, ['review', '--accept-notes', OP, '--if-notes', shown.note_history.digest], /NOTE_|INTEGRITY/u);
  assert.equal(raw(f), bytes);
});

test('QA legacy missing attribution stays unknown and both authored and unattributed operation history resist drop/prune', async t => {
  const f = scratch(t, { operations: { [OP]: { notes: [OLD] }, 'GET /empty': { source_file: null, notes: [] } } });
  const bytes = raw(f), shown = await show(f);
  assert.ok(shown.notes.includes(OLD));
  assert.match(JSON.stringify(shown.note_history.issues), /unknown|missing|attribution/u);
  assert.equal(raw(f), bytes);
  for (const args of [['review', '--drop', OP], ['prune', OP]]) await assertRefusedWithoutWrite(f, args, /NOTE_|HISTORY|PROTECTED/u);
  await acknowledge(f);
  for (const args of [['review', '--drop', OP], ['prune', OP]]) await assertRefusedWithoutWrite(f, args, /NOTE_|HISTORY|PROTECTED/u);
  await success(f, ['review', '--drop', 'GET /empty']);
  assert.ok(!(ctx(f).operations['GET /empty']), 'an empty history does not block ordinary explicit curation');
  const authored = scratch(t); await firstNote(authored);
  for (const args of [['review', '--drop', OP], ['prune', OP]]) await assertRefusedWithoutWrite(authored, args, /NOTE_|HISTORY|PROTECTED/u);
});

test('QA valid credential references in prose pass but malformed references, mixed secret values and operation-position credentials do not', async t => {
  const references = ['bearer:FIXTURE_TOKEN', 'header:X-API-Key:FIXTURE_KEY', 'query:key:FIXTURE_KEY', 'oauth:FIXTURE_CLIENT:FIXTURE_SECRET'];
  for (const reference of references) {
    const f = scratch(t), text = `Use the configured reference (${reference}) for this integration.`;
    await firstNote(f, text);
    assert.ok(entry(f).notes.includes(text));
  }
  const secrets = [
    'Use bearer:FIXTURE_TOKEN-value instead.',
    'Use bearer:fixture_token instead.',
    'Use bearer:FIXTURE_TOKEN and ghp_' + 'x'.repeat(40) + '.',
    'Use header:X-API-Key:FIXTURE_KEY and password=fixture-real-secret-value.',
    'The credentials are at https://fixture-user:fixture-password@example.invalid/api.',
  ];
  for (const text of secrets) {
    const f = scratch(t);
    await assertRefusedWithoutWrite(f, ['note', OP, text], /SECRET_IN_NOTE/u);
    assert.ok(!raw(f).includes(text));
  }
  const f = scratch(t);
  await assertRefusedWithoutWrite(f, ['note', 'GET /api/user?access_token=ghp_' + 'z'.repeat(40), 'A safe explanation'], /SECRET_IN_NOTE/u);
});

async function httpFixture(t) {
  const f = scratch(t), requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorized: req.headers.authorization === `Bearer ${TOKEN}` });
    const status = req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { ready: true } : { error: 'authentication required' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  createFixtureStack(f.root, { environment: 'fixture', baseUrl: origin, contract: 'openapi.json',
    environmentConfig: { auth: 'bearer:API_ACCEPTANCE_TOKEN' } });
  f.environment.API_ACCEPTANCE_TOKEN = TOKEN;
  f.environment.API_ENV = 'fixture';
  return { ...f, origin, requests };
}
const localEvidence = fixture => readdirSync(join(fixture.root, fixtureEvidencePath())).filter(name => /^run-.+\.json$/u.test(name))
  .map(name => ({ id: name.slice(0, -5), bytes: readFileSync(join(fixture.root, fixtureEvidencePath(), name), 'utf8'),
    data: JSON.parse(readFileSync(join(fixture.root, fixtureEvidencePath(), name), 'utf8')) }));

test('QA linked evidence distinguishes an ordinary authenticated request, learn and doctor without promoting headers or bodies', async t => {
  const f = await httpFixture(t);
  await success(f, ['init']);
  await success(f, ['request', 'GET', '/api/user', '--expect-status', '200']);
  const request = localEvidence(f).find(run => run.data.origin?.initiator === 'cli.request');
  assert.ok(request, 'ordinary request has its own internal origin');
  assert.equal(request.data.origin.scope.operation, OP);
  await firstNote(f, OLD, ['--evidence', request.id]);
  const linked = entry(f).notes_provenance[0].evidence[0];
  assert.equal(linked.run_id, request.id);
  assert.equal(linked.state, 'available', JSON.stringify({ linked, origin: request.data.origin, contract: ctx(f).api }));
  assert.match(linked.digest, FULL_DIGEST);
  assert.equal(linked.provenance.initiator, 'cli.request');
  assert.equal(linked.provenance.transport, 'api_request:http');
  assert.ok(linked.provenance.observed_at);
  assert.match(linked.provenance.package_version, /^\d+\.\d+\.\d+/u);
  assert.equal(entry(f).verified_at, null, 'citing an asserted request does not verify an authored explanation');

  await success(f, ['learn']);
  const learned = localEvidence(f).find(run => run.data.origin?.initiator === 'cli.learn');
  assert.ok(learned, 'learn is not indistinguishable from an ordinary client request');
  assert.ok(f.requests.some(req => req.authorized));
  await cli(f, ['doctor', '--probe', `${f.origin}/api/user`, '--json']);
  const probed = localEvidence(f).find(run => run.data.origin?.initiator === 'cli.doctor');
  assert.ok(probed, 'doctor initiator is stamped explicitly, not inferred from onboarding purpose');
  await success(f, ['note', OP, NEW, '--supersedes', record(await show(f), OLD).id,
    '--evidence', learned.id, '--evidence', probed.id]);
  const replacement = entry(f).notes_provenance[1];
  assert.deepEqual(replacement.evidence.map(ref => ref.provenance.initiator).sort(), ['cli.doctor', 'cli.learn']);
  assert.ok(!raw(f).includes(TOKEN));
  assert.ok(!raw(f).includes('authentication required'), 'private response bodies are not committed via the evidence link');
  assert.ok(!raw(f).includes('authorization'), 'raw request headers are not committed via the evidence link');
});

test('QA human note evidence labels attachment history explicitly after its private receipt is absent', async t => {
  const f = await httpFixture(t);
  await success(f, ['init']);
  await success(f, ['request', 'GET', '/api/user', '--expect-status', '200']);
  const request = localEvidence(f).find(run => run.data.origin?.initiator === 'cli.request');
  await firstNote(f, OLD, ['--evidence', request.id]);
  rmSync(join(f.root, fixtureEvidencePath(), `${request.id}.json`));
  const human = await success(f, ['show', OP, '--human']);
  assert.ok(human.stdout.includes(`Evidence ${request.id}: attachment-time state available; current receipt availability not checked`));
  assert.ok(!human.stdout.includes(`Evidence ${request.id}: available;`));
  assert.equal(entry(f).notes_provenance[0].evidence[0].state, 'available', 'historical provenance is preserved');
});

test('QA legacy and missing evidence retain unknown/unavailable origin, exact evidence IDs cannot escape the repo', async t => {
  const f = scratch(t), id = 'run-11111111-1111-4111-8111-111111111111';
  writeFileSync(join(f.root, fixtureEvidencePath(), `${id}.json`), JSON.stringify({ request: { method: 'GET', path: '/api/user' }, response: { status: 200 } }));
  await firstNote(f, OLD, ['--evidence', id]);
  const legacy = entry(f).notes_provenance[0].evidence[0];
  assert.equal(legacy.provenance.initiator, 'unknown');
  assert.match(legacy.digest, FULL_DIGEST);
  const missing = 'run-22222222-2222-4222-8222-222222222222';
  await success(f, ['note', OP, EXTRA, '--alongside', '--evidence', missing]);
  assert.equal(entry(f).notes_provenance[1].evidence[0].state, 'unavailable');
  assert.equal(entry(f).notes_provenance[1].evidence[0].provenance.initiator, 'unknown');
  for (const id of ['../other', `../../${missing}`, `${missing}.json`, `${missing}/child`]) {
    await assertRefusedWithoutWrite(f, ['note', OP, NEW, '--alongside', '--evidence', id], /EVIDENCE|NOTE_/u);
  }
  const outside = join(f.machine, 'external-private-evidence.json');
  writeFileSync(outside, JSON.stringify({ request: { headers: { authorization: TOKEN } }, response: { body: 'private-payload' } }));
  const linkedId = 'run-33333333-3333-4333-8333-333333333333';
  symlinkSync(outside, join(f.root, fixtureEvidencePath(), `${linkedId}.json`));
  const result = await cli(f, ['note', OP, NEW, '--alongside', '--evidence', linkedId]);
  assert.ok(result.code !== 0 || entry(f).notes_provenance.at(-1).evidence[0].state === 'unavailable', result.output);
  assert.ok(!raw(f).includes(TOKEN) && !raw(f).includes('private-payload'));
});

for (const mode of ['dangling', 'cyclic']) test(`QA a ${mode} replacement relationship stays visible as an integrity failure`, async t => {
  const f = scratch(t), original = await firstNote(f);
  await success(f, ['note', OP, NEW, '--supersedes', original.note.id]);
  mutate(f, current => {
    const links = current.operations[OP].note_replacements;
    if (mode === 'dangling') links[0].replacement = 'sha256:' + 'f'.repeat(64);
    else links.push({ ...links[0], supersedes: links[0].replacement, replacement: links[0].supersedes });
  });
  const bytes = raw(f), result = await cli(f, ['show', OP]), shown = JSON.parse(result.stdout);
  assert.equal(shown.note_history.state, 'invalid');
  assert.deepEqual(shown.active_notes, [OLD, NEW], 'a damaged relationship cannot silently hide historical claims');
  assert.match(JSON.stringify(shown.note_history.issues), mode === 'dangling' ? /DANGLING/u : /CYCLE/u);
  const doctor = await cli(f, ['doctor', '--offline', '--json']);
  assert.notEqual(doctor.code, 0);
  assert.ok(JSON.parse(doctor.stdout).checks.some(check => /note/u.test(check.name) && check.state === 'FAIL'));
  await assertRefusedWithoutWrite(f, ['note', OP, EXTRA, '--alongside'], /NOTE_HISTORY_INVALID/u);
  assert.equal(raw(f), bytes);
});

test('QA a client observation can preserve a suspect history without resealing it; learn refuses before sending a request', async t => {
  const f = await httpFixture(t); await success(f, ['init']); await firstNote(f);
  await success(f, ['note', OP, EXTRA, '--alongside']);
  const baseline = entry(f).note_integrity.digest;
  mutate(f, current => { current.operations[OP].notes[0] += ' A hand-edited claim.'; });
  const editedNotes = structuredClone(entry(f).notes);
  const sent = f.requests.length;
  await success(f, ['request', 'GET', '/api/user', '--expect-status', '200']);
  assert.equal(f.requests.length, sent + 1, 'the independent client observation still executes once');
  assert.ok(Object.values(ctx(f).api_context.operations).some(operation => operation.observations.length > 0));
  assert.deepEqual(entry(f).notes, editedNotes);
  assert.equal(entry(f).note_integrity.digest, baseline, 'observing a response must not bless a prior manual edit');
  assert.equal((await show(f)).note_history.state, 'changed');
  const beforeLearn = raw(f), beforeRequests = f.requests.length;
  const refused = await cli(f, ['learn']);
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, /NOTE_HISTORY_CHANGED/u);
  assert.equal(f.requests.length, beforeRequests, 'learn resolves note-integrity refusal before entering its request loop');
  assert.equal(raw(f), beforeLearn);
  await success(f, ['note', 'GET /other', 'An independent operation has independent context.']);
  assert.equal(entry(f).note_integrity.digest, baseline);
  assert.deepEqual(entry(f).notes, editedNotes);
  assert.equal((await show(f)).note_history.state, 'changed');
});

test('QA client delivery, granted lookup, graph export, human library and receipts agree on active guidance', async t => {
  const f = await httpFixture(t); await success(f, ['init']);
  const initial = await firstNote(f);
  await success(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  const response = JSON.parse((await success(f, ['request', 'GET', '/api/user', '--expect-status', '200'], { API_BUDGET: '4000' })).stdout);
  assert.deepEqual(response.known.notes, [NEW]);
  assert.ok(!JSON.stringify(response.known).includes(OLD));

  // These repo-level readers retain their implicit-store path until STACKS-2.
  // Supply that read-only projection with the exact stack snapshot just tested;
  // all authored writes and live requests above still use the real stack.
  writeFileSync(join(f.root, LAYOUT.context), raw(f));

  const consumer = scratch(t); consumer.environment[HOME_ENV_NAME] = f.machine;
  await success(consumer, ['grant', f.root]);
  const remote = await show(consumer);
  assert.ok(remote.from, 'the granted answer identifies the provider');
  assert.deepEqual(remote.active_notes, [NEW]);
  assert.equal(record(remote, OLD, 'history').id, initial.note.id);

  writeFileSync(join(f.root, LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/api', name: 'QA fixture' },
    nodes: [{ id: 'api', kind: 'service', name: 'QA API', protocol: 'http' }], dependencies: [], context: { legacy: 'api' },
  }));
  await success(f, ['graph', 'export', '--json']);
  const exported = JSON.parse(readFileSync(join(f.root, LAYOUT.graphSnapshot), 'utf8'));
  const exportedNotes = exported.knowledge.flatMap(record => record.notes ?? []);
  assert.ok(exportedNotes.includes(NEW), 'portable graph includes current authored guidance');
  assert.ok(!exportedNotes.includes(OLD), 'portable graph cannot resurrect replaced guidance');
  assert.match(exported.omissions.join(' '), /superseded/u, 'the export reports the omitted historical note');

  const library = JSON.parse((await success(f, ['view', '--json'])).stdout);
  const html = readFileSync(library.path, 'utf8');
  assert.ok(html.indexOf(NEW) >= 0 && html.indexOf(OLD) > html.indexOf(NEW), 'the human library presents active guidance before retained history');
  assert.match(html, /superseded|Superseded/u);
  const receipt = JSON.parse((await success(f, ['receipt', '--json'])).stdout);
  assert.deepEqual(receipt.gotchas.operations.find(operation => operation.op === OP)?.notes, [NEW]);
  assert.equal(receipt.gotchas.notes_delivered, 1, 'receipt counts recorded deliveries rather than all retained history');
});

test('QA a phrase resembling a generated failure remains authored when learn later verifies the API', async t => {
  const f = await httpFixture(t); await success(f, ['init']);
  const phrase = `Unreachable at ${f.origin}: ECONNREFUSED`;
  const original = await firstNote(f, phrase);
  await success(f, ['learn']);
  const now = await show(f);
  assert.deepEqual(now.active_notes, [phrase]);
  assert.equal(record(now, phrase).id, original.note.id);
  assert.equal(record(now, phrase).kind, 'authored');
  assert.equal(entry(f).notes_superseded[0], null, 'machine recovery cannot infer ownership from matching text');
});

test('QA an acknowledged unattributed duplicate preserves its original unknown author and does not attach new evidence', async t => {
  const f = scratch(t, { operations: { [OP]: { notes: [OLD], notes_provenance: [null], notes_superseded: [null] } } });
  await acknowledge(f);
  const original = await show(f), bytes = raw(f);
  const missingId = 'run-44444444-4444-4444-8444-444444444444';
  const duplicate = JSON.parse((await success(f, ['note', OP, OLD, '--evidence', missingId])).stdout);
  assert.ok(duplicate.unchanged, 'the existing active claim remains a no-op');
  assert.equal(duplicate.note_id, record(original, OLD).id);
  assert.equal(duplicate.by, null, 'the receipt must not manufacture attribution from the current Git author');
  assert.equal(duplicate.at, null, 'the receipt must not present the retry date as the original recorded date');
  assert.deepEqual(duplicate.evidence, [], 'new attempted evidence references do not become saved references on a duplicate');
  assert.match(duplicate.evidence_attachment, /unchanged/u);
  assert.equal(raw(f), bytes);
  assert.deepEqual(entry(f).notes_provenance, [null]);
  assert.equal(entry(f).note_integrity.prior_integrity, 'unknown');
});

test('QA accepting a reviewed edited relationship refreshes active managed guidance and its retry preserves the acknowledgement', async t => {
  const f = scratch(t);
  writeFileSync(join(f.root, 'AGENTS.md'), 'A team-owned instruction remains here.\n');
  await success(f, ['connect', '--agents', '--no-skills']);
  const initial = await firstNote(f);
  await success(f, ['note', OP, NEW, '--supersedes', initial.note.id]);
  const pointerBefore = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(pointerBefore.includes(NEW) && !pointerBefore.includes(OLD));
  // An external, structurally valid reversal is still suspect until explicitly
  // reviewed. Acknowledgement accepts these bytes, not their explanatory truth.
  mutate(f, current => {
    const link = current.operations[OP].note_replacements[0];
    [link.supersedes, link.replacement] = [link.replacement, link.supersedes];
  });
  const edited = await show(f);
  assert.equal(edited.note_history.state, 'changed');
  assert.deepEqual(edited.active_notes, [OLD, NEW], 'suspect relationships do not silently hide either claim');
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), pointerBefore);
  const command = ['review', '--accept-notes', OP, '--if-notes', edited.note_history.digest, '--json'];
  const accepted = JSON.parse((await success(f, command)).stdout);
  assert.equal(accepted.pointers.state, 'written');
  assert.deepEqual(accepted.note_history.active.map(note => note.text), [OLD]);
  const refreshed = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.ok(refreshed.includes(OLD) && !refreshed.includes(NEW), 'review refreshes the now accepted active projection');
  assert.ok(refreshed.includes('A team-owned instruction remains here.'));
  const bytes = raw(f), receipts = structuredClone(entry(f).note_integrity.acknowledgements);
  const retry = JSON.parse((await success(f, command)).stdout);
  assert.equal(retry.unchanged, true);
  assert.equal(retry.pointers.state, 'unchanged');
  assert.equal(raw(f), bytes);
  assert.deepEqual(entry(f).note_integrity.acknowledgements, receipts);
  assert.deepEqual(entry(f).notes, [OLD, NEW]);
});

test('QA a partial temporary-pointer write failure preserves the original and removes the owned incomplete file', async t => {
  const f = scratch(t), file = join(f.root, 'AGENTS.md');
  writeFileSync(file, 'original instruction\n');
  // Isolate the filesystem fault in a subprocess, so no other acceptance case
  // or test worker inherits the patched built-in. This simulates ENOSPC after
  // the helper has exclusively opened and partly written its owned temporary.
  const program = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const file = ${JSON.stringify(file)}, root = ${JSON.stringify(f.root)};
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (target, text, options) => {
      if (typeof target === 'number') {
        originalWrite(target, 'partial', options);
        throw Object.assign(new Error('synthetic write failure'), { code: 'ENOSPC' });
      }
      return originalWrite(target, text, options);
    };
    syncBuiltinESMExports();
    let errorCode;
    try {
      const { replaceNotePointer } = await import(${JSON.stringify(new URL('../lib/note-pointers.mjs', import.meta.url).href)});
      try { replaceNotePointer(file, 'replacement\\n', { expectedText: 'original instruction\\n' }); }
      catch (error) { errorCode = error.code; }
    } finally {
      fs.writeFileSync = originalWrite;
      syncBuiltinESMExports();
    }
    console.log(JSON.stringify({ errorCode,
      originalRetained: fs.readFileSync(file, 'utf8') === 'original instruction\\n',
      orphanedTemps: fs.readdirSync(root).filter(name => name.includes('.refresh-')).length }));
  `;
  const result = await new Promise(resolve => execFile(process.execPath, ['--input-type=module', '-e', program], {
    cwd: f.root, encoding: 'utf8', timeout: 10000, env: f.environment,
  }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { errorCode: 'ENOSPC', originalRetained: true, orphanedTemps: 0 });
  assert.equal(readFileSync(file, 'utf8'), 'original instruction\n');
});
