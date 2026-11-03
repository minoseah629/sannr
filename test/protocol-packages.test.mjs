import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { protocolRequest } from '../lib/protocol-client.mjs';
import { PRODUCT } from '../lib/brand.mjs';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const versions = manifest.optionalDependencies ?? manifest.dependencies;
const packageNames = ['graphql', 'ws', '@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs'];
const runtime = overrides => ({ root: tmpdir(), timeoutMs: 1000, budget: 10000, contextEnabled: false,
  errorEnvelope: ({ error, code, message, next, ...rest }) => ({ ...rest, ok: false,
    error: error ?? { code, message, ...(next ? { next } : {}) } }), ...overrides });

for (const missing of packageNames) test(`DEP-1 missing optional package ${missing} refuses by name and exact install hint before dispatch`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-package-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, 'lib'), join(root, 'lib'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  // For a gRPC omission, the other direct packages resolve without executing.
  // These deliberately unverified peer stubs prove missing-package preflight
  // happens before integrity validation or third-party code is evaluated.
  if (missing.startsWith('@grpc/') || missing === 'protobufjs') {
    for (const name of packageNames.slice(2).filter(name => name !== missing)) {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: versions[name], type: 'module', main: 'index.mjs' }));
      writeFileSync(join(dir, 'index.mjs'), 'throw new Error("Peer stub must not execute.");\nexport default {};\n');
    }
  }
  const protocol = missing === 'graphql' ? 'graphql' : missing === 'ws' ? 'websocket' : 'grpc';
  const script = `
    const { protocolRequest } = await import(${JSON.stringify(pathToFileURL(join(root, 'lib/protocol-client.mjs')).href)});
    let dispatches = 0;
    const result = await protocolRequest({ protocol: ${JSON.stringify(protocol)}, graphql: ${protocol === 'graphql' ? '{ document: "query Probe { ready }" }' : 'undefined'} }, {
      root: process.cwd(), timeoutMs: 1000, budget: 10000,
      prepareTarget: () => { dispatches++; throw new Error('Must not dispatch.'); },
      errorEnvelope: ({ error, code, message, next, ...rest }) => ({ ...rest, ok: false,
        error: error ?? { code, message, ...(next ? { next } : {}) } }),
    });
    process.stdout.write(JSON.stringify({ result, dispatches }));
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeout: 10000 });
  const { result, dispatches } = JSON.parse(stdout);
  assert.equal(result.error.code, 'PROTOCOL_PACKAGE_MISSING');
  assert.equal(result.error.package, missing);
  assert.equal(result.error.install, `npm install --save-exact --ignore-scripts ${missing}@${versions[missing]}`);
  assert.ok(result.error.message.includes(missing));
  assert.ok(result.error.next.includes(result.error.install));
  assert.equal(result.mode, 'refused');
  assert.equal(dispatches, 0);
  assert.equal(JSON.stringify(result).includes(root), false, 'workstation paths stay out of public errors');
});

const request = { protocol: 'jsonrpc', rpc: { method: 'probe' } };
for (const code of ['ERR_MODULE_NOT_FOUND', 'GRAPHQL_PRIVATE_FIXTURE_VALUE', 'private-fixture-code'])
  test(`DEP-1 preparation public codes reject unlisted ${code}`, async () => {
    const result = await protocolRequest(request, runtime({ prepareTarget() {
      throw Object.assign(new Error('private-fixture-message'), { code });
    } }));
    assert.equal(result.error.code, 'PROTOCOL_INPUT_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-message|GRAPHQL_PRIVATE_FIXTURE_VALUE|ERR_MODULE_NOT_FOUND|private-fixture-code/);
  });

test('DEP-1 protocol evidence and returned transport codes reject unlisted error codes', async () => {
  const result = await protocolRequest(request, runtime({
    prepareTarget: async () => ({ provider: 'fixture', environment: 'local', url: new URL('http://127.0.0.1/rpc'), headers: {}, secrets: [] }),
    withSlot: async () => ({ status: null, body: null, ok: false, outcome: 'error', complete: false, sent: 0, received: 0,
      error: { code: 'private-fixture-code', message: 'A fixture failed.' } }),
    scrub: value => value,
    writeEvidence() { throw Object.assign(new Error('private-fixture-message'), { code: 'private-fixture-code' }); },
  }));
  assert.equal(result.error.code, 'PROTOCOL_TRANSPORT_ERROR');
  assert.equal(result.evidence_error.code, 'PROTOCOL_EVIDENCE_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-code|private-fixture-message/);
});

for (const throwing of [false, true]) test(`DEP-1 preparation snapshots a ${throwing ? 'throwing' : 'changing'} error code getter safely`, async () => {
  let reads = 0;
  const error = new Error('A fixture failed.');
  Object.defineProperty(error, 'code', { get() {
    reads++;
    if (throwing) throw new Error('private-fixture-code');
    return reads === 1 ? 'GRAPHQL_DOCUMENT_REQUIRED' : 'private-fixture-code';
  } });
  const result = await protocolRequest(request, runtime({ prepareTarget() { throw error; } }));
  assert.equal(result.error.code, throwing ? 'PROTOCOL_INPUT_INVALID' : 'GRAPHQL_DOCUMENT_REQUIRED');
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-code/);
});

for (const shape of ['unknown', 'changing', 'throwing']) test(`DEP-1 target refusals canonicalize ${shape} public error codes`, async () => {
  let reads = 0;
  const error = { message: 'private-fixture-message' };
  Object.defineProperty(error, 'code', { enumerable: true, get() {
    reads++;
    if (shape === 'throwing') throw new Error('private-fixture-code');
    return shape === 'changing' && reads === 1 ? 'AUTH_ENV_MISSING' : 'private-fixture-code';
  } });
  const result = await protocolRequest(request, runtime({ prepareTarget: async () => ({ error }) }));
  assert.equal(result.error.code, shape === 'changing' ? 'AUTH_ENV_MISSING' : 'PROTOCOL_INPUT_INVALID');
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-code/);
  assert.equal(reads, 1);
  if (shape !== 'changing') assert.doesNotMatch(JSON.stringify(result), /private-fixture-message/);
});

test('DEP-1 target refusal allowlist preserves policy and auth remediation', async () => {
  for (const code of ['AUTH_ENV_MISSING', 'PRODUCTION_WRITE_REFUSED']) {
    const error = { code, kind: 'policy', message: 'A fixture request was refused.', next: 'Repair the fixture configuration.', details: { field: 'fixture' } };
    const result = await protocolRequest(request, runtime({ prepareTarget: async () => ({ error }) }));
    assert.deepEqual(result.error, error);
  }
});

test('DEP-1 a returned transport code getter cannot change during envelope serialization', async () => {
  let reads = 0;
  const error = { message: 'A fixture failed.' };
  Object.defineProperty(error, 'code', { enumerable: true, get() {
    return ++reads <= 3 ? 'GRPC_STATUS_ERROR' : 'private-fixture-code';
  } });
  const result = await protocolRequest(request, runtime({
    prepareTarget: async () => ({ provider: 'fixture', environment: 'local', url: new URL('http://127.0.0.1/rpc'), headers: {}, secrets: [] }),
    withSlot: async () => ({ status: null, body: null, ok: false, outcome: 'error', complete: false, sent: 0, received: 0, error }),
    scrub: value => JSON.parse(JSON.stringify(value)),
    writeEvidence: () => ({ id: 'fixture', path: join(tmpdir(), 'fixture-evidence.json') }),
  }));
  assert.equal(result.error.code, 'GRPC_STATUS_ERROR');
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-code/);
});

for (const recovery of [true, false]) test(`DEP-1 ${recovery ? 'installing a missing adapter recovers' : 'changed adapter bytes refuse'} in the same process`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-package-recheck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(ROOT, 'lib'), join(root, 'lib'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(root, 'package.json'));
  if (!recovery) cpSync(join(ROOT, 'node_modules/graphql'), join(root, 'node_modules/graphql'), { recursive: true });
  const script = `
    import { appendFileSync, cpSync } from 'node:fs';
    const { protocolRequest } = await import(${JSON.stringify(pathToFileURL(join(root, 'lib/protocol-client.mjs')).href)});
    const runtime = {
      root: process.cwd(), timeoutMs: 1000, budget: 10000, contextEnabled: false,
      errorEnvelope: ({ error, code, message, next, ...rest }) => ({ ...rest, ok: false, error: error ?? { code, message, ...(next ? { next } : {}) } }),
      prepareTarget: async () => ({ provider: 'fixture', environment: 'local', url: new URL('http://127.0.0.1/graphql'), headers: {}, secrets: [] }),
      withSlot: async () => ({ status: 200, body: null, ok: true, outcome: 'success', complete: true, sent: 0, received: 0 }),
      scrub: value => value, writeEvidence: () => ({ id: 'fixture', path: process.cwd() + '/private.json' }),
    };
    const request = { protocol: 'graphql', graphql: { document: 'query Probe { ready }' } };
    const first = await protocolRequest(request, runtime);
    ${recovery
      ? `cpSync(${JSON.stringify(join(ROOT, 'node_modules/graphql'))}, 'node_modules/graphql', { recursive: true });`
      : "appendFileSync('node_modules/graphql/package.json', '\\n');"}
    const second = await protocolRequest(request, runtime);
    process.stdout.write(JSON.stringify({ first, second }));
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: root, timeout: 10000 });
  const { first, second } = JSON.parse(stdout);
  if (recovery) {
    assert.equal(first.error.code, 'PROTOCOL_PACKAGE_MISSING');
    assert.equal(second.ok, true, 'installing the named exact package must allow the next request without restarting');
  } else {
    assert.equal(first.ok, true);
    assert.equal(second.error?.code, 'PROTOCOL_PACKAGE_INTEGRITY');
    assert.equal(second.mode, 'refused');
    assert.match(second.error.next, /npm ci --ignore-scripts/);
    assert.doesNotMatch(second.error.message, /adapter input|schema/);
  }
});

test('DEP-1 each public protocol request verifies each pinned package file once before dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-package-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('API_') || key.startsWith(`${PRODUCT.toUpperCase()}_`)) delete env[key];
  Object.assign(env, { API_BASE_URL: 'http://127.0.0.1:8000', API_CONTEXT_DIR: root,
    API_CONTEXT_OFF: '1', API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl') });
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { resolve } from 'node:path';
    import { fileURLToPath } from 'node:url';
    const pinned = new Map(${JSON.stringify(['graphql', 'ws'].map(name => [join(ROOT, 'node_modules', name, 'LICENSE'), name]))});
    let counts = { graphql: 0, ws: 0 };
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
      const file = path instanceof URL ? fileURLToPath(path) : typeof path === 'string' ? resolve(path) : null;
      const name = pinned.get(file);
      if (name) counts[name]++;
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const { apiRequest } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'lib/client.mjs')).href)});
    const outcomes = [];
    for (let call = 0; call < 2; call++) {
      counts = { graphql: 0, ws: 0 };
      const result = await apiRequest({ protocol: 'graphql', path: 'http://127.0.0.1:8001/graphql',
        graphql: { document: 'subscription Probe { ready }' } });
      outcomes.push({ code: result.error?.code, counts });
    }
    process.stdout.write(JSON.stringify(outcomes));
  `;
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, timeout: 20000 });
  const outcomes = JSON.parse(stdout);
  for (const { code, counts } of outcomes) {
    assert.equal(code, 'ORIGIN_NOT_CONFIGURED', 'the public request must finish preparation and refuse before dispatch');
    assert.deepEqual(counts, { graphql: 1, ws: 1 }, 'hash verification must not repeat package file reads within one request');
  }
});
