import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupGuidance } from '../lib/onboarding.mjs';
import { ENVELOPE_VERSION, OPERATORS } from '../lib/assertions.mjs';
import { buildMapModel, renderMapText, renderMapHtml } from '../lib/map.mjs';
import { HOME_ENV_NAME, } from "../lib/brand.mjs";

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'ah2-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('AH-2 context unknown action has its own value-free public code', t => {
  const root = project(t), action = 'invalid-private-input';
  const env = { ...process.env, [HOME_ENV_NAME]: join(root, 'home'), API_CONTEXT_DIR: root };
  for (const args of [['context', action], ['context', action, 'missing.json']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONTEXT_ACTION_UNKNOWN/);
    assert.ok(!result.stderr.includes(action));
  }
});

test('AH-2 committed setup marker is explicitly machine-local', () => {
  const guidance = setupGuidance(`setup-v1:${'a'.repeat(64)}`);
  assert.match(guidance, /machine-local/i);
  assert.match(guidance, /another (?:machine|checkout)/i);
});

test('AH-2 context errors use an allowlist instead of passing through error code or message', t => {
  const root = project(t), injectedCode = 'CONTEXT_PRIVATE_INPUT', injectedMessage = 'private-error-input';
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ v: 0, operations: {} }));
  writeFileSync(join(root, 'query.json'), '{}');
  const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const stat = fs.statSync; fs.statSync = function(path, ...args) {
      if (String(path).endsWith(${JSON.stringify(LAYOUT.context)})) throw Object.assign(new Error(${JSON.stringify(injectedMessage)}), {code:${JSON.stringify(injectedCode)}});
      return stat.call(this, path, ...args);
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    CLI, 'context', 'query', 'query.json'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, [HOME_ENV_NAME]: join(root, 'home'), API_CONTEXT_DIR: root } });
  assert.equal(result.status, 1);
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes(injectedCode), 'foreign error codes must not be public');
  assert.ok(!output.includes(injectedMessage), 'foreign error messages must not be public');
  assert.match(output, /CONTEXT_COMMAND_FAILED/);
});

test('AH-2 deep equality uses envelope v2 and has a migration note', () => {
  assert.equal(ENVELOPE_VERSION, 2);
  assert.equal(OPERATORS.equals({ fields: [1, { present: true }] }, { fields: [1, { present: true }] }), true);
  assert.equal(OPERATORS.equals([1, 2], [2, 1]), false);
  assert.equal(OPERATORS.not_equals({ n: 1 }, { n: '1' }), true);
  const migration = readFileSync(new URL('../docs/imports.md', import.meta.url), 'utf8');
  assert.match(migration, /envelope v2/i);
  assert.match(migration, /deep.*equal/i);
  assert.match(migration, /ENVELOPE_VERSION_UNSUPPORTED/);
});

test('AH-2 parser-only base suppression is an omission in JSON text and HTML maps', async t => {
  const root = project(t);
  writeFileSync(join(root, 'server.mjs'), "const parsed = new URL(req.url, 'http://parser-only.invalid');\n");
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0',
    info: { title: 'Omission fixture', version: '1' }, paths: { '/health': { get: { responses: { '200': { description: 'ok' } } } } } }));
  const model = await buildMapModel(root, { execute: false });
  assert.deepEqual(model.external, []);
  assert.ok(model.omissions?.some(row => row.code === 'PARSER_ONLY_BASE_OMITTED' && row.file === 'server.mjs'));
  assert.match(renderMapText(model), /PARSER_ONLY_BASE_OMITTED/);
  assert.match(renderMapHtml(model), /PARSER_ONLY_BASE_OMITTED/);
  assert.ok(!JSON.stringify(model.omissions).includes('parser-only.invalid'));
  const started = spawnSync(process.execPath, [CLI, 'start'], { cwd: root, encoding: 'utf8',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_'))),
      [HOME_ENV_NAME]: join(root, 'home'), API_CONTEXT_DIR: root } });
  assert.equal(started.status, 0);
  assert.match(started.stdout, /PARSER_ONLY_BASE_OMITTED/);
});
