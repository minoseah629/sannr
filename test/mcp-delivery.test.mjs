import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { MCP_SERVER_KEY } from '../lib/brand.mjs';
// MCP-1b: inspected facts must arrive in the agent's existing path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync,  rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeMcpInspection } from '../lib/mcp-inspect.mjs';
import { start } from './fixture-server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin/cli.mjs');
const SERVER = join(ROOT, 'server.mjs');
const tool = (name = 'read_status') => ({ name, description: 'Declared fixture tool', inputSchema: {
  type: 'object', required: ['tenant_id'], properties: { tenant_id: { type: 'string' }, optional: { type: 'boolean' } },
}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
const inspection = (tools = [tool()], name = 'fixture-server', label = 'fixture') => ({
  server: { name, version: '2.1', label, transport: 'stdio' }, initialized: true,
  capabilities: {}, declared: { tools, resources: [], prompts: [] }, measured: [],
});
function scratch(t, records = [inspection()]) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-delivery-'));
  const home = mkdtempSync(join(tmpdir(), 'mcp-delivery-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [join(ROOT, 'test/fixtures/mcp-inspect-server.mjs')] },
  } }));
  for (const record of records) storeMcpInspection(root, record);
  return { root, env: { ...process.env, HOME: home, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', API_EVIDENCE: join(root, 'evidence') } };
}
function scopedInspection(project, contract) {
  const saved = readFileSync(join(project.root, LAYOUT.context),'utf8');
  createFixtureStack(project.root,{contract});
  writeFileSync(fixtureContextFile(project.root),saved);
}
function cli(project, args) {
  try { return { status: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd: project.root, env: project.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (error) { return { status: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }; }
}

test('MCP-1b connect pushes latest registered tools, claims, required fields and diff after existing facts', (t) => {
  const project = scratch(t, [inspection([tool('old_tool')]), inspection(), inspection([tool('unregistered_tool')], 'other', 'unregistered')]);
  const result = cli(project, ['connect', '--json']);
  assert.equal(result.status, 0, result.out);
  const pointer = readFileSync(join(project.root, 'AGENTS.md'), 'utf8');
  assert.equal(readFileSync(join(project.root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.match(pointer, /MCP servers this repo registers/);
  assert.match(pointer, /Server: `fixture-server` `2\.1`/);
  assert.match(pointer, /\| Tool \| Hints \(server claims\) \| Required inputs \|/);
  assert.match(pointer, /`read_status`.*claims read-only; claims not destructive; claims idempotent; claims not open-world.*`tenant_id`/);
  assert.match(pointer, /Last diff.*1 tool added:?.*`read_status`.*1 tool removed:?.*`old_tool`/);
  assert.doesNotMatch(pointer, /unregistered(?:_|&#95;)tool/);
  assert.ok(pointer.indexOf('## API context') < pointer.indexOf('MCP servers this repo registers'));
  assert.equal(pointer.split('| `old_tool` |').length, 1, 'superseded declaration is not delivered');
});

test('MCP-1b learn --agents pushes MCP declarations without an HTTP contract', (t) => {
  const project = scratch(t);
  scopedInspection(project);
  const result = cli(project, ['learn', '--agents', '--json']);
  assert.equal(result.status, 0, result.out);
  assert.match(readFileSync(join(project.root, 'AGENTS.md'), 'utf8'), /MCP servers this repo registers[\s\S]*`read_status`/);
});

test('MCP-1b first connect includes records for registrations it is about to write', (t) => {
  const project = scratch(t, [inspection([tool('api_request')], MCP_SERVER_KEY, MCP_SERVER_KEY)]);
  rmSync(join(project.root, '.mcp.json'));
  const result = cli(project, ['connect', '--json']);
  assert.equal(result.status, 0, result.out);
  const first = readFileSync(join(project.root, 'AGENTS.md'), 'utf8');
  assert.match(first, /MCP servers this repo registers[\s\S]*`api_request`/);
  assert.equal(cli(project, ['connect', '--json']).status, 0);
  assert.equal(readFileSync(join(project.root, 'AGENTS.md'), 'utf8'), first);
});

test('MCP-1b connect attaches a newly discovered HTTP contract without losing earlier MCP records', (t) => {
  const project = scratch(t);
  const contextPath = join(project.root, LAYOUT.context);
  const before = JSON.parse(readFileSync(contextPath, 'utf8'));
  assert.equal(before.api.contract, null);
  writeFileSync(join(project.root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0',
    info: { title: 'new HTTP surface', version: '1' }, paths: { '/json': { get: {
      responses: { 200: { description: 'fixture response', content: { 'application/json': {
        schema: { type: 'object', properties: { slideshow: { type: 'object' } } },
      } } } },
    } } } }));
  const connected = cli(project, ['connect', '--json']);
  assert.equal(connected.status, 0, connected.out);
  const after = JSON.parse(readFileSync(contextPath, 'utf8'));
  assert.equal(after.api.contract, 'openapi.json');
  assert.deepEqual(after.mcp_inspections, before.mcp_inspections);
  assert.ok(after.operations['GET /json']);
  scopedInspection(project,'openapi.json');
  const learned = cli(project, ['learn', '--agents', '--limit=0', '--json']);
  assert.equal(learned.status, 0, learned.out);
  assert.equal(JSON.parse(learned.out).request_attempts, 0);
  assert.match(readFileSync(join(project.root, 'AGENTS.md'), 'utf8'), /MCP servers this repo registers[\s\S]*`read_status`/);
  assert.deepEqual(JSON.parse(readFileSync(fixtureContextFile(project.root), 'utf8')).mcp_inspections, before.mcp_inspections);
});

test('MCP-1b show returns the latest inspected declaration with claims and identity gap', (t) => {
  const project = scratch(t, [inspection([tool('old_tool')]), inspection([tool()], null)]);
  const result = cli(project, ['show', 'read_status']);
  assert.equal(result.status, 0, result.out);
  const shown = JSON.parse(result.out);
  assert.equal(shown.tool, 'read_status');
  assert.equal(shown.server.label, 'fixture');
  assert.equal(shown.server.name, null);
  assert.equal(shown.confidence, 'declared');
  assert.match(shown.identity_gap, /server\.name: null/);
  assert.deepEqual(shown.declaration.inputSchema.required, ['tenant_id']);
  assert.equal(shown.hint_claims.readOnlyHint, true);
});

test('MCP-1b delivered declarations are bounded and Markdown/secret safe, including unnamed servers', async (t) => {
  const { MAX_INLINE_MCP_TOOLS, renderInlineMcp } = await import('../lib/mcp-delivery.mjs');
  assert.ok(Number.isInteger(MAX_INLINE_MCP_TOOLS) && MAX_INLINE_MCP_TOOLS > 0);
  const hostile = tool('evil|`<img>');
  hostile.inputSchema.required = ['line\nbreak|`<script>'];
  const records = [inspection([hostile, ...Array.from({ length: MAX_INLINE_MCP_TOOLS }, (_, i) => tool(`tool_${i}`))], null)];
  const project = scratch(t, records);
  const result = cli(project, ['connect', '--json']);
  assert.equal(result.status, 0, result.out);
  const pointer = readFileSync(join(project.root, 'AGENTS.md'), 'utf8');
  assert.match(pointer, /identity unavailable \(server\.name: null\)/);
  assert.match(pointer, /``evil\\\|`<img>``/);
  assert.match(pointer, /``line break\\\|`<script>``/);
  assert.match(pointer, /1 more tool/);
  assert.doesNotMatch(pointer, new RegExp('\\| `tool_' + (MAX_INLINE_MCP_TOOLS - 1) + '` \\|'));
  // Synthetic inline credential matches the actual guard; entity-encoded
  // underscores in the old assertion could hide an unredacted sentinel.
  const ctx = { mcp_inspections: [{ ...inspection([tool('Bearer: literal_secret_token_12345678901234567890')]), at: '2026-01-01' }] };
  assert.doesNotMatch(renderInlineMcp(ctx, [{ key: 'fixture' }]).join('\n'), /literal_secret/);
});

test('MCP-1b tool lookup never merges same-named tools from different servers', async () => {
  const { inspectedToolFor } = await import('../lib/mcp-delivery.mjs');
  const ctx = { mcp_inspections: [inspection(), inspection([tool()], 'second-server', 'second')] };
  const ambiguous = inspectedToolFor(ctx, 'read_status');
  assert.equal(ambiguous.code, 'MCP_TOOL_AMBIGUOUS');
  assert.deepEqual(ambiguous.servers, ['fixture', 'second']);
  assert.equal(inspectedToolFor(ctx, 'fixture/read_status').server.label, 'fixture');
});

test('MCP-1b own MCP server delivers inspected declaration facts within the default request budget', async (t) => {
  const project = scratch(t);
  const fixture = await start();
  t.after(() => fixture.close());
  const child = spawn(process.execPath, [SERVER], { cwd: project.root,
    env: { ...project.env, API_BASE_URL: fixture.origin, API_BUDGET: '800' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const reply = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('server reply timed out')), 10000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.split('\n')[0]));
    });
    child.on('error', reject);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'api_request', arguments: { path: '/read_status', method: 'GET' },
    } })}\n`);
  });
  const out = JSON.parse(reply.result.content[0].text);
  assert.equal(out.known.tool, 'read_status');
  assert.equal(out.known.confidence, 'declared');
  assert.equal(out.known.server.label, 'fixture');
  assert.deepEqual(out.known.required_inputs, ['tenant_id']);
  assert.equal(out.known.hint_claims.readOnlyHint, true);
});

test('MCP-1b same-path HTTP known facts survive MCP enrichment and context-off disables both', async (t) => {
  const project = scratch(t, [inspection([tool('json')])]);
  const path = join(project.root, LAYOUT.context);
  const context = JSON.parse(readFileSync(path, 'utf8'));
  context.operations['GET /json'] = { effect: 'read', notes: ['requires tenant scope'], fields: {} };
  writeFileSync(path, JSON.stringify(context));
  const fixture = await start();
  t.after(() => fixture.close());
  const script = `import { apiRequest } from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)}; console.log(JSON.stringify(await apiRequest({method:'GET',path:'/json',budget:2000})));`;
  const request = off => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: project.root,
      env: { ...project.env, API_CONTEXT_OFF: off, API_BASE_URL: fixture.origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
  const out = await request('0');
  assert.equal(out.known.op, 'GET /json');
  assert.deepEqual(out.known.notes, ['requires tenant scope']);
  assert.equal(out.known.mcp.tool, 'json');
  assert.equal((await request('1')).known, null);
});
