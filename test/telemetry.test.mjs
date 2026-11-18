// USE-1: the daily usage document, observed only from outside — through the
// CLI and the MCP server's stdio — in an isolated machine state directory and
// HOME. A harness-owned preload (never a product override) records every
// attempted fetch, answers for the fixed destination in the mode under test,
// passes loopback API traffic through and blocks everything else before the
// wire, so nothing reaches a real host. The same preload pins every process's
// clock to a fixed midday that only the test moves (m.advance), so no test
// depends on the time of day or on file times.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, closeSync, cpSync, openSync, existsSync, renameSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME_ENV_NAME, MCP_INSPECT_CLIENT_NAME, PRODUCT, TELEMETRY_CHECKOUT_ENV_NAME, TELEMETRY_ENV_NAME, TOOL_NAME, USAGE_URL } from '../lib/brand.mjs';
import { cliFeatureNames } from '../lib/telemetry.mjs';
import { SAVED_REQUEST_TOOL } from '../lib/saved-request-actions.mjs';
import { WORKBENCH_AGENT_TOOL } from '../lib/workbench-agent-tools.mjs';
import { NOTE_REVIEW_TOOL, NOTE_RETIRE_TOOL, NOTE_CONTEXT_TOOL } from '../lib/note-review-actions.mjs';

const ROOT = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, 'lib/usage.schema.json'), 'utf8'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
// Written out here, not imported, so a variable dropped from the code fails.
const CI_VARIABLES = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION'];
const START = Date.parse('2026-06-15T12:00:00.000Z');
const day = n => new Date(START + n * 86_400_000).toISOString().slice(0, 10);
const IS_CHECKOUT = existsSync(join(ROOT, '.git'));

// --- a minimal validator for exactly the keywords the contract uses ----------
function validate(schema, value, path = '$') {
  const errors = [];
  const type = t => t === 'integer' ? Number.isInteger(value) : t === 'null' ? value === null
    : t === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === t;
  if (schema.anyOf) return schema.anyOf.some(option => !validate(option, value, path).length) ? [] : [`${path}: anyOf`];
  if (schema.type && !type(schema.type)) return [`${path}: type ${schema.type}`];
  if ('const' in schema && value !== schema.const) errors.push(`${path}: const`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: pattern`);
  if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: minLength`);
  if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: maxLength`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: minimum`);
  if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: maximum`);
  if (schema.type === 'object') {
    const keys = Object.keys(value);
    for (const key of schema.required ?? []) if (!keys.includes(key)) errors.push(`${path}.${key}: required`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: maxProperties`);
    for (const key of keys) {
      if (schema.propertyNames) errors.push(...validate({ type: 'string', ...schema.propertyNames }, key, `${path}[name]`));
      if (schema.properties?.[key]) errors.push(...validate(schema.properties[key], value[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, value[key], `${path}.${key}`));
    }
  }
  return errors;
}

// --- one isolated machine --------------------------------------------------------
function machine(t, { project = 'project', stateInHome = false } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-')));
  t.after(() => { for (const dir of ['state', 'other-state', 'home']) try { chmodSync(join(parent, dir), 0o700); } catch { /* absent */ }
    rmSync(parent, { recursive: true, force: true }); });
  const home = join(parent, 'home'), state = stateInHome ? join(parent, 'home', `.${PRODUCT}`) : join(parent, 'state'), root = join(parent, project);
  mkdirSync(home); mkdirSync(root);
  const calls = join(parent, 'calls.jsonl'), mode = join(parent, 'mode.txt'), clock = join(parent, 'clock.txt'), preload = join(parent, 'preload.mjs');
  writeFileSync(mode, 'accept');
  writeFileSync(clock, String(START - Date.now()));
  writeFileSync(preload, `import { appendFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
// A process started with no home directory falls back to the account's real
// home; a test that starts one points that fallback at a temporary directory.
if (process.env.TEST_FALLBACK_HOME) {
  const fallback = process.env.TEST_FALLBACK_HOME, userInfo = os.userInfo;
  os.homedir = () => fallback;
  os.userInfo = (...args) => ({ ...userInfo(...args), homedir: fallback });
  syncBuiltinESMExports();
}
const RealDate = Date;
const offset = () => Number(readFileSync(${JSON.stringify(clock)}, 'utf8'));
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + offset()); }
  static now() { return RealDate.now() + offset(); }
};
if ((process.argv[1] ?? '').endsWith('telemetry-send.mjs')) {
  let ms = 0; try { ms = Number(readFileSync(${JSON.stringify(join(parent, 'stall.txt'))}, 'utf8')); } catch {}
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}
const actual = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url instanceof Request ? url.url : url);
  if (new URL(href).hostname === '127.0.0.1') return actual(url, init);
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ url: href, method: init.method, redirect: init.redirect, cwd: process.cwd(),
    proxy: Object.keys(process.env).filter(name => /proxy/i.test(name)),
    headers: Object.fromEntries(new Headers(init.headers)), body: init.body === undefined ? null : Buffer.from(init.body).toString('base64') }) + '\\n');
  if (href !== ${JSON.stringify(USAGE_URL)}) throw new Error('blocked by the test harness');
  const mode = readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
  if (mode === 'throw') throw new TypeError('fetch failed');
  if (mode === 'hang') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)));
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 400));
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://example.invalid/elsewhere' } });
  return new Response(null, { status: ['accept', 'slow'].includes(mode) ? 202 : Number(mode) });
};
`);
  // The checkout switch names this checkout's own real path: only a test does.
  // The off switches are named here, empty, so the test helper leaves them
  // unset in these children on purpose: this file turns counting on.
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, [HOME_ENV_NAME]: state, [TELEMETRY_CHECKOUT_ENV_NAME]: ROOT,
    [TELEMETRY_ENV_NAME]: '', DO_NOT_TRACK: '',
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, NO_COLOR: '1', API_FRICTION_OFF: '1' };
  const m = {
    parent, home, state, root, env,
    stateFile: join(state, 'telemetry.json'), lock: join(state, 'telemetry', '.send.lock'), sent: join(state, 'telemetry', 'sent'),
    counts: join(state, 'telemetry', 'counts.jsonl'),
    setMode: value => writeFileSync(mode, value),
    stallSender: ms => writeFileSync(join(parent, 'stall.txt'), String(ms)),
    advance: hours => writeFileSync(clock, String(Number(readFileSync(clock, 'utf8')) + hours * 3_600_000)),
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line); return { ...row, body: row.body === null ? null : Buffer.from(row.body, 'base64').toString('utf8') };
    }) : [],
    readState: (file = join(state, 'telemetry.json')) => JSON.parse(readFileSync(file, 'utf8')),
    run: (args, options = {}) => run(args, { cwd: options.cwd ?? root, env: { ...env, ...options.env }, input: options.input }),
    // A started send owns the lock until its detached sender finishes.
    settle: async (limit = 15_000) => {
      const end = Date.now() + limit;
      const locks = [m.lock, ...['other-state', join('home', `.${PRODUCT}`)].map(dir => join(parent, dir, 'telemetry', '.send.lock'))];
      while (locks.some(lock => existsSync(lock))) { if (Date.now() > end) throw new Error('sender did not finish'); await new Promise(r => setTimeout(r, 50)); }
    },
  };
  return m;
}

function run(args, { cwd, env, input }) {
  const started = performance.now();
  const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  if (input !== undefined) child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: performance.now() - started }); });
  });
}
const json = result => { try { return JSON.parse(result.stdout); } catch { assert.fail(`not JSON: ${result.stdout}${result.stderr}`); } };
const NOTICE = /telemetry: once a day .* sends usage counts/;
const usagePosts = m => m.calls().filter(call => call.url === USAGE_URL);
const show = async m => json(await m.run(['telemetry', 'show', '--json']));

async function gitInit(cwd) {
  const git = spawn('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => git.once('close', resolve)), 0);
}

async function loopbackApi(t) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (req.url === '/redir') { res.writeHead(302, { location: '/final' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/graphql' ? '{"data":{"state":"ready"}}' : '{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

// --- USE-1-01 -------------------------------------------------------------------
test('USE-1-01: a fresh machine shows the notice once on stderr, sends nothing and makes no identifier', async t => {
  const m = machine(t);
  const off = await m.run(['--version'], { env: { [TELEMETRY_ENV_NAME]: '0' } });
  assert.equal(existsSync(m.state), false, 'the off run wrote machine state');
  const first = await m.run(['--version']);
  assert.equal(first.code, off.code);
  assert.equal(first.stdout, off.stdout, 'the notice changed stdout');
  assert.match(first.stderr, NOTICE);
  assert.equal(first.stderr.match(/telemetry:/g).length, 1);
  for (const args of [['--version'], ['stacks', '--json'], ['--help']]) {
    const later = await m.run(args);
    assert.doesNotMatch(later.stderr, NOTICE, `${args.join(' ')} repeated the notice`);
  }
  m.advance(23);
  await m.run(['--version']);
  await m.settle();
  assert.deepEqual(m.calls(), [], 'a request was attempted within 24 hours of the notice');
  const status = json(await m.run(['telemetry', 'status', '--json']));
  assert.equal(status.state, 'on');
  assert.equal(status.install, 'absent');
  assert.equal(m.readState().install, null);
  assert.equal(existsSync(m.sent), false);
});

// --- USE-1-02 and USE-1-06 ------------------------------------------------------
test('USE-1-02/06: a day after the notice one command sends exactly one valid document, its receipt first; show is the truth', async t => {
  const m = machine(t);
  await m.run(['--version']);
  await m.run(['stacks', '--json']);
  m.advance(25);
  const first = await m.run(['--version'], { env: { HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', all_proxy: 'x', NODE_USE_ENV_PROXY: '1' } });
  assert.equal(first.code, 0);
  await m.settle();
  const posts = m.calls();
  assert.equal(posts.length, 1, JSON.stringify(posts));
  const [post] = posts;
  assert.equal(post.url, USAGE_URL);
  assert.equal(post.method, 'POST');
  assert.equal(post.redirect, 'manual', 'redirects must not be followed');
  assert.deepEqual(Object.keys(post.headers).sort(), ['content-type', 'user-agent']);
  assert.equal(post.headers['content-type'], 'application/json');
  assert.equal(post.headers['user-agent'], `${PRODUCT}/${VERSION}`);
  assert.deepEqual(post.proxy, [], 'a proxy variable reached the sender');
  assert.equal(post.cwd, realpathSync(join(m.state, 'telemetry')), 'the sender holds the project directory');
  assert.ok(Buffer.byteLength(post.body) <= 2048);
  const document = JSON.parse(post.body);
  assert.deepEqual(validate(SCHEMA, document), []);
  assert.deepEqual(Object.keys(document).sort(), [...SCHEMA.required].sort());
  assert.equal(document.since, null);
  assert.equal(document.version, VERSION);
  assert.deepEqual(document.features, { stacks: 1, version: 1 });
  const shownAfter = await show(m);
  assert.equal(shownAfter.last_delivered.body, post.body, 'the delivered receipt is not the sent bytes');
  assert.equal(shownAfter.last_attempt.outcome, 'delivered');
  assert.equal(readdirSync(m.sent).length, 1);

  m.advance(9); // still the same UTC day (22:00)
  for (const args of [['--version'], ['stacks', '--json']]) await m.run(args);
  await m.settle();
  assert.equal(m.calls().length, 1, 'a second document went out the same UTC day');

  // USE-1-06: the next day, show prints exactly what the next send carries.
  m.advance(24);
  const shown = await show(m);
  assert.equal(shown.destination.url, USAGE_URL);
  await m.run(['--help']);
  await m.settle();
  assert.equal(m.calls().length, 2);
  assert.equal(m.calls()[1].body, shown.body, 'show differed from the bytes sent');
  assert.equal(JSON.parse(shown.body).install, document.install);
  assert.equal(JSON.parse(shown.body).since, day(1));
});

// --- USE-1-03 and F7 ------------------------------------------------------------
test('USE-1-03: counts under fixed names; api_calls counts requests to the person\'s APIs, protocol included, not the probe', async t => {
  const m = machine(t);
  const api = await loopbackApi(t);
  await m.run(['--version']);
  assert.equal((await m.run(['stack', 'add', 'local', '--base-url', api, '--json'])).code, 0);
  for (let i = 0; i < 3; i++) {
    const result = await m.run(['request', 'GET', '/ping', '--stack', 'local']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  const redirected = await m.run(['request', 'GET', '/redir', '--stack', 'local']);
  assert.equal(JSON.parse(redirected.stdout).status, 200, redirected.stdout + redirected.stderr);
  writeFileSync(join(m.root, 'graphql.json'), JSON.stringify({ protocol: 'graphql', path: '/graphql', graphql: { document: 'query Probe { state }' } }));
  const protocol = await m.run(['protocol', 'graphql.json', '--stack', 'local']);
  assert.equal(protocol.code, 0, protocol.stdout + protocol.stderr);
  await m.run(['doctor', '--probe', `${api}/ping`]);
  await m.run(['suite', 'list']);
  await m.run(['context', '--env', 'x', 'nonsense']);
  m.advance(25);
  await m.run(['--help']);
  await m.settle();
  const [post] = m.calls();
  const document = JSON.parse(post.body);
  assert.deepEqual(document.features, { context: 1, doctor: 1, protocol: 1, request: 4, stack_add: 1, suite_list: 1, version: 1 });
  assert.equal(document.api_calls, 5, 'three requests, one redirected request and one GraphQL request; not the probe');
  const status = json(await m.run(['telemetry', 'status', '--json']));
  assert.equal(status.last_sent, day(1));
  const next = JSON.parse((await show(m)).body);
  assert.deepEqual(next.features, { help: 1 });
  assert.equal(next.api_calls, 0);
  assert.equal(next.since, day(1));
});

// --- USE-1-04 -------------------------------------------------------------------
test('USE-1-04: off sends nothing, deletes the identifier and counts, and holds across processes and projects; on starts again', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  assert.equal(m.calls().length, 1);
  const oldInstall = JSON.parse(m.calls()[0].body).install;
  m.advance(24);
  await m.run(['stacks', '--json']);
  await m.settle();
  const before = m.calls().length;
  const off = json(await m.run(['telemetry', 'off', '--json']));
  assert.equal(off.state, 'off');
  assert.equal(off.sent, false);
  await m.settle();
  assert.equal(m.calls().length, before, 'opting out sent something');
  const stored = readdirSync(m.state, { recursive: true }).map(name => join(m.state, name))
    .filter(path => statSync(path).isFile()).map(path => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(stored, new RegExp(oldInstall), 'the identifier survived off');
  assert.equal(JSON.parse((await show(m)).body).api_calls, 0);
  const other = join(m.parent, 'second-project');
  mkdirSync(other);
  for (const cwd of [m.root, other]) for (const args of [['--version'], ['stacks', '--json'], ['--help']]) {
    m.advance(25);
    const result = await m.run(args, { cwd });
    assert.doesNotMatch(result.stderr, NOTICE);
  }
  await m.settle();
  assert.equal(m.calls().length, before, 'a request was made while off');
  assert.equal(existsSync(m.counts), false, 'a command was counted while off');
  assert.equal(existsSync(m.sent), false, 'a document was prepared while off');
  assert.equal(json(await m.run(['telemetry', 'status', '--json'])).state, 'off');

  assert.equal(json(await m.run(['telemetry', 'on', '--json'])).state, 'on');
  await m.run(['--version']);
  await m.settle();
  assert.equal(m.calls().length, before + 1);
  const fresh = JSON.parse(m.calls().at(-1).body);
  assert.notEqual(fresh.install, oldInstall);
  assert.equal(fresh.since, null);
  assert.deepEqual(fresh.features, {}, 'counts from before off survived it');
  assert.equal(fresh.api_calls, 0);
});

// --- A5a / F1 ------------------------------------------------------------------
test('A5a: off racing a send in progress is never undone, and nothing is sent afterwards', async t => {
  for (let i = 0; i < 12; i++) {
    const m = machine(t);
    await m.run(['--version']);
    m.advance(25);
    m.setMode('slow');
    const due = m.run(['stacks', '--json']);
    await new Promise(resolve => setTimeout(resolve, (i % 6) * 15));
    const off = await m.run(['telemetry', 'off', '--json']);
    await due;
    assert.equal(json(off).state, 'off');
    await m.settle();
    assert.equal(json(await m.run(['telemetry', 'status', '--json'])).state, 'off', `run ${i}: off was undone`);
    const seen = usagePosts(m).length;
    assert.ok(seen <= 1, `run ${i}: ${seen} documents`);
    m.setMode('accept');
    for (let d = 0; d < 2; d++) { m.advance(25); await m.run(['--version']); await m.settle(); }
    assert.equal(usagePosts(m).length, seen, `run ${i}: sending continued after off`);
  }
});

// --- A5b / F3 ------------------------------------------------------------------
test('A5b: off holds for every process run with this home directory, whatever SANNR_HOME it uses', async t => {
  const m = machine(t);
  const other = join(m.parent, 'other-state');
  assert.equal(json(await m.run(['telemetry', 'off', '--json'])).state, 'off');
  assert.ok(existsSync(join(m.home, `.${PRODUCT}`, 'telemetry.off')), 'off was not recorded for the home directory');
  const result = await m.run(['--version'], { env: { [HOME_ENV_NAME]: other } });
  assert.doesNotMatch(result.stderr, NOTICE);
  assert.equal(existsSync(join(other, 'telemetry.json')), false);
  const status = json(await m.run(['telemetry', 'status', '--json'], { env: { [HOME_ENV_NAME]: other } }));
  assert.equal(status.state, 'off');
  const server = mcp(t, m, { [HOME_ENV_NAME]: other });
  await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  const reply = (await server.call(2, { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } })).msg;
  assert.equal(reply.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  await server.close();
  assert.equal(existsSync(join(other, 'telemetry.json')), false);
  await gitInit(m.root);
  const connect = json(await m.run(['connect', '--json'], { env: { [HOME_ENV_NAME]: other } }));
  assert.equal(connect.telemetry_notice, undefined, 'connect showed the notice while the home is off');
  assert.equal(existsSync(join(other, 'telemetry.json')), false);
});

// --- USE-1-05 and A17 ----------------------------------------------------------
test('USE-1-05: every environment switch and CI variable means no count, identifier, request, notice or state', async t => {
  const switches = [[TELEMETRY_ENV_NAME, '0'], [TELEMETRY_ENV_NAME, 'off'], [TELEMETRY_ENV_NAME, 'false'], [TELEMETRY_ENV_NAME, 'NO'],
    ['DO_NOT_TRACK', '1'], ['CI', 'true'], ['CI', '1'], ...CI_VARIABLES.map(name => [name, 'true'])];
  for (const [name, value] of switches) {
    const m = machine(t);
    const result = await m.run(['--version'], { env: { [name]: value } });
    await m.run(['stacks', '--json'], { env: { [name]: value } });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, NOTICE, `${name}=${value} showed the notice`);
    assert.equal(existsSync(m.state), false, `${name}=${value} wrote state`);
    const status = json(await m.run(['telemetry', 'status', '--json'], { env: { [name]: value } }));
    assert.equal(status.state, 'off');
    assert.equal(status.reason.variable, name);
    await m.run(['--version']);
    m.advance(25);
    await m.run(['stacks', '--json'], { env: { [name]: value } });
    await m.run(['--version'], { env: { [name]: value } });
    await m.settle();
    assert.deepEqual(m.calls(), [], `${name}=${value} sent`);
    assert.deepEqual(JSON.parse((await show(m)).body).features, { version: 1 }, `${name}=${value} counted`);
  }
  for (const value of ['0', 'false']) {
    const m = machine(t);
    assert.match((await m.run(['--version'], { env: { CI: value } })).stderr, NOTICE, `CI=${value} is not a CI environment`);
  }
});

test('A17: a source checkout never counts or sends unless a test names the checkout', async t => {
  if (!IS_CHECKOUT) { t.skip('this package is not a source checkout'); return; }
  for (const value of [undefined, '', '1', 'true', '/', join(ROOT, 'lib')]) {
    const m = machine(t);
    const env = value === undefined ? {} : { [TELEMETRY_CHECKOUT_ENV_NAME]: value };
    if (value === undefined) delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
    const result = await m.run(['--version'], { env });
    assert.doesNotMatch(result.stderr, NOTICE, `checkout switch ${value} showed the notice`);
    await m.run(['stacks', '--json'], { env });
    assert.equal(existsSync(m.state), false, `checkout switch ${value} wrote state`);
    const status = json(await m.run(['telemetry', 'status', '--json'], { env }));
    assert.equal(status.state, 'off');
    assert.equal(status.reason.source, 'checkout');
  }
});

test('A17c: a source tree without .git never counts; a packed copy behaves as an installed package', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-trees-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  // A source copy as a ZIP download or an archive gives it: no .git.
  const source = join(parent, 'source');
  for (const entry of ['bin', 'lib', 'skill', 'stacks', 'server.mjs', 'package.json', 'scripts', 'test'])
    cpSync(join(ROOT, entry), join(source, entry), { recursive: true, filter: from => !from.includes(`${join('test', 'fixtures')}`) });
  assert.equal(existsSync(join(source, '.git')), false);
  // The packed copy npm makes from this tree.
  const packDir = join(parent, 'pack'), packed = join(parent, 'packed');
  mkdirSync(packDir); mkdirSync(packed);
  const pack = spawn('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packDir], { cwd: ROOT, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => pack.once('close', resolve)), 0, 'npm pack failed');
  const tarball = join(packDir, readdirSync(packDir).find(name => name.endsWith('.tgz')));
  const untar = spawn('tar', ['-xzf', tarball, '-C', packed], { stdio: 'ignore' });
  assert.equal(await new Promise(resolve => untar.once('close', resolve)), 0);
  const packedRoot = join(packed, 'package');
  assert.equal(existsSync(join(packedRoot, 'test')) || existsSync(join(packedRoot, 'scripts', 'test-unit.mjs')) || existsSync(join(packedRoot, '.git')), false,
    'the packed copy contains a source-tree marker');
  for (const [tree, root, counts] of [['source copy', source, false], ['packed copy', packedRoot, true]]) {
    const m = machine(t);
    delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
    const cli = join(root, 'bin', 'cli.mjs');
    const go = args => new Promise(resolve => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: m.root, env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    const first = await go(['--version']);
    assert.equal(first.code, 0, first.stderr);
    if (counts) {
      assert.match(first.stderr, NOTICE, `${tree}: an installed package shows the notice`);
      assert.ok(existsSync(m.stateFile));
    } else {
      assert.doesNotMatch(first.stderr, NOTICE, `${tree} counted`);
      assert.equal(existsSync(m.state), false, `${tree} wrote telemetry state`);
      assert.equal(JSON.parse((await go(['telemetry', 'status', '--json'])).stdout).reason.source, 'checkout');
    }
  }
});

// --- USE-1-07 -------------------------------------------------------------------
test('USE-1-07: a failing, refusing, redirecting or silent endpoint changes no output or exit code, and counts wait for a 2xx', async t => {
  for (const mode of ['throw', '400', '429', '500', '503', 'redirect', 'hang']) {
    const m = machine(t);
    await m.run(['--version']);
    await m.run(['stacks', '--json']);
    m.advance(25);
    m.setMode(mode);
    const runs = mode === 'hang' ? 2 : 4;
    for (let i = 0; i < runs; i++) {
      for (const args of [['--version'], ['stacks', '--json'], ['telemetry', 'status', '--json']]) {
        const offRun = await m.run(args, { env: { [TELEMETRY_ENV_NAME]: '0' } });
        const onRun = await m.run(args);
        assert.equal(onRun.code, offRun.code, `${mode}: ${args.join(' ')} exit`);
        if (args[0] !== 'telemetry') assert.equal(onRun.stdout, offRun.stdout, `${mode}: ${args.join(' ')} stdout`);
        assert.equal(onRun.stderr, offRun.stderr, `${mode}: ${args.join(' ')} stderr`);
        if (mode === 'hang' && args[0] === '--version')
          assert.ok(onRun.ms - offRun.ms <= 1000, `${mode}: --version waited ${onRun.ms - offRun.ms} ms for the network`);
      }
      await m.settle();
    }
    const attempts = usagePosts(m);
    assert.ok(attempts.length >= 1 && attempts.length <= 3, `${mode}: ${attempts.length} attempts`);
    if (mode !== 'hang') assert.equal(attempts.length, 3, `${mode}: retries in a day`);
    const failed = await show(m);
    assert.equal(failed.last_delivered, null, `${mode}: a failed attempt reads as delivered`);
    assert.equal(failed.last_attempt.outcome, 'not-delivered');
    // The next UTC day, an accepting endpoint receives the counts kept so far.
    m.setMode('accept');
    m.advance(24);
    await m.run(['--help']);
    await m.settle();
    const delivered = JSON.parse(usagePosts(m).at(-1).body);
    assert.equal(usagePosts(m).length, attempts.length + 1, `${mode}: no delivery after recovery`);
    assert.ok(delivered.features.stacks >= 1 + runs, `${mode}: counts were lost: ${JSON.stringify(delivered.features)}`);
    assert.equal(delivered.install, JSON.parse(attempts[0].body).install);
  }
});

// --- USE-1-08 and F9 -------------------------------------------------------------
test('USE-1-08: JSON stays JSON with the notice pending, connect carries it as a field, and a dry run writes and sends nothing', async t => {
  for (const args of [['stacks', '--json'], ['telemetry', 'status', '--json'], ['telemetry', 'show', '--json'],
    ['capabilities', '--json'], ['doctor', '--offline', '--json']]) {
    const m = machine(t);
    const result = await m.run(args);
    json(result);
    if (args[0] !== 'telemetry') assert.match(result.stderr, NOTICE);
  }
  const m = machine(t);
  await gitInit(m.root);
  const dry = json(await m.run(['connect', '--dry-run', '--json']));
  assert.equal(dry.telemetry_notice, undefined, 'a dry run recorded the notice');
  assert.equal(existsSync(m.state), false, 'a dry run wrote telemetry state');
  const connect = await m.run(['connect', '--json']);
  assert.match(json(connect).telemetry_notice, NOTICE);
  assert.doesNotMatch(connect.stderr, NOTICE);
  assert.equal(json(await m.run(['connect', '--json'])).telemetry_notice, undefined);
  m.advance(25);
  const before = readFileSync(m.stateFile, 'utf8');
  await m.run(['migrate', '--dry-run', '--json']);
  await m.run(['connect', '--dry-run', '--json']);
  await m.settle();
  assert.deepEqual(m.calls(), [], 'a dry run started the daily send');
  assert.equal(readFileSync(m.stateFile, 'utf8'), before);
  const human = machine(t);
  await gitInit(human.root);
  assert.match((await human.run(['connect'])).stdout, NOTICE);
});

// --- A14a / F5 -----------------------------------------------------------------
test('A14a: the pointer block connect writes and the request skill say what "opt out" means', async t => {
  // Both shapes of the block: a repository with no API stack yet, and one with a stack.
  for (const withStack of [false, true]) {
    const m = machine(t);
    await gitInit(m.root);
    if (withStack) assert.equal((await m.run(['stack', 'add', 'local', '--base-url', 'http://127.0.0.1:9', '--json'])).code, 0);
    assert.equal((await m.run(['connect', '--json'])).code, 0);
    let blocks = 0;
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      if (!existsSync(join(m.root, file))) continue;
      const text = readFileSync(join(m.root, file), 'utf8');
      if (!text.includes(`<!-- ${PRODUCT}:begin -->`)) continue;
      blocks++;
      assert.match(text, /usage counts once a day unless turned off; if a person says "opt out", run .*telemetry off/, `${file} (stack: ${withStack})`);
    }
    assert.ok(blocks >= 1, 'connect wrote no pointer block');
  }
  assert.match(readFileSync(join(ROOT, 'skill/SKILL.md'), 'utf8'), /"opt out", run `\w+ telemetry off`/);
});

// --- USE-1-09 -------------------------------------------------------------------
// The server is killed when the test ends, passed or failed, and every wait
// for a reply has a deadline, so a broken behavior fails instead of hanging.
function mcp(t, m, extraEnv = {}, { unset = [], env: baseEnv = m.env } = {}) {
  // `unset` names variables the server starts without, as a host that never
  // passes them would start it (through env -u, which the test helper cannot fill).
  const [command, args] = unset.length ? ['/usr/bin/env', [...unset.flatMap(name => ['-u', name]), process.execPath, CLI, 'mcp', 'serve']]
    : [process.execPath, [CLI, 'mcp', 'serve']];
  const child = spawn(command, args, { cwd: m.root, env: { ...baseEnv, API_CONTEXT_DIR: m.root, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const replies = new Map(), waiters = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const parts = buffer.split('\n'); buffer = parts.pop();
    for (const part of parts) if (part.trim()) {
      const msg = JSON.parse(part);
      replies.set(msg.id, { msg, at: performance.now() });
      waiters.get(msg.id)?.();
    }
  });
  const call = (id, message) => new Promise((resolve, reject) => {
    const sent = performance.now();
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`MCP reply ${id} did not arrive within 15 s`)); }, 15_000);
    waiters.set(id, () => { clearTimeout(timer); resolve({ ...replies.get(id), ms: replies.get(id).at - sent }); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
  });
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited; clearTimeout(timer);
  };
  return { call, close };
}

test('USE-1-09: the MCP server counts tool calls, relays the notice once and sends in the background', async t => {
  const m = machine(t);
  const server = mcp(t, m);
  await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  const tool = { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } };
  const first = (await server.call(2, tool)).msg;
  const texts = first.result.content.map(block => block.text);
  assert.equal(texts.filter(text => NOTICE.test(text)).length, 1, JSON.stringify(texts));
  assert.doesNotThrow(() => JSON.parse(texts[0]), 'the tool result moved from the first block');
  const second = (await server.call(3, tool)).msg;
  assert.equal(second.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  await server.call(4, { method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  await server.close();
  assert.deepEqual(JSON.parse((await show(m)).body).features, { mcp_api_saved_requests: 1 },
    'the call before the notice is counted, or an undeclared name was');

  m.advance(25);
  m.setMode('hang');
  const later = mcp(t, m);
  await later.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  const reply = await later.call(2, tool);
  assert.ok(reply.ms < 3000, `the tool result waited ${reply.ms} ms for the send`);
  assert.equal(reply.msg.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  await later.close();
  await m.settle();
  assert.equal(usagePosts(m).length, 1, 'no document went out in the background');
  assert.deepEqual(JSON.parse(usagePosts(m)[0].body).features, { mcp_api_saved_requests: 1 });
});

// --- USE-1-10 -------------------------------------------------------------------
test('USE-1-10: no folder, repository, host, path, header, credential name or machine identity leaves', async t => {
  const m = machine(t, { project: 'zqfolder-private-name' });
  const api = await loopbackApi(t);
  const port = new URL(api).port;
  const secret = 'zq-credential-value-7781';
  const env = { ZQ_CREDENTIAL_VARIABLE: secret };
  await gitInit(m.root);
  const remote = spawn('git', ['remote', 'add', 'origin', 'https://example.invalid/zqowner/zqrepository-name.git'], { cwd: m.root });
  await new Promise(resolve => remote.once('close', resolve));
  await m.run(['--version'], { env });
  assert.equal((await m.run(['stack', 'add', 'zqstackname', '--base-url', api, '--auth', 'header:X-Zqheader-Name:ZQ_CREDENTIAL_VARIABLE'], { env })).code, 0);
  for (const path of ['/zqpath-private/one', '/zqpath-private/two?zqquery=zqvalue'])
    await m.run(['request', 'GET', path, '--stack', 'zqstackname'], { env });
  m.advance(25);
  await m.run(['stacks', '--json'], { env });
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
  const receipts = readdirSync(m.sent).map(name => readFileSync(join(m.sent, name), 'utf8'));
  const bytes = [...usagePosts(m).map(call => JSON.stringify({ ...call, cwd: undefined })), ...receipts].join('\n').toLowerCase();
  const known = ['zqfolder', 'zqrepository', 'zqowner', 'zqstackname', 'zqpath', 'zqquery', 'zqvalue', 'zqheader', 'zq_credential',
    'zq-credential', secret, '127.0.0.1', `:${port}`, m.parent.toLowerCase(), userInfo().username.toLowerCase(), hostname().toLowerCase()];
  for (const value of known) assert.equal(bytes.includes(value), false, `${value} left the machine`);
  assert.equal(JSON.parse(usagePosts(m)[0].body).api_calls, 2);
});

// --- USE-1-11 and F11 ------------------------------------------------------------
test('USE-1-11: a corrupt state file, a read-only or file state directory: commands work, nothing is sent, status says why', async t => {
  const corrupt = machine(t);
  mkdirSync(corrupt.state);
  writeFileSync(corrupt.stateFile, '{"v":1,"state":"on",');
  const cases = [[corrupt, 'TELEMETRY_STATE_INVALID']];
  const asFile = machine(t);
  writeFileSync(asFile.state, 'not a directory');
  cases.push([asFile, 'TELEMETRY_STATE_DIRECTORY_INVALID']);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const readOnly = machine(t);
    mkdirSync(readOnly.state);
    chmodSync(readOnly.state, 0o500);
    cases.push([readOnly, 'TELEMETRY_STATE_UNWRITABLE']);
  } else t.diagnostic('read-only state directory case skipped: Windows or root');
  for (const [m, code] of cases) {
    for (const args of [['--version'], ['stacks', '--json']]) {
      const off = await m.run(args, { env: { [TELEMETRY_ENV_NAME]: '0' } });
      const on = await m.run(args);
      assert.equal(on.code, off.code, `${code}: ${args[0]}`);
      assert.equal(on.stdout, off.stdout, `${code}: ${args[0]}`);
      assert.doesNotMatch(on.stderr, NOTICE, `${code}: a notice it cannot record`);
    }
    await m.settle().catch(() => {});
    assert.deepEqual(m.calls(), [], `${code}: sent`);
    const status = json(await m.run(['telemetry', 'status', '--json']));
    assert.equal(status.state, 'unavailable', code);
    assert.equal(status.problem?.code, code);
  }
  // connect records its notice itself; a damaged record is still not replaced.
  await gitInit(corrupt.root);
  const before = readFileSync(corrupt.stateFile, 'utf8');
  assert.equal(json(await corrupt.run(['connect', '--json'])).telemetry_notice, undefined, 'connect showed a notice it cannot record');
  assert.equal(readFileSync(corrupt.stateFile, 'utf8'), before, 'connect replaced a damaged state file');
  // off replaces a corrupt record, which is the person's way out.
  assert.equal(json(await corrupt.run(['telemetry', 'off', '--json'])).state, 'off');
});

test('F11: a broken or abandoned send lock does not stop sending; a live one holds', async t => {
  for (const kind of ['file', 'empty', 'old', 'future']) {
    const m = machine(t);
    await m.run(['--version']);
    m.advance(25);
    mkdirSync(join(m.state, 'telemetry'), { recursive: true });
    if (kind === 'file') writeFileSync(m.lock, 'stray');
    else {
      mkdirSync(m.lock);
      const created = kind === 'old' ? START + 25 * 3_600_000 - 10 * 60_000 : START + 30 * 86_400_000;
      if (kind !== 'empty') writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'abandoned', created_at: created, pid: 1 }));
    }
    assert.match(json(await m.run(['telemetry', 'status', '--json'])).send_lock, /stale/, kind);
    await m.run(['--version']);
    await m.settle().catch(error => { throw new Error(`${kind}: ${error.message}; lock now ${existsSync(m.lock) ? readdirSync(m.lock).join(',') : 'gone'}`); });
    assert.equal(usagePosts(m).length, 1, `${kind}: the lock stopped the send`);
  }
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  mkdirSync(m.lock, { recursive: true });
  writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'live', created_at: START + 25 * 3_600_000, pid: process.pid }));
  await m.run(['--version']);
  assert.deepEqual(usagePosts(m), [], 'a live lock was taken');
  assert.match(json(await m.run(['telemetry', 'status', '--json'])).send_lock, /held/);
});

// --- USE-1-12 -------------------------------------------------------------------
// --- Amendment 4 -------------------------------------------------------------------

// Off, once returned, holds: whichever command or sender races it, the state
// stays off and nothing is sent later, until telemetry on.
async function offHolds(m, label) {
  await m.settle();
  assert.equal(json(await m.run(['telemetry', 'status', '--json'])).state, 'off', `${label}: off was undone`);
  const seen = usagePosts(m).length;
  m.setMode('accept');
  for (let d = 0; d < 2; d++) { m.advance(25); await m.run(['--version']); await m.settle(); }
  assert.equal(usagePosts(m).length, seen, `${label}: sending continued after off`);
}

test('A5d: every writer of the state goes through the lock; nothing but on turns a recorded off into on', async t => {
  const racers = {
    reset: m => m.run(['telemetry', 'reset', '--json']),
    sender: m => m.run(['stacks', '--json']),
    'reset+sender': m => Promise.all([m.run(['telemetry', 'reset', '--json']), m.run(['stacks', '--json'])]),
  };
  for (const [name, racer] of Object.entries(racers)) for (let i = 0; i < 8; i++) {
    const m = machine(t);
    await m.run(['--version']);
    m.advance(25);
    m.setMode('slow');
    const before = i % 2 === 0;
    const first = before ? racer(m) : m.run(['telemetry', 'off', '--json']);
    await new Promise(resolve => setTimeout(resolve, (i % 4) * 10));
    const second = before ? m.run(['telemetry', 'off', '--json']) : racer(m);
    await Promise.all([first, second]);
    await offHolds(m, `${name} ${before ? 'before' : 'after'} off, run ${i}`);
  }
});

test('A5e: off reaches every state directory: old identifiers and counts are discarded, and on revives none', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), other = join(m.parent, 'other-state');
  const inOther = { [HOME_ENV_NAME]: other }, inUser = { [HOME_ENV_NAME]: user };
  await m.run(['--version'], { env: inOther });
  m.advance(25);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const old = JSON.parse(usagePosts(m)[0].body).install;
  await m.run(['stacks', '--json'], { env: inOther });
  assert.equal(json(await m.run(['telemetry', 'off', '--json'], { env: inUser })).scope, 'home');
  await m.run(['--help'], { env: inOther });
  assert.equal(m.readState(join(other, 'telemetry.json')).install, null, 'the other directory kept its identifier while off');
  assert.equal(existsSync(join(other, 'telemetry', 'counts.jsonl')), false, 'the other directory kept its counts while off');
  const on = json(await m.run(['telemetry', 'on', '--json'], { env: inUser }));
  assert.equal(on.state, 'on');
  m.advance(24);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const next = JSON.parse(usagePosts(m).at(-1).body);
  assert.equal(usagePosts(m).length, 2);
  assert.notEqual(next.install, old, 'on revived an old identifier');
  assert.equal(next.since, null);
  assert.deepEqual(next.features, {}, 'counts from before off were sent');
});

test('A5e: a directory not touched while off still discards its old data after on', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), other = join(m.parent, 'other-state');
  const inOther = { [HOME_ENV_NAME]: other }, inUser = { [HOME_ENV_NAME]: user };
  await m.run(['--version'], { env: inOther });
  m.advance(25);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const old = JSON.parse(usagePosts(m)[0].body).install;
  await m.run(['stacks', '--json'], { env: inOther });
  await m.run(['telemetry', 'off', '--json'], { env: inUser });
  await m.run(['telemetry', 'on', '--json'], { env: inUser });
  m.advance(24);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  const next = JSON.parse(usagePosts(m).at(-1).body);
  assert.notEqual(next.install, old);
  assert.deepEqual(next.features, {});
});

test('A5f: off never claims more than it recorded, and exits 1 when it could not record off for the user', async t => {
  const m = machine(t);
  writeFileSync(join(m.home, `.${PRODUCT}`), 'a file where the default state directory should be');
  const human = await m.run(['telemetry', 'off']);
  assert.equal(human.code, 1, human.stdout + human.stderr);
  assert.match(human.stdout, /^Telemetry is off only for /);
  assert.doesNotMatch(human.stdout, /for every .* process run with the home directory/);
  const value = json(await m.run(['telemetry', 'off', '--json']));
  assert.equal(value.ok, false);
  assert.equal(value.scope, 'directory');
  // Another state directory still counts, which is exactly what it said.
  const other = join(m.parent, 'other-state');
  assert.match((await m.run(['--version'], { env: { [HOME_ENV_NAME]: other } })).stderr, NOTICE);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const none = machine(t);
    mkdirSync(none.state);
    chmodSync(none.state, 0o500);
    chmodSync(none.home, 0o500);
    const result = await none.run(['telemetry', 'off']);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^Telemetry could not be turned off/);
  }
  const ok = machine(t);
  const recorded = await ok.run(['telemetry', 'off']);
  assert.equal(recorded.code, 0);
  assert.match(recorded.stdout, /^Telemetry is off for every \w+ process run with the home directory .*, recorded in .*telemetry\.off/);
});

test('N5, N7: the day\'s document survives off, on and reset, and on says what it lifted', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  await m.run(['telemetry', 'off', '--json']);
  const on = json(await m.run(['telemetry', 'on', '--json']));
  assert.equal(on.home_off_lifted, true);
  assert.match((await m.run(['telemetry', 'off'])) && (await m.run(['telemetry', 'on'])).stdout, /The off recorded for the home directory .* is lifted, so \w+ processes run with it can count again/);
  await m.run(['telemetry', 'reset', '--json']);
  await m.run(['stacks', '--json']);
  await m.settle();
  assert.equal(usagePosts(m).length, 1, 'off, on or reset added a document to the day');
  m.advance(24);
  await m.run(['--version']);
  await m.settle();
  assert.equal(usagePosts(m).length, 2);
});

test('N8: a lock left by a process that has ended is neither waited for nor called a send in progress', async t => {
  const dead = spawn(process.execPath, ['-e', '0']);
  const pid = dead.pid;
  await new Promise(resolve => dead.once('close', resolve));
  const m = machine(t);
  await m.run(['--version']);
  mkdirSync(m.lock, { recursive: true });
  writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'ended', created_at: START, pid }));
  assert.match(json(await m.run(['telemetry', 'status', '--json'])).send_lock, /ended/);
  const off = await m.run(['telemetry', 'off', '--json']);
  assert.equal(json(off).ok, true);
  assert.ok(off.ms < 4000, `off waited ${Math.round(off.ms)} ms for a process that has ended`);
});

test('N9: a command run with --offline starts no send', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['doctor', '--offline', '--json']);
  await m.run(['stacks', '--json', '--offline']);
  await m.settle();
  assert.deepEqual(usagePosts(m), []);
  await m.run(['--version']);
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
});

test('N10: the day is the UTC day, whatever the time zone', async t => {
  for (const TZ of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const m = machine(t);
    await m.run(['--version'], { env: { TZ } });
    m.advance(25); // 13:00 UTC: already the next local day in Kiritimati
    await m.run(['--version'], { env: { TZ } });
    await m.settle();
    m.advance(10); // 23:00 UTC: the same UTC day, a different local day in both zones
    await m.run(['--version'], { env: { TZ } });
    await m.settle();
    assert.equal(usagePosts(m).length, 1, `${TZ}: a second document in one UTC day`);
    m.advance(2); // 01:00 UTC the next day
    await m.run(['--version'], { env: { TZ } });
    await m.settle();
    assert.equal(usagePosts(m).length, 2, `${TZ}: no document on the next UTC day`);
  }
});

test('A17a: a test run never counts or sends, and a packed copy run as the package test runs it leaves no state', async t => {
  for (const name of ['NODE_TEST_CONTEXT', 'VITEST', 'JEST_WORKER_ID']) {
    const m = machine(t);
    const result = await m.run(['--version'], { env: { [name]: name === 'NODE_TEST_CONTEXT' ? 'child-v8' : '1' } });
    assert.doesNotMatch(result.stderr, NOTICE, name);
    assert.equal(existsSync(m.state), false, `${name}: state written`);
    assert.equal(json(await m.run(['telemetry', 'status', '--json'], { env: { [name]: '1' } })).reason.source, 'test');
  }
  // A copy without .git behaves as an installed package. Run it the way
  // test/package.test.mjs runs its packed copy: the test process's own
  // environment, which carries the test runner's mark, and only HOME moved.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-packed-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const copy = join(parent, 'package'), home = join(parent, 'home');
  mkdirSync(home);
  for (const entry of ['bin', 'lib', 'skill', 'stacks', 'server.mjs', 'package.json', 'docs'])
    cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  cpSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'), { recursive: true });
  assert.equal(existsSync(join(copy, '.git')), false);
  if (!process.env.NODE_TEST_CONTEXT) { t.diagnostic('packed-copy half skipped: this file was not run by node --test, so there is no runner mark to inherit (the A17b test covers a run without it)'); return; }
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env[HOME_ENV_NAME]; delete env.DO_NOT_TRACK; delete env[TELEMETRY_ENV_NAME]; delete env.CI;
  for (const name of CI_VARIABLES) delete env[name];
  const packed = args => new Promise(resolve => {
    const child = spawn(process.execPath, [join(copy, 'bin/cli.mjs'), ...args], { cwd: parent, env, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
  await packed(['--help']);
  await packed(['map', '.', '--text', '--no-execute']);
  assert.equal(existsSync(join(home, `.${PRODUCT}`, 'telemetry.json')), false, 'the packed copy wrote telemetry state in a test run');
  assert.equal(existsSync(join(home, `.${PRODUCT}`, 'telemetry')), false);
});

// --- Amendment 5 -------------------------------------------------------------------

test('A5g: off is a marker written at once: it never waits for a sender, and a sender that wakes after it sends nothing', async t => {
  for (const kind of ['stalled before its check', 'hanging request']) {
    // The second case runs in the home's own default directory.
    const m = machine(t, { stateInHome: kind === 'hanging request' });
    await m.run(['--version']);
    m.advance(25);
    if (kind === 'stalled before its check') m.stallSender(1500); else m.setMode('hang');
    await m.run(['stacks', '--json']); // starts the sender
    const off = await m.run(['telemetry', 'off', '--json']);
    assert.equal(json(off).ok, true);
    assert.ok(off.ms < 1000, `${kind}: off took ${Math.round(off.ms)} ms`);
    assert.ok(existsSync(join(m.state, 'telemetry.off')) && existsSync(join(m.home, `.${PRODUCT}`, 'telemetry.off')));
    const atOff = usagePosts(m).length;
    m.stallSender(0);
    await m.settle();
    if (kind === 'stalled before its check') assert.equal(usagePosts(m).length, 0, 'a sender that woke after off sent');
    else assert.ok(usagePosts(m).length <= atOff + 0, 'a request started after off');
    // The identifier and counts the sender held are cleared at the next use.
    await m.run(['stacks', '--json']);
    assert.equal(m.readState().install, null, `${kind}: the identifier survived off`);
    assert.equal(existsSync(m.counts) || existsSync(m.sent), false, `${kind}: counts or receipts survived off`);
    await offHolds(m, kind);
  }
});

test('A5g: on straight after an off that a send was holding keeps nothing from before', async t => {
  const m = machine(t);
  await m.run(['--version']);
  await m.run(['stacks', '--json']);
  m.advance(25);
  m.setMode('hang');
  await m.run(['stacks', '--json']); // the sender holds the lock with the counts
  await m.run(['telemetry', 'off', '--json']);
  const on = json(await m.run(['telemetry', 'on', '--json']));
  assert.equal(on.ok, true);
  await m.settle();
  m.setMode('accept');
  m.advance(24);
  await m.run(['--help']);
  await m.settle();
  const last = JSON.parse(usagePosts(m).at(-1).body);
  assert.deepEqual(last.features, {}, 'on revived counts from before off');
  assert.equal(last.since, null);
});

test('A5h: a damaged or lost record of the home means off, and a directory that has seen the home off remembers it', async t => {
  const user = m => join(m.home, `.${PRODUCT}`), other = m => join(m.parent, 'other-state');
  for (const damage of ['marker', 'record']) {
    const m = machine(t);
    const inOther = { [HOME_ENV_NAME]: other(m) };
    await m.run(['--version'], { env: inOther });
    m.advance(25);
    mkdirSync(user(m), { recursive: true });
    writeFileSync(join(user(m), damage === 'marker' ? 'telemetry.off' : 'telemetry.json'), '{"v":1,"state":');
    await m.run(['--version'], { env: inOther });
    await m.settle();
    assert.deepEqual(usagePosts(m), [], `a damaged home ${damage} did not hold off`);
    const status = json(await m.run(['telemetry', 'status', '--json'], { env: inOther }));
    assert.equal(status.state, 'off');
    assert.match(status.reason.source, /damaged/);
  }
  const m = machine(t);
  const inOther = { [HOME_ENV_NAME]: other(m) }, inUser = { [HOME_ENV_NAME]: user(m) };
  await m.run(['--version'], { env: inOther });
  await m.run(['telemetry', 'off', '--json'], { env: inUser });
  await m.run(['stacks', '--json'], { env: inOther }); // sees the home's off
  rmSync(user(m), { recursive: true, force: true }); // the home's record is lost
  m.advance(25);
  await m.run(['--version'], { env: inOther });
  await m.settle();
  assert.deepEqual(usagePosts(m), [], 'losing the home record turned another directory back on');
  // Off run in a directory of its own holds there when the home's files are lost.
  const own = machine(t);
  await own.run(['--version']);
  await own.run(['telemetry', 'off', '--json']);
  rmSync(join(own.home, `.${PRODUCT}`), { recursive: true, force: true });
  own.advance(25);
  await own.run(['--version']);
  await own.settle();
  assert.deepEqual(usagePosts(own), [], 'off in a directory did not hold once the home was lost');
  // A marker of the directory itself that cannot be read means off.
  const damaged = machine(t);
  await damaged.run(['--version']);
  writeFileSync(join(damaged.state, 'telemetry.off'), 'not json');
  damaged.advance(25);
  await damaged.run(['--version']);
  await damaged.settle();
  assert.deepEqual(usagePosts(damaged), []);
  assert.equal(json(await damaged.run(['telemetry', 'status', '--json'])).reason.source, 'marker_damaged');
  // A record that says off holds off even without a marker.
  const plain = machine(t);
  await plain.run(['--version']);
  writeFileSync(plain.stateFile, JSON.stringify({ ...plain.readState(), state: 'off' }));
  plain.advance(25);
  await plain.run(['--version']);
  await plain.settle();
  assert.deepEqual(usagePosts(plain), []);
});

test('A5k: off marks every state directory at once; one nobody used while off stays off when the home is lost', async t => {
  for (const loss of ['deleted', 'moved', 'another HOME']) {
    const m = machine(t);
    const user = join(m.home, `.${PRODUCT}`), b = join(m.parent, 'other-state');
    const inB = { [HOME_ENV_NAME]: b }, inUser = { [HOME_ENV_NAME]: user };
    await m.run(['--version'], { env: inB });
    m.advance(25);
    await m.run(['--version'], { env: inB });
    await m.settle();
    await m.run(['map', '.', '--text', '--no-execute'], { env: inB });
    const sentBefore = usagePosts(m).length;
    const off = json(await m.run(['telemetry', 'off', '--json'], { env: inUser }));
    assert.ok(off.other_directories.includes(b), `${loss}: off did not mark the other directory`);
    assert.ok(existsSync(join(b, 'telemetry.off')));
    // B is not used while off. Then the home's files go away.
    if (loss === 'deleted') rmSync(user, { recursive: true, force: true });
    if (loss === 'moved') renameSync(user, `${user}-aside`);
    const other = loss === 'another HOME' ? { HOME: join(m.parent, 'another-home'), USERPROFILE: join(m.parent, 'another-home') } : {};
    for (let day = 0; day < 3; day++) {
      m.advance(25);
      await m.run(['stacks', '--json'], { env: { ...inB, ...other } });
      await m.settle();
    }
    assert.equal(usagePosts(m).length, sentBefore, `${loss}: the directory nobody used while off sent`);
    assert.equal(existsSync(join(b, 'telemetry', 'counts.jsonl')), false, `${loss}: the directory nobody used while off counted`);
  }
});

test('A5k, F6: on lifts the markers off put in other directories, keeps those that turned themselves off, and names them', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), b = join(m.parent, 'other-state'), c = join(m.parent, 'third-state');
  const inUser = { [HOME_ENV_NAME]: user };
  for (const dir of [b, c]) await m.run(['--version'], { env: { [HOME_ENV_NAME]: dir } });
  await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: b } }); // B turns itself off
  await m.run(['telemetry', 'off', '--json'], { env: inUser }); // then the home: C is marked
  assert.ok(existsSync(join(c, 'telemetry.off')));
  const on = json(await m.run(['telemetry', 'on', '--json'], { env: inUser }));
  assert.deepEqual(on.still_off, [b]);
  assert.equal(existsSync(join(c, 'telemetry.off')), false, 'on did not lift the marker off put in C');
  assert.ok(existsSync(join(b, 'telemetry.off')), 'on removed the marker of a directory that turned itself off');
  const text = await m.run(['telemetry', 'off'], { env: inUser }) && await m.run(['telemetry', 'on'], { env: inUser });
  assert.match(text.stdout, /can count again, except in the state directories named below/);
  assert.match(text.stdout, new RegExp(`stay off until telemetry on is run with them: ${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(json(await m.run(['telemetry', 'status', '--json'], { env: { [HOME_ENV_NAME]: b } })).state, 'off');
});

test('F4: a home whose marker cannot be read (mode 000) holds every directory off', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions'); return; }
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), b = join(m.parent, 'other-state');
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: b } });
  rmSync(join(b, 'telemetry.off'), { force: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(join(user, 'telemetry.off'), '{}');
  chmodSync(user, 0o000);
  t.after(() => { try { chmodSync(user, 0o700); } catch { /* removed */ } });
  m.advance(25);
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: b } });
  await m.settle();
  chmodSync(user, 0o700);
  assert.deepEqual(usagePosts(m), [], 'an unreadable home marker did not hold off');
  assert.equal(existsSync(join(b, 'telemetry', 'counts.jsonl')), false);
});

test('A5h: a state directory first used while its home is off keeps that off when the home is lost', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), fresh = join(m.parent, 'fresh-state');
  await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: user } });
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: fresh } }); // first use, while off
  rmSync(user, { recursive: true, force: true });
  const again = await m.run(['--version'], { env: { [HOME_ENV_NAME]: fresh } });
  assert.doesNotMatch(again.stderr, NOTICE, 'a directory first used while off started over once the home was lost');
  m.advance(25);
  await m.run(['stacks', '--json'], { env: { [HOME_ENV_NAME]: fresh } });
  await m.settle();
  assert.deepEqual(usagePosts(m), []);
});

test('A5e: a directory whose send held its lock during off discards its old data after on', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), b = join(m.parent, 'other-state');
  const inB = { [HOME_ENV_NAME]: b }, inUser = { [HOME_ENV_NAME]: user };
  await m.run(['--version'], { env: inB });
  await m.run(['stacks', '--json'], { env: inB });
  m.advance(25);
  m.setMode('hang');
  await m.run(['stacks', '--json'], { env: inB }); // B's sender holds B's lock with B's counts
  const old = m.readState(join(b, 'telemetry.json')).install;
  await m.run(['telemetry', 'off', '--json'], { env: inUser });
  await m.settle();
  await m.run(['telemetry', 'on', '--json'], { env: inUser });
  m.setMode('accept');
  m.advance(24);
  await m.run(['--help'], { env: inB });
  await m.settle();
  const last = JSON.parse(usagePosts(m).at(-1).body);
  assert.notEqual(last.install, old, 'an identifier from before off was sent');
  assert.deepEqual(last.features, {}, 'counts from before off were sent');
});

test('A5i: off racing the first command of a fresh machine always holds', async t => {
  for (let i = 0; i < 20; i++) {
    const m = machine(t);
    const first = m.run(i % 2 ? ['stacks', '--json'] : ['--version']);
    await new Promise(resolve => setTimeout(resolve, i % 5 * 5));
    const off = await m.run(['telemetry', 'off', '--json']);
    await first;
    assert.equal(off.code, 0, off.stdout + off.stderr);
    assert.equal(json(off).ok, true);
    m.advance(25);
    await m.run(['--version']);
    await m.settle();
    assert.deepEqual(usagePosts(m), [], `run ${i}: sent after off`);
  }
});

test('A5d: reset takes the lock: with a live send holding it, reset changes nothing and says why', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  const install = m.readState().install;
  mkdirSync(m.lock, { recursive: true });
  writeFileSync(join(m.lock, 'owner.json'), JSON.stringify({ nonce: 'live', created_at: START + 25 * 3_600_000, pid: process.pid }));
  const reset = await m.run(['telemetry', 'reset', '--json']);
  assert.equal(reset.code, 1);
  assert.match(reset.stderr, /TELEMETRY_STATE_BUSY/);
  assert.equal(m.readState().install, install, 'reset changed the record without the lock');
  rmSync(m.lock, { recursive: true, force: true });
});

test('F6: on and reset name an unwritable directory, not a send in progress', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions'); return; }
  const m = machine(t);
  await m.run(['--version']);
  await m.run(['telemetry', 'off', '--json']);
  chmodSync(join(m.state, 'telemetry'), 0o500);
  chmodSync(m.state, 0o500);
  for (const sub of ['on', 'reset']) {
    const result = await m.run(['telemetry', sub]);
    assert.doesNotMatch(result.stderr, /send in progress/, sub);
    if (result.code !== 0) assert.match(result.stderr, /UNWRITABLE|cannot be written/, sub);
  }
  chmodSync(m.state, 0o700);
  chmodSync(join(m.state, 'telemetry'), 0o700);
});

test('A17b: the packed copy run with plain node and an exported SANNR_HOME leaves no telemetry state and sends nothing', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-canary-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const canary = join(parent, 'home'), state = join(canary, 'state-home'), calls = join(parent, 'calls.jsonl'), preload = join(parent, 'preload.mjs');
  mkdirSync(state, { recursive: true });
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
const actual = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const href = String(url instanceof Request ? url.url : url);
  if (new URL(href).hostname === '127.0.0.1') return actual(url, init);
  appendFileSync(${JSON.stringify(calls)}, href + '\\n');
  throw new Error('blocked by the test harness');
};
`);
  const env = { ...process.env, HOME: canary, USERPROFILE: canary, [HOME_ENV_NAME]: state, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  for (const name of ['TEST_ISOLATED_HOME', 'NODE_TEST_CONTEXT', 'DO_NOT_TRACK', TELEMETRY_ENV_NAME, 'CI', 'API_USAGE_LOG', 'npm_config_cache', ...CI_VARIABLES]) delete env[name];
  const child = spawn(process.execPath, [join(ROOT, 'test/package.test.mjs')], { cwd: ROOT, env, stdio: 'ignore' });
  const timer = setTimeout(() => child.kill("SIGKILL"), 110_000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, 'test/package.test.mjs failed when run with plain node');
  const landed = readdirSync(canary, { recursive: true });
  assert.deepEqual(landed.filter(name => name !== 'state-home'), [], `written into the inherited home: ${landed.join(', ')}`);
  assert.equal(existsSync(calls) ? readFileSync(calls, 'utf8') : '', '', 'a request left the machine');
});

test('USE-1-12: eight commands started together when a document is due send one, whatever the file times say', async t => {
  // Every process's clock is months away from the file system's clock here.
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await Promise.all(Array.from({ length: 8 }, (_, i) => m.run(i % 2 ? ['--version'] : ['stacks', '--json'])));
  await m.settle();
  assert.equal(usagePosts(m).length, 1);
});

// --- F8, F10, F15 and the limits ------------------------------------------------
test('F8: reset makes a new identifier at the next document without adding a document to the day', async t => {
  const m = machine(t);
  await m.run(['--version']);
  m.advance(25);
  await m.run(['--version']);
  await m.settle();
  const first = JSON.parse(usagePosts(m)[0].body).install;
  for (let i = 0; i < 3; i++) {
    assert.equal(json(await m.run(['telemetry', 'reset', '--json'])).ok, true);
    await m.run(['stacks', '--json']);
    await m.settle();
  }
  assert.equal(usagePosts(m).length, 1, 'reset bought another document the same day');
  m.advance(24);
  await m.run(['--version']);
  await m.settle();
  const next = JSON.parse(usagePosts(m).at(-1).body);
  assert.equal(usagePosts(m).length, 2);
  assert.notEqual(next.install, first);
  assert.equal(next.since, null);
});

test('A8/F10: receipts keep the last 30 and say whether each was delivered', async t => {
  const m = machine(t);
  await m.run(['--version']);
  mkdirSync(m.sent, { recursive: true });
  for (let i = 0; i < 35; i++) writeFileSync(join(m.sent, `20260101T0000${String(i).padStart(2, '0')}Z-0000000${i % 10}.delivered.json`), '{}');
  m.advance(25);
  m.setMode('500');
  await m.run(['--version']);
  await m.settle();
  assert.ok(readdirSync(m.sent).length <= 30, `${readdirSync(m.sent).length} receipts kept`);
  const shown = await show(m);
  assert.equal(shown.last_attempt.outcome, 'not-delivered');
  assert.equal(shown.last_attempt.body, usagePosts(m)[0].body);
  assert.equal(shown.last_delivered.body, '{}', 'the failed attempt was reported as the last delivery');
});

test('A9: counts clamp at 10,000, and features beyond 64 or 2,048 bytes wait for the next document', async t => {
  const m = machine(t);
  await m.run(['--version']);
  const names = JSON.parse(readFileSync(join(ROOT, 'lib/usage-features.json'), 'utf8'));
  const lines = [...Array.from({ length: 10_005 }, () => '{"f":"stacks"}'), ...Array.from({ length: 1_000_003 }, () => '{"a":1}'),
    ...names.map(name => JSON.stringify({ f: name }))];
  writeFileSync(m.counts, lines.join('\n') + '\n');
  m.advance(25);
  await m.run(['--help']);
  await m.settle();
  const first = JSON.parse(usagePosts(m)[0].body);
  assert.deepEqual(validate(SCHEMA, first), []);
  assert.equal(first.features.stacks, 10_000);
  assert.equal(first.api_calls, 1_000_000);
  assert.ok(Object.keys(first.features).length <= 64 && Buffer.byteLength(usagePosts(m)[0].body) <= 2048);
  m.advance(24);
  await m.run(['--help']);
  await m.settle();
  const second = JSON.parse(usagePosts(m)[1].body);
  assert.deepEqual(validate(SCHEMA, second), []);
  const sent = new Set([...Object.keys(first.features), ...Object.keys(second.features)]);
  for (const name of names) assert.ok(sent.has(name), `${name} was dropped instead of waiting`);
});

// --- A16 -------------------------------------------------------------------------
test('A16: lib/usage-features.json is the one sorted list of names, pinned, shipped and equal to what is counted', () => {
  const bytes = readFileSync(join(ROOT, 'lib/usage-features.json'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'de500569c131717a620ad08e9c974a347bf2e7ad34b28df1845b08ce5eb08771');
  const names = JSON.parse(bytes);
  assert.ok(Array.isArray(names) && names.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(name)));
  assert.deepEqual(names, [...new Set(names)].sort());
  const mcpNames = [TOOL_NAME, SAVED_REQUEST_TOOL.name, WORKBENCH_AGENT_TOOL.name, NOTE_REVIEW_TOOL.name, NOTE_RETIRE_TOOL.name,
    NOTE_CONTEXT_TOOL.name, 'api_context', 'api_context_record'].map(name => `mcp_${name}`);
  assert.deepEqual(names, [...new Set([...cliFeatureNames(), ...mcpNames])].sort());
  const inventory = JSON.parse(readFileSync(join(ROOT, 'packaging/public-source-files.json'), 'utf8')).files;
  assert.ok(inventory.includes('lib/usage-features.json'));
  assert.match(readFileSync(join(ROOT, 'docs/telemetry.md'), 'utf8'), /lib\/usage-features\.json/);
});

// --- USE-1-13 -------------------------------------------------------------------
test('USE-1-13: the contract is pinned, the destination is documented, the notice says what it must, the words are exact', async t => {
  assert.equal(createHash('sha256').update(readFileSync(join(ROOT, 'lib/usage.schema.json'))).digest('hex'),
    'b326dd62c8bf63c5ac787a178e8c562e80c91d7dbe6214bd24181e12853fe3a5');
  assert.ok(readFileSync(join(ROOT, 'docs/network-behavior.md'), 'utf8').includes(USAGE_URL));
  const m = machine(t);
  const notice = (await m.run(['--version'])).stderr.trim();
  for (const required of [/telemetry/, /random install ID/, /linked to the next/, /version/, /operating system/, /each .* command and MCP tool ran/,
    /API calls/, /Nothing about your repositories, APIs or requests is sent/, /on unless you turn it off/, /telemetry off`/, /"opt out"/,
    /telemetry show` prints exactly what is sent/, /24 hours/]) assert.match(notice, required);
  assert.doesNotMatch(notice, /\bjust\b|only a little|anonymous/i);
  assert.equal(notice.split('\n').length, 1, 'the notice is one paragraph');

  const retired = [/no telemetry/i, /nothing phones home/i, /never phones home/i, /only thing it sends us is feedback/i,
    /only thing [^.]* sends us is feedback/i, /no sannr server/i, /only thing it will ever send/i,
    /before it has told you/i, /stores no IP address/i, /no (?:setting, )?environment variable[^.]*changes/i];
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(join(ROOT, 'packaging/public-source-files.json'), 'utf8')).files;
  const shipped = new Set(inventory.filter(path => !path.startsWith('test/') && /\.(md|mjs|json|yml|txt)$/.test(path)));
  for (const entry of pkg.files) if (!entry.endsWith('/')) shipped.add(entry);
  for (const path of shipped) {
    if (!existsSync(join(ROOT, path))) continue;
    const text = readFileSync(join(ROOT, path), 'utf8');
    for (const phrase of retired) assert.doesNotMatch(text, phrase, `${path} still makes a retired or overstated promise`);
    // "Anonymous" only where the same paragraph says the identifier links days.
    if (path.endsWith('.md')) for (const paragraph of text.split(/\n\s*\n/))
      if (/anonymous/i.test(paragraph) && /usage|telemetry/i.test(paragraph))
        assert.match(paragraph, /link/i, `${path}: "anonymous" without saying the identifier links days: ${paragraph.slice(0, 120)}`);
  }
});

// --- Amendment 7 -------------------------------------------------------------------
// Every file or directory whose name starts with telemetry or .telemetry under `root`.
function telemetryFiles(root) {
  const found = [];
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (/^\.?telemetry/.test(entry.name)) found.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path);
    }
  };
  walk(root);
  return found.sort();
}
// Run the CLI with some variables removed from its environment altogether
// (env -u), as a shell or host that never sets them would start it. The test
// helper fills HOME into a hand-built environment, so this is the only way to
// start a test child with no HOME at all.
function runUnset(m, unset, args, env = {}) {
  const started = performance.now();
  const child = spawn('/usr/bin/env', [...unset.flatMap(name => ['-u', name]), process.execPath, CLI, ...args],
    { cwd: m.root, env: { ...m.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: performance.now() - started }); });
  });
}
// The ways an environment names no home directory, each with the account's
// fallback home pointed at a temporary directory.
function noHomeVariants() {
  const variants = [['HOME empty', { HOME: '', USERPROFILE: '' }, []], ['HOME relative', { HOME: 'relative-home', USERPROFILE: 'relative-home' }, []]];
  if (process.platform !== 'win32') variants.unshift(['HOME unset', {}, ['HOME', 'USERPROFILE']]);
  return variants;
}

test('A17e: with no home directory in the environment nothing is counted, sent, shown or written, and status says why', async t => {
  for (const [label, homeEnv, unset] of noHomeVariants()) {
    for (const stateDir of ['set', 'unset']) {
      const m = machine(t);
      const fallback = join(m.parent, 'fallback-home');
      mkdirSync(fallback);
      const env = { ...homeEnv, TEST_FALLBACK_HOME: fallback, ...(stateDir === 'unset' ? { [HOME_ENV_NAME]: '' } : {}) };
      const go = args => runUnset(m, unset, args, env);
      const what = `${label}, SANNR_HOME ${stateDir}`;
      const first = await go(['--version']);
      assert.equal(first.code, 0, `${what}: ${first.stderr}`);
      assert.doesNotMatch(first.stderr, NOTICE, `${what}: the notice was shown`);
      await go(['stacks', '--json']);
      m.advance(25);
      await go(['map', '.', '--text', '--no-execute']);
      await go(['stacks', '--json']);
      const status = json(await go(['telemetry', 'status', '--json']));
      assert.equal(status.state, 'off', what);
      assert.equal(status.reason.source, 'no_home', what);
      assert.match((await go(['telemetry', 'status'])).stdout, /names no home directory/, what);
      assert.equal(json(await go(['telemetry', 'show', '--json'])).body, null, `${what}: show built a document`);
      for (const command of ['off', 'on', 'reset']) {
        const result = await go(['telemetry', command, '--json']);
        assert.equal(result.code, 1, `${what}: telemetry ${command} exited ${result.code}`);
        assert.match(result.stdout + result.stderr, /TELEMETRY_NO_HOME/, what);
      }
      await m.settle();
      assert.deepEqual(m.calls(), [], `${what}: something was sent`);
      assert.deepEqual(telemetryFiles(m.parent), [], `${what}: telemetry state was written`);
    }
  }
});

test('A17e: an MCP host that starts the server with no home directory is not counted', async t => {
  for (const [label, homeEnv, unset] of noHomeVariants()) {
    const m = machine(t);
    const fallback = join(m.parent, 'fallback-home');
    mkdirSync(fallback);
    // A registration's environment: no HOME, the state directory it names.
    const env = { PATH: process.env.PATH, [HOME_ENV_NAME]: m.state, [TELEMETRY_CHECKOUT_ENV_NAME]: ROOT, [TELEMETRY_ENV_NAME]: '', DO_NOT_TRACK: '',
      NODE_OPTIONS: m.env.NODE_OPTIONS, TEST_FALLBACK_HOME: fallback, ...homeEnv };
    const server = mcp(t, m, {}, { unset, env });
    await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
    const tool = { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } };
    const reply = (await server.call(2, tool)).msg;
    assert.equal(reply.result.content.filter(block => NOTICE.test(block.text)).length, 0, `${label}: the notice was relayed`);
    await server.call(3, tool);
    await server.close();
    m.advance(25);
    const later = mcp(t, m, {}, { unset, env });
    await later.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
    await later.call(2, tool);
    await later.close();
    await m.settle();
    assert.deepEqual(m.calls(), [], `${label}: something was sent`);
    assert.deepEqual(telemetryFiles(m.parent), [], `${label}: telemetry state was written`);
  }
});

test('A17e: connect and doctor, which starts the registered server, turn nothing on', async t => {
  // Off recorded: connect, then doctor probing the server it registered.
  const m = machine(t);
  await gitInit(m.root);
  json(await m.run(['telemetry', 'off', '--json']));
  const before = telemetryFiles(m.parent);
  assert.equal((await m.run(['connect', '--json'])).code, 0);
  const doctor = json(await m.run(['doctor', '--offline', '--json']));
  assert.match(JSON.stringify(doctor), /MCP initialize responded/, 'doctor did not start the registered server');
  m.advance(25);
  await m.run(['doctor', '--offline', '--json']);
  await m.settle();
  assert.equal(json(await m.run(['telemetry', 'status', '--json'])).state, 'off');
  assert.deepEqual(m.calls(), []);
  assert.deepEqual(telemetryFiles(m.parent), before, 'connect or doctor changed the telemetry state');
  // No home: the same commands write no telemetry state anywhere.
  for (const [label, homeEnv, unset] of noHomeVariants()) {
    const n = machine(t);
    await gitInit(n.root);
    const fallback = join(n.parent, 'fallback-home');
    mkdirSync(fallback);
    const env = { ...homeEnv, TEST_FALLBACK_HOME: fallback };
    await runUnset(n, unset, ['connect', '--json'], env);
    n.advance(25);
    await runUnset(n, unset, ['doctor', '--offline', '--json'], env);
    await n.settle();
    assert.deepEqual(n.calls(), [], `${label}: something was sent`);
    assert.deepEqual(telemetryFiles(n.parent), [], `${label}: telemetry state was written`);
  }
});

test('A5l: the MCP server and the CLI each record their state directory, also when the list was lost', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), list = join(user, 'telemetry.dirs');
  const b = join(m.parent, 'other-state'), c = join(m.parent, 'third-state');
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: b } });
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: c } });
  assert.deepEqual(readFileSync(list, 'utf8').split('\n').filter(Boolean).sort(), [b, c].sort());
  rmSync(list);
  // B is used again only by the MCP server, C only by the CLI.
  const server = mcp(t, m, { [HOME_ENV_NAME]: b });
  await server.call(1, { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } });
  await server.call(2, { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } });
  await server.close();
  assert.deepEqual(readFileSync(list, 'utf8').split('\n').filter(Boolean), [b], 'the MCP server did not record its directory');
  await m.run(['stacks', '--json'], { env: { [HOME_ENV_NAME]: c } });
  assert.deepEqual(readFileSync(list, 'utf8').split('\n').filter(Boolean), [b, c], 'the CLI did not record an existing directory again');
  // So off marks both.
  const off = json(await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: user } }));
  assert.deepEqual(off.other_directories.sort(), [b, c].sort());
});

test('A5l: off marks only listed directories that exist, creates none, writes nowhere else, and prunes the list', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), list = join(user, 'telemetry.dirs'), b = join(m.parent, 'other-state');
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: b } });
  const missing = join(m.parent, 'gone'), file = join(m.parent, 'a-file');
  writeFileSync(file, 'x');
  // A relative entry that names a real directory from the current one.
  mkdirSync(join(m.root, 'relative', 'dir'), { recursive: true });
  writeFileSync(list, ['relative/dir', '   ', ` ${b}`, missing, file, join(file, 'under'), b, ''].join('\n'));
  const off = json(await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: user } }));
  assert.deepEqual(off.other_directories, [b]);
  assert.equal(off.directory_list.readable, true);
  assert.equal(existsSync(missing), false, 'off created a listed directory that did not exist');
  assert.equal(readFileSync(file, 'utf8'), 'x');
  assert.deepEqual(telemetryFiles(m.root), [], 'off wrote into the current directory');
  assert.deepEqual(readdirSync(join(m.root, 'relative', 'dir')), [], 'off marked a relative entry');
  assert.deepEqual(readFileSync(list, 'utf8').split('\n').filter(Boolean), [b], 'the list was not pruned');
});

test('A5l: the list has a fixed size, and off takes a bounded time whatever it holds', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), list = join(user, 'telemetry.dirs');
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: user } });
  // 300 directories that exist: the list keeps the newest 256.
  const dirs = [];
  for (let i = 0; i < 300; i++) { const dir = join(m.parent, 'many', `d${String(i).padStart(3, '0')}`); mkdirSync(dir, { recursive: true }); dirs.push(dir); }
  writeFileSync(list, `${dirs.join('\n')}\n`);
  const fresh = join(m.parent, 'fresh');
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: fresh } });
  const kept = readFileSync(list, 'utf8').split('\n').filter(Boolean);
  assert.equal(kept.length, 256, 'the list grew past its maximum');
  assert.equal(kept.at(-1), fresh);
  // 20,000 lines of directories that no longer exist, and one that does.
  writeFileSync(list, `${Array.from({ length: 20_000 }, (_, i) => join(m.parent, 'deleted', `tmp${i}`)).join('\n')}\n${fresh}\n`);
  const result = await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: user } });
  const off = json(result);
  assert.deepEqual(off.other_directories, [fresh]);
  assert.ok(result.stdout.length < 16_384, `off printed ${result.stdout.length} bytes`);
  assert.ok(result.ms < 10_000, `off took ${result.ms} ms`);
  assert.equal(existsSync(join(m.parent, 'deleted')), false, 'off created directories that no longer exist');
  assert.deepEqual(readFileSync(list, 'utf8').split('\n').filter(Boolean), [fresh]);
});

test('A5l: when the list cannot be read, off says so and names the directories it did mark', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) { t.skip('needs POSIX permissions'); return; }
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), list = join(user, 'telemetry.dirs'), b = join(m.parent, 'other-state');
  await m.run(['--version'], { env: { [HOME_ENV_NAME]: b } });
  chmodSync(list, 0o000);
  t.after(() => { try { chmodSync(list, 0o600); } catch { /* removed */ } });
  const off = json(await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: user } }));
  assert.equal(off.ok, true);
  assert.equal(off.directory_list.readable, false);
  assert.deepEqual(off.other_directories, []);
  chmodSync(list, 0o600);
  await m.run(['telemetry', 'on', '--json'], { env: { [HOME_ENV_NAME]: user } });
  chmodSync(list, 0o000);
  const text = await m.run(['telemetry', 'off'], { env: { [HOME_ENV_NAME]: user } });
  assert.match(text.stdout, /could not be read \(EACCES\), so no other directory was marked/);
  assert.match(text.stdout, /stays off only while the home's marker is there/);
});

test('F6: off clears the identifier and counts of the other directories it marks at once', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), b = join(m.parent, 'other-state'), inB = { [HOME_ENV_NAME]: b };
  await m.run(['--version'], { env: inB });
  m.advance(25);
  await m.run(['--version'], { env: inB });
  await m.settle();
  await m.run(['map', '.', '--text', '--no-execute'], { env: inB });
  assert.ok(m.readState(join(b, 'telemetry.json')).install, 'B has no identifier to clear');
  assert.ok(existsSync(join(b, 'telemetry', 'counts.jsonl')));
  const off = json(await m.run(['telemetry', 'off', '--json'], { env: { [HOME_ENV_NAME]: user } }));
  assert.deepEqual(off.other_directories, [b]);
  // Without B being used again.
  assert.equal(m.readState(join(b, 'telemetry.json')).install, null, 'off left the identifier of a directory it marked');
  assert.equal(existsSync(join(b, 'telemetry', 'counts.jsonl')), false, 'off left the counts of a directory it marked');
});

test('F8: off racing on across three directories ends as one of them says, and neither fails', async t => {
  const m = machine(t);
  const user = join(m.home, `.${PRODUCT}`), b = join(m.parent, 'other-state'), c = join(m.parent, 'third-state');
  const inUser = { [HOME_ENV_NAME]: user }, inB = { [HOME_ENV_NAME]: b };
  for (const dir of [user, b, c]) await m.run(['--version'], { env: { [HOME_ENV_NAME]: dir } });
  const states = async () => Promise.all([user, b, c].map(async dir => json(await m.run(['telemetry', 'status', '--json'], { env: { [HOME_ENV_NAME]: dir } })).state));
  for (let round = 0; round < 6; round++) {
    json(await m.run(['telemetry', 'off', '--json'], { env: inUser }));
    const [off, on] = await Promise.all([
      new Promise(resolve => setTimeout(resolve, round * 7 % 20)).then(() => m.run(['telemetry', 'off', '--json'], { env: inUser })),
      m.run(['telemetry', 'on', '--json'], { env: inB })]);
    assert.equal(off.code, 0, `round ${round}: off failed: ${off.stdout}${off.stderr}`);
    assert.ok(on.code === 0 || /TELEMETRY_STATE_BUSY/.test(on.stdout + on.stderr), `round ${round}: on failed: ${on.stdout}${on.stderr}`);
    const end = await states();
    const allOff = end.every(state => state === 'off'), allOn = end.every(state => state === 'on');
    assert.ok(allOff || on.code === 0 && allOn, `round ${round}: ended ${end.join('/')}, which neither output describes`);
  }
});

test('F6: each source-tree marker alone, and a marker path that cannot be read, make a source tree', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-markers-')));
  t.after(() => { try { chmodSync(join(parent, 'tree', 'scripts'), 0o700); } catch { /* absent */ } rmSync(parent, { recursive: true, force: true }); });
  const tree = join(parent, 'tree');
  for (const entry of ['bin', 'lib', 'skill', 'stacks', 'server.mjs', 'package.json']) cpSync(join(ROOT, entry), join(tree, entry), { recursive: true });
  // Written out, not imported, so a marker dropped from the code fails.
  const markers = {
    '.git file': () => writeFileSync(join(tree, '.git'), 'gitdir: ../elsewhere\n'),
    '.git directory': () => mkdirSync(join(tree, '.git')),
    'scripts/test-unit.mjs': () => { mkdirSync(join(tree, 'scripts')); writeFileSync(join(tree, 'scripts', 'test-unit.mjs'), ''); },
    'test/telemetry.test.mjs': () => { mkdirSync(join(tree, 'test')); writeFileSync(join(tree, 'test', 'telemetry.test.mjs'), ''); },
    'scripts/ unreadable': () => { mkdirSync(join(tree, 'scripts')); chmodSync(join(tree, 'scripts'), 0o000); },
  };
  const clear = () => { try { chmodSync(join(tree, 'scripts'), 0o700); } catch { /* absent */ }
    for (const name of ['.git', 'scripts', 'test']) rmSync(join(tree, name), { recursive: true, force: true }); };
  const go = (m, args) => new Promise(resolve => {
    const child = spawn(process.execPath, [join(tree, 'bin', 'cli.mjs'), ...args], { cwd: m.root, env: m.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const cases = Object.entries(markers).filter(([name]) => !(name === 'scripts/ unreadable' && (process.platform === 'win32' || process.getuid?.() === 0)));
  for (const [name, make] of [['no marker', () => {}], ...cases]) {
    clear(); make();
    const m = machine(t);
    delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
    const first = await go(m, ['--version']);
    assert.equal(first.code, 0, `${name}: ${first.stderr}`);
    if (name === 'no marker') { assert.match(first.stderr, NOTICE, 'a tree with no marker is an installed package'); continue; }
    assert.doesNotMatch(first.stderr, NOTICE, `${name}: a tree with this marker alone counted`);
    assert.equal(existsSync(m.state), false, `${name}: wrote telemetry state`);
    assert.equal(JSON.parse((await go(m, ['telemetry', 'status', '--json'])).stdout).reason.source, 'checkout', name);
  }
  clear();
});

// --- Amendment 8: the notice and mcp inspect -------------------------------------
// `mcp inspect --execute` keeps an observation of a tool result, not its text,
// so Sannr's own server must neither attach the notice to it nor record it as
// given. The server and (except in U4) the inspector are a copied package with
// no source-tree marker, so they count as an installed copy.
function installedCopy(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'telemetry-inspect-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const copy = join(parent, 'package');
  for (const entry of ['bin', 'lib', 'skill', 'stacks', 'server.mjs', 'package.json']) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  return { cli: join(copy, 'bin', 'cli.mjs'), server: join(copy, 'server.mjs') };
}
// `stdout` and `stderr` are 'pipe' (read here), 'ignore' (the null device) or a file descriptor.
function runCli(cli, args, { cwd, env, stdout: out = 'pipe', stderr: err = 'pipe' }) {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', out, err] });
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => stdout += chunk);
  child.stderr?.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
// api_saved_requests list reads local files and sends nothing.
const INSPECT_CALL = ['--execute', 'api_saved_requests', '--args', 'api_saved_requests={"action":"list"}', '--execute-unsafe', '--json'];
const noticesRecorded = dir => existsSync(join(dir, 'telemetry.json')) ? (readFileSync(join(dir, 'telemetry.json'), 'utf8').match(/"noticed_at":"/g) ?? []).length : 0;
const counted = (dir, feature) => existsSync(join(dir, 'telemetry', 'counts.jsonl'))
  ? readFileSync(join(dir, 'telemetry', 'counts.jsonl'), 'utf8').split('\n').filter(line => line === JSON.stringify({ f: feature })).length : 0;
function measuredOnce(result) {
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  assert.equal(json(result).measured.length, 1, 'the inspector did not make the one tool call');
  assert.doesNotMatch(result.stdout, NOTICE, 'the notice reached the inspection output');
}
function serveCopy(t, m, server) {
  const child = spawn(process.execPath, [server], { cwd: m.root, env: { ...m.env, API_CONTEXT_DIR: m.root }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  const waiters = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const parts = buffer.split('\n'); buffer = parts.pop();
    for (const part of parts) if (part.trim()) { const msg = JSON.parse(part); waiters.get(msg.id)?.(msg); }
  });
  const call = (id, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`MCP reply ${id} did not arrive within 15 s`)); }, 15_000);
    waiters.set(id, msg => { clearTimeout(timer); waiters.delete(id); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...message }) + '\n');
  });
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited; clearTimeout(timer);
  };
  return { call, close };
}

test('A8 U1: a client that names itself as the inspector gets no notice and records none; the next client gets it', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { server } = installedCopy(t);
  const tool = { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } };
  const inspector = serveCopy(t, m, server);
  await inspector.call(1, { method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: MCP_INSPECT_CLIENT_NAME, version: '0.1.0' } } });
  const quiet = await inspector.call(2, tool);
  await inspector.close();
  assert.equal(quiet.result.content.length, 1, JSON.stringify(quiet.result.content));
  assert.equal(quiet.result.content.filter(block => NOTICE.test(block.text)).length, 0, 'the inspector got the notice');
  assert.equal(noticesRecorded(m.state), 0, 'the notice was recorded as given to the inspector');
  assert.equal(existsSync(join(m.state, 'telemetry', 'counts.jsonl')), false, 'a call on a state directory not told was counted');

  const host = serveCopy(t, m, server);
  await host.call(1, { method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'some-agent-host' } } });
  const first = await host.call(2, tool);
  const second = await host.call(3, tool);
  await host.close();
  assert.match(first.result.content.at(-1).text, NOTICE, 'the notice is not the last block of the next client\'s first result');
  assert.equal(first.result.content.filter(block => NOTICE.test(block.text)).length, 1);
  assert.equal(second.result.content.filter(block => NOTICE.test(block.text)).length, 0);
  assert.equal(noticesRecorded(m.state), 1);
});

test('A8 U2: mcp inspect of a server given another state directory, the parent already told: that directory records nothing', async t => {
  if (process.platform === 'win32') { t.skip('needs /usr/bin/env'); return; }
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli, server } = installedCopy(t);
  assert.match((await runCli(cli, ['--version'], { cwd: m.root, env: m.env })).stderr, NOTICE, 'the parent was not told');
  const other = join(m.parent, 'other-state');
  const result = await runCli(cli, ['mcp', 'inspect', '/usr/bin/env', `${HOME_ENV_NAME}=${other}`, process.execPath, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(result);
  assert.doesNotMatch(result.stderr, NOTICE);
  assert.equal(existsSync(join(other, 'telemetry.json')), false, 'the server\'s state directory holds a telemetry record');
  assert.equal(noticesRecorded(m.state), 1);
});

test('A8 U3: mcp inspect with the environment stripped (env -i): the server\'s state directory records nothing', async t => {
  if (process.platform === 'win32') { t.skip('needs /usr/bin/env'); return; }
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli, server } = installedCopy(t);
  await runCli(cli, ['--version'], { cwd: m.root, env: m.env });
  const other = join(m.parent, 'other-state'), otherHome = join(m.parent, 'other-home');
  mkdirSync(otherHome);
  // The fetch-blocking preload goes through env -i too, so the server cannot reach a real host.
  const result = await runCli(cli, ['mcp', 'inspect', '/usr/bin/env', '-i', `PATH=${process.env.PATH}`, `HOME=${otherHome}`, `${HOME_ENV_NAME}=${other}`,
    `NODE_OPTIONS=${m.env.NODE_OPTIONS}`, process.execPath, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(result);
  assert.equal(existsSync(join(other, 'telemetry.json')), false, 'the server\'s state directory holds a telemetry record');
  assert.deepEqual(readdirSync(otherHome), [], 'the stripped server wrote in its home');
});

test('A8 U4: a source tree inspecting an installed copy on a home never told: no record and nothing printed', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { server } = installedCopy(t);
  // This checkout's own CLI without the checkout switch is a source tree: it never counts.
  const result = await runCli(CLI, ['mcp', 'inspect', process.execPath, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(result);
  assert.doesNotMatch(result.stderr, NOTICE, 'a notice was printed');
  assert.equal(existsSync(join(m.state, 'telemetry.json')), false, 'the installed copy\'s state directory was recorded as told');
  assert.equal(existsSync(join(m.state, 'telemetry', 'counts.jsonl')), false);
});

test('A8 U5 (guard): mcp inspect on a home never told shows the notice once on stderr, records it once, counts mcp_inspect', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli, server } = installedCopy(t);
  const result = await runCli(cli, ['mcp', 'inspect', process.execPath, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(result);
  assert.equal((result.stderr.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, result.stderr);
  assert.equal(noticesRecorded(m.state), 1);
  assert.equal(counted(m.state, 'mcp_inspect'), 1);
});

test('A8 U6 (guard): told and on, a tool call made through the inspector counts mcp_<tool> once', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli, server } = installedCopy(t);
  await runCli(cli, ['--version'], { cwd: m.root, env: m.env });
  const result = await runCli(cli, ['mcp', 'inspect', process.execPath, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(result);
  assert.doesNotMatch(result.stderr, NOTICE);
  assert.equal(counted(m.state, 'mcp_api_saved_requests'), 1);
  assert.equal(noticesRecorded(m.state), 1);
});

// --- Amendment 9: the null device, a proxy, the fixed name, a second initialize ----
// A copy with one source-tree marker: it never counts, so whatever is recorded
// or printed comes from the installed copy it starts.
function sourceTreeCopy(t) {
  const { cli } = installedCopy(t);
  const root = join(cli, '..', '..');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'test-unit.mjs'), '');
  return cli;
}
const telemetryRecords = dir => readdirSync(dir, { recursive: true }).filter(name => String(name).endsWith('telemetry.json'));

test('A9 V1: a source tree inspecting an installed CLI (--version, and mcp with serve forgotten) on a home never told: no record', async t => {
  // Each target is its own subtest, so the second runs when the first fails (A10.4).
  for (const target of [['--version'], ['mcp']]) await t.test(target.join(' '), async t => {
    const m = machine(t);
    delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
    const inspector = sourceTreeCopy(t), { cli } = installedCopy(t);
    const result = await runCli(inspector, ['mcp', 'inspect', process.execPath, cli, ...target, '--json'], { cwd: m.root, env: m.env });
    assert.doesNotMatch(result.stdout + result.stderr, NOTICE, target.join(' '));
    assert.equal(existsSync(join(m.state, 'telemetry.json')), false, `${target.join(' ')}: the notice was recorded with its stderr discarded`);
    assert.equal(existsSync(join(m.state, 'telemetry', 'counts.jsonl')), false, `${target.join(' ')}: counted`);
  });
});

test('A9 V2: stderr (and stdout for connect) on the null device records nothing; the next readable run is told', async t => {
  // Two subtests, so the connect case runs when the first fails (A10.4).
  await t.test('stderr', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli } = installedCopy(t);
  const quiet = await runCli(cli, ['--version'], { cwd: m.root, env: m.env, stderr: 'ignore' });
  assert.equal(quiet.code, 0);
  assert.equal(existsSync(join(m.state, 'telemetry.json')), false, 'the notice was recorded on the null device');
  assert.equal(existsSync(join(m.state, 'telemetry', 'counts.jsonl')), false, 'a run on the null device was counted');
  const told = await runCli(cli, ['--version'], { cwd: m.root, env: m.env });
  assert.equal((told.stderr.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, told.stderr);
  assert.equal(noticesRecorded(m.state), 1);
  });

  await t.test('connect stdout', async t => {
  const { cli } = installedCopy(t);
  const c = machine(t);
  delete c.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const connect = ['connect', '--base-url', 'http://127.0.0.1:9'];
  const silent = await runCli(cli, connect, { cwd: c.root, env: c.env, stdout: 'ignore' });
  assert.equal(silent.code, 0, silent.stderr);
  assert.doesNotMatch(silent.stderr, NOTICE);
  assert.equal(existsSync(join(c.state, 'telemetry.json')), false, 'connect recorded the notice with stdout on the null device');
  const shown = await runCli(cli, ['connect'], { cwd: c.root, env: c.env });
  assert.equal((shown.stdout.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, `${shown.stdout}${shown.stderr}`);
  assert.equal(noticesRecorded(c.state), 1);
  });
});

test('A9 V3 (guard): stderr as a pipe and as a file: the notice is written and recorded', async t => {
  const { cli } = installedCopy(t);
  const piped = machine(t);
  delete piped.env[TELEMETRY_CHECKOUT_ENV_NAME];
  assert.match((await runCli(cli, ['--version'], { cwd: piped.root, env: piped.env })).stderr, NOTICE);
  assert.equal(noticesRecorded(piped.state), 1);
  const filed = machine(t);
  delete filed.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const file = join(filed.parent, 'stderr.txt'), fd = openSync(file, 'w');
  try { await runCli(cli, ['--version'], { cwd: filed.root, env: filed.env, stderr: fd }); } finally { closeSync(fd); }
  assert.equal((readFileSync(file, 'utf8').match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1);
  assert.equal(noticesRecorded(filed.state), 1);
});

test('A9 V4: through a proxy that renames the client, the inspector shows the notice once on its stderr; a second inspection nothing', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const inspector = sourceTreeCopy(t), { server } = installedCopy(t);
  // Like an aggregating gateway: it initializes the server under its own name.
  const proxy = join(m.parent, 'proxy.mjs');
  writeFileSync(proxy, `import { spawn } from 'node:child_process';
const child = spawn(process.execPath, process.argv.slice(2), { stdio: ['pipe', 'inherit', 'inherit'] });
let buffer = '';
process.stdin.on('data', chunk => { buffer += chunk; const lines = buffer.split('\\n'); buffer = lines.pop();
  for (const line of lines) { if (!line.trim()) continue; const msg = JSON.parse(line);
    if (msg.method === 'initialize') msg.params.clientInfo = { name: 'some-gateway', version: '1' };
    child.stdin.write(JSON.stringify(msg) + '\\n'); } });
process.stdin.on('end', () => child.stdin.end());
child.on('close', code => process.exit(code ?? 0));
`);
  const first = await runCli(inspector, ['mcp', 'inspect', process.execPath, proxy, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(first);
  assert.equal((first.stderr.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, first.stderr);
  assert.equal(noticesRecorded(m.state), 1);
  const second = await runCli(inspector, ['mcp', 'inspect', process.execPath, proxy, server, ...INSPECT_CALL], { cwd: m.root, env: m.env });
  measuredOnce(second);
  assert.doesNotMatch(second.stderr, NOTICE);
});

test('A9 V5: another product name in the server\'s environment only: the inspector\'s call gets no notice and leaves no record', async t => {
  if (process.platform === 'win32') { t.skip('needs /usr/bin/env'); return; }
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const inspector = sourceTreeCopy(t), { server } = installedCopy(t);
  const result = await runCli(inspector, ['mcp', 'inspect', '/usr/bin/env', 'API_CONTEXT_PRODUCT_NAME=zqother', process.execPath, server, ...INSPECT_CALL],
    { cwd: m.root, env: m.env });
  measuredOnce(result);
  assert.doesNotMatch(result.stderr, NOTICE);
  assert.deepEqual(telemetryRecords(m.parent), [], 'a telemetry record was written');
});

test('A9 V6: two initialize messages in one session: the last one decides', async t => {
  const tool = { method: 'tools/call', params: { name: 'api_saved_requests', arguments: { action: 'list' } } };
  const init = name => ({ method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name } } });
  const { server } = installedCopy(t);
  const a = machine(t);
  delete a.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const host = serveCopy(t, a, server);
  await host.call(1, init(MCP_INSPECT_CLIENT_NAME));
  await host.call(2, init('some-agent-host'));
  const told = await host.call(3, tool);
  await host.close();
  assert.match(told.result.content.at(-1).text, NOTICE, 'the other client, initialized last, got no notice');
  assert.equal(noticesRecorded(a.state), 1);
  const b = machine(t);
  delete b.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const inspected = serveCopy(t, b, server);
  await inspected.call(1, init('some-agent-host'));
  await inspected.call(2, init(MCP_INSPECT_CLIENT_NAME));
  const quiet = await inspected.call(3, tool);
  await inspected.close();
  assert.equal(quiet.result.content.filter(block => NOTICE.test(block.text)).length, 0, 'the inspector, initialized last, got the notice');
  assert.equal(noticesRecorded(b.state), 0);
});

// --- Amendment 10: what the inspector drops, its own text once, another device ----
test('A10 W1: connect (plain and --json) as the inspect target: the notice is on the inspector\'s stderr once, none on stdout', async t => {
  for (const json of [false, true]) await t.test(json ? '--json' : 'plain', async t => {
    const m = machine(t);
    delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
    const inspector = sourceTreeCopy(t), { cli } = installedCopy(t);
    const target = [process.execPath, cli, 'connect', '--base-url', 'http://127.0.0.1:9', ...(json ? ['--json'] : [])];
    const result = await runCli(inspector, ['mcp', 'inspect', ...target], { cwd: m.root, env: m.env });
    assert.equal((result.stderr.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, result.stderr);
    assert.doesNotMatch(result.stdout, NOTICE);
    assert.equal(noticesRecorded(m.state), 1, 'connect did not run as the target');
  });
});

test('A10 W2: two tool results carrying notice-like blocks: the inspector prints its own notice once and none of the server\'s bytes', async t => {
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const inspector = sourceTreeCopy(t);
  const fake = join(m.parent, 'fake-server.mjs');
  writeFileSync(fake, `const notice = 'Sannr telemetry: once a day Sannr sends usage counts to zqserver.invalid: ZQ SERVER BYTES';
let buffer = '';
const send = msg => process.stdout.write(JSON.stringify(msg) + '\\n');
process.stdin.on('data', chunk => { buffer += chunk; const lines = buffer.split('\\n'); buffer = lines.pop();
  for (const line of lines) { if (!line.trim()) continue; const msg = JSON.parse(line);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'zqfake', version: '1' } } });
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }, { name: 'two', inputSchema: { type: 'object' } }] } });
    else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }, { type: 'text', text: notice }] } });
    else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} }); } });
process.stdin.on('end', () => process.exit(0));
`);
  const result = await runCli(inspector, ['mcp', 'inspect', process.execPath, fake, '--execute', 'one', '--execute', 'two', '--execute-unsafe', '--json'], { cwd: m.root, env: m.env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(json(result).measured.length, 2);
  assert.equal((result.stderr.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, result.stderr);
  for (const bytes of ['ZQ SERVER BYTES', 'zqserver.invalid'])
    assert.equal((result.stdout + result.stderr).includes(bytes), false, `the server's bytes (${bytes}) were printed`);
});

test('A10 W3: stderr on another character device (/dev/zero), home never told: the notice is recorded', async t => {
  if (process.platform === 'win32') { t.skip('needs /dev/zero'); return; }
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli } = installedCopy(t);
  const fd = openSync('/dev/zero', 'w');
  try { assert.equal((await runCli(cli, ['--version'], { cwd: m.root, env: m.env, stderr: fd })).code, 0); } finally { closeSync(fd); }
  assert.equal(noticesRecorded(m.state), 1, 'a character device that is not the null device was treated as one');
});

// --- review of 835d5d5: the failed write and the product-name seam ---------------
const sendLocks = parent => readdirSync(parent, { recursive: true }).filter(name => String(name).endsWith('.send.lock'));
async function sendersDone(parent, limit = 15_000) {
  const end = Date.now() + limit;
  while (sendLocks(parent).length) { if (Date.now() > end) throw new Error('sender did not finish'); await new Promise(r => setTimeout(r, 50)); }
}

test('R1: a notice whose write to standard error fails is not recorded; the next readable command is told, and nothing is sent meanwhile', async t => {
  if (process.platform === 'win32') { t.skip('needs sh and a pipe whose reader has gone'); return; }
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli } = installedCopy(t);
  // The reader (`:`) ends at once; the command starts after it has gone, so
  // its write to standard error fails with a broken pipe.
  const deadPipe = () => new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', '{ sleep 0.4; exec "$0" "$1" --version; } 2>&1 >/dev/null | :', process.execPath, cli], { cwd: m.root, env: m.env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  await deadPipe();
  assert.equal(existsSync(join(m.state, 'telemetry.json')), false, 'a notice nobody received was recorded');
  assert.equal(existsSync(join(m.state, 'telemetry', 'counts.jsonl')), false, 'the command whose notice failed was counted');
  m.advance(25);
  await deadPipe();
  await sendersDone(m.parent);
  assert.deepEqual(m.calls(), [], 'a machine that never received the notice sent a document');
  const told = await runCli(cli, ['--version'], { cwd: m.root, env: m.env });
  assert.equal((told.stderr.match(new RegExp(NOTICE.source, 'g')) ?? []).length, 1, told.stderr);
  assert.equal(noticesRecorded(m.state), 1);
  const again = await runCli(cli, ['--version'], { cwd: m.root, env: m.env });
  assert.doesNotMatch(again.stderr, NOTICE);
});

test('R1: a failed write removes only the record it made: a machine already told keeps its record', async t => {
  if (process.platform === 'win32') { t.skip('needs sh and a pipe whose reader has gone'); return; }
  const m = machine(t);
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const { cli } = installedCopy(t);
  await runCli(cli, ['--version'], { cwd: m.root, env: m.env });
  const before = readFileSync(join(m.state, 'telemetry.json'), 'utf8');
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', '{ sleep 0.4; exec "$0" "$1" --version; } 2>&1 >/dev/null | :', process.execPath, cli], { cwd: m.root, env: m.env, stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(readFileSync(join(m.state, 'telemetry.json'), 'utf8'), before);
});

test('R2: the product-name seam turns usage counts off: no notice, state, count or send, on a fresh home and on one turned off', async t => {
  const SEAM = 'API_CONTEXT_PRODUCT_NAME', renamed = 'zqseam';
  const { cli } = installedCopy(t);
  // A home never told.
  const fresh = machine(t, { stateInHome: true });
  delete fresh.env[TELEMETRY_CHECKOUT_ENV_NAME];
  const first = await runCli(cli, ['--version'], { cwd: fresh.root, env: { ...fresh.env, [SEAM]: renamed } });
  assert.equal(first.code, 0, first.stderr);
  assert.doesNotMatch(first.stderr, NOTICE, 'a renamed process showed the notice');
  assert.deepEqual(telemetryRecords(fresh.parent), [], 'a renamed process wrote a telemetry record');
  const status = JSON.parse((await runCli(cli, ['telemetry', 'status', '--json'], { cwd: fresh.root, env: { ...fresh.env, [SEAM]: renamed } })).stdout);
  assert.equal(status.state, 'off');
  assert.equal(status.reason.variable, SEAM);
  // A home told, then turned off for good.
  const m = machine(t, { stateInHome: true });
  delete m.env[TELEMETRY_CHECKOUT_ENV_NAME];
  assert.match((await runCli(cli, ['--version'], { cwd: m.root, env: m.env })).stderr, NOTICE);
  assert.equal((await runCli(cli, ['telemetry', 'off'], { cwd: m.root, env: m.env })).code, 0);
  const records = telemetryRecords(m.parent);
  for (const extra of [{}, { [TELEMETRY_ENV_NAME]: '0' }]) {
    const env = { ...m.env, ...extra, [SEAM]: renamed };
    const run = await runCli(cli, ['--version'], { cwd: m.root, env });
    assert.doesNotMatch(run.stderr, NOTICE, 'the seam showed a fresh notice on a home that is off');
    m.advance(25);
    await runCli(cli, ['stacks', '--json'], { cwd: m.root, env });
    await runCli(cli, ['--version'], { cwd: m.root, env });
    await sendersDone(m.parent);
  }
  assert.deepEqual(m.calls(), [], 'a document was sent under the seam');
  assert.deepEqual(telemetryRecords(m.parent), records, 'the seam made another state directory with a telemetry record');
  assert.equal(existsSync(join(m.home, `.${renamed}`, 'telemetry')), false);
});

test('R2: the sender\'s user agent name is fixed, whatever the seam says', async () => {
  const brand = pathToFileURL(join(ROOT, 'lib/brand.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `const b = await import(${JSON.stringify(brand)}); console.log(JSON.stringify([b.PRODUCT, b.USAGE_USER_AGENT_NAME]))`],
    { env: { PATH: process.env.PATH, API_CONTEXT_PRODUCT_NAME: 'zqseam' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', chunk => out += chunk);
  await new Promise(resolve => child.once('close', resolve));
  assert.deepEqual(JSON.parse(out), ['zqseam', 'sannr']);
});
