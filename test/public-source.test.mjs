import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE_SURFACES } from '../lib/brand.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = path => readFileSync(join(ROOT, path));
const inventory = JSON.parse(read('packaging/public-source-files.json'));
const excluded = path => inventory.excluded_files.includes(path)
  || inventory.excluded_directories.some(prefix => path.startsWith(prefix));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t, mutate = () => {}) {
  const parent = mkdtempSync(join(tmpdir(), 'public-source-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, 'source'), out = join(parent, 'public');
  mkdirSync(source);
  const put = (path, bytes) => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), bytes);
  };
  const files = ['scripts/stage-public-source.mjs', 'lib/brand.mjs',
    'packaging/CLAUDE.public.md', 'packaging/public-source-files.json', 'package.json', 'README.md'];
  for (const path of files.filter(path => path !== 'packaging/public-source-files.json')) put(path, read(path));
  // Model private input even when this regression runs in the staged public
  // repository, where the research-only npm commands are deliberately absent.
  const privatePackage = JSON.parse(read('package.json'));
  privatePackage.scripts['test:external'] = 'node test/external.mjs';
  privatePackage.scripts['test:research'] = 'node scripts/test-unit.mjs --research';
  privatePackage.scripts['pack:alpha'] = 'node scripts/pack-alpha.mjs';
  put('package.json', JSON.stringify(privatePackage));
  const policy = { ...inventory, files };
  put('packaging/public-source-files.json', JSON.stringify(policy));
  put('BUILD_STATUS.json', JSON.stringify({ claim_status: { 'CLAIM-005': 'unproven' } }));
  const research = ['fleet/private.txt', 'harness/private.mjs', 'harness2/protocol.md',
    'reports/envelope-overhead-2026-08-24.md', 'reports/build-status/old.json',
    'EXTERNAL-YARDSTICK.md', 'scripts/graph-alpha-pilot.mjs', 'test/external.mjs',
    'test/research-comparison-evidence.test.mjs',
    // Internal planning and owner-review documents name people and work orders.
    'docs/overhead-milestone.md', 'docs/workbench-goal.md',
    'docs/workbench-owner-walkthrough.md', 'docs/workbench-progress.md',
    // The private alpha ZIP handoff stays in the private repository.
    'packaging/alpha/INSTALL.md', 'packaging/alpha/VERIFY-ZIP.md', 'scripts/alpha-zip.mjs', 'scripts/pack-alpha.mjs'];
  for (const path of research) put(path, 'Private fixture content must not be copied.\n');
  mutate({ put, policy, source });
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Source Fixture', '-c', 'user.email=source-fixture@example.invalid',
    'commit', '-qm', 'Fixture input');
  const execute = () => spawnSync(process.execPath, ['scripts/stage-public-source.mjs', '--out', out],
    { cwd: source, encoding: 'utf8' });
  return { source, out, research, execute, put };
}

test('public source excludes research while retaining product regressions and release tools', () => {
  assert.equal(inventory.schema_version, 2);
  assert.deepEqual(inventory.excluded_directories, ['fleet/', 'harness/', 'harness2/', 'reports/']);
  assert.equal(new Set(inventory.files).size, inventory.files.length);
  assert.deepEqual(inventory.files.filter(excluded), []);
  for (const path of ['EXTERNAL-YARDSTICK.md', 'test/external.mjs', 'test/reach.test.mjs',
    'test/multigen.test.mjs', 'test/comparator.test.mjs', 'scripts/demo-launch-world.mjs',
    'packaging/alpha/VERIFY-ZIP.md', 'scripts/alpha-zip.mjs', 'scripts/pack-alpha.mjs'])
    assert.ok(excluded(path), path);
  assert.ok(PRIVATE_SURFACES.includes('packaging/alpha/INSTALL.md'), 'the alpha install prompt stays private');
  for (const path of ['test/agent-lifecycle-tools-qa.test.mjs', 'test/librarian.test.mjs',
    'test/alpha-hardening-evaluation.test.mjs', 'test/alpha-seam.test.mjs',
    'test/operation-context.test.mjs', 'test/protocol-grpc.test.mjs',
    'test/truthful.mjs', 'test/stress.mjs', 'test/robustness-import.test.mjs',
    'scripts/verify-npx-install.mjs', 'scripts/verify-release-artifact.mjs'])
    assert.ok(inventory.files.includes(path), `${path} remains a product gate`);
});

test('public assembly copies no research, history or build-status ledger', t => {
  const { source, out, research, execute } = fixture(t);
  const before = research.map(path => digest(readFileSync(join(source, path))));
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  for (const path of research) assert.equal(existsSync(join(out, path)), false, path);
  assert.equal(existsSync(join(out, '.git')), false);
  assert.deepEqual(research.map(path => digest(readFileSync(join(source, path)))), before,
    'assembly never removes or changes private research');
  // The private claim ledger stays private: no BUILD_STATUS.json and nothing
  // under reports/ is copied or generated into the public tree.
  assert.equal(existsSync(join(out, 'BUILD_STATUS.json')), false, 'BUILD_STATUS.json is private');
  assert.equal(existsSync(join(out, 'reports')), false, 'reports/ is private');
  const manifest = JSON.parse(readFileSync(join(out, 'PUBLIC_SOURCE.json')));
  assert.deepEqual(manifest.files.filter(row => row.path === 'BUILD_STATUS.json' || row.path.startsWith('reports/')), []);
  assert.deepEqual(manifest.transforms.map(row => row.id),
    ['public-agent-conventions', 'omit-private-research-command']);
  for (const path of ['CLAUDE.md', 'AGENTS.md'])
    assert.doesNotMatch(readFileSync(join(out, path), 'utf8'), /BUILD_STATUS|CLAIM-00/, `${path} names no private ledger`);
  const privatePackage = JSON.parse(readFileSync(join(source, 'package.json')));
  const publicPackage = JSON.parse(readFileSync(join(out, 'package.json')));
  assert.equal(privatePackage.scripts['test:external'], 'node test/external.mjs');
  assert.equal(privatePackage.scripts['test:research'], 'node scripts/test-unit.mjs --research');
  assert.equal(publicPackage.scripts['test:external'], undefined);
  assert.equal(publicPackage.scripts['test:research'], undefined);
  assert.equal(privatePackage.scripts['pack:alpha'], 'node scripts/pack-alpha.mjs');
  assert.equal(publicPackage.scripts['pack:alpha'], undefined, 'the private alpha ZIP builder is not advertised publicly');
  delete privatePackage.scripts['test:external'];
  delete privatePackage.scripts['test:research'];
  delete privatePackage.scripts['pack:alpha'];
  assert.deepEqual(publicPackage, privatePackage, 'only the omitted private scripts change package metadata');
});

test('public assembly fails closed on an unreviewed path outside excluded research directories', t => {
  const { out, execute } = fixture(t, ({ put }) => put('scripts/unreviewed.mjs', 'unreviewed'));
  const result = execute();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unreviewed public source path: scripts\/unreviewed\.mjs/);
  assert.equal(existsSync(out), false);
});

test('public assembly rejects overlapping research inclusion and refuses dirty tracked input', t => {
  const overlapping = fixture(t, ({ put, policy }) => {
    policy.files.push('harness2/protocol.md');
    put('packaging/public-source-files.json', JSON.stringify(policy));
  });
  const rejected = overlapping.execute();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /also excluded as research/);
  const dirty = fixture(t);
  dirty.put('README.md', 'Changed after commit.');
  const result = dirty.execute();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Commit tracked changes/);
  assert.equal(existsSync(dirty.out), false);
});

// The npm tarball and the public repository are both cut from this tree. npm
// pack silently skips a `files` entry that names a deleted path, and staging
// refuses a tracked path the inventory does not review, so pin both against
// the tracked tree. Outside a Git checkout (an assembled copy) there is no
// tracked tree to compare; the skip says so by name.
function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  // A path deleted in the working tree but not yet committed is not part of the tree.
  return result.status === 0 && result.stdout
    ? result.stdout.split('\0').filter(path => path && existsSync(join(ROOT, path))) : null;
}

test('every package.json files entry exists in the tree and ships from the public inventory', t => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('not a Git checkout: no tracked tree to compare the npm file list with');
  const pkg = JSON.parse(read('package.json'));
  const missing = [], notPublic = [];
  for (const rule of pkg.files) {
    const paths = rule.endsWith('/') ? tracked.filter(path => path.startsWith(rule)) : tracked.filter(path => path === rule);
    if (!paths.length) missing.push(rule);
    notPublic.push(...paths.filter(path => !inventory.files.includes(path)));
  }
  assert.deepEqual(missing, [], 'package.json files names a path that is not in the tree; npm pack would omit it without an error');
  assert.deepEqual(notPublic, [], 'the npm package must ship only paths the public source inventory reviews');
});

test('the public inventory and the tracked tree agree, so staging finds no missing or unreviewed path', t => {
  const tracked = trackedFiles();
  if (!tracked) return t.skip('not a Git checkout: no tracked tree to compare the inventory with');
  const present = new Set(tracked);
  // PUBLIC_SOURCE.json, CLAUDE.md and AGENTS.md are written by the assembly itself.
  const reviewedElsewhere = path => excluded(path) || PRIVATE_SURFACES.includes(path)
    || ['BUILD_STATUS.json', 'PUBLIC_SOURCE.json'].includes(path);
  assert.deepEqual(inventory.files.filter(path => !present.has(path)), [],
    'the inventory names a path that is not in the tree; staging would refuse it as missing');
  assert.deepEqual(tracked.filter(path => !reviewedElsewhere(path) && !inventory.files.includes(path)), [],
    'a tracked path is neither public nor excluded; staging would refuse it as unreviewed');
});
