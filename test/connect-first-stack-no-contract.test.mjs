// A fresh connect without an OpenAPI contract creates the first API stack from
// --base-url, or from the one public API the code visibly calls, so the first
// session's notes have a committed home. Everything here is local fixtures:
// connect sends no API request, and the detected URLs are never contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT } from '../lib/layout.mjs';
import { CONTEXT_BASENAME, HOME_ENV_NAME, POINTER_BEGIN } from '../lib/brand.mjs';
import { detectFirstStack, hostClass, stackNameFromHost } from '../lib/first-stack.mjs';
import { upstreamUrls } from '../lib/audit.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTHING_KEPT = 'Nothing your agent calls is kept until a stack exists.';
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const stacksDir = f => join(f.root, LAYOUT.collection);
const stackNames = f => existsSync(stacksDir(f)) ? readdirSync(stacksDir(f)).filter(name => existsSync(join(stacksDir(f), name, 'stack.json'))).sort() : [];

function fixture(t, files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'connect-first-stack-nc-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const home = join(root, 'home'); mkdirSync(home);
  for (const [path, body] of Object.entries(files)) write(join(root, path), body);
  return { root, env: { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'state'), NO_COLOR: '1', API_USAGE_LOG: '' } };
}
async function command(f, args) {
  const child = spawn(process.execPath, [join(ROOT, 'bin/cli.mjs'), ...args], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { exit, stdout, stderr };
}
const passed = result => { assert.equal(result.exit, 0, result.stdout + result.stderr); return JSON.parse(result.stdout); };
const refused = (result, code) => {
  assert.notEqual(result.exit, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout || result.stderr).error.code, code, result.stdout + result.stderr);
};
const STRIPE_CALL = { 'src/pay.mjs': 'export const charge = () => fetch("https://api.stripe.com/v1/charges", { method: "POST" });\n' };

test('--base-url creates the first stack with stack add validation, scopes setup to it, and a note lands immediately', async t => {
  const f = fixture(t);
  const report = passed(await command(f, ['connect', '--base-url', 'https://api.acme.example.org/v1', '--auth', 'bearer:ACME_TOKEN', '--env', 'prod', '--stack', 'acme', '--json']));
  assert.deepEqual(report.first_stack, { action: 'created', stack: 'acme', base_url: 'https://api.acme.example.org/v1', source: 'flag', environment: 'prod' });
  assert.deepEqual(json(join(stacksDir(f), 'acme', 'stack.json')), { v: 1, name: 'acme', default_environment: 'prod',
    environments: { prod: { baseUrl: 'https://api.acme.example.org/v1', auth: 'bearer:ACME_TOKEN' } } });
  assert.ok(existsSync(join(stacksDir(f), 'acme', CONTEXT_BASENAME)));
  for (const path of [`${LAYOUT.collection}/acme/stack.json`, `${LAYOUT.collection}/acme/${CONTEXT_BASENAME}`])
    assert.ok(report.touched_files.some(row => row.path === path && row.action === 'created'), path);
  assert.equal(report.setup.context.state, 'available');
  assert.ok(!JSON.stringify(report).includes(NOTHING_KEPT));
  const note = passed(await command(f, ['note', 'GET /v1/widgets', 'Widgets page with an opaque cursor.', '--json']));
  assert.equal(note.file, `${LAYOUT.collection}/acme/${CONTEXT_BASENAME}`);
  // A name derived from the host when --stack is absent.
  const g = fixture(t);
  assert.equal(passed(await command(g, ['connect', '--base-url', 'https://api.stripe.com', '--json'])).first_stack.stack, 'stripe');
});

test('--base-url refuses credentials, a query, a bad credential reference and a missing URL, writes nothing and echoes no value', async t => {
  for (const [args, code] of [
    [['--base-url', 'https://user:hunter2-secret@api.acme.io/v1'], 'STACK_URL_INVALID'],
    [['--base-url', 'https://api.acme.io/v1?api_key=hunter2-secret'], 'STACK_URL_INVALID'],
    [['--base-url', 'ftp://api.acme.io'], 'STACK_URL_INVALID'],
    [['--base-url', 'https://api.acme.io', '--auth', 'hunter2-secret'], 'STACK_AUTH_INVALID'],
    [['--auth', 'bearer:ACME_TOKEN'], 'STACK_URL_REQUIRED'],
    [['--base-url', 'https://api.acme.io', '--stack', 'Not A Name'], 'STACK_NAME_INVALID'],
  ]) {
    const f = fixture(t);
    const result = await command(f, ['connect', ...args, '--json']);
    refused(result, code);
    assert.ok(!(result.stdout + result.stderr).includes('hunter2'), `${code} echoed a value`);
    assert.deepEqual(readdirSync(f.root).sort(), ['.git', 'home'], `${code} wrote setup files`);
  }
});

test('exactly one detected public API becomes the first stack, chosen from code; package metadata is never an API', async t => {
  const f = fixture(t, { ...STRIPE_CALL,
    'package.json': JSON.stringify({ name: 'x', homepage: 'https://example.com/x', repository: { url: 'https://github.com/acme/x.git' }, bugs: 'https://github.com/acme/x/issues' }),
    'tsconfig.json': JSON.stringify({ $schema: 'https://json.schemastore.org/tsconfig' }) });
  const report = passed(await command(f, ['connect', '--json']));
  assert.deepEqual(report.first_stack, { action: 'created', stack: 'stripe', base_url: 'https://api.stripe.com',
    source: 'detected-in-code', file: 'src/pay.mjs', environment: 'default' });
  assert.deepEqual(stackNames(f), ['stripe']);
  assert.equal(json(join(stacksDir(f), 'stripe', 'stack.json')).environments.default.baseUrl, 'https://api.stripe.com');
  const note = await command(f, ['note', 'POST /v1/charges', 'Charges need an idempotency key on retry.']);
  assert.equal(note.exit, 0, note.stdout + note.stderr);
  assert.ok(readFileSync(join(stacksDir(f), 'stripe', CONTEXT_BASENAME), 'utf8').includes('idempotency key'));
  const human = await command(fixture(t, STRIPE_CALL), ['connect']);
  assert.match(human.stdout, /First API stack created: stripe → https:\/\/api\.stripe\.com, detected in code \(src\/pay\.mjs\)\./);
});

test('several public APIs create nothing and list each candidate with a ready stack add command', async t => {
  const f = fixture(t, { 'src/a.mjs': 'await fetch("https://api.stripe.com/v1/charges");\nawait fetch("https://api.github.com/user");\n' });
  const report = passed(await command(f, ['connect', '--json']));
  assert.equal(report.first_stack.action, 'none');
  assert.equal(report.first_stack.message, NOTHING_KEPT);
  assert.deepEqual(report.first_stack.candidates.map(row => [row.stack, row.base_url, row.file]),
    [['github', 'https://api.github.com', 'src/a.mjs'], ['stripe', 'https://api.stripe.com', 'src/a.mjs']]);
  for (const row of report.first_stack.candidates) assert.match(row.command, new RegExp(` stack add ${row.stack} --base-url ${row.base_url.replace(/[.]/g, '\\.')}$`));
  assert.deepEqual(stackNames(f), []);
  const human = await command(f, ['connect']);
  assert.ok(human.stdout.includes(NOTHING_KEPT));
  assert.match(human.stdout, /stack add github --base-url https:\/\/api\.github\.com/);
});

test('no detected API creates nothing and says plainly that nothing is kept', async t => {
  const f = fixture(t, { 'src/a.mjs': 'console.log("no calls here");\n' });
  const report = passed(await command(f, ['connect', '--json']));
  assert.deepEqual({ ...report.first_stack, next: undefined }, { action: 'none', candidates: [], message: NOTHING_KEPT, next: undefined });
  assert.match(report.first_stack.next, /connect --base-url <url>/);
  assert.deepEqual(stackNames(f), []);
  assert.ok((await command(f, ['connect'])).stdout.includes(NOTHING_KEPT));
});

test('loopback and private-network APIs are listed but never chosen automatically', async t => {
  const f = fixture(t, { 'src/a.mjs': 'await fetch("http://localhost:4000/items");\nconst base = "http://10.0.0.7:8080";\nawait fetch(`${base}/x`);\n' });
  const report = passed(await command(f, ['connect', '--json']));
  assert.equal(report.first_stack.action, 'none');
  assert.deepEqual(report.first_stack.candidates.map(row => [row.base_url, row.host_class]),
    [['http://10.0.0.7:8080', 'private'], ['http://localhost:4000', 'loopback']]);
  assert.ok(report.first_stack.candidates.every(row => /never chosen automatically/.test(row.reason)));
  assert.deepEqual(stackNames(f), []);
  // One public API beside a loopback one is still chosen; the loopback one is listed.
  const g = fixture(t, { 'src/a.mjs': 'await fetch("http://localhost:4000/items");\nawait fetch("https://api.stripe.com/v1/charges");\n' });
  const mixed = passed(await command(g, ['connect', '--json']));
  assert.equal(mixed.first_stack.stack, 'stripe');
  assert.deepEqual(mixed.first_stack.candidates.map(row => row.base_url), ['http://localhost:4000']);
});

test('an existing stack and a legacy store take precedence; --base-url then refuses without writing', async t => {
  const f = fixture(t, STRIPE_CALL);
  passed(await command(f, ['stack', 'add', 'billing', '--base-url', 'https://billing.example.test', '--json']));
  const before = readFileSync(join(stacksDir(f), 'billing', 'stack.json'), 'utf8');
  const report = passed(await command(f, ['connect', '--json']));
  assert.equal(report.first_stack, undefined);
  assert.deepEqual(stackNames(f), ['billing']);
  assert.equal(readFileSync(join(stacksDir(f), 'billing', 'stack.json'), 'utf8'), before);
  const flagged = await command(f, ['connect', '--base-url', 'https://api.stripe.com', '--json']);
  refused(flagged, 'STACK_EXISTS');
  assert.deepEqual(stackNames(f), ['billing']);

  const legacy = fixture(t, { ...STRIPE_CALL, [LAYOUT.context]: JSON.stringify({ v: 0, api: { name: 'Legacy', contract: null }, operations: {} }) });
  passed(await command(legacy, ['connect', '--json']));
  assert.deepEqual(stackNames(legacy), []);
  refused(await command(legacy, ['connect', '--base-url', 'https://api.stripe.com', '--json']), 'STACKS_MIGRATION_REQUIRED');
});

test('the contract path is unchanged, and --base-url only supplies its base URL', async t => {
  const spec = { openapi: '3.0.3', info: { title: 'Setup Fixture API', version: '1' }, paths: { '/health': { get: { responses: { 200: { description: 'ok' } } } } } };
  const f = fixture(t, { ...STRIPE_CALL, 'openapi.json': JSON.stringify(spec) });
  const report = passed(await command(f, ['connect', '--json']));
  assert.deepEqual(stackNames(f), ['setup-fixture'], 'a contract outranks the detected upstream');
  assert.equal(report.first_stack.source, 'contract');
  assert.equal(report.first_stack.action, 'created');
  assert.ok(json(join(stacksDir(f), 'setup-fixture', CONTEXT_BASENAME)).operations['GET /health']);
  const g = fixture(t, { 'openapi.json': JSON.stringify(spec) });
  passed(await command(g, ['connect', '--base-url', 'https://setup.example.org', '--json']));
  assert.equal(json(join(stacksDir(g), 'setup-fixture', 'stack.json')).environments.default.baseUrl, 'https://setup.example.org');
});

test('dry run creates nothing and reports the stack it would create', async t => {
  const f = fixture(t, STRIPE_CALL);
  const report = passed(await command(f, ['connect', '--dry-run', '--json']));
  assert.equal(report.first_stack.action, 'would create');
  assert.equal(report.first_stack.stack, 'stripe');
  for (const path of [`${LAYOUT.collection}/stripe/stack.json`, `${LAYOUT.collection}/stripe/${CONTEXT_BASENAME}`])
    assert.ok(report.planned_files.some(row => row.path === path), path);
  assert.deepEqual(report.touched_files, []);
  assert.deepEqual(readdirSync(f.root).sort(), ['.git', 'home', 'src']);
  const flagged = passed(await command(f, ['connect', '--dry-run', '--base-url', 'https://api.acme.io', '--json']));
  assert.equal(flagged.first_stack.action, 'would create');
  assert.deepEqual(readdirSync(f.root).sort(), ['.git', 'home', 'src']);
});

test('a second connect creates no second stack and leaves the first byte-identical', async t => {
  const f = fixture(t, STRIPE_CALL);
  passed(await command(f, ['connect', '--json']));
  write(join(f.root, 'src/more.mjs'), 'await fetch("https://api.github.com/user");\n');
  const before = readFileSync(join(stacksDir(f), 'stripe', 'stack.json'), 'utf8');
  const again = passed(await command(f, ['connect', '--json']));
  assert.equal(again.first_stack, undefined);
  assert.deepEqual(stackNames(f), ['stripe']);
  assert.equal(readFileSync(join(stacksDir(f), 'stripe', 'stack.json'), 'utf8'), before);
});

test('a blocked setup writes no stack, even when one API was detected or named', async t => {
  for (const args of [[], ['--base-url', 'https://api.acme.io']]) {
    const f = fixture(t, { ...STRIPE_CALL, 'AGENTS.md': `${POINTER_BEGIN}\nUnclosed project guidance.\n` });
    const result = await command(f, ['connect', ...args, '--json']);
    assert.notEqual(result.exit, 0);
    assert.equal(JSON.parse(result.stdout).first_stack.action, 'not created');
    assert.equal(existsSync(join(f.root, LAYOUT.directory)), false);
    assert.equal(existsSync(join(f.root, '.mcp.json')), false);
  }
});

test('host classes and stack names are deterministic', t => {
  assert.deepEqual(['api.stripe.com', 'localhost', 'app.localhost', '127.0.0.1', '[::1]', '10.1.2.3', '172.20.0.1', '192.168.1.1', 'catalog', 'svc.internal', 'api.example.com', 'x.test', '8.8.8.8'].map(hostClass),
    ['public', 'loopback', 'loopback', 'loopback', 'loopback', 'private', 'private', 'private', 'private', 'private', 'reserved', 'reserved', 'public']);
  assert.deepEqual(['api.stripe.com', 'stripe.com', 'hooks.slack.com', 'myapp.herokuapp.com', 'api.foo.co.uk', '10.0.0.5', 'api.io', 'sannr-feedback.io'].map(stackNameFromHost),
    ['stripe', 'stripe', 'slack', 'myapp', 'foo', 'api', 'api', 'api']);
  const f = fixture(t, { 'src/a.mjs': 'await fetch("https://api.stripe.com/a");\nawait fetch("https://files.stripe.com/b");\n' });
  const { selected, candidates } = detectFirstStack(f.root, upstreamUrls(f.root, null), { cli: 'sannr' });
  assert.equal(selected, null);
  assert.deepEqual(candidates.map(row => row.stack), ['stripe', 'stripe-2'], 'colliding names get a deterministic suffix in origin order');
});
