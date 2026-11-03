// Process-level proof of a standalone viewport and repository operator inbox.
// Both the MCP peer and API fixture are child processes; no model or vendor runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
const { launchWorkbench } = await import(process.env.SANNR_TEST_PACKAGE
  ? pathToFileURL(join(process.env.SANNR_TEST_PACKAGE, 'lib/workbench-cli.mjs')).href
  : new URL('../lib/workbench-cli.mjs', import.meta.url).href);
import { createFixtureStack } from './helpers/stack-fixture.mjs';

// The release check supplies an extracted candidate so the exercised MCP
// server, terminal launcher, engine and assets come from those exact package bytes.
const SERVER = process.env.SANNR_TEST_PACKAGE ? join(process.env.SANNR_TEST_PACKAGE, 'server.mjs')
  : fileURLToPath(new URL('../server.mjs', import.meta.url));
const PRIVATE_INPUT = 'synthetic-private-runtime-672981';
const RESPONSE_SECRET = 'synthetic-response-secret-291763';
const HOST = 'workbench-fixture-host', TASK = 'Review order response';

function deadline(promise, label, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  })]).finally(() => clearTimeout(timer));
}
function child(command, args, options) {
  const process = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', exited = false;
  process.stderr.on('data', bytes => { stderr += bytes; });
  process.stdin.on('error', () => {});
  const closed = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  return { process, closed, stderr: () => stderr,
    async stop() {
      if (exited) return closed;
      process.stdin.end(); process.kill('SIGTERM');
      try { return await deadline(closed, 'child cleanup', 3000); }
      catch { process.kill('SIGKILL'); return closed; }
    } };
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-agent-adapters-'));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'machine', 'usage.jsonl'), API_BUDGET: '6000',
    API_FRICTION_OFF: '1', NO_COLOR: '1' };
  mkdirSync(env.HOME, { recursive: true });
  const children = [], terminals = [], seen = [];
  t.after(async () => {
    for (const terminal of terminals) await terminal.close();
    for (const process of children) await process.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const api = child(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    const server = createServer((request, response) => {
      console.log(JSON.stringify({ request: { method: request.method, path: request.url,
        private_note: request.headers['x-private-note'] } }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: 'ready', reflected: request.headers['x-private-note'],
        password: '${RESPONSE_SECRET}' }));
    });
    server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], { cwd: root, env });
  children.push(api);
  let buffer = '', ready;
  const port = await deadline(new Promise((resolve, reject) => {
    ready = resolve; api.process.once('error', reject);
    api.process.stdout.on('data', bytes => {
      buffer += bytes;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines.filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.port) ready(message.port);
        if (message.request) seen.push(message.request);
      }
    });
  }), 'API fixture startup');
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3', info: { title: 'Workbench fixture', version: '1' }, paths: {
    '/orders/{id}': { get: { parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'detail', in: 'query', required: true, schema: { type: 'string', enum: ['compact', 'full'] } },
      { name: 'x-private-note', in: 'header', schema: { type: 'string' } },
    ], responses: { 200: { description: 'ready' } } } },
  } }));
  createFixtureStack(root, { contract: 'openapi.json', baseUrl: `http://127.0.0.1:${port}` });
  return { root, env, children, terminals, seen };
}
async function mcp(f, { initialized = true, readOnly = false, ping = true } = {}) {
  const running = child(process.execPath, [SERVER], { cwd: f.root,
    env: { ...f.env, ...(readOnly ? { API_REQUEST_READ_ONLY: '1' } : {}) } });
  f.children.push(running);
  let buffer = '', sequence = 0, pings = 0;
  const pending = new Map();
  const send = value => running.process.stdin.write(`${JSON.stringify(value)}\n`);
  running.process.stdout.on('data', bytes => {
    buffer += bytes;
    const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.method === 'ping') {
        pings++;
        if (ping) send({ jsonrpc: '2.0', id: message.id, result: {} });
        continue;
      }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    }
  });
  running.closed.then(() => {
    for (const waiter of pending.values()) waiter.reject(new Error('MCP peer closed before responding'));
    pending.clear();
  });
  const rpc = (method, params = {}) => {
    const id = ++sequence;
    return deadline(new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject }); send({ jsonrpc: '2.0', id, method, params });
    }), `MCP ${method}`).finally(() => pending.delete(id));
  };
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: HOST, version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  const finishInitialization = () => send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  if (initialized) finishInitialization();
  const call = async (name, args) => {
    const response = await rpc('tools/call', { name, arguments: args });
    const texts = response.result?.content?.filter(item => item.type === 'text').map(item => item.text) ?? [];
    return { response, value: texts.length ? JSON.parse(texts[0]) : null, hints: texts.slice(1).map(text => JSON.parse(text)) };
  };
  return { rpc, call, finishInitialization, pings: () => pings, stderr: running.stderr,
    async end() { running.process.stdin.end(); return deadline(running.closed, 'MCP EOF shutdown', 4000); } };
}
function browser(url, path, body = {}, { token, nonce } = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', path, agent: false, headers: {
      origin: new URL(url).origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
      'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(token ? { 'x-workbench-token': token } : {}), ...(nonce ? { 'x-workbench-pairing': nonce } : {}),
    } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Browser fixture request timed out')));
    req.on('error', reject); req.end(payload);
  });
}
const document = () => ({ folder: 'orders', name: 'lookup', stack: 'fixture', environment: 'local',
  request: { method: 'GET', path: '/orders/{id}', bindings: { path: { id: { $input: 'order_id' } },
    query: { detail: { $enum: 'compact' } }, headers: { 'x-private-note': { $input: 'private_note' } } } },
  inputs: { order_id: { type: 'string', sensitive: true }, private_note: { type: 'string', sensitive: true } }, credentials: [] });
const noPrivateValues = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const privateValue of [PRIVATE_INPUT, RESPONSE_SECRET, 'synthetic-order-1973'])
    assert.ok(!text.includes(privateValue), 'runtime and response values must not enter the handoff');
};

// The terminal owns browser authority. Presence is never needed to create this
// server or act; the MCP child merely reads/acknowledges repository journals.
async function viewport(f, sessionId) {
  const server = await launchWorkbench(f.root, { sessionId });
  sessionId = server.sessionId;
  f.terminals.push(server);
  const forbidden = await browser(server.url, '/action', { action: 'agent', params: {} });
  assert.equal(forbidden.status, 401);
  const start = await browser(server.url, '/pair/start');
  assert.equal(start.status, 200);
  assert.equal(server.authorizePairing(start.body.result.code), true);
  const complete = await browser(server.url, '/pair/complete', {}, { nonce: start.body.result.nonce });
  assert.equal(complete.status, 200);
  const token = complete.body.result.token;
  const action = async (name, params = {}) => {
    const response = await browser(server.url, '/action', { action: name, params }, { token });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result;
  };
  return { server, session: sessionId, token, action };
}

test('standalone browser saves, sends and queues; unattached MCP reads and acknowledges the repository inbox', async t => {
  const f = await fixture(t), { server, session, token, action } = await viewport(f);
  assert.equal((await action('agent')).connection, null);
  const initial = await action('snapshot');
  assert.ok(initial.stacks.length); assert.equal(initial.agent.session_id, session);
  const saved = await action('saved', { action: 'create', document: document() });
  assert.equal(saved.handoff.state, 'queued'); assert.equal(saved.handoff.seq, 1);
  const edit = structuredClone(saved.document); edit.request.bindings.query.detail = { $enum: 'full' };
  const edited = await action('saved', { action: 'edit', ref: saved.ref, document: edit });
  assert.equal(edited.handoff.seq, 2); assert.equal(f.seen.length, 0, 'opening and saving send no API traffic');
  const run = await action('saved', { action: 'run', ref: saved.ref,
    inputs: { order_id: 'synthetic-order-1973', private_note: PRIVATE_INPUT } });
  assert.equal(run.status, 200); assert.equal(run.handoff.seq, 3); assert.match(run.evidence, /^run-/);
  assert.equal(run.saved_request.assertions, 'not_run'); noPrivateValues(run);
  const followup = await action('handoff', { message: 'Review the saved request change and its response.', saved_ref: saved.ref, run_id: run.evidence });
  assert.equal(followup.state, 'queued'); assert.equal(followup.seq, 4);
  assert.equal(f.seen.length, 1);

  const peer = await mcp(f);
  const status = (await peer.call('api_workbench', { action: 'status' })).value;
  assert.equal(status.connection, null, 'no attachment occurred');
  assert.equal(status.sessions.find(item => item.session_id === session).pending, 4);
  const forbiddenAck = await peer.call('api_workbench', { action: 'ack', session, through: 4 });
  assert.equal(forbiddenAck.value.error.code, 'WORKBENCH_HANDOFF_NOT_READ');
  assert.match(forbiddenAck.value.error.next, /cursor order/i, 'the precise controller recovery reaches the agent');
  const firstPage = (await peer.call('api_workbench', { action: 'read', session, limit: 2 })).value;
  assert.deepEqual(firstPage.events.map(event => event.kind), ['saved', 'edited']);
  assert.notEqual(firstPage.events[1].request_digest, firstPage.events[1].previous_request_digest);
  assert.equal(firstPage.retrieved_through, 2); assert.equal(firstPage.pending, 4);
  assert.equal((await peer.call('api_workbench', { action: 'ack', session, through: 3 })).value.error.code, 'WORKBENCH_HANDOFF_NOT_READ');
  const ack = (await peer.call('api_workbench', { action: 'ack', session, through: 2 })).value;
  assert.equal(ack.pending, 2);
  const nextTool = await peer.call('api_saved_requests', { action: 'list' });
  assert.deepEqual(nextTool.hints[0].workbench_handoffs, [{ session_id: session, pending: 2 }]);
  const historyPath = join(f.root, LAYOUT.evidence, 'workbench', 'handoffs', `${session}.json`);
  const beforeExit = readFileSync(historyPath, 'utf8'); noPrivateValues(beforeExit); noPrivateValues(nextTool);
  const exit = await peer.end(); assert.equal(exit.code, 0, peer.stderr());
  assert.equal((await action('agent')).pending, 2, 'MCP EOF cannot revoke terminal authority');
  assert.equal(readFileSync(historyPath, 'utf8'), beforeExit);
  await server.close();
  await assert.rejects(browser(server.url, '/action', { action: 'agent', params: {} }, { token }));

  const reopened = await viewport(f, session);
  assert.equal((await reopened.action('agent')).pending, 2, 'a later terminal continues the same inbox');
  const fresh = await mcp(f);
  const recovered = (await fresh.call('api_workbench', { action: 'status' })).value;
  assert.equal(recovered.connection, null); assert.equal(recovered.sessions[0].pending, 2);
  const inbox = (await fresh.call('api_workbench', { action: 'read', session })).value;
  assert.deepEqual(inbox.events.map(event => event.kind), ['saved', 'edited', 'request_result', 'follow_up']);
  assert.equal(inbox.events[2].run_id, run.evidence); assert.equal(inbox.events[3].message_trust, 'untrusted-data');
  noPrivateValues(inbox);
  const received = (await fresh.call('api_workbench', { action: 'ack', session, through: inbox.next_cursor })).value;
  assert.equal(received.pending, 0); assert.equal(received.meaning, 'received, not completed');
  assert.deepEqual((await fresh.call('api_saved_requests', { action: 'list' })).hints, []);
  assert.equal((await reopened.action('agent')).pending, 0);
  assert.equal(f.seen.length, 1, 'reading/acknowledging never replay a request');
});

test('presence uses no host ping and detach or MCP EOF never closes a terminal-owned viewport', async t => {
  const f = await fixture(t), { action } = await viewport(f);
  const peer = await mcp(f, { initialized: false, ping: false });
  assert.equal((await peer.call('api_workbench', { action: 'attach', task: TASK })).value.error.code, 'WORKBENCH_HOST_NOT_INITIALIZED');
  peer.finishInitialization();
  const attached = (await peer.call('api_workbench', { action: 'attach', task: TASK })).value;
  assert.equal(attached.host, HOST); assert.equal(attached.task, TASK);
  assert.equal(peer.pings(), 0);
  assert.equal((await action('agent')).connection.session_id, attached.session_id);
  const other = await mcp(f);
  assert.equal((await other.call('api_workbench', { action: 'detach', session: attached.session_id })).value.error.code, 'WORKBENCH_SESSION_NOT_ATTACHED');
  await peer.call('api_workbench', { action: 'detach', session: attached.session_id });
  assert.equal((await action('agent')).connection, null);
  const saved = await action('saved', { action: 'create', document: document() });
  assert.equal(saved.handoff.state, 'queued');
  await peer.call('api_workbench', { action: 'attach', task: TASK });
  assert.ok((await action('agent')).connection);
  assert.equal((await peer.end()).code, 0);
  assert.equal((await action('agent')).connection, null);
  assert.equal((await action('handoff', { message: 'Continue after the agent returns.' })).state, 'queued');
  assert.equal(f.seen.length, 0);
});

test('read-only MCP exposes no presence tool, without preventing a separate operator viewport', async t => {
  const f = await fixture(t), peer = await mcp(f, { readOnly: true });
  const listing = await peer.rpc('tools/list');
  assert.ok(!listing.result.tools.some(tool => tool.name === 'api_workbench'));
  assert.equal((await peer.call('api_workbench', { action: 'attach', task: TASK })).response.error.code, -32602);
  const { action } = await viewport(f);
  assert.equal((await action('agent')).connection, null);
  assert.equal(peer.pings(), 0); assert.equal(f.seen.length, 0);
});

test('a completed request stays successful when the repository inbox is locked or malformed', async t => {
  const f = await fixture(t), { session, action } = await viewport(f);
  const saved = await action('saved', { action: 'create', document: document() });
  const dir = join(f.root, LAYOUT.evidence, 'workbench', 'handoffs');
  mkdirSync(join(dir, `${session}.lock`));
  const result = await action('saved', { action: 'run', ref: saved.ref,
    inputs: { order_id: 'synthetic-order-1973', private_note: PRIVATE_INPUT } });
  assert.equal(result.status, 200); assert.match(result.evidence, /^run-/);
  assert.equal(result.handoff.state, 'not_queued'); assert.equal(result.handoff.code, 'WORKBENCH_HANDOFF_BUSY');
  assert.equal(f.seen.length, 1);
  writeFileSync(join(dir, `${session}.json`), '{ malformed history');
  const snapshot = await action('snapshot');
  assert.ok(snapshot.stacks.length); assert.equal(snapshot.agent.inbox_unavailable, true);
  assert.equal(f.seen.length, 1, 'opening an unavailable inbox never repeats a send');
  noPrivateValues(snapshot);
});

test('resuming an inbox rejects a missing or invalid ID without requiring agent presence', async t => {
  const f = await fixture(t);
  await assert.rejects(launchWorkbench(f.root, { sessionId: 'wb-11111111-1111-4111-8111-111111111111' }), { code: 'WORKBENCH_SESSION_NOT_FOUND' });
  await assert.rejects(launchWorkbench(f.root, { sessionId: '../../outside' }), { code: 'WORKBENCH_HANDOFF_SESSION_INVALID' });
  const first = await viewport(f), second = await viewport(f);
  assert.notEqual(first.session, second.session);
  assert.equal((await first.action('agent')).connection, null);
  assert.equal((await second.action('agent')).connection, null);
});
