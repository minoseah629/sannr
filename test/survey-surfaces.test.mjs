import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createSurveySnapshot, canonicalSurveyJson } from '../lib/survey-model.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';

test('show and map consume the saved survey without regeneration, and invalid snapshots do not disable CODE-1', t => {
  const root = mkdtempSync(join(tmpdir(), 'survey-surfaces-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); };
  put(join(root, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Files', version: '1' },
    paths: { '/files': { get: { responses: { 200: { description: 'OK' } } } } } });
  put(join(root, 'src/app.mjs'), 'app.get("/files", handler);\n');
  createFixtureStack(root, { name: 'files', contract: 'openapi.json' });
  put(fixtureContextFile(root, 'files'), { v: 0, api: { name: 'Files' }, operations: { 'GET /files': { notes: [] } } });
  const env = { ...process.env, HOME: join(root, '.home') };
  for (const key of Object.keys(env)) if (key.startsWith('API_') || key.startsWith('SANNR_')) delete env[key];
  const cli = (...args) => {
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cli.mjs', import.meta.url)), ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr + run.stdout); return JSON.parse(run.stdout);
  };
  const shownBefore = cli('show', 'GET /files', '--stack', 'files');
  assert.equal(shownBefore.survey.state, 'not-generated');
  assert.match(shownBefore.survey.command, /survey generate/u);
  const snapshot = createSurveySnapshot({ nodes: [
    { id: 'op-files', kind: 'operation', label: 'GET /files', operation: 'GET /files', stack: 'files' },
    { id: 'file-app', kind: 'file', label: 'src/app.mjs', file: 'src/app.mjs' },
  ], relationships: [{ id: 'edge-defines', kind: 'defines', from: 'file-app', to: 'op-files',
    declarations: [{ kind: 'code', file: 'src/app.mjs', line: 1 }], observations: [], operator_attributions: [] }] });
  const file = join(root, LAYOUT.directory, 'graph', 'survey.json');
  put(file, canonicalSurveyJson(snapshot));
  const before = readFileSync(file, 'utf8');
  const shown = cli('show', 'GET /files', '--stack', 'files');
  assert.deepEqual(shown.code, shownBefore.code);
  assert.equal(shown.survey.snapshot.id, snapshot.snapshot.id);
  assert.deepEqual(shown.survey.current_inputs, { state: 'not-checked' });
  const mapped = cli('map', '--json', '--no-execute');
  assert.equal(mapped.survey.snapshot.snapshot.id, snapshot.snapshot.id);
  assert.deepEqual(mapped.survey.snapshot.relationships, snapshot.relationships);
  assert.equal(readFileSync(file, 'utf8'), before, 'reading never refreshes the survey');
  put(file, '{"v":999,"kind":"api-survey"}');
  const invalid = cli('show', 'GET /files', '--stack', 'files');
  assert.equal(invalid.survey.state, 'invalid');
  assert.deepEqual(invalid.code, shownBefore.code);
  assert.equal(readFileSync(file, 'utf8'), '{"v":999,"kind":"api-survey"}');
});
