import { LAYOUT } from "../lib/layout.mjs";
// Suite input enters only through stdin; every prospective committed file is
// confined to a disposable project and every canary is generated in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT } from '../lib/brand.mjs';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const cases = [
  ['GraphQL variables', value => ({ protocol: 'graphql', graphql: {
    document: 'query Fixture { status }', variables: { nested: [{ password: value }] },
  } })],
  ['JSON-RPC params', value => ({ protocol: 'jsonrpc', rpc: {
    method: 'Fixture', params: [{ nested: { access_token: value } }],
  } })],
  ['gRPC body', value => ({ protocol: 'grpc', grpc: {
    proto: 'service.proto', service: 'fixture.Service', method: 'Unary', body: { nested: { 'x-service-secret': value } },
  } })],
  ['gRPC stream messages', value => ({ protocol: 'grpc', grpc: {
    proto: 'service.proto', service: 'fixture.Service', method: 'Stream', messages: [{ nested: { api_key: value } }],
  } })],
  ['WebSocket send frames', value => ({ protocol: 'websocket', websocket: {
    operation: 'Fixture', send: [{ nested: { authorization: value } }],
  } })],
  ['credential object keys stay out of refusal messages', value => ({ protocol: 'graphql', graphql: {
    document: 'query Fixture { status }', variables: { password: { [`Bearer ${value}`]: true } },
  } })],
  ['header control', value => ({ protocol: 'graphql', headers: { authorization: value },
    graphql: { document: 'query Fixture { status }' } })],
];

test('AH-3 suite save refuses credential-named protocol payloads before any committed write', async t => {
  for (const [name, request] of cases) await t.test(name, t => {
    const root = mkdtempSync(join(tmpdir(), 'ah3-protocol-suite-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const credential = randomBytes(24).toString('hex');
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !name.startsWith('API_') && !name.startsWith(`${PRODUCT.toUpperCase()}_`)));
    const child = spawnSync(process.execPath, [cli, 'suite', 'save', 'credential-boundary'], {
      cwd: root, env, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ requests: [{ path: '/fixture', expect: [{ json: 'status', exists: true }], ...request(credential) }] }),
    });
    assert.equal(child.status, 2, 'credential-named payloads must take the suite secret refusal');
    assert.equal(child.stdout, '', 'a refused suite must not report a write');
    assert.equal(JSON.parse(child.stderr).refused, 'SECRET_IN_SUITE');
    assert.equal(existsSync(join(root, LAYOUT.suites, 'credential-boundary.json')), false);
    const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [readFileSync(path, 'utf8')];
    });
    assert.equal([child.stdout, child.stderr, ...files(root)].some(text => text.includes(credential)), false,
      'the canary must remain absent from stdout stderr and all project files');
  });
});
