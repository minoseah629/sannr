// Independent install-policy checks. All API execution is disabled; files on
// disk, rather than the implementation's plan, are the write-report oracle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME, POINTER_BEGIN, POINTER_END } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(SOURCE, 'bin/cli.mjs');
const BRIDGE = '@AGENTS.md\n';

function fixture(t, files = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'alpha4-install-policy-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'sannr-state'),
    API_USAGE_LOG: '', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  for (const [path, bytes] of Object.entries(files)) write(path, bytes);
  const invoke = (...args) => {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 15_000,
    });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
      output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}` };
  };
  const connect = (...args) => {
    const result = invoke('connect', ...args);
    assert.equal(result.code, 0, result.output);
    return result;
  };
  return { root, home, env, write, invoke, connect };
}

function snapshot(root, prefix = '') {
  const files = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const [child, bytes] of snapshot(path, name + '/')) files.set(child, bytes);
    } else if (entry.isFile()) files.set(name, readFileSync(path).toString('base64'));
    // Symlink targets belong to a different ownership boundary.
  }
  return files;
}

function changes(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path =>
    before.get(path) === after.get(path) ? [] : [{ path,
      action: !before.has(path) ? 'created' : !after.has(path) ? 'removed' : 'updated' }]);
}

function observed(f) {
  return new Map([...snapshot(f.root), ...[...snapshot(f.home)]
    .map(([path, bytes]) => [join(f.home, path), bytes])]);
}

function managed(text) {
  assert.equal(text.split(POINTER_BEGIN).length - 1, 1, 'exactly one managed block');
  assert.equal(text.split(POINTER_END).length - 1, 1, 'exactly one managed block end');
  return text.slice(text.indexOf(POINTER_BEGIN), text.indexOf(POINTER_END) + POINTER_END.length);
}

test('fresh setup places the full instructions in AGENTS and leaves the Claude bridge one line on repeat', t => {
  const f = fixture(t);
  f.connect('--json');
  const agents = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.match(managed(agents), /API context/);
  assert.equal(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), BRIDGE);
  const beforeRepeat = observed(f);
  const repeated = JSON.parse(f.connect('--json').stdout);
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), agents);
  assert.equal(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), BRIDGE);
  assert.deepEqual([...repeated.touched_files].sort((a, b) => a.path.localeCompare(b.path)),
    changes(beforeRepeat, observed(f)).sort((a, b) => a.path.localeCompare(b.path)));
  const doctor = f.invoke('doctor', '--offline', '--json');
  assert.equal(doctor.code, 0, doctor.output);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.checks.find(row => row.name === 'wiring')?.state, 'PASS', doctor.output);
});

test('existing instruction files retain user text and receive the same managed block idempotently', t => {
  const own = { 'AGENTS.md': '# Team conventions\n\nRun the project checks.\n\n  \n',
    'CLAUDE.md': '# Personal conventions\n\nKeep this instruction verbatim.\n\n  \n' };
  const f = fixture(t, own);
  f.connect('--json');
  const before = Object.fromEntries(Object.keys(own).map(path => [path, readFileSync(join(f.root, path), 'utf8')]));
  for (const path of Object.keys(own)) assert.ok(before[path].startsWith(own[path]), path);
  assert.equal(managed(before['AGENTS.md']), managed(before['CLAUDE.md']));
  f.connect('--json');
  for (const path of Object.keys(own)) assert.equal(readFileSync(join(f.root, path), 'utf8'), before[path]);
});

test('a Claude bridge with user additions is preserved as an existing instruction file', t => {
  const own = BRIDGE + '\n# Added by the team\nPreserve our review policy.\n';
  const f = fixture(t, { 'CLAUDE.md': own });
  f.connect('--json');
  const claude = readFileSync(join(f.root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith(own));
  assert.equal(managed(claude), managed(readFileSync(join(f.root, 'AGENTS.md'), 'utf8')));
  const unwire = f.invoke('unwire', '--json');
  assert.equal(unwire.code, 0, unwire.output);
  assert.ok(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8').startsWith(own));
});

test('migration replaces old managed instructions and preserves their surrounding user bytes', t => {
  const prefix = '# Existing team instructions\n\n  Keep this indentation.\n\n';
  const suffix = '\n\n# Additional policy\nKeep this too.\n';
  const oldBlock = `${POINTER_BEGIN}\nOld generated API instructions.\n${POINTER_END}`;
  const f = fixture(t, { 'AGENTS.md': prefix + oldBlock + suffix,
    'CLAUDE.md': prefix + oldBlock + suffix });
  f.connect('--json');
  const migrated = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  const block = managed(migrated);
  assert.equal(migrated, prefix + block + suffix);
  assert.doesNotMatch(block, /Old generated API instructions/);
  assert.equal(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), migrated);
  f.connect('--json');
  assert.equal(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), migrated);
  assert.equal(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), migrated);
});

for (const format of ['json', 'human']) {
  test(`connect ${format} output names every file it changes, including generated layout and ignore files`, t => {
    const f = fixture(t, { '.gitignore': '# Team-owned ignore rules\n/dist/\n',
      [LAYOUT.gitignore]: '/team-private/\n',
      'openapi.json': JSON.stringify({ openapi: '3.0.3', info: { title: 'fixture', version: '1' },
        paths: { '/thing': { get: { responses: { '200': { description: 'OK' } } } } } }) });
    const before = observed(f);
    const result = f.connect(...(format === 'json' ? ['--json'] : []));
    const actual = changes(before, observed(f));
    for (const required of [LAYOUT.readme, LAYOUT.gitignore, LAYOUT.marker, 'AGENTS.md', 'CLAUDE.md'])
      assert.ok(actual.some(row => row.path === required), `${required} was not exercised`);
    assert.equal(actual.find(row => row.path === LAYOUT.gitignore)?.action, 'updated');
    if (format === 'json') {
      const report = JSON.parse(result.stdout);
      assert.ok(Array.isArray(report.touched_files), 'connect must expose its actual touched-file ledger');
      assert.deepEqual([...report.touched_files].sort((a, b) => a.path.localeCompare(b.path)),
        actual.sort((a, b) => a.path.localeCompare(b.path)));
    } else {
      for (const row of actual) assert.ok(result.stdout.includes(row.path), `unreported ${row.action}: ${row.path}\n${result.output}`);
    }
    assert.equal(readFileSync(join(f.root, '.gitignore'), 'utf8'), '# Team-owned ignore rules\n/dist/\n',
      'ordinary setup has no reason to overwrite the root ignore rules');
    assert.equal(readFileSync(join(f.root, LAYOUT.gitignore), 'utf8'), '/team-private/\n/evidence/\n/feedback/\n');
  });
}

test('dry-run creates no files and distinguishes planned changes from touched files', t => {
  const f = fixture(t);
  const before = observed(f);
  const result = f.connect('--dry-run', '--json');
  assert.deepEqual(observed(f), before);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.touched_files, []);
  assert.ok(report.planned_files?.some(row => row.path === 'AGENTS.md'));
  assert.ok(report.planned_files?.some(row => row.path === 'CLAUDE.md'));
});

test('explicit hook setup also reports the Git-local ignore and host settings writes', t => {
  const f = fixture(t, { '.gitignore': '/dist/\n' });
  const init = spawnSync('git', ['init', '-q'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  f.env.API_BASE_URL = 'http://127.0.0.1:9107';
  const before = observed(f);
  const report = JSON.parse(f.connect('--claude-hook', '--json').stdout);
  const actual = changes(before, observed(f));
  assert.ok(actual.some(row => row.path === '.git/info/exclude'));
  assert.ok(actual.some(row => row.path === '.claude/settings.local.json'));
  assert.deepEqual([...report.touched_files].sort((a, b) => a.path.localeCompare(b.path)),
    actual.sort((a, b) => a.path.localeCompare(b.path)));
  assert.equal(readFileSync(join(f.root, '.gitignore'), 'utf8'), '/dist/\n');
});

test('unwire preserves user text, an existing Claude bridge, API context and evidence', t => {
  const f = fixture(t, { 'AGENTS.md': '# Team-owned instructions\n', 'CLAUDE.md': BRIDGE });
  f.connect('--json');
  const knowledge = '{"team_note":"independent fixture"}\n';
  f.write(LAYOUT.context, knowledge);
  f.write(join(LAYOUT.evidence, 'keep.json'), '{"fixture":true}\n');
  const result = f.invoke('unwire', '--json');
  assert.equal(result.code, 0, result.output);
  assert.equal(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8'), BRIDGE,
    'an unmarked pre-existing bridge is not owned by this tool');
  assert.match(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), /^# Team-owned instructions\n/);
  assert.doesNotMatch(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), new RegExp(POINTER_BEGIN));
  assert.equal(readFileSync(join(f.root, LAYOUT.context), 'utf8'), knowledge);
  assert.equal(readFileSync(join(f.root, LAYOUT.evidence, 'keep.json'), 'utf8'), '{"fixture":true}\n');
});

for (const path of ['AGENTS.md', 'CLAUDE.md']) {
  test(`linked ${path} fails closed before setup changes any other file`, t => {
    const f = fixture(t);
    const outside = join(f.home, 'shared-instructions.md'), secret = '# Never edit this shared file\n';
    writeFileSync(outside, secret);
    symlinkSync(outside, join(f.root, path));
    const before = observed(f);
    const result = f.invoke('connect', '--json');
    assert.notEqual(result.code, 0, result.output);
    assert.deepEqual(observed(f), before, result.output);
    assert.equal(readFileSync(outside, 'utf8'), secret);
    const doctor = f.invoke('doctor', '--offline', '--json');
    const report = JSON.parse(doctor.stdout);
    assert.notEqual(report.checks.find(row => row.name === 'wiring')?.state, 'PASS');
    assert.equal(existsSync(join(f.root, '.mcp.json')), false);
  });
}

test('a malformed existing Claude managed block is a no-write setup conflict', t => {
  const f = fixture(t, { 'CLAUDE.md': '# Team text\n' + POINTER_BEGIN + '\nAn unfinished local edit.\n' });
  const before = observed(f);
  const result = f.invoke('connect', '--json');
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(observed(f), before, result.output);
});

test('doctor never blesses a linked instruction file just because its target has valid markers', t => {
  const f = fixture(t);
  f.connect('--json');
  rmSync(join(f.root, 'CLAUDE.md'));
  symlinkSync(join(f.root, 'AGENTS.md'), join(f.root, 'CLAUDE.md'));
  const before = observed(f);
  const doctor = f.invoke('doctor', '--offline', '--json');
  const report = JSON.parse(doctor.stdout);
  assert.notEqual(report.checks.find(row => row.name === 'wiring')?.state, 'PASS');
  assert.deepEqual(observed(f), before);
});
