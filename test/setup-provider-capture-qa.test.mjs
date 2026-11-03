import { MCP_SERVER_KEY } from '../lib/brand.mjs';
import { LAYOUT } from "../lib/layout.mjs";
// Independent regression for the fresh-host pilot's CLI/MCP contract split.
// These APIs and repositories exist only inside this disposable fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const runFile = promisify(execFile);
const cliPath = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const clientUrl = new URL('../lib/client.mjs', import.meta.url).href;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (root, path, value) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), JSON.stringify(value));
};
const digest = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const contract = title => ({ openapi: '3.0.0', info: { title, version: '1' },
  paths: { '/health': { get: { responses: { 200: { description: 'OK' } } } } } });

async function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'sannr-setup-provider-qa-')));
  const root = join(parent, 'consumer with spaces'); mkdirSync(root);
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  await runFile('git', ['init', '-q'], { cwd: root });
  const calls = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, secret_value: 'fixture-payload-private' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  save(root, 'openapi.json', contract('Primary'));
  save(root, 'contracts/peer.json', contract('Peer'));
  const config = { v: 1, default: 'local', environments: {
    local: { baseUrl: 'http://127.0.0.1:1' },
    staging: { baseUrl: origin, headers: { 'X-Fixture': 'keep' }, hosts: {
      peer: { baseUrl: `${origin}/peer`, contract: './contracts/peer.json', contractPathPrefix: '/peer' },
    } },
  } };
  save(root, LAYOUT.environments, config);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { API_ENV: 'staging', SANNR_HOME: join(parent, 'registry'),
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'),
    API_FRICTION_OFF: '1', API_CONTEXT_OFF: '0' });
  const cli = async (...args) => {
    try {
      const r = await runFile(process.execPath, [cliPath, ...args], { cwd: root, env,
        encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      return { code: 0, ...r };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const checked = async (...args) => {
    const r = await cli(...args);
    assert.equal(r.code, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  return { root, origin, config, env, calls, cli, checked };
}

test('QA: discovered primary binding survives fresh CLI suite and agrees with the generated MCP environment', async t => {
  const f = await fixture(t);
  const first = await f.checked('start', '--json');
  assert.equal(first.requests_executed, 0);
  assert.equal(f.calls.length, 0, 'Setup must not contact either fixture provider.');
  const persisted = json(join(f.root, LAYOUT.environments));
  assert.equal(resolve(f.root, persisted.environments.staging.contract), join(f.root, 'openapi.json'));
  assert.deepEqual(persisted.environments.local, f.config.environments.local);
  assert.deepEqual(persisted.environments.staging.hosts, f.config.environments.staging.hosts);
  assert.deepEqual(persisted.environments.staging.headers, f.config.environments.staging.headers);
  const second = await f.checked('start', '--json');
  assert.equal(second.setup.host.binding_id, first.setup.host.binding_id,
    'Persisting discovery must not immediately stale the generated setup marker.');
  assert.equal(f.calls.length, 0);

  // R7: onboarding can still inspect/bind a legacy repo; shared capture begins
  // only after the real offline migration creates explicit provider stacks.
  const expectedContracts = [[f.origin, digest(join(f.root, 'openapi.json'))],
    [`${f.origin}/peer`, digest(join(f.root, 'contracts/peer.json'))]];
  await f.checked('migrate', '--name', 'primary', '--json');
  const connected = await f.checked('connect', '--json');

  save(f.root, `${LAYOUT.suites}/health.json`, { v: 2, name: 'health', requests: [
    { id: 'primary', stack: 'primary', path: '/health', expect: [{ status: 200 }, { json: 'ok', equals: true }] },
    { id: 'peer', stack: 'peer', path: '/health', expect: [{ status: 200 }, { json: 'ok', equals: true }] },
  ] });
  await f.checked('suite', 'run', 'health', '--json');
  assert.deepEqual(f.calls.map(call => call.path), ['/health', '/peer/health']);
  const stackContext = name => join(f.root, LAYOUT.collection, name, 'sannr.json');
  const ops = ['primary','peer'].flatMap(name => Object.values(json(stackContext(name)).api_context?.operations ?? {}));
  assert.equal(ops.length, 2, 'Both CLI suite responses need provider-scoped shared observations.');
  for (const [provider, expectedDigest] of expectedContracts) {
    const entry = ops.find(op => op.identity.provider === provider);
    assert.ok(entry, `Missing ${provider}`);
    assert.equal(entry.identity.environment, 'staging');
    assert.equal(entry.identity.operation, 'GET /health');
    assert.equal(entry.identity.contractDigest, expectedDigest);
    assert.equal(entry.observations.length, 1);
    assert.equal(entry.observations[0].evidence.length, 1);
  }
  for (const name of ['primary','peer']) assert.doesNotMatch(readFileSync(stackContext(name), 'utf8'), /fixture-payload-private/);
  const binding = json(join(f.root, '.mcp.json')).mcpServers[MCP_SERVER_KEY];
  assert.equal(binding.env.API_SETUP_BINDING, connected.setup.host.binding_id);
  for (const pin of ['API_ENV','API_CONTRACT','API_CONFIG']) assert.equal(binding.env[pin], undefined, `${pin} must not freeze a new stack registration`);
  const script = `const {apiRequest}=await import(${JSON.stringify(clientUrl)});process.stdout.write(JSON.stringify(await apiRequest({stack:'primary',path:'/health'})));`;
  const mcpEnvRequest = await runFile(process.execPath, ['--input-type=module', '-e', script], {
    cwd: f.root, env: { ...f.env, ...binding.env }, encoding: 'utf8', timeout: 20000,
  });
  const receipt = JSON.parse(mcpEnvRequest.stdout).context_capture;
  assert.equal(receipt.state, 'captured');
  assert.deepEqual(receipt.identity, ops.find(op => op.identity.provider === f.origin).identity);
});

test('QA: ambiguous discovery does not silently bind the first contract; explicit selection resolves it offline', async t => {
  const f = await fixture(t);
  save(f.root, 'swagger.json', contract('Alternative primary'));
  const ambiguous = await f.cli('start', '--json');
  assert.equal(f.calls.length, 0);
  const before = json(join(f.root, LAYOUT.environments));
  assert.equal(before.environments.staging.contract, undefined,
    'Multiple primary contract candidates must not become an arbitrary persistent binding.');
  assert.match(ambiguous.stdout + ambiguous.stderr, /ambig|multiple|contract/i);
  const resolved = await f.checked('start', '--contract', 'swagger.json', '--json');
  assert.equal(resolved.requests_executed, 0);
  assert.equal(f.calls.length, 0);
  const after = json(join(f.root, LAYOUT.environments));
  assert.equal(resolve(f.root, after.environments.staging.contract), join(f.root, 'swagger.json'));
  assert.deepEqual(after.environments.local, f.config.environments.local);
  const binding = json(join(f.root, '.mcp.json')).mcpServers[MCP_SERVER_KEY];
  assert.equal(binding.env.API_CONTRACT, join(f.root, 'swagger.json'));
  assert.equal(binding.env.API_SETUP_BINDING, resolved.setup.host.binding_id);
});
