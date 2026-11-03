import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSurveySnapshot, canonicalSurveyJson } from '../lib/survey-model.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';
import { runSurveyCommand } from '../lib/survey-cli.mjs';

const temp = t => {
  const root = mkdtempSync(join(tmpdir(), 'survey-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const fixture = () => createSurveySnapshot();

test('survey CLI separates explicit generation from bounded snapshot reads and rejects ambiguous flags', async t => {
  const root = temp(t), calls = [], snapshot = fixture();
  const io = {
    generateSurvey: async (root, options) => { calls.push(['generate', root, options]); return { state: 'generated', snapshot }; },
    readSurvey: async () => { calls.push(['read']); return { state: 'ready', snapshot }; },
    surveyStatus: async () => { calls.push(['status']); return { state: 'unknown', checked_at: '2026-10-17T00:00:00.000Z' }; },
    querySurvey: async (root, options) => { calls.push(['query', root, options]); return { state: 'ready', nodes: [], relationships: [], omitted: { nodes: 0, relationships: 0 } }; },
  };
  let result = await runSurveyCommand(root, ['generate', '--exclude-env', '--include-fixtures'], { io });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.output).state, 'generated');
  assert.equal(calls[0][2].excludeEnv, true);
  assert.equal(calls[0][2].includeFixtures, true);
  result = await runSurveyCommand(root, ['query', '--stack', 'orders', '--operation', 'GET /orders', '--max-bytes', '1024'], { io });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.at(-1)[2].maxBytes, 1024);
  assert.equal(calls.at(-1)[2].operation, 'GET /orders');
  result = await runSurveyCommand(root, ['status'], { io });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.output).state, 'unknown');
  assert.equal(calls.filter(([kind]) => kind === 'generate').length, 1);
  for (const args of [['query'], ['query', '--operation', 'GET /orders', '--max-bytes', '0'],
    ['generate', '--out', 'a.json', '--out', 'b.json'], ['generate', '--execute'], ['render', '--format', 'javascript'],
    ['status', '--out', 'a.json'], ['render', '--format', 'html', '--out']]) {
    const before = calls.length;
    result = await runSurveyCommand(root, args, { io });
    assert.notEqual(result.exitCode, 0, JSON.stringify(args));
    assert.match(JSON.parse(result.output).code, /^SURVEY_/u);
    assert.equal(calls.length, before, 'argument failures do not read or regenerate');
  }
});

test('survey rendering is atomic, preserves unrelated files and requires explicit external output authority', async t => {
  const root = temp(t), outside = temp(t), snapshot = fixture();
  const io = { readSurvey: async () => ({ state: 'ready', snapshot }) };
  const output = join(root, 'survey.html');
  let result = await runSurveyCommand(root, ['render', '--format', 'html', '--out', output], { io });
  assert.equal(result.exitCode, 0);
  const bytes = readFileSync(output, 'utf8');
  assert.match(bytes, /current inputs not checked/u);
  result = await runSurveyCommand(root, ['render', '--format', 'html', '--out', output], { io });
  assert.equal(result.exitCode, 0, 'byte-identical rendering is a harmless repeat');
  writeFileSync(output, 'user-owned contents');
  result = await runSurveyCommand(root, ['render', '--format', 'html', '--out', output], { io });
  assert.notEqual(result.exitCode, 0);
  assert.equal(readFileSync(output, 'utf8'), 'user-owned contents');
  const external = join(outside, 'survey.dot');
  result = await runSurveyCommand(root, ['render', '--format', 'dot', '--out', external], { io });
  assert.notEqual(result.exitCode, 0);
  assert.equal(existsSync(external), false);
  result = await runSurveyCommand(root, ['render', '--format', 'dot', '--out', external, '--allow-outside-project'], { io });
  assert.equal(result.exitCode, 0);
  assert.match(readFileSync(external, 'utf8'), /^digraph api_survey/u);
});

test('missing or invalid snapshots are bounded diagnostics, never an automatic empty graph or regeneration', async t => {
  const root = temp(t), generated = [];
  for (const state of ['not-generated', 'invalid']) {
    const io = {
      readSurvey: async () => ({ state, code: state === 'invalid' ? 'SURVEY_INVALID' : 'SURVEY_NOT_GENERATED', message: ['', 'Users', 'private', 'token=secret'].join('/') }),
      generateSurvey: async () => { generated.push(true); },
    };
    const result = await runSurveyCommand(root, ['render', '--format', 'html'], { io });
    const diagnostic = JSON.parse(result.output);
    assert.notEqual(result.exitCode, 0);
    assert.match(diagnostic.code, /^SURVEY_/u);
    assert.match(diagnostic.next, /survey generate/u);
    assert.doesNotMatch(result.output, /\/Users\/|token=secret/u);
    assert.ok(Buffer.byteLength(result.output) < 1024);
  }
  assert.deepEqual(generated, []);
});

test('the real CLI preserves a missing snapshot and emits a budgeted operation query without discovery', t => {
  const root = temp(t), isolatedHome = temp(t);
  const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'HOME'
    && !key.startsWith('API_') && !key.startsWith(`${ENV_PREFIX}_`)));
  Object.assign(env, { HOME: isolatedHome, [HOME_ENV_NAME]: join(isolatedHome, '.state') });
  const run = (...args) => spawnSync(process.execPath, [cli, 'survey', ...args], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  const missing = run('query', '--operation', 'GET /orders');
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).code, 'SURVEY_NOT_GENERATED');
  assert.equal(existsSync(join(root, LAYOUT.directory)), false, 'a missing read must not create survey state');
  const directory = join(root, LAYOUT.directory, 'graph'); mkdirSync(directory, { recursive: true });
  const snapshot = createSurveySnapshot({ nodes: [{ id: 'orders', kind: 'operation', label: 'GET /orders', stack: 'orders', operation: 'GET /orders' }] });
  const file = join(directory, 'survey.json'), bytes = canonicalSurveyJson(snapshot); writeFileSync(file, bytes);
  const queried = run('query', '--stack', 'orders', '--operation', 'GET /orders', '--max-bytes', '512');
  assert.equal(queried.status, 0, queried.stderr);
  assert.ok(Buffer.byteLength(queried.stdout) <= 512, 'the entire JSON output respects the requested byte budget');
  const query = JSON.parse(queried.stdout);
  assert.equal(query.snapshot.id, snapshot.snapshot.id);
  assert.equal(query.current_inputs.state, 'not-checked');
  const rendered = run('render', '--format', 'dot');
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /^digraph api_survey/u);
  assert.equal(readFileSync(file, 'utf8'), bytes);
  assert.equal(existsSync(join(root, LAYOUT.evidence, 'survey')), false, 'read-only projections create no private check receipt');

  // Exercise the real output registry, not the injected renderer seam: output
  // paths must never replace the source input while registering a projection.
  const generated = run('generate');
  assert.equal(generated.status, 0, generated.stdout + generated.stderr);
  const saved = readFileSync(file, 'utf8');
  for (const format of ['json', 'dot', 'html']) {
    const projection = run('render', '--format', format, '--out', `projection.${format}`);
    assert.equal(projection.status, 0, projection.stdout + projection.stderr);
    assert.ok(readFileSync(join(root, `projection.${format}`), 'utf8').length > 0);
  }
  const checked = run('status');
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(JSON.parse(checked.stdout).source.state, 'current');
  const unchanged = run('generate');
  assert.equal(unchanged.status, 0, unchanged.stdout + unchanged.stderr);
  assert.equal(JSON.parse(unchanged.stdout).state, 'unchanged');
  assert.equal(readFileSync(file, 'utf8'), saved);
});
