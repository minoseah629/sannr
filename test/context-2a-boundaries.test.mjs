// Independent stack-fact boundary specimens; all data is synthetic and local.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { recordGraphContext, graphRecordTool, graphRecordFailure } from '../lib/graph-record.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME, FEEDBACK_STACK_NAME } from '../lib/brand.mjs';

const privateText = 'ghp_fixturecredential012345678901234567890';
const privatePath = '/' + 'Users/fixture/private-source.json';
const source = fileURLToPath(new URL('../', import.meta.url));
function fixture(t, { snapshot } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture Author'], { cwd: root });
  createFixtureStack(root, { name: 'fixture', baseUrl: 'https://example.test' });
  writeFileSync(fixtureContextFile(root), JSON.stringify({ v: 0, api: { name: 'fixture' }, operations: {} }));
  mkdirSync(join(root, LAYOUT.graphManifest, '..'), { recursive: true });
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1, repository: { id: 'fixture/repo', name: 'Fixture' }, nodes: [], dependencies: [],
    ...(snapshot ? { context: { snapshot } } : {}) }));
  const record = extra => recordGraphContext(root, { scope: 'stack', stack: 'fixture', note: 'Documented: inspect the error code.', ...extra });
  return { root, record };
}
function safeError(error) {
  const result = graphRecordFailure(error), output = JSON.stringify(result);
  assert.ok(!output.includes(privateText), 'refusal echoed a stored credential');
  assert.ok(!output.includes(privatePath), 'refusal echoed a private workstation path');
  assert.equal(result.requests_executed, 0); assert.equal(result.published, false);
  return result;
}
test('CONTEXT-2a boundary: refusal never echoes a hand-edited stack fact or arbitrary NOTE error', t => {
  const f = fixture(t); f.record();
  const file = fixtureContextFile(f.root), ctx = JSON.parse(readFileSync(file));
  ctx.stack_facts.notes[0] = `Token: ${privateText}; source ${privatePath}`;
  writeFileSync(file, JSON.stringify(ctx));
  let failure; try { f.record({ note: 'A safe new lesson.', alongside: true }); } catch (error) { failure = error; }
  assert.equal(failure?.code, 'NOTE_HISTORY_CHANGED'); safeError(failure);
  const unknown = safeError({ code: 'NOTE_' + privateText, message: privatePath, existing: [{ text: privateText }] });
  assert.equal(unknown.error.code, 'GRAPH_RECORD_FAILED');
});
test('CONTEXT-2a boundary: stack record refuses verification fields, secrets and built-in writes', t => {
  const f = fixture(t), original = readFileSync(fixtureContextFile(f.root), 'utf8');
  for (const fields of [{ verified: true }, { observations: [] }, { source: 'client' }, { note: privateText }, { note: privatePath }]) {
    assert.throws(() => f.record(fields));
  }
  assert.throws(() => f.record({ stack: FEEDBACK_STACK_NAME }));
  assert.equal(readFileSync(fixtureContextFile(f.root), 'utf8'), original);
});
test('CONTEXT-2a boundary: stack recording discloses unsupported graph export and preserves configured snapshot', t => {
  const f = fixture(t, { snapshot: 'share/context.json' });
  mkdirSync(join(f.root, 'share')); writeFileSync(join(f.root, 'share/context.json'), 'previous snapshot bytes');
  const result = f.record();
  assert.equal(readFileSync(join(f.root, 'share/context.json'), 'utf8'), 'previous snapshot bytes');
  assert.equal(result.snapshot, undefined); assert.equal(result.published, false);
  assert.match(result.next, /snapshots do not yet carry stack facts/);
});
test('CONTEXT-2a boundary: absent graph and read-only MCP bindings never expose or execute stack recording', async t => {
  const f = fixture(t), request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_context_record', arguments: { scope: 'stack', stack: 'fixture', note: 'Documented: a safe lesson.' } } };
  for (const readOnly of [true, false]) {
    if (!readOnly) rmSync(join(f.root, LAYOUT.graphManifest));
    if (!readOnly) assert.equal(graphRecordTool(f.root), null);
    const child = spawn(process.execPath, [join(source, 'server.mjs')], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root,
      [HOME_ENV_NAME]: join(f.root, 'machine'), API_CONTEXT_DIR: f.root, API_REQUEST_READ_ONLY: readOnly ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n' + JSON.stringify(request) + '\n');
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr);
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(!messages.find(message => message.id === 1).result.tools.some(tool => tool.name === 'api_context_record'));
    assert.ok(messages.find(message => message.id === 2).error);
    assert.equal(JSON.parse(readFileSync(fixtureContextFile(f.root))).stack_facts, undefined);
  }
  assert.equal(existsSync(join(f.root, 'share/context.json')), false);
});
