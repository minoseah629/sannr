// Cold-release qualification caught connect writing a retired first store.
// Contracts and claims are synthetic; no API request is needed for this setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';
import { CONTEXT_BASENAME, HOME_ENV_NAME, MCP_SERVER_KEY, POINTER_BEGIN } from '../lib/brand.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
function fixture(t, { contract = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'connect-first-stack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  if (contract) write(join(root, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Setup Fixture API', version: '1' },
    paths: { '/health': { get: { responses: { 200: { description: 'Fixture response' } } } } } });
  return { root, env: { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'state'), NO_COLOR: '1', API_USAGE_LOG: '' } };
}
async function command(f, args) {
  const child = spawn(process.execPath, [join(ROOT, 'bin/cli.mjs'), ...args], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { exit, stdout, stderr };
}
const passed = result => { assert.equal(result.exit, 0, result.stdout + result.stderr); return JSON.parse(result.stdout); };

test('fresh connect discovers a contract into a named stack, reports every created file and accepts the first note', async t => {
  const f = fixture(t), folder = join(f.root, LAYOUT.collection, 'setup-fixture');
  const report = passed(await command(f, ['connect', '--json']));
  assert.equal(existsSync(join(f.root, LAYOUT.context)), false, 'a fresh connect must not manufacture a retired single-store installation');
  assert.equal(json(join(folder, 'stack.json')).name, 'setup-fixture');
  assert.ok(json(join(folder, CONTEXT_BASENAME)).operations['GET /health']);
  assert.equal(json(join(folder, CONTEXT_BASENAME)).operations['GET /health'].verified_at, null,
    'contract-derived inventory must not imply an executed verification');
  for (const file of ['stack.json', 'openapi.json', CONTEXT_BASENAME]) assert.ok(report.touched_files.some(row => row.path === `${LAYOUT.collection}/setup-fixture/${file}` && row.action === 'created'), file);
  const entry = json(join(f.root, '.mcp.json')).mcpServers[MCP_SERVER_KEY];
  for (const pin of ['API_CONFIG', 'API_CONTRACT', 'API_ENV']) assert.equal(pin in entry.env, false);
  const note = await command(f, ['note', 'GET /health', 'Synthetic readiness uses the health endpoint.']);
  assert.equal(note.exit, 0, note.stdout + note.stderr);
  assert.deepEqual(passed(await command(f, ['show', 'GET /health'])).notes, ['Synthetic readiness uses the health endpoint.']);
  const again = passed(await command(f, ['connect', '--json']));
  assert.ok(again.mcp.every(row => row.action === 'unchanged'));
});

test('fresh connect dry-run names the stack destinations and pointer conflict writes nothing', async t => {
  const f = fixture(t), before = readdirSync(f.root).sort();
  const report = passed(await command(f, ['connect', '--dry-run', '--json']));
  assert.deepEqual(readdirSync(f.root).sort(), before);
  for (const file of ['stack.json', 'openapi.json', CONTEXT_BASENAME]) assert.ok(report.planned_files.some(row => row.path === `${LAYOUT.collection}/setup-fixture/${file}`), file);
  assert.ok(!report.planned_files.some(row => row.path === LAYOUT.context));
  write(join(f.root, 'AGENTS.md'), `${POINTER_BEGIN}\nUnclosed project guidance.\n`);
  const blocked = await command(f, ['connect', '--json']);
  assert.notEqual(blocked.exit, 0);
  assert.equal(existsSync(join(f.root, LAYOUT.directory)), false);
  assert.equal(existsSync(join(f.root, '.mcp.json')), false);
});

test('connect leaves contractless setup empty and preserves existing single-store knowledge for explicit migration', async t => {
  const empty = fixture(t, { contract: false });
  passed(await command(empty, ['connect', '--json']));
  assert.equal(existsSync(join(empty.root, LAYOUT.context)), false);
  assert.ok(!readdirSync(join(empty.root, LAYOUT.collection)).includes('api'));
  const legacy = fixture(t), old = { v: 0, api: { name: 'Existing Fixture API', contract: 'openapi.json' }, operations: { 'GET /health': { notes: [], fields: {} } } };
  write(join(legacy.root, LAYOUT.context), old);
  passed(await command(legacy, ['connect', '--json']));
  assert.ok(existsSync(join(legacy.root, LAYOUT.context)));
  assert.equal(existsSync(join(legacy.root, LAYOUT.collection, 'setup-fixture', 'stack.json')), false);
});
