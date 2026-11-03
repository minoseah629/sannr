import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT } from '../lib/brand.mjs';

const client = new URL('../lib/protocol-client.mjs', import.meta.url).href;
const credentials = new URL('../lib/protocol-credentials.mjs', import.meta.url).href;
function probe(t, specimen) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-protocol-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('API_') && !name.startsWith(`${PRODUCT.toUpperCase()}_`)));
  const script = `
    import { randomUUID } from 'node:crypto';
    const { protocolRequest } = await import(${JSON.stringify(client)});
    const { payloadCredentialProblem } = await import(${JSON.stringify(credentials)});
    const secret = randomUUID(), evidence = [];
    let reads = 0, hookCalls = 0, targetCalls = 0, mutate = () => {};
    const runtime = { root: process.cwd(), timeoutMs: 1000, budget: 10000, contextEnabled: false,
      errorEnvelope: ({ error, code, message, ...rest }) => ({ ...rest, ok: false, error: error ?? { code, message } }),
      prepareTarget: async () => { targetCalls++; mutate(); return { provider: 'fixture', environment: 'local',
        url: new URL('http://127.0.0.1/rpc'), headers: {}, secrets: [] }; },
      // This is a controlled adapter-result fixture, with no network execution.
      withSlot: async () => ({ status: 200, body: { ready: true }, ok: true, outcome: 'success', complete: true, sent: 1, received: 1 }),
      scrub: value => value,
      writeEvidence: record => { evidence.push(JSON.stringify(record)); return { id: 'fixture', path: process.cwd() + '/evidence.json' }; },
    };
    ${specimen}
    process.stdout.write(JSON.stringify({ ok: result.ok, code: result.error?.code, reads, hookCalls, targetCalls,
      secretPresent: JSON.stringify(result).includes(secret) || evidence.some(value => value.includes(secret)),
      evidencePresent: evidence.length > 0, problem }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined, 'The programmatic fixture must finish inside its deadline');
  assert.equal(result.status, 0, 'The programmatic fixture child must finish successfully');
  assert.equal(result.stderr, '', 'The programmatic fixture must not log diagnostics');
  return JSON.parse(result.stdout);
}

test('AH-3 protocol payload getter is refused before invocation and cannot promote a changing credential', t => {
  const out = probe(t, `
    const graphql = { document: 'query Item { item }' };
    Object.defineProperty(graphql, 'variables', { enumerable: true, get() { reads++; return reads === 1 ? {} : { password: secret }; } });
    const result = await protocolRequest({ protocol: 'graphql', graphql }, runtime);
    const problem = null;
  `);
  assert.equal(out.code, 'PROTOCOL_INPUT_INVALID');
  assert.equal(out.reads, 0);
  assert.equal(out.targetCalls, 0);
  assert.equal(out.secretPresent, false);
  assert.equal(out.evidencePresent, false);
});

test('AH-3 nonenumerable payload toJSON is refused without executing or promoting its credential', t => {
  const out = probe(t, `
    const params = {};
    Object.defineProperty(params, 'toJSON', { value() { hookCalls++; return { password: secret }; } });
    const request = { protocol: 'jsonrpc', rpc: { method: 'fixture.read', params } };
    const problem = payloadCredentialProblem(request);
    const result = await protocolRequest(request, runtime);
  `);
  assert.equal(out.code, 'PROTOCOL_INPUT_INVALID');
  assert.equal(out.problem, 'PROTOCOL_INPUT_INVALID');
  assert.equal(out.hookCalls, 0);
  assert.equal(out.targetCalls, 0);
  assert.equal(out.secretPresent, false);
  assert.equal(out.evidencePresent, false);
});

test('AH-3 protocol evidence reuses the scanned payload snapshot across asynchronous preparation', t => {
  const out = probe(t, `
    const params = { nested: { ready: true } };
    const request = { protocol: 'jsonrpc', rpc: { method: 'fixture.read', params } };
    mutate = () => { params.nested.password = secret; request.rpc = { method: 'changed', params: { password: secret } }; };
    const result = await protocolRequest(request, runtime);
    const problem = null;
  `);
  assert.equal(out.ok, true);
  assert.equal(out.targetCalls, 1);
  assert.equal(out.evidencePresent, true);
  assert.equal(out.secretPresent, false);
});

test('AH-3 protocol payload functions, nonplain objects and hidden accessors are malformed without invocation', t => {
  const out = probe(t, `
    const values = [() => { hookCalls++; }, new Date(), Object.create({ toJSON() { hookCalls++; return { password: secret }; } }), {}];
    Object.defineProperty(values[3], 'hidden', { get() { reads++; return secret; } });
    const results = [];
    for (const value of values) results.push(await protocolRequest({ protocol: 'jsonrpc', rpc: { method: 'fixture.read', params: { nested: value } } }, runtime));
    const result = { ok: false, error: { code: results.every(item => item.error?.code === 'PROTOCOL_INPUT_INVALID') ? 'PROTOCOL_INPUT_INVALID' : 'NOT_REFUSED' } };
    const problem = null;
  `);
  assert.equal(out.code, 'PROTOCOL_INPUT_INVALID');
  assert.equal(out.reads, 0);
  assert.equal(out.hookCalls, 0);
  assert.equal(out.targetCalls, 0);
  assert.equal(out.secretPresent, false);
});

test('AH-3 credential snapshot preserves valid WebSocket outgoing sets larger than one MiB', t => {
  const out = probe(t, `
    const send = [{ content: 'x'.repeat(600000) }, { content: 'y'.repeat(600000) }];
    const result = await protocolRequest({ protocol: 'websocket', websocket: { operation: 'fixture.events',
      send, max_frame_bytes: 1048576, max_total_bytes: 8388608 } }, runtime);
    const problem = null;
  `);
  assert.equal(out.ok, true);
  assert.equal(out.targetCalls, 1);
  assert.equal(out.evidencePresent, true);
  assert.equal(out.secretPresent, false);
});

test('AH-3 credential snapshot preserves JSON-RPC payload depth and node counts within adapter bounds', t => {
  const out = probe(t, `
    let nested = true;
    for (let depth = 0; depth < 40; depth++) nested = { child: nested };
    const params = { nested, many: Array.from({ length: 25000 }, () => false) };
    const result = await protocolRequest({ protocol: 'jsonrpc', rpc: { method: 'fixture.read', params } }, runtime);
    const problem = null;
  `);
  assert.equal(out.ok, true);
  assert.equal(out.targetCalls, 1);
  assert.equal(out.evidencePresent, true);
  assert.equal(out.secretPresent, false);
});
