import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { workbenchHandlers, workbenchAssets, workbenchSnapshot } from '../lib/workbench-engine.mjs';
import { createWorkbenchServer } from '../lib/workbench-server.mjs';
import { requestEvidenceOrigin } from '../lib/note-evidence.mjs';
import { loadHttpContract } from '../lib/http-operation-context.mjs';
import { operationId, contextShape } from '../lib/operation-context.mjs';
import { readNoteContext } from '../lib/note-review-actions.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const OP = 'GET /items', CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function fixture(t, { name = 'fixture', environments } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-review-'));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Fixture', version: '1' }, paths: {
    '/items': { get: { responses: { 200: { description: 'ok' } } } }, '/other': { get: { responses: { 200: { description: 'ok' } } } },
  } }));
  const scope = createFixtureStack(root, { name, contract: 'openapi.json', ...(environments ? { environments } : {}) });
  const file = fixtureContextFile(root, name); writeFileSync(file, JSON.stringify({ v: 0, api: {}, operations: {} }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_') && key !== HOME_ENV_NAME));
  Object.assign(env, { API_REPO_ROOT: root, API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', NO_COLOR: '1' });
  const cli = args => JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--stack', name, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 20000 }));
  const note = (text, args = []) => cli(['note', OP, text, ...args]);
  const raw = () => readFileSync(file, 'utf8');
  const handlers = workbenchHandlers(root);
  const call = (name, params = {}) => handlers[name].run(params);
  const id = note => ({ stack: name, operation: OP, note_id: note.note_id });
  return { root, scope, file, env, cli, note, raw, call, id };
}
function run(f, id, { status = 200, environment = 'local', provider = f.scope.config.baseUrl, kept = true } = {}) {
  const contractDigest = loadHttpContract(f.scope.config.contract).digest;
  const identity = { stack: f.scope.stack, protocol: 'http', operation: OP, environment, provider, contractDigest, endpoint: `${provider}/items` };
  const at = new Date().toISOString(), origin = requestEvidenceOrigin('cli.request', 'http', identity);
  const body = { item_id: 'PRIVATE_RUN_VALUE', access_token: 'review_secret_opaque_value' };
  const bytes = JSON.stringify({ runId: id, origin, request: { method: 'GET', body: { page_size: 2 } }, response: { status, body,
    headers: { 'cache-control': 'private', authorization: 'review_secret_opaque_value', 'x-note': '<script>unsafe()</script>' } } });
  const path = `${f.scope.evidenceDir}/${id}.json`;
  if (kept) writeFileSync(join(f.root, path), bytes);
  const ctx = JSON.parse(f.raw()); ctx.api_context ??= { v: 1, operations: {} };
  const entry = ctx.api_context.operations[operationId(identity)] ??= { identity, observations: [], omitted_observations: 0 };
  entry.observations.push({ id, recorded_at: at, observed_at: at, source: { kind: 'client', tool: 'api_request:http' }, basis: 'observed',
    verification: 'client-observation', outcome: status < 400 ? 'success' : 'error', complete: true, response_status: status,
    request_shape: contextShape({ page_size: 2 }).shape, response_shape: contextShape(body).shape,
    evidence: [{ path, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }], notes: [], omissions: [] });
  writeFileSync(f.file, JSON.stringify(ctx));
}
const review = (f, note, decision, extra = {}) => f.call('reviewDecision', { operation: OP, stack: f.scope.stack, notes: [note.note_id], decision, by: 'Fixture reviewer', actor: 'person', ...extra });

async function wire(service, path, body, token, extra = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(service.url, { method: 'POST', path, headers: { origin: service.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty', 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(token ? { 'x-workbench-token': token } : {}), ...extra } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(payload);
  });
}

test('review decisions share headless labels and stable no-write refusals', async t => {
  const f = fixture(t), note = f.note('Documented: returns a collection.');
  const before = f.raw(), params = { stack: 'fixture', operation: OP, notes: [note.note_id], by: 'Reviewer', actor: 'person', decision: 'trusted', limits: 'as documented' };
  const act = value => f.call('reviewDecision', JSON.parse(JSON.stringify(value)));
  for (const [value, code] of [
    [{ ...params, decision: 'disputed', limits: undefined }, 'NOTE_REVIEW_REASON_REQUIRED'],
    [{ ...params, notes: [`sha256:${'0'.repeat(64)}`] }, 'NOTE_DIGEST_CONFLICT'],
    [{ ...params, command: 'execute' }, 'NOTE_REVIEW_INVALID'],
    [{ ...params, limits: 'Authorization: Bearer sk-test-secret-value-123456789' }, 'SECRET_IN_REVIEW'],
  ]) {
    const result = await act(value); assert.equal(result.refused, code); assert.equal(f.raw(), before);
    if (code === 'NOTE_DIGEST_CONFLICT') { assert.ok(result.current_notes.includes(note.note_id)); assert.match(result.next, /Current note identities/); }
  }
  const saved = await act(params); assert.equal(saved.added, 1); assert.equal(saved.requests_executed, 0);
  assert.equal((await act(params)).unchanged, true);
  const detail = await f.call('reviewDetail', f.id(note));
  assert.equal(detail.record.review.state, 'trusted');
  assert.match(detail.record.review.label, /trusted by Reviewer.*no run.*as documented/);
  const shown = f.cli(['show', OP]);
  assert.deepEqual(detail.preview.records.map(row => row.review), shown.note_projection.records.map(row => row.review));
  const snapshot = await workbenchSnapshot(f.root); assert.equal(snapshot.settings.theme, 'claims');
  assert.equal((await f.call('reviewIndex')).reviewed, 1);
  const refused = await review(f, note, 'disputed', { reason: 'No longer valid.' }); assert.equal(refused.refused, 'NOTE_REVIEW_EVIDENCE_REQUIRED');
  await t.test('paired HTTP authority gates review writes', async t => {
    let service;
    try { service = await createWorkbenchServer({ assets: workbenchAssets(), handlers: workbenchHandlers(f.root) }); }
    catch (error) { if (error.code === 'EPERM') { t.skip('Loopback fixture bind refused by sandbox: EPERM'); return; } throw error; }
    t.after(() => service.close());
    const savedBytes = f.raw();
    assert.equal((await wire(service, '/action', { action: 'reviewDecision', params })).status, 401);
    assert.equal(f.raw(), savedBytes);
    const pending = (await wire(service, '/pair/start', {})).result; service.authorizePairing(pending.code);
    const token = (await wire(service, '/pair/complete', {}, null, { 'x-workbench-pairing': pending.nonce })).result.token;
    const result = (await wire(service, '/action', { action: 'reviewDecision', params }, token)).result;
    assert.equal(result.unchanged, true);
  });
});

test('run comparison distinguishes kept bytes, ledger summaries and IDs without promoting payloads', async t => {
  const f = fixture(t); run(f, 'run-here'); run(f, 'run-summary', { kept: false });
  const note = f.note('Returns HTTP 200 in local; request field page_size, response field item_id and header Cache-Control.',
    ['--evidence', 'run-here', '--evidence', 'run-summary', '--evidence', 'run-missing']);
  const before = f.raw(), detail = await f.call('reviewDetail', f.id(note));
  assert.equal(detail.refused, undefined, JSON.stringify(detail));
  assert.deepEqual(detail.comparisons.map(row => row.depth), ['full-run', 'ledger-summary', 'run-id-only']);
  assert.ok(detail.comparisons[0].rows.some(row => row.kind === 'field' && row.mark === 'present'));
  for (const comparison of detail.comparisons.slice(1)) assert.ok(comparison.rows.every(row => !['matches', 'present'].includes(row.mark)));
  assert.ok(detail.comparisons[2].rows.every(row => row.mark === 'not-checkable'));
  assert.ok(!JSON.stringify(detail).includes('PRIVATE_RUN_VALUE'));
  const json = await f.call('reviewNode', { ...f.id(note), node: 'run:run-here' });
  assert.ok(json.response.body_text.includes('PRIVATE_RUN_VALUE'), 'explicit private inspection is bounded existing local authority');
  assert.ok(!JSON.stringify(json).includes('review_secret_opaque_value'));
  const contract = await f.call('reviewNode', { ...f.id(note), node: 'contract' });
  assert.equal(contract.data.digest, loadHttpContract(f.scope.config.contract).digest, 'the contract node retains the same full identity as run scope');
  const missing = detail.nodes.find(row => row.id === 'run:run-missing'); assert.equal(missing.present, false); assert.match(missing.stop, /not on this machine/);
  assert.equal(f.raw(), before);
  await review(f, note, 'trusted', { limits: 'local only', evidence: ['run-here'] });
  assert.ok(!f.raw().includes('PRIVATE_RUN_VALUE'));
  // Replacing a run or pointing at a symlink cannot inherit its former match.
  rmSync(join(f.root, f.scope.evidenceDir, 'run-here.json'));
  symlinkSync(f.file, join(f.root, f.scope.evidenceDir, 'run-here.json'));
  const changed = await f.call('reviewDetail', f.id(note));
  assert.notEqual(changed.comparisons[0].depth, 'full-run');
  assert.ok(changed.comparisons[0].rows.every(row => !['matches', 'present'].includes(row.mark)));
  assert.equal((await f.call('reviewNode', { ...f.id(note), node: '../../outside' })).refused, 'NOTE_REVIEW_INVALID');
});

test('a both-trusted conflict names the runs its correction cites and a dispute with them retires the earlier trust', async t => {
  const f = fixture(t);
  const old = f.note('Documented: the route accepts a cursor.');
  await review(f, old, 'trusted');
  const newer = f.note('Documented: the route uses a page.', ['--supersedes', old.note_id, '--evidence', 'run-correction']);
  await review(f, newer, 'trusted');
  const detail = await f.call('reviewDetail', f.id(newer));
  assert.equal(detail.conflicts[0].predecessor, old.note_id);
  assert.deepEqual(detail.conflicts[0].correction_evidence, ['run-correction']);
  const before = f.raw();
  const bare = await review(f, old, 'disputed', { reason: `Retired by authored correction ${newer.note_id}` });
  assert.equal(bare.refused, 'NOTE_REVIEW_EVIDENCE_REQUIRED', 'the overturn rule is unchanged');
  assert.ok(bare.next.includes(`show '${OP}' --stack fixture --history`) && !bare.next.includes(f.root), bare.next);
  assert.equal(f.raw(), before);
  const disputed = await review(f, old, 'disputed', { reason: `Retired by authored correction ${newer.note_id}`, evidence: detail.conflicts[0].correction_evidence });
  assert.equal(disputed.refused, undefined, JSON.stringify(disputed));
  assert.deepEqual(disputed.reviews[0].evidence, ['run-correction']);
  assert.deepEqual((await f.call('reviewDetail', f.id(newer))).conflicts, []);
});

test('retirement and explicit correction actions preserve history and source batches expose holdbacks', async t => {
  const f = fixture(t), source = 'https://docs.example.test/items';
  const old = f.note('Documented: the route accepts a cursor.', ['--basis', 'documentation', '--source', source]);
  await review(f, old, 'trusted');
  const newer = f.note('Documented: the route uses a page.', ['--supersedes', old.note_id, '--basis', 'documentation', '--source', source, '--evidence', 'run-correction']);
  const suggestion = f.note('Correction: the earlier note about pages is incomplete.', ['--alongside', '--basis', 'documentation', '--source', source]);
  const before = f.raw();
  const group = await f.call('reviewGroups', { kind: 'source', ...f.id(newer) });
  assert.deepEqual(group.held_back.map(row => row.note_id), [old.note_id]);
  assert.equal(f.raw(), before);
  const batch = await f.call('reviewBatch', { identities: [...group.notes, ...group.held_back].map(row => f.id(row)), decision: 'trusted', by: 'Docs reviewer', actor: 'person', limits: 'as documented' });
  assert.equal(batch.receipts[0].held_back[0].note_id, old.note_id);
  let detail = await f.call('reviewDetail', f.id(newer));
  assert.equal(detail.conflicts[0].code, 'NOTE_BOTH_TRUSTED');
  assert.equal((await f.call('reviewDetail', f.id(suggestion))).record.correction_suggestion.state, 'unlinked');
  const priorCount = JSON.parse(f.raw()).operations[OP].note_replacements.length;
  const result = await f.call('reviewSupersede', { ...f.id(suggestion), supersedes: newer.note_id, by: 'Reviewer', actor: 'person', evidence: ['run-correction'] });
  assert.equal(result.refused, undefined, JSON.stringify(result));
  assert.equal(JSON.parse(f.raw()).operations[OP].note_replacements.length, priorCount + 1);
  assert.ok(JSON.parse(f.raw()).operations[OP].notes.includes('Documented: the route accepts a cursor.'));
  const retired = await f.call('reviewRetire', { stack: 'fixture', operation: OP, retires: result.note_id, reason: 'removed', text: 'The route was removed.', by: 'Reviewer', actor: 'person' });
  assert.equal(retired.refused, undefined, JSON.stringify(retired));
  detail = await f.call('reviewDetail', f.id(retired));
  assert.equal(detail.record.retirement[0].note_id, result.note_id);
  assert.equal(detail.record.retirement[0].reason, 'removed');
  const entry = JSON.parse(f.raw()).operations[OP];
  assert.equal(entry.note_retirements[0].replacement, retired.note_id);
  assert.ok(entry.note_review_integrity);
  assert.equal((await review(f, retired, 'trusted')).refused, undefined);
});

test('production prompts use stated environments and common causes without invented placeholders, and a run request hands its prompt to the inbox', async t => {
  const f = fixture(t, { environments: { local: { baseUrl: 'http://127.0.0.1:1' }, 'reporting-test': { baseUrl: 'https://api.example.test', production: false }, production: { baseUrl: 'https://api.example.test', production: true } } });
  run(f, 'run-scope', { environment: 'reporting-test', provider: 'https://api.example.test' });
  const note = f.note('Observed in reporting-test: returns HTTP 200.', ['--evidence', 'run-scope', '--by', 'Fixture summary editor']);
  const blank = f.note('Documentation: pagination is described.', ['--alongside', '--by', 'Reader', '--actor', 'person']);
  const before = f.raw(), index = await f.call('reviewIndex');
  assert.equal(index.causes.length, 1); assert.deepEqual(index.causes[0].stacks, ['fixture']);
  assert.match(index.causes[0].label, /reporting-test.*production host/);
  assert.equal(index.authors.find(row => row.category === 'imported').count, 1);
  const prompt = await f.call('reviewPrompt', f.id(note));
  assert.match(prompt.prompt, /GET \/items.*fixture/); assert.match(prompt.prompt, /out of scope/);
  assert.match(prompt.prompt, /Environment: reporting-test/); assert.match(prompt.prompt, /Resolved host: api.example.test/); assert.match(prompt.prompt, /STOP and ask/);
  assert.equal(prompt.environments[0].production, true, 'the production host requires a stop even when this alias is not marked production');
  const noEnv = await f.call('reviewPrompt', f.id(blank)); assert.doesNotMatch(noEnv.prompt, /Environment:|undefined|null|default environment/);
  assert.equal(f.raw(), before);
  const requested = await review(f, blank, 'run-requested', { reason: 'Check pagination in an authorized local run.' });
  assert.equal(requested.requests_executed, 0);
  assert.equal(requested.handoff.state, 'queued');
  const inbox = JSON.parse(readFileSync(join(f.root, LAYOUT.evidence, 'workbench', 'handoffs', `${requested.handoff.session_id}.json`), 'utf8'));
  assert.deepEqual(inbox.events.map(row => [row.kind, row.note_id, row.prompt]), [['run_request', blank.note_id, noEnv.prompt]]);
  const detail = await f.call('reviewDetail', f.id(blank));
  assert.equal(detail.record.review.state, 'run-requested');
  assert.match(detail.record.review.label, /· request: open ·/u);
  assert.ok(detail.nodes.some(node => node.kind === 'review' && node.fields.some(field => field.name === 'Request' && /^Open/u.test(field.value))));
});

test('empty and bounded review reads remain honest and preserve exact navigation identities', async t => {
  const f = fixture(t); assert.equal((await f.call('reviewIndex')).state, 'no-notes');
  rmSync(f.file); assert.equal((await f.call('reviewIndex')).state, 'no-ledger');
  writeFileSync(f.file, JSON.stringify({ v: 0, api: {}, operations: {} }));
  const one = f.note('Local source: first note.'); f.note('Local source: second note.', ['--alongside']);
  const before = f.raw(), first = await f.call('reviewIndex', { limit: 1 });
  assert.equal(first.total, 2); assert.equal(first.records.length, 1); assert.equal(first.next_offset, 1);
  const next = await f.call('reviewIndex', { limit: 1, offset: first.next_offset });
  assert.notEqual(next.records[0].note_id, first.records[0].note_id); assert.equal(next.next_offset, null);
  assert.equal((await f.call('reviewIndex', { state: 'trusted' })).filtered_total, 0);
  assert.equal(f.raw(), before);
  const retired = await f.call('reviewRetire', { stack: 'fixture', operation: OP, retires: one.note_id, reason: 'other', text: 'Retired during another session.', by: 'Reviewer', actor: 'person' });
  const after = f.raw(), stale = await review(f, one, 'trusted');
  assert.equal(stale.refused, 'NOTE_REVIEW_REPLACED'); assert.equal(stale.replacement, retired.note_id); assert.equal(f.raw(), after);
});

test('Review preserves a failed agent-context read when a legacy note remains readable', async t => {
  const f = fixture(t);
  writeFileSync(f.file, JSON.stringify({ v: 0, api: {}, operations: { [OP]: { notes: ['Documented: a synthetic legacy claim.'] } },
    api_context: { v: 1, operations: { damaged: null } } }));
  const before = f.raw(), index = await f.call('reviewIndex');
  assert.equal(index.records.length, 1);
  const shared = readNoteContext(f.root, { stack: 'fixture', operation: OP, max_bytes: 32000 });
  assert.equal(shared.note_context, undefined);
  assert.deepEqual(shared.issues, [{ repository: 'local', code: 'CONTEXT_INVALID' }]);
  const detail = await f.call('reviewDetail', f.id(index.records[0]));
  assert.equal(detail.record.text, 'Documented: a synthetic legacy claim.');
  assert.equal(detail.preview, null, 'an unreadable agent context must not become an empty successful projection');
  assert.deepEqual(detail.preview_issues, shared.issues);
  assert.deepEqual(detail.preview_omissions, shared.omissions);
  assert.equal(f.raw(), before, 'reading the preview preserves the damaged fixture unchanged');
});

const pause = ms => new Promise(done => setTimeout(done, ms));

test('a claim contradicted since its trust shows each later run as a compared run and a trace node', async t => {
  const f = fixture(t), note = f.note('Returns HTTP 201.');
  await review(f, note, 'trusted', { limits: 'local only' });
  await pause(5);
  run(f, 'run-later'); run(f, 'run-later-summary', { kept: false });
  const before = f.raw(), detail = await f.call('reviewDetail', f.id(note));
  assert.equal(detail.record.review.state, 'contradicted-since-trusted');
  const later = detail.comparisons.filter(row => row.role === 'later-run');
  assert.deepEqual(later.map(row => [row.run_id, row.depth]).sort(), [['run-later', 'full-run'], ['run-later-summary', 'ledger-summary']]);
  const kept = later.find(row => row.run_id === 'run-later'), status = kept.rows.find(row => row.kind === 'status');
  assert.deepEqual([status.claim, status.recorded, status.mark], ['Status mentioned: 201', '200', 'differs']);
  assert.ok(later.find(row => row.run_id === 'run-later-summary').rows.every(row => row.mark !== 'differs' && row.mark !== 'matches'));
  assert.match(detail.evidence_explanation, /run-later/);
  assert.doesNotMatch(detail.evidence_explanation, /No run is attached/);
  const ids = detail.nodes.map(row => row.id), node = detail.nodes.find(row => row.id === 'later-run:run-later');
  assert.deepEqual([node.kind, node.label, node.run_id, node.present, node.referenced], ['later-run', 'run-later', 'run-later', true, false]);
  assert.ok(ids.indexOf('later-run:run-later') > ids.indexOf('evidence') && ids.indexOf('later-run:run-later') < ids.indexOf('contract'));
  assert.equal(detail.nodes.find(row => row.id === 'later-run:run-later-summary').present, false);
  assert.ok(!JSON.stringify(detail).includes('PRIVATE_RUN_VALUE'));
  const json = await f.call('reviewNode', { ...f.id(note), node: 'later-run:run-later' });
  assert.equal(json.data.run_id, 'run-later');
  assert.ok(json.response.body_text.includes('PRIVATE_RUN_VALUE'), 'the later run opens like an attached run');
  assert.equal(f.raw(), before, 'reading the contradiction writes nothing');
  const plain = f.note('Returns HTTP 200 for a listing.', ['--alongside']);
  assert.deepEqual((await f.call('reviewDetail', f.id(plain))).comparisons, [], 'an untrusted claim gains no later-run comparison');
});

test('correction conflicts appear only on the predecessor and its correction', async t => {
  const f = fixture(t);
  const old = f.note('Documented: the route accepts a cursor.');
  await review(f, old, 'trusted');
  const newer = f.note('Documented: the route uses a page.', ['--supersedes', old.note_id, '--evidence', 'run-correction']);
  await review(f, newer, 'trusted');
  const unrelated = f.note('Documented: the route sorts by id.', ['--alongside']);
  await review(f, unrelated, 'trusted');
  const pair = conflict => [conflict.predecessor, conflict.correction];
  assert.deepEqual((await f.call('reviewDetail', f.id(newer))).conflicts.map(pair), [[old.note_id, newer.note_id]]);
  assert.deepEqual((await f.call('reviewDetail', f.id(old))).conflicts.map(pair), [[old.note_id, newer.note_id]]);
  assert.deepEqual((await f.call('reviewDetail', f.id(unrelated))).conflicts, []);
});

test('a name found in a run is marked present while status and environment equality stay literal matches', async t => {
  const f = fixture(t); run(f, 'run-here');
  const note = f.note('Returns HTTP 200 in local with item_id and header Cache-Control.', ['--evidence', 'run-here']);
  const [comparison] = (await f.call('reviewDetail', f.id(note))).comparisons;
  assert.equal(comparison.role, 'attached');
  const marks = Object.fromEntries(comparison.rows.map(row => [`${row.kind}:${row.claim}`, row.mark]));
  assert.equal(marks['status:Status mentioned: 200'], 'matches');
  assert.equal(marks['environment:local'], 'matches');
  assert.equal(marks['field:Field mentioned: item_id'], 'present');
  assert.equal(marks['header:cache-control'], 'present');
  assert.ok(comparison.rows.filter(row => ['field', 'header'].includes(row.kind)).every(row => row.mark !== 'matches'));
  const other = f.note('Returns HTTP 404 in local.', ['--alongside', '--evidence', 'run-here']);
  const status = (await f.call('reviewDetail', f.id(other))).comparisons[0].rows.find(row => row.kind === 'status');
  assert.equal(status.mark, 'differs');
});

test('review facet counts follow the other active filters and causes follow the stack', async t => {
  const f = fixture(t, { environments: { local: { baseUrl: 'http://127.0.0.1:1' }, 'reporting-test': { baseUrl: 'https://api.example.test' }, production: { baseUrl: 'https://api.example.test', production: true } } });
  createFixtureStack(f.root, { name: 'other', contract: 'openapi.json' });
  writeFileSync(fixtureContextFile(f.root, 'other'), JSON.stringify({ v: 0, api: {}, operations: {} }));
  run(f, 'run-scope', { environment: 'reporting-test', provider: 'https://api.example.test' });
  f.note('Observed in reporting-test: returns HTTP 200.', ['--evidence', 'run-scope', '--by', 'Fixture summary editor']);
  const documented = f.note('Documented: pagination is described.', ['--alongside', '--by', 'Reader', '--actor', 'person']);
  f.note('Documented: sorting is described.', ['--alongside', '--by', 'Helper agent', '--actor', 'agent']);
  await review(f, documented, 'trusted', { limits: 'as documented' });
  execFileSync(process.execPath, [CLI, 'note', OP, 'Documented: another stack.', '--by', 'Reader', '--actor', 'person', '--stack', 'other', '--json'],
    { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000 });
  const before = f.raw(), count = (rows, key, value) => rows.find(row => row[key] === value).count;
  const trusted = await f.call('reviewIndex', { stack: 'fixture', state: 'trusted' });
  assert.equal(trusted.filtered_total, 1);
  assert.deepEqual(trusted.filter_authors.map(row => [row.category, row.count]), [['person', 1], ['agent', 0], ['imported', 0], ['unknown', 0]]);
  assert.equal(count(trusted.lanes, 'id', 'documentation'), 1); assert.equal(count(trusted.lanes, 'id', 'out-of-scope-run'), 0);
  assert.equal(count(trusted.states, 'state', 'unreviewed'), 2, 'state counts ignore only the state filter');
  const agents = await f.call('reviewIndex', { stack: 'fixture', author: 'agent' });
  assert.equal(count(agents.states, 'state', 'trusted'), 0); assert.equal(count(agents.states, 'state', 'unreviewed'), 1);
  assert.equal(count(agents.filter_authors, 'category', 'imported'), 1, 'author counts ignore only the author filter');
  assert.equal(count(agents.lanes, 'id', 'out-of-scope-run'), 0);
  // Every facet's count equals the result size its selection produces.
  for (const params of [{}, { stack: 'fixture' }, { stack: 'fixture', state: 'unreviewed' }, { stack: 'fixture', lane: 'documentation' }, { stack: 'other', author: 'person' }]) {
    const index = await f.call('reviewIndex', params);
    assert.equal(index.total, 4); assert.equal(index.trusted, 1); assert.equal(index.reviewed, 1);
    assert.equal(index.authors.find(row => row.category === 'person').count, 2, 'header author totals stay unfiltered');
    for (const row of index.states) assert.equal((await f.call('reviewIndex', { ...params, state: row.state })).filtered_total, row.count, `${JSON.stringify(params)} state ${row.state}`);
    for (const row of index.filter_authors) assert.equal((await f.call('reviewIndex', { ...params, author: row.category })).filtered_total, row.count, `${JSON.stringify(params)} author ${row.category}`);
    for (const row of index.lanes) assert.equal((await f.call('reviewIndex', { ...params, lane: row.id })).filtered_total, row.count, `${JSON.stringify(params)} lane ${row.id}`);
  }
  assert.equal((await f.call('reviewIndex')).causes.length, 1);
  assert.deepEqual((await f.call('reviewIndex', { stack: 'fixture' })).causes.map(row => row.environment), ['reporting-test']);
  const other = await f.call('reviewIndex', { stack: 'other' });
  assert.deepEqual(other.causes, []); assert.equal(other.causes_omitted, 0);
  assert.equal(f.raw(), before);
});

test('stack counts follow the other active filters, so choosing a stack chip yields its count', async t => {
  const f = fixture(t);
  createFixtureStack(f.root, { name: 'other', contract: 'openapi.json' });
  writeFileSync(fixtureContextFile(f.root, 'other'), JSON.stringify({ v: 0, api: {}, operations: {} }));
  const documented = f.note('Documented: pagination is described.', ['--by', 'Reader', '--actor', 'person']);
  f.note('Documented: sorting is described.', ['--alongside', '--by', 'Helper agent', '--actor', 'agent']);
  await review(f, documented, 'trusted', { limits: 'as documented' });
  execFileSync(process.execPath, [CLI, 'note', OP, 'Documented: another stack.', '--by', 'Reader', '--actor', 'person', '--stack', 'other', '--json'],
    { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 20000 });
  const before = f.raw(), count = (index, name) => index.stacks.find(row => row.name === name).count;
  const trusted = await f.call('reviewIndex', { state: 'trusted' });
  assert.deepEqual([count(trusted, 'fixture'), count(trusted, 'other'), trusted.stacks_total], [1, 0, 1], 'no trusted note lives in the other stack');
  assert.equal(trusted.total, 3, 'header totals stay unfiltered');
  const agents = await f.call('reviewIndex', { author: 'agent', stack: 'other' });
  assert.deepEqual([count(agents, 'fixture'), count(agents, 'other'), agents.stacks_total], [1, 0, 1], 'stack counts ignore only the stack filter');
  for (const params of [{}, { state: 'trusted' }, { state: 'unreviewed' }, { author: 'person' }, { author: 'agent', state: 'unreviewed' }, { lane: 'documentation', stack: 'other' }]) {
    const index = await f.call('reviewIndex', params), { stack, ...rest } = params;
    assert.equal(index.total, 3);
    assert.equal(index.stacks_total, (await f.call('reviewIndex', rest)).filtered_total, `${JSON.stringify(params)} all stacks`);
    for (const row of index.stacks) assert.equal((await f.call('reviewIndex', { ...rest, stack: row.name })).filtered_total, row.count, `${JSON.stringify(params)} stack ${row.name}`);
  }
  assert.equal(f.raw(), before);
});

test('historical notes are marked historical and a retirement record names what it retires', async t => {
  const f = fixture(t);
  const old = f.note('Documented: the route accepts a cursor.');
  const newer = f.note('Documented: the route uses a page.', ['--supersedes', old.note_id]);
  const gone = f.note('Documented: the route accepts a size.', ['--alongside']);
  const retired = await f.call('reviewRetire', { stack: 'fixture', operation: OP, retires: gone.note_id, reason: 'removed', text: 'No longer accepted; size was removed.', by: 'Reviewer', actor: 'person' });
  assert.equal(retired.refused, undefined, JSON.stringify(retired));
  const historical = await f.call('reviewDetail', f.id(old));
  assert.equal(historical.historical, true); assert.ok(historical.record.superseded);
  assert.equal((await f.call('reviewDetail', f.id(gone))).historical, true);
  const active = await f.call('reviewDetail', f.id(newer));
  assert.equal(active.historical, false); assert.equal(active.record.retirement_of, undefined);
  const record = (await f.call('reviewDetail', { stack: 'fixture', operation: OP, note_id: retired.note_id }));
  assert.equal(record.historical, false);
  assert.deepEqual(record.record.retirement_of, { note_id: gone.note_id, reason: 'removed' });
});

test('retirement records in the Review list carry the retired claim and reason', async t => {
  const f = fixture(t), claim = `Documented: the route accepts a size parameter ${'and more words '.repeat(12)}end.`;
  const gone = f.note(claim), kept = f.note('Documented: the route uses a page.', ['--alongside']);
  const retired = await f.call('reviewRetire', { stack: 'fixture', operation: OP, retires: gone.note_id, reason: 'removed', text: 'No longer accepted; size was removed.', by: 'Reviewer', actor: 'person' });
  const before = f.raw(), index = await f.call('reviewIndex');
  const row = index.records.find(item => item.note_id === retired.note_id);
  assert.equal(row.retirement.note_id, gone.note_id); assert.equal(row.retirement.reason, 'removed');
  assert.ok(claim.length > 120 && row.retirement.claim.length <= 121 && claim.startsWith(row.retirement.claim.replace(/…$/u, '')));
  assert.equal(index.records.find(item => item.note_id === kept.note_id).retirement, undefined);
  assert.equal(f.raw(), before);
});
