// OPEN-1: `workbench open` starts or reuses one checkout's background
// Workbench and opens a connected page with no terminal and no pairing code.
// These run the real CLI and MCP server as child processes against synthetic
// checkouts. The system opener is a stand-in on PATH that acts as the opened
// page; the only traffic is to the product's own loopback listeners.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { launchDirectory, openWorkbench, serviceRecordPath, stopWorkbenchService } from '../lib/workbench-launch.mjs';
import { launchWorkbench } from '../lib/workbench-cli.mjs';
import { askWorkbenchControl, listWorkbenchControls } from '../lib/workbench-control.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { browserLog, installTestBrowser, pageAction, pageRequest, redeemLaunch } from './fixtures/workbench-browser.mjs';
import { loadWorkbenchPage } from './helpers/workbench-dom.mjs';
import { workbenchHandlers } from '../lib/workbench-engine.mjs';

const candidate = process.env.SANNR_TEST_PACKAGE;
const CLI = candidate ? join(candidate, 'bin', 'cli.mjs') : fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const SERVER = candidate ? join(candidate, 'server.mjs') : fileURLToPath(new URL('../server.mjs', import.meta.url));
// The Windows opener is an absolute system path that a test cannot stand in for.
const noStandIn = process.platform === 'win32' ? 'the Windows opener cannot be replaced by a test stand-in' : false;

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

/** A scratch area with isolated machine state, a stand-in opener and a loopback API that must stay silent. */
async function scene(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-open-'))), seen = [], roots = [];
  const api = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise(done => api.listen(0, '127.0.0.1', done));
  mkdirSync(join(base, 'home'), { recursive: true });
  const log = join(base, 'browser.jsonl');
  const env = { PATH: `${installTestBrowser(join(base, 'bin'))}${delimiter}${process.env.PATH}`, HOME: join(base, 'home'), [HOME_ENV_NAME]: join(base, 'machine'),
    API_USAGE_LOG: join(base, 'machine', 'usage.jsonl'), API_FRICTION_OFF: '1', NO_COLOR: '1', DISPLAY: ':0',
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    WORKBENCH_TEST_BROWSER: 'connect', WORKBENCH_TEST_BROWSER_LOG: log };
  const cli = (cwd, args, extra = {}) => child(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extra } });
  const json = async (cwd, args, extra) => { const run = await cli(cwd, [...args, '--json'], extra); return { ...run, value: JSON.parse(run.stdout) }; };
  t.after(async () => {
    // Stop every service a test started, whatever state the test ended in.
    for (const root of roots) await cli(root, ['workbench', 'stop']).catch(() => {});
    await new Promise(done => api.close(done));
    rmSync(base, { recursive: true, force: true });
  });
  /** A configured checkout: one stack bound to the silent loopback API. */
  async function checkout(path, stack = 'fixture') {
    const root = join(base, path);
    mkdirSync(root, { recursive: true });
    assert.equal((await child('git', ['init', '--quiet'], { cwd: root, env })).code, 0);
    writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: stack, version: '1' },
      paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } }));
    createFixtureStack(root, { name: stack, title: `${stack} API`, contract: 'openapi.json', baseUrl: `http://127.0.0.1:${api.address().port}` });
    writeFileSync(fixtureContextFile(root, stack), JSON.stringify({ v: 0, api: { name: `${stack} API` }, operations: {} }));
    roots.push(root);
    return root;
  }
  return { base, env, seen, log, cli, json, checkout, launches: () => browserLog(log) };
}
/** The committed halves of a checkout: every stack file's bytes. */
function committed(root) {
  const out = {}, walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path); else out[path.slice(root.length)] = readFileSync(path, 'utf8');
  } };
  walk(join(root, LAYOUT.collection));
  return out;
}
const stacksOf = reply => reply.json.result.stacks.map(row => row.name);

test('a non-interactive open starts the checkout\'s service and a connected page, reuses it, and reopens after stop', { skip: noStandIn }, async t => {
  const s = await scene(t), root = await s.checkout('solo'), before = committed(root);
  const first = await s.json(root, ['workbench', 'open']);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.value.ok, true);
  assert.deepEqual(first.value.repository, { name: 'solo', root });
  assert.equal(first.value.instance.state, 'created');
  assert.match(first.value.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(first.value.browser.state, 'dispatched');
  assert.equal(first.value.page.state, 'connected', 'the result reports the page that redeemed the launch, not the opener\'s exit');
  const [launched] = s.launches();
  assert.equal(launched.plain, first.value.url);
  assert.match(launched.grant, /^[A-Za-z0-9_-]{43}$/);
  for (const secret of [launched.grant, launched.token]) assert.ok(!(first.stdout + first.stderr).includes(secret), 'no launch or session material in command output');
  assert.ok(!readFileSync(serviceRecordPath(root), 'utf8').includes(launched.grant), 'the discovery record carries no launch material');

  // The launching command has exited; the page it opened is usable.
  const index = await pageAction(launched.origin, launched.token, 'workbench');
  assert.equal(index.status, 200); assert.deepEqual(stacksOf(index), ['fixture']);
  // The plain URL is the package's static page and no more.
  assert.equal((await pageAction(launched.origin, 'x'.repeat(43), 'workbench')).status, 401);
  assert.equal((await pageRequest(launched.origin, '/action', { action: 'workbench', params: {} })).status, 401);
  assert.equal((await pageRequest(launched.origin, '/action', { action: 'workbench', params: {} }, { 'x-workbench-token': launched.token, origin: 'https://other.example.test' })).status, 403);

  const status = await s.json(root, ['workbench', 'status']);
  assert.equal(status.value.state, 'running'); assert.equal(status.value.instance.id, first.value.instance.id);
  assert.equal(status.value.pages_connected, 1);

  const second = await s.json(root, ['workbench', 'open', '--view', 'map', '--stack', 'fixture', '--operation', 'GET /health']);
  assert.equal(second.value.instance.state, 'reused'); assert.equal(second.value.instance.id, first.value.instance.id); assert.equal(second.value.url, first.value.url);
  assert.deepEqual(second.value.context, { passed: { view: 'map', stack: 'fixture', operation: 'GET /health' }, ignored: [] });
  const again = s.launches()[1];
  assert.deepEqual([again.view, again.stack, again.operation], ['map', 'fixture', 'GET /health'], 'navigation reaches the page beside the launch');
  assert.notEqual(again.token, launched.token);
  assert.equal((await pageAction(launched.origin, launched.token, 'workbench')).status, 200, 'a new open leaves the earlier page connected');
  assert.equal((await pageAction(again.origin, again.token, 'workbench')).status, 200);

  // A launch works once. Showing it again ends the session it created.
  const replay = await redeemLaunch(launched.origin, launched.grant);
  assert.equal(replay.status, 401); assert.equal(replay.json.error.code, 'WORKBENCH_LAUNCH_REUSED');
  assert.equal((await pageAction(launched.origin, launched.token, 'workbench')).status, 401);
  assert.equal((await pageAction(again.origin, again.token, 'workbench')).status, 200, 'another page\'s session is untouched');

  assert.deepEqual(s.seen, [], 'opening and reading the index sent nothing to the API');
  assert.deepEqual(committed(root), before, 'opening wrote nothing to the committed stack files');

  const stopped = await s.json(root, ['workbench', 'stop']);
  assert.equal(stopped.value.state, 'stopped'); assert.equal(stopped.value.instance.id, first.value.instance.id);
  assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'not-running');
  assert.equal((await pageAction(again.origin, again.token, 'workbench')).status, 0, 'a stopped service no longer listens');
  assert.equal((await s.json(root, ['workbench', 'stop'])).value.state, 'not-running', 'stopping twice is not an error');
  const reopened = await s.json(root, ['workbench', 'open', '--no-open']);
  assert.equal(reopened.value.instance.state, 'created'); assert.notEqual(reopened.value.instance.id, first.value.instance.id);
  assert.equal(reopened.value.browser.state, 'not-requested');
});

test('two checkouts with the same folder name run side by side, and neither one\'s launch or session opens the other', { skip: noStandIn }, async t => {
  const s = await scene(t), a = await s.checkout(join('one', 'app'), 'alpha'), b = await s.checkout(join('two', 'app'), 'beta');
  const openA = await s.json(a, ['workbench', 'open']);
  // B is opened from A's directory by naming it: the result names B.
  const openB = await s.json(a, ['workbench', 'open', '--project', b]);
  assert.equal(openA.value.repository.root, a); assert.equal(openB.value.repository.root, b);
  assert.equal(openA.value.repository.name, openB.value.repository.name);
  assert.notEqual(openA.value.instance.id, openB.value.instance.id); assert.notEqual(openA.value.url, openB.value.url);
  const [pageA, pageB] = s.launches();
  assert.deepEqual(stacksOf(await pageAction(pageA.origin, pageA.token, 'workbench')), ['alpha']);
  assert.deepEqual(stacksOf(await pageAction(pageB.origin, pageB.token, 'workbench')), ['beta']);
  assert.equal((await pageAction(pageB.origin, pageA.token, 'workbench')).status, 401, 'A\'s session is nothing to B');
  // An unused launch for A is refused by B, then still works for A.
  await s.json(a, ['workbench', 'open'], { WORKBENCH_TEST_BROWSER: 'ignore' });
  const unused = s.launches()[2];
  assert.equal(unused.origin, pageA.origin);
  const foreign = await redeemLaunch(pageB.origin, unused.grant);
  assert.equal(foreign.status, 401); assert.equal(foreign.json.error.code, 'WORKBENCH_LAUNCH_INVALID');
  assert.equal((await redeemLaunch(pageA.origin, unused.grant)).status, 200);

  assert.equal((await s.json(b, ['workbench', 'stop', '--project', a])).value.state, 'stopped');
  assert.equal((await s.json(b, ['workbench', 'status'])).value.state, 'running', 'stopping A leaves B running');
  assert.equal((await pageAction(pageB.origin, pageB.token, 'workbench')).status, 200);
  const reopened = await s.json(a, ['workbench', 'open']);
  assert.equal(reopened.value.instance.state, 'created'); assert.equal(reopened.value.page.state, 'connected');
  assert.deepEqual(s.seen, []);
});

test('simultaneous opens converge on one instance; a killed service, a squatted port and a damaged record recover without touching anything else', async t => {
  const s = await scene(t), root = await s.checkout('race'), before = committed(root);
  const opens = await Promise.all([1, 2, 3].map(() => s.json(root, ['workbench', 'open', '--no-open'])));
  for (const run of opens) assert.equal(run.code, 0, run.stderr);
  assert.equal(new Set(opens.map(run => run.value.instance.id)).size, 1, 'every caller got the same instance');
  assert.equal(new Set(opens.map(run => run.value.url)).size, 1);
  assert.equal(opens.filter(run => run.value.instance.state === 'created').length, 1, 'exactly one of them started it');

  // The service dies without cleaning up, and something else takes its port.
  const running = (await s.json(root, ['workbench', 'status'])).value, port = Number(new URL(running.url).port);
  process.kill(running.instance.pid, 'SIGKILL');
  let squatter = null; const squatted = [];
  for (let attempt = 0; attempt < 100 && !squatter; attempt++) {
    const server = createServer((req, res) => { squatted.push(req.url); res.end('unrelated'); });
    const bound = await new Promise(done => { server.once('error', () => done(false)); server.listen(port, '127.0.0.1', () => done(true)); });
    if (bound) squatter = server; else await delay(50);
  }
  assert.ok(squatter, 'the old port could be taken once the service was gone');
  t.after(() => new Promise(done => squatter.close(done)));
  const stale = (await s.json(root, ['workbench', 'status'])).value;
  assert.equal(stale.state, 'not-running'); assert.equal(stale.stale_record, true);
  const recovered = await s.json(root, ['workbench', 'open', '--no-open']);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.value.instance.state, 'created'); assert.equal(recovered.value.instance.replaced_stale_record, true);
  assert.notEqual(recovered.value.instance.id, running.instance.id); assert.notEqual(recovered.value.url, running.url);
  assert.deepEqual(squatted, [], 'the unrelated listener on the old port was never contacted');
  assert.equal(squatter.listening, true);

  // A record that is not a service record is replaced, not obeyed.
  assert.equal((await s.json(root, ['workbench', 'stop'])).value.state, 'stopped');
  writeFileSync(serviceRecordPath(root), '{"version":1,"kind":"workbench-service","socket":"/nonexistent/control.sock"');
  const repaired = await s.json(root, ['workbench', 'open', '--no-open']);
  assert.equal(repaired.value.instance.state, 'created');
  assert.equal((await s.json(root, ['workbench', 'status'])).value.instance.id, repaired.value.instance.id);
  assert.deepEqual(committed(root), before); assert.deepEqual(s.seen, []);
});

test('a lock left by a dead opener is cleared, one that cannot be cleared is a named refusal, and a removed launch folder stops the service for good', async t => {
  const s = await scene(t), root = await s.checkout('locks'), lock = join(launchDirectory(root), 'launch.lock');
  assert.equal((await s.json(root, ['workbench', 'open', '--no-open'])).value.instance.state, 'created');
  assert.equal((await s.json(root, ['workbench', 'stop'])).value.state, 'stopped');
  // An opener that died mid-launch: its lock names a process that no longer exists.
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); await once(gone, 'close');
  writeFileSync(lock, JSON.stringify({ pid: gone.pid, at: new Date().toISOString(), id: 'dead' }));
  const cleared = await s.json(root, ['workbench', 'open', '--no-open']);
  assert.equal(cleared.code, 0, cleared.stderr); assert.equal(cleared.value.instance.state, 'created');
  assert.equal(existsSync(lock), false);
  assert.equal((await s.json(root, ['workbench', 'stop'])).value.state, 'stopped');
  // Something that is not a lock sits at the lock's name and cannot be cleared.
  mkdirSync(lock); utimesSync(lock, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  await assert.rejects(openWorkbench(root, { open: false, env: s.env, deadlineMs: 300 }), { code: 'WORKBENCH_LAUNCH_BUSY' });
  assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'not-running', 'the refusal started nothing');
  rmSync(lock, { recursive: true });

  // The checkout's private files are removed under a running service.
  const running = await s.json(root, ['workbench', 'open', '--no-open']), { pid } = (await s.json(root, ['workbench', 'status'])).value.instance;
  assert.equal(running.value.instance.state, 'created');
  rmSync(join(root, LAYOUT.evidence, 'workbench'), { recursive: true });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; alive() && waited < 30_000; waited += 100) await delay(100);
  assert.equal(alive(), false, 'the service stopped once its launch folder was gone');
  assert.equal(existsSync(join(root, LAYOUT.evidence, 'workbench', 'launch')), false, 'and it put nothing back');
  assert.equal((await pageRequest(new URL(running.value.url).origin, '/action', { action: 'workbench', params: {} })).status, 0);
});

test('a missing or unconfigured target, a failed opener and an unanswered launch are separate named outcomes', { skip: noStandIn }, async t => {
  const s = await scene(t), root = await s.checkout('named');
  const missing = await s.json(root, ['workbench', 'open', '--project', join(s.base, 'nowhere')]);
  assert.equal(missing.code, 1); assert.equal(missing.value.ok, false); assert.equal(missing.value.error.code, 'WORKBENCH_PROJECT_NOT_FOUND');
  const bare = join(s.base, 'bare'); mkdirSync(bare);
  const unconfigured = await s.json(root, ['workbench', 'open', '--project', bare]);
  assert.equal(unconfigured.code, 1); assert.equal(unconfigured.value.error.code, 'WORKBENCH_PROJECT_NOT_CONFIGURED');
  assert.deepEqual(readdirSync(bare), [], 'nothing was created in the unconfigured checkout');
  assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'not-running', 'a refused target never falls back to the current checkout');
  assert.deepEqual(s.launches(), []);
  // Without --json the same refusal is the CLI's usual error report.
  const plain = await s.cli(root, ['workbench', 'open', '--project', bare]);
  assert.equal(plain.code, 1); assert.match(plain.stderr, /WORKBENCH_PROJECT_NOT_CONFIGURED/);
  assert.equal((await s.cli(root, ['workbench', 'open', '--frobnicate'])).code, 1);

  // An opener that fails leaves a healthy instance and says how to retry.
  const failed = await s.json(root, ['workbench', 'open'], { WORKBENCH_TEST_BROWSER: 'fail' });
  assert.equal(failed.code, 1); assert.equal(failed.value.ok, false);
  assert.equal(failed.value.error.code, 'WORKBENCH_OPENER_FAILED'); assert.equal(failed.value.browser.state, 'failed');
  assert.equal(failed.value.page.state, 'not-opened'); assert.equal(failed.value.instance.state, 'created');
  assert.match(failed.value.url, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.match(failed.value.error.next, /workbench open/);
  assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'running');
  // No opener on this machine at all.
  const empty = join(s.base, 'empty-path'); mkdirSync(empty);
  const absent = await s.json(root, ['workbench', 'open'], { PATH: empty });
  assert.equal(absent.code, 1); assert.equal(absent.value.error.code, 'WORKBENCH_OPENER_UNAVAILABLE'); assert.equal(absent.value.instance.state, 'reused');
  // An opener that accepts the request while no page ever connects.
  const silent = await s.json(root, ['workbench', 'open', '--view', 'nonsense'], { WORKBENCH_TEST_BROWSER: 'ignore', SSH_CONNECTION: '203.0.113.9 50000 203.0.113.10 22' });
  assert.equal(silent.code, 0); assert.equal(silent.value.ok, true);
  assert.equal(silent.value.browser.state, 'dispatched'); assert.equal(silent.value.page.state, 'not-observed');
  assert.equal(silent.value.browser.remote_session, true);
  assert.deepEqual(silent.value.context, { passed: {}, ignored: ['view'] }, 'an unusable view is named and the repository still opens');
  const outputs = [failed, absent, silent].map(run => run.stdout + run.stderr).join('\n');
  for (const entry of s.launches()) if (entry.grant) assert.ok(!outputs.includes(entry.grant), 'diagnostics carry no launch material');

  // A Linux session with no display is reported without running an opener.
  const before = s.launches().length;
  const headless = await openWorkbench(root, { platform: 'linux', env: { ...s.env, DISPLAY: '', WAYLAND_DISPLAY: '' } });
  assert.equal(headless.ok, false); assert.equal(headless.error.code, 'WORKBENCH_BROWSER_UNAVAILABLE');
  assert.equal(headless.instance.state, 'reused'); assert.equal(s.launches().length, before);
  assert.equal((await stopWorkbenchService(root)).state, 'stopped');
});

async function mcpPeer(s, root) {
  const proc = spawn(process.execPath, [SERVER], { cwd: root, env: { ...s.env, API_CONTEXT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(proc, 'close'), pending = new Map(); let buffer = '', next = 1;
  proc.stderr.resume();
  proc.stdout.on('data', chunk => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) { const reply = JSON.parse(line), waiter = pending.get(reply.id); if (waiter) { pending.delete(reply.id); clearTimeout(waiter.timer); waiter.resolve(reply); } }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 40_000);
    pending.set(id, { resolve, timer }); proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'open-fixture', version: '1' } });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tool = (await request('tools/list')).result.tools.find(item => item.name === 'api_workbench');
  const call = async args => { const reply = await request('tools/call', { name: 'api_workbench', arguments: args });
    return { value: JSON.parse(reply.result.content[0].text), error: reply.result.isError === true }; };
  return { tool, call, close: async () => { proc.stdin.end(); proc.kill(); await closed; } };
}

test('api_workbench open launches only the repository its server is bound to, and the page outlives the MCP peer', { skip: noStandIn }, async t => {
  const s = await scene(t), a = await s.checkout('coordination', 'alpha'), b = await s.checkout('application', 'beta');
  const peer = await mcpPeer(s, a);
  t.after(() => peer.close());
  assert.ok(peer.tool.inputSchema.properties.action.enum.includes('open'));
  assert.ok(peer.tool.inputSchema.properties.action.enum.includes('show'), 'show remains its own, non-launching action');
  // The conversation's target is B, but this server acts for A: named refusal, nothing started.
  const mismatch = await peer.call({ action: 'open', project: b });
  assert.equal(mismatch.error, true); assert.equal(mismatch.value.error.code, 'WORKBENCH_REPOSITORY_MISMATCH');
  assert.deepEqual(mismatch.value.error.details, { bound_repository: a, requested_repository: b });
  for (const root of [a, b]) assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'not-running');
  assert.equal((await peer.call({ action: 'open', project: join(s.base, 'nowhere') })).value.error.code, 'WORKBENCH_PROJECT_NOT_FOUND');
  assert.deepEqual(s.launches(), []);
  // show still launches nothing.
  await peer.call({ action: 'show' });
  assert.equal((await s.json(a, ['workbench', 'status'])).value.state, 'not-running');

  const opened = await peer.call({ action: 'open', project: a, view: 'activity' });
  assert.equal(opened.error, false);
  assert.equal(opened.value.repository.root, a); assert.equal(opened.value.instance.state, 'created');
  assert.equal(opened.value.browser.state, 'dispatched'); assert.equal(opened.value.page.state, 'connected');
  const [page] = s.launches();
  assert.equal(page.view, 'activity'); assert.ok(!JSON.stringify(opened.value).includes(page.grant));
  // The same peer still serves A afterwards: opening rebound nothing.
  assert.equal((await peer.call({ action: 'open', project: b })).value.error.code, 'WORKBENCH_REPOSITORY_MISMATCH');

  await peer.close();
  const after = (await s.json(a, ['workbench', 'status'])).value;
  assert.equal(after.state, 'running'); assert.equal(after.instance.id, opened.value.instance.id, 'the service outlived the MCP peer that started it');
  assert.deepEqual(stacksOf(await pageAction(page.origin, page.token, 'workbench')), ['alpha']);

  const later = await mcpPeer(s, a);
  t.after(() => later.close());
  assert.equal((await later.call({ action: 'open' })).value.instance.state, 'reused');
  assert.equal((await later.call({ action: 'stop' })).value.state, 'stopped');
  assert.equal((await s.json(a, ['workbench', 'status'])).value.state, 'not-running');
  assert.deepEqual(s.seen, []);
});

test('a terminal-launched workbench is never opened without its typed code: open starts its own service beside it', async t => {
  const s = await scene(t), root = await s.checkout('terminal');
  const piped = await s.cli(root, ['workbench', '--no-open']);
  assert.equal(piped.code, 1); assert.match(piped.stdout + piped.stderr, /WORKBENCH_TERMINAL_REQUIRED/);
  assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'not-running', 'the refused terminal launch started nothing');
  // What `workbench` runs in an interactive terminal, in this process.
  const terminal = await launchWorkbench(root);
  t.after(() => terminal.close());
  assert.equal((await s.json(root, ['workbench', 'status'])).value.state, 'not-running', 'a terminal launch is not the background service');
  const opened = await s.json(root, ['workbench', 'open', '--no-open']);
  assert.equal(opened.value.instance.state, 'created'); assert.notEqual(opened.value.url, terminal.url);
  // The terminal instance has no launch route and mints no grant for anyone.
  assert.equal((await redeemLaunch(terminal.origin, 'x'.repeat(43))).status, 404);
  const control = listWorkbenchControls(root).find(item => item.session_id === terminal.sessionId);
  const asked = await askWorkbenchControl(control.socket, { v: 1, kind: 'grant' });
  assert.equal(asked.reply.ok, false); assert.equal(asked.reply.code, 'WORKBENCH_CONTROL_MESSAGE_INVALID');
  assert.equal((await pageRequest(terminal.origin, '/pair/start', {})).status, 200, 'it still pairs by code');
  assert.equal((await pageRequest(new URL(opened.value.url).origin, '/pair/start', {})).status, 404, 'the background service has no pairing route');
});

// The packaged page script of a launched service, run in the DOM shim against
// this checkout's real engine handlers. `tab` is one browser tab's state.
test('the opened page spends its launch once, clears it from the address bar, stays connected across a reload, and a plain URL gets nothing', async t => {
  const s = await scene(t), root = await s.checkout('page');
  const home = process.env.HOME, machine = process.env[HOME_ENV_NAME];
  process.env.HOME = s.env.HOME; process.env[HOME_ENV_NAME] = s.env[HOME_ENV_NAME];
  t.after(() => { process.env.HOME = home; if (machine === undefined) delete process.env[HOME_ENV_NAME]; else process.env[HOME_ENV_NAME] = machine; });
  const handlers = workbenchHandlers(root), tokens = new Set(), grants = new Map([['grant-one', 'token-one'], ['grant-two', 'token-two']]);
  const tab = new Map(), load = (hash, storage = tab) => loadWorkbenchPage(handlers, { launch: { hash, storage, grants, tokens } });
  const gate = page => page.text('#pair-status'), shown = page => !page.q('#app').hidden;

  const opened = load('#launch=grant-one&view=activity');
  await opened.settle(60);
  assert.equal(shown(opened), true);
  assert.equal(opened.address.hash, '', 'the launch is gone from the address bar');
  assert.equal(opened.q('#app').getAttribute('data-view'), 'activity', 'the view the launch named is showing');
  assert.deepEqual(opened.wire.filter(row => row.path === '/launch/redeem').map(row => row.headers['x-workbench-launch']), ['grant-one']);
  assert.ok(opened.wire.filter(row => row.path === '/action').every(row => row.headers['x-workbench-token'] === 'token-one'));
  assert.ok(![...tab.values()].some(value => value.includes('grant-one')), 'the tab keeps its session, not the launch');

  // Reload: the same tab, no fragment, no second exchange.
  const reloaded = load('');
  await reloaded.settle(60);
  assert.equal(shown(reloaded), true);
  assert.deepEqual(reloaded.wire.filter(row => row.path !== '/action'), []);
  assert.equal(reloaded.q('#app').getAttribute('data-view'), 'workbench');

  // A later launch arriving in the loaded tab connects it again and is cleared too.
  await reloaded.arrive('#launch=grant-two&view=map');
  assert.equal(reloaded.address.hash, ''); assert.equal(shown(reloaded), true);
  assert.equal(reloaded.q('#app').getAttribute('data-view'), 'map');
  assert.equal(reloaded.wire.at(-1).headers['x-workbench-token'], 'token-two');

  // A launch that is refused leaves this connected tab as it was.
  await reloaded.arrive('#launch=never-issued');
  assert.equal(reloaded.address.hash, ''); assert.equal(shown(reloaded), true);
  await reloaded.click('[data-mode="workbench"]');
  assert.equal(reloaded.q('#app').getAttribute('data-view'), 'workbench');
  assert.equal(reloaded.wire.at(-1).headers['x-workbench-token'], 'token-two', 'the tab still acts with its own session');
  assert.match(reloaded.document.title, /^page · /u, 'the tab is titled with its repository');

  // The same holds in a browser that gives the tab no storage to fall back on.
  grants.set('grant-memory', 'token-memory');
  const bare = loadWorkbenchPage(handlers, { launch: { hash: '#launch=grant-memory', grants, tokens, noStorage: true } });
  await bare.settle(60);
  await bare.arrive('#launch=never-issued');
  assert.equal(shown(bare), true, 'a refused launch does not disconnect a tab that holds its session only in memory');
  await bare.click('[data-mode="map"]');
  assert.equal(bare.q('#app').getAttribute('data-view'), 'map'); assert.equal(bare.wire.at(-1).headers['x-workbench-token'], 'token-memory');

  // A browser that will not rewrite the address shows the same launch again
  // on reload; the tab does not spend it twice and stays connected.
  grants.set('grant-frozen', 'token-frozen');
  const frozen = new Map(), stuck = () => loadWorkbenchPage(handlers, { launch: { hash: '#launch=grant-frozen', storage: frozen, grants, tokens, frozenAddress: true } });
  const first = stuck(); await first.settle(60);
  assert.equal(shown(first), true);
  const second = stuck(); await second.settle(60);
  assert.equal(shown(second), true);
  assert.deepEqual(second.wire.filter(row => row.path === '/launch/redeem'), [], 'a launch this tab already spent is not presented again');

  // Another tab with only the plain URL: no session, no request for data.
  const stranger = load('', new Map());
  await stranger.settle(60);
  assert.equal(shown(stranger), false);
  assert.match(gate(stranger), /not connected/u); assert.match(gate(stranger), /tool workbench open/u);
  assert.deepEqual(stranger.calls, [], 'an unconnected tab asks the engine for nothing');
  assert.equal(stranger.q('#pair-again').hidden, true, 'there is no pairing code to ask for');

  // A used or unknown launch does not connect, and says what to do.
  const replayed = load('#launch=grant-one', new Map());
  await replayed.settle(60);
  assert.equal(shown(replayed), false); assert.equal(replayed.address.hash, '');
  assert.match(gate(replayed), /expired or was already used/u); assert.deepEqual(replayed.calls, []);

  // The service forgets the tab's session (it stopped and another started):
  // the tab shows the not-connected screen and drops the dead session.
  tokens.clear();
  const ended = load('');
  await ended.settle(60);
  assert.equal(shown(ended), false); assert.match(gate(ended), /no longer connected/u);
  assert.equal(tab.size, 0);
  // An unusable view or operation in a launch changes nothing but still opens the page.
  grants.set('grant-three', 'token-three');
  const odd = load('#launch=grant-three&view=settings&operation=GET+%2Fnowhere&stack=fixture');
  await odd.settle(60);
  assert.equal(shown(odd), true); assert.equal(odd.q('#app').getAttribute('data-view'), 'workbench');
  assert.equal(odd.all('.problem').length, 0, 'an unknown operation is ignored, not shown as an error');
});
