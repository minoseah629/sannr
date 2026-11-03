import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, statSync,
  utimesSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createSourceScan } from '../lib/source-scan.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';

function project(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'source-scan-')));
  const root = join(parent, 'repo'), home = join(parent, 'home');
  mkdirSync(root); mkdirSync(home);
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state');
  t.after(() => {
    for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true });
  });
  return { root, parent };
}
function write(root, file, text) {
  const path = join(root, file); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text); return path;
}
function sources(scan) {
  return scan.sourceFiles().filter(file => file.endsWith('.mjs'))
    .map(file => [relative(scan.root, file), scan.read(file)]);
}

test('process reuse detects source edits, additions, renames and deletions', t => {
  const { root } = project(t), firstFile = write(root, 'src/a.mjs', 'export const a = 1;\n');
  const cold = createSourceScan(root);
  assert.deepEqual(sources(cold), [['src/a.mjs', 'export const a = 1;\n']]);
  assert.equal(cold.stats.content_reads, 1);
  const warm = createSourceScan(root);
  assert.deepEqual(sources(warm), sources(cold));
  assert.equal(warm.stats.content_reads, 0, 'an unchanged invocation reuses source bytes');

  // Size and mtime alone are insufficient: restoring mtime must not preserve
  // bytes or derived interpretation after a same-length source edit.
  const before = statSync(firstFile);
  writeFileSync(firstFile, 'export const a = 2;\n');
  utimesSync(firstFile, before.atime, before.mtime);
  const edited = createSourceScan(root);
  assert.deepEqual(sources(edited), [['src/a.mjs', 'export const a = 2;\n']]);
  assert.equal(edited.stats.content_reads, 1);
  assert.deepEqual(sources(cold), [['src/a.mjs', 'export const a = 1;\n']], 'an in-flight snapshot keeps its original bytes');
  write(root, 'src/b.mjs', 'export const b = 1;\n');
  assert.deepEqual(sources(createSourceScan(root)).map(([file]) => file), ['src/a.mjs', 'src/b.mjs']);
  renameSync(join(root, 'src/b.mjs'), join(root, 'src/c.mjs'));
  assert.deepEqual(sources(createSourceScan(root)).map(([file]) => file), ['src/a.mjs', 'src/c.mjs']);
  rmSync(firstFile);
  assert.deepEqual(sources(createSourceScan(root)), [['src/c.mjs', 'export const b = 1;\n']]);
});

test('a hidden dependency moved outside the repository cannot reuse bytes or derived results', t => {
  const { root, parent } = project(t), file = write(root, '.private/spec.json', '{"paths":{}}');
  const readContract = scan => scan.memo('contract', () => scan.read(file), { files: [file] });
  assert.equal(readContract(createSourceScan(root)), '{"paths":{}}');
  const warm = createSourceScan(root);
  assert.equal(readContract(warm), '{"paths":{}}');
  assert.equal(warm.stats.derived_hits, 1);
  // Moving the containing directory preserves the leaf inode and timestamps.
  // The new ancestor link changes the containment boundary, not those stamps.
  renameSync(join(root, '.private'), join(parent, 'outside'));
  symlinkSync(join(parent, 'outside'), join(root, '.private'), 'dir');
  const moved = createSourceScan(root);
  assert.equal(readContract(moved), null);
  assert.equal(moved.read(file), null);
  assert.equal(moved.stats.derived_hits, 0);
  assert.equal(moved.stats.content_reads, 0);
});

test('caller mutations cannot change a later invocation’s cached discovery', t => {
  const { root } = project(t); write(root, 'src/a.mjs', 'export const a = 1;\n');
  const discover = scan => scan.memo('discovery', () => ({ files: sources(scan), counts: { sources: 1 } }));
  const cold = createSourceScan(root), first = discover(cold);
  first.files[0][1] = 'changed by caller'; first.files.push(['invented.mjs', '']); first.counts.sources = 99;
  const warm = createSourceScan(root), second = discover(warm);
  assert.deepEqual(second, { files: [['src/a.mjs', 'export const a = 1;\n']], counts: { sources: 1 } });
  assert.equal(warm.stats.content_reads, 0);
  assert.equal(warm.stats.derived_hits, 1);
  second.files.length = 0;
  assert.deepEqual(discover(createSourceScan(root)).files, [['src/a.mjs', 'export const a = 1;\n']]);
  write(root, 'src/a.mjs', 'export const a = 2;\n');
  const edited = createSourceScan(root);
  assert.deepEqual(discover(edited).files, [['src/a.mjs', 'export const a = 2;\n']]);
  assert.equal(edited.stats.derived_builds, 1);
});

test('generated instruction and README changes preserve reusable source discovery', t => {
  const { root } = project(t); write(root, 'src/a.mjs', 'export const a = 1;\n');
  const discover = scan => scan.memo('sources', () => sources(scan));
  const expected = discover(createSourceScan(root));
  for (const version of [1, 2]) {
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'README.md']) write(root, file, `Generated instructions ${version}.\n`);
    const scan = createSourceScan(root);
    assert.deepEqual(discover(scan), expected);
    assert.equal(scan.stats.content_reads, 0);
    assert.equal(scan.stats.derived_builds, 0);
    assert.equal(scan.stats.derived_hits, 1);
    assert.equal(scan.stats.inventory_invalidations, 0);
  }
});

test('opt-in inventory accounts for eligible inputs, exclusions and cached read limits', t => {
  const { root } = project(t);
  write(root, 'src/plain.mjs', 'export const value = 1;\n');
  write(root, 'src/large.mjs', 'x'.repeat(64));
  write(root, 'test/fixtures/example.mjs', 'export const fixture = true;\n');
  write(root, 'README.md', 'Not source.\n');
  write(root, '.private/hidden.mjs', 'private source\n');
  write(root, 'node_modules/pkg/index.mjs', 'dependency\n');
  write(root, 'a/b/c/d/e/f/g/h/deep.mjs', 'too deep\n');
  write(root, 'generated/survey.json', '{}');
  write(root, 'nested/.env', 'TOKEN=private-fixture\n');
  symlinkSync(join(root, 'src/plain.mjs'), join(root, 'src/link.mjs'));
  const options = { diagnostics: true, excludeFiles: ['generated/survey.json'] };
  const cold = createSourceScan(root, options), inventory = cold.inventory();
  assert.ok(inventory.entries.some(row => row.path === 'src/plain.mjs' && row.eligible && row.status === 'eligible'));
  assert.ok(inventory.entries.some(row => row.path === 'README.md' && !row.eligible && row.status === 'unsupported-extension'));
  assert.ok(inventory.entries.some(row => row.path === 'test/fixtures/example.mjs' && !row.eligible && row.status === 'fixture-excluded'));
  assert.ok(inventory.entries.some(row => row.path === 'generated/survey.json' && row.status === 'explicitly-excluded'));
  for (const [path, reason, extent] of [
    ['.private', 'hidden-excluded', 'unknown'], ['node_modules', 'directory-excluded', 'unknown'],
    ['a/b/c/d/e/f/g/h', 'depth-limit', 'unknown'], ['src/link.mjs', 'symlink-excluded', 'one'],
  ]) assert.ok(inventory.omissions.some(row => row.path === path && row.reason === reason && row.extent === extent), path);
  assert.ok(!cold.files().includes(join(root, 'generated/survey.json')));
  assert.equal(cold.read('src/plain.mjs'), 'export const value = 1;\n');
  assert.equal(cold.read('src/large.mjs', { maxBytes: 32 }), null);
  const warm = createSourceScan(root, options);
  assert.equal(warm.read('src/plain.mjs'), 'export const value = 1;\n');
  assert.equal(warm.read('src/large.mjs', { maxBytes: 32 }), null);
  const outcomes = scan => scan.readDiagnostics().map(({ path, status, maxBytes }) => ({ path, status, maxBytes }));
  assert.deepEqual(outcomes(warm), outcomes(cold), 'cached null reads still disclose the same limit omission');
  assert.equal(warm.stats.content_reads, 0);
  assert.ok(warm.readDiagnostics().every(row => row.cache_hit));
  assert.equal(warm.readDiagnostics().find(row => row.path === 'src/large.mjs').status, 'oversized');
  write(root, 'src/new-no-api.mjs', 'export const other = 2;\n');
  assert.ok(createSourceScan(root, options).inventory().entries.some(row => row.path === 'src/new-no-api.mjs' && row.eligible));
  const ordinary = createSourceScan(root);
  assert.ok(ordinary.files().includes(join(root, 'generated/survey.json')), 'exclusions do not alter default scans or their cache');
  assert.deepEqual(ordinary.inventory(), { entries: [], omissions: [] });
  const withoutEnvironment = createSourceScan(root, { diagnostics: true, excludeEnvironmentFiles: true });
  assert.ok(!withoutEnvironment.files().includes(join(root, 'nested/.env')));
  assert.equal(withoutEnvironment.read('nested/.env'), null);
  assert.equal(withoutEnvironment.inventory().entries.find(row => row.path === 'nested/.env').status, 'environment-excluded');
  assert.ok(ordinary.files().includes(join(root, 'nested/.env')), 'credential exclusion is opt-in and partitions the cache');
});
