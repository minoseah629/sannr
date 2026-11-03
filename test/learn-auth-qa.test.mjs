// Independent synthetic QA for authenticated learn. Local fixture traffic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { writeFileSync } from './helpers/layout-fixture.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';
import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
import { activeNotes, freshnessFor, isValidSupersessionMarker, learnFromResponse, loadContextSnapshot, acceptNoteHistory, inspectNoteHistory } from '../lib/context.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))), CLI = join(ROOT, 'bin/cli.mjs');
const TOKEN = 'synthetic-local-fixture-credential';
const run = (root, args, env = {}) => new Promise(resolve => execFile(process.execPath, [CLI, ...args], {
  cwd: root, encoding: 'utf8', timeout: 15000,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_'))), API_REPO_ROOT: root,
    API_CONTEXT_DIR: root, API_ENV: 'fixture',
    API_USAGE_LOG: join(root, 'private-usage.jsonl'), API_EVIDENCE: join(root, fixtureEvidencePath()),
    API_LEARN_QA_TOKEN: TOKEN, API_BUDGET: '180', API_FRICTION_OFF: '1', ...env },
}, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
const acknowledgeNotes = root => inFixtureStack(root, () => {
  const snapshot = loadContextSnapshot(root), operation = 'GET /items';
  acceptNoteHistory(root, snapshot, { operation, expectedDigest: inspectNoteHistory(snapshot.ctx.operations[operation]).digest,
    stamp: { by: 'qa-fixture-review', at: '2026-09-30' } });
});
const readContext = root => JSON.parse(readFileSync(fixtureContextFile(root), 'utf8'));
const evidence = root => existsSync(join(root, fixtureEvidencePath()))
  ? readdirSync(join(root, fixtureEvidencePath())).filter(name => /^run-.*\.json$/.test(name)).map(name => JSON.parse(readFileSync(join(root, fixtureEvidencePath(), name), 'utf8'))) : [];
async function fixture(t, { mode = 'ok', auth = true } = {}) {
  const state = { mode, seen: [] };
  const server = createServer((req, res) => {
    state.seen.push({ method: req.method, path: req.url, headers: req.headers });
    if (state.mode === 'redirect' && req.url === '/items') {
      res.writeHead(302, { location: '/login' }); res.end(); return;
    }
    const status = typeof state.mode === 'number' ? state.mode : req.url === '/login' ? 200
      : auth && (req.headers.authorization !== `Bearer ${TOKEN}` || req.headers['x-fixture-tenant'] !== 'blue') ? 401 : 200;
    const body = status >= 400 ? { auth_error: 'synthetic refusal', detail: 'must-not-be-promoted' }
      : req.url === '/login' ? { login_html: 'not-the-requested-operation' }
      : { data: Array.from({ length: 50 }, (_, i) => ({ tier: i === 49 ? 'pro' : 'basic', label: `private-fixture-label-${i}` })) };
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const root = mkdtempSync(join(tmpdir(), 'learn-auth-qa-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'local fixture', version: '1' }, paths: {
    '/items': { get: { responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: {
      data: { type: 'array', items: { type: 'object', properties: { tier: { type: 'string', enum: ['basic', 'pro'] }, label: { type: 'string' } } } },
    } } } } } } } },
  } }));
  createFixtureStack(root, { environment: 'fixture', baseUrl: origin, contract: 'openapi.json',
    environmentConfig: { ...(auth ? { auth: 'bearer:API_LEARN_QA_TOKEN' } : {}), headers: { 'X-Fixture-Tenant': 'blue' } } });
  const initialized = await run(root, ['init']); assert.equal(initialized.code, 0, initialized.stderr);
  return { root, origin, state };
}

test('QA learn uses the configured authentication and headers, keeps raw promotion beyond envelope budget, and records assertion evidence', async t => {
  const f = await fixture(t), result = await run(f.root, ['learn']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state.seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(f.state.seen[0].headers['x-fixture-tenant'], 'blue');
  const entry = readContext(f.root).operations['GET /items'];
  assert.ok(entry.verified_at);
  assert.deepEqual(entry.fields.tier.values.sort(), ['basic', 'pro'], 'last row must survive presentation budgeting');
  const records = evidence(f.root); assert.ok(records.length > 0);
  assert.equal(records.at(-1).response.status, 200);
  assert.equal(entry.last_learn.assertions.failed, 0);
  assert.ok(entry.last_learn.evidence);
  const committed = readFileSync(fixtureContextFile(f.root), 'utf8');
  assert.ok(!committed.includes('private-fixture-label-'));
  assert.ok(!committed.includes(TOKEN));
  assert.ok(!JSON.stringify(records).includes(TOKEN), 'evidence must scrub configured credentials');
});

for (const status of [401, 403]) test(`QA HTTP ${status} never verifies or overwrites a successful shape with auth-error fields`, async t => {
  const f = await fixture(t, { mode: status, auth: false });
  const seeded = readContext(f.root), old = seeded.operations['GET /items'];
  Object.assign(old, { verified_at: '2026-09-01T00:00:00Z', verified_by: 'prior-agent', status_codes: [200],
    fields: { retained: { distinct: 1 } }, shape_hash: 'sha256:prior', shape_diverged_at: '2026-09-02',
    notes: ['A manual constraint'], notes_provenance: [null], notes_superseded: [null] });
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(seeded));
  acknowledgeNotes(f.root);
  const learned = await run(f.root, ['learn']);
  assert.equal(learned.code, 0, learned.stderr);
  const entry = readContext(f.root).operations['GET /items'];
  assert.equal(entry.verified_at, null);
  assert.equal(entry.verified_by, undefined);
  assert.deepEqual(entry.fields, old.fields);
  assert.equal(entry.shape_hash, old.shape_hash);
  assert.equal(entry.shape_diverged_at, old.shape_diverged_at);
  assert.ok(entry.notes.includes('A manual constraint'));
  assert.equal(entry.last_learn.status, status);
  assert.ok(entry.last_learn.evidence);
  assert.equal(evidence(f.root).at(-1).response.status, status);
  assert.equal(freshnessFor(entry, f.root, null).confidence, 'unverified');
});

test('QA CI HTTP 401 exits unsuccessfully while retaining unverified metadata and private assertion evidence', async t => {
  const f = await fixture(t, { mode: 401 });
  const result = await run(f.root, ['learn', '--ci']);
  assert.equal(result.code, 1, result.stderr);
  const out = JSON.parse(result.stdout), entry = readContext(f.root).operations['GET /items'];
  assert.equal(out.authentication_failed, 1);
  assert.equal(out.unverified, 1);
  assert.equal(entry.verified_at, null);
  assert.equal(entry.last_learn.status, 401);
  assert.equal(entry.last_learn.outcome, 'authentication_failed');
  assert.ok(entry.last_learn.evidence);
  assert.equal(entry.last_learn.assertions.failed, 1);
  assert.equal(evidence(f.root).at(-1).response.status, 401);
  assert.ok(!JSON.stringify(entry.fields).includes('auth_error'));
});

test('QA successful recovery supersedes only generated auth-failure notes and refreshes the managed pointer count', async t => {
  const f = await fixture(t, { mode: 401 }), ctx = readContext(f.root);
  const authored = 'The tenant header identifies the account that owns these items.';
  Object.assign(ctx.operations['GET /items'], { notes: [authored], notes_provenance: [null], notes_superseded: [null] });
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(ctx));
  acknowledgeNotes(f.root);
  writeFileSync(join(f.root, 'AGENTS.md'), 'Keep this authored instruction.\n');

  const failure = await run(f.root, ['learn', '--agents']);
  assert.equal(failure.code, 0, failure.stderr);
  const failed = readContext(f.root).operations['GET /items'];
  const failureIndex = failed.notes.findIndex((_, index) => failed.notes_provenance[index]?.kind === 'learn_verification_failure');
  assert.ok(failureIndex >= 0);
  assert.equal(isValidSupersessionMarker(failed.notes_superseded[failureIndex]), false);
  assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /1 operation; 1 written, 0 observed, 0 asserted, 0 verified/);

  f.state.mode = 'ok';
  const success = await run(f.root, ['learn']);
  assert.equal(success.code, 0, success.stderr);
  const recovered = readContext(f.root).operations['GET /items'];
  assert.ok(recovered.verified_at);
  assert.equal(recovered.last_learn.status, 200);
  assert.equal(recovered.notes[failureIndex], failed.notes[failureIndex], 'keep the historical failure text');
  assert.equal(recovered.notes_superseded[failureIndex].reason, 'successful_verification');
  assert.equal(isValidSupersessionMarker(recovered.notes_superseded[failureIndex]), true);
  assert.equal(recovered.notes_superseded[recovered.notes.indexOf(authored)], null);
  assert.deepEqual(activeNotes(recovered), [authored]);
  const pointer = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.match(pointer, /1 operation; 0 written, 0 observed, 0 asserted, 1 verified/);
  assert.ok(pointer.includes('Keep this authored instruction.'));
  assert.ok(pointer.includes(authored));
  assert.ok(!pointer.includes('Authentication failed'));
  assert.deepEqual(evidence(f.root).map(record => record.response.status).sort(), [200, 401]);
});

test('QA legacy auth-only verification is unverified on read without mutating the saved specimen', async t => {
  const f = await fixture(t, { auth: false }), ctx = readContext(f.root);
  for (const status_codes of [[401], [403], [401, 403]]) {
    const entry = { verified_at: '2026-09-01', status_codes, fields: { error: { distinct: 1 } } };
    assert.equal(freshnessFor(entry, f.root, null).confidence, 'unverified');
  }
  ctx.operations['GET /items'] = { ...ctx.operations['GET /items'], verified_at: '2026-09-01', status_codes: [401] };
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(ctx));
  const before = readFileSync(fixtureContextFile(f.root));
  const shown = await run(f.root, ['show', 'GET /items']);
  assert.equal(JSON.parse(shown.stdout).confidence, 'unverified');
  assert.deepEqual(readFileSync(fixtureContextFile(f.root)), before);
  assert.equal(f.state.seen.length, 0);
});

test('QA learn dry-run preserves knowledge and pointer bytes while retaining private client evidence', async t => {
  const f = await fixture(t), before = readFileSync(fixtureContextFile(f.root));
  writeFileSync(join(f.root, 'AGENTS.md'), 'Manual instructions remain.\n');
  const result = await run(f.root, ['learn', '--dry-run', '--json']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readFileSync(fixtureContextFile(f.root)), before);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'Manual instructions remain.\n');
  assert.ok(evidence(f.root).length > 0);
  const out = JSON.parse(result.stdout); assert.equal(out.wrote, null);
  assert.deepEqual(out.operations[0].would_promote.fields.tier.values.sort(), ['basic', 'pro']);
});

test('QA redirect to a successful login does not verify the original operation', async t => {
  const f = await fixture(t, { mode: 'redirect', auth: false });
  await run(f.root, ['learn']);
  const entry = readContext(f.root).operations['GET /items'];
  assert.equal(entry.verified_at, null);
  assert.equal(entry.fields.login_html, undefined);
  assert.equal(entry.last_learn.status, 302);
  assert.ok(entry.last_learn.evidence);
});

test('QA forged read effect cannot authorize a POST during learn', async t => {
  const f = await fixture(t, { auth: false }), ctx = readContext(f.root);
  ctx.operations = { 'POST /items': { ...ctx.operations['GET /items'], effect: 'read', verified_at: null, fields: {} } };
  writeFileSync(fixtureContextFile(f.root), JSON.stringify(ctx));
  const result = await run(f.root, ['learn']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.state.seen.length, 0);
  assert.equal(readContext(f.root).operations['POST /items'].verified_at, null);
});

test('QA learnFromResponse itself cannot construct verified auth failures', () => {
  for (const status of [401, 403, 500]) {
    let result;
    try { result = learnFromResponse({ op: 'GET /items', method: 'GET', path: '/items', body: { error: 'failure' }, status }); }
    catch { continue; }
    assert.equal(result.verified_at, null);
  }
});
