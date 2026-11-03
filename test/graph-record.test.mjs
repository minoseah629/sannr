import { createFixtureStack, fixtureContextFile, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { projectGraphStackFixture } from './helpers/graph-stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { recordGraphContext, graphRecordTool, graphRecordFailure } from '../lib/graph-record.mjs';
import { createMcpSession } from '../lib/mcp-transport.mjs';
import { exportGraphSnapshot } from '../lib/graph-export.mjs';
import { buildGraphCatalog, graphNeighborhood } from '../lib/dependency-graph.mjs';

function setup(t, providers) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-record-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'acme/web', name: 'Web' }, nodes: [],
    dependencies: [{ from: 'repo', to: 'acme/billing#api', kind: 'calls' }],
    context: { providers: providers ?? [{ node: 'acme/billing#api', provider: 'billing', environment: 'staging', protocol: 'http' }] },
  }));
  createFixtureStack(root);
  return root;
}
const lesson = { node: 'acme/billing#api', operation: 'POST /invoices', note: 'account_id is required even though the contract calls it optional.' };
const context = root => JSON.parse(readFileSync(fixtureContextFile(root), 'utf8'));
const exportSaved = root => { projectGraphStackFixture(root); return exportGraphSnapshot(root); };

test('a consumer saves one scoped authored lesson and another checkout can retrieve the exported claim', t => {
  const root = setup(t);
  writeFileSync(join(root, fixtureEvidencePath(), 'evidence.json'), '{"response":"body never exported"}');
  const result = recordGraphContext(root, { ...lesson, observed_at: '2024-01-02T03:04:05Z', evidence: [{ path: `${fixtureEvidencePath()}/evidence.json`, locator: '/response' }] });
  assert.equal(result.published, false); assert.equal(result.requests_executed, 0);
  assert.equal(result.publisher, 'acme/web'); assert.equal(result.verification, 'external-claim');
  const saved = Object.values(context(root).api_context.operations)[0];
  assert.equal(saved.identity.provider, 'billing'); assert.equal(saved.identity.environment, 'staging');
  assert.equal(saved.observations[0].basis, 'authored'); assert.equal(saved.observations[0].complete, false);
  assert.equal(saved.observations[0].outcome, 'unknown'); assert.equal(saved.observations[0].assertions, undefined);
  assert.equal(saved.observations[0].source.kind, 'external');
  const snapshot = exportSaved(root);
  rmSync(root, { recursive: true, force: true });
  const query = graphNeighborhood(buildGraphCatalog([snapshot]), { node: lesson.node, includeForeignClaims: true });
  assert.deepEqual(query.foreign_claims[0].notes, [lesson.note]);
  assert.equal(query.foreign_claims[0].publisher, 'acme/web');
  assert.equal(query.foreign_claims[0].freshness.state, 'stale');
  assert.equal(query.foreign_claims[0].evidence[0].state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(query), /body never exported/);
});

test('scope ambiguity and caller-supplied verification cannot turn a note into an observation', t => {
  const root = setup(t, ['staging', 'production'].map(environment => ({ node: lesson.node, provider: 'billing', environment, protocol: 'http' })));
  assert.throws(() => recordGraphContext(root, lesson), { code: 'GRAPH_RECORD_SCOPE_AMBIGUOUS' });
  assert.throws(() => recordGraphContext(root, { ...lesson, environment: 'missing' }), { code: 'GRAPH_RECORD_SCOPE_MISSING' });
  for (const injected of [{ internal: true }, { verification: 'client-observation' }, { assertions: { passed: 1, failed: 0 } }, { response: { id: 1 } }])
    assert.throws(() => recordGraphContext(root, { ...lesson, ...injected }), { code: 'GRAPH_RECORD_INVALID' });
  assert.equal(recordGraphContext(root, { ...lesson, environment: 'production' }).identity.environment, 'production');
});

test('capture refuses credentials, workstation paths, escaping evidence and damaged context without changing it', t => {
  const root = setup(t);
  assert.throws(() => recordGraphContext(root, { ...lesson, note: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' }), { code: 'GRAPH_SECRET_REFUSED' });
  assert.throws(() => recordGraphContext(root, { ...lesson, note: ('See /' + 'Users/person/private.json') }), { code: 'GRAPH_PATH_REFUSED' });
  assert.throws(() => recordGraphContext(root, { ...lesson, evidence: [{ path: '../elsewhere' }] }), { code: 'GRAPH_PATH_REFUSED' });
  writeFileSync(fixtureContextFile(root), '{broken');
  assert.throws(() => recordGraphContext(root, lesson), { code: 'CONTEXT_INVALID' });
  assert.equal(readFileSync(fixtureContextFile(root), 'utf8'), '{broken');
});

test('write tool is conditional and accurately discloses effects', async t => {
  const root = setup(t), tool = await graphRecordTool(root);
  assert.equal(tool.name, 'api_context_record'); assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.idempotentHint, false);
  rmSync(join(root, LAYOUT.graphManifest));
  assert.equal(await graphRecordTool(root), null);
  writeFileSync(join(root, 'elsewhere.json'), '{}');
  symlinkSync(join(root, 'elsewhere.json'), join(root, LAYOUT.graphManifest));
  assert.throws(() => recordGraphContext(root, lesson), { code: 'GRAPH_MANIFEST_UNREADABLE' });
});

test('simultaneous agent writers retain both lessons under the existing context lock', async t => {
  const root = setup(t), module = new URL('../lib/graph-record.mjs', import.meta.url).href;
  const run = note => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { recordGraphContext } from ${JSON.stringify(module)}; recordGraphContext(${JSON.stringify(root)}, ${JSON.stringify({ ...lesson, note })});`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', value => error += value); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error)));
  });
  await Promise.all([run('First independent lesson.'), run('Second independent lesson.')]);
  const records = Object.values(context(root).api_context.operations)[0].observations;
  assert.deepEqual(records.flatMap(record => record.notes).sort(), ['First independent lesson.', 'Second independent lesson.']);
});

test('a swapped run ID locator is diagnosed before file lookup and a correct evidence retry remains an unverified claim', t => {
  const root = setup(t), runId = 'run-f5bc621c-fc80-49c3-8a91-6aa50a7a647e';
  const mistaken = { ...lesson, evidence: [{ locator: runId, path: 'counts.deployment_events' }] };
  assert.throws(() => recordGraphContext(root, mistaken), { code: 'GRAPH_EVIDENCE_LOCATOR_INVALID' });
  assert.equal(existsSync(fixtureContextFile(root)), false, 'invalid references do not discard evidence and save a weaker lesson');
  for (const locator of ['counts.deployment_events', '#/response/body', '/bad~2escape', '/trailing~'])
    assert.throws(() => recordGraphContext(root, { ...lesson, evidence: [{ path: 'missing.json', locator }] }), { code: 'GRAPH_EVIDENCE_LOCATOR_INVALID' });
  mkdirSync(join(root, fixtureEvidencePath()), { recursive: true });
  const path = `${fixtureEvidencePath()}/${runId}.json`;
  writeFileSync(join(root, path), JSON.stringify({ response: { body: { counts: { deployment_events: '240' }, private: 'private-response-sentinel' } } }));
  const result = recordGraphContext(root, { ...lesson, evidence: [{ path, locator: '/response/body/counts/deployment_events' }] });
  assert.equal(result.verification, 'external-claim'); assert.equal(result.requests_executed, 0);
  const observation = Object.values(context(root).api_context.operations)[0].observations[0];
  assert.equal(observation.evidence[0].path, path);
  assert.equal(observation.evidence[0].locator, '/response/body/counts/deployment_events');
  assert.match(observation.evidence[0].digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(observation.basis, 'authored'); assert.equal(observation.outcome, 'unknown');
  assert.equal(observation.complete, false); assert.equal(observation.assertions, undefined);
  assert.doesNotMatch(JSON.stringify(exportSaved(root)), /private-response-sentinel|"240"/u);
  // Valid JSON Pointer escaping stays accepted; a reference does not assert the selected content.
  assert.doesNotThrow(() => recordGraphContext(root, { ...lesson, evidence: [{ path, locator: '/literal~0tilde~1slash' }] }));
});

test('recording failure guidance is allowlisted and never reflects private error details', () => {
  const secret = ('private-error-sentinel /' + 'Users/example/secret.json Bearer abcdefghijklmnopqrstuvwxyz');
  for (const code of ['GRAPH_EVIDENCE_LOCATOR_INVALID', 'CONTEXT_EVIDENCE_MISSING', 'CONTEXT_EVIDENCE_INVALID', 'GRAPH_PATH_REFUSED', 'GRAPH_SECRET_REFUSED', 'GRAPH_RECORD_SCOPE_AMBIGUOUS', 'CONTEXT_INVALID']) {
    const result = graphRecordFailure({ code, message: secret, path: secret, remediation: secret });
    assert.equal(result.error.code, code); assert.ok(result.error.remediation);
    assert.equal(result.requests_executed, 0); assert.equal(result.published, false);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const unknown = graphRecordFailure({ code: 'GRAPH_PRIVATE_ERROR_SENTINEL', message: secret });
  assert.equal(unknown.error.code, 'GRAPH_RECORD_FAILED');
  assert.doesNotMatch(JSON.stringify(unknown), /GRAPH_PRIVATE_ERROR_SENTINEL|private-error-sentinel|\/Users\/example/u);
});

test('MCP evidence errors expose a safe correction path and a retry retains the evidence digest without execution', async t => {
  const root = setup(t), guard = join(root, 'no-execution.mjs'), marker = join(root, 'execution-attempted');
  writeFileSync(guard, `
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
    import child from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const refused = () => { writeFileSync(${JSON.stringify(marker)}, 'attempted'); throw new Error('No API execution allowed'); };
    globalThis.fetch = refused;
    for (const module of [http, https, net, tls]) for (const name of ['request','get','connect','createConnection','createServer']) if (typeof module[name] === 'function') module[name] = refused;
    for (const name of ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync']) child[name] = refused;
    syncBuiltinESMExports();
  `);
  const env = Object.fromEntries(Object.keys(process.env).filter(key => /^(?:API_|SANNR_|NODE_OPTIONS)/u.test(key)).map(key => [key, undefined]));
  Object.assign(env, { API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', SANNR_HOME: join(root, 'home'), NODE_OPTIONS: `--import=${guard}` });
  const session = createMcpSession({ command: process.execPath, args: [new URL('../server.mjs', import.meta.url).pathname], cwd: root, env, timeoutMs: 5000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'record-evidence-regression', version: '1' } });
  const tool = (await session.request('tools/list')).result.tools.find(item => item.name === 'api_context_record');
  assert.match(tool.inputSchema.properties.evidence.items.oneOf.find(item => item.type === 'object').properties.path.description, /configured evidence directory/u);
  assert.deepEqual(tool.inputSchema.properties.evidence.examples[0], [{ path: `${LAYOUT.evidence}/run-example.json`, locator: '/response/body/counts/deployment_events' }]);
  const record = args => session.request('tools/call', { name: 'api_context_record', arguments: args });
  const runId = 'run-f5bc621c-fc80-49c3-8a91-6aa50a7a647e';
  const bad = await record({ ...lesson, evidence: [{ path: 'counts.deployment_events', locator: runId }] });
  assert.equal(bad.result.isError, true);
  const badBody = JSON.parse(bad.result.content[0].text);
  assert.equal(badBody.error.code, 'GRAPH_EVIDENCE_LOCATOR_INVALID');
  assert.match(badBody.error.remediation, /Keep the evidence reference/u);
  assert.doesNotMatch(JSON.stringify(bad), new RegExp(runId));
  const missing = await record({ ...lesson, evidence: [{ path: 'missing-private-filename.json' }] });
  assert.equal(JSON.parse(missing.result.content[0].text).error.code, 'CONTEXT_EVIDENCE_MISSING');
  assert.doesNotMatch(JSON.stringify(missing), /missing-private-filename/u);
  assert.match(JSON.parse(missing.result.content[0].text).error.remediation, /existing request evidence artifact/u);
  mkdirSync(join(root, fixtureEvidencePath()), { recursive: true });
  writeFileSync(join(root, fixtureEvidencePath(), `${runId}.json`), '{"response":{"body":{"private":"private-body-sentinel"}}}');
  const saved = await record({ ...lesson, evidence: [{ path: `${fixtureEvidencePath()}/${runId}.json` }] });
  assert.equal(saved.result.isError, undefined);
  assert.equal(JSON.parse(saved.result.content[0].text).verification, 'external-claim');
  assert.equal(Object.values(context(root).api_context.operations)[0].observations[0].evidence.length, 1);
  assert.doesNotMatch(JSON.stringify(exportSaved(root)), /private-body-sentinel/u);
  assert.equal(existsSync(marker), false, 'recording and error recovery execute no API requests, listeners, or child processes');
});
