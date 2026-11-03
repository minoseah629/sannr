import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkbenchServer, WorkbenchRefusal } from '../lib/workbench-server.mjs';
import { createWorkbenchPairingTerminal } from '../lib/workbench-cli.mjs';

const assets = {
  '/': '<!doctype html><title>Local workbench</title><script src="/workbench.js" defer></script>',
  '/workbench.js': 'document.body.textContent="Pair in the launch terminal";',
  '/workbench.css': 'body{color:#eee;background:#111}',
};
async function launch(t, options = {}) {
  const service = await createWorkbenchServer({ assets, handlers: { snapshot: () => ({ private: 'synthetic-private' }) }, ...options });
  t.after(() => service.close());
  return service;
}
function call(service, path = '/action', body = { action: 'snapshot', params: {} }, options = {}) {
  const payload = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  const headers = {
    origin: service.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
    'content-type': 'application/json', accept: 'application/json', 'content-length': payload.length,
    ...(options.token ? { 'x-workbench-token': options.token } : {}), ...options.headers,
  };
  for (const key of Object.keys(headers)) if (headers[key] === undefined) delete headers[key];
  return new Promise((resolve, reject) => {
    const req = request(service.url, { method: options.method ?? 'POST', path, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json; try { json = JSON.parse(text); } catch { /* static/empty output */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(payload);
  });
}
async function start(service) {
  const response = await call(service, '/pair/start', {});
  assert.equal(response.status, 200);
  return response.json.result;
}
async function finish(service, nonce) {
  return call(service, '/pair/complete', {}, { headers: { 'x-workbench-pairing': nonce } });
}
async function pair(service) {
  const pending = await start(service);
  assert.equal(service.authorizePairing(pending.code), true);
  const response = await finish(service, pending.nonce);
  assert.equal(response.status, 200);
  return response.json.result.token;
}

test('terminal pairing lifecycle follows accepted browser requests and completed connections without exposing authority', async t => {
  const states = [];
  const service = await launch(t, { onPairingState: state => states.push(state) });
  assert.deepEqual(states, [], 'launching does not ask for a code before a browser requests one');
  assert.equal((await call(service, '/pair/start', { unexpected: true })).status, 400);
  assert.equal((await call(service, '/pair/start', {}, { headers: { origin: 'https://example.test' } })).status, 403);
  assert.deepEqual(states, [], 'invalid or foreign requests cannot prompt the launch terminal');
  const pending = await start(service);
  assert.deepEqual(states, ['requested']);
  assert.equal((await finish(service, pending.nonce)).status, 202);
  assert.equal(service.authorizePairing('wrong-code'), false);
  assert.deepEqual(states, ['requested']);
  assert.equal(service.authorizePairing(pending.code), true);
  assert.deepEqual(states, ['requested'], 'terminal approval is not yet a connected browser');
  const first = (await finish(service, pending.nonce)).json.result.token;
  assert.deepEqual(states, ['requested', 'connected']);
  assert.equal((await call(service, '/action', undefined, { token: first })).status, 200);
  assert.deepEqual(states, ['requested', 'connected'], 'ordinary actions never ask for another code');
  const replacement = await start(service);
  assert.deepEqual(states, ['requested', 'connected', 'requested']);
  assert.equal(service.authorizePairing(replacement.code), true);
  const second = (await finish(service, replacement.nonce)).json.result.token;
  assert.deepEqual(states, ['requested', 'connected', 'requested', 'connected']);
  assert.equal((await call(service, '/action', undefined, { token: first })).status, 401);
  assert.equal((await call(service, '/action', undefined, { token: second })).status, 200);
});

test('the launch terminal prompts only for pending browser pairing, retries invalid input, and becomes quiet after connecting', async t => {
  const input = new PassThrough(), output = new PassThrough();
  let transcript = '', terminal;
  output.on('data', bytes => { transcript += bytes; });
  const service = await launch(t, { onPairingState: state => terminal.pairingState(state) });
  terminal = createWorkbenchPairingTerminal({ input, output,
    authorizePairing: code => service.authorizePairing(code), onClose: () => {} });
  t.after(() => { terminal.close(); input.destroy(); output.destroy(); });
  const prompts = () => transcript.match(/Pairing code: /g)?.length ?? 0;
  assert.equal(prompts(), 0);
  const pending = await start(service);
  assert.equal(prompts(), 1);
  await start(service);
  assert.equal(prompts(), 1, 'another pending tab does not duplicate the active input prompt');
  input.write('invalid-code\n');
  assert.match(transcript, /unavailable or expired/);
  assert.equal(prompts(), 2, 'invalid input leaves the terminal ready for a corrected code');
  input.write(`${pending.code}\n`);
  assert.match(transcript, /Code accepted\. Waiting for the browser to connect/);
  assert.equal(prompts(), 2, 'accepting the code must not print the misleading next-code prompt');
  const first = (await finish(service, pending.nonce)).json.result.token;
  assert.match(transcript, /Browser connected\. Workbench ready\. Ctrl-C closes the workbench\./);
  assert.equal(prompts(), 2);
  input.write('\n');
  assert.equal(prompts(), 2, 'an idle Enter does not restart pairing');
  const replacement = await start(service);
  assert.equal(prompts(), 3, 'an explicit reconnect asks for a fresh code');
  input.write(`${replacement.code}\n`);
  const second = (await finish(service, replacement.nonce)).json.result.token;
  assert.equal(prompts(), 3);
  assert.equal(transcript.match(/Browser connected\./g)?.length, 2);
  assert.equal((await call(service, '/action', undefined, { token: first })).status, 401);
  assert.equal((await call(service, '/action', undefined, { token: second })).status, 200);
  for (const authority of [pending.code, pending.nonce, replacement.code, replacement.nonce, first, second])
    assert.ok(!transcript.includes(authority), 'the status writer never prints pairing or action secrets');
});

test('launch URL reveals only public assets; terminal approval is independent of URL/nonce/code', async t => {
  let reads = 0;
  const service = await launch(t, { handlers: { snapshot: () => { reads++; return { private: 'synthetic-private' }; } } });
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const page = await call(service, '/', '', { method: 'GET', headers: { origin: undefined } });
  assert.equal(page.status, 200);
  assert.equal(page.text, assets['/']);
  assert.doesNotMatch(page.text, /synthetic-private|token|nonce/);
  const pending = await start(service);
  assert.match(pending.code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.match(pending.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await finish(service, pending.nonce)).status, 202);
  for (const token of [undefined, pending.code, pending.nonce, service.url])
    assert.equal((await call(service, '/action', undefined, { token })).status, 401);
  assert.equal(service.authorizePairing('not-the-browser-code'), false);
  assert.equal(service.authorizePairing('é'.repeat(pending.code.length)), false);
  assert.equal(reads, 0);
  assert.equal(service.authorizePairing(pending.code), true);
  const complete = await finish(service, pending.nonce);
  const token = complete.json.result.token;
  assert.notEqual(token, pending.nonce);
  assert.equal((await finish(service, pending.nonce)).status, 401);
  const response = await call(service, '/action', undefined, { token });
  assert.equal(response.json.result.private, 'synthetic-private');
  assert.equal(reads, 1);
  for (const path of [`/?token=${token}`, `/?nonce=${pending.nonce}`, `/action?token=${token}`, `/action#${token}`]) {
    const leaked = await call(service, path, '', { method: 'GET' });
    assert.equal(leaked.status, 404);
    assert.ok(!leaked.text.includes(token));
  }
});

test('cross-origin, rebinding, null origin, missing metadata and stale authority never invoke handlers', async t => {
  let calls = 0;
  const service = await launch(t, { handlers: { snapshot: () => ++calls } });
  const token = await pair(service);
  for (const headers of [
    { origin: 'https://attacker.invalid' }, { origin: 'null' }, { origin: undefined },
    { origin: `${service.origin}/` }, { origin: service.origin.replace('127.0.0.1', 'localhost') },
    { host: 'attacker.invalid' }, { host: service.origin.slice(7).replace('127.0.0.1', 'localhost') },
    { host: `${service.origin.slice(7)}.attacker.invalid` }, { host: `127.0.0.1:${Number(new URL(service.url).port) + 1}` },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': undefined },
    { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-mode': 'navigate' }, { 'sec-fetch-dest': 'document' },
  ]) {
    const response = await call(service, '/action', undefined, { token, headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const badToken of ['stale-token', 'A'.repeat(43), 'é'.repeat(43)])
    assert.equal((await call(service, '/action', undefined, { token: badToken })).status, 401);
  assert.equal(calls, 0);
  assert.equal((await call(service, '/action', undefined, { token })).status, 200);
  assert.equal(calls, 1);
});

test('forms, preflights, encoded paths, arbitrary file paths and malformed action shapes refuse', async t => {
  let calls = 0;
  const service = await launch(t, { handlers: { snapshot: () => ++calls } });
  const token = await pair(service);
  for (const method of ['GET', 'PUT', 'OPTIONS'])
    assert.equal((await call(service, '/action', undefined, { token, method })).status, 405);
  for (const path of ['/action/', '/%61ction', '//action', '/..%2fprivate', '/../../etc/passwd', '/workbench.js?x=1', `${service.origin}/action`])
    assert.equal((await call(service, path, undefined, { token })).status, 404, path);
  for (const headers of [
    { 'content-type': 'application/x-www-form-urlencoded' }, { 'content-type': 'text/plain' },
    { 'content-type': 'application/json; charset=utf-8' }, { accept: '*/*' },
    { 'content-encoding': 'gzip' }, { 'access-control-request-method': 'POST' },
  ]) assert.equal((await call(service, '/action', undefined, { token, headers })).status, 415);
  for (const body of [[], null, {}, { action: 'snapshot' }, { action: 'snapshot', params: {}, shell: 'injected' },
    { action: 'snapshot', params: [] }, { action: 1, params: {} }, '{', '{"action":"snapshot","params":{"__proto__":{}}}',
    '{"action":"exec","action":"snapshot","params":{}}',
    '{"action":"snapshot","params":{"duplicate":1,"dupli\\u0063ate":2}}',
    '{"action":"snapshot","params":{"value":1e999}}',
    Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    JSON.stringify({ action: 'snapshot', params: { deep: JSON.parse('['.repeat(33) + '0' + ']'.repeat(33)) } }),
  ]) assert.equal((await call(service, '/action', body, { token })).status, 400);
  for (const action of ['exec', 'readFile', 'snapshot.__proto__', '__proto__', 'toString'])
    assert.equal((await call(service, '/action', { action, params: {} }, { token })).status, 404);
  assert.equal(calls, 0);
});

test('duplicate Host, Origin, metadata and token headers fail closed', async t => {
  let calls = 0;
  const service = await launch(t, { handlers: { snapshot: () => ++calls } });
  const token = await pair(service);
  for (const duplicate of ['Host', 'Origin', 'Sec-Fetch-Site', 'X-Workbench-Token']) {
    const values = { Host: new URL(service.url).host, Origin: service.origin, 'Sec-Fetch-Site': 'same-origin', 'X-Workbench-Token': token };
    const body = JSON.stringify({ action: 'snapshot', params: {} });
    const raw = `POST /action HTTP/1.1\r\nHost: ${values.Host}\r\nOrigin: ${values.Origin}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\nAccept: application/json\r\nContent-Type: application/json\r\nX-Workbench-Token: ${token}\r\n${duplicate}: ${values[duplicate]}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
    const response = await new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: Number(new URL(service.url).port) }, () => socket.end(raw));
      let value = '';
      socket.on('data', chunk => { value += chunk; }); socket.on('error', reject); socket.on('end', () => resolve(value));
    });
    assert.match(response, /^HTTP\/1.1 (?:400|401|403) /, duplicate);
  }
  assert.equal(calls, 0);
});

test('pairing expires, is bounded and rotates browser authority without reusing old nonces', async t => {
  const expiredService = await launch(t, { pairingTimeoutMs: 25 });
  const expired = await start(expiredService);
  await delay(35);
  assert.equal(expiredService.authorizePairing(expired.code), false);
  assert.equal((await finish(expiredService, expired.nonce)).status, 401);
  const service = await launch(t);
  const first = await pair(service);
  const candidates = [];
  for (let i = 0; i < 4; i++) candidates.push(await start(service));
  assert.equal((await call(service, '/pair/start', {})).status, 429);
  assert.equal(service.authorizePairing(candidates[0].code), true);
  assert.equal((await finish(service, candidates[1].nonce)).status, 401);
  const second = (await finish(service, candidates[0].nonce)).json.result.token;
  assert.notEqual(first, second);
  assert.equal((await call(service, '/action', undefined, { token: first })).status, 401);
  assert.equal((await call(service, '/action', undefined, { token: second })).status, 200);
});

test('responses prevent caching/framing/referrers; untrusted text stays JSON and known refusals retain engine guidance', async t => {
  const dangerous = '</script><img src="https://attacker.invalid/steal" onerror="alert(1)">';
  const service = await launch(t, { handlers: {
    snapshot: () => ({ text: dangerous }),
    refused: () => { throw new WorkbenchRefusal('PRODUCTION_POLICY_DENIED', 'Choose a permitted environment; do not bypass policy.'); },
    broken: () => { throw Object.assign(new Error('credential=synthetic-secret-value'), { code: 'PRIVATE_VALUE', next: 'secret=synthetic-secret-value' }); },
  } });
  const token = await pair(service);
  const response = await call(service, '/action', undefined, { token });
  assert.equal(response.json.result.text, dangerous);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.match(response.headers['content-security-policy'], /default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(response.headers['content-security-policy'], /unsafe-inline|unsafe-eval/);
  const refused = await call(service, '/action', { action: 'refused', params: {} }, { token });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json.error, { code: 'PRODUCTION_POLICY_DENIED', next_action: 'Choose a permitted environment; do not bypass policy.' });
  const broken = await call(service, '/action', { action: 'broken', params: {} }, { token });
  assert.equal(broken.status, 500);
  assert.doesNotMatch(broken.text, /synthetic-secret-value|PRIVATE_VALUE/);
});

test('bounded request/response sizes reject oversized values and never call engine for oversized requests', async t => {
  let calls = 0;
  const service = await launch(t, { maxRequestBytes: 128, maxResponseBytes: 256,
    handlers: { snapshot: () => { calls++; return 'response'.repeat(100); } } });
  const token = await pair(service);
  const body = { action: 'snapshot', params: { large: 'x'.repeat(129) } };
  assert.equal((await call(service, '/action', body, { token })).status, 413);
  assert.equal((await call(service, '/action', body, { token, headers: { 'content-length': undefined, 'transfer-encoding': 'chunked' } })).status, 413);
  assert.equal(calls, 0);
  const result = await call(service, '/action', undefined, { token });
  assert.equal(result.json.error.code, 'WORKBENCH_RESPONSE_LIMIT');
  assert.ok(Buffer.byteLength(result.text) <= 256);
  assert.equal(calls, 1);
});

test('a slow body cannot use revoked authority, and an incomplete body has a deadline', async t => {
  let calls = 0;
  const service = await launch(t, { bodyTimeoutMs: 60, handlers: { snapshot: () => ++calls } });
  let token = await pair(service);
  async function partial() {
    const body = JSON.stringify({ action: 'snapshot', params: {} });
    let resolveReply, rejectReply;
    const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const socket = connect({ host: '127.0.0.1', port: Number(new URL(service.url).port) });
    let response = '';
    socket.on('data', bytes => { response += bytes; }); socket.on('error', rejectReply);
    socket.on('end', () => resolveReply(response));
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.write(`POST /action HTTP/1.1\r\nHost: ${new URL(service.url).host}\r\nOrigin: ${service.origin}\r\nSec-Fetch-Site: same-origin\r\nSec-Fetch-Mode: cors\r\nSec-Fetch-Dest: empty\r\nAccept: application/json\r\nContent-Type: application/json\r\nX-Workbench-Token: ${token}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body.slice(0, 2)}`);
    return { socket, reply, rest: body.slice(2) };
  }
  const old = await partial();
  token = await pair(service);
  old.socket.end(old.rest);
  assert.match(await old.reply, /^HTTP\/1.1 401 /);
  const unfinished = await partial();
  assert.match(await unfinished.reply, /WORKBENCH_BODY_TIMEOUT/);
  assert.equal(calls, 0);
  assert.equal((await call(service, '/action', undefined, { token })).status, 200);
});

test('background polling and unauthenticated access do not keep authority alive', async t => {
  const service = await launch(t, { idleTimeoutMs: 160 });
  const token = await pair(service);
  for (let i = 0; i < 3; i++) {
    await delay(30);
    assert.equal((await call(service, '/action', undefined, { token })).status, 200);
  }
  assert.deepEqual(await service.closed, { reason: 'idle' });
  assert.equal(service.authorizePairing('unavailable'), false);
  await assert.rejects(call(service, '/action', undefined, { token }), /ECONNREFUSED|socket hang up/);
  const replacement = await launch(t);
  assert.equal((await call(replacement, '/action', undefined, { token })).status, 401);
});

test('explicit interaction extends idle, while absolute lifetime and manual shutdown revoke authority', async t => {
  const service = await launch(t, { idleTimeoutMs: 100, lifetimeMs: 240,
    handlers: { snapshot: { run: () => 'read', touch: true } } });
  const token = await pair(service);
  for (let i = 0; i < 3; i++) {
    await delay(55);
    assert.equal((await call(service, '/action', undefined, { token })).status, 200);
  }
  assert.deepEqual(await service.closed, { reason: 'lifetime' });
  const other = await launch(t);
  await pair(other);
  assert.deepEqual(await other.close(), { reason: 'operator' });
  assert.deepEqual(await other.close(), { reason: 'operator' });
});

test('concurrency is bounded; shutdown notifies accepted work without retaining its result', async t => {
  let entered = 0, release, signal;
  const barrier = new Promise(resolve => { release = resolve; });
  const service = await launch(t, { handlers: { snapshot: async (_params, context) => {
    entered++; signal = context.signal; await barrier; return 'completed';
  } } });
  const token = await pair(service);
  const active = Array.from({ length: 4 }, () => call(service, '/action', undefined, { token }).catch(error => error));
  for (let i = 0; entered < 4 && i < 100; i++) await delay(2);
  assert.equal(entered, 4);
  assert.equal((await call(service, '/action', undefined, { token })).status, 429);
  await service.close();
  assert.equal(signal.aborted, true);
  release();
  await Promise.all(active);
});
