// USE-1 with OPEN-1: usage counts where the one-step Workbench launch meets
// them. The background Workbench process (`workbench serve`) is started by
// `workbench open` and the api_workbench tool, detached, with its output
// discarded: it must never show or record the one-time notice, count its own
// start or start a send. `workbench` counts launches only.
//
// Run through real child processes of a copied package that counts as
// installed (a source tree never counts), with an isolated HOME and state
// directory, a stand-in for the system opener on PATH and a preload that
// blocks every non-loopback fetch before the wire.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HOME_ENV_NAME, TELEMETRY_ENV_NAME, TOOL_NAME } from '../lib/brand.mjs';
import { backgroundProcess, cliFeature, cliFeatureNames } from '../lib/telemetry.mjs';
import { liveWorkbenchService, stopWorkbenchService } from '../lib/workbench-launch.mjs';
import { SAVED_REQUEST_TOOL } from '../lib/saved-request-actions.mjs';
import { WORKBENCH_AGENT_TOOL } from '../lib/workbench-agent-tools.mjs';
import { NOTE_REVIEW_TOOL, NOTE_RETIRE_TOOL, NOTE_CONTEXT_TOOL } from '../lib/note-review-actions.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { browserLog, installTestBrowser, pageAction } from './fixtures/workbench-browser.mjs';

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const NOTICE = /telemetry: once a day .* sends usage counts/;
const noStandIn = process.platform === 'win32' ? 'the Windows opener cannot be replaced by a test stand-in' : false;

// One copy of the package per file: no .git, no test runner, no test suite,
// so it counts as an installed package.
let packageCopy = null;
function installedPackage() {
  if (packageCopy) return packageCopy;
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-usage-package-')));
  process.on('exit', () => { try { rmSync(parent, { recursive: true, force: true }); } catch { /* best effort */ } });
  const copy = join(parent, 'package');
  for (const entry of ['bin', 'lib', 'skill', 'stacks', 'server.mjs', 'package.json', 'docs'])
    cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), 'dir');
  for (const marker of ['.git', 'scripts/test-unit.mjs', 'test/telemetry.test.mjs']) assert.equal(existsSync(join(copy, marker)), false);
  packageCopy = { cli: join(copy, 'bin', 'cli.mjs') };
  return packageCopy;
}

function child(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${args.slice(1, 4).join(' ')} timed out`)); }, 40_000);
    proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** One isolated machine with a configured checkout, counting on (no off switch named). */
async function machine(t) {
  const { cli: CLI } = installedPackage();
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-usage-'))), seen = [];
  const api = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise(done => api.listen(0, '127.0.0.1', done));
  const home = join(base, 'home'), state = join(base, 'machine'), root = join(base, 'checkout'), calls = join(base, 'calls.jsonl');
  mkdirSync(home, { recursive: true }); mkdirSync(root, { recursive: true });
  const preload = join(base, 'preload.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
const actual = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url instanceof Request ? url.url : url);
  if (new URL(href).hostname === '127.0.0.1') return actual(url, init);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: href, argv: process.argv.slice(2) }) + '\\n');
  throw new Error('blocked by the test harness');
};
`);
  const log = join(base, 'browser.jsonl');
  // The off switches are named here, empty, so the test helper leaves them
  // unset in these children on purpose: this file turns counting on.
  const env = { PATH: `${installTestBrowser(join(base, 'bin'))}${delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home,
    [HOME_ENV_NAME]: state, [TELEMETRY_ENV_NAME]: '', DO_NOT_TRACK: '', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    API_USAGE_LOG: join(state, 'usage.jsonl'), API_FRICTION_OFF: '1', NO_COLOR: '1', DISPLAY: ':0',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    WORKBENCH_TEST_BROWSER: 'connect', WORKBENCH_TEST_BROWSER_LOG: log };
  const cli = (args, extra = {}) => child(process.execPath, [CLI, ...args], { cwd: root, env: { ...env, ...extra } });
  assert.equal((await child('git', ['init', '--quiet'], { cwd: root, env })).code, 0);
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'fixture', version: '1' },
    paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } }));
  createFixtureStack(root, { contract: 'openapi.json', baseUrl: `http://127.0.0.1:${api.address().port}` });
  writeFileSync(fixtureContextFile(root, 'fixture'), JSON.stringify({ v: 0, api: { name: 'fixture API' }, operations: {} }));
  t.after(async () => {
    // Stop the service a test started, whatever state the test ended in.
    await cli(['workbench', 'stop', '--project', root]).catch(() => {});
    await new Promise(done => api.close(done));
    rmSync(base, { recursive: true, force: true });
  });
  const lines = () => { try { return readFileSync(join(state, 'telemetry', 'counts.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return {
    base, root, state, env, seen, cli, CLI,
    stateFile: join(state, 'telemetry.json'),
    record: () => { try { return readFileSync(join(state, 'telemetry.json'), 'utf8'); } catch { return null; } },
    features: name => lines().filter(row => row.f === name).length,
    apiCalls: () => lines().filter(row => row.a === 1).length,
    lines,
    blocked: () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : [],
    launches: () => browserLog(log),
  };
}

/** Whether the checkout's service is running, asked through the CLI's status command. */
async function serviceState(m) {
  const run = await m.cli(['workbench', 'status', '--json']);
  return JSON.parse(run.stdout).state;
}

function mcp(t, m) {
  const proc = spawn(process.execPath, [m.CLI, 'mcp', 'serve'], { cwd: m.root, env: { ...m.env, API_CONTEXT_DIR: m.root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => proc.once('close', resolve));
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; } });
  const replies = new Map(), waiters = new Map();
  let buffer = '';
  proc.stdout.on('data', chunk => {
    buffer += chunk;
    const parts = buffer.split('\n'); buffer = parts.pop();
    for (const part of parts) if (part.trim()) { const msg = JSON.parse(part); replies.set(msg.id, msg); waiters.get(msg.id)?.(); }
  });
  const call = (id, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`MCP reply ${id} did not arrive within 40 s`)); }, 40_000);
    waiters.set(id, () => { clearTimeout(timer); resolve(replies.get(id)); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
  });
  const close = async () => {
    proc.stdin.end();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
    await exited; clearTimeout(timer);
  };
  const notify = method => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { call, notify, close };
}
const workbenchCall = args => ({ method: 'tools/call', params: { name: WORKBENCH_AGENT_TOOL.name, arguments: args } });

/** A request the page's Request view executes through the running service. */
async function requestThroughService(m) {
  const launched = m.launches().at(-1);
  assert.ok(launched?.token, 'the stand-in page connected');
  const document = { kind: 'saved-request', origin: 'saved-request-document', format_version: 1, folder: 'usage', name: 'health',
    stack: 'fixture', environment: 'local', request: { method: 'GET', path: '/health', bindings: {} }, inputs: {}, credentials: [] };
  const before = m.seen.length;
  const reply = await pageAction(launched.origin, launched.token, 'saved', { action: 'run', document });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  assert.equal(m.seen.length, before + 1, 'the request reached the loopback API once');
}

// --- T1 -------------------------------------------------------------------------
test('T1: on a fresh machine the MCP server\'s first call, api_workbench open, carries the notice; the service records none and counts nothing', { skip: noStandIn }, async t => {
  const m = await machine(t);
  const server = mcp(t, m);
  await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  server.notify('notifications/initialized');
  const first = await server.call(2, workbenchCall({ action: 'open' }));
  assert.equal(first.result?.isError ?? false, false, JSON.stringify(first));
  const blocks = first.result.content.map(block => block.text);
  assert.match(blocks.at(-1), NOTICE, 'the notice is the last text block of the first tool result');
  assert.equal(blocks.filter(text => NOTICE.test(text)).length, 1);
  assert.equal(JSON.parse(blocks[0]).ok, true, blocks[0]);
  const noticed = JSON.parse(m.record()).noticed_at;
  assert.ok(noticed, 'the notice was recorded as given');
  const second = await server.call(3, workbenchCall({ action: 'status' }));
  assert.ok(!second.result.content.some(block => NOTICE.test(block.text)), 'a later result repeated the notice');
  assert.equal(JSON.parse(m.record()).noticed_at, noticed);
  assert.ok(m.features('mcp_api_workbench') >= 1, 'counts.jsonl holds mcp_api_workbench');
  assert.equal(m.features('workbench'), 0, 'the background service counted workbench');
  await server.call(4, workbenchCall({ action: 'stop' }));
  await server.close();
  assert.deepEqual(m.blocked(), []);
});

// --- T2 -------------------------------------------------------------------------
test('T2: on a fresh machine `workbench open --json` writes the notice once on stderr; stdout is the usual result; the service adds nothing', { skip: noStandIn }, async t => {
  const m = await machine(t);
  const open = await m.cli(['workbench', 'open', '--json']);
  assert.equal(open.code, 0, open.stderr);
  assert.equal(open.stderr.match(/telemetry:/g)?.length, 1, open.stderr);
  assert.match(open.stderr, NOTICE);
  const value = JSON.parse(open.stdout);
  assert.equal(value.ok, true); assert.equal(value.instance.state, 'created'); assert.equal(value.page.state, 'connected');
  const record = m.record();
  assert.ok(JSON.parse(record).noticed_at);
  assert.equal(await serviceState(m), 'running', 'the service is left running');
  await delay(300);
  assert.equal(m.record(), record, 'the service rewrote the notice record');
  assert.equal(m.features('workbench'), 1, 'one open counted workbench more than once');
  assert.equal(m.lines().filter(row => row.f).length, 1, `only the open was counted: ${JSON.stringify(m.lines())}`);
  assert.deepEqual(m.blocked(), []);
});

// --- T3 -------------------------------------------------------------------------
test('T3: on a machine already told, each open counts one workbench; status and stop count none', { skip: noStandIn }, async t => {
  const m = await machine(t);
  assert.match((await m.cli(['--version'])).stderr, NOTICE);
  assert.equal(m.features('workbench'), 0);
  const open = await m.cli(['workbench', 'open', '--json']);
  assert.equal(open.code, 0, open.stderr);
  assert.doesNotMatch(open.stderr, NOTICE);
  assert.equal(m.features('workbench'), 1, 'one open added more or less than one workbench');
  assert.equal((await m.cli(['workbench', 'status', '--json'])).code, 0);
  assert.equal(m.features('workbench'), 1, 'status was counted');
  const again = await m.cli(['workbench', 'open', '--json']);
  assert.equal(JSON.parse(again.stdout).instance.state, 'reused');
  assert.equal(m.features('workbench'), 2, 'a reusing open added more or less than one workbench');
  const stop = await m.cli(['workbench', 'stop', '--json']);
  assert.equal(JSON.parse(stop.stdout).state, 'stopped');
  assert.equal(m.features('workbench'), 2, 'stop was counted');
  assert.deepEqual(m.blocked(), []);
});

test('T3: on a machine not yet told, status prints the notice on stderr and counts nothing', { skip: noStandIn }, async t => {
  const m = await machine(t);
  const status = await m.cli(['workbench', 'status', '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stderr, NOTICE);
  assert.equal(JSON.parse(status.stdout).state, 'not-running');
  assert.ok(JSON.parse(m.record()).noticed_at);
  assert.deepEqual(m.lines(), []);
});

// --- T4 -------------------------------------------------------------------------
test('T4: workbench counts launches only; serve, status and stop have no feature; the tables still produce exactly the fixed list', () => {
  const expected = [
    [['workbench'], 'workbench'], [['workbench', 'open'], 'workbench'], [['workbench', 'open', '--project', 'x'], 'workbench'],
    [['workbench', '--no-open'], 'workbench'], [['workbench', '--session', 'status'], 'workbench'],
    [['workbench', 'serve', '--project', 'x'], null], [['workbench', 'status'], null], [['workbench', 'status', '--json'], null],
    [['workbench', 'stop'], null], [['workbench', 'stop', '--project', 'x'], null], [['workbench', '--help'], 'help'],
    [['workbench', 'serve', '--help'], 'help'], [['workbench', 'serve', '-h'], 'help'], [['workbench', 'serve', '--project', 'x', '--help'], 'help'],
  ];
  for (const [argv, feature] of expected) assert.equal(cliFeature(argv), feature, argv.join(' '));
  // Help for serve is read by a person: it is not the background process.
  assert.equal(backgroundProcess(['workbench', 'serve', '--project', 'x']), true);
  for (const argv of [['workbench', 'serve', '--help'], ['workbench', 'serve', '-h'], ['workbench', 'serve', '--project', 'x', '--help'], ['workbench', 'open']])
    assert.equal(backgroundProcess(argv), false, argv.join(' '));
  const names = JSON.parse(readFileSync(join(ROOT, 'lib/usage-features.json'), 'utf8'));
  const mcpNames = [TOOL_NAME, SAVED_REQUEST_TOOL.name, WORKBENCH_AGENT_TOOL.name, NOTE_REVIEW_TOOL.name, NOTE_RETIRE_TOOL.name,
    NOTE_CONTEXT_TOOL.name, 'api_context', 'api_context_record'].map(name => `mcp_${name}`);
  assert.deepEqual(names, [...new Set([...cliFeatureNames(), ...mcpNames])].sort());
});

// --- T5 -------------------------------------------------------------------------
test('T5: a request executed through the running service counts one api_calls when told and on, and nothing when not told or off', { skip: noStandIn }, async t => {
  await t.test('told and on', async t => {
    const m = await machine(t);
    await m.cli(['--version']);
    assert.equal((await m.cli(['workbench', 'open', '--json'])).code, 0);
    const before = m.lines().length;
    assert.equal(m.features('workbench'), 1, 'the service counted its own start');
    await requestThroughService(m);
    assert.equal(m.apiCalls(), 1);
    assert.equal(m.lines().length, before + 1, 'the request added only its api_calls line');
  });
  await t.test('not told', async t => {
    const m = await machine(t);
    // A service left running on a machine whose record is then gone: it has
    // not been told, so the request counts nothing and no notice is recorded.
    assert.equal((await m.cli(['workbench', 'open', '--json'])).code, 0);
    assert.equal(m.features('workbench'), 1, 'the service counted its own start');
    rmSync(m.stateFile); rmSync(join(m.state, 'telemetry'), { recursive: true, force: true });
    await requestThroughService(m);
    assert.equal(m.record(), null, 'the service recorded a notice nobody saw');
    assert.deepEqual(m.lines(), []);
  });
  await t.test('off', async t => {
    const m = await machine(t);
    await m.cli(['--version']);
    assert.equal((await m.cli(['telemetry', 'off'])).code, 0);
    assert.equal((await m.cli(['workbench', 'open', '--json'])).code, 0);
    await requestThroughService(m);
    assert.deepEqual(m.lines(), []);
  });
});

// --- T6 -------------------------------------------------------------------------
test('T6: with telemetry off recorded for the home, an open and its service write no count and no notice record', { skip: noStandIn }, async t => {
  const m = await machine(t);
  const off = await m.cli(['telemetry', 'off']);
  assert.equal(off.code, 0, off.stderr);
  const record = m.record();
  assert.equal(record === null ? null : JSON.parse(record).noticed_at, null);
  const open = await m.cli(['workbench', 'open', '--json']);
  assert.equal(open.code, 0, open.stderr);
  assert.doesNotMatch(open.stderr, NOTICE);
  assert.equal(await serviceState(m), 'running');
  await delay(300);
  assert.equal(m.record(), record, 'the open or its service changed the record');
  assert.deepEqual(m.lines(), []);
  assert.deepEqual(m.blocked(), []);
});

// --- T8 -------------------------------------------------------------------------
/** Start the background process itself, as the launcher does, and wait until
 *  it answers. Readiness and stop are asked in this process, through the
 *  library, so no CLI command of the test touches the usage state. */
async function startServe(t, m) {
  const proc = spawn(process.execPath, [m.CLI, 'workbench', 'serve', '--project', m.root], { cwd: m.root, env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => proc.once('close', resolve));
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; } });
  const until = Date.now() + 15_000;
  while ((await liveWorkbenchService(m.root)).state !== 'running') {
    if (Date.now() > until || proc.exitCode !== null) assert.fail(`the service did not start: ${stderr}`);
    await delay(100);
  }
  return {
    stderr: () => stderr,
    stop: async () => {
      assert.equal((await stopWorkbenchService(m.root)).state, 'stopped');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await exited; clearTimeout(timer);
    },
  };
}
const usageCalls = m => m.blocked().filter(line => JSON.parse(line).url.includes('/api/v1/usage'));

test('T8: a service started directly takes no notice, counts nothing for its start and starts no send', { skip: noStandIn }, async t => {
  await t.test('a home never told', async t => {
    const m = await machine(t);
    const serve = await startServe(t, m);
    await delay(300);
    assert.equal(m.record(), null, 'the service recorded a notice while running');
    assert.deepEqual(m.lines(), []);
    await serve.stop();
    assert.doesNotMatch(serve.stderr(), NOTICE);
    assert.equal(m.record(), null, 'a notice record exists after the service stopped');
    assert.equal(existsSync(join(m.state, 'telemetry')), false, 'counts were written');
    assert.deepEqual(m.blocked(), []);
  });
  await t.test('a home told more than a day ago, counts pending, a send due', async t => {
    const m = await machine(t);
    assert.match((await m.cli(['--version'])).stderr, NOTICE);
    await m.cli(['--version']);
    // Then told two days ago, as far as the record says: a send is due.
    const told = JSON.parse(m.record());
    told.noticed_at = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeFileSync(m.stateFile, `${JSON.stringify(told)}\n`);
    const pending = readFileSync(join(m.state, 'telemetry', 'counts.jsonl'), 'utf8');
    const record = m.record();
    const serve = await startServe(t, m);
    await delay(1500);
    await serve.stop();
    await delay(500);
    assert.deepEqual(usageCalls(m), [], 'the service attempted a send');
    assert.equal(existsSync(join(m.state, 'telemetry', 'sent')), false, 'the service prepared a document');
    assert.equal(existsSync(join(m.state, 'telemetry', 'batch.json')), false, 'the service folded the counts for a send');
    assert.equal(m.record(), record, 'the service recorded an attempt or changed the record');
    assert.equal(readFileSync(join(m.state, 'telemetry', 'counts.jsonl'), 'utf8'), pending, 'the service counted its own start');
    // Control: the same machine, a command a person runs, does start the due send.
    await m.cli(['--version']);
    const until = Date.now() + 15_000;
    while (!usageCalls(m).length && Date.now() < until) await delay(100);
    assert.equal(usageCalls(m).length, 1, 'the staged machine had no send due');
    assert.equal(JSON.parse(m.record()).attempts, 1);
  });
});

// --- T9 -------------------------------------------------------------------------
test('T9: telemetry off run while a service is running stops it counting the requests sent from its page', { skip: noStandIn }, async t => {
  const m = await machine(t);
  await m.cli(['--version']);
  assert.equal((await m.cli(['workbench', 'open', '--json'])).code, 0);
  await requestThroughService(m);
  assert.equal(m.apiCalls(), 1, 'the running service counted before off');
  assert.equal((await m.cli(['telemetry', 'off'])).code, 0);
  assert.equal(await serviceState(m), 'running', 'the service kept running through off');
  await requestThroughService(m);
  assert.deepEqual(m.lines(), []);
  assert.equal(existsSync(join(m.state, 'telemetry', 'counts.jsonl')), false, 'a count file was left');
  assert.deepEqual(m.blocked(), []);
});
