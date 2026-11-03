import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialEnvironment, loadEnvFile, resolveConfig } from '../lib/config.mjs';

const serverFile = fileURLToPath(new URL('../server.mjs', import.meta.url));
const TOKEN = 'ROTATION_FIXTURE_TOKEN';
const first = 'fixture-initial-not-a-real-token';
const second = 'fixture-rotated-not-a-real-token';
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function fixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), 'env-rotation-'));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); });
  return { dir, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function mcp(t, dir, config, overrides = {}) {
  const configPath = join(dir, 'environments.json');
  writeFileSync(configPath, JSON.stringify(config));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('API_') && !key.startsWith('ROTATION_FIXTURE_')));
  Object.assign(env, { HOME: dir, API_CONFIG: configPath, API_CONTEXT_DIR: dir, API_CONTEXT_OFF: '1', API_EVIDENCE: join(dir, 'evidence'), API_FRICTION_OFF: '1', API_TIMEOUT_MS: '3000' }, overrides);
  const child = spawn(process.execPath, [serverFile], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 0;
  // Child output contains envelopes, never print it as part of a failed test.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { return; }
    const waiter = pending.get(value.id);
    if (waiter) { pending.delete(value.id); clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  child.on('exit', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('MCP exited before response')); } pending.clear(); });
  t.after(async () => { child.stdin.end(); child.kill(); await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); }); lines.close(); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP response timed out')); }, 7000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'env-rotation-fixture', version: '1' } });
  return {
    pid: child.pid,
    async request(args = {}) {
      const reply = await rpc('tools/call', { name: 'api_request', arguments: { method: 'GET', path: '/health', expect: [{ status: 200 }], ...args } });
      assert.equal(reply.error, undefined, 'MCP request must be accepted');
      const wire = reply.result.content.find(item => item.type === 'text').text;
      assert.equal([first, second].some(value => wire.includes(value)), false, 'MCP must not reveal credential values');
      return JSON.parse(wire);
    },
  };
}

test('one running MCP session uses a rotated file token on its next request', { timeout: 15000 }, async t => {
  let expected = first;
  const received = [];
  const { dir, baseUrl } = await fixture(t, (req, res) => {
    const valid = req.headers.authorization === `Bearer ${expected}`;
    received.push(valid);
    json(res, valid ? 200 : 401, { authenticated: valid });
  });
  const envFile = join(dir, 'credentials.env');
  writeFileSync(envFile, `${TOKEN}=${first}\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `bearer:${TOKEN}`, envFile } } });
  assert.equal((await session.request()).status, 200);
  expected = second;
  writeFileSync(envFile + '.next', `${TOKEN}=${second}\n`);
  renameSync(envFile + '.next', envFile);
  assert.equal((await session.request()).status, 200, 'token rotation must take effect without restarting MCP');
  assert.deepEqual(received, [true, true]);
  assert.equal(typeof session.pid, 'number');
});

for (const scheme of ['header', 'query']) {
  test(`file-backed ${scheme} credentials rotate within the same MCP session`, { timeout: 15000 }, async t => {
    let expected = first;
    const { dir, baseUrl } = await fixture(t, (req, res) => {
      const value = scheme === 'header' ? req.headers['x-api-key'] : new URL(req.url, 'http://fixture.local').searchParams.get('api_key');
      json(res, value === expected ? 200 : 401, { authenticated: value === expected });
    });
    const envFile = join(dir, 'credentials.env');
    writeFileSync(envFile, `${TOKEN}=${first}\n`);
    const auth = scheme === 'header' ? `header:X-API-Key:${TOKEN}` : `query:api_key:${TOKEN}`;
    const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth, envFile } } });
    assert.equal((await session.request()).status, 200);
    expected = second;
    writeFileSync(envFile, `${TOKEN}=${second}\n`);
    assert.equal((await session.request()).status, 200);
  });
}

test('inherited credentials keep precedence when their file is changed or removed', { timeout: 15000 }, async t => {
  const received = [];
  const { dir, baseUrl } = await fixture(t, (req, res) => {
    const valid = req.headers.authorization === `Bearer ${second}`;
    received.push(valid);
    json(res, valid ? 200 : 401, { authenticated: valid });
  });
  const envFile = join(dir, 'credentials.env');
  writeFileSync(envFile, `${TOKEN}=${first}\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `bearer:${TOKEN}`, envFile } } }, { [TOKEN]: second });
  assert.equal((await session.request()).status, 200);
  writeFileSync(envFile, `${TOKEN}=irrelevant-file-replacement\n`);
  assert.equal((await session.request()).status, 200);
  rmSync(envFile);
  assert.equal((await session.request()).status, 200);
  assert.deepEqual(received, [true, true, true]);
});

test('a request after rotation cannot coalesce onto an older authenticated request in flight', { timeout: 15000 }, async t => {
  let releaseFirst, announceFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const started = new Promise(resolve => { announceFirst = resolve; });
  const received = [];
  const { dir, baseUrl } = await fixture(t, async (req, res) => {
    const index = received.length;
    const valid = req.headers.authorization === `Bearer ${index === 0 ? first : second}`;
    received.push(valid);
    if (index === 0) { announceFirst(); await held; }
    json(res, valid ? 200 : 401, { authenticated: valid });
  });
  const envFile = join(dir, 'credentials.env');
  writeFileSync(envFile, `${TOKEN}=${first}\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `bearer:${TOKEN}`, envFile } } }, { API_CONCURRENCY: '2', API_TIMEOUT_MS: '10000' });
  const original = session.request();
  await started;
  writeFileSync(envFile, `${TOKEN}=${second}\n`);
  let rotated;
  // With two lanes, the second must finish before the first is released. A
  // coalesced call would wait on the held response and fail the bounded test.
  try { rotated = await session.request(); }
  finally { releaseFirst(); }
  assert.equal((await original).status, 200);
  assert.equal(rotated.status, 200);
  assert.deepEqual(received, [true, true]);
  assert.equal(rotated.coalesced, undefined);
});

test('removed, absent and unreadable files cannot reuse the startup token; recovery needs no restart', { timeout: 15000 }, async t => {
  const received = [];
  const { dir, baseUrl } = await fixture(t, (req, res) => {
    const supplied = req.headers.authorization !== undefined;
    received.push(supplied);
    json(res, req.headers.authorization === `Bearer ${first}` ? 200 : 401, { authenticated: supplied });
  });
  const envFile = join(dir, 'credentials.env');
  writeFileSync(envFile, `${TOKEN}=${first}\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `bearer:${TOKEN}`, envFile } } });
  assert.equal((await session.request()).status, 200);
  writeFileSync(envFile, 'UNRELATED_FIXTURE_KEY=unrelated\n');
  assert.equal((await session.request()).status, 401);
  rmSync(envFile);
  assert.equal((await session.request()).status, 401);
  // A directory is deterministically unreadable as an env file, even as root.
  mkdirSync(envFile);
  assert.equal((await session.request()).status, 401);
  rmSync(envFile, { recursive: true });
  writeFileSync(envFile, `${TOKEN}=${first}\n`);
  assert.equal((await session.request()).status, 200);
  assert.deepEqual(received, [true, false, false, false, true]);
});

test('API_ENV_FILE rotates when no project envFile is configured', { timeout: 15000 }, async t => {
  let expected = first;
  const { dir, baseUrl } = await fixture(t, (req, res) => json(res, req.headers.authorization === `Bearer ${expected}` ? 200 : 401, { ok: true }));
  const envFile = join(dir, 'fallback.env');
  writeFileSync(envFile, `${TOKEN}=${first}\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `bearer:${TOKEN}` } } }, { API_ENV_FILE: envFile });
  assert.equal((await session.request()).status, 200);
  expected = second;
  writeFileSync(envFile, `${TOKEN}=${second}\n`);
  assert.equal((await session.request()).status, 200);
});

test('upstreams sharing an env-var name use only their own file, including concurrent requests', { timeout: 15000 }, async t => {
  const expected = { '/primary/health': first, '/other/health': second };
  const received = [];
  const { dir, baseUrl } = await fixture(t, (req, res) => {
    const valid = req.headers.authorization === `Bearer ${expected[req.url]}`;
    received.push({ path: req.url, valid, supplied: req.headers.authorization !== undefined });
    json(res, valid ? 200 : 401, { authenticated: valid });
  });
  const primaryFile = join(dir, 'primary.env'), otherFile = join(dir, 'other.env');
  writeFileSync(primaryFile, `${TOKEN}=${first}\n`);
  writeFileSync(otherFile, `${TOKEN}=${second}\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl: baseUrl + '/primary', auth: `bearer:${TOKEN}`, envFile: primaryFile } }, hosts: { other: { baseUrl: baseUrl + '/other', auth: `bearer:${TOKEN}`, envFile: otherFile } } });
  assert.deepEqual((await Promise.all([session.request(), session.request({ upstream: 'other' })])).map(row => row.status), [200, 200]);
  expected['/primary/health'] = second;
  writeFileSync(primaryFile, `${TOKEN}=${second}\n`);
  assert.deepEqual((await Promise.all([session.request(), session.request({ upstream: 'other' })])).map(row => row.status), [200, 200]);
  rmSync(otherFile);
  assert.equal((await session.request({ upstream: 'other' })).status, 401);
  assert.equal(received.at(-1).supplied, false, 'missing upstream file must not fall back to primary credential');
  assert.equal((await session.request()).status, 200);
  assert.equal(received.filter(row => row.valid).length, 5);
});

test('OAuth client-secret rotation invalidates an unexpired grant in a running MCP session', { timeout: 15000 }, async t => {
  const idName = 'ROTATION_FIXTURE_CLIENT_ID', secretName = 'ROTATION_FIXTURE_CLIENT_SECRET';
  let expectedSecret = first, issued = 0;
  const seenCredentials = [];
  const { dir, baseUrl } = await fixture(t, async (req, res) => {
    if (req.url === '/token') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const valid = form.get('client_id') === 'synthetic-client' && form.get('client_secret') === expectedSecret;
      seenCredentials.push(valid);
      if (!valid) return json(res, 401, { error: 'invalid_client' });
      issued += 1;
      return json(res, 200, { access_token: `synthetic-access-${issued}`, expires_in: 3600 });
    }
    const valid = req.headers.authorization === `Bearer synthetic-access-${issued}` && issued > 0;
    json(res, valid ? 200 : 401, { authenticated: valid });
  });
  const envFile = join(dir, 'credentials.env');
  const write = value => writeFileSync(envFile, `${idName}=synthetic-client\n${secretName}=${value}\n`);
  write(first);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `oauth:${idName}:${secretName}`, envFile } } }, { API_OAUTH_TOKEN_URL: baseUrl + '/token' });
  assert.equal((await session.request()).status, 200);
  assert.equal((await session.request()).status, 200);
  assert.equal(issued, 1, 'unchanged credentials should reuse a grant');
  expectedSecret = second;
  write(second);
  assert.equal((await session.request()).status, 200);
  assert.equal(issued, 2, 'new client secret must obtain a new grant even while old access token is unexpired');
  rmSync(envFile);
  assert.equal((await session.request()).status, 401);
  assert.equal(issued, 2, 'missing credentials must not reuse the cached grant or contact token endpoint');
  assert.deepEqual(seenCredentials, [true, true]);
});

test('OAuth endpoints and scopes cannot bleed between provider files in one MCP session', { timeout: 15000 }, async t => {
  const idName = 'ROTATION_FIXTURE_CLIENT_ID', secretName = 'ROTATION_FIXTURE_CLIENT_SECRET';
  const grants = [];
  const { dir, baseUrl } = await fixture(t, async (req, res) => {
    if (req.url.endsWith('/token')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const provider = req.url.startsWith('/primary/') ? 'primary' : 'other';
      const valid = form.get('client_id') === `synthetic-${provider}`
        && form.get('client_secret') === (provider === 'primary' ? first : second);
      grants.push({ provider, valid, scope: form.get('scope') });
      if (!valid) return json(res, 401, { error: 'invalid_client' });
      return json(res, 200, { access_token: `synthetic-${provider}-access`, expires_in: 3600 });
    }
    const provider = req.url.startsWith('/primary/') ? 'primary' : 'other';
    const valid = req.headers.authorization === `Bearer synthetic-${provider}-access`;
    json(res, valid ? 200 : 401, { authenticated: valid });
  });
  const primaryFile = join(dir, 'primary.env'), otherFile = join(dir, 'other.env');
  const primaryCredentials = `${idName}=synthetic-primary\n${secretName}=${first}\n`;
  writeFileSync(primaryFile, primaryCredentials);
  writeFileSync(otherFile, `${idName}=synthetic-other\n${secretName}=${second}\nAPI_OAUTH_TOKEN_URL=${baseUrl}/other/token\nAPI_OAUTH_SCOPE=other-only\n`);
  const auth = `oauth:${idName}:${secretName}`;
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl: baseUrl + '/primary', auth, envFile: primaryFile } }, hosts: { other: { baseUrl: baseUrl + '/other', auth, envFile: otherFile } } });
  const blocked = await session.request();
  assert.equal(blocked.error?.code, 'OAUTH_TOKEN_URL_MISSING');
  assert.deepEqual(grants, [], 'primary credentials must not be sent to the other provider token endpoint');
  assert.equal((await session.request({ upstream: 'other' })).status, 200);
  writeFileSync(primaryFile, primaryCredentials + `API_OAUTH_TOKEN_URL=${baseUrl}/primary/token\n`);
  assert.equal((await session.request()).status, 200);
  assert.deepEqual(grants, [
    { provider: 'other', valid: true, scope: 'other-only' },
    { provider: 'primary', valid: true, scope: null },
  ]);
  writeFileSync(primaryFile, primaryCredentials);
  assert.equal((await session.request()).error?.code, 'OAUTH_TOKEN_URL_MISSING');
  assert.equal(grants.length, 2, 'removed endpoint cannot keep using an old grant or another host endpoint');
});

test('inherited OAuth endpoint and scope override provider file values', { timeout: 15000 }, async t => {
  const idName = 'ROTATION_FIXTURE_CLIENT_ID', secretName = 'ROTATION_FIXTURE_CLIENT_SECRET';
  const grants = [];
  const { dir, baseUrl } = await fixture(t, async (req, res) => {
    if (req.url.endsWith('/token')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      grants.push({ path: req.url, scope: form.get('scope') });
      return json(res, 200, { access_token: 'synthetic-inherited-access', expires_in: 3600 });
    }
    json(res, req.headers.authorization === 'Bearer synthetic-inherited-access' ? 200 : 401, { ok: true });
  });
  const envFile = join(dir, 'provider.env');
  writeFileSync(envFile, `${idName}=synthetic-client\n${secretName}=${first}\nAPI_OAUTH_TOKEN_URL=${baseUrl}/file/token\nAPI_OAUTH_SCOPE=file-only\n`);
  const session = await mcp(t, dir, { default: 'local', environments: { local: { baseUrl, auth: `oauth:${idName}:${secretName}`, envFile } } }, { API_OAUTH_TOKEN_URL: baseUrl + '/inherited/token', API_OAUTH_SCOPE: 'inherited-only' });
  assert.equal((await session.request()).status, 200);
  assert.deepEqual(grants, [{ path: '/inherited/token', scope: 'inherited-only' }]);
});

test('env-file ownership refreshes/removes only file values and isolates later configs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-ownership-'));
  const saved = { ...process.env };
  try {
    delete process.env[TOKEN]; delete process.env.API_ENV_FILE; delete process.env.API_ENV;
    const a = join(dir, 'a.env'), b = join(dir, 'b.env');
    writeFileSync(a, `${TOKEN}=${first}\n`); writeFileSync(b, `${TOKEN}=${second}\n`);
    loadEnvFile(a);
    assert.equal(process.env[TOKEN] === first, true);
    writeFileSync(a, `${TOKEN}=${second}\n`); loadEnvFile(a);
    assert.equal(process.env[TOKEN] === second, true);
    rmSync(a); loadEnvFile(a);
    assert.equal(process.env[TOKEN], undefined);
    writeFileSync(a, `${TOKEN}=${first}\n`); loadEnvFile(a);
    process.env[TOKEN] = second; loadEnvFile(a);
    assert.equal(process.env[TOKEN] === second, true, 'explicit in-process override must win');
    delete process.env[TOKEN];
    const config = join(dir, 'environments.json'); process.env.API_CONFIG = config;
    writeFileSync(config, JSON.stringify({ default: 'local', environments: { local: { envFile: a } } }));
    const firstConfig = resolveConfig(dir);
    writeFileSync(config, JSON.stringify({ default: 'local', environments: { local: { envFile: b } } }));
    const secondConfig = resolveConfig(dir);
    assert.equal(credentialEnvironment(firstConfig.credentialEnvFiles)[TOKEN] === first, true);
    assert.equal(credentialEnvironment(secondConfig.credentialEnvFiles)[TOKEN] === second, true);
    rmSync(b);
    assert.equal(credentialEnvironment(secondConfig.credentialEnvFiles)[TOKEN], undefined);
    resolveConfig(dir);
    assert.equal(process.env[TOKEN], undefined);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  }
});
