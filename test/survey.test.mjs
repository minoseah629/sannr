import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateSurvey, readSurvey, surveyStatus, querySurvey, registerSurveyRender } from '../lib/survey.mjs';
import { canonicalSurveyJson } from '../lib/survey-model.mjs';
import { operationId } from '../lib/operation-context.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';

const write = (root, path, value) => {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file;
};
const at = '2026-10-17T01:00:00.000Z';
const spec = (title, paths) => ({ openapi: '3.0.3', info: { title, version: '1' },
  paths: Object.fromEntries(paths.map(path => [path, { get: { responses: { 200: { description: 'ok' } } } }])) });
function fixture(t, { git = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'survey-')), root = join(parent, 'repo'), home = join(parent, 'home');
  mkdirSync(root); mkdirSync(home);
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state');
  t.after(() => { for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true }); });
  write(root, 'service/openapi.json', spec('Inventory', ['/items', '/items/{id}']));
  write(root, 'service/routes.mjs', 'app.get("/items", list);\napp.get("/items/:id", get);\n');
  write(root, 'contracts/orders.json', spec('Orders', ['/orders']));
  createFixtureStack(root, { name: 'inventory', environment: 'test', baseUrl: 'https://inventory.example.test/v1', contract: 'service/openapi.json' });
  createFixtureStack(root, { name: 'orders', environment: 'test', baseUrl: 'https://orders.example.test', contract: 'contracts/orders.json' });
  write(root, 'src/client.mjs', 'const BASE = "https://inventory.example.test/v1";\nconst SECOND = "https://inventory.example.test/v1";\nconst THIRD = "https://inventory.example.test/v1";\nfetch(`${BASE}/items`);\n');
  const identity = { stack: 'inventory', protocol: 'http', provider: 'https://inventory.example.test/v1', environment: 'test', operation: 'GET /items/{id}' };
  const context = { v: 0, api: { name: 'Inventory' }, operations: {}, api_context: { v: 1, operations: {
    [operationId(identity)]: { identity, observations: [], omitted_observations: 0, key_sources: [{ param: 'id', location: 'path',
      source: { operation: 'GET /items', field: 'data[].id' }, first_observed_at: at, last_observed_at: at,
      also_seen: 1, evidence: { run_id: 'run-source', digest: `sha256:${'a'.repeat(64)}` } }] },
  } } };
  writeFileSync(fixtureContextFile(root, 'inventory'), JSON.stringify(context));
  write(root, `${LAYOUT.suites}/flow.json`, { stack: 'inventory', environment: 'test', requests: [
    { method: 'GET', path: '/items', capture: { item: 'data.0.id' } },
    { method: 'GET', path: '/items/{item}' },
  ] });
  if (git) {
    const run = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    run(['init', '-q']); run(['add', '.']);
    run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  }
  return { root, parent, context };
}

test('generation retains conservative code and supplies evidence, preserving unchanged and failed snapshots', t => {
  const { root } = fixture(t), secret = `sk_live_${'x'.repeat(32)}`;
  write(root, `src/${secret}.mjs`, 'export const privateValue = 1;');
  const result = generateSurvey(root, { now: at });
  assert.ok(!JSON.stringify(result).includes(secret), 'diagnostics share the portable withholding boundary');
  assert.equal(result.state, 'generated');
  const model = result.snapshot, calls = model.relationships.filter(edge => edge.kind === 'calls');
  assert.equal(calls.length, 1, 'three URL bindings do not become three calls');
  assert.equal(model.relationships.filter(edge => edge.kind === 'defines').length, 2);
  const host = model.nodes.find(node => node.kind === 'host' && node.host.includes('inventory.example.test'));
  assert.ok(host.references.length >= 3, 'all detected host-reference locations remain');
  const flow = model.relationships.find(edge => edge.kind === 'supplies');
  assert.equal(flow.declarations.length, 1);
  assert.equal(flow.observations.length, 1);
  assert.equal(flow.observations[0].proof.state, 'unavailable');
  assert.ok(model.relationships.every(edge => edge.kind !== 'imports'));
  const bytes = readFileSync(result.path, 'utf8'), before = statSync(result.path).mtimeMs;
  const again = generateSurvey(root, { now: '2026-10-18T01:00:00.000Z' });
  assert.equal(again.state, 'unchanged'); assert.equal(readFileSync(result.path, 'utf8'), bytes);
  assert.equal(statSync(result.path).mtimeMs, before);
  write(root, `${LAYOUT.collection}/inventory/stack.json`, '{broken');
  assert.throws(() => generateSurvey(root), error => /^SURVEY_/.test(error.code));
  assert.equal(readFileSync(result.path, 'utf8'), bytes, 'failed generation preserves valid historical artifact');
});

test('explicit status inventories new, edited, renamed and deleted inputs and separates observation changes', t => {
  const { root, context } = fixture(t), generated = generateSurvey(root, { now: at });
  const original = readFileSync(generated.path, 'utf8');
  assert.equal(surveyStatus(root).source.state, 'current');
  const rendered = write(root, 'survey-render.json', canonicalSurveyJson(generated.snapshot));
  registerSurveyRender(root, { out: rendered, format: 'json' });
  assert.equal(surveyStatus(root).source.state, 'current', 'a registered JSON projection cannot become a new discovery input');
  assert.equal(generateSurvey(root).state, 'unchanged');
  for (const mutate of [
    () => write(root, 'src/plain.mjs', 'export const noApi = 1;'),
    () => write(root, 'src/plain.mjs', 'export const noApi = 2;'),
    () => renameSync(join(root, 'src/plain.mjs'), join(root, 'src/renamed.mjs')),
    () => rmSync(join(root, 'src/renamed.mjs')),
  ]) {
    mutate(); assert.equal(surveyStatus(root).source.state, 'stale');
    generateSurvey(root);
  }
  const configPath = `${LAYOUT.collection}/inventory/stack.json`, config = JSON.parse(readFileSync(join(root, configPath)));
  config.environments.test.baseUrl = 'https://inventory.example.test/v2'; write(root, configPath, config);
  assert.equal(surveyStatus(root).source.state, 'stale'); generateSurvey(root);
  const entry = Object.values(context.api_context.operations)[0]; entry.key_sources[0].also_seen++;
  writeFileSync(fixtureContextFile(root, 'inventory'), JSON.stringify(context));
  const changed = surveyStatus(root);
  assert.equal(changed.observations.state, 'stale');
  const saved = readFileSync(generated.path, 'utf8');
  surveyStatus(root); assert.equal(readFileSync(generated.path, 'utf8'), saved, 'status does not regenerate');
  assert.notEqual(saved, original);
  const query = querySurvey(root, { stack: 'inventory', operation: 'GET /items', maxBytes: 1024 });
  assert.equal(query.state, 'ready'); assert.ok(Buffer.byteLength(JSON.stringify(query)) <= 1024);
  assert.ok(query.omitted.nodes + query.omitted.relationships > 0);
});

test('absent, invalid and private-baseline-free snapshots stay bounded and never silently scan or rewrite', t => {
  const { root } = fixture(t, { git: false });
  assert.equal(readSurvey(root).state, 'not-generated');
  assert.equal(querySurvey(root, { operation: 'GET /items' }).state, 'not-generated');
  const generated = generateSurvey(root, { now: at });
  const status = surveyStatus(root);
  assert.equal(status.base_commit.state, 'unavailable');
  assert.equal(status.observations.state, 'unknown', 'absent private proof is not silently current');
  rmSync(join(root, LAYOUT.evidence, 'survey'), { recursive: true });
  const withoutPrivate = surveyStatus(root);
  assert.equal(withoutPrivate.source.state, 'unknown');
  assert.equal(readSurvey(root).state, 'ready', 'a portable snapshot is readable without private state');
  writeFileSync(generated.path, '{invalid');
  const invalid = readSurvey(root);
  assert.equal(invalid.state, 'invalid'); assert.ok(JSON.stringify(invalid).length < 2048);
  assert.equal(querySurvey(root).state, 'invalid');
  assert.equal(readFileSync(generated.path, 'utf8'), '{invalid');
});

test('credential files are excluded before reads and their unavailable scope is explicit', t => {
  const { root } = fixture(t);
  const configPath = `${LAYOUT.collection}/inventory/stack.json`, config = JSON.parse(readFileSync(join(root, configPath)));
  config.environments.test.envFile = '../../../credentials.json'; write(root, configPath, config);
  write(root, 'credentials.json', '{"token":"private-credential-fixture"}');
  write(root, 'nested/.env', 'TOKEN=private-environment-fixture\n');
  const result = generateSurvey(root, { excludeEnv: true });
  assert.ok(!result.snapshot.source.inventory.some(row => ['credentials.json', 'nested/.env'].includes(row.file)));
  assert.ok(result.snapshot.coverage.omissions.some(row => row.reason === 'environment-excluded'));
  assert.ok(result.snapshot.coverage.omissions.some(row => row.reason === 'credential-file-excluded'));
  assert.equal(surveyStatus(root).source.state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /private-credential-fixture|private-environment-fixture/);
});

test('coverage counts unique files when readers use different byte limits and retains partial-read omissions', t => {
  const { root } = fixture(t);
  const contract = spec('Independent source contract', ['/other']);
  write(root, 'independent/openapi.json', contract);
  const first = generateSurvey(root, { now: at }).snapshot;
  const readFiles = new Set(first.source.inventory.filter(row => row.kind === 'source' && row.state === 'read').map(row => row.file));
  assert.ok(readFiles.has('independent/openapi.json'));
  assert.equal(first.coverage.scanned_files, readFiles.size,
    'one source contract read by the contract and source readers is still one scanned file');
  assert.equal(first.coverage.skipped_files, 0);
  contract.info.description = 'padding '.repeat(60_000);
  write(root, 'independent/openapi.json', contract);
  const larger = generateSurvey(root, { now: '2026-10-18T01:00:00.000Z' }).snapshot;
  assert.equal(larger.coverage.scanned_files, readFiles.size,
    'the larger contract is readable under the contract-reader bound, counted only once');
  assert.equal(larger.coverage.oversized_files, 1);
  assert.equal(larger.coverage.skipped_files, 1,
    'the same file was omitted by the smaller source-reader bound; dimensions may overlap');
  assert.equal(larger.coverage.unreadable_files, 0);
  assert.equal(larger.coverage.truncated, true);
  assert.equal(surveyStatus(root).source.state, 'unknown', 'partial source inspection is not clean freshness');
});
