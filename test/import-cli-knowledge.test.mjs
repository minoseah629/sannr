import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CONTEXT_FILE, loadContext } from '../lib/context.mjs';

const CLI = resolve('bin/cli.mjs');
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'import-cli-claims-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function run(root, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('API_')));
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...env, NO_COLOR: '1' } });
}
const collection = () => ({ info: { name: 'Health', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [{ name: 'Health', request: { method: 'GET', url: 'https://fixture.invalid/health' },
    event: [{ listen: 'test', script: { exec: ['pm.test("status", () => { pm.response.to.have.status(200); });'] } }] }] });

test('actual CLI import saves durable source claims; previews and repeated imports preserve bytes', t => {
  const root = fixture(t), source = join(root, 'collection.json'); writeFileSync(source, JSON.stringify(collection()));
  for (const flag of ['--json', '--dry-run']) {
    const result = run(root, 'import', source, '--suite', 'health', flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, CONTEXT_FILE)), false);
  }
  const written = run(root, 'import', source, '--suite', 'health');
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /source claims/);
  const before = readFileSync(join(root, CONTEXT_FILE), 'utf8');
  const ctx = loadContext(root); assert.equal(Object.values(ctx.imported_test_claims.sources)[0].claims.length, 1);
  assert.deepEqual(ctx.operations, {});
  const repeated = run(root, 'import', source, '--suite', 'health'); assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(join(root, CONTEXT_FILE), 'utf8'), before);
  for (const flag of ['--json', '--dry-run']) {
    const preview = run(root, 'import', source, '--suite', 'health', flag);
    assert.equal(preview.status, 0);
    if (flag === '--json') assert.ok(JSON.parse(preview.stdout).report);
    assert.equal(readFileSync(join(root, CONTEXT_FILE), 'utf8'), before);
  }
  const shown = run(root, 'show', 'GET /health'); assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).from_tests.claims[0].state, 'unverified');
  const broken = collection(); broken.item[0].event = [];
  writeFileSync(source, JSON.stringify(broken));
  const failed = run(root, 'import', source, '--suite', 'health'); assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(join(root, CONTEXT_FILE), 'utf8'), before);
});

test('import refreshes only existing managed pointers with a separate from-tests count', t => {
  const root = fixture(t);
  const connect = run(root, 'connect', '--agent', 'claude'); assert.equal(connect.status, 0, connect.stderr);
  const source = join(root, 'collection.json'); writeFileSync(source, JSON.stringify(collection()));
  const imported = run(root, 'import', source, '--suite', 'health'); assert.equal(imported.status, 0, imported.stderr);
  const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.match(instructions, /0 operations; 0 written, 0 observed, 0 asserted, 0 verified/);
  assert.match(instructions, /1 claims from imported tests/);
  assert.match(imported.stdout, /updated AGENTS.md/);
});

const insomnia4 = `_type: export
__export_format: 4
resources:
  - _type: workspace
    _id: workspace
    name: Fixture
  - _type: request
    _id: health
    parentId: workspace
    name: Health
    method: GET
    url: https://fixture.invalid/health
  - _type: response
    parentId: health
    statusCode: 200
`;
const insomnia5 = `type: collection.insomnia.rest/5.0
name: Fixture
collection:
  - name: Health
    method: GET
    url: https://fixture.invalid/health
    responses:
      - statusCode: 200
`;
for (const [version, yaml] of [['v4', insomnia4], ['v5', insomnia5]]) test(`CLI routes Insomnia ${version} YAML to its own decoder`, t => {
  const root = fixture(t), source = join(root, 'collection.yaml'); writeFileSync(source, yaml);
  const result = run(root, 'import', source, '--suite', 'insomnia', '--json');
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout); assert.match(out.report.source_kind, /insomnia/);
  assert.equal(out.suite.requests[0].path, '/health'); assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.equal(existsSync(join(root, CONTEXT_FILE)), false);
});

test('Insomnia environment YAML saves names only and does not manufacture a runnable suite', t => {
  const root = fixture(t), source = join(root, 'environment.yaml');
  writeFileSync(source, 'type: environment.insomnia.rest/5.0\nname: fixture\nenvironments:\n  name: base\n  data:\n    password: private-value-do-not-copy\n');
  const result = run(root, 'import', source); assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /private-value-do-not-copy/);
  const facts = readFileSync(join(root, '.sannr/stacks/suites/fixture.environment-facts.json'), 'utf8');
  assert.match(facts, /password/); assert.doesNotMatch(facts, /private-value-do-not-copy/);
  assert.equal(existsSync(join(root, '.sannr/stacks/suites/fixture.json')), false);
  assert.equal(existsSync(join(root, CONTEXT_FILE)), false);
});
