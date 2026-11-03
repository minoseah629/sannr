import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateSurvey, readSurvey, surveyStatus, querySurvey } from '../lib/survey.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';
import { createSurveySnapshot } from '../lib/survey-model.mjs';

const first = '2026-10-17T01:00:00.000Z', second = '2026-10-17T02:00:00.000Z';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'survey-independent-qa-'));
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = join(root, '.isolated-home'); process.env[HOME_ENV_NAME] = join(root, '.isolated-home/state');
  mkdirSync(process.env.HOME);
  t.after(() => { for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(root, { recursive: true, force: true }); });
  const write = (path, value) => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value)); return target;
  };
  const stack = `${LAYOUT.collection}/inventory/stack.json`;
  write(stack, { v: 1, name: 'inventory', title: 'Inventory API', default_environment: 'test', contract: 'openapi.json',
    environments: { test: { baseUrl: 'https://inventory.example.test' } } });
  write(`${LAYOUT.collection}/inventory/openapi.json`, { openapi: '3.0.3', info: { title: 'Inventory', version: '1' },
    paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } } });
  write('src/client.mjs', 'fetch("https://inventory.example.test/items");\n');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  return { root, write, git, stack };
}

test('a failed explicit status check replaces an older current receipt without rewriting the artifact', t => {
  const { root, write, stack } = fixture(t);
  const generated = generateSurvey(root, { now: first });
  const before = readFileSync(generated.path, 'utf8');
  assert.equal(surveyStatus(root, { now: first }).state, 'current');
  write(stack, '{broken');
  assert.equal(surveyStatus(root, { now: second }).state, 'unknown');
  const query = querySurvey(root, { stack: 'inventory', operation: 'GET /items' });
  assert.equal(query.current_inputs.state, 'unknown', 'snapshot readers must not reuse the previous green freshness receipt');
  assert.equal(query.current_inputs.checked_at, second);
  assert.equal(readFileSync(generated.path, 'utf8'), before);
  const stateDirectory = join(root, LAYOUT.evidence, 'survey');
  const receipt = readdirSync(stateDirectory).find(name => name.endsWith('.status.json'));
  const privateMarker = ['', 'Users', 'private-account', 'local-secret-file'].join('/');
  writeFileSync(join(stateDirectory, receipt), JSON.stringify({ snapshot_id: generated.snapshot.snapshot.id,
    state: 'current', checked_at: second, source: { state: 'current', detail: privateMarker }, privateMarker }));
  assert.ok(!JSON.stringify(readSurvey(root)).includes(privateMarker));
  assert.ok(!JSON.stringify(querySurvey(root)).includes(privateMarker));
  writeFileSync(join(stateDirectory, receipt), JSON.stringify({ snapshot_id: generated.snapshot.snapshot.id,
    state: privateMarker, checked_at: second }));
  assert.equal(querySurvey(root).current_inputs.state, 'not-checked');
});

test('generation installs Git exclusion for private raw-input fingerprints in a newly configured checkout', t => {
  const { root, git } = fixture(t);
  generateSurvey(root, { now: first });
  const state = join(LAYOUT.evidence, 'survey');
  const baseline = readdirSync(join(root, state)).find(name => name.endsWith('.inputs.json'));
  assert.ok(baseline, 'the local freshness baseline was actually written');
  const listed = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  assert.ok(!listed.includes(join(state, baseline)), 'private raw fingerprints must be ignored, not merely chmod 600');
  assert.throws(() => generateSurvey(root, { stateDir: root }),
    'a state directory cannot encompass the source repository and append ignore-all rules to its root');
  assert.equal(existsSync(join(root, '.gitignore')), false, 'rejected broad state destination leaves repository ignore policy intact');
  assert.throws(() => generateSurvey(root, { stateDir: join(root, 'src') }),
    'a preexisting source directory is not an owned private state directory');
  assert.equal(existsSync(join(root, 'src/.gitignore')), false, 'rejected source directory keeps its ignore policy intact');
});

test('a source depth limit is reported as truncated coverage and cannot yield clean current inputs', t => {
  const { root, write } = fixture(t);
  write('a/b/c/d/e/f/g/h/deep.mjs', 'fetch("https://inventory.example.test/items");\n');
  const generated = generateSurvey(root, { now: first });
  assert.ok(generated.snapshot.coverage.omissions.some(row => row.reason === 'depth-limit'));
  assert.equal(generated.snapshot.coverage.truncated, true, 'dropping an unread subtree is truncation, not complete coverage');
  assert.equal(surveyStatus(root).source.state, 'unknown', 'the unchecked subtree cannot produce a clean freshness result');
});

test('unresolved route metadata cannot bypass the portable query-value boundary', t => {
  const { root, write } = fixture(t), marker = 'ordinary-private-account';
  write('src/routes.mjs', `app.get('/unmatched?account=${marker}', handler);\napp.get('/other#${marker}', handler);\n`);
  const generated = generateSurvey(root, { now: first });
  assert.ok(!JSON.stringify(generated.snapshot).includes(marker), 'unresolved candidates are portable metadata too');
  for (const fields of [{ path: `/unmatched?account=${marker}` }, { operation: `GET /items?account=${marker}` },
    { host: `inventory.example.test?account=${marker}` }, { path: `/unmatched%3Faccount%3D${marker}` },
    { operation: `GET /items%253Faccount%253D${marker}` }, { path: `/unmatched#${marker}` }])
    assert.throws(() => createSurveySnapshot({ unresolved: [{ kind: 'call', reason: 'no-unique-bound-operation', ...fields }] }),
      'strict model validation must reject query-bearing unresolved structure');
});
