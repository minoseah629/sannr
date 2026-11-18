import './helpers/isolated-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { SKILL_SOURCES, renderSkill } from '../lib/connect.mjs';
import { atomicRenameSync } from '../lib/atomic-rename.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';
import { MCP_SERVER_KEY, FEEDBACK_STACK_NAME } from '../lib/brand.mjs';
import { advertisementPlan } from '../lib/advertisement.mjs';
import { resolveStack } from '../lib/stacks.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';
import { loadContext, saveContext } from '../lib/context.mjs';
import { setupBindingId } from '../lib/setup-binding.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const exec = promisify(execFile);

test('packaged knowledge stays readable when its native scope is on another drive', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'native-builtin-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const sourceDrive = CLI[0].toUpperCase();
  const root = process.platform === 'win32' ? `${sourceDrive === 'Z' ? 'Y' : 'Z'}:/native-readonly-scope` : temporary;
  const scope = resolveStack(root, { stack: FEEDBACK_STACK_NAME });
  withStackScope(scope, () => {
    const context = loadContext(root);
    assert.ok(context?.operations['POST /feedback'].notes.length >= 4);
    assert.throws(() => saveContext(root, { operations: {} }), { code: 'STACK_READ_ONLY' });
  });
});

test('setup bindings survive another filesystem spelling of the same checkout', async t => {
  const base = mkdtempSync(join(tmpdir(), 'native-root-alias-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'real'), alias = join(base, 'alias');
  mkdirSync(root);
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const entry = { command: process.execPath, args: [fileURLToPath(new URL('../server.mjs', import.meta.url))], env: { API_CONTEXT_DIR: root } };
  assert.equal(setupBindingId(root, entry), setupBindingId(alias, entry));
  if (process.platform === 'win32') {
    const { stdout } = await exec('cmd.exe', ['/d', '/c', 'for %I in ("%NATIVE_TEST_ROOT%") do @echo "%~sI"'],
      { env: { ...process.env, NATIVE_TEST_ROOT: root }, windowsVerbatimArguments: true });
    const shortRoot = stdout.trim().slice(1, -1);
    assert.ok(shortRoot);
    assert.equal(setupBindingId(root, entry), setupBindingId(shortRoot, entry));
  }
});

test('CRLF skill sources render the same complete commands and documentation as LF sources', t => {
  const root = mkdtempSync(join(tmpdir(), 'native skill paths '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, source] of SKILL_SOURCES.entries()) {
    const path = join(root, `skill-${index}.md`);
    const lf = readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(path, lf);
    const plain = [renderSkill(path, null), renderSkill(path, './node_modules/.bin/tool')];
    writeFileSync(path, lf.replace(/\n/g, '\r\n'));
    assert.deepEqual([renderSkill(path, null), renderSkill(path, './node_modules/.bin/tool')], plain);
    assert.doesNotMatch(plain.join('\n'), /\{\{[A-Z_]+\}\}/);
  }
});

test('Windows atomic replacement retries sharing violations without a partial overwrite', () => {
  let calls = 0;
  const waits = [];
  atomicRenameSync('new', 'old', { platform: 'win32', wait: ms => waits.push(ms), rename: () => {
    if (++calls < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
  } });
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  for (const platform of ['win32', 'linux']) {
    const error = Object.assign(new Error('full disk'), { code: 'ENOSPC' });
    assert.throws(() => atomicRenameSync('new', 'old', { platform, wait: () => assert.fail('not transient'), rename: () => { throw error; } }), error);
  }
  let attempts = 0;
  assert.throws(() => atomicRenameSync('new', 'old', { platform: 'win32', wait: () => {}, rename: () => {
    attempts++; throw Object.assign(new Error('denied'), { code: 'EACCES' });
  } }), { code: 'EACCES' });
  assert.equal(attempts, 41);
});

test('native paths with spaces support setup, checked requests, fresh-process memory and MCP from another cwd', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'native project with spaces '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const server = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ready":true}'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const env = { ...process.env, SANNR_HOME: join(root, 'state'), API_USAGE_LOG: '', API_CONTEXT_DIR: root };
  const cli = async args => JSON.parse((await exec(process.execPath, [CLI, ...args], { cwd: root, env })).stdout);
  if (process.platform === 'win32') {
    const command = advertisementPlan(root).local.command;
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${command} --version`], { cwd: root, env });
    assert.match(result.stdout, /\d+\.\d+\.\d+/);
  }
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'native fixture', version: '1' },
    paths: { '/health': { get: { responses: { 200: { description: 'Ready', content: { 'application/json': {
      schema: { type: 'object', properties: { ready: { type: 'boolean' } } },
    } } } } } } } }));
  createFixtureStack(root, { baseUrl: `http://127.0.0.1:${server.address().port}`, contract: 'openapi.json' });
  await cli(['init']);
  await cli(['connect', '--json']);
  const doctor = await cli(['doctor', '--offline', '--json']);
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  const request = await cli(['request', 'GET', '/health', '--expect-status', '200']);
  assert.equal(request.status, 200);
  await cli(['note', 'GET /health', 'The local fixture returns a readiness flag.']);
  const shown = await cli(['show', 'GET /health', '--json']);
  assert.match(JSON.stringify(shown), /local fixture returns a readiness flag/);
  const entry = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers[MCP_SERVER_KEY];
  // The host's cwd is deliberately unrelated. All authority comes from the
  // generated entry; credentials and the installer's PATH are not copied.
  const reply = await new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { cwd: tmpdir(), env: { ...env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP startup timed out')); }, 10000);
    let pending = '', stderr = '';
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); if (code && code !== 0) reject(new Error(stderr)); });
    child.stdout.on('data', bytes => {
      pending += bytes;
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === 2) { clearTimeout(timer); child.kill(); resolve(message); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'native-test', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
  const requestTool = reply.result.tools.find(tool => tool.name === 'api_request');
  assert.ok(requestTool);
  assert.ok(requestTool.description.includes(entry.env.API_SETUP_BINDING));
});
