import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, rmSync, readFileSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureOperationContext as captureRaw } from '../lib/operation-context.mjs';
import { loadHttpContract } from '../lib/http-operation-context.mjs';

import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
const captureOperationContext = (root, ...args) => inFixtureStack(root, () => captureRaw(root, ...args));

const runFile = promisify(execFile);
const clientUrl = new URL('../lib/client.mjs', import.meta.url).href;
async function fixture(t, values) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'response-change-fixture-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const server = createServer((request, response) => {
    calls.push({ url: request.url, method: request.method });
    request.resume();
    response.setHeader('content-type', 'application/json');
    const body = { counts: { deployment_events: values[Math.min(calls.length - 1, values.length - 1)] } };
    response.end(JSON.stringify(request.url === '/graphql' ? { data: { health: body } } : body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const file = join(root, 'openapi.json');
  writeFileSync(file, JSON.stringify({ openapi: '3.0.0', info: { title: 'Health', version: '1' }, paths: { '/health': { get: {} } } }));
  createFixtureStack(root, { baseUrl: origin, contract: 'openapi.json' });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_|SANNR_)/.test(key))),
    API_CONTEXT_DIR: root, API_EVIDENCE: join(root, fixtureEvidencePath()),
    SANNR_HOME: join(root, 'home'), API_USAGE_LOG: '', API_FRICTION_OFF: '1' };
  const run = async (requests, budget = 800) => {
    const script = `const {apiRequest,tokens}=await import(${JSON.stringify(clientUrl)});const results=[];
      for(const request of ${JSON.stringify(requests)}){const result=await apiRequest(request);results.push({result,tokens:tokens(JSON.stringify(result))});}
      process.stdout.write(JSON.stringify(results));`;
    const child = await runFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, env: { ...env, API_BUDGET: String(budget) }, encoding: 'utf8', timeout: 20000,
    });
    return JSON.parse(child.stdout);
  };
  const identity = { stack: 'fixture', provider: origin, environment: 'local', protocol: 'http', operation: 'GET /health',
    endpoint: `${origin}/health`, contractDigest: loadHttpContract(file).digest };
  return { root, origin, identity, calls, run };
}
const get = { path: '/health', expect: [{ status: 200 }] };

test('real HTTP numeric → string → numeric replies expose linked change notices at the default budget', async t => {
  const f = await fixture(t, [41, 'string-value-private', 42, 43]);
  const responses = await f.run([get, get, get, get]);
  assert.equal(f.calls.length, 4);
  for (const { result, tokens } of responses) {
    assert.equal(result.ok, true);
    assert.equal(result.assertions.passed, 1);
    assert.equal(result.data, null);
    assert.ok(tokens <= 800, `${tokens} > budget`);
  }
  assert.equal(responses[0].result.context_capture.change_notice, undefined);
  assert.equal(responses[3].result.context_capture.change_notice, undefined);
  for (const index of [1, 2]) {
    const notice = responses[index].result.context_capture.change_notice;
    assert.equal(notice.code, 'RESPONSE_STRUCTURE_CHANGED');
    assert.equal(notice.previous.observation_id, responses[index - 1].result.context_capture.observation_id);
    assert.equal(notice.current.observation_id, responses[index].result.context_capture.observation_id);
    assert.equal(notice.changes[0].path, '/counts/deployment_events');
    assert.ok(notice.previous.evidence.path);
    assert.ok(notice.current.evidence.path);
    assert.doesNotMatch(JSON.stringify(notice), /string-value-private/);
  }
  assert.doesNotMatch(readFileSync(fixtureContextFile(f.root), 'utf8'), /string-value-private/);
});

test('a real new HTTP response detects a frozen old-format client observation without rewriting it', async t => {
  const f = await fixture(t, [42]);
  writeFileSync(join(f.root, fixtureEvidencePath(), 'old-evidence.json'), '{"status":200}');
  const old = captureOperationContext(f.root, { identity: f.identity, source: { tool: 'api_request:http' },
    complete: true, outcome: 'success', request: { params: {}, body: null },
    response: { counts: { deployment_events: 'old-string-private' } },
    notes: ['HTTP response status 200.'], evidence: [{ path: `${fixtureEvidencePath()}/old-evidence.json` }] }, { internal: true });
  const before = JSON.parse(readFileSync(fixtureContextFile(f.root), 'utf8')).api_context.operations[old.operation_id].observations[0];
  const [{ result }] = await f.run([get]);
  assert.equal(result.context_capture.change_notice.previous.status_basis, 'legacy_note');
  assert.equal(result.context_capture.change_notice.previous.observation_id, old.observation_id);
  const after = JSON.parse(readFileSync(fixtureContextFile(f.root), 'utf8')).api_context.operations[old.operation_id].observations[0];
  assert.deepEqual(after, before);
});

test('HTTP notice compression preserves the signal and names details withheld under smaller budgets', async t => {
  for (const budget of [400, 250, 150]) {
    const f = await fixture(t, [41, 'private-string']);
    const responses = await f.run([get, get], budget);
    const { result, tokens } = responses[1];
    assert.equal(result.ok, true);
    assert.equal(result.evidence.startsWith('run-'), true);
    assert.equal(result.context_capture.change_notice.code, 'RESPONSE_STRUCTURE_CHANGED');
    assert.match(result.context_capture.change_notice.next, /api_context_record/);
    assert.equal(result.context_capture.change_notice.details_omitted, true);
    assert.ok(tokens <= budget || result.budget_min === tokens,
      `budget ${budget}, received ${tokens}, minimum ${result.budget_min}`);
  }
});

test('real GraphQL replies use the generic advisory and retain its signal through protocol budgeting', async t => {
  const f = await fixture(t, [41, 'private-string']);
  const request = { protocol: 'graphql', path: '/graphql', graphql: { document: 'query Health { health { counts { deployment_events } } }' }, expect: [{ status: 200 }] };
  const responses = await f.run([request, request], 800);
  assert.equal(responses[0].result.context_capture.change_notice, undefined);
  const notice = responses[1].result.context_capture.change_notice;
  assert.equal(notice.code, 'RESPONSE_STRUCTURE_CHANGED');
  assert.match(notice.next, /api_context_record/);
  assert.ok(responses[1].tokens <= 800 || responses[1].result.budget_min);
  assert.doesNotMatch(JSON.stringify(notice), /private-string/);
});
