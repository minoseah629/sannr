// `stack import`: one test per acceptance scenario, through the CLI. Sources are
// synthetic stacks in temporary directories; the Git "remote" is a local
// repository given as a file URL. Nothing here touches the network.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { baselineNoteHistory } from '../lib/note-history.mjs';
import { applyImport, openImportSource, parseImportSource, planImport } from '../lib/stack-import.mjs';

const cliPath = join(fileURLToPath(new URL('../', import.meta.url)), 'bin', 'cli.mjs');
const OP = 'GET /pets';
const today = () => new Date().toISOString().slice(0, 10);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const stackFolder = (root, name) => join(root, LAYOUT.collection, name);
const contract = { openapi: '3.0.0', info: { title: 'Pets API', version: '1' },
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } }, post: { responses: { 201: { description: 'ok' } } } } } };

// One temporary parent holds the source and destination repositories as
// siblings, plus the home, machine and temp directories every command uses.
function sandbox(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'stack-import-test-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const name of ['home', 'machine', 'tmp']) mkdirSync(join(base, name));
  const env = { PATH: process.env.PATH, HOME: join(base, 'home'), [HOME_ENV_NAME]: join(base, 'machine'),
    API_USAGE_LOG: join(base, 'machine', 'usage.jsonl'), TMPDIR: join(base, 'tmp'), NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'home', 'gitconfig') };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
    { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const repo = name => { const root = join(base, name); mkdirSync(root, { recursive: true }); git(root, 'init', '--quiet', '--initial-branch=main', '.'); return root; };
  const commit = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '--quiet', '--allow-empty', '-m', message); return git(root, 'rev-parse', 'HEAD'); };
  const cli = (cwd, args, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', exit => { let value; try { value = JSON.parse(stdout); } catch { /* text output */ } resolve({ exit, stdout, stderr, value }); });
  });
  return { base, env, git, repo, commit, cli };
}
const ok = result => { assert.equal(result.exit, 0, `${result.stdout}\n${result.stderr}`); return result.value ?? result.stdout; };

// A source repository with one `pets` stack, built by the CLI as an author would.
async function petsSource(box, { baseUrl = 'http://127.0.0.1:9/v1', name = 'source' } = {}) {
  const root = box.repo(name), author = { API_AUTHOR: 'upstream-author' };
  writeJson(join(root, 'pets.openapi.json'), contract);
  ok(await box.cli(root, ['stack', 'add', 'pets', '--base-url', baseUrl, '--auth', 'bearer:PETS_KEY', '--contract', 'pets.openapi.json', '--env', 'local', '--json'], author));
  const note = async (...args) => ok(await box.cli(root, ['note', ...args, '--stack', 'pets'], author));
  await note(OP, 'Documented: lists are capped at 50.', '--basis', 'documentation', '--source', 'https://docs.example.test/pets');
  await note('--scope', 'stack', 'Errors carry a stable code.');
  return { root, note, author, commit: box.commit(root, 'pets stack') };
}
// A hand-written stack folder, for sources the CLI itself would refuse to write.
function rawStack(root, name, { document = {}, knowledge } = {}) {
  writeJson(join(stackFolder(root, name), 'stack.json'), { v: 1, name, default_environment: 'local',
    environments: { local: { baseUrl: `https://${name}.example.test` } }, ...document });
  if (knowledge) writeJson(join(stackFolder(root, name), CONTEXT_BASENAME), knowledge);
}
// A hash of every file under a repository; `git: true` includes its .git
// directory, so a moved HEAD, a rewritten index or a new file there shows.
function tree(root, { git = false } = {}) {
  const hash = createHash('sha256');
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.name === '.git' && !git) continue;
      hash.update(`${path}\0`);
      if (entry.isDirectory()) walk(path); else hash.update(readFileSync(path));
    }
  };
  walk(root);
  return hash.digest('hex');
}
const show = async (box, root, stack, operation = OP) => ok(await box.cli(root, ['show', operation, '--stack', stack]));
const activeTexts = detail => detail.note_history.active.map(record => record.text);

test('IMP-01: a source holding one stack installs its contract and notes, and show reads them', async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target');
  const receipt = ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  assert.equal(receipt.stacks[0].stack, 'pets');
  assert.deepEqual(json(join(stackFolder(target, 'pets'), 'pets.openapi.json')), contract);
  assert.equal(json(join(stackFolder(target, 'pets'), 'stack.json')).environments.local.auth, 'bearer:PETS_KEY');
  const detail = await show(box, target, 'pets');
  assert.deepEqual(detail.active_notes, ['Documented: lists are capped at 50.']);
  assert.deepEqual(detail.stack_facts.active_notes, ['Errors carry a stable code.']);
  const listed = ok(await box.cli(target, ['stacks', '--json'])).stacks.find(row => row.name === 'pets');
  assert.equal(listed.imported.source, '../source');
  assert.equal(listed.imported.commit, source.commit);
});

test('IMP-02: a source with several stacks lists them and writes nothing until some or all are chosen', async t => {
  const box = sandbox(t), source = box.repo('source');
  for (const name of ['alpha', 'beta', 'gamma']) rawStack(source, name);
  const some = box.repo('some'), every = box.repo('every'), before = tree(some);
  const unselected = await box.cli(some, ['stack', 'import', '../source']);
  assert.notEqual(unselected.exit, 0);
  for (const name of ['alpha', 'beta', 'gamma']) assert.ok(unselected.stderr.includes(name), unselected.stderr);
  assert.equal(tree(some), before);
  ok(await box.cli(some, ['stack', 'import', '../source', '--stack', 'alpha', '--stack', 'beta', '--json']));
  assert.deepEqual(readdirSync(join(some, LAYOUT.collection)).sort(), ['alpha', 'beta']);
  ok(await box.cli(every, ['stack', 'import', '../source', '--all', '--json']));
  assert.deepEqual(readdirSync(join(every, LAYOUT.collection)).sort(), ['alpha', 'beta', 'gamma']);
});

test('IMP-03: a Git URL installs the stack at its head or a named ref, records the commit and leaves no clone', async t => {
  const box = sandbox(t), source = await petsSource(box);
  box.git(source.root, 'branch', 'v1');
  await source.note(OP, 'Documented: the cap rose to 100.', '--alongside');
  const head = box.commit(source.root, 'second note'), url = pathToFileURL(source.root).href;
  const latest = box.repo('latest'), pinned = box.repo('pinned');
  const atHead = await box.cli(latest, ['stack', 'import', url, '--json']);
  assert.equal(ok(atHead).source.commit, head);
  assert.match(atHead.stderr, /git fetch/);
  assert.equal(activeTexts(await show(box, latest, 'pets')).length, 2);
  const atRef = ok(await box.cli(pinned, ['stack', 'import', url, '--ref', 'v1', '--json']));
  assert.equal(atRef.source.commit, source.commit);
  assert.equal(atRef.source.ref, 'v1');
  assert.deepEqual(activeTexts(await show(box, pinned, 'pets')), ['Documented: lists are capped at 50.']);
  assert.equal(ok(await box.cli(pinned, ['stacks', '--json'])).stacks.find(row => row.name === 'pets').imported.commit, source.commit);
  assert.deepEqual(readdirSync(box.env.TMPDIR), []);
});

test('IMP-04: show and context query tell an imported note from a local one and keep the author\'s basis and source', async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target');
  ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  ok(await box.cli(target, ['note', OP, 'Local: we page with limit=10.', '--stack', 'pets', '--alongside'], { API_AUTHOR: 'local-dev' }));
  const expected = { source: '../source', commit: source.commit, at: today() };
  const check = records => {
    const imported = records.find(record => record.text === 'Documented: lists are capped at 50.');
    const local = records.find(record => record.text === 'Local: we page with limit=10.');
    assert.deepEqual({ source: imported.imported.source, commit: imported.imported.commit, at: imported.imported.at }, expected);
    assert.deepEqual(imported.basis, { kind: 'documentation', inferred: false, source: 'https://docs.example.test/pets' });
    assert.equal(imported.author.by, 'upstream-author');
    assert.equal(local.imported, undefined);
    assert.equal(local.author.by, 'local-dev');
  };
  check((await show(box, target, 'pets')).note_projection.records);
  writeJson(join(target, 'query.json'), { operation: OP });
  check(ok(await box.cli(target, ['context', 'query', 'query.json', '--stack', 'pets'])).note_context.records);
  const human = ok(await box.cli(target, ['show', OP, '--stack', 'pets', '--human']));
  assert.ok(human.includes(`imported from "../source" at commit ${source.commit.slice(0, 12)} on ${today()}`), human);
});

test('IMP-05: the envFile, the shared account fact, evidence files and evidence references stay behind; only their count arrives, read as unavailable', async t => {
  const box = sandbox(t);
  const listener = createServer((request, response) => { response.setHeader('content-type', 'application/json'); response.end('[]'); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const source = await petsSource(box, { baseUrl: `http://127.0.0.1:${listener.address().port}/v1` });
  const key = { ...source.author, PETS_KEY: 'synthetic-fixture-key' };
  const run = ok(await box.cli(source.root, ['request', 'GET', '/pets', '--stack', 'pets', '--expect-status', '200'], key)).evidence;
  ok(await box.cli(source.root, ['note', OP, 'Observed: an empty list returned 200.', '--stack', 'pets', '--alongside', '--evidence', run], key));
  ok(await box.cli(source.root, ['note', '--stack', 'pets', '--env', 'local', '--scope', 'account', 'Trial account; writes are unavailable.', '--shared'], key));
  const config = join(stackFolder(source.root, 'pets'), 'stack.json');
  writeJson(config, { ...json(config), environments: { local: { ...json(config).environments.local, envFile: '~/.config/upstream/pets.env' } } });
  assert.ok(Object.keys(json(join(stackFolder(source.root, 'pets'), CONTEXT_BASENAME)).account_facts).length);
  assert.ok(readdirSync(join(source.root, LAYOUT.evidence, 'pets')).length);

  const target = box.repo('target');
  const receipt = ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  assert.deepEqual(json(join(stackFolder(target, 'pets'), 'stack.json')).environments.local,
    { baseUrl: `http://127.0.0.1:${listener.address().port}/v1`, auth: 'bearer:PETS_KEY' });
  const knowledge = readFileSync(join(stackFolder(target, 'pets'), CONTEXT_BASENAME), 'utf8');
  assert.equal(JSON.parse(knowledge).account_facts, undefined);
  assert.ok(!knowledge.includes('Trial account'));
  assert.ok(receipt.stacks[0].not_imported.includes('account_facts'));
  const observed = (await show(box, target, 'pets')).note_history.active.find(record => record.text.startsWith('Observed:'));
  assert.equal(observed.provenance.evidence, undefined);
  assert.ok(!knowledge.includes(run) && !knowledge.includes('127.0.0.1'), 'no run ID or provider URL of the author is carried');
  const projected = (await show(box, target, 'pets')).note_projection.records.find(record => record.text.startsWith('Observed:'));
  assert.deepEqual([projected.imported.evidence_count, projected.imported.evidence_state], [1, 'unavailable']);
  writeJson(join(target, 'query.json'), { operation: OP });
  const queried = ok(await box.cli(target, ['context', 'query', 'query.json', '--stack', 'pets'])).note_context.records.find(record => record.text.startsWith('Observed:'));
  assert.deepEqual([queried.imported.evidence_count, queried.imported.evidence_state], [1, 'unavailable']);
  assert.ok(ok(await box.cli(target, ['show', OP, '--stack', 'pets', '--human'])).includes('the author attached 1 run in the source, unavailable here'));
  const evidence = join(target, LAYOUT.evidence, 'pets');
  assert.deepEqual(existsSync(evidence) ? readdirSync(evidence) : [], []);
});

test('IMP-06: a hostile source is refused by name and leaves the repository unchanged', async t => {
  const box = sandbox(t), target = box.repo('target');
  rawStack(target, 'existing');
  const before = tree(target);
  const refusedWith = async (source, code, exit, detail) => {
    const result = await box.cli(target, ['stack', 'import', `../${source}`]);
    assert.equal(result.exit, exit, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes(code), result.stderr);
    if (detail) assert.ok(result.stderr.includes(detail), result.stderr);
    assert.equal(tree(target), before);
  };
  await t.test('an unknown stack.json key', async () => {
    rawStack(box.repo('unknown-key'), 'pets', { document: { surprise: true } });
    await refusedWith('unknown-key', 'STACK_KEY_UNKNOWN', 1, 'surprise');
  });
  await t.test('a contract path that escapes the stack folder', async () => {
    const source = box.repo('escaping');
    writeJson(join(source, 'outside.openapi.json'), contract);
    rawStack(source, 'pets', { document: { contract: '../../../outside.openapi.json' } });
    await refusedWith('escaping', 'STACK_CONTRACT_OUTSIDE_PROJECT', 1, 'pets');
  });
  await t.test('a symlinked file', async t => {
    const source = box.repo('linked');
    rawStack(source, 'pets');
    writeJson(join(source, 'elsewhere.json'), { v: 0, operations: {} });
    try { symlinkSync(join(source, 'elsewhere.json'), join(stackFolder(source, 'pets'), CONTEXT_BASENAME)); }
    catch { t.skip('this platform cannot create a symbolic link'); return; }
    await refusedWith('linked', 'STACK_UNSAFE_PATH', 1, 'pets');
  });
  await t.test('a note containing a secret-shaped value', async () => {
    const secret = ['sk', 'live', 'a1b2c3d4e5f6g7h8'].join('_');
    const entry = baselineNoteHistory({ source_file: null, verified_at: null, contract_digest: null, shape_hash: null, status_codes: [],
      effect: 'read', fields: {}, notes: [`Use the key ${secret} for this call.`],
      notes_provenance: [{ by: 'upstream-author', at: '2026-11-01' }], notes_superseded: [null] });
    rawStack(box.repo('leaking'), 'pets', { knowledge: { v: 0, api: { name: 'Pets API', contract: null, contract_digest: null },
      generated_at: '2026-11-01', operations: { [OP]: entry } } });
    const result = await box.cli(target, ['stack', 'import', '../leaking']);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    await refusedWith('leaking', 'SECRET_IN_NOTE', 2, OP);
  });
});

test('IMP-07: a name that exists locally refuses and names --as; with --as the stack installs and its notes resolve', async t => {
  const box = sandbox(t);
  await petsSource(box);
  const target = box.repo('target');
  ok(await box.cli(target, ['stack', 'add', 'pets', '--base-url', 'https://pets.internal.example.test', '--json']));
  const before = tree(target);
  const collision = await box.cli(target, ['stack', 'import', '../source']);
  assert.notEqual(collision.exit, 0);
  assert.ok(collision.stderr.includes('STACK_EXISTS') && collision.stderr.includes('--as'), collision.stderr);
  assert.equal(tree(target), before);
  const receipt = ok(await box.cli(target, ['stack', 'import', '../source', '--as', 'pets-library', '--json']));
  assert.deepEqual([receipt.stacks[0].stack, receipt.stacks[0].from], ['pets-library', 'pets']);
  assert.equal(json(join(stackFolder(target, 'pets-library'), 'stack.json')).name, 'pets-library');
  assert.deepEqual((await show(box, target, 'pets-library')).active_notes, ['Documented: lists are capped at 50.']);
  assert.equal(json(join(stackFolder(target, 'pets'), 'stack.json')).environments.default.baseUrl, 'https://pets.internal.example.test');
});

test('IMP-08: importing again brings new, changed and retired upstream notes and keeps the local note', async t => {
  const box = sandbox(t), source = await petsSource(box);
  const changing = (await source.note(OP, 'Documented: the default page size is 20.', '--alongside')).note_id;
  const retiring = (await source.note(OP, 'Documented: sorting by name is supported.', '--alongside')).note_id;
  box.commit(source.root, 'three notes');
  const target = box.repo('target');
  ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  ok(await box.cli(target, ['note', OP, 'Local: we page with limit=10.', '--stack', 'pets', '--alongside'], { API_AUTHOR: 'local-dev' }));

  await source.note(OP, 'Documented: filtering by tag is supported.', '--alongside');
  await source.note(OP, 'Documented: the default page size is 25.', '--supersedes', changing);
  await source.note(OP, 'Sorting was removed in v2.', '--retires', retiring, '--reason', 'removed', '--actor', 'agent', '--by', 'upstream-author');
  const commit = box.commit(source.root, 'new, changed, retired');

  const receipt = ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  assert.equal(receipt.stacks[0].action, 'update');
  assert.deepEqual(receipt.stacks[0].notes, { added: 1, updated: 1, retired: 1, unchanged: 2 });
  assert.equal(receipt.source.commit, commit);
  const detail = await show(box, target, 'pets');
  const active = activeTexts(detail), history = detail.note_history.history.map(record => record.text);
  for (const text of ['Local: we page with limit=10.', 'Documented: lists are capped at 50.',
    'Documented: filtering by tag is supported.', 'Documented: the default page size is 25.'])
    assert.ok(active.includes(text), `${text}\n${active.join('\n')}`);
  for (const text of ['Documented: sorting by name is supported.', 'Documented: the default page size is 20.']) {
    assert.ok(!active.includes(text), text);
    assert.ok(history.includes(text), text);
  }
  assert.equal(detail.note_history.state, 'healthy');
  const again = ok(await box.cli(target, ['stack', 'import', '../source', '--json'])).stacks[0];
  assert.deepEqual(again.notes, { added: 0, updated: 0, retired: 0, unchanged: 5 });
});

test('IMP-09: a dry run prints the receipt of the real import and changes no file, from a path and from a Git URL', async t => {
  const box = sandbox(t), source = await petsSource(box);
  const target = box.repo('target');
  writeFileSync(join(target, 'README.md'), 'a repository\n');
  box.commit(target, 'the user\'s own work');
  const before = tree(target, { git: true });
  const planned = ok(await box.cli(target, ['stack', 'import', '../source', '--dry-run', '--json']));
  const fetched = ok(await box.cli(target, ['stack', 'import', pathToFileURL(source.root).href, '--dry-run', '--json']));
  assert.equal(tree(target, { git: true }), before);
  assert.deepEqual([planned.dry_run, fetched.dry_run, fetched.source.commit], [true, true, source.commit]);
  const done = ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  for (const field of ['source', 'stacks', 'layout_files', 'requests_executed']) assert.deepEqual(planned[field], done[field]);
  assert.deepEqual(fetched.stacks, done.stacks);
  assert.notEqual(tree(target), before);
});

test('IMP-10: import, dry run and update open no connection to the stack\'s base URL', async t => {
  const box = sandbox(t);
  let connections = 0;
  const listener = createServer((request, response) => response.end('{}'));
  listener.on('connection', () => { connections += 1; });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => listener.close());
  const source = await petsSource(box, { baseUrl: `http://127.0.0.1:${listener.address().port}/v1` });
  const target = box.repo('target');
  ok(await box.cli(target, ['stack', 'import', '../source', '--dry-run', '--json']));
  ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  await source.note(OP, 'Documented: filtering by tag is supported.', '--alongside');
  box.commit(source.root, 'another note');
  assert.equal(ok(await box.cli(target, ['stack', 'import', '../source', '--json'])).stacks[0].notes.added, 1);
  ok(await box.cli(target, ['stack', 'import', pathToFileURL(source.root).href, '--as', 'pets-git', '--json']));
  assert.equal(connections, 0);
});

test('a Git source never touches the repository git is pointed at by GIT_DIR and GIT_WORK_TREE', async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target');
  writeFileSync(join(target, 'README.md'), 'the user\'s own work\n');
  const head = box.commit(target, 'the user\'s own work'), before = tree(target, { git: true });
  const redirected = { GIT_DIR: join(target, '.git'), GIT_WORK_TREE: target, GIT_INDEX_FILE: join(target, '.git', 'index') };
  ok(await box.cli(target, ['stack', 'import', pathToFileURL(source.root).href, '--dry-run', '--json'], redirected));
  assert.equal(tree(target, { git: true }), before);
  ok(await box.cli(target, ['stack', 'import', pathToFileURL(source.root).href, '--json'], redirected));
  assert.deepEqual([box.git(target, 'rev-parse', 'HEAD'), box.git(target, 'symbolic-ref', 'HEAD')], [head, 'refs/heads/main']);
  assert.equal(readFileSync(join(target, 'README.md'), 'utf8'), 'the user\'s own work\n');
  assert.ok(!existsSync(join(target, '.git', 'shallow')));
  rmSync(join(target, LAYOUT.directory), { recursive: true });
  assert.equal(tree(target, { git: true }), before);
});

test('a contract name that is not a parseable contract file is refused by name and nothing is planted', async t => {
  const box = sandbox(t), target = box.repo('target'), before = tree(target);
  const plant = (name, contractName, bytes) => {
    const source = box.repo(name), folder = stackFolder(source, 'pets');
    rawStack(source, 'pets', { document: { default_environment: 'a', contract: 'pets.openapi.json', environments: {
      a: { baseUrl: 'https://pets.example.test' }, b: { baseUrl: 'https://pets.example.test', contract: contractName } } } });
    writeJson(join(folder, 'pets.openapi.json'), contract);
    mkdirSync(dirname(join(folder, contractName)), { recursive: true });
    writeFileSync(join(folder, contractName), bytes);
  };
  plant('instructions', 'CLAUDE.md', '# Follow these instructions\n');
  plant('dotfile', 'sub/.mcp.json', JSON.stringify(contract));
  plant('reserved', 'AGENTS.json', JSON.stringify(contract));
  plant('not-a-contract', 'notes.json', JSON.stringify({ mcpServers: { planted: { command: 'sh' } } }));
  for (const [source, name] of [['instructions', 'CLAUDE.md'], ['dotfile', 'sub/.mcp.json'], ['reserved', 'AGENTS.json'], ['not-a-contract', 'notes.json']]) {
    const result = await box.cli(target, ['stack', 'import', `../${source}`]);
    assert.equal(result.exit, 1, result.stdout);
    assert.ok(result.stderr.includes('STACK_CONTRACT_INVALID') && result.stderr.includes(name), result.stderr);
    assert.equal(tree(target), before);
  }
});

test('two far-away sources with the same directory name are not treated as one source', async t => {
  const box = sandbox(t), target = box.repo('deep/er/still/target');
  for (const name of ['one', 'two']) {
    const source = box.repo(`far/${name}/library`);
    rawStack(source, 'pets');
    ok(await box.cli(source, ['stack', 'add', 'notes', '--base-url', 'https://notes.example.test', '--json']));
    ok(await box.cli(source, ['note', OP, `Documented: written in ${name}.`, '--stack', 'notes'], { API_AUTHOR: 'upstream-author' }));
  }
  const first = ok(await box.cli(target, ['stack', 'import', join(box.base, 'far', 'one', 'library'), '--stack', 'notes', '--json']));
  assert.equal(first.source.location, 'library');
  const before = tree(target);
  const second = await box.cli(target, ['stack', 'import', join(box.base, 'far', 'two', 'library'), '--stack', 'notes']);
  assert.equal(second.exit, 1, second.stdout);
  assert.ok(second.stderr.includes('STACK_EXISTS') && second.stderr.includes('--as'), second.stderr);
  assert.equal(tree(target), before);
  ok(await box.cli(target, ['stack', 'import', join(box.base, 'far', 'two', 'library'), '--stack', 'notes', '--as', 'notes-two', '--json']));
  assert.deepEqual((await show(box, target, 'notes')).active_notes, ['Documented: written in one.']);
  assert.deepEqual((await show(box, target, 'notes-two')).active_notes, ['Documented: written in two.']);
});

test('a secret-shaped author name or contract title in the source is refused and not written', async t => {
  const box = sandbox(t), target = box.repo('target'), before = tree(target);
  const secret = ['sk', 'live', 'a1b2c3d4e5'].join('_');
  const entry = baselineNoteHistory({ source_file: null, verified_at: null, contract_digest: null, shape_hash: null, status_codes: [],
    effect: 'read', fields: {}, notes: ['A harmless note.'], notes_provenance: [{ by: secret, at: '2026-11-01' }], notes_superseded: [null] });
  rawStack(box.repo('author'), 'pets', { knowledge: { v: 0, api: { name: 'Pets API', contract: null, contract_digest: null },
    generated_at: '2026-11-01', operations: { [OP]: entry } } });
  const titled = box.repo('title');
  rawStack(titled, 'pets', { document: { contract: 'pets.openapi.json' } });
  writeJson(join(stackFolder(titled, 'pets'), 'pets.openapi.json'), { ...contract, info: { title: `Pets ${secret}`, version: '1' } });
  for (const [source, code, exit] of [['author', 'SECRET_IN_NOTE', 2], ['title', 'STACK_SECRET_LITERAL', 1]]) {
    const result = await box.cli(target, ['stack', 'import', `../${source}`]);
    assert.equal(result.exit, exit, `${result.stdout}\n${result.stderr}`);
    assert.ok(result.stderr.includes(code) && !`${result.stdout}${result.stderr}`.includes(secret), result.stderr);
    assert.equal(tree(target), before);
  }
});

test('3,000 notes on one operation import once, read back unchanged on a second import and leave a healthy history', async t => {
  const box = sandbox(t), target = box.repo('target');
  const notes = Array.from({ length: 3000 }, (_, index) => `Documented: rule ${index} applies.`);
  const entry = baselineNoteHistory({ source_file: null, verified_at: null, contract_digest: null, shape_hash: null, status_codes: [],
    effect: 'read', fields: {}, notes, notes_provenance: notes.map(() => ({ by: 'upstream-author', at: '2026-11-01' })), notes_superseded: notes.map(() => null) });
  rawStack(box.repo('source'), 'pets', { document: { contract: 'pets.openapi.json' }, knowledge: { v: 0,
    api: { name: 'Pets API', contract: null, contract_digest: null }, generated_at: '2026-11-01', operations: { [OP]: entry } } });
  writeJson(join(stackFolder(join(box.base, 'source'), 'pets'), 'pets.openapi.json'), contract);
  assert.equal(ok(await box.cli(target, ['stack', 'import', '../source', '--json'])).stacks[0].notes.added, 3000);
  assert.equal(ok(await box.cli(target, ['stack', 'import', '../source', '--json'])).stacks[0].notes.unchanged, 3000);
  assert.equal((await show(box, target, 'pets')).note_history.state, 'healthy');
});

test('the receipt names each environment\'s hosts, credential variables and production flag, in a dry run and a real import', async t => {
  const box = sandbox(t), target = box.repo('target');
  rawStack(box.repo('source'), 'pay', { document: { default_environment: 'sandbox', environments: { sandbox: {
    baseUrl: 'https://collector.example.test/v1', auth: 'oauth:PAY_CLIENT_ID:PAY_SECRET_KEY', tokenUrl: 'https://tokens.example.test/oauth', production: false } } } });
  const expected = [{ name: 'sandbox', default: true, base_url_host: 'collector.example.test', token_url_host: 'tokens.example.test',
    auth_variables: ['PAY_CLIENT_ID', 'PAY_SECRET_KEY'], production: false }];
  assert.deepEqual(ok(await box.cli(target, ['stack', 'import', '../source', '--dry-run', '--json'])).stacks[0].environments, expected);
  const human = ok(await box.cli(target, ['stack', 'import', '../source', '--dry-run']));
  for (const text of ['collector.example.test', 'tokens.example.test', 'PAY_CLIENT_ID, PAY_SECRET_KEY', 'production: no']) assert.ok(human.includes(text), human);
  assert.deepEqual(ok(await box.cli(target, ['stack', 'import', '../source', '--json'])).stacks[0].environments, expected);
  const updated = ok(await box.cli(target, ['stack', 'import', '../source']));
  assert.ok(updated.includes('collector.example.test') && updated.includes('PAY_CLIENT_ID, PAY_SECRET_KEY'), updated);
});

test('terminating an import while git is fetching removes the temporary clone', { skip: process.platform === 'win32' && 'the stand-in git is a POSIX shell script' }, async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target');
  // A stand-in git that stalls on fetch and is the real git for everything else.
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), bin = join(box.base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor argument in "$@"; do if [ "$argument" = fetch ]; then exec sleep 30; fi; done\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  const child = spawn(process.execPath, [cliPath, 'stack', 'import', pathToFileURL(source.root).href],
    { cwd: target, env: { ...box.env, PATH: `${bin}:${box.env.PATH}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  const closed = new Promise(resolve => child.once('close', (exit, signal) => resolve({ exit, signal })));
  for (let waited = 0; waited < 20000 && !(stderr.includes('git fetch') && readdirSync(box.env.TMPDIR).length); waited += 50)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(readdirSync(box.env.TMPDIR).length, 1, stderr);
  await new Promise(resolve => setTimeout(resolve, 300));
  child.kill('SIGTERM');
  assert.deepEqual(await closed, { exit: 143, signal: null });
  assert.deepEqual(readdirSync(box.env.TMPDIR), []);
});

test('a Git source is read without running the user\'s smudge filters on its files', { skip: process.platform === 'win32' && 'the filter is a POSIX shell script' }, async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target');
  writeFileSync(join(source.root, '.gitattributes'), '*.json filter=fixture\n');
  box.commit(source.root, 'select a filter');
  const marker = join(box.base, 'filter-ran'), filter = join(box.base, 'smudge.sh');
  writeFileSync(filter, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(filter, 0o755);
  // The filter is configured wherever git may look for the user's settings.
  for (const file of [join(box.env.HOME, '.gitconfig'), box.env.GIT_CONFIG_GLOBAL]) writeFileSync(file, `[filter "fixture"]\n\tsmudge = ${filter}\n`);
  ok(await box.cli(target, ['stack', 'import', pathToFileURL(source.root).href, '--json']));
  assert.ok(!existsSync(marker));
  assert.deepEqual((await show(box, target, 'pets')).active_notes, ['Documented: lists are capped at 50.']);
});

test('a Git repository that is one stack folder at its root imports under the name in its stack.json, or under --as', async t => {
  const box = sandbox(t), source = box.repo('source'), target = box.repo('target');
  writeJson(join(source, 'stack.json'), { v: 1, name: 'pets', contract: 'pets.openapi.json', default_environment: 'local',
    environments: { local: { baseUrl: 'https://pets.example.test' } } });
  writeJson(join(source, 'pets.openapi.json'), contract);
  const commit = box.commit(source, 'a stack at the root'), url = pathToFileURL(source).href;
  const receipt = ok(await box.cli(target, ['stack', 'import', url, '--json']));
  assert.deepEqual([receipt.stacks[0].stack, receipt.source.commit], ['pets', commit]);
  assert.equal(ok(await box.cli(target, ['stack', 'import', url, '--as', 'pets-two', '--json'])).stacks[0].stack, 'pets-two');
  assert.deepEqual(readdirSync(join(target, LAYOUT.collection)).sort(), ['pets', 'pets-two']);
});

test('every contract shape stack add accepts imports from a stack built with stack add', async t => {
  const box = sandbox(t), source = box.repo('source'), target = box.repo('target');
  const shapes = {
    'json-three': ['pets.openapi.json', JSON.stringify(contract)],
    'yaml-swagger': ['two.yaml', 'swagger: 2.0\ninfo:\n  title: Two\n  version: "1"\nbasePath: /v1\npaths:\n  /pets:\n    get:\n      responses:\n        200:\n          description: ok\n'],
    'yaml-three-one': ['three.yml', 'openapi: 3.1\ninfo:\n  title: Three\n  version: "1"\npaths:\n  /pets:\n    get:\n      responses:\n        "200":\n          description: ok\n'],
    'yaml-anchors': ['anchors.yaml', 'openapi: 3.0.3\ninfo:\n  title: Anchors\n  version: "1"\n  description: |\n    A block scalar\n    over two lines.\nx-ok: &ok\n  description: ok\npaths:\n  /pets:\n    get:\n      responses:\n        "200": *ok\n    post:\n      responses:\n        "201": *ok\n'],
  };
  for (const [name, [file, text]] of Object.entries(shapes)) {
    writeFileSync(join(source, file), text);
    ok(await box.cli(source, ['stack', 'add', name, '--base-url', `https://${name}.example.test`, '--contract', file, '--json']));
  }
  const receipt = ok(await box.cli(target, ['stack', 'import', '../source', '--all', '--json']));
  assert.deepEqual(receipt.stacks.map(row => row.stack).sort(), Object.keys(shapes).sort());
  for (const row of receipt.stacks) {
    assert.ok(row.operations > 0, row.stack);
    assert.equal(row.operations, Object.keys(json(join(stackFolder(source, row.stack), CONTEXT_BASENAME)).operations).length, row.stack);
  }
});

test('a stack folder that appears between planning and writing is left untouched, and earlier stacks in the run are reported as written', async t => {
  const box = sandbox(t), source = box.repo('source'), target = box.repo('target');
  for (const name of ['alpha', 'zeta']) rawStack(source, name);
  const plan = planImport(target, await openImportSource(target, parseImportSource(source)), { all: true });
  ok(await box.cli(target, ['stack', 'add', 'zeta', '--base-url', 'https://mine.example.test', '--json']));
  ok(await box.cli(target, ['note', 'GET /mine', 'A local note.', '--stack', 'zeta'], { API_AUTHOR: 'local-dev' }));
  const mine = tree(stackFolder(target, 'zeta'));
  const applied = applyImport(plan);
  assert.deepEqual([applied.written, applied.failed.stack, applied.failed.code], [['alpha'], 'zeta', 'STACK_EXISTS']);
  assert.equal(tree(stackFolder(target, 'zeta')), mine);
  assert.deepEqual((await show(box, target, 'zeta', 'GET /mine')).active_notes, ['A local note.']);
  assert.ok(existsSync(join(stackFolder(target, 'alpha'), 'stack.json')));
});

test('a stack imported from a source recorded by name only is never updated from a nearer source of the same name', async t => {
  const box = sandbox(t), target = box.repo('deep/er/still/target');
  const build = async (root, text) => {
    ok(await box.cli(root, ['stack', 'add', 'pets', '--base-url', 'https://pets.example.test', '--json']));
    ok(await box.cli(root, ['note', OP, text, '--stack', 'pets'], { API_AUTHOR: 'upstream-author' }));
  };
  await build(box.repo('far/one/library'), 'Documented: written far away.');
  ok(await box.cli(target, ['stack', 'import', join(box.base, 'far', 'one', 'library'), '--json']));
  await build(box.repo('deep/er/still/target/library'), 'Documented: written nearby.');
  const before = tree(target);
  const second = await box.cli(target, ['stack', 'import', './library']);
  assert.equal(second.exit, 1, second.stdout);
  assert.ok(second.stderr.includes('STACK_EXISTS') && second.stderr.includes('--as'), second.stderr);
  assert.equal(tree(target), before);
});

test('GIT_ALLOW_PROTOCOL set by the user still restricts the fetch of a Git source', async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target'), before = tree(target);
  const result = await box.cli(target, ['stack', 'import', pathToFileURL(source.root).href], { GIT_ALLOW_PROTOCOL: 'https' });
  assert.equal(result.exit, 1, result.stdout);
  assert.ok(result.stderr.includes('STACK_IMPORT_GIT_FAILED'), result.stderr);
  assert.equal(tree(target), before);
  assert.deepEqual(readdirSync(box.env.TMPDIR), []);
});

test('an upstream retirement of a locally trusted note arrives beside it naming the local note, and is reported as held on every import', async t => {
  const box = sandbox(t), source = await petsSource(box), target = box.repo('target');
  const upstream = (await source.note(OP, 'Documented: sorting by name is supported.', '--alongside')).note_id;
  ok(await box.cli(target, ['stack', 'import', '../source', '--json']));
  const local = (await show(box, target, 'pets')).note_history.active.find(record => record.text.includes('sorting')).id;
  ok(await box.cli(target, ['review', OP, '--stack', 'pets', '--note', local, '--decision', 'trusted', '--by', 'Alex', '--actor', 'person', '--json']));
  await source.note(OP, 'Sorting was removed in v2.', '--retires', upstream, '--reason', 'removed', '--actor', 'agent', '--by', 'upstream-author');
  for (const round of ['first', 'second']) {
    const row = ok(await box.cli(target, ['stack', 'import', '../source', '--json'])).stacks[0];
    assert.deepEqual(row.held, [{ target: OP, note_id: local, reason: 'LOCALLY_TRUSTED' }], round);
    assert.deepEqual(row.no_longer_upstream, [], round);
  }
  const active = activeTexts(await show(box, target, 'pets'));
  assert.ok(active.includes('Documented: sorting by name is supported.'));
  assert.ok(active.includes(`Retired ${local} (removed): Sorting was removed in v2.`), active.join('\n'));
});
