import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchema, introspectionFromSchema } from 'graphql';
import { analyzeGraphql, prepareGraphql } from '../lib/protocols/graphql.mjs';
import { prepareJsonRpc } from '../lib/protocols/jsonrpc.mjs';
import { RESPONSE_MAX_BYTES } from '../lib/response-bounds.mjs';

const SDL = 'type Device { id: ID!, label: String! } type Query { device(id: ID!): Device } type Mutation { rename(id: ID!, label: String!): Device } type Subscription { changed: Device }';
const DOCUMENT = 'query Device($id: ID!) { device(id: $id) { id label } }';
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'sannr-protocol-http-'));
  writeFileSync(join(root, 'schema.graphql'), SDL);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
async function endpoint(t, handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, method: req.method, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    calls.push(call);
    res.setHeader('content-type', 'application/json');
    await handler(call, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: new URL(`http://127.0.0.1:${server.address().port}/api`), calls };
}
const gql = overrides => ({ graphql: { document: DOCUMENT, variables: { id: 'sample-id' }, ...overrides } });

test('GraphQL identity uses selected operation and canonical document, excluding variable values', async () => {
  const a = await analyzeGraphql(gql());
  const whitespace = await analyzeGraphql(gql({ document: '# comment\nquery Device ( $id: ID! ) { device (id:$id) {id label} }', variables: { id: 'other-id' } }));
  const different = await analyzeGraphql(gql({ document: 'query Device($id: ID!) { device(id: $id) { id } }' }));
  assert.equal(a.operation, whitespace.operation);
  assert.notEqual(a.operation, different.operation);
  assert.equal(a.effect, 'read');
  assert.equal(a.contractDigest, null);
  assert.equal(a.declaration.schemaValidated, false);
  assert.doesNotMatch(JSON.stringify({ operation: a.operation, declaration: a.declaration }), /sample-id/);
  assert.deepEqual(a.declaration.variables, [{ name: 'id', type: 'ID!' }]);
});

test('GraphQL requires one selected operation and rejects invalid executable documents before sending', async () => {
  await assert.rejects(prepareGraphql(gql({ schemaFile: 'unsupported-option.graphql' })), { code: 'GRAPHQL_OPTION_UNSUPPORTED' });
  for (const [document, operationName, code] of [
    ['query A { a } query B { b }', undefined, 'GRAPHQL_OPERATION_REQUIRED'],
    ['query A { a }', 'Missing', 'GRAPHQL_OPERATION_REQUIRED'],
    ['query A { a } query A { b }', 'A', 'GRAPHQL_OPERATION_INVALID'],
    ['{ a } query B { b }', 'B', 'GRAPHQL_OPERATION_INVALID'],
    ['query {', undefined, 'GRAPHQL_DOCUMENT_INVALID'],
    ['type Query { a: String }', undefined, 'GRAPHQL_DOCUMENT_INVALID'],
  ]) await assert.rejects(prepareGraphql(gql({ document, ...(operationName ? { operationName } : {}) })), { code });
  const query = await prepareGraphql(gql({ document: 'query A { a } mutation B { b }', operationName: 'A' }));
  const mutation = await prepareGraphql(gql({ document: 'query A { a } mutation B { b }', operationName: 'B' }));
  assert.equal(query.effect, 'read');
  assert.equal(mutation.effect, 'write');
  assert.notEqual(query.operation, mutation.operation);
});

test('GraphQL validates SDL and variables locally without retaining scalar values', async t => {
  const root = fixture(t);
  const prepared = await prepareGraphql(gql({ schema: 'schema.graphql' }), { root });
  assert.match(prepared.contractDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(prepared.declaration.schemaValidated, true);
  assert.equal(prepared.declaration.validationScope, 'request-document-and-variables');
  assert.equal(prepared.declaration.responseValidated, false);
  for (const variables of [{}, { id: { private: 'not-an-id' } }])
    await assert.rejects(prepareGraphql(gql({ schema: 'schema.graphql', variables }), { root }), error => {
      assert.equal(error.code, 'GRAPHQL_VALIDATION_FAILED');
      assert.doesNotMatch(error.message, /not-an-id|private/);
      return true;
    });
  await assert.rejects(prepareGraphql(gql({ schema: 'schema.graphql', document: '{ missingField }' }), { root }), { code: 'GRAPHQL_VALIDATION_FAILED' });
  assert.equal((await prepareGraphql({ graphql: { document: 'mutation R { rename(id: "one", label: "private-label") { id } }', schema: 'schema.graphql' } }, { root })).effect, 'write');
});

test('GraphQL accepts project-local introspection but refuses escaped or malformed schema files', async t => {
  const root = fixture(t), outside = fixture(t);
  const introspection = introspectionFromSchema(buildSchema(SDL));
  writeFileSync(join(root, 'schema.json'), JSON.stringify({ data: introspection }));
  assert.equal((await prepareGraphql(gql({ schema: 'schema.json' }), { root })).declaration.schemaValidated, true);
  writeFileSync(join(root, 'broken.graphql'), 'private-invalid-schema {');
  await assert.rejects(prepareGraphql(gql({ schema: 'broken.graphql' }), { root }), { code: 'GRAPHQL_SCHEMA_INVALID' });
  await assert.rejects(prepareGraphql(gql({ schema: join(root, 'schema.json') }), { root }), { code: 'GRAPHQL_SCHEMA_PATH_INVALID' });
  await assert.rejects(prepareGraphql(gql({ schema: '../missing-outside-schema.json' }), { root }), { code: 'GRAPHQL_SCHEMA_PATH_INVALID' });
  symlinkSync(join(outside, 'schema.graphql'), join(root, 'outside.graphql'));
  await assert.rejects(prepareGraphql(gql({ schema: 'outside.graphql' }), { root }), { code: 'GRAPHQL_SCHEMA_PATH_INVALID' });
});

test('GraphQL HTTP adapter refuses subscriptions; shared analysis preserves their identity', async () => {
  const request = { graphql: { document: 'subscription Changes { changed { id } }' } };
  assert.equal((await analyzeGraphql(request)).kind, 'subscription');
  await assert.rejects(prepareGraphql(request), { code: 'GRAPHQL_SUBSCRIPTION_TRANSPORT_REQUIRED' });
});

test('GraphQL query executes one POST with the selected document and bounded application outcome', async t => {
  const e = await endpoint(t, (call, res) => res.end(JSON.stringify({ data: { device: { id: call.body.variables.id, label: 'fixture' } } })));
  const request = gql(), prepared = await prepareGraphql(request);
  request.graphql.variables.id = 'changed-after-prepare';
  let attempts = 0;
  const result = await prepared.execute({ url: e.url, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'text/plain' }, onAttempt: () => attempts++ });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'success');
  assert.equal(result.complete, true);
  assert.equal(result.status, 200);
  assert.equal(result.sent, 1);
  assert.equal(result.received, 1);
  assert.equal(attempts, 1);
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].method, 'POST');
  assert.equal(e.calls[0].headers.authorization, 'Bearer fixture');
  assert.equal(e.calls[0].headers['content-type'], 'application/json');
  assert.equal(e.calls[0].body.operationName, 'Device');
  assert.equal(e.calls[0].body.variables.id, 'sample-id');
});

test('GraphQL HTTP 200 errors and partial data never masquerade as success', async t => {
  const replies = [
    { data: { device: null }, errors: [{ message: 'private application detail' }] },
    { errors: [{ message: 'private request detail' }] },
    { data: null, errors: [{ message: 'private execution detail' }] },
  ];
  const e = await endpoint(t, (_call, res) => res.end(JSON.stringify(replies.shift())));
  const prepared = await prepareGraphql(gql());
  for (const expected of ['partial', 'error', 'error']) {
    const result = await prepared.execute({ url: e.url });
    assert.equal(result.status, 200);
    assert.equal(result.ok, false);
    assert.equal(result.complete, true);
    assert.equal(result.outcome, expected);
    assert.equal(result.error.code, 'GRAPHQL_ERRORS');
    assert.doesNotMatch(result.error.message, /private/);
  }
});

test('GraphQL incomplete, invalid and non-success HTTP responses stay distinct', async t => {
  const replies = [
    { body: { data: { device: null }, hasNext: true }, code: 'GRAPHQL_INCREMENTAL_UNSUPPORTED' },
    { body: { data: [], errors: [] }, code: 'GRAPHQL_RESPONSE_INVALID' },
    { body: { errors: [{ code: 7 }] }, code: 'GRAPHQL_RESPONSE_INVALID' },
    { body: { data: { device: null } }, status: 503, code: 'GRAPHQL_HTTP_ERROR' },
  ];
  let next;
  const e = await endpoint(t, (_call, res) => { res.statusCode = next.status ?? 200; res.end(JSON.stringify(next.body)); });
  const prepared = await prepareGraphql(gql());
  for (next of replies) {
    const result = await prepared.execute({ url: e.url });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, next.code);
    assert.equal(result.complete, next.status === 503);
  }
});

test('JSON-RPC preserves string, integer and null ids and does not infer method effects', async t => {
  const e = await endpoint(t, (call, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: call.body.id, result: null })));
  for (const id of ['one', 0, null, undefined]) {
    const prepared = await prepareJsonRpc({ rpc: { method: 'rpc.discover', params: [], ...(id !== undefined ? { id } : {}) } });
    assert.equal(prepared.operation, 'rpc.discover');
    assert.equal(prepared.effect, 'unknown');
    const result = await prepared.execute({ url: e.url });
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    if (id !== undefined) assert.equal(e.calls.at(-1).body.id, id);
    else assert.equal(typeof e.calls.at(-1).body.id, 'string');
  }
});

test('JSON-RPC enforces correlation, result/error exclusivity and valid error structure', async t => {
  const replies = [
    { jsonrpc: '2.0', id: '1', result: 'private' },
    { jsonrpc: '2.0', id: 1, result: 1, error: { code: -32603, message: 'private' } },
    { jsonrpc: '2.0', id: 1 },
    { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: 'private' } },
    { jsonrpc: '1.0', id: 1, result: 3 },
    [{ jsonrpc: '2.0', id: 1, result: 3 }],
  ];
  const e = await endpoint(t, (_call, res) => res.end(JSON.stringify(replies.shift())));
  const prepared = await prepareJsonRpc({ rpc: { method: 'sum', params: [1, 2], id: 1 } });
  for (let i = 0; i < 6; i++) {
    const result = await prepared.execute({ url: e.url });
    assert.equal(result.ok, false);
    assert.equal(result.complete, false);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(result.error.code, i === 0 ? 'JSONRPC_ID_MISMATCH' : 'JSONRPC_RESPONSE_INVALID');
    assert.doesNotMatch(result.error.message, /private/);
  }
});

test('JSON-RPC application errors are terminal protocol failures even on HTTP 200', async t => {
  const e = await endpoint(t, (call, res) => res.end(JSON.stringify({ jsonrpc: '2.0', id: call.body.id, error: { code: -32001, message: 'private error detail', data: { token: 'private' } } })));
  const prepared = await prepareJsonRpc({ rpc: { method: 'charge', params: { amount: 7 } } });
  const result = await prepared.execute({ url: e.url });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'error');
  assert.equal(result.complete, true);
  assert.equal(result.protocolStatus, -32001);
  assert.equal(result.error.code, 'JSONRPC_REMOTE_ERROR');
  assert.doesNotMatch(result.error.message, /private/);
});

test('JSON-RPC refuses unsupported batches, notifications and schemas instead of silently changing execution', async () => {
  for (const [rpc, code] of [
    [[], 'JSONRPC_BATCH_UNSUPPORTED'], [{ batch: [] }, 'JSONRPC_BATCH_UNSUPPORTED'],
    [{ method: 'notify', notification: true }, 'JSONRPC_NOTIFICATION_UNSUPPORTED'],
    [{ method: 'sum', schema: 'schema.json' }, 'JSONRPC_SCHEMA_UNSUPPORTED'],
    [{ method: 'sum', version: '1.0' }, 'JSONRPC_OPTION_UNSUPPORTED'],
    [{ method: '', params: [] }, 'JSONRPC_METHOD_INVALID'],
    [{ method: 'sum', params: 'invalid' }, 'JSONRPC_PARAMS_INVALID'],
    [{ method: 'sum', id: 1.5 }, 'JSONRPC_ID_INVALID'],
    [{ method: 'sum', params: { number: Infinity } }, 'JSONRPC_INPUT_INVALID'],
  ]) await assert.rejects(prepareJsonRpc({ rpc }), { code });
});

test('HTTP protocol adapters never follow redirects or retry', async t => {
  const e = await endpoint(t, (_call, res) => { res.statusCode = 302; res.setHeader('location', '/should-not-run'); res.end(); });
  for (const prepared of [await prepareGraphql(gql()), await prepareJsonRpc({ rpc: { method: 'sum' } })]) {
    let attempts = 0;
    const result = await prepared.execute({ url: e.url, onAttempt: () => attempts++ });
    assert.equal(result.error.code, 'PROTOCOL_REDIRECT_REFUSED');
    assert.equal(result.complete, false);
    assert.equal(attempts, 1);
  }
  assert.deepEqual(e.calls.map(call => call.path), ['/api', '/api']);
});

test('HTTP protocol adapters report pre-send cancellation and body deadlines without success claims', async t => {
  const e = await endpoint(t, (_call, res) => { res.write('{'); });
  const prepared = await prepareGraphql(gql());
  const controller = new AbortController(); controller.abort();
  let attempts = 0;
  const cancelled = await prepared.execute({ url: e.url, signal: controller.signal, onAttempt: () => attempts++ });
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.sent, 0);
  assert.equal(attempts, 0);
  const timed = await prepared.execute({ url: e.url, signal: AbortSignal.timeout(50), onAttempt: () => attempts++ });
  assert.equal(timed.outcome, 'timeout');
  assert.equal(timed.complete, false);
  assert.equal(timed.sent, 1);
  assert.equal(attempts, 1);
});

test('HTTP protocol adapters bound decoded response bytes and reject invalid JSON', async t => {
  let oversized = false;
  const e = await endpoint(t, (_call, res) => res.end(oversized ? 'x'.repeat(RESPONSE_MAX_BYTES + 1) : 'private invalid json'));
  const prepared = await prepareJsonRpc({ rpc: { method: 'sum' } });
  const invalid = await prepared.execute({ url: e.url });
  assert.equal(invalid.error.code, 'PROTOCOL_RESPONSE_INVALID');
  assert.equal(invalid.body, null);
  assert.doesNotMatch(invalid.error.message, /private/);
  oversized = true;
  const limited = await prepared.execute({ url: e.url });
  assert.equal(limited.error.code, 'RESPONSE_OVERSIZED');
  assert.equal(limited.complete, false);
});
