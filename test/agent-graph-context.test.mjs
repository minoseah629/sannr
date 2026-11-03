import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { graphContext, graphTool, readGraphUsage } from '../lib/agent-graph-context.mjs';
import { createGraphSnapshot } from '../lib/dependency-graph.mjs';
import { recordGraphContext } from '../lib/graph-record.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const AT = '2026-08-01T12:00:00.000Z';
const NOTE = 'Confirmation leaves an order in draft unless shipping is set first.';
const json = (path, value) => writeFileSync(path, JSON.stringify(value));

function fixture(t, { configured = true, metrics = false, knowledge } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-graph-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.API_CONTEXT_OFF;
  delete process.env.API_CONTEXT_OFF;
  t.after(() => { if (previous === undefined) delete process.env.API_CONTEXT_OFF; else process.env.API_CONTEXT_OFF = previous; });
  const catalog = join(root, 'catalog');
  mkdirSync(catalog);
  const manifest = { v: 1, repository: { id: 'shop', name: 'Shop' }, catalog: 'catalog', metrics, publishers: [{ id: 'orders', fingerprint: sha('orders pin') }],
    dependencies: [{ from: 'repo', to: 'orders#api', kind: 'calls' }] };
  if (configured) json(join(root, LAYOUT.graphManifest), manifest);
  const provider = { v: 1, repository: { id: 'orders', name: 'Orders', fingerprint: sha('orders pin'), url: 'https://example.test/orders' },
    nodes: [{ id: 'api', name: 'Orders API', kind: 'service' }] };
  const publish = records => json(join(catalog, 'orders.json'), createGraphSnapshot(provider, { knowledge: records, at: AT }));
  publish(knowledge ?? [fact('one'), fact('production', { environment: 'production', notes: ['Production has a separate scope.'] })]);
  return { root, catalog, manifest, provider, publish };
}

function fact(id, overrides = {}) {
  return { id: sha(id), node: 'orders#api', operation: 'POST /orders/{id}/confirm', protocol: 'http', environment: 'staging',
    basis: 'observed', verification: 'client-observation', notes: [NOTE], observed_at: AT, recorded_at: AT,
    evidence: [{ path: 'evidence/prior.json', digest: sha('prior evidence'), state: 'unavailable' }],
    source: { kind: 'protocol-context', path: LAYOUT.context, record_id: id, digest: sha('context'), author: 'fixture-client' },
    freshness: { state: 'unknown', reason: 'The snapshot does not establish current API behavior.', observed_at: AT },
    omissions: ['Evidence contents were not copied or rechecked.'], ...overrides };
}

test('graph tool is absent without configuration or when context is disabled', async t => {
  const f = fixture(t, { configured: false });
  assert.equal(await graphTool(f.root), null);
  assert.equal((await graphContext(f.root)).issues[0].code, 'GRAPH_NOT_CONFIGURED');
  json(join(f.root, LAYOUT.graphManifest), f.manifest);
  process.env.API_CONTEXT_OFF = '1';
  assert.equal(await graphTool(f.root), null);
  assert.equal((await graphContext(f.root)).issues[0].code, 'GRAPH_CONTEXT_DISABLED');
});

test('focused context carries exact scoped facts and original publisher evidence without the provider checkout', async t => {
  const f = fixture(t);
  const result = await graphContext(f.root, { action: 'context', node: 'orders#api', operation: 'POST /orders/{id}/confirm', environment: 'staging', response_format: 'detailed' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.requests_executed, 0);
  assert.equal(result.knowledge.length, 1);
  const known = result.knowledge[0];
  assert.equal(known.publisher, 'orders');
  assert.equal(known.publication.id, 'orders');
  assert.equal(known.publication.url, 'https://example.test/orders');
  assert.equal(known.observed_at, AT);
  assert.equal(known.verification, 'client-observation');
  assert.equal(known.freshness.state, 'unknown');
  assert.equal(known.evidence[0].state, 'unavailable');
  assert.deepEqual(known.notes, [NOTE]);
  assert.ok(result.briefing.includes(NOTE));
  assert.ok(result.briefing.includes('unavailable'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(f.root));
  assert.equal((await graphContext(f.root, { action: 'context', environment: 'stag' })).knowledge.length, 0);
});

test('exact filters run before the traversal record budget', async t => {
  const records = Array.from({ length: 205 }, (_, i) => fact(`other-${i}`, { operation: `GET /other-${i}`, notes: ['Other operation.'] }));
  records.push(fact('last'));
  const f = fixture(t, { knowledge: records });
  const result = await graphContext(f.root, { action: 'context', operation: 'POST /orders/{id}/confirm', environment: 'staging' });
  assert.equal(result.knowledge.length, 1);
  assert.deepEqual(result.knowledge[0].notes, [NOTE]);
});

test('bootstrap stays a small dependency index and leaves notes to focused retrieval', async t => {
  const f = fixture(t);
  const overview = await graphContext(f.root);
  assert.equal(overview.action, 'overview');
  assert.equal(overview.knowledge.length, 0);
  assert.equal(overview.available_knowledge, 2);
  assert.equal(overview.nodes.some(node => node.id === 'shop#repo'), true, 'provider-only catalog composes the current consumer declaration');
  const tool = await graphTool(f.root);
  assert.equal(tool.name, 'api_context');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.match(tool.description, /orders#api/);
  assert.doesNotMatch(tool.description, /Confirmation leaves|Production has/);
  assert.ok(tool.description.split('\n\n')[1].length <= 1500);
  assert.equal(tool.inputSchema.additionalProperties, false);
});

test('catalog replacement, provider removal and manifest removal take effect on the next read', async t => {
  const f = fixture(t);
  assert.ok((await graphContext(f.root, { action: 'context' })).knowledge.some(item => item.notes.includes(NOTE)));
  f.publish([fact('replacement', { notes: ['The new observation replaces the selected snapshot.'] })]);
  const changed = await graphContext(f.root, { action: 'context' });
  assert.equal(changed.knowledge.length, 1);
  assert.doesNotMatch(JSON.stringify(changed), /Confirmation leaves/);
  rmSync(join(f.catalog, 'orders.json'));
  const removed = await graphContext(f.root, { action: 'context' });
  assert.equal(removed.knowledge.length, 0);
  assert.equal(removed.unresolved[0].id, 'orders#api');
  assert.equal(removed.callers.coverage, 'partial');
  rmSync(join(f.root, LAYOUT.graphManifest));
  assert.equal(await graphTool(f.root), null);
});

test('small output budgets disclose omissions and malformed inputs return fixed, bounded diagnostics', async t => {
  const f = fixture(t, { knowledge: Array.from({ length: 20 }, (_, i) => fact(`fact-${i}`, { notes: ['A'.repeat(800)] })) });
  for (const max_bytes of [2000, 12000, 64000]) {
    const result = await graphContext(f.root, { action: 'context', max_bytes });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= max_bytes);
    if (max_bytes < 64000) assert.equal(result.truncated.response_bytes, true);
    if (max_bytes === 2000) assert.ok(result.omitted_response_items.knowledge > 0);
    if (result.knowledge.length === 0) assert.match(result.briefing, /All matching facts.*omitted/);
  }
  for (const args of [null, [], { action: 'execute' }, { catalog: '/private/data' }, { max_bytes: 1 }, { node: 'bad\nnode' }]) {
    const result = await graphContext(f.root, args);
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, 'GRAPH_QUERY_INVALID');
    assert.doesNotMatch(JSON.stringify(result), /\/private\/data|bad\\nnode/);
  }
  writeFileSync(join(f.root, LAYOUT.graphManifest), '{"secret-input-do-not-echo":');
  const tool = await graphTool(f.root);
  assert.ok(tool, 'malformed configured context stays diagnosable');
  assert.doesNotMatch(tool.description, /secret-input-do-not-echo/);
  assert.equal((await graphContext(f.root)).issues[0].code, 'GRAPH_MANIFEST_UNREADABLE');
});

test('the minimum focused budget preserves a small matching fact ahead of a repeated index', async t => {
  const f = fixture(t, { knowledge: [fact('small', { notes: ['Only published items are returned.'] })] });
  const result = await graphContext(f.root, { action: 'context', operation: 'POST /orders/{id}/confirm', environment: 'staging', max_bytes: 2000 });
  assert.equal(result.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2000);
  assert.equal(result.knowledge.length, 1, JSON.stringify(result));
  assert.equal(result.knowledge[0].publisher, 'orders');
  assert.equal(result.knowledge[0].observed_at, AT);
  assert.equal(result.knowledge[0].freshness.state, 'unknown');
  assert.deepEqual(result.knowledge[0].notes, ['Only published items are returned.']);
  assert.equal(result.truncated.response_bytes, true);
  assert.match(result.topology_scope, /unfiltered/);
});

test('the minimum budget retains a real captured lesson and its entire provenance before empty graph metadata', async t => {
  const f = fixture(t);
  json(join(f.root, LAYOUT.graphManifest), { ...f.manifest, context: { providers: [
    { node: 'orders#api', provider: 'orders-fixture', environment: 'staging', protocol: 'http' },
  ] } });
  recordGraphContext(f.root, { node: 'orders#api', operation: 'POST /invoices',
    note: 'account_id is required despite the contract.', observed_at: AT });
  const query = { action: 'context', response_format: 'detailed', node: 'orders#api', operation: 'POST /invoices', environment: 'staging' };
  const complete = await graphContext(f.root, { ...query, max_bytes: 64000 });
  const compact = await graphContext(f.root, { ...query, max_bytes: 2000 });
  assert.equal(compact.knowledge.length, 1, JSON.stringify(compact));
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 2000);
  const retained = structuredClone(compact.knowledge[0]);
  retained.publication.generated_at = complete.knowledge[0].publication.generated_at;
  assert.deepEqual(retained, complete.knowledge[0], 'only the surrounding envelope is compacted; the claim stays intact');
  assert.equal(retained.publisher, 'shop');
  assert.equal(retained.basis, 'authored');
  assert.equal(retained.verification, 'external-claim');
  assert.equal(compact.omitted_foreign_claims ?? 0, 0);
  assert.match(compact.briefing, /omitted/);
  assert.ok(compact.omitted_response_items.envelope_fields > 0);
});

test('optional metrics record only local delivery counts and never claim benefit', async t => {
  const f = fixture(t);
  const path = join(f.root, `${LAYOUT.evidence}/graph/usage.jsonl`);
  await graphContext(f.root, { action: 'context' });
  assert.equal(existsSync(path), false);
  json(join(f.root, LAYOUT.graphManifest), { ...f.manifest, metrics: true });
  const delivered = await graphContext(f.root, { action: 'context', environment: 'staging' }, { channel: 'mcp' });
  const event = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(event).sort(), ['action', 'at', 'channel', 'issues', 'knowledge_delivered', 'repository_count', 'truncated']);
  assert.equal(event.knowledge_delivered, delivered.knowledge.length);
  assert.equal(event.channel, 'mcp');
  assert.doesNotMatch(JSON.stringify(event), /orders|staging|shipping|example\.test|sannr\.json/);
  assert.equal(readGraphUsage(f.root).recorded_events, 1);
  assert.match(readGraphUsage(f.root).meaning, /do not prove agent use/);
  rmSync(join(f.root, LAYOUT.evidence), { recursive: true });
  writeFileSync(join(f.root, LAYOUT.evidence), 'cannot create a directory here');
  assert.equal((await graphContext(f.root, { action: 'context' })).ok, true, 'metrics failure never breaks context');
});

async function mcp(t, root, overrides = {}) {
  const guard = join(root, 'no-execution.mjs'), marker = join(root, 'execution-attempted');
  writeFileSync(guard, `
    import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
    import child from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const refused = () => { writeFileSync(${JSON.stringify(marker)}, 'attempted'); throw new Error('Fixture prohibits request or process execution'); };
    globalThis.fetch = refused;
    for (const module of [http, https, net, tls]) for (const name of ['request', 'get', 'connect', 'createConnection', 'createServer'])
      if (typeof module[name] === 'function') module[name] = refused;
    for (const name of ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']) child[name] = refused;
    syncBuiltinESMExports();
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:API_|SANNR_|NODE_OPTIONS)/u.test(key)));
  Object.assign(env, { API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', API_EVIDENCE: join(root, 'evidence'),
    API_USAGE_LOG: join(root, 'usage.jsonl'), SANNR_HOME: join(root, 'home'), NODE_OPTIONS: `--import=${guard}`, ...overrides });
  const child = spawn(process.execPath, [join(ROOT, 'server.mjs')], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let nextId = 0, buffer = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const reply = JSON.parse(line), waiter = pending.get(reply.id);
      if (waiter) { pending.delete(reply.id); clearTimeout(waiter.timer); waiter.resolve(reply); }
    }
  });
  child.on('error', error => { for (const item of pending.values()) item.reject(error); });
  t.after(() => {
    child.kill('SIGTERM');
    for (const item of pending.values()) clearTimeout(item.timer);
    assert.equal(existsSync(marker), false, 'pre-task context must execute no request, listener or child process');
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  }).then(reply => {
    assert.equal(existsSync(marker), false, 'pre-task context must execute no request, listener or child process');
    return reply;
  });
  return { request };
}

test('fresh MCP host receives only the index, retrieves scoped facts before requests, and observes catalog changes', async t => {
  const f = fixture(t);
  const host = await mcp(t, f.root);
  const init = await host.request('initialize', { protocolVersion: '2025-11-25' });
  assert.match(init.result.instructions, /orders#api/);
  assert.doesNotMatch(init.result.instructions, /Confirmation leaves/);
  const listed = await host.request('tools/list');
  assert.equal(listed.result.tools.some(tool => tool.name === 'api_request'), true);
  assert.equal(listed.result.tools.some(tool => tool.name === 'api_context'), true);
  const query = () => host.request('tools/call', { name: 'api_context', arguments: { action: 'context', operation: 'POST /orders/{id}/confirm', environment: 'staging' } });
  const first = JSON.parse((await query()).result.content[0].text);
  assert.deepEqual(first.knowledge[0].notes, [NOTE]);
  const inspect = ref => host.request('tools/call', { name: 'api_context', arguments: { action: 'inspect', ref } });
  const inspected = JSON.parse((await inspect(first.knowledge[0].detail_ref)).result.content[0].text);
  assert.equal(inspected.requests_executed, 0);
  assert.equal(inspected.knowledge[0].evidence[0].state, 'unavailable');
  assert.equal(inspected.knowledge[0].source.record_id, 'one');
  f.publish([fact('next', { notes: ['Changed snapshot fact.'] })]);
  assert.deepEqual(JSON.parse((await query()).result.content[0].text).knowledge[0].notes, ['Changed snapshot fact.']);
  const old = JSON.parse((await inspect(first.knowledge[0].detail_ref)).result.content[0].text);
  assert.equal(old.ok, false);
  assert.equal(old.issues[0].code, 'GRAPH_RECORD_NOT_FOUND');
  const malformed = await host.request('tools/call', { name: 'api_context', arguments: [] });
  assert.equal(malformed.result.isError, true);
  rmSync(join(f.root, LAYOUT.graphManifest));
  assert.deepEqual((await host.request('tools/list')).result.tools.map(tool => tool.name), ['api_request', 'api_saved_requests', 'api_workbench', 'api_note_review', 'api_note_retire', 'api_note_context']);
  assert.equal((await query()).error.code, -32602);
});

test('MCP default and context-disabled bindings retain request tools without graph context', async t => {
  const f = fixture(t, { configured: false });
  const host = await mcp(t, f.root);
  assert.deepEqual((await host.request('tools/list')).result.tools.map(tool => tool.name), ['api_request', 'api_saved_requests', 'api_workbench', 'api_note_review', 'api_note_retire', 'api_note_context']);
  const read = await host.request('tools/call', { name: 'api_note_context', arguments: { operation: 'GET /items' } });
  assert.equal(read.result.isError, undefined);
  assert.equal(JSON.parse(read.result.content[0].text).requests_executed, 0);
  json(join(f.root, LAYOUT.graphManifest), f.manifest);
  const disabled = await mcp(t, f.root, { API_CONTEXT_OFF: '1' });
  assert.deepEqual((await disabled.request('tools/list')).result.tools.map(tool => tool.name), ['api_request', 'api_saved_requests', 'api_workbench']);
  for (const name of ['api_note_context', 'api_note_review', 'api_note_retire', 'api_context', 'api_context_record'])
    assert.equal((await disabled.request('tools/call', { name, arguments: {} })).error.code, -32602);
});

test('MCP recording preserves consumer authorship and is absent from the read-only librarian', async t => {
  const f = fixture(t);
  json(join(f.root, LAYOUT.graphManifest), { ...f.manifest, context: { providers: [
    { node: 'orders#api', provider: 'orders-fixture', environment: 'staging', protocol: 'http' },
  ] } });
  const host = await mcp(t, f.root);
  const tools = (await host.request('tools/list')).result.tools;
  assert.equal(tools.find(tool => tool.name === 'api_context_record').annotations.readOnlyHint, false);
  const recorded = await host.request('tools/call', { name: 'api_context_record', arguments: {
    node: 'orders#api', operation: 'POST /orders/{id}/confirm', note: 'A consumer observed an extra confirmation prerequisite.',
    environment: 'staging', observed_at: AT,
  } });
  assert.equal(recorded.result.isError, undefined, JSON.stringify(recorded));
  const receipt = JSON.parse(recorded.result.content[0].text);
  assert.equal(receipt.publisher, 'shop');
  assert.equal(receipt.verification, 'external-claim');
  assert.equal(receipt.published, false);
  const known = JSON.parse((await host.request('tools/call', { name: 'api_context', arguments: {
    action: 'context', response_format: 'detailed', node: 'orders#api', operation: 'POST /orders/{id}/confirm', environment: 'staging',
  } })).result.content[0].text).knowledge;
  const consumer = known.find(item => item.publisher === 'shop');
  assert.ok(consumer, JSON.stringify(known));
  assert.equal(consumer.node, 'orders#api');
  assert.equal(consumer.publication.id, 'shop');
  assert.equal(consumer.basis, 'authored');
  assert.equal(consumer.verification, 'external-claim');
  assert.equal(consumer.observed_at, AT);
  const readonly = await mcp(t, f.root, { API_REQUEST_READ_ONLY: '1' });
  const readOnlyTools = (await readonly.request('tools/list')).result.tools;
  assert.deepEqual(readOnlyTools.map(tool => tool.name), ['api_request', 'api_saved_requests', 'api_note_context', 'api_context']);
  assert.equal(readOnlyTools.find(tool => tool.name === 'api_note_context').annotations.readOnlyHint, true);
  assert.deepEqual(readOnlyTools.find(tool => tool.name === 'api_saved_requests').inputSchema.properties.action.enum, ['list', 'show', 'reopen', 'inspect']);
  assert.equal((await readonly.request('tools/call', { name: 'api_context_record', arguments: {} })).error.code, -32602);
  const before = readFileSync(join(f.root, LAYOUT.context), 'utf8');
  const read = await readonly.request('tools/call', { name: 'api_note_context', arguments: { operation: 'POST /orders/{id}/confirm' } });
  assert.equal(read.result.isError, undefined);
  assert.equal(JSON.parse(read.result.content[0].text).requests_executed, 0);
  for (const name of ['api_note_review', 'api_note_retire'])
    assert.equal((await readonly.request('tools/call', { name, arguments: {} })).error.code, -32602);
  assert.equal(readFileSync(join(f.root, LAYOUT.context), 'utf8'), before);
});
