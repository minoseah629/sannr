// The Workbench read models as the page receives them: the real engine
// handlers over the synthetic lab (no network, no real home directory). One
// test per behavior the DESIGN-1 round-1 fix contract asks of the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWorkbenchLab } from './fixtures/workbench-lab.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { generateSurvey } from '../lib/survey.mjs';
import { workbenchHandlers } from '../lib/workbench-engine.mjs';
import { WORKBENCH_LIMITS } from '../lib/workbench-server.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function lab(t, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-model-')), home = join(parent, 'home');
  mkdirSync(home);
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state');
  t.after(() => { for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, '.state') };
  const built = buildWorkbenchLab(join(parent, 'repo'), { env, generateSurvey, ...options });
  const note = (stack, operation, text) => JSON.parse(execFileSync(process.execPath, [CLI, 'note', operation, text, '--stack', stack, '--json', '--by', 'Lab agent', '--actor', 'agent', '--alongside'],
    { cwd: built.root, env: { ...env, API_REPO_ROOT: built.root, API_CONTEXT_DIR: built.root, API_FRICTION_OFF: '1', NO_COLOR: '1' }, encoding: 'utf8', timeout: 20000 }));
  return { ...built, handlers: workbenchHandlers(built.root), note };
}
const identity = note => ({ stack: note.stack, operation: note.operation, note_id: note.note_id });
const find = (index, operation, text) => index.notes.find(note => note.operation === operation && (!text || note.text.includes(text)));
const editJson = (file, fn) => { const value = JSON.parse(readFileSync(file, 'utf8')); fn(value); writeFileSync(file, JSON.stringify(value)); };

test('a run recorded against the current contract matches a ledger that stores the short contract digest', async t => {
  const { handlers } = lab(t, { shortDigest: true, survey: false });
  const index = await handlers.workbench.run({});
  const ok = await handlers.note.run(identity(find(index, 'GET /health')));
  assert.match(ok.ledger_digest, /^sha256:[0-9a-f]{16}$/u, 'the ledger keeps the short form');
  assert.equal(ok.evidence[0].contract_matches, true);
  const older = await handlers.note.run(identity(find(index, 'GET /orders/{orderId}/quote', 'staging')));
  assert.equal(older.evidence[0].contract_matches, false, 'a run against another contract still reads as older');
});

test('a note names every environment its text or its runs concern, marked production as the verify prompt decides', async t => {
  const { root, handlers, note } = lab(t, { survey: false });
  editJson(join(root, LAYOUT.collection, 'parcel', 'stack.json'), stack => { stack.environments.staging.production = true; });
  note('parcel', 'GET /health', 'Staging health has not been checked yet.');
  const index = await handlers.workbench.run({});
  const runless = await handlers.note.run(identity(find(index, 'GET /health', 'Staging health')));
  assert.equal(runless.evidence.length, 0);
  assert.deepEqual(runless.environments, [{ name: 'staging', production: true }]);
  const mismatch = await handlers.note.run(identity(find(index, 'GET /orders/{orderId}/quote', 'staging')));
  assert.deepEqual(mismatch.environments, [{ name: 'staging', production: true }], 'named and run environments are de-duplicated');
  const local = await handlers.note.run(identity(find(index, 'GET /health', 'health returns 200')));
  assert.deepEqual(local.environments, [{ name: 'local', production: false }]);
});

test('the Map draws an operation with a recorded request by its latest run file when nothing is shared', async t => {
  const { handlers } = lab(t);
  const map = await handlers.surveyMap.run({});
  const status = Object.fromEntries(map.operations.map(op => [op.key, op.status]));
  assert.equal(status['GET /orders/{orderId}/quote'], 'error', 'its only run file answered 422');
  assert.equal(status['GET /health'], 'ok', 'the shared observation decides');
  assert.equal(status['GET /v1/entries'], 'unobserved', 'no request at all');
});

test('the Map reads an operation whose only run is a ledger link, with no run file or observation, as requested with no result recorded', async t => {
  const { root, handlers } = lab(t);
  rmSync(join(root, LAYOUT.evidence, 'parcel', 'run-lab-quote-scope.json'));
  const status = Object.fromEntries((await handlers.surveyMap.run({})).operations.map(op => [op.key, op.status]));
  assert.equal(status['GET /orders/{orderId}/quote'], 'unrecorded');
  assert.equal(status['GET /v1/entries'], 'unobserved', 'no run at all is still never requested');
});

test('a large Map still opens, trimming run lists and then operations, and says how many it left out', async t => {
  const { root } = lab(t, { survey: false });
  // Many long operations referenced from code, and many runs on one of them.
  const long = index => `/catalog/${'segment'.repeat(60)}/${index}`;
  const paths = Array.from({ length: 380 }, (_, index) => long(index));
  editJson(join(root, LAYOUT.collection, 'parcel', 'openapi.json'), contract => {
    for (const path of paths) contract.paths[path] = { get: { responses: { 200: { description: 'ok' } } } };
  });
  writeFileSync(join(root, 'parcel-service', 'openapi.json'), readFileSync(join(root, LAYOUT.collection, 'parcel', 'openapi.json')));
  for (let i = 0; i < paths.length; i += 40) writeFileSync(join(root, 'parcel-service', `catalog-${i}.mjs`),
    paths.slice(i, i + 40).map(path => `app.get(${JSON.stringify(path)}, item);`).join('\n'));
  for (let i = 0; i < 60; i++) writeFileSync(join(root, LAYOUT.evidence, 'parcel', `run-lab-many-${String(i).padStart(2, '0')}.json`),
    JSON.stringify({ runId: `run-lab-many-${String(i).padStart(2, '0')}`, origin: { observed_at: `2026-10-29T11:${String(i).padStart(2, '0')}:00.000Z`,
      scope: { operation: 'GET /health' } }, response: { status: 200 } }));
  generateSurvey(root, { now: '2026-10-29T12:00:00.000Z' });
  const map = await workbenchHandlers(root).surveyMap.run({});
  assert.ok(Buffer.byteLength(JSON.stringify(map)) <= WORKBENCH_LIMITS.responseBytes, 'the Map opens instead of hitting the response limit');
  assert.ok(map.operations_omitted > 0, 'operations past the budget are counted');
  const shown = map.stacks.filter(stack => !stack.vendor).reduce((sum, stack) => sum + stack.total, 0);
  assert.equal(map.operations.length + map.operations_omitted, shown);
  for (const op of map.operations) assert.ok(op.runs.length <= op.runs_total);
  const keys = new Set(map.operations.map(op => op.key));
  for (const file of map.files) for (const key of file.operations) assert.ok(keys.has(key), 'files list only operations drawn');
  const health = map.operations.find(op => op.key === 'GET /health');
  assert.ok(health.runs_total >= 61 && health.runs.length < health.runs_total, 'a trimmed run list keeps its total');
});

test('a single-store repository opens every trace and saves responses, and identities must be strings', async t => {
  const { handlers } = lab(t, { singleStore: true, survey: false });
  const index = await handlers.workbench.run({});
  assert.ok(index.notes.length >= 3);
  for (const note of index.notes) {
    assert.equal(note.stack, '');
    const detail = await handlers.note.run(identity(note));
    assert.equal(detail.note_id, note.note_id);
  }
  await handlers.respond.run({ ...identity(index.notes[0]), text: 'Checked in the single store.' });
  assert.deepEqual(Object.keys((await handlers.workbench.run({})).responses), [JSON.stringify(['', index.notes[0].operation, index.notes[0].note_id])]);
  const first = identity(index.notes[0]);
  for (const bad of [{ ...first, stack: null }, { ...first, note_id: [first.note_id] }, { ...first, operation: [first.operation] }, { operation: first.operation, note_id: first.note_id }])
    await assert.rejects(handlers.note.run(bad), { code: 'WORKBENCH_NOTE_INVALID' });
});

test('responses: a save returns only its note, the index carries listed notes within its budget, and nothing stored is deleted', async t => {
  const { root, handlers } = lab(t, { survey: false });
  const index = await handlers.workbench.run({});
  const [a, b] = index.notes;
  await handlers.respond.run({ ...identity(a), text: 'First response on A.' });
  const saved = await handlers.respond.run({ ...identity(b), text: 'Response on B.' });
  assert.equal(saved.key, JSON.stringify([b.stack, b.operation, b.note_id]));
  assert.deepEqual(saved.responses.map(row => row.text), ['Response on B.']);
  assert.equal(saved.ledger_written, false);
  // Stored responses for a note that is no longer active, and many long ones.
  const file = join(root, LAYOUT.evidence, 'workbench', 'responses.json'), at = i => `2026-10-29T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, '0')}:00.000Z`;
  editJson(file, store => {
    store.notes.push({ stack: 'parcel', operation: 'GET /health', note_id: `sha256:${'a'.repeat(64)}`, responses: [{ text: 'Retired note.', at: at(1) }] });
    store.notes.find(row => row.note_id === a.note_id).responses.push(...Array.from({ length: 30 }, (_, i) => ({ text: `${i} ${'x'.repeat(3990)}`, at: at(i + 10) })));
    store.notes.find(row => row.note_id === b.note_id).responses.push(...Array.from({ length: 30 }, (_, i) => ({ text: `${i} ${'y'.repeat(3990)}`, at: at(i + 5) })));
  });
  const before = JSON.parse(readFileSync(file, 'utf8')).notes.reduce((sum, row) => sum + row.responses.length, 0);
  const bounded = await handlers.workbench.run({});
  const listed = Object.values(bounded.responses).reduce((sum, list) => sum + list.length, 0);
  assert.equal(listed + bounded.responses_omitted, before, 'every stored response is either listed or counted');
  assert.ok(Object.values(bounded.responses).every(list => list.length <= 20));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= WORKBENCH_LIMITS.responseBytes, 'the Workbench still opens');
  assert.ok(!Object.keys(bounded.responses).some(key => key.includes('a'.repeat(64))), 'a retired note is left out');
  const keptA = bounded.responses[JSON.stringify([a.stack, a.operation, a.note_id])] ?? [];
  assert.ok(keptA.some(row => row.text.startsWith('29 ')), 'the most recent response is kept');
  await handlers.respond.run({ ...identity(a), text: 'Another response on A.' });
  const after = JSON.parse(readFileSync(file, 'utf8')).notes;
  assert.equal(after.reduce((sum, row) => sum + row.responses.length, 0), before + 1, 'saving keeps every stored response');
  // A save that would push the stored file past its safe size is refused before writing.
  editJson(file, store => { store.notes.push(...Array.from({ length: 200 }, (_, i) => ({ stack: 'parcel', operation: 'GET /health',
    note_id: `sha256:${i.toString(16).padStart(64, 'b')}`, responses: Array.from({ length: 4 }, () => ({ text: 'z'.repeat(4000), at: at(1) })) }))); });
  const full = readFileSync(file);
  await assert.rejects(handlers.respond.run({ ...identity(a), text: 'One more.' }), { code: 'WORKBENCH_RESPONSES_FULL' });
  assert.deepEqual(readFileSync(file), full, 'nothing was written');
});

test('stacks come in order: handlers in this code first, then stacks with notes, then stacks with none, each by name', async t => {
  const { root, handlers } = lab(t, { survey: false });
  createFixtureStack(root, { name: 'archive', title: 'Archive Lab' });
  editJson(fixtureContextFile(root, 'parcel'), ctx => { ctx.operations['GET /health'].source_file = 'parcel-service/routes.mjs'; });
  const index = await handlers.workbench.run({});
  assert.deepEqual(index.stacks.map(stack => stack.name), ['parcel', 'ledger', 'archive', 'vendor']);
});

test('in a single-store repository the Map names the store as the Workbench does, so its notes and runs join', async t => {
  const { root, handlers } = lab(t, { singleStore: true });
  const index = await handlers.workbench.run({});
  let map = await handlers.surveyMap.run({});
  assert.deepEqual(map.stacks.map(row => row.name), index.stacks.map(row => row.name), 'one store, named as the Workbench names it');
  // With the store's contract configured, its operations are drawn and carry their notes and runs.
  mkdirSync(join(root, LAYOUT.environments, '..'), { recursive: true });
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ default: 'local', environments: { local: { baseUrl: 'http://127.0.0.1:9', contract: 'parcel-service/openapi.json' } } }));
  generateSurvey(root, { now: '2026-10-29T12:00:00.000Z' });
  map = await handlers.surveyMap.run({});
  assert.deepEqual(map.contracts.map(row => row.stack), ['']);
  assert.deepEqual(map.operations.map(op => [op.key, op.stack]).sort(), [['GET /health', ''], ['GET /orders/{orderId}/quote', '']]);
  for (const op of map.operations) assert.ok(index.notes.some(note => note.stack === op.stack && note.operation === op.key), op.key);
  const quote = map.operations.find(op => op.key === 'GET /orders/{orderId}/quote');
  assert.ok(quote.runs.some(run => run.id === 'run-lab-quote-scope' && run.mismatch), 'the note’s run joins');
});

test('the operation view reads a known operation with no note, refuses an unknown one, and reads the single store', async t => {
  const { root, handlers } = lab(t, { quietOperations: true });
  const label = await handlers.operationView.run({ stack: 'parcel', operation: 'POST /orders/{orderId}/label' });
  assert.equal(label.file, 'parcel-service/routes.mjs');
  assert.deepEqual(label.runs.map(run => [run.id, run.status]), [['run-lab-label-created', 201], ['run-lab-label-refused', 409]], 'newest first');
  assert.equal(label.runs_total, 2);
  assert.deepEqual(label.contract.codes, ['201', '409']);
  assert.deepEqual(label.environments, [{ name: 'local', production: false }, { name: 'staging', production: false }]);
  assert.ok(!JSON.stringify(label).includes('127.0.0.1:9/lab'), 'no request input from a run file');
  const health = await handlers.operationView.run({ stack: 'parcel', operation: 'GET /health' });
  assert.equal(health.runs[0].observation.response_status, 200, 'a shared observation that cites the run');
  for (const unknown of [{ stack: 'parcel', operation: 'GET /missing' }, { stack: 'archive', operation: 'GET /health' }, { stack: '', operation: 'GET /health' }])
    await assert.rejects(handlers.operationView.run(unknown), { code: 'WORKBENCH_OPERATION_UNKNOWN' });
  for (const bad of [{ stack: null, operation: 'GET /health' }, { stack: 'parcel', operation: ['GET /health'] }, { stack: 'parcel' }])
    await assert.rejects(handlers.operationView.run(bad), { code: /^WORKBENCH_(OPERATION|PARAMETERS)_INVALID$/u });
  const single = lab(t, { singleStore: true, survey: false });
  const stored = await single.handlers.operationView.run({ stack: '', operation: 'GET /health' });
  assert.equal(stored.stack, '');
  assert.ok(stored.runs.some(run => run.id === 'run-lab-health-ok'));
  await assert.rejects(single.handlers.operationView.run({ stack: 'parcel', operation: 'GET /health' }), { code: 'WORKBENCH_OPERATION_UNKNOWN' });
  assert.deepEqual(stored.environments, [], 'no environments file lists none');
  mkdirSync(join(single.root, LAYOUT.environments, '..'), { recursive: true });
  writeFileSync(join(single.root, LAYOUT.environments), JSON.stringify({ default: 'local', environments: {
    local: { baseUrl: 'http://127.0.0.1:9' }, live: { baseUrl: 'https://api.parcel.example.test', production: true }, prod: {} } }));
  assert.deepEqual((await single.handlers.operationView.run({ stack: '', operation: 'GET /health' })).environments,
    [{ name: 'local', production: false }, { name: 'live', production: true }, { name: 'prod', production: true }], 'the single store’s declared environments');
  assert.ok(root);
});

test('addNote refuses an unknown operation or stack and leaves every ledger as it was', async t => {
  const { root, handlers } = lab(t, { quietOperations: true });
  const ledgers = ['parcel', 'ledger', 'vendor'].map(name => fixtureContextFile(root, name)), before = ledgers.map(file => readFileSync(file));
  for (const unknown of [{ stack: 'parcel', operation: 'GET /missing' }, { stack: 'archive', operation: 'GET /health' }, { stack: '', operation: 'GET /health' }])
    await assert.rejects(handlers.addNote.run({ ...unknown, text: 'A lab note.' }), { code: 'WORKBENCH_OPERATION_UNKNOWN' });
  for (const bad of [{ stack: null, operation: 'GET /health', text: 'A lab note.' }, { stack: 'parcel', operation: 'GET /health', text: 'A lab note.', by: 'Someone' },
    { stack: 'parcel', operation: 'GET /health', text: ['A lab note.'] }, { stack: 'parcel', operation: 'GET /health', text: '   ' }])
    await assert.rejects(handlers.addNote.run(bad), { code: /^(?:WORKBENCH_(?:OPERATION|PARAMETERS)_INVALID|NOTE_ARGUMENTS_REQUIRED)$/u });
  assert.deepEqual(ledgers.map(file => readFileSync(file)), before);
});

test('addNote takes the single store’s empty-string stack and applies the CLI’s single-store policy, leaving the ledger as it was', async t => {
  // The CLI's note command refuses knowledge writes in the single-store
  // layout until migration; the page's write is the same write.
  const single = lab(t, { singleStore: true, survey: false }), file = join(single.root, LAYOUT.context), before = readFileSync(file);
  await assert.rejects(single.handlers.addNote.run({ stack: '', operation: 'GET /health', text: 'Health is served without authentication on local.' }),
    { code: 'STACKS_MIGRATION_REQUIRED' });
  // As in the CLI, the layout is refused before the text is checked.
  for (const text of ['   ', `Send Authorization: Bearer ${'Q7x'.repeat(16)} first.`])
    await assert.rejects(single.handlers.addNote.run({ stack: '', operation: 'GET /health', text }), { code: 'STACKS_MIGRATION_REQUIRED' });
  await assert.rejects(single.handlers.addNote.run({ stack: 'parcel', operation: 'GET /health', text: 'A lab note.' }), { code: 'WORKBENCH_OPERATION_UNKNOWN' });
  assert.deepEqual(readFileSync(file), before);
  const index = await single.handlers.workbench.run({});
  assert.ok(index.notes.every(note => note.stack === ''));
  assert.equal(index.note_writes?.state, 'migration_required', 'the page learns that notes cannot be saved here');
  assert.match(index.note_writes.command, / migrate --dry-run$/u);
  const named = lab(t, { survey: false });
  assert.equal((await named.handlers.workbench.run({})).note_writes, undefined);
});

test('addNote accepts the characters the CLI’s note accepts, such as a tab or a carriage return', async t => {
  const { root, handlers, note } = lab(t, { quietOperations: true });
  for (const text of ['Fields:\tid\tstatus, separated by tabs.', 'A line\r\nand the next.']) {
    note('parcel', 'GET /health', text);
    const saved = await handlers.addNote.run({ stack: 'parcel', operation: 'GET /health', text: `Page: ${text}` });
    assert.match(saved.note_id, /^sha256:/u);
  }
  const stored = JSON.parse(readFileSync(fixtureContextFile(root, 'parcel'), 'utf8')).operations['GET /health'].notes;
  for (const text of ['Fields:\tid\tstatus, separated by tabs.', 'A line\r\nand the next.'])
    assert.ok(stored.includes(text) && stored.includes(`Page: ${text}`), 'the CLI and the page each saved it as written');
});

test('addNote refuses a note that is both too long and credential-shaped as a credential, as the CLI does', async t => {
  const { root, handlers } = lab(t, { quietOperations: true });
  const file = fixtureContextFile(root, 'parcel'), before = readFileSync(file);
  const text = `Send Authorization: Bearer ${'Q7x'.repeat(16)} first. ${'x'.repeat(9000)}`;
  await assert.rejects(handlers.addNote.run({ stack: 'parcel', operation: 'GET /health', text }), { code: 'SECRET_IN_NOTE' });
  await assert.rejects(handlers.addNote.run({ stack: 'parcel', operation: 'GET /health', text: 'x'.repeat(9000) }), { code: 'NOTE_TOO_LONG' });
  assert.deepEqual(readFileSync(file), before);
});

test('addNote returns the key the note is stored under when the ledger names the operation with a trailing slash', async t => {
  const { root, handlers } = lab(t, { quietOperations: true });
  editJson(fixtureContextFile(root, 'parcel'), value => {
    value.operations['GET /health/'] = value.operations['GET /health']; delete value.operations['GET /health'];
  });
  const saved = await handlers.addNote.run({ stack: 'parcel', operation: 'GET /health', text: 'Health answers on the slash form too.' });
  const index = await handlers.workbench.run({});
  assert.ok(index.notes.some(note => JSON.stringify([note.stack || '', note.operation, note.note_id]) === saved.key), 'the returned key is a row of the index');
});

test('addNote turns an unexpected write failure into a note refusal that names no path', async t => {
  if (process.getuid?.() === 0) return t.skip('permissions do not bind root');
  const { root, handlers } = lab(t, { quietOperations: true });
  const dir = dirname(fixtureContextFile(root, 'parcel'));
  chmodSync(dir, 0o555);
  let refusal;
  try { refusal = await handlers.addNote.run({ stack: 'parcel', operation: 'GET /health', text: 'Health answers within a second.' }).then(() => null, error => error); }
  finally { chmodSync(dir, 0o755); }
  assert.ok(refusal, 'the save is refused');
  assert.match(refusal.code, /^(?:NOTE_|CONTEXT_)/u);
  assert.ok(!refusal.message.includes(root) && !(refusal.nextAction ?? '').includes(root), 'no path reaches the page');
});
