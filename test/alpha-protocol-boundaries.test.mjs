import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync,  readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {  HOME_ENV_NAME, PRODUCT } from "../lib/brand.mjs";

const CLIENT = new URL('../lib/client.mjs', import.meta.url).href;
const query = { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Item { item }' } };
const subscription = { protocol: 'graphql', path: '/graphql', graphql: { document: 'subscription Events { event }' } };
const stream = { protocol: 'websocket', path: '/events', websocket: { operation: 'events.listen' } };

async function fixture(t, { production = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-protocol-boundaries-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push('http');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body.jsonrpc ? { jsonrpc: '2.0', id: body.id, result: body.params }
      : { data: body.variables ?? { item: true } }));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => {
    calls.push('websocket');
    socket.on('error', () => {});
    if (!socket.protocol) { socket.send(JSON.stringify({ ready: true })); socket.close(1000); }
    else socket.on('message', bytes => {
      const frame = JSON.parse(bytes);
      if (frame.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
      if (frame.type === 'subscribe') socket.send(JSON.stringify({ id: frame.id, type: 'complete' }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'fixture', environments: {
    fixture: { baseUrl: `http://127.0.0.1:${server.address().port}`, production },
  } }));
  writeFileSync(join(root, 'service.proto'), 'syntax = "proto3"; package fixture; service Service { rpc Read (Input) returns (Input); } message Input { string password = 1; }');
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('API_') && !name.startsWith(`${PRODUCT.toUpperCase()}_`)));
  Object.assign(env, { API_ENV_FILE: '', API_CONFIG: join(root, LAYOUT.environments), API_CONTEXT_DIR: root,
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'),
    API_BUDGET: '100000', API_TIMEOUT_MS: '3000', [HOME_ENV_NAME]: join(root, '.home') });
  const run = (requests, overrides = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      const { apiRequest } = await import(${JSON.stringify(CLIENT)});
      const delays = [], schedule = globalThis.setTimeout;
      globalThis.setTimeout = (fn, delay, ...args) => { delays.push(delay); return schedule(fn, delay, ...args); };
      const results = [];
      for (const request of JSON.parse(readFileSync(0, 'utf8'))) results.push(await apiRequest(request));
      process.stdout.write(JSON.stringify({ results, delays }));
    `], { cwd: root, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture deadline exceeded.')); }, 15000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Fixture child failed.'));
      resolve({ ...JSON.parse(stdout), stdout, stderr });
    });
    child.stdin.end(JSON.stringify(requests));
  });
  const surfaces = () => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8')).join('\n');
  return { root, run, calls, surfaces };
}

test('AH-3.2 inherited API_TIMEOUT_MS=900000 runs with a 300000ms deadline; explicit timeout_ms is refused', async t => {
  const f = await fixture(t);
  const out = await f.run([query, { ...query, timeout_ms: 900000 }], { API_TIMEOUT_MS: '900000' });
  assert.equal(out.results[0].ok, true);
  assert.ok(out.delays.includes(300000), 'the clamped operation timer must be installed');
  assert.ok(!out.delays.includes(900000), 'the inherited timer must never exceed the bound');
  assert.equal(out.results[1].error?.code, 'PROTOCOL_TIMEOUT_INVALID');
  assert.deepEqual(f.calls, ['http']);
});

test('AH-3.3 GraphQL subscriptions take the unknown-effect WebSocket production boundary', async t => {
  const f = await fixture(t, { production: true });
  const { results } = await f.run([subscription, stream]);
  for (const result of results) assert.equal(result.error?.code, 'PRODUCTION_WRITE_REFUSED');
  assert.deepEqual(f.calls, []);
});

test('AH-3.3 declared read-only GraphQL and WebSocket streams execute in production without a write flag', async t => {
  const f = await fixture(t, { production: true });
  const { results } = await f.run([
    { ...subscription, websocket: { effect: 'read' } },
    { ...stream, websocket: { ...stream.websocket, effect: 'read' } },
  ]);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.protocol.effect, 'read');
    assert.equal(result.protocol.declaration.stream, true);
    assert.equal(result.protocol.declaration.effectBasis, 'caller-declared-unverified');
  }
  assert.deepEqual(f.calls, ['websocket', 'websocket']);
});

for (const field of ['variables', 'params', 'grpc body', 'grpc messages', 'WebSocket send', 'header']) {
  test(`AH-3.4 ${field} credential field is refused before dispatch and absent from every output surface`, async t => {
    const f = await fixture(t);
    const secret = randomBytes(24).toString('hex');
    const nested = { nested: [{ password: secret }] };
    const request = field === 'variables' ? { ...query, graphql: { ...query.graphql, variables: nested } }
      : field === 'params' ? { protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'fixture.read', params: nested } }
      : field === 'header' ? { ...query, headers: { 'x-api-key': secret } }
      : field === 'WebSocket send' ? { ...stream, websocket: { ...stream.websocket, send: [nested] } }
      : { protocol: 'grpc', path: '/', grpc: { proto: 'service.proto', service: 'fixture.Service', method: 'Read',
        ...(field === 'grpc body' ? { body: { password: secret } } : { messages: [{ password: secret }] }) } };
    const out = await f.run([request]);
    assert.ok(!(out.stdout + out.stderr + f.surfaces()).includes(secret), 'credential bytes must be withheld');
    assert.equal(out.results[0].error?.code, 'CREDENTIAL_IN_REQUEST');
    assert.deepEqual(f.calls, []);
    assert.ok(!readdirSync(f.root).includes(LAYOUT.context), 'refusal cannot create knowledge');
  });
}
