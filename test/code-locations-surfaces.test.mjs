import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { buildApiMapModel, apiMapSummary } from '../lib/api-map.mjs';
import { buildMapModel, renderMapHtml } from '../lib/map.mjs';
import { buildViewModel, renderViewHtml } from '../lib/view.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const write = (root, file, data) => { const target = resolve(root, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data); };
const json = (root, file, data) => write(root, file, JSON.stringify(data));
const contract = paths => ({ openapi: '3.0.3', info: { title: 'Synthetic API', version: '1' }, paths });

// One synthetic surface scenario: local code joins the same rows shown to the
// operator, while declarations never become runtime evidence.
test('map and view locate declared API code without changing evidence or making requests', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'code-surfaces-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: join(root, '.home'), SANNR_HOME: join(root, '.home'), API_USAGE_LOG: join(root, '.usage.jsonl') };
  for (const key of Object.keys(env)) if (key.startsWith('API_') && key !== 'API_USAGE_LOG') delete env[key];
  const previousEnvironment = { ...process.env };
  for (const key of Object.keys(process.env)) if (key === 'HOME' || key.startsWith('API_') || key.startsWith('SANNR_')) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]; Object.assign(process.env, previousEnvironment); });
  const files = contract({ '/files': { post: { responses: { 201: { description: 'created' } } } }, '/orphans': { get: { responses: { 200: { description: 'ok' } } } } });
  json(root, 'service/openapi.json', files);
  write(root, 'service/src/routes/files.ts', 'import express from "express";\nconst app = express();\napp.post("/files", handler);\napp.get("/unmapped", handler);\n');
  createFixtureStack(root, { name: 'files', contract: 'service/openapi.json', baseUrl: 'https://files.example.test' });
  json(root, fixtureContextFile(root, 'files'), { v: 0, api: { name: 'Files' }, operations: { 'POST /files': { notes: [], fields: {}, verified_at: null } } });
  json(root, 'billing/openapi.json', contract({ '/invoices': { get: { responses: { 200: { description: 'ok' } } } } }));
  createFixtureStack(root, { name: 'billing', contract: 'billing/openapi.json', environment: 'production', environments: {
    production: { baseUrl: 'https://billing-prod.example.test/v2' }, staging: { baseUrl: 'https://billing.example.test/v2' },
  } });
  write(root, 'consumer/client.ts', 'const base = "https://billing.example.test/v2";\nfetch(`${base}/invoices`);\n');
  write(root, 'consumer/helper.ts', 'const billing = "https://billing.example.test/v2";\n');
  write(root, 'consumer/.env', 'BILLING_URL=https://billing.example.test/v2\n');
  const model = buildApiMapModel(root, { env }), summary = apiMapSummary(model);
  const served = model.stacks.find(row => row.name === 'files').api_map.operations.find(row => row.op === 'POST /files');
  assert.equal(served.evidence_class.class, 'written');
  assert.equal(served.standing.key, 'write-no-response');
  assert.ok(served.code.defined_in.some(location => location.file === 'service/src/routes/files.ts' && location.line === 3));
  assert.deepEqual(summary.stacks.find(row => row.name === 'files').api_map.operations.find(row => row.op === 'POST /files').code, served.code);
  const billing = model.stacks.find(row => row.name === 'billing').api_map;
  assert.deepEqual(new Set(billing.code.called_from.map(location => location.file)), new Set(['consumer/client.ts', 'consumer/helper.ts', 'consumer/.env']));
  const call = billing.operations.find(row => row.op === 'GET /invoices').code.called_from;
  assert.ok(call.some(location => location.file === 'consumer/client.ts' && location.environments.includes('staging')));
  assert.ok(model.code.unmatched.routes.some(row => (row.operation ?? row.op ?? `${row.method} ${row.path}`) === 'GET /unmapped'));
  assert.ok(model.code.unmatched.operations.some(row => (row.operation ?? row.op) === 'GET /orphans'));
  const footprint = await buildMapModel(root);
  const view = buildViewModel(root, { env });
  for (const html of [renderMapHtml(footprint, { apiMap: model }), renderViewHtml(view)]) {
    assert.ok(html.includes('service/src/routes/files.ts:3'));
    assert.ok(html.includes('consumer/client.ts'));
    assert.ok(html.includes('declared by code'));
    assert.ok(html.includes('GET /unmapped') && html.includes('GET /orphans'));
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script|<iframe|<object|<embed|\bsrc\s*=|\bon[a-z]+\s*=/i);
  }
  // Both real CLI entrypoints run with every Node networking primitive disabled.
  const guard = join(root, '.offline.mjs');
  writeFileSync(guard, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import {syncBuiltinESMExports} from 'node:module'; const no=()=>{throw new Error('network forbidden')}; globalThis.fetch=no; for(const m of [http,https,net,tls]) for(const k of ['request','get','connect','createConnection','createServer']) if(typeof m[k]==='function') m[k]=no; syncBuiltinESMExports();`);
  for (const [stack, operation, expected] of [
    ['files', 'POST /files', served.code], ['billing', 'GET /invoices', billing.operations.find(row => row.op === 'GET /invoices').code],
  ]) {
    const shown = spawnSync(process.execPath, [join(repo, 'bin/cli.mjs'), 'show', operation, '--stack', stack], {
      cwd: root, env: { ...env, NODE_OPTIONS: `--import=${guard}` }, encoding: 'utf8',
    });
    assert.equal(shown.status, 0, shown.stderr + shown.stdout);
    const value = JSON.parse(shown.stdout);
    assert.deepEqual(value.code, expected);
    assert.equal(value.evidence_class.class, 'written');
  }
  for (const command of ['map', 'view']) {
    const out = join(root, `${command}.html`);
    const result = spawnSync(process.execPath, [join(repo, 'bin/cli.mjs'), command, '--out', out, ...(command === 'map' ? ['--no-preview'] : [])], {
      cwd: root, env: { ...env, NODE_OPTIONS: `--import=${guard}` }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(readFileSync(out, 'utf8').includes('service/src/routes/files.ts:3'));
  }
});
