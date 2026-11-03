import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { captureOperationContext as captureRaw, operationId, queryOperationContext as queryRaw } from '../lib/operation-context.mjs';
import { graphRecordFailure, graphRecordTool, recordGraphContext as recordRaw } from '../lib/graph-record.mjs';
import { exportGraphSnapshot } from '../lib/graph-export.mjs';
import { buildGraphCatalog, graphNeighborhood } from '../lib/dependency-graph.mjs';
import { createMcpSession } from '../lib/mcp-transport.mjs';

import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, inFixtureStack } from './helpers/stack-fixture.mjs';
const captureOperationContext = (root, ...args) => inFixtureStack(root, () => captureRaw(root, ...args));
const queryOperationContext = (root, ...args) => inFixtureStack(root, () => queryRaw(root, ...args));
const recordGraphContext = (root, ...args) => inFixtureStack(root, () => recordRaw(root, ...args));

const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const identity = { stack: 'fixture', provider: 'https://billing.example.test/v2', environment: 'staging', protocol: 'http', operation: 'POST /invoices',
  endpoint: 'https://billing.example.test/v2/invoices', contractDigest: sha('original contract') };
const note = 'The staging response rejected a missing billing_group; the contract did not declare that requirement.';
function setup(t, { evidence = true, observed_at = '2020-01-02T03:04:05.000Z', overrides = {}, internal = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'observation-record-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1, repository: { id: 'acme/web', name: 'Web' }, nodes: [],
    dependencies: [{ from: 'repo', to: 'acme/billing#api', kind: 'calls' }], context: { providers: [
      { node: 'acme/billing#api', ...Object.fromEntries(['provider', 'environment', 'protocol'].map(key => [key, identity[key]])) },
    ] } }));
  createFixtureStack(root, { baseUrl: identity.provider, environment: identity.environment });
  if (evidence) writeFileSync(join(root, fixtureEvidencePath(), 'run-existing.json'), '{"response":{"body":{"private":"never-copy-payload"}}}');
  const receipt = captureOperationContext(root, { identity, source: { tool: 'api_request' }, basis: 'observed', outcome: 'error', complete: true,
    observed_at, status: 422, response: { error: 'private-message-value' }, assertions: { passed: 0, failed: 1 },
    evidence: evidence ? [{ path: `${fixtureEvidencePath()}/run-existing.json`, locator: '/response/body' }] : [], ...overrides }, { internal });
  return { root, receipt };
}
const bytes = root => readFileSync(fixtureContextFile(root), 'utf8');
const context = root => JSON.parse(bytes(root));
function saved(root, receipt) { return context(root).api_context.operations[receipt.operation_id].observations; }
function mutation(root, update) { const ctx = context(root); update(ctx); writeFileSync(fixtureContextFile(root), JSON.stringify(ctx)); }
function refusesUnchanged(root, args, code) {
  const before = bytes(root);
  assert.throws(() => recordGraphContext(root, args), { code });
  assert.equal(bytes(root), before, 'failed linking must leave original context bytes unchanged');
  const error = graphRecordFailure({ code, message: 'private-untrusted-error', path: ('/' + 'Users/private/credential') });
  assert.equal(error.error.code, code); assert.equal(error.requests_executed, 0); assert.equal(error.published, false);
  assert.doesNotMatch(JSON.stringify(error), /private-untrusted-error|\/Users\/private/u);
}

test('one observation handle retains exact scope, evidence digest and original age while authoring an unverified explanation', t => {
  const { root, receipt } = setup(t), original = structuredClone(saved(root, receipt)[0]);
  const result = recordGraphContext(root, { observation_id: receipt.observation_id, note });
  assert.deepEqual(result.identity, receipt.identity); assert.equal(result.operation_id, receipt.operation_id);
  assert.equal(result.node, 'acme/billing#api'); assert.equal(result.publisher, 'acme/web');
  assert.equal(result.observed_at, original.observed_at); assert.equal(result.source_freshness.state, 'stale');
  assert.equal(result.requests_executed, 0); assert.equal(result.published, false); assert.equal(result.evidence.state, 'matching');
  const [unchanged, claim] = saved(root, receipt);
  assert.deepEqual(unchanged, original);
  assert.deepEqual(claim.based_on, { operation_id: receipt.operation_id, observation_id: receipt.observation_id, observation_digest: sha(JSON.stringify(original)) });
  assert.deepEqual(claim.evidence, original.evidence); assert.equal(claim.observed_at, original.observed_at);
  assert.equal(claim.basis, 'authored'); assert.equal(claim.verification, 'external-claim'); assert.equal(claim.source.kind, 'external');
  assert.equal(claim.outcome, 'unknown'); assert.equal(claim.complete, false);
  for (const key of ['assertions', 'response_status', 'request_shape', 'response_shape']) assert.equal(claim[key], undefined);
  assert.match(claim.omissions.join(' '), /source observation outcome was error/u);
  const queried = queryOperationContext(root, identity).operations[0].observations.find(item => item.id === claim.id);
  assert.deepEqual(queried.based_on, claim.based_on); assert.equal(queried.evidence[0].state, 'matching');
  assert.doesNotMatch(bytes(root), /never-copy-payload|private-message-value/u);
});

test('the source link and original timestamp survive Git/CI export without private evidence payloads or local availability claims', t => {
  const { root, receipt } = setup(t);
  recordGraphContext(root, { observation_id: receipt.observation_id, operation_id: receipt.operation_id, note });
  // Cross-repo stack export is deferred. Preserve the existing historical
  // snapshot projection with a read-only legacy clone, never a legacy capture.
  const clone = realpathSync(mkdtempSync(join(tmpdir(), 'observation-export-history-')));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  writeFileSync(join(clone, LAYOUT.context), bytes(root));
  writeFileSync(join(clone, LAYOUT.graphManifest), readFileSync(join(root, LAYOUT.graphManifest)));
  const snapshot = exportGraphSnapshot(clone), claim = snapshot.knowledge.find(item => item.basis === 'authored');
  assert.equal(claim.based_on.observation_id, receipt.observation_id); assert.equal(claim.freshness.state, 'stale');
  rmSync(join(root, fixtureEvidencePath()), { recursive: true });
  const retrieved = graphNeighborhood(buildGraphCatalog([snapshot]), { node: 'acme/billing#api', includeForeignClaims: true });
  assert.equal(retrieved.knowledge.length, 0, 'an authored consumer claim remains outside its provider\'s knowledge section');
  const remote = retrieved.foreign_claims.find(item => item.basis === 'authored');
  assert.deepEqual(remote.based_on, claim.based_on); assert.equal(remote.evidence[0].state, 'unavailable');
  assert.equal(remote.observed_at, claim.observed_at); assert.equal(remote.publisher, 'acme/web');
  assert.equal(remote.verification, 'external-claim'); assert.doesNotMatch(JSON.stringify(remote), /never-copy-payload/u);
  const other = setup(t).root;
  refusesUnchanged(other, { observation_id: receipt.observation_id, note }, 'GRAPH_OBSERVATION_MISSING');
});

test('scoped recording preserves the configured historical snapshot while stack export is deferred', t => {
  const { root, receipt } = setup(t), manifestPath = join(root, LAYOUT.graphManifest);
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.context.snapshot = 'share/api-snapshot.json';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const clone = realpathSync(mkdtempSync(join(tmpdir(), 'observation-existing-snapshot-')));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  writeFileSync(join(clone, LAYOUT.context), bytes(root));
  writeFileSync(join(clone, LAYOUT.graphManifest), readFileSync(manifestPath));
  const snapshot = exportGraphSnapshot(clone);
  assert.ok(snapshot.knowledge.length, 'the preexisting artifact contains retained API knowledge');
  const target = join(root, manifest.context.snapshot);
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  const before = readFileSync(target);
  const result = recordGraphContext(root, { observation_id: receipt.observation_id, note });
  assert.equal(saved(root, receipt).length, 2, 'the additive lesson is saved in its selected stack');
  assert.deepEqual(readFileSync(target), before, 'deferred stack export must not replace an existing shared artifact');
  assert.equal(result.snapshot.code, 'STACK_GRAPH_EXPORT_DEFERRED');
  assert.equal(result.snapshot.lesson_saved, true);
  assert.equal(result.snapshot.published, false);
});

test('missing and changed evidence refuse the write without refreshing digests or discarding available evidence', t => {
  const { root, receipt } = setup(t), args = { observation_id: receipt.observation_id, note }, evidencePath = join(root, fixtureEvidencePath(), 'run-existing.json');
  const original = readFileSync(evidencePath);
  writeFileSync(evidencePath, 'changed response');
  refusesUnchanged(root, args, 'CONTEXT_EVIDENCE_CHANGED');
  rmSync(evidencePath);
  refusesUnchanged(root, args, 'CONTEXT_EVIDENCE_MISSING');
  writeFileSync(evidencePath, original);
  assert.equal(recordGraphContext(root, args).evidence.state, 'matching');
});

test('replacement file links, linked parent directories and hardlinks are refused even when their bytes match', t => {
  for (const kind of ['file-link', 'directory-link', 'hardlink']) {
    const { root, receipt } = setup(t), evidencePath = join(root, fixtureEvidencePath(), 'run-existing.json'), original = readFileSync(evidencePath);
    const copy = join(root, 'copy.json'); writeFileSync(copy, original);
    rmSync(evidencePath);
    if (kind === 'file-link') symlinkSync(copy, evidencePath);
    else if (kind === 'hardlink') linkSync(copy, evidencePath);
    else {
      rmSync(join(root, fixtureEvidencePath()), { recursive: true }); mkdirSync(join(root, 'actual-evidence'));
      writeFileSync(join(root, 'actual-evidence', 'run-existing.json'), original);
      symlinkSync(join(root, 'actual-evidence'), join(root, fixtureEvidencePath()), process.platform === 'win32' ? 'junction' : 'dir');
    }
    refusesUnchanged(root, { observation_id: receipt.observation_id, note }, 'CONTEXT_EVIDENCE_INVALID');
  }
});

test('an observation without evidence stays explicitly unsupported by evidence and does not acquire invented verification', t => {
  const { root, receipt } = setup(t, { evidence: false, observed_at: new Date().toISOString() });
  const result = recordGraphContext(root, { observation_id: receipt.observation_id, note });
  assert.equal(result.evidence.state, 'absent'); assert.equal(result.evidence.references, 0); assert.equal(result.source_freshness.state, 'unknown');
  assert.deepEqual(saved(root, receipt).at(-1).evidence, []);
  assert.match(saved(root, receipt).at(-1).omissions.join(' '), /no saved evidence files/u);
});

test('the original provider binding must still match exactly; a same operation on a different environment cannot be borrowed', t => {
  const { root, receipt } = setup(t), manifestPath = join(root, LAYOUT.graphManifest), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.context.providers[0].environment = 'production'; writeFileSync(manifestPath, JSON.stringify(manifest));
  refusesUnchanged(root, { observation_id: receipt.observation_id, note }, 'GRAPH_RECORD_SCOPE_MISSING');
  manifest.context.providers[0].environment = 'staging';
  manifest.context.providers.push({ ...manifest.context.providers[0], node: 'acme/web#repo' }); writeFileSync(manifestPath, JSON.stringify(manifest));
  refusesUnchanged(root, { observation_id: receipt.observation_id, note }, 'GRAPH_BINDING_CONFLICT');
});

test('duplicate observation IDs require exact operation scope and duplicates within that scope remain ambiguous', t => {
  const { root, receipt } = setup(t), otherIdentity = { ...receipt.identity, operation: 'GET /invoices' }, otherId = operationId(otherIdentity);
  mutation(root, ctx => { ctx.api_context.operations[otherId] = { ...structuredClone(ctx.api_context.operations[receipt.operation_id]), identity: otherIdentity }; });
  refusesUnchanged(root, { observation_id: receipt.observation_id, note }, 'GRAPH_OBSERVATION_AMBIGUOUS');
  assert.equal(recordGraphContext(root, { observation_id: receipt.observation_id, operation_id: receipt.operation_id, note }).operation_id, receipt.operation_id);
  mutation(root, ctx => { const entry = ctx.api_context.operations[receipt.operation_id]; entry.observations.push(structuredClone(entry.observations[0])); });
  refusesUnchanged(root, { observation_id: receipt.observation_id, operation_id: receipt.operation_id, note }, 'GRAPH_OBSERVATION_AMBIGUOUS');
});

test('scope/time/evidence overrides and external or authored observations cannot impersonate a linked local request', t => {
  const { root, receipt } = setup(t), base = { observation_id: receipt.observation_id, note };
  for (const extra of [{ node: 'acme/billing#api' }, { operation: 'GET /invoices' }, { environment: 'production' }, { protocol: 'grpc' },
    { evidence: [] }, { observed_at: new Date().toISOString() }, { verification: 'client-observation' }, { internal: true }, { operation_id: 'POST /invoices' }])
    refusesUnchanged(root, { ...base, ...extra }, 'GRAPH_RECORD_INVALID');
  const authored = recordGraphContext(root, base);
  refusesUnchanged(root, { observation_id: authored.observation_id, note }, 'GRAPH_OBSERVATION_UNSUPPORTED');
  for (const fixture of [{ internal: false }, { overrides: { basis: 'declared' } }]) {
    const source = setup(t, fixture);
    refusesUnchanged(source.root, { observation_id: source.receipt.observation_id, note }, 'GRAPH_OBSERVATION_UNSUPPORTED');
  }
});

test('retention refuses losing the selected source and evicted IDs never resolve to another observation', t => {
  const { root, receipt } = setup(t, { evidence: false });
  for (let i = 0; i < 19; i++) captureOperationContext(root, { identity, response: { count: i } }, { internal: true });
  refusesUnchanged(root, { observation_id: receipt.observation_id, note }, 'GRAPH_OBSERVATION_RETENTION_LIMIT');
  captureOperationContext(root, { identity, response: { count: 20 } }, { internal: true });
  refusesUnchanged(root, { observation_id: receipt.observation_id, note }, 'GRAPH_OBSERVATION_MISSING');
});

test('concurrent linked lessons preserve the same original observation and both authored notes', async t => {
  const { root, receipt } = setup(t), module = new URL('../lib/graph-record.mjs', import.meta.url).href;
  const original = structuredClone(saved(root, receipt)[0]);
  const run = note => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { recordGraphContext } from ${JSON.stringify(module)};
       import { inFixtureStack } from ${JSON.stringify(new URL('./helpers/stack-fixture.mjs', import.meta.url).href)};
       inFixtureStack(${JSON.stringify(root)}, () => recordGraphContext(${JSON.stringify(root)}, ${JSON.stringify({ observation_id: receipt.observation_id, note })}));`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => stderr += chunk); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run('One separately supported explanation.'), run('Another separately supported explanation.')]);
  const records = saved(root, receipt); assert.deepEqual(records[0], original);
  assert.deepEqual(records.slice(1).flatMap(item => item.notes).sort(), ['Another separately supported explanation.', 'One separately supported explanation.']);
  assert.ok(records.slice(1).every(item => item.based_on.observation_digest === sha(JSON.stringify(original))));
});

test('MCP recording uses the observation receipt without evidence-path reconstruction and executes zero requests', async t => {
  const { root, receipt } = setup(t), marker = join(root, 'execution-attempted'), guard = join(root, 'no-execution.mjs');
  writeFileSync(guard, `
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
    import child from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const refuse = () => { writeFileSync(${JSON.stringify(marker)}, 'attempted'); throw new Error('No execution permitted'); };
    globalThis.fetch = refuse;
    for (const module of [http, https, net, tls]) for (const key of ['request','get','connect','createConnection','createServer']) if (typeof module[key] === 'function') module[key] = refuse;
    for (const key of ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync']) child[key] = refuse;
    syncBuiltinESMExports();
  `);
  const env = Object.fromEntries(Object.keys(process.env).filter(key => /^(?:API_|SANNR_|NODE_OPTIONS)/u.test(key)).map(key => [key, undefined]));
  Object.assign(env, { API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', SANNR_HOME: join(root, 'home'), NODE_OPTIONS: `--import=${guard}` });
  const session = createMcpSession({ command: process.execPath, args: [new URL('../server.mjs', import.meta.url).pathname], cwd: root, env, timeoutMs: 5000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'observation-link-regression', version: '1' } });
  const tools = (await session.request('tools/list')).result.tools;
  assert.ok(tools.find(tool => tool.name === 'api_context_record').inputSchema.properties.observation_id);
  const response = await session.request('tools/call', { name: 'api_context_record', arguments: { observation_id: receipt.observation_id, note } });
  assert.equal(response.result.isError, undefined);
  const result = JSON.parse(response.result.content[0].text);
  assert.equal(result.based_on.observation_id, receipt.observation_id); assert.equal(result.evidence.references, 1);
  assert.equal(result.requests_executed, 0); assert.equal(existsSync(marker), false);
});

test('CLI observation mode works without a graph node and rejects mixed scope and global optout', async t => {
  const { root, receipt } = setup(t), cli = new URL('../bin/cli.mjs', import.meta.url).pathname;
  const run = (extra = [], env = {}) => spawnSync(process.execPath, [cli, 'graph', 'record', '--observation-id', receipt.observation_id,
    '--operation-id', receipt.operation_id, '--note', note, '--json', ...extra], { cwd: root, env: { ...process.env, API_CONTEXT_OFF: '0', ...env }, encoding: 'utf8' });
  const result = run(); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).based_on.observation_id, receipt.observation_id);
  const before = bytes(root);
  assert.notEqual(run(['--environment', 'production']).status, 0); assert.equal(bytes(root), before);
  const disabled = run([], { API_CONTEXT_OFF: '1' }); assert.notEqual(disabled.status, 0); assert.equal(bytes(root), before);
  const old = process.env.API_CONTEXT_OFF;
  try { process.env.API_CONTEXT_OFF = '1'; assert.equal(await graphRecordTool(root), null); }
  finally { if (old === undefined) delete process.env.API_CONTEXT_OFF; else process.env.API_CONTEXT_OFF = old; }
});
