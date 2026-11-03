import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {  HOME_ENV_NAME, PRODUCT } from "../lib/brand.mjs";
import { exportGraphSnapshot } from '../lib/graph-export.mjs';
import { graphRecordFailure } from '../lib/graph-record.mjs';
import { materializeRecordedSnapshot } from '../lib/graph-snapshot-write.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';

const MANIFEST = LAYOUT.graphManifest;
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function fixture(t, manifestName = MANIFEST) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-export-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { v: 1, repository: { id: 'fixture/service', name: 'Service' }, nodes: [], dependencies: [] };
  mkdirSync(dirname(join(root, manifestName)), { recursive: true });
  writeFileSync(join(root, manifestName), JSON.stringify(manifest));
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, operations: {} }));
  return { root, manifestName, manifest };
}
function cli(root, args, env = {}) {
  return spawnSync(process.execPath, [CLI, 'graph', ...args], { cwd: root, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', [HOME_ENV_NAME]: join(root, 'home'), NODE_OPTIONS: '', ...env } });
}
function refused(result, code = 'GRAPH_SNAPSHOT_DESTINATION_REFUSED') {
  assert.equal(result.status, 1, 'unsafe graph export must exit nonzero');
  assert.equal(JSON.parse(result.stderr).error.code, code);
  assert.ok(!result.stdout.includes('Graph snapshot written'));
}

test('AH-1 export refuses the knowledge filename and preserves its bytes', t => {
  const { root } = fixture(t), path = join(root, LAYOUT.context), before = readFileSync(path);
  refused(cli(root, ['export', '--out', LAYOUT.context]));
  assert.deepEqual(readFileSync(path), before);
});

test('AH-1 export refuses the default graph manifest and preserves its bytes', t => {
  const { root } = fixture(t), path = join(root, MANIFEST), before = readFileSync(path);
  refused(cli(root, ['export', '--out', MANIFEST]));
  assert.deepEqual(readFileSync(path), before);
});

test('AH-1 export refuses a custom graph manifest and preserves its bytes', t => {
  const { root, manifestName } = fixture(t, 'config/graph.json'), path = join(root, manifestName), before = readFileSync(path);
  refused(cli(root, ['export', '--manifest', manifestName, '--out', manifestName]));
  assert.deepEqual(readFileSync(path), before);
});

test('AH-1 export refuses a custom manifest reached through a macOS temporary-directory alias', {
  skip: process.platform !== 'darwin' ? 'macOS temporary-directory aliases are not present on this platform' : false,
}, t => {
  const alias = mkdtempSync(('/' + 'tmp/alpha-export-alias-')), root = realpathSync(alias), name = 'manifest.json';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, MANIFEST), JSON.stringify({ v: 1, repository: { id: 'fixture/alias', name: 'Alias' } }));
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, operations: {} }));
  // A manifest can also be valid snapshot-shaped JSON. Its identity remains
  // protected even when the destination uses the OS-owned canonical alias.
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(exportGraphSnapshot(root)));
  const before = readFileSync(path);
  refused(cli(root, ['export', alias, '--manifest', name, '--out', path]));
  assert.deepEqual(readFileSync(path), before);
});

for (const [kind, name] of [['knowledge', LAYOUT.context], ['manifest', MANIFEST]]) {
  test(`AH-1 export refuses the reserved ${kind} basename even when absent`, t => {
    const { root } = fixture(t), out = join('share', name);
    refused(cli(root, ['export', '--out', out]));
    assert.equal(existsSync(join(root, out)), false);
  });
  test(`AH-1 configured writer refuses the reserved ${kind} basename even when absent`, t => {
    const { root, manifest } = fixture(t), out = join('share', name);
    manifest.context = { snapshot: out };
    const result = materializeRecordedSnapshot(root, () => manifest, { publisher: manifest.repository.id });
    assert.equal(result.state, 'failed');
    assert.equal(result.code, 'GRAPH_SNAPSHOT_DESTINATION_REFUSED');
    assert.equal(existsSync(join(root, out)), false);
  });
}

for (const kind of ['unrelated', 'foreign-publisher']) {
  test(`AH-1 export preserves a ${kind} destination`, t => {
    const { root } = fixture(t), target = join(root, 'shared.json');
    const snapshot = exportGraphSnapshot(root);
    snapshot.repository.id = 'fixture/other';
    writeFileSync(target, kind === 'unrelated' ? '{"preserve":true}' : JSON.stringify(snapshot));
    const before = readFileSync(target);
    refused(cli(root, ['export', '--out', target]));
    assert.deepEqual(readFileSync(target), before);
  });
}

test('AH-1 export keeps linked destinations and their targets byte-identical', t => {
  for (const kind of ['hardlink', 'symlink']) {
    const { root } = fixture(t), target = join(root, 'shared.json'), protectedFile = join(root, 'protected.json');
    writeFileSync(protectedFile, JSON.stringify(exportGraphSnapshot(root)));
    if (kind === 'hardlink') linkSync(protectedFile, target); else symlinkSync(protectedFile, target);
    const before = readFileSync(protectedFile), result = cli(root, ['export', '--out', target]);
    assert.equal(result.status, 1);
    assert.deepEqual(readFileSync(protectedFile), before);
    assert.deepEqual(readFileSync(target), before);
  }
});

test('AH-1 export can replace its own valid snapshot using the shared destination guard', t => {
  const { root } = fixture(t), target = join(root, 'share', 'snapshot.json');
  for (let i = 0; i < 2; i++) {
    const result = cli(root, ['export', '--out', target, '--json']);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(readFileSync(target)).repository.id, 'fixture/service');
  }
});

function errorFixture(root, code) {
  const preload = join(root, 'injected-fs-error.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original = fs.openSync;
    fs.openSync = (path, ...args) => {
      if (String(path).endsWith(${JSON.stringify(MANIFEST)})) throw Object.assign(new Error(String(path)), {code: ${JSON.stringify(code)}});
      return original(path, ...args);
    }; syncBuiltinESMExports();`);
  return { NODE_OPTIONS: `--import=${preload}` };
}

test('AH-1 CLI graph errors print curated remediation without a raw absolute path', t => {
  const { root } = fixture(t), code = 'GRAPH_MANIFEST_UNREADABLE';
  // The record path is a current write; historical export fixtures above
  // remain saved read-only stores until STACKS-2 adds the newer projection.
  createFixtureStack(root);
  const result = cli(root, ['record', 'fixture/service#repo', '--operation', 'GET /items', '--note', 'An authored lesson.'], errorFixture(root, code));
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(root), 'graph errors must not expose filesystem paths');
  const expected = graphRecordFailure({ code }).error, actual = JSON.parse(result.stderr).error;
  assert.equal(actual.code, code);
  assert.equal(actual.message, expected.message);
  assert.equal(actual.next, expected.remediation);
});

test('AH-1 CLI graph errors allowlist codes instead of passing through a matching prefix', t => {
  const { root } = fixture(t), code = 'GRAPH_UNLISTED_ERROR';
  createFixtureStack(root);
  const result = cli(root, ['record', 'fixture/service#repo', '--operation', 'GET /items', '--note', 'An authored lesson.'], errorFixture(root, code));
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'GRAPH_RECORD_FAILED');
  assert.ok(!result.stderr.includes(root), 'unknown errors must not expose filesystem paths');
});

for (const format of ['text', 'json']) {
  test(`AH-1 CLI graph ${format} failures include named curated remediation`, t => {
    const { root } = fixture(t);
    rmSync(join(root, MANIFEST));
    const result = cli(root, ['context', ...(format === 'json' ? ['--json'] : [])]);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('GRAPH_NOT_CONFIGURED'), 'the issue must be named');
    if (format === 'json') assert.match(JSON.parse(result.stdout).issues[0].next ?? '', /Configure the local graph manifest/);
    else assert.match(result.stdout, /Configure the local graph manifest/);
    assert.ok(!result.stdout.includes(root));
  });
}

test('AH-1 CLI graph argument errors omit absolute checkout paths from help guidance', t => {
  const { root } = fixture(t);
  const result = cli(root, ['unsupported-action']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, 'GRAPH_ARGUMENT_INVALID');
  assert.ok(!result.stderr.includes(dirname(CLI)), 'argument remediation must stay portable');
  assert.match(JSON.parse(result.stderr).error.next, /docs\/dependency-graph\.md/);
});
