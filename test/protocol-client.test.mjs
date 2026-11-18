import { LAYOUT } from "../lib/layout.mjs";
// Exercise the public client and MCP boundary in isolated projects, with real
// loopback HTTP/WebSocket peers. No installed demo or external API is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BUILTIN_DEFAULTS } from '../lib/config.mjs';
import { readRateLimit } from '../lib/response-headers.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT = pathToFileURL(join(ROOT, 'lib/client.mjs')).href;
// R7 (2026-10-07): writable capture fixtures use a real explicit stack. Legacy
// request/read-only behavior is pinned separately in stack-migration-policy.
const STACK_CONTEXT = join(LAYOUT.collection, 'fixture', 'sannr.json');
const STACK_EVIDENCE = join(LAYOUT.evidence, 'fixture');
const TOKEN = 'fixture-credential-' + 'q'.repeat(32);
// These are behavior fixtures, not connection-speed benchmarks. Give transport
// the host's own request budget, with a separate allowance for child startup.
const REQUEST_TIMEOUT_MS = BUILTIN_DEFAULTS.timeoutMs;
const requestCount = input => Array.isArray(input?.requests) ? input.requests.length
  : Array.isArray(input) ? input.length : 1;
const query = (name = 'Item', variables) => ({ protocol: 'graphql', path: '/graphql',
  graphql: { document: `query ${name}($lookup: String) { item(lookup: $lookup) { id } }`, ...(variables ? { variables } : {}) } });

async function fixture(t, response, { production = false, websocket, upgradeDelayMs = 0, responseDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sannr-protocol-client-'));
  const requests = [], upgrades = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* GET fixture */ }
    const request = { method: req.method, path: req.url, headers: req.headers, body };
    requests.push(request);
    if (responseDelayMs) await delay(responseDelayMs);
    const result = response(request);
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...result.headers });
    res.end(JSON.stringify(result.body));
  });
  const ws = new WebSocketServer(upgradeDelayMs ? { noServer: true } : { server });
  if (upgradeDelayMs) server.on('upgrade', (req, socket, head) => {
    const timer = setTimeout(() => {
      if (!socket.destroyed) ws.handleUpgrade(req, socket, head, client => ws.emit('connection', client, req));
    }, upgradeDelayMs);
    socket.once('close', () => clearTimeout(timer));
  });
  ws.on('connection', (socket, req) => {
    upgrades.push(req);
    socket.on('error', () => {});
    websocket?.(socket, req);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, LAYOUT.collection, 'fixture', 'stack.json'), JSON.stringify({ v: 1, name: 'fixture', default_environment: 'fixture', environments: {
    fixture: { baseUrl: origin, auth: 'bearer:FIXTURE_PROTOCOL_TOKEN', production },
  } }));
  t.after(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, API_ENV: 'fixture',
    API_ENV_FILE: '', API_CONTRACT: '', API_CONTEXT_OFF: '0', API_CONTEXT_DIR: dir, API_BUDGET: '100000', API_TIMEOUT_MS: String(REQUEST_TIMEOUT_MS),
    API_USAGE_LOG: '/dev/null', API_EVIDENCE: join(dir, 'evidence'), SANNR_HOME: join(dir, '.home'),
    API_ALLOW_PRODUCTION_WRITES: '0', FIXTURE_PROTOCOL_TOKEN: TOKEN };
  delete env.API_AUTH;
  const child = (args, input, overrides = {}, count = 1) => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: dir, env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => { proc.kill(); reject(new Error('Protocol fixture child reached its watchdog.')); },
      (count + 1) * REQUEST_TIMEOUT_MS);
    proc.stdout.on('data', value => { stdout += value; });
    proc.stderr.resume();
    proc.on('error', () => { clearTimeout(timer); reject(new Error('Protocol fixture child could not start.')); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error('Protocol fixture child failed before returning an envelope.')); return; }
      resolve(stdout);
    });
    proc.stdin.end(input);
  });
  const run = async (input, overrides = {}, setup = '') => JSON.parse(await child(['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const client = await import(${JSON.stringify(CLIENT)});
    ${setup}
    const out = input.requests ? await client.runEnvelope(input) : Array.isArray(input)
      ? await (async () => { const results = []; for (const request of input) results.push(await client.apiRequest(request)); return results; })()
      : await client.apiRequest(input);
    process.stdout.write(JSON.stringify(out));
  `], JSON.stringify(input), overrides, requestCount(input)));
  const mcp = async input => {
    const stdout = await child([join(ROOT, 'server.mjs')], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'api_request', arguments: input } },
    ].map(message => JSON.stringify(message)).join('\n') + '\n', { API_REQUEST_READ_ONLY: '1' }, requestCount(input));
    const reply = stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 100);
    return JSON.parse(reply.result.content[0].text);
  };
  return { dir, origin, requests, upgrades, run, mcp };
}

test('AH-2 protocol and HTTP response envelopes both declare v2', async t => {
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture' } } } }));
  const result = await f.run([query(), { path: '/health' }]);
  assert.equal(result.length, 2);
  for (const envelope of result) assert.equal(envelope.v, 2);
});

test('GraphQL HTTP 200 application errors stay failed even when a status assertion passes', async t => {
  const f = await fixture(t, () => ({ body: { errors: [{ message: 'fixture failure' }] } }));
  const result = await f.run({ ...query(), expect: [{ status: 200 }] });
  assert.equal(result.status, 200);
  assert.equal(result.ok, false);
  assert.equal(result.assertions.passed, 1);
  assert.equal(result.assertions.failed, 0);
  assert.equal(result.protocol.outcome, 'error');
  assert.equal(result.protocol.attempts, 1);
  assert.equal(result.error.code, 'GRAPHQL_ERRORS');
  assert.equal(result.context_capture.state, 'captured');
  const context = JSON.parse(readFileSync(join(f.dir, STACK_CONTEXT), 'utf8'));
  assert.equal(Object.values(context.api_context.operations)[0].observations[0].outcome, 'error');
  assert.equal(f.requests.length, 1);
});

test('operation identity separates documents, excludes variable values, and scrubs configured auth', async t => {
  const f = await fixture(t, req => ({ body: { data: { item: { id: req.body.variables?.lookup ?? 'fixture' },
    credentialEcho: TOKEN, authorizationEcho: req.headers.authorization } } }));
  const privateA = 'fixture_private_lookup_A', privateB = 'fixture_private_lookup_B';
  const results = await f.run([query('Alpha', { lookup: privateA }), query('Alpha', { lookup: privateB }), query('Beta', { lookup: privateA })]);
  assert.ok(results.every(result => result.ok && result.context_capture.state === 'captured'));
  assert.ok(f.requests.every(req => req.headers.authorization === `Bearer ${TOKEN}`));
  assert.equal(results[0].protocol.identity.operation, results[1].protocol.identity.operation);
  assert.notEqual(results[0].protocol.identity.operation, results[2].protocol.identity.operation);
  const contextText = readFileSync(join(f.dir, STACK_CONTEXT), 'utf8');
  for (const value of [privateA, privateB, TOKEN]) assert.ok(!contextText.includes(value), `context must omit ${value}`);
  const entries = Object.values(JSON.parse(contextText).api_context.operations);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(entry => entry.observations.length).sort(), [1, 2]);
  assert.ok(entries.every(entry => entry.identity.environment === 'fixture' && entry.identity.protocol === 'graphql'));
  const evidenceFiles = readdirSync(join(f.dir, STACK_EVIDENCE)).filter(file => file.endsWith('.json'));
  assert.equal(evidenceFiles.length, 3);
  assert.ok(!JSON.stringify(results).includes(TOKEN));
  for (const file of evidenceFiles) {
    const path = join(f.dir, STACK_EVIDENCE, file);
    assert.ok(!readFileSync(path, 'utf8').includes(TOKEN));
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test('production permits parsed GraphQL queries and refuses mutations and unknown WebSocket effects before dispatch', async t => {
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture' } } } }), { production: true });
  const results = await f.run([
    query(), { protocol: 'graphql', path: '/graphql', graphql: { document: 'mutation Change { change }' } },
    { protocol: 'websocket', path: '/events', websocket: { operation: 'events.listen' } },
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].protocol.effect, 'read');
  for (const result of results.slice(1)) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'PRODUCTION_WRITE_REFUSED');
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.upgrades.length, 0);
});

test('unconfigured authorities and literal credential locations are refused without requests', async t => {
  const f = await fixture(t, () => assert.fail('no request should be dispatched'));
  const results = await f.run([
    { ...query(), path: 'http://127.0.0.1:9/graphql' },
    { ...query(), headers: { authorization: 'Bearer caller-credential' } },
  ]);
  assert.equal(results[0].error.code, 'ORIGIN_NOT_CONFIGURED');
  assert.equal(results[1].error.code, 'CREDENTIAL_IN_REQUEST');
  assert.equal(f.requests.length, 0);
});

test('batch protocol execution counts actual connections and preserves stream truncation', async t => {
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture' } } } }), {
    websocket: socket => { socket.send(JSON.stringify({ number: 1 })); socket.send(JSON.stringify({ number: 2 })); socket.send(JSON.stringify({ number: 3 })); },
  });
  const result = await f.run({ v: 2, on_failure: 'continue', requests: [
    { id: 'stream', protocol: 'websocket', path: '/stream', websocket: { operation: 'events.stream', max_messages: 2 } },
    { ...query(), id: 'query' },
  ] });
  assert.equal(result.ok, false);
  assert.equal(result.attempted, 2);
  assert.equal(f.upgrades.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(result.results[0].protocol.attempts, 1);
  assert.equal(result.results[0].protocol.complete, false);
  assert.equal(result.results[0].protocol.outcome, 'incomplete');
  assert.equal(result.results[0].protocol.received, 2);
  assert.equal(result.results[1].ok, true);
});

test('GraphQL subscriptions dispatch over WebSocket and the common deadline reports timeout', async t => {
  const f = await fixture(t, () => assert.fail('subscription must not use HTTP POST'), {
    upgradeDelayMs: 1100,
    websocket: socket => socket.on('message', data => {
      const frame = JSON.parse(data);
      if (frame.type === 'connection_init') socket.send(JSON.stringify({ type: 'connection_ack' }));
    }),
  });
  // The common timer includes cold preparation and the upgrade. A one-second
  // wall-clock allowance cannot also promise an upgrade on a busy runner.
  // Delay the peer past that old allowance, then fire the real common timer's
  // callback after the actual socket opens. The transport deadline stays later;
  // the child watchdog still bounds missing dispatch or cleanup.
  const result = await f.run({ protocol: 'graphql', path: '/graphql', timeout_ms: 1000,
    graphql: { document: 'subscription Counter { counter }' }, websocket: { timeout_ms: 60000 } }, {}, `
      const { default: WebSocket } = await import(${JSON.stringify(import.meta.resolve('ws'))});
      const realSetTimeout = globalThis.setTimeout;
      let expireCommonDeadline;
      globalThis.setTimeout = (callback, delay, ...args) => {
        if (delay !== 1000) return realSetTimeout(callback, delay, ...args);
        if (expireCommonDeadline) throw new Error('The fixture observed more than one common deadline.');
        expireCommonDeadline = () => callback(...args);
        return realSetTimeout(() => { throw new Error('The fixture never observed a WebSocket open.'); }, ${REQUEST_TIMEOUT_MS});
      };
      const originalEmit = WebSocket.prototype.emit;
      WebSocket.prototype.emit = function(event, ...args) {
        const result = originalEmit.call(this, event, ...args);
        if (event === 'open') {
          if (!expireCommonDeadline) throw new Error('The protocol did not install its common deadline.');
          queueMicrotask(expireCommonDeadline);
        }
        return result;
      };
    `);
  assert.equal(result.ok, false);
  assert.equal(result.protocol.outcome, 'timeout');
  assert.equal(result.protocol.complete, false);
  assert.equal(result.protocol.attempts, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(f.upgrades.length, 1);
});

test('JSON-RPC batches capture results and interpolate later protocol params', async t => {
  const f = await fixture(t, req => ({ body: { jsonrpc: '2.0', id: req.body.id,
    result: req.body.method === 'jobs.create' ? { job: 'fixture_job' } : { observed: req.body.params.job } } }));
  const result = await f.run({ v: 2, requests: [
    { id: 'create', protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'jobs.create', params: {} }, capture: { job: 'result.job' } },
    { id: 'get', protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'jobs.get', params: { job: '{job}' } },
      expect: [{ json: 'result.observed', equals: 'fixture_job' }] },
  ] });
  assert.equal(result.ok, true);
  assert.equal(result.attempted, 2);
  assert.deepEqual(result.captured.job, { type: 'string', length: 11 });
  assert.equal(f.requests[1].body.params.job, 'fixture_job');
  assert.equal(result.results[1].assertions.passed, 1);
});

test('the read-only librarian rejects protocol requests atomically before any HTTP request or upgrade', async t => {
  const f = await fixture(t, () => assert.fail('librarian must refuse before dispatch'));
  const single = await f.mcp(query());
  assert.equal(single.error.code, 'LIBRARIAN_READ_ONLY');
  const batch = await f.mcp({ requests: [
    { method: 'GET', path: '/health' },
    { protocol: 'websocket', path: '/stream', websocket: { operation: 'events.listen' } },
  ] });
  assert.equal(batch.error.code, 'LIBRARIAN_READ_ONLY');
  assert.equal(f.requests.length, 0);
  assert.equal(f.upgrades.length, 0);
});

test('a large protocol response still records bounded context and uses a compact presentation', async t => {
  // Cross the old two-second fixture budget deterministically: under suite
  // load the same delay can happen before a loopback peer gets CPU time.
  const payload = 'fixture-large-value-' + 'x'.repeat(2 * 1024 * 1024);
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture', payload } } } }), { responseDelayMs: 2100 });
  const result = await f.run(query(), { API_BUDGET: '800' });
  assert.equal(result.ok, true);
  assert.equal(result.protocol.attempts, 1);
  assert.equal(result.mode, 'summary');
  assert.equal(result.discovery.truncated, true);
  assert.equal(result.context_capture.state, 'captured');
  const contextText = readFileSync(join(f.dir, STACK_CONTEXT), 'utf8');
  assert.ok(contextText.length < 16000);
  assert.ok(!contextText.includes('fixture-large-value-'));
  assert.ok(contextText.includes('response_shape'));
  assert.ok(result.evidence);
});

test('API_CONTEXT_OFF disables context reads and writes while retaining private evidence', async t => {
  // Context opt-out remains a success assertion even when the peer is delayed.
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture' } } } }), { responseDelayMs: 2100 });
  const result = await f.run(query(), { API_CONTEXT_OFF: '1' });
  assert.equal(result.ok, true);
  assert.equal(result.known, null);
  assert.equal(result.context_capture.state, 'disabled');
  assert.ok(result.evidence);
  assert.equal(existsSync(join(f.dir, STACK_CONTEXT)), false);
});

test('capture_context false disables this protocol observation while retaining the response and evidence', async t => {
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture' } } } }));
  const result = await f.run({ ...query(), capture_context: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.context_capture, { state: 'disabled', reason: 'request-opt-out' });
  assert.ok(result.evidence);
  assert.equal(existsSync(join(f.dir, STACK_CONTEXT)), false);
});

test('librarian HTTP reads and batches cannot acquire implicit shared context writes', async t => {
  const f = await fixture(t, () => ({ body: { healthy: true } }));
  const single = await f.mcp({ path: '/health' });
  const batch = await f.mcp({ requests: [{ path: '/health' }, { method: 'HEAD', path: '/health' }] });
  for (const result of [single, ...batch.results]) {
    assert.equal(result.ok, true);
    assert.equal(result.context_capture.state, 'disabled');
    assert.equal(result.context_capture.reason, 'request-opt-out');
    assert.ok(result.evidence);
  }
  assert.equal(existsSync(join(f.dir, STACK_CONTEXT)), false);
  const refused = await f.mcp({ path: '/health', capture_context: true });
  assert.equal(refused.error.code, 'LIBRARIAN_READ_ONLY');
  assert.equal(f.requests.length, 3);
});

test('HTTP protocol header assertions inspect actual headers and scrub credential values', async t => {
  const cookie = 'fixture-cookie-' + 'z'.repeat(24);
  const f = await fixture(t, () => ({ headers: { 'x-fixture': 'present', 'set-cookie': `session=${cookie}; HttpOnly; SameSite=Strict` },
    body: { data: { cookieEcho: cookie, sameSite: 'Strict' } } }));
  const results = await f.run([
    { ...query(), expect: [{ header: 'x-fixture', exists: false }] },
    { ...query(), expect: [{ header: 'x-fixture', equals: 'present' }, { header: 'set-cookie', exists: true }] },
    { ...query(), expect: [{ header: 'set-cookie', equals: 'wrong-cookie' }] },
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].assertions.failed, 1);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].assertions.passed, 2);
  assert.equal(results[2].ok, false);
  assert.equal(results[2].assertions.failures[0].actual, '[redacted]');
  assert.ok(!JSON.stringify(results).includes(cookie));
  assert.equal(results[0].data.data.sameSite, 'Strict', 'cookie attributes must not be treated as credential values');
  for (const name of readdirSync(join(f.dir, STACK_EVIDENCE)).filter(name => name.endsWith('.json')))
    assert.ok(!readFileSync(join(f.dir, STACK_EVIDENCE, name), 'utf8').includes(cookie));
});

test('HTTP protocol envelopes show the bounded header selection and rate limits so a small response stays visible', async t => {
  // Seen on 2026-11-05 against GitHub's GraphQL API: 26 response headers
  // (1.2 KB) spent the 800-token budget before a 211-byte page of results, so
  // the agent lost the page and its cursor while rate-limit headers went
  // unread. The envelope now shows the same header selection as HTTP requests.
  const noise = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`x-fixture-noise-${i}`, 'h'.repeat(80)]));
  const f = await fixture(t, () => ({ body: { data: { page: { endCursor: 'cursor-fixture', hasNextPage: true } } },
    headers: { ...noise, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4931', 'x-ratelimit-reset': '1793896961',
      link: '<https://example.test/next>; rel="next"' } }));
  const result = await f.run(query(), { API_BUDGET: '800' });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'passthrough');
  assert.equal(result.data.data.page.endCursor, 'cursor-fixture', 'the page and its cursor are shown');
  assert.deepEqual(result.rate_limit, { limit: 5000, remaining: 4931, reset: 1793896961 });
  assert.deepEqual(Object.keys(result.headers).sort(), ['content-type', 'link']);
  assert.ok(!JSON.stringify(result.headers).includes('x-fixture-noise'));
  // Header assertions and private evidence still see the whole snapshot.
  const asserted = await f.run({ ...query(), expect: [{ header: 'x-fixture-noise-3', exists: true }] }, { API_BUDGET: '800' });
  assert.equal(asserted.ok, true);
  assert.equal(asserted.assertions.passed, 1);
  const evidence = readdirSync(join(f.dir, STACK_EVIDENCE)).filter(name => name.endsWith('.json'))
    .map(name => readFileSync(join(f.dir, STACK_EVIDENCE, name), 'utf8'));
  assert.ok(evidence.some(text => text.includes('x-fixture-noise-3')));
  const throttled = await (await fixture(t, () => ({ status: 429, headers: { 'retry-after': '7', 'x-ratelimit-remaining': '0' },
    body: { errors: [{ message: 'fixture throttled' }] } }))).run(query(), { API_BUDGET: '800' });
  assert.equal(throttled.ok, false);
  assert.deepEqual(throttled.rate_limit, { limit: null, remaining: 0, reset: null, throttled_by_server: true, retry_after_ms: 7000 });
  assert.equal(throttled.headers['retry-after'], '7');
});

test('a GraphQL refusal says what it refused: the adapter message and bounded validation details', async t => {
  // Seen on 2026-11-05: an invalid document against a saved schema answered
  // only "The protocol request could not be prepared", so the agent could not
  // tell which field or variable the schema rejected.
  const f = await fixture(t, () => ({ body: { data: { item: { id: 'fixture' } } } }));
  writeFileSync(join(f.dir, 'schema.graphql'), 'type Item { id: ID! } type Query { item(lookup: String): Item }');
  const invalid = { ...query(), graphql: { ...query().graphql, schema: 'schema.graphql', document: 'query Item { item { id missingField } }' } };
  for (const result of [await f.run(invalid)]) {
    assert.equal(result.ok, false);
    assert.equal(result.mode, 'refused');
    assert.equal(result.error.code, 'GRAPHQL_VALIDATION_FAILED');
    assert.equal(result.error.message, 'GraphQL document or variables do not match the schema.');
    assert.equal(result.error.next, 'Check the adapter input and local schema.');
    assert.match(result.error.details[0], /Cannot query field "missingField" on type "Item"/);
  }
  const value = 'private-variable-value-' + 'v'.repeat(16);
  const variables = await f.run({ ...invalid, graphql: { ...query().graphql, schema: 'schema.graphql', variables: { lookup: { nested: value } } } });
  assert.equal(variables.error.code, 'GRAPHQL_VALIDATION_FAILED');
  assert.deepEqual(variables.error.details, ['Variable "$lookup" of type "String" is missing or does not match its declared type.']);
  assert.ok(!JSON.stringify(variables).includes(value));
  const ambiguous = await f.run({ ...query(), graphql: { document: 'query A { item { id } } query B { item { id } }' } });
  assert.equal(ambiguous.error.code, 'GRAPHQL_OPERATION_REQUIRED');
  assert.equal(ambiguous.error.message, 'Select exactly one declared GraphQL operation by name.');
  assert.equal(ambiguous.error.details, undefined);
  assert.equal(f.requests.length, 0, 'nothing was sent');
});

test('unavailable stream headers and mismatched protocol inputs are refused before dispatch', async t => {
  const f = await fixture(t, () => assert.fail('must refuse before dispatch'));
  const subscription = { protocol: 'graphql', path: '/graphql', graphql: { document: 'subscription Item { item }' } };
  const results = await f.run([
    { protocol: 'websocket', path: '/stream', websocket: { operation: 'events' }, expect: [{ header: 'x-fixture', exists: false }] },
    { ...subscription, expect: [{ header: 'x-fixture', exists: false }] },
    { ...query(), rpc: { method: 'ignored', params: { shouldNotBeCaptured: true } } },
    { ...query(), websocket: { until: { json: 'ready', exists: true } } },
    { protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'read' }, grpc: {} },
  ]);
  assert.ok(results.slice(0, 2).every(result => result.error.code === 'PROTOCOL_HEADER_ASSERTION_UNSUPPORTED'));
  assert.ok(results.slice(2).every(result => result.error.code === 'PROTOCOL_INPUT_CONFLICT'));
  assert.equal(f.requests.length, 0);
  assert.equal(f.upgrades.length, 0);
});

test('wide response shapes and tiny budgets have bounded, explicit presentation omissions', async t => {
  const f = await fixture(t, () => ({ body: { data: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`field_${i}`,
    Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`nested_${j}`, 'x'.repeat(50)]))])) } }));
  const normal = await f.run(query(), { API_BUDGET: '800' });
  assert.equal(normal.ok, true);
  assert.equal(normal.context_capture.state, 'captured');
  assert.ok(Buffer.byteLength(JSON.stringify(normal)) <= 3200, 'the summary shape must also fit the presentation budget');
  assert.ok(normal.presentation.omitted.includes('discovery.shape'));
  assert.equal(normal.protocol.outcome, 'success');
  assert.ok(normal.evidence);
  const tiny = await f.run(query(), { API_BUDGET: '130' });
  assert.equal(tiny.protocol.outcome, 'success');
  assert.match(tiny.protocol.identity.id, /^sha256:/);
  assert.equal(tiny.budget_min, Math.ceil(Buffer.byteLength(JSON.stringify(tiny)) / 4));
});

test('budgeted assertion failures retain counts and name omitted details', async t => {
  const f = await fixture(t, () => ({ body: { data: { item: 1 } } }));
  const expect = Array.from({ length: 50 }, (_, i) => ({ json: `data.field_${i}`, equals: true }));
  const result = await f.run({ ...query(), expect }, { API_BUDGET: '800' });
  assert.equal(result.ok, false);
  assert.equal(result.assertions.failed, 50);
  assert.equal(result.assertions.passed, 0);
  assert.equal(result.assertions.failures.length + result.assertions.omitted_failures, 50);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 3200 || result.budget_min);
});

test('an empty rate-limit header reads as absent, never as zero', () => {
  // beta.1's HTTP client returned null for an empty value; the shared reader
  // the protocol adapters now use must not turn it into a false exhaustion.
  assert.deepEqual(readRateLimit({ 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '' }),
    { limit: 100, remaining: null, reset: null });
  assert.deepEqual(readRateLimit({ 'RateLimit-Limit': '', 'RateLimit-Remaining': '', 'RateLimit-Reset': '' }), null);
  assert.deepEqual(readRateLimit(new Headers({ 'x-ratelimit-limit': '0', 'x-ratelimit-remaining': '0' })),
    { limit: 0, remaining: 0, reset: null });
});
