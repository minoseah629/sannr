// STACKS-2(d): genuine independent stacks; all sources are synthetic local files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { operationId, contextShape } from '../lib/operation-context.mjs';
import { buildApiMapModel, renderApiMapHtml, apiMapSummary } from '../lib/api-map.mjs';
import { buildViewModel, renderViewHtml } from '../lib/view.mjs';
import { footprintModel, renderMapHtml } from '../lib/map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AT = '2026-10-07T12:00:00.000Z';
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const SECRET = 'Bearer ' + 'synthetic_test_token_'.repeat(3);
const RAW = 'PRIVATE_BODY_VALUE_7R2Q';
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-map-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, count] of [['alpha', 1], ['beta', 2]]) {
    const contract = JSON.stringify({ openapi: '3.0.3', info: { title: `${name} API`, version: '1' }, paths: {
      '/users': { get: { summary: `<script>alert(1)</script> ${name}`, responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string', example: RAW, default: RAW, const: RAW } } }, example: RAW } } } } } },
    } });
    writeFileSync(join(root, `${name}.json`), contract);
    createFixtureStack(root, { name, title: `${name} API`, environment: 'production', baseUrl: `https://${name}.example.test`, contract: `${name}.json` });
    const identity = { stack: name, provider: `https://${name}.example.test`, environment: 'production', protocol: 'http', operation: 'GET /users', endpoint: `https://${name}.example.test/users`, contractDigest: sha(contract) };
    const observations = Array.from({ length: count }, (_, n) => {
      const path = `${LAYOUT.evidence}/${name}/run-${name}-${n}.json`, bytes = JSON.stringify({ body: RAW, headers: { authorization: SECRET } });
      writeFileSync(join(root, path), bytes);
      return { id: `obs-${name}-${n}`, recorded_at: AT, observed_at: AT, basis: 'observed', source: { kind: 'client', tool: 'api_request:http' }, verification: 'client-observation', outcome: 'success', complete: true, evidence: [{ path, digest: sha(bytes) }], notes: ['HTTP response status 200.'], omissions: [], response_status: 200, attempts: 1, request_shape: contextShape({}).shape, response_shape: contextShape({ id: RAW }).shape };
    });
    writeFileSync(fixtureContextFile(root, name), JSON.stringify({ v: 0, generated_at: AT, api: { name: `${name} API`, contract: `${LAYOUT.collection}/${name}/${name}.json` }, operations: { 'GET /users': { verified_at: null, fields: {}, notes: [`Only ${name} guidance.`, SECRET], notes_provenance: [{ by: 'agent', at: '2026-10-07' }, { by: 'agent', at: '2026-10-07' }], notes_superseded: [null, null] } }, api_context: { v: 1, operations: { [operationId(identity)]: { identity, observations, omitted_observations: 0 } } } }));
  }
  writeFileSync(join(root, LAYOUT.directory, 'defaults.json'), JSON.stringify({ default_stack: 'beta' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_') && !key.startsWith('SANNR_')));
  env[HOME_ENV_NAME] = join(root, '.state'); env.API_USAGE_LOG = join(root, '.usage.jsonl');
  return { root, env };
}
function cleanPage(html) {
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /<script|<iframe|<object|<embed|\bsrc\s*=|\bon[a-z]+\s*=/i);
  for (const value of [SECRET, RAW]) assert.ok(!html.includes(value), value);
  assert.equal((html.match(/class="stack-viewport"/g) ?? []).length, 2);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'independent viewport element identities');
  for (const name of ['alpha', 'beta']) assert.match(html, new RegExp(`data-stack="${name}"`));
}

test('STACKS-2(d): map/view index counts agree with each scoped show; no private values or scripts in either viewport', t => {
  const { root, env } = fixture(t);
  const map = buildApiMapModel(root, { now: Date.parse(AT), env });
  assert.equal(map.kind, 'stack-api-map');
  assert.deepEqual(map.stack_index.map(row => row.name), ['beta', 'alpha']);
  assert.equal(map.stacks.length, 2);
  for (const row of map.stack_index) {
    const shown = spawnSync(process.execPath, [join(ROOT, 'bin/cli.mjs'), 'show', '--stack', row.name, 'GET /users', '--json'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    const show = JSON.parse(shown.stdout), model = map.stacks.find(stack => stack.name === row.name).api_map;
    assert.equal(row.operations, 1);
    assert.equal(row.responses, show.observation_summary.observation_count);
    assert.equal(row.observed, show.confidence === 'observed' ? 1 : 0);
    assert.equal(row.notes, show.note_history.active.length);
    assert.ok(model.notes.some(note => note.text === `Only ${row.name} guidance.`));
    assert.ok(!JSON.stringify(model).includes(`Only ${row.name === 'alpha' ? 'beta' : 'alpha'} guidance.`));
    assert.equal(model.withheld.note, 1);
  }
  const footprint = footprintModel({ root, surfaces: [], edges: [], external: [], platform: [] });
  const mapHtml = renderMapHtml(footprint, { apiMap: map });
  cleanPage(mapHtml);
  const view = buildViewModel(root, { generatedAt: AT, env }), viewHtml = renderViewHtml(view);
  cleanPage(viewHtml);
  assert.deepEqual(view.api_map.stack_index, map.stack_index);
  for (const html of [mapHtml, viewHtml]) {
    assert.match(html, /Stack index/);
    for (const viewport of html.split('class="stack-viewport"').slice(1)) assert.match(viewport.split('</section>')[0], /Withheld by the secret and promotion scans: 1 note/);
    assert.match(html, /&lt;script&gt;alert&#40;1\)&lt;\/script&gt;/);
  }
  for (const output of [JSON.stringify(apiMapSummary(map)), JSON.stringify(view)]) for (const value of [SECRET, RAW]) assert.ok(!output.includes(value));
});

test('STACKS-2(d): CLI map and view include both real stack viewports', t => {
  const { root, env } = fixture(t);
  for (const [command, args] of [['map', ['--no-execute', '--no-preview']], ['view', []]]) {
    const output = join(root, `${command}.html`);
    const result = spawnSync(process.execPath, [join(ROOT, 'bin/cli.mjs'), command, ...args, '--out', output], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    cleanPage(readFileSync(output, 'utf8'));
  }
});

test('STACKS-2(d): no default is needed for the index; unsorted never borrows another contract', t => {
  const { root, env } = fixture(t);
  rmSync(join(root, LAYOUT.directory, 'defaults.json'));
  const unsorted = join(root, LAYOUT.collection, 'unsorted');
  mkdirSync(unsorted);
  writeFileSync(join(unsorted, 'stack.json'), JSON.stringify({ v: 1, name: 'unsorted', environments: {} }));
  writeFileSync(join(unsorted, 'sannr.json'), JSON.stringify({ v: 0, api: { name: 'Unsorted' }, operations: { 'GET /loose': { notes: ['Waiting to be filed.'], notes_provenance: [{ by: 'human', at: '2026-10-07' }] } } }));
  // A conventional project contract must not become the holding stack's contract.
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Unrelated', version: '1' }, paths: { '/unrelated': { get: { responses: { 200: { description: 'OK' } } } } } }));
  const model = buildApiMapModel(root, { now: Date.parse(AT), env });
  assert.deepEqual(model.stack_index.map(row => row.name), ['alpha', 'beta', 'unsorted']);
  const loose = model.stacks.find(row => row.name === 'unsorted');
  assert.equal(loose.api_map.contract.state, 'not-named');
  assert.deepEqual(loose.api_map.operations.map(row => row.op), ['GET /loose']);
  assert.equal(loose.api_map.store.path, `${LAYOUT.collection}/unsorted/sannr.json`);
  const view = buildViewModel(root, { generatedAt: AT, env });
  assert.equal(view.stack_views.length, 3);
  assert.ok(renderViewHtml(view).includes('Waiting to be filed.'));
});

test('STACKS-2(d): each viewport uses its selected environment contract, not an older store header', t => {
  const { root, env } = fixture(t), folder = join(root, LAYOUT.collection, 'alpha');
  const config = JSON.parse(readFileSync(join(folder, 'stack.json')));
  config.environments.staging = { baseUrl: 'https://staging-alpha.example.test', contract: 'staging.json' };
  config.default_environment = 'staging';
  writeFileSync(join(folder, 'stack.json'), JSON.stringify(config));
  writeFileSync(join(folder, 'staging.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Staging', version: '2' }, paths: { '/staging': { get: { responses: { 200: { description: 'OK' } } } } } }));
  const map = buildApiMapModel(root, { now: Date.parse(AT), env });
  const alpha = map.stacks.find(row => row.name === 'alpha').api_map;
  assert.equal(alpha.contract.path, `${LAYOUT.collection}/alpha/staging.json`);
  assert.ok(alpha.operations.some(row => row.op === 'GET /staging' && row.in_contract));
  assert.equal(alpha.operations.find(row => row.op === 'GET /users').in_contract, false);
  const view = buildViewModel(root, { generatedAt: AT, env }).stack_views.find(row => row.name === 'alpha').model;
  assert.equal(view.contract, `${LAYOUT.collection}/alpha/staging.json`);
});

test('STACKS-2(d): a configured contract without a store still maps declarations, never fabricated observations', t => {
  const { root, env } = fixture(t);
  for (const name of ['alpha', 'beta']) rmSync(fixtureContextFile(root, name));
  for (const map of [buildApiMapModel(root, { now: Date.parse(AT), env }), buildViewModel(root, { generatedAt: AT, env }).api_map]) {
    assert.deepEqual(map.stack_index.map(row => row.contract_state), ['read', 'read']);
    assert.deepEqual(map.stack_index.map(row => row.operations), [1, 1]);
    for (const row of map.stacks) {
      assert.equal(row.api_map.store.state, 'missing');
      assert.equal(row.api_map.store_operations, 0);
      assert.equal(row.api_map.counts.contract_only, 1);
      assert.equal(row.api_map.counts.observed_total, 0);
      assert.equal(row.api_map.observations.counted, 0);
      assert.equal(row.api_map.operations[0].in_store, false);
      assert.equal(row.api_map.operations[0].standing.key, 'no-response');
      assert.equal(row.api_map.notes.length, 0);
    }
  }
  const view = buildViewModel(root, { generatedAt: AT, env });
  for (const row of view.stack_views) {
    assert.equal(row.model.contract_state, 'read');
    assert.match(row.model.contract, /\.json$/);
    // W1 adds navigable declaration cards without inventing an observation.
    assert.equal(row.model.operations.length, 1);
    const operation = row.model.operations[0];
    assert.equal(operation.standing.key, 'no-response');
    assert.equal(operation.responses, 0);
    assert.equal(operation.verified_at, null);
    assert.deepEqual(operation.notes, []);
    assert.match(operation.operation_anchor, /^operation-[a-f0-9]{64}$/);
  }
  assert.match(renderViewHtml(view), /contract operation not yet in the store/);
  for (const name of ['alpha', 'beta']) assert.throws(() => readFileSync(fixtureContextFile(root, name)), { code: 'ENOENT' });
});

test('STACKS-2(d): a named stack without a configured contract never borrows its saved sibling header', t => {
  const { root, env } = fixture(t), folder = join(root, LAYOUT.collection, 'alpha');
  const config = JSON.parse(readFileSync(join(folder, 'stack.json')));
  delete config.contract;
  writeFileSync(join(folder, 'stack.json'), JSON.stringify(config));
  const saved = JSON.parse(readFileSync(fixtureContextFile(root, 'alpha')));
  saved.api.contract = `${LAYOUT.collection}/beta/beta.json`;
  writeFileSync(fixtureContextFile(root, 'alpha'), JSON.stringify(saved));
  const siblingContract = join(root, LAYOUT.collection, 'beta', 'beta.json');
  const sibling = JSON.parse(readFileSync(siblingContract));
  sibling.paths['/borrowed'] = { get: { responses: { 200: { description: 'OK' } } } };
  writeFileSync(siblingContract, JSON.stringify(sibling));
  const map = buildApiMapModel(root, { now: Date.parse(AT), env });
  const alpha = map.stacks.find(row => row.name === 'alpha').api_map;
  assert.equal(alpha.contract.state, 'not-named');
  assert.equal(alpha.contract.path, null);
  assert.deepEqual(alpha.operations.map(row => row.op), ['GET /users']);
  assert.equal(alpha.operations[0].in_contract, false);
  assert.equal(alpha.scope.state, 'unresolved');
  const view = buildViewModel(root, { generatedAt: AT, env }).stack_views.find(row => row.name === 'alpha').model;
  assert.equal(view.contract, null);
  assert.equal(view.contract_state, null);
  assert.deepEqual(view.operations[0].declared, []);
  const shown = spawnSync(process.execPath, [join(ROOT, 'bin/cli.mjs'), 'show', '--stack', 'alpha', 'GET /users', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.equal(JSON.parse(shown.stdout).observation_summary.state, 'scope-unresolved');
});

test('STACKS-2(d): repo report withholding counts once while separate stack notes each count', t => {
  const { root, env } = fixture(t);
  writeFileSync(join(root, LAYOUT.baseline), JSON.stringify({ findings: [], generated_at: 'fixture-review@example.test' }));
  const view = buildViewModel(root, { generatedAt: AT, env });
  assert.equal(view.withheld['report-text'], 1);
  assert.equal(view.withheld.note, 2);
  const html = renderViewHtml(view);
  const header = html.match(/<p class="basis" id="withheld">([^<]+)<\/p>/)[1];
  assert.match(header, /2 notes/);
  assert.match(header, /1 saved report field or line/);
  assert.doesNotMatch(header, /2 saved report fields/);
  assert.ok(!html.includes('fixture-review@example.test'));
});
