import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUITE_DIR, listSuites, loadSuite, normalizeSuite, saveSuite } from '../lib/suites.mjs';

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin/cli.mjs');
const execFileP = promisify(execFile);
const suffixes = ['todo', 'provenance', 'environment-facts', 'import-losses'];
const suite = { v: 2, name: 'smoke', requests: [{ method: 'GET', path: '/health', expect: [{ status: 200 }] }] };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'household-sidecars-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function cli(root, args, extraEnv = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_')));
  const options = { cwd: root, encoding: 'utf8', timeout: 20000,
    env: { ...env, HOME: root, NO_COLOR: '1', API_USAGE_LOG: '/dev/null', API_CONTEXT_OFF: '1',
      API_EVIDENCE: join(root, 'evidence'), ...extraEnv } };
  try { const out = await execFileP(process.execPath, [CLI, ...args], options); return { code: 0, ...out }; }
  catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
function collection(origin, runnable = true) {
  return { info: { name: 'Household', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      ...(runnable ? [{ name: 'Health', request: { method: 'GET', url: `${origin}/health` },
        event: [{ listen: 'test', script: { exec: ['pm.test("status", () => { pm.response.to.have.status(200); });'] } }] }] : []),
      { name: 'Needs assertions', request: { method: 'POST', url: `${origin}/tasks` } },
    ] };
}

test('real import sidecars stay inspectable while suite list and read-only CI verification run only the suite', async t => {
  const root = fixture(t), hits = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const source = join(root, 'collection.json'); writeFileSync(source, JSON.stringify(collection(origin)));
  const imported = await cli(root, ['import', source, '--suite', 'household']);
  assert.equal(imported.code, 0, imported.stderr);
  const envSource = join(root, 'environment.yaml');
  writeFileSync(envSource, 'type: environment.insomnia.rest/5.0\nname: fixture\nenvironments:\n  name: base\n  data:\n    region: local\n');
  const environment = await cli(root, ['import', envSource]); assert.equal(environment.code, 0, environment.stderr);
  const lossSource = join(root, 'loss.json'); writeFileSync(lossSource, JSON.stringify(collection(origin, false)));
  const lost = await cli(root, ['import', lossSource, '--suite', 'loss']); assert.equal(lost.code, 1, lost.stderr);
  const files = ['household.todo.json', 'household.provenance.json', 'fixture.environment-facts.json', 'loss.import-losses.json'];
  const before = new Map(files.map(file => {
    const path = join(root, SUITE_DIR, file); assert.ok(existsSync(path), file); return [path, readFileSync(path, 'utf8')];
  }));
  assert.deepEqual(listSuites(root), ['household']);
  const listed = await cli(root, ['suite', 'list']); assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /household/); assert.doesNotMatch(listed.stdout, /todo|provenance|environment-facts|import-losses|unreadable/);
  const checked = await cli(root, ['verify', '--read-only', '--ci', '--json'], { API_BASE_URL: origin });
  assert.equal(checked.code, 0, checked.stderr || checked.stdout);
  const report = JSON.parse(checked.stdout);
  assert.equal(report.ok, true); assert.equal(report.request_attempts, 1); assert.equal(report.suites.length, 1);
  assert.deepEqual(hits, ['GET /health']);
  for (const [path, bytes] of before) assert.equal(readFileSync(path, 'utf8'), bytes, 'verification must retain metadata unchanged');
});

test('metadata is excluded by reserved filename, never by parsing or hiding damaged real suites', async t => {
  const root = fixture(t), dir = join(root, SUITE_DIR); mkdirSync(dir, { recursive: true });
  for (const suffix of suffixes) writeFileSync(join(dir, `smoke.${suffix}.json`), '{broken sidecar');
  writeFileSync(join(dir, 'broken.json'), '{broken suite');
  writeFileSync(join(dir, 'smoke.todo-report.json'), JSON.stringify(suite));
  assert.deepEqual(listSuites(root), ['broken', 'smoke.todo-report']);
  const listed = await cli(root, ['suite', 'list']); assert.match(listed.stdout, /broken.*unreadable/);
  const checked = await cli(root, ['verify', '--read-only', '--ci']);
  assert.notEqual(checked.code, 0); assert.match(checked.stderr, /SUITE_CORRUPT/);
});

test('metadata-only directories report NO_SUITES rather than a false passing verification', async t => {
  const root = fixture(t), dir = join(root, SUITE_DIR); mkdirSync(dir, { recursive: true });
  for (const suffix of suffixes) writeFileSync(join(dir, `smoke.${suffix}.json`), JSON.stringify(suite));
  assert.deepEqual(listSuites(root), []);
  const checked = await cli(root, ['verify', '--read-only', '--ci']);
  assert.notEqual(checked.code, 0); assert.match(checked.stderr, /NO_SUITES/);
});

test('explicit suite load and save refuse reserved metadata names before writing', t => {
  const root = fixture(t), dir = join(root, SUITE_DIR); mkdirSync(dir, { recursive: true });
  for (const suffix of [...suffixes, 'TODO']) {
    const name = `smoke.${suffix}`, file = join(dir, `${name}.json`), bytes = JSON.stringify(suite);
    writeFileSync(file, bytes);
    assert.equal(normalizeSuite(name, suite).problems[0]?.code, 'SUITE_NAME_RESERVED');
    assert.throws(() => loadSuite(root, name), { code: 'SUITE_NAME_RESERVED' });
    assert.throws(() => saveSuite(root, { ...suite, name }), { code: 'SUITE_NAME_RESERVED' });
    assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});

test('import refuses reserved suite names before producing hidden suites or sidecars', async t => {
  const root = fixture(t), source = join(root, 'collection.json');
  writeFileSync(source, JSON.stringify(collection('http://127.0.0.1:1')));
  const imported = await cli(root, ['import', source, '--suite', 'smoke.todo']);
  assert.notEqual(imported.code, 0); assert.match(imported.stderr, /SUITE_NAME_RESERVED/);
  assert.equal(existsSync(join(root, SUITE_DIR)), false);
});
