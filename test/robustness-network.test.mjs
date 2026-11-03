import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runNetwork, runJob, defective } from './robustness/network-driver.mjs';

test('H2 deterministic network response variations obey error, deadline, memory and promotion bounds', { timeout: 30000 }, async t => {
  const started = performance.now();
  const results = await runNetwork();
  for (const row of results) await t.test(`${row.entry} × ${row.variation}`, () => assert.equal(defective(row), false, JSON.stringify(row)));
  assert.ok(performance.now() - started <= 30000, 'network gate share exceeds 30 s');
});

for (const [finding, entry, variation, code] of [
  ['H2-01', 'apiRequest', 'oversized-body', 'RESPONSE_OVERSIZED'],
  ['H2-01', 'apiRequest', 'binary-oversized', 'RESPONSE_OVERSIZED'],
  ['H2-01', 'apiRequest', 'gzip-expansion', 'RESPONSE_OVERSIZED'],
  ['H2-01', 'apiRequest', 'deep-json', 'RESPONSE_OVERSIZED'],
  ['H2-01', 'apiRequest', 'oauth-oversized', 'RESPONSE_OVERSIZED'],
  ['H2-01', 'apiRequest', 'page-oversized', 'RESPONSE_OVERSIZED'],
  ['H2-01', 'apiRequest', 'page-deep', 'RESPONSE_OVERSIZED'],
  ['H2-02', 'apiRequest', 'oauth-slow', 'REQUEST_TIMEOUT'],
  ['H2-02', 'apiRequest', 'page-slow', 'REQUEST_TIMEOUT'],
  ['H2-02', 'apiRequest', 'redirect-slow', 'REQUEST_TIMEOUT'],
  ['H2-02', 'apiRequest', 'retry-delay', 'REQUEST_TIMEOUT'],
  ['H2-02', 'apiRequest', 'oauth-null', 'OAUTH_NO_ACCESS_TOKEN'],
  ['H2-02', 'apiRequest', 'invalid-length', 'TRANSPORT_FAILED'],
  ['H2-02', 'apiRequest', 'lying-length', 'TRANSPORT_FAILED'],
  ['H2-02', 'apiRequest', 'redirect-loop', 'RESPONSE_REDIRECT_LOOP'],
  ['H2-02', 'apiRequest', 'invalid-redirect', 'RESPONSE_REDIRECT_INVALID'],
  ['H2-02', 'apiRequest', 'retry-slow', 'REQUEST_TIMEOUT'],
  ['H2-08', 'inspectMcp:stdio', 'list-spread', 'MCP_LIST_LIMIT'],
  ['H2-08', 'inspectMcp:http', 'list-spread', 'MCP_LIST_LIMIT'],
  ['H2-07', 'inspectMcp:stdio', 'slow-pages', 'MCP_TIMEOUT'],
  ['H2-07', 'inspectMcp:http', 'slow-pages', 'MCP_TIMEOUT'],
  ['H2-04', 'inspectMcp:stdio', 'non-utf8', 'MCP_ENCODING_INVALID'],
  ['H2-04', 'inspectMcp:http', 'non-utf8', 'MCP_ENCODING_INVALID'],
  ['H2-05', 'inspectMcp:http', 'session-change', 'MCP_SESSION_CHANGED'],
  ['H2-06', 'inspectMcp:stdio', 'rpc-error', 'MCP_LIST_FAILED'],
]) test(`${finding} ${entry} ${variation} refuses by name without response diagnostics`, async () => {
  const row = await runJob({ entry, variation, index: 0 });
  assert.equal(defective(row), false, JSON.stringify(row));
  assert.equal(row.code, code, JSON.stringify(row));
});
for (const [entry, variation, code] of [
  ['cli:request-envelope', 'invalid-length', 'TRANSPORT_FAILED'],
  ['cli:request-direct', 'invalid-length', 'TRANSPORT_FAILED'],
  ['cli:request-direct', 'oversized-body', 'RESPONSE_OVERSIZED'],
  ['cli:request', 'invalid-length', 'TRANSPORT_FAILED'],
  ['cli:mcp-registered:stdio', 'ten-thousand-tools', 'MCP_LIST_LIMIT'],
  ['cli:mcp:stdio', 'ten-thousand-tools', 'MCP_LIST_LIMIT'],
  ['cli:request', 'redirect-loop', 'RESPONSE_REDIRECT_LOOP'],
  ['cli:request', 'retry-slow', 'REQUEST_TIMEOUT'],
  ['cli:request', 'gzip-expansion', 'RESPONSE_OVERSIZED'],
  ['cli:mcp:stdio', 'rpc-error', 'MCP_LIST_FAILED'],
  ['cli:mcp:http', 'non-utf8', 'MCP_ENCODING_INVALID'],
  ['cli:mcp:http', 'status-503', 'MCP_HTTP_FAILED'],
]) test(`H2-03 ${entry} ${variation} exits 1 with a named code and no stack`, async () => {
  const row = await runJob({ entry, variation, index: 0 });
  assert.equal(defective(row), false, JSON.stringify(row));
  assert.equal(row.exitCode, 1, JSON.stringify(row));
  assert.ok(row.codes.includes(code), JSON.stringify(row));
});
