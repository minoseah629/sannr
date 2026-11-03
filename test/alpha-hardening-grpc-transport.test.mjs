import { LAYOUT } from "../lib/layout.mjs";
// The public client is exercised in temporary projects. The dispatch callback
// stops the old unsafe implementation before it can contact any remote host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT } from '../lib/brand.mjs';
import { BUILTIN_DEFAULTS } from '../lib/config.mjs';

const clientUrl = new URL('../lib/client.mjs', import.meta.url).href;
const adapterUrl = new URL('../lib/protocols/grpc.mjs', import.meta.url).href;
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !name.startsWith('API_') && !name.startsWith(`${PRODUCT.toUpperCase()}_`)));
const proto = 'syntax = "proto3"; package fixture; message Input {} message Output {} service Service { rpc Read(Input) returns (Output); }';

function probe(t, { origin, auth = 'bearer:FIXTURE_GRPC_AUTH' }) {
  const root = mkdtempSync(join(tmpdir(), 'ah3-grpc-transport-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const credential = randomBytes(24).toString('hex');
  writeFileSync(join(root, 'service.proto'), proto);
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'fixture', environments: {
    fixture: { baseUrl: origin, production: false, ...(auth ? { auth } : {}) },
  } }));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { apiRequest } = await import(${JSON.stringify(clientUrl)});
    let dispatches = 0;
    const envelope = await apiRequest({ protocol: 'grpc', path: '',
      grpc: { proto: 'service.proto', service: 'fixture.Service', method: 'Read', body: {} },
      _onAttempt() { dispatches += 1; throw new Error('Fixture stops before wire dispatch.'); }
    });
    process.stdout.write(JSON.stringify({ envelope, dispatches }));
  `], { cwd: root, encoding: 'utf8', timeout: 10000, env: { ...cleanEnvironment(),
    API_CONFIG: join(root, LAYOUT.environments), API_ENV: 'fixture',
    API_TIMEOUT_MS: '1000', API_EVIDENCE: join(root, 'evidence'),
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_CONTEXT_DIR: root,
    FIXTURE_GRPC_AUTH: credential,
  } });
  assert.equal(child.status, 0, 'the isolated protocol probe must complete');
  assert.equal(child.stderr, '', 'the protocol probe must not log errors or transport details');
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [readFileSync(path, 'utf8')];
  });
  assert.equal([child.stdout, child.stderr, ...files(root)].some(text => text.includes(credential)), false,
    'credential values must remain absent from output and every project file');
  return JSON.parse(child.stdout);
}

test('AH-3 plaintext remote gRPC refuses configured bearer and custom-header credentials before dispatch', async t => {
  for (const options of [
    { origin: 'http://fixture.example:4317' },
    { origin: 'http://fixture.example:4317', auth: 'header:X-Tenant-Identity:FIXTURE_GRPC_AUTH' },
    { origin: 'http://127.loopback.example:4317' },
    { origin: 'http://localhost.example:4317' },
    { origin: 'http://0.0.0.0:4317' },
    { origin: 'http://host.docker.internal:4317' },
  ]) await t.test(`${new URL(options.origin).hostname} ${options.auth ? 'custom header' : 'bearer'}`, t => {
    const { envelope, dispatches } = probe(t, options);
    assert.equal(envelope.error?.code, 'GRPC_INSECURE_CREDENTIALS');
    assert.equal(envelope.ok, false);
    assert.equal(envelope.protocol?.complete, false);
    assert.equal(envelope.protocol?.sent, 0);
    assert.equal(envelope.protocol?.attempts, 0);
    assert.equal(dispatches, 0);
  });
});

test('AH-3 gRPC transport guard preserves loopback TLS and unauthenticated dispatch paths', t => {
  for (const options of [
    { origin: 'http://127.0.0.1:4317' },
    { origin: 'http://127.0.0.2:4317' },
    { origin: 'http://localhost:4317' },
    { origin: 'http://[::1]:4317' },
    { origin: 'https://fixture.example:4317' },
    { origin: 'http://fixture.example:4317', auth: null },
  ]) {
    const { envelope, dispatches } = probe(t, options);
    assert.equal(envelope.error?.code, 'GRPC_TRANSPORT_ERROR', 'the fixture must reach its controlled pre-wire stop');
    assert.equal(envelope.protocol?.attempts, 1);
    assert.equal(dispatches, 1);
  }
});

test('AH-3 gRPC metadata accessors cannot promote thrown codes or messages', t => {
  const root = mkdtempSync(join(tmpdir(), 'ah3-grpc-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'service.proto'), proto);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { prepareGrpc } = await import(${JSON.stringify(adapterUrl)});
    const { randomBytes } = await import('node:crypto');
    const canary = randomBytes(24).toString('hex');
    const plan = await prepareGrpc({ grpc: { proto: 'service.proto', service: 'fixture.Service', method: 'Read' } });
    const outcomes = [];
    for (const sourceCode of ['GRPC_METADATA_INVALID', canary]) {
      const headers = Object.defineProperty({}, 'authorization', { enumerable: true,
        get() { throw Object.assign(new Error(canary), { code: sourceCode }); } });
      let attempts = 0;
      const result = await plan.execute({ url: new URL('http://127.0.0.1:4317'), headers,
        onAttempt() { attempts += 1; throw new Error('Fixture stops before wire dispatch.'); } });
      outcomes.push({ curated: result.error?.code === 'GRPC_METADATA_INVALID',
        private: !JSON.stringify(result).includes(canary), attempts });
    }
    process.stdout.write(JSON.stringify(outcomes));
  `], { cwd: root, env: cleanEnvironment(), encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, 'the metadata probe must return a bounded result');
  assert.equal(child.stderr, '');
  for (const outcome of JSON.parse(child.stdout)) {
    assert.equal(outcome.curated, true, 'foreign error codes must not escape the metadata guard');
    assert.equal(outcome.private, true, 'foreign error messages must not escape the metadata guard');
    assert.equal(outcome.attempts, 0);
  }
});

test('AH-3 declared read-only gRPC production streams require no write flag', t => {
  const root = mkdtempSync(join(tmpdir(), 'ah3-grpc-stream-effect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'service.proto'), proto.replace('rpc Read(Input) returns (Output)', 'rpc Watch(Input) returns (stream Output)'));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const grpc = await import(${JSON.stringify(import.meta.resolve('@grpc/grpc-js'))});
    const loader = await import(${JSON.stringify(import.meta.resolve('@grpc/proto-loader'))});
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(${JSON.stringify(LAYOUT.config)}, { recursive: true });
    const server = new grpc.Server();
    let calls = 0;
    server.addService(loader.loadSync('service.proto')['fixture.Service'], {
      Watch(call) {
        calls += 1;
        // Reproduce a peer that becomes ready beyond the old five-second
        // fixture budget; this specimen measures the read boundary, not speed.
        setTimeout(() => { if (!call.cancelled) { call.write({}); call.end(); } }, 5100);
      }
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
      (error, port) => error ? reject(error) : resolve(port)));
    writeFileSync(${JSON.stringify(LAYOUT.environments)}, JSON.stringify({ v: 1, default: 'fixture', environments: {
      fixture: { baseUrl: 'http://127.0.0.1:' + port, production: true }
    } }));
    try {
      const { apiRequest } = await import(${JSON.stringify(clientUrl)});
      // This fixture checks the production effect boundary, not connection
      // speed. The request and the enclosing child both remain bounded.
      const request = { protocol: 'grpc', path: '', timeout_ms: ${BUILTIN_DEFAULTS.timeoutMs},
        grpc: { proto: 'service.proto', service: 'fixture.Service', method: 'Watch' },
        expect: [{ json: '0', exists: true }] };
      const unknown = await apiRequest(request);
      const read = await apiRequest({ ...request, grpc: { ...request.grpc, effect: 'read' } });
      const invalid = await apiRequest({ ...request, grpc: { ...request.grpc, effect: 'trusted' } });
      process.stdout.write(JSON.stringify({ unknown, read, invalid, calls }));
    } finally { server.forceShutdown(); }
  `], { cwd: root, encoding: 'utf8', timeout: 4 * BUILTIN_DEFAULTS.timeoutMs, env: { ...cleanEnvironment(),
    API_CONFIG: join(root, LAYOUT.environments), API_ENV: 'fixture', API_ALLOW_PRODUCTION_WRITES: '0',
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'), API_CONTEXT_DIR: root,
  } });
  assert.equal(child.status, 0, 'the isolated production stream fixture must complete');
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.unknown.error?.code, 'PRODUCTION_WRITE_REFUSED');
  assert.equal(result.read.ok, true, 'a declared read stream must cross the read boundary');
  assert.equal(result.read.protocol.effect, 'read');
  assert.equal(result.read.protocol.declaration.effectBasis, 'caller-declared-unverified');
  assert.equal(result.read.protocol.declaration.responseStream, true);
  assert.equal(result.read.protocol.complete, true);
  assert.equal(result.read.assertions.passed, 1);
  assert.equal(result.read.assertions.failed, 0);
  assert.equal(result.invalid.error?.code, 'GRPC_REQUEST_INVALID');
  assert.equal(result.calls, 1);
});
