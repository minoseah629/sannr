import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as stacks from '../lib/stacks.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';
import { loadContext, saveContext, updateContext } from '../lib/context.mjs';
import { PRODUCT, CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const builtinName = `${PRODUCT}-feedback`;
const baseUrl = `https://${PRODUCT}.dev/api/v1`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'feedback-stack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function writeJson(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }
function writeStack(root, name, base = 'https://service.example.test') {
  writeJson(join(root, LAYOUT.collection, name, 'stack.json'), {
    v: 1, name, default_environment: 'local', environments: { local: { baseUrl: base } },
  });
}
async function cli(root, args) {
  const child = spawn(process.execPath, [join(packageRoot, 'bin/cli.mjs'), ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'), API_USAGE_LOG: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); });
}

test('feedback (f): built-in stack is explicit catalog inventory without becoming a repository or default stack', t => {
  const root = fixture(t);
  assert.equal(stacks.stackCatalog(root).stacks.length, 0);
  assert.equal(stacks.stackProjectRoot(root), root);
  assert.equal(stacks.resolveStack(root, { path: '/users' }), null);
  const catalog = stacks.stackCatalog(root, { includeBuiltin: true });
  assert.deepEqual(catalog.problems, []);
  assert.equal(catalog.stacks.filter(row => row.name === builtinName).length, 1);
  assert.equal(catalog.stacks.find(row => row.name === builtinName).readOnly, true);
  writeStack(root, 'api');
  assert.equal(stacks.resolveStack(root, { path: '/users' }).stack, 'api');
});

test('feedback (f): explicit built-in resolution reads packaged knowledge and binds private project evidence', t => {
  const root = fixture(t), scope = stacks.stackScope(root, { stack: builtinName });
  assert.ok(scope, 'the shipped stack resolves even before connect');
  assert.equal(scope.builtin, true); assert.equal(scope.readOnly, true);
  assert.equal(scope.config.baseUrl, baseUrl);
  assert.equal(resolve(root, scope.contextFile), join(packageRoot, 'stacks', builtinName, CONTEXT_BASENAME));
  assert.equal(scope.evidenceDir, `${LAYOUT.evidence}/${builtinName}`);
  assert.equal(scope.config.defaults.evidenceDir, scope.evidenceDir);
  assert.equal(scope.config.capture, false);
  withStackScope(scope, () => {
    const context = loadContext(root);
    assert.deepEqual(Object.keys(context.operations).sort(), ['GET /feedback/schema', 'POST /feedback']);
    assert.ok(context.operations['POST /feedback'].notes.some(note => /30.second/i.test(note)));
  });
});

test('feedback (f): repository stack shadows and ambient credentials cannot replace the packaged sender', t => {
  const root = fixture(t), saved = { ...process.env };
  writeStack(root, builtinName, 'https://redirect.example.test');
  try {
    Object.assign(process.env, { API_ENV: 'hijacked', API_AUTH: 'bearer:SYNTHETIC_TOKEN', API_BASE_URL: 'https://redirect.example.test',
      API_CONFIG: join(root, 'malicious.json'), API_ENV_FILE: join(root, 'secrets.env'), API_CONTRACT: join(root, 'fake.json'), API_EVIDENCE: 'outside' });
    writeJson(process.env.API_CONFIG, { default: 'hijacked', environments: { hijacked: { baseUrl: 'https://redirect.example.test', headers: { 'X-Extra': 'synthetic' } } } });
    const scope = stacks.resolveStack(root, { stack: builtinName, path: '/feedback' });
    assert.equal(scope.config.baseUrl, baseUrl);
    assert.equal(scope.config.auth, undefined);
    assert.deepEqual(scope.config.headers, {}); assert.deepEqual(scope.config.credentialEnvFiles, []);
    assert.equal(scope.config.name, 'public');
    assert.equal(scope.config.contract, join(packageRoot, 'stacks', builtinName, 'feedback.openapi.json'));
    assert.equal(scope.config.defaults.evidenceDir, `${LAYOUT.evidence}/${builtinName}`);
    assert.equal(resolveConfig(root, { stack: builtinName, path: '/feedback' }).baseUrl, baseUrl);
    assert.equal(stacks.stackCatalog(root, { includeBuiltin: true }).stacks.filter(row => row.name === builtinName).length, 1);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});

test('feedback (f): endpoint URL selects the built-in ahead of repo origin overlap and refuses another target', t => {
  const root = fixture(t); writeStack(root, 'other', baseUrl);
  assert.equal(stacks.resolveStack(root, { path: `${baseUrl}/feedback` }).stack, builtinName);
  assert.equal(stacks.resolveStack(root, { path: `${baseUrl}/feedback/schema` }).stack, builtinName);
  assert.throws(() => stacks.resolveStack(root, { stack: builtinName, path: 'https://redirect.example.test/feedback' }), error => error.code === 'ORIGIN_NOT_CONFIGURED');
  assert.throws(() => stacks.resolveStack(root, { stack: 'other', path: `${baseUrl}/feedback` }), error => error.code === 'FEEDBACK_STACK_REQUIRED');
  assert.equal(stacks.resolveStack(root, { path: `${baseUrl}/elsewhere` }).stack, builtinName, 'the whole first-party hostname is reserved; dispatch rejects undeclared paths');
});

test('feedback (f): built-in identity cannot be created or declared as the repository default', t => {
  const root = fixture(t);
  assert.throws(() => stacks.createStack(root, builtinName, { baseUrl: 'https://service.example.test' }), error => error.code === 'STACK_READ_ONLY');
  assert.equal(existsSync(join(root, LAYOUT.collection, builtinName)), false);
  writeJson(join(root, LAYOUT.directory, 'defaults.json'), { default_stack: builtinName });
  assert.equal(stacks.stackCatalog(root).problems[0]?.code, 'STACK_DEFAULT_READ_ONLY');
});

test('feedback (a): defaults validate only ask, allow and never with no unknown nested policy', t => {
  const root = fixture(t), file = join(root, LAYOUT.directory, 'defaults.json');
  for (const send of ['ask', 'allow', 'never']) {
    writeJson(file, { feedback: { send } });
    const catalog = stacks.stackCatalog(root);
    assert.deepEqual(catalog.problems, [], send); assert.equal(catalog.defaults.feedback.send, send);
  }
  for (const feedback of [{ send: 'yes' }, { send: true }, { send: 'allow', target: 'https://service.example.test' }, null, [], 'allow']) {
    writeJson(file, { feedback });
    assert.equal(stacks.stackCatalog(root).problems[0]?.code, 'FEEDBACK_POLICY_INVALID');
  }
});

test('feedback (f): stacks and show expose packaged day-one knowledge without a repository stack', async t => {
  const root = fixture(t), listed = await cli(root, ['stacks', '--json']);
  assert.equal(listed.code, 0, listed.stderr);
  const stack = JSON.parse(listed.stdout).stacks.find(row => row.name === builtinName);
  assert.ok(stack); assert.equal(stack.counts.operations, 2); assert.equal(stack.contract.state, 'bound');
  const shown = await cli(root, ['show', '--stack', builtinName]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /POST \/feedback/); assert.match(shown.stdout, /30.second/i);
});

test('feedback (f): note, review and learn refuse built-in knowledge without touching packaged bytes', async t => {
  const root = fixture(t), path = join(packageRoot, 'stacks', builtinName, CONTEXT_BASENAME);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  for (const args of [['note', 'POST /feedback', 'Replace destination'], ['review', '--accept-notes'], ['learn', '--read-only']]) {
    const result = await cli(root, [...args, '--stack', builtinName]);
    assert.notEqual(result.code, 0); assert.match(result.stdout + result.stderr, /STACK_READ_ONLY/);
  }
  assert.ok(before); assert.equal(readFileSync(path, 'utf8'), before);
});

// The package path is never passed to a writer before this guard is checked.
test('feedback (f): context writes reject read-only scope before creating layout or locks', t => {
  const root = fixture(t), scope = { root, stack: builtinName, readOnly: true, contextFile: 'untouched.json' };
  withStackScope(scope, () => {
    assert.throws(() => saveContext(root, { v: 0, operations: {} }), error => error.code === 'STACK_READ_ONLY');
    assert.throws(() => updateContext(root, () => assert.fail('readonly updater was invoked')), error => error.code === 'STACK_READ_ONLY');
  });
  assert.equal(existsSync(join(root, LAYOUT.directory)), false);
  assert.equal(existsSync(join(root, 'untouched.json')), false);
});

test('feedback (f): explicit feedback configuration cannot inherit an active repository stack', t => {
  const root = fixture(t); writeStack(root, 'api');
  withStackScope(stacks.stackScope(root, { stack: 'api' }), () => {
    assert.equal(resolveConfig(root, { stack: builtinName, path: '/feedback' }).baseUrl, baseUrl);
    assert.equal(resolveConfig(root, { path: `${baseUrl}/feedback` }).stack, builtinName);
  });
});

test('feedback host reservation includes encoded, trailing and alternate-origin requests', () => {
  const hostname = new URL(baseUrl).hostname;
  for (const path of [`${baseUrl}/feedback/`, `${baseUrl}/%66eedback`, `${baseUrl}/elsewhere`,
    `http://${hostname}/api/v1/feedback`, `https://${hostname}:8443/api/v1/feedback`, `https://${hostname}./api/v1/feedback`])
    assert.equal(stacks.isBuiltinFeedbackTarget(path), true, path);
  assert.equal(stacks.isBuiltinFeedbackTarget(`https://${hostname}.example.test/api/v1/feedback`), false);
});

async function forbiddenTransport(t, kind) {
  const root = fixture(t), file = new URL('../lib/client.mjs', import.meta.url).href;
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_USAGE_LOG: '', API_CONTEXT_DIR: root, API_CONTEXT_OFF: '1',
    API_BASE_URL: kind === 'oauth' ? 'https://service.example.test' : baseUrl,
    ...(kind === 'oauth' ? { API_AUTH: 'oauth:FIXTURE_ID:FIXTURE_SECRET', FIXTURE_ID: 'synthetic-id',
      FIXTURE_SECRET: 'synthetic-secret', API_OAUTH_TOKEN_URL: `${baseUrl}/feedback` } : {}),
  };
  const source = `let calls=0;globalThis.fetch=async(url,init)=>{calls++;return new Response('{"field":"body"}',{status:400,headers:{'content-type':'application/json'}})};
    const {apiRequest}=await import(${JSON.stringify(file)});
    const result=await apiRequest(${JSON.stringify(kind === 'oauth' ? { method: 'GET', path: '/users' }
      : { protocol: 'jsonrpc', path: '/feedback', rpc: { method: 'probe' } })});
    console.log(JSON.stringify({calls,ok:result.ok,error:result.error}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

test('feedback guard prevents legacy relative JSON-RPC requests from bypassing send policy', async t => {
  const result = await forbiddenTransport(t, 'jsonrpc');
  assert.equal(result.calls, 0, 'protocol dispatch must refuse before any fetch, receipt or credentials');
  assert.equal(result.ok, false);
});

test('feedback guard prevents OAuth token URLs from sending credentials to the reserved hostname', async t => {
  const result = await forbiddenTransport(t, 'oauth');
  assert.equal(result.calls, 0, 'OAuth credentials must never cross the optional-feedback boundary');
  assert.equal(result.ok, false);
});
