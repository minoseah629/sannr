import { createFixtureStack, fixtureContextFile, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync,  readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin/cli.mjs');
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'sannr-protocol-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const write = (root, file, value) => writeFileSync(join(root, file), JSON.stringify(value));
async function run(root, args, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { SANNR_HOME: join(root, 'home'), API_CONTEXT_DIR: root,
    API_USAGE_LOG: join(root, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence'), ...extra });
  try {
    const result = await exec(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return { ...result, code: 0 };
  } catch (error) { return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}
const identity = { provider: 'fixture-api', environment: 'local', protocol: 'custom-rpc',
  operation: 'lookup', endpoint: 'http://127.0.0.1:9000/rpc', contractDigest: null };

test('context CLI captures external evidence, retrieves exact scope and preserves claim provenance', async t => {
  const root = project(t);
  createFixtureStack(root);
  const evidence = `${fixtureEvidencePath()}/call.json`;
  write(root, evidence, { result: { found: true } });
  write(root, 'capture.json', { identity, basis: 'observed', source: { tool: 'fixture-client' },
    outcome: 'success', complete: true, response: { value: 'private-scalar-not-committed' },
    evidence: [{ path: evidence, locator: '/result' }] });
  const captured = await run(root, ['context', 'capture', 'capture.json']);
  assert.equal(captured.code, 0, captured.stdout + captured.stderr);
  assert.equal(JSON.parse(captured.stdout).state, 'captured');
  const stored = readFileSync(fixtureContextFile(root), 'utf8');
  assert.doesNotMatch(stored, /private-scalar-not-committed/);
  write(root, 'query.json', { provider: 'fixture-api', protocol: 'custom-rpc' });
  const queried = await run(root, ['context', 'query', 'query.json']);
  assert.equal(queried.code, 0, queried.stdout + queried.stderr);
  const operation = JSON.parse(queried.stdout).operations[0];
  assert.equal(operation.identity.protocol, 'custom-rpc');
  assert.equal(operation.observations[0].verification, 'external-claim');
  assert.equal(operation.observations[0].evidence[0].state, 'matching');
  write(root, 'query.json', { provider: 'different-api' });
  assert.deepEqual(JSON.parse((await run(root, ['context', 'query', 'query.json'])).stdout).operations, []);
});

test('context CLI migration binds a named legacy operation without changing it', async t => {
  const root = project(t), legacy = { verified_at: null, notes: ['A retained author note.'] };
  write(root, LAYOUT.context, { v: 0, api: { name: 'fixture', contract_digest: null }, operations: { 'GET /items': legacy } });
  write(root, 'bindings.json', { bindings: [{ legacy_operation: 'GET /items', identity: { ...identity, protocol: 'http', operation: 'GET /items' } }] });
  const bound = await run(root, ['context', 'migrate', 'bindings.json']);
  assert.equal(bound.code, 0, bound.stdout + bound.stderr);
  assert.equal(JSON.parse(bound.stdout).originals_preserved, true);
  assert.deepEqual(JSON.parse(readFileSync(join(root, LAYOUT.context), 'utf8')).operations['GET /items'], legacy);
});

test('protocol CLI honors explicit environment, executes GraphQL and exits nonzero for application errors', async t => {
  const root = project(t), calls = [];
  let applicationError = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(applicationError ? { errors: [{ message: 'fixture application error' }] } : { data: { state: 'ready' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  write(root, LAYOUT.environments, { v: 1, default: 'other', environments: {
    local: { baseUrl: `http://127.0.0.1:${server.address().port}` }, other: { baseUrl: 'http://127.0.0.1:1' },
  } });
  createFixtureStack(root, { environment:'other', environments:{
    local:{baseUrl:`http://127.0.0.1:${server.address().port}`},other:{baseUrl:'http://127.0.0.1:1'},
  } });
  write(root, 'request.json', { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Probe { state }' } });
  const result = await run(root, ['protocol', 'request.json', '--env', 'local'], { API_ENV: 'other' });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.environment, 'local');
  assert.equal(body.protocol.name, 'graphql');
  assert.equal(body.context_capture.state, 'captured');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.operationName, 'Probe');
  applicationError = true;
  const failed = await run(root, ['protocol', 'request.json', '--env=local']);
  assert.equal(failed.code, 1, failed.stdout + failed.stderr);
  assert.equal(JSON.parse(failed.stdout).protocol.outcome, 'error');
});

test('protocol and context CLI reject malformed input without echoing its contents', async t => {
  const root = project(t);
  writeFileSync(join(root, 'broken.json'), '{ private-payload-do-not-echo');
  for (const args of [['protocol', 'broken.json'], ['context', 'capture', 'broken.json']]) {
    const result = await run(root, args);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /JSON_INPUT_INVALID/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-payload/);
  }
  write(root, 'missing-protocol.json', { path: '/graphql', graphql: { document: '{ state }' } });
  assert.match((await run(root, ['protocol', 'missing-protocol.json'])).stderr, /PROTOCOL_REQUIRED/);
  for (const command of ['protocol', 'context']) {
    const help = await run(root, [command, '--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /docs\/protocols\.md/);
  }
});
