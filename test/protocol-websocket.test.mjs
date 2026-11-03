import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { prepareWebsocket, prepareGraphqlSubscription } from '../lib/protocols/websocket.mjs';

async function fixture(t, connected, options = {}) {
  const requests = [], sockets = new Set();
  const server = createServer((req, res) => { res.writeHead(400); res.end(); });
  const ws = new WebSocketServer({ server, ...options });
  ws.on('connection', (socket, request) => {
    requests.push(request); sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    connected(socket, request);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => ws.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return { url: new URL(`http://127.0.0.1:${server.address().port}/stream`), requests, sockets };
}
const wsRequest = websocket => ({ websocket: { operation: 'fixture.events', timeout_ms: 1000, ...websocket } });
const graphqlRequest = websocket => ({ graphql: { document: 'subscription Counter { counter }' },
  websocket: { timeout_ms: 1000, ...websocket } });
async function execute(plan, target, options = {}) {
  let attempts = 0;
  const result = await plan.execute({ url: target.url, headers: {}, onAttempt: () => { attempts++; }, ...options });
  return { result, attempts };
}
const json = (socket, body) => socket.send(JSON.stringify(body));

test('WebSocket sends bounded JSON and captures messages through a normal close', async t => {
  const inbound = [];
  const target = await fixture(t, socket => socket.on('message', data => {
    const value = JSON.parse(data); inbound.push(value); json(socket, { echo: value });
    if (inbound.length === 2) socket.close(1000);
  }));
  const plan = await prepareWebsocket(wsRequest({ send: [{ number: 1 }, { number: 2 }] }));
  assert.equal(plan.operation, 'WEBSOCKET fixture.events');
  assert.equal(plan.effect, 'unknown');
  assert.equal(plan.contractDigest, null);
  const { result, attempts } = await execute(plan, target, { headers: { authorization: 'Bearer fixture-auth' } });
  assert.equal(attempts, 1);
  assert.equal(target.requests[0].headers.authorization, 'Bearer fixture-auth');
  assert.equal(target.requests[0].url, '/stream');
  assert.deepEqual(inbound, [{ number: 1 }, { number: 2 }]);
  assert.deepEqual(result, { status: 101, ok: true, body: { messages: [{ echo: { number: 1 } }, { echo: { number: 2 } }] },
    outcome: 'success', complete: true, sent: 2, received: 2, protocolStatus: 1000 });
});

test('a matching predicate completes exactly at the configured message cap', async t => {
  const target = await fixture(t, socket => { json(socket, { state: 'waiting' }); json(socket, { state: 'done' }); });
  const { result } = await execute(await prepareWebsocket(wsRequest({ max_messages: 2, until: { json: 'state', equals: 'done' } })), target);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.protocolStatus, 'predicate');
  assert.equal(result.received, 2);
});

test('a welcome predicate does not skip the configured initial sends', async t => {
  const inbound = [];
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const target = await fixture(t, socket => {
    json(socket, { ready: true });
    socket.on('message', data => inbound.push(JSON.parse(data)));
    socket.on('close', close);
  });
  const outgoing = Array.from({ length: 32 }, (_, sequence) => ({ sequence }));
  const { result } = await execute(await prepareWebsocket(wsRequest({ send: outgoing, until: { json: 'ready', equals: true } })), target);
  await closed;
  assert.equal(result.ok, true);
  assert.equal(result.sent, outgoing.length);
  assert.deepEqual(inbound, outgoing);
});

test('a peer ignoring close cannot outlive the fixed cleanup interval', async t => {
  const target = await fixture(t, socket => {
    // A paused peer never receives the close frame; the client must terminate.
    socket._socket.pause();
    json(socket, { ready: true });
  });
  const started = Date.now();
  const { result } = await execute(await prepareWebsocket(wsRequest({ until: { json: 'ready', equals: true } })), target);
  assert.equal(result.ok, true);
  assert.ok(Date.now() - started < 1000, 'close cleanup must not wait for the ws library default of 30 seconds');
});

test('a message cap without completion is an incomplete result with retained messages', async t => {
  const target = await fixture(t, socket => { json(socket, 1); json(socket, 2); json(socket, 3); });
  const { result } = await execute(await prepareWebsocket(wsRequest({ max_messages: 2 })), target);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.error.code, 'WEBSOCKET_MESSAGE_LIMIT');
  assert.deepEqual(result.body.messages, [1, 2]);
});

test('a normal close cannot satisfy an unmet completion predicate', async t => {
  const target = await fixture(t, socket => { json(socket, { state: 'waiting' }); socket.close(1000); });
  const { result } = await execute(await prepareWebsocket(wsRequest({ until: { json: 'state', equals: 'done' } })), target);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.complete, false);
  assert.equal(result.error.code, 'WEBSOCKET_CLOSED_BEFORE_COMPLETION');
});

test('own deadline, external timeout, and cancellation release idle connections', async t => {
  for (const kind of ['deadline', 'timeout', 'cancelled']) await t.test(kind, async t => {
    let close;
    const closed = new Promise(resolve => { close = resolve; });
    const target = await fixture(t, socket => socket.on('close', close));
    const controller = new AbortController();
    const timer = kind === 'cancelled' ? setTimeout(() => controller.abort(), 50) : null;
    t.after(() => clearTimeout(timer));
    const signal = kind === 'timeout' ? AbortSignal.timeout(50) : controller.signal;
    const { result, attempts } = await execute(await prepareWebsocket(wsRequest({ timeout_ms: kind === 'deadline' ? 50 : 1000 })), target, { signal });
    await closed;
    assert.equal(attempts, 1);
    assert.equal(result.ok, false);
    assert.equal(result.complete, false);
    assert.equal(result.outcome, kind === 'cancelled' ? 'cancelled' : 'timeout');
    assert.equal(target.sockets.size, 0);
  });
});

test('an already-cancelled session performs zero connection attempts', async t => {
  const target = await fixture(t, () => assert.fail('must not connect'));
  const { result, attempts } = await execute(await prepareWebsocket(wsRequest({})), target, { signal: AbortSignal.abort() });
  assert.equal(attempts, 0);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.status, null);
  assert.equal(target.requests.length, 0);
});

test('an upgrade redirect is refused without forwarding configured credentials', async t => {
  let destinationRequests = 0, authorization;
  const destination = createServer((req, res) => { destinationRequests++; res.end(); });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  const redirect = createServer((req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/other` }); res.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => redirect.close(resolve));
    await new Promise(resolve => destination.close(resolve));
  });
  const { result, attempts } = await execute(await prepareWebsocket(wsRequest({})),
    { url: new URL(`http://127.0.0.1:${redirect.address().port}/stream`) }, { headers: { authorization: 'Bearer fixture-auth' } });
  assert.equal(attempts, 1);
  assert.equal(authorization, 'Bearer fixture-auth');
  assert.equal(destinationRequests, 0);
  assert.equal(result.status, 302);
  assert.equal(result.error.code, 'WEBSOCKET_REDIRECT_REFUSED');
});

test('frame and total-byte limits retain only bounded evidence', async t => {
  await t.test('frame', async t => {
    const target = await fixture(t, socket => json(socket, { text: 'x'.repeat(300) }));
    const { result } = await execute(await prepareWebsocket(wsRequest({ max_frame_bytes: 128 })), target);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'WEBSOCKET_BYTE_LIMIT');
    assert.deepEqual(result.body.messages, []);
    assert.ok(result.omissions.length);
  });
  await t.test('total', async t => {
    const target = await fixture(t, socket => { json(socket, { text: 'x'.repeat(60) }); json(socket, { text: 'y'.repeat(60) }); });
    const { result } = await execute(await prepareWebsocket(wsRequest({ max_frame_bytes: 128, max_total_bytes: 100 })), target);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'WEBSOCKET_BYTE_LIMIT');
    assert.equal(result.received, 2);
    assert.equal(result.body.messages.length, 1);
  });
});

test('invalid JSON, binary frames, and abnormal closes are explicit failures without retries', async t => {
  for (const [name, send, code] of [
    ['JSON', socket => socket.send('not JSON'), 'WEBSOCKET_INVALID_JSON'],
    ['binary', socket => socket.send(Buffer.from([1, 2, 3])), 'WEBSOCKET_BINARY_UNSUPPORTED'],
    ['abnormal close', socket => socket.close(1008, 'private server diagnostic'), 'WEBSOCKET_ABNORMAL_CLOSE'],
  ]) await t.test(name, async t => {
    const target = await fixture(t, send);
    const { result, attempts } = await execute(await prepareWebsocket(wsRequest({})), target);
    assert.equal(attempts, 1);
    assert.equal(target.requests.length, 1);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.ok(!JSON.stringify(result).includes('private server diagnostic'));
  });
});

test('control frames are answered within a fixed bound', async t => {
  await t.test('ping/pong', async t => {
    const target = await fixture(t, socket => {
      socket.on('pong', data => { assert.equal(data.toString(), 'check'); json(socket, { ready: true }); socket.close(1000); });
      socket.ping('check');
    });
    const { result } = await execute(await prepareWebsocket(wsRequest({})), target);
    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(result.received, 1);
  });
  await t.test('control flood', async t => {
    const target = await fixture(t, socket => { for (let i = 0; i < 100; i++) socket.ping('x'); });
    const { result } = await execute(await prepareWebsocket(wsRequest({})), target);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'WEBSOCKET_CONTROL_LIMIT');
    assert.ok(result.sent <= 64);
  });
});

test('unsafe or unbounded WebSocket options are rejected during preparation', async () => {
  for (const config of [
    { operation: '' }, { timeout_ms: 60001 }, { max_messages: 0 }, { max_frame_bytes: 1048577 },
    { max_total_bytes: Infinity }, { until: { json: 'status' } }, { until: { json: 'status', equals: {} } },
    { subprotocols: ['duplicate', 'duplicate'] }, { subprotocols: ['invalid protocol'] },
    { send: [undefined] }, { send: [NaN] }, { send: [1n] }, { send: Array(33).fill({}) },
    { send: [{ text: 'oversized' }], max_frame_bytes: 2 }, { typo_timeout_ms: 1 },
  ]) await assert.rejects(prepareWebsocket(wsRequest(config)), { code: 'INVALID_WEBSOCKET_REQUEST' });
});

function graphqlServer(onSubscribe) {
  return socket => socket.on('message', data => {
    const frame = JSON.parse(data);
    if (frame.type === 'connection_init') json(socket, { type: 'connection_ack' });
    else if (frame.type === 'subscribe') onSubscribe(socket, frame);
    else if (frame.type === 'complete') socket.close(1000);
  });
}

test('GraphQL subscription initializes, waits for acknowledgement, subscribes once, and completes', async t => {
  const subscriptions = [];
  const target = await fixture(t, graphqlServer((socket, frame) => {
    subscriptions.push(frame);
    json(socket, { id: frame.id, type: 'next', payload: { data: { counter: 1 } } });
    json(socket, { id: frame.id, type: 'next', payload: { data: { counter: 2 } } });
    json(socket, { id: frame.id, type: 'complete' });
  }));
  const plan = await prepareGraphqlSubscription(graphqlRequest({}));
  const { result, attempts } = await execute(plan, target);
  assert.equal(attempts, 1);
  assert.match(plan.operation, /subscription.*Counter/i);
  assert.equal(target.requests[0].headers['sec-websocket-protocol'], 'graphql-transport-ws');
  assert.equal(subscriptions.length, 1);
  assert.match(subscriptions[0].payload.query, /subscription Counter/);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.protocolStatus, 'complete');
  assert.equal(result.sent, 2);
  assert.equal(result.received, 4);
  assert.deepEqual(result.body.messages.map(frame => frame.type), ['connection_ack', 'next', 'next', 'complete']);
});

test('GraphQL predicate completion sends one unsubscribe and retains the matching payload', async t => {
  let unsubscribed;
  const completed = new Promise(resolve => { unsubscribed = resolve; });
  const target = await fixture(t, socket => socket.on('message', data => {
    const frame = JSON.parse(data);
    if (frame.type === 'connection_init') json(socket, { type: 'connection_ack' });
    if (frame.type === 'subscribe') {
      json(socket, { id: frame.id, type: 'next', payload: { data: { counter: 1 } } });
      json(socket, { id: frame.id, type: 'next', payload: { data: { counter: 2 } } });
    }
    if (frame.type === 'complete') { unsubscribed(); socket.close(1000); }
  }));
  const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({ max_messages: 3, until: { json: 'data.counter', equals: 2 } })), target);
  await completed;
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.sent, 3);
  assert.equal(result.received, 3);
  assert.equal(result.body.messages.at(-1).payload.data.counter, 2);
});

test('GraphQL partial execution errors and terminal errors cannot look successful', async t => {
  for (const kind of ['next', 'error']) await t.test(kind, async t => {
    const target = await fixture(t, graphqlServer((socket, frame) => json(socket, { id: frame.id, type: kind,
      payload: kind === 'next' ? { data: { counter: null }, errors: [{ message: 'fixture failure' }] } : [{ message: 'fixture failure' }] })));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({})), target);
    assert.equal(result.ok, false);
    assert.equal(result.complete, false);
    assert.equal(result.error.code, 'GRAPHQL_EXECUTION_ERROR');
    assert.equal(result.outcome, kind === 'next' ? 'partial' : 'error');
  });
});

test('GraphQL protocol order and operation identity are validated', async t => {
  for (const kind of ['before_ack', 'wrong_id', 'duplicate_ack', 'invalid_payload']) await t.test(kind, async t => {
    const target = await fixture(t, socket => socket.on('message', data => {
      const frame = JSON.parse(data);
      if (frame.type === 'connection_init') {
        if (kind === 'before_ack') json(socket, { id: 'unexpected', type: 'next', payload: { data: {} } });
        else { json(socket, { type: 'connection_ack' }); if (kind === 'duplicate_ack') json(socket, { type: 'connection_ack' }); }
      }
      if (frame.type === 'subscribe') json(socket, { id: kind === 'wrong_id' ? 'unexpected' : frame.id,
        type: 'next', payload: kind === 'invalid_payload' ? 'invalid' : { data: {} } });
    }));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({})), target);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'GRAPHQL_WS_PROTOCOL_ERROR');
  });
});

test('GraphQL subscription result envelopes use the same validation as HTTP GraphQL', async t => {
  for (const payload of [{ data: 42 }, { errors: [] }, { errors: ['invalid'] },
    { data: {}, extensions: false }, { data: {}, errors: [{ message: 42 }] }]) await t.test(JSON.stringify(payload), async t => {
    const target = await fixture(t, graphqlServer((socket, frame) => {
      json(socket, { id: frame.id, type: 'next', payload });
      json(socket, { id: frame.id, type: 'complete' });
    }));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({})), target);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'GRAPHQL_WS_PROTOCOL_ERROR');
  });
  await t.test('null data with errors is an error', async t => {
    const target = await fixture(t, graphqlServer((socket, frame) =>
      json(socket, { id: frame.id, type: 'next', payload: { data: null, errors: [{ message: 'fixture failure' }] } })));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({})), target);
    assert.equal(result.outcome, 'error');
  });
  await t.test('invalid terminal error objects', async t => {
    const target = await fixture(t, graphqlServer((socket, frame) => json(socket, { id: frame.id, type: 'error', payload: ['invalid'] })));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({})), target);
    assert.equal(result.error.code, 'GRAPHQL_WS_PROTOCOL_ERROR');
  });
});

test('GraphQL cannot subscribe without acknowledgement or infer completion from socket close', async t => {
  await t.test('no acknowledgement', async t => {
    const frames = [];
    const target = await fixture(t, socket => socket.on('message', data => frames.push(JSON.parse(data))));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({ timeout_ms: 50 })), target);
    assert.equal(result.outcome, 'timeout');
    assert.deepEqual(frames.map(frame => frame.type), ['connection_init']);
  });
  await t.test('close before complete', async t => {
    const target = await fixture(t, graphqlServer((socket, frame) => { json(socket, { id: frame.id, type: 'next', payload: { data: {} } }); socket.close(1000); }));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({})), target);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'WEBSOCKET_CLOSED_BEFORE_COMPLETION');
  });
  await t.test('message cap', async t => {
    const target = await fixture(t, graphqlServer((socket, frame) => { json(socket, { id: frame.id, type: 'next', payload: { data: {} } }); json(socket, { id: frame.id, type: 'complete' }); }));
    const { result } = await execute(await prepareGraphqlSubscription(graphqlRequest({ max_messages: 2 })), target);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, 'WEBSOCKET_MESSAGE_LIMIT');
    assert.equal(result.received, 2);
  });
});

test('GraphQL subscription preparation refuses unsupported sends, protocols, and operation types', async () => {
  await assert.rejects(prepareGraphqlSubscription(graphqlRequest({ send: [{ type: 'subscribe' }] })), { code: 'INVALID_WEBSOCKET_REQUEST' });
  await assert.rejects(prepareGraphqlSubscription(graphqlRequest({ subprotocols: ['graphql-ws'] })), { code: 'INVALID_WEBSOCKET_REQUEST' });
  await assert.rejects(prepareGraphqlSubscription({ graphql: { document: 'query Counter { counter }' } }), { code: 'INVALID_WEBSOCKET_REQUEST' });
});
