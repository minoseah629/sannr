import { MCP_SERVER_KEY } from '../lib/brand.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync,  rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInlineMcp, MAX_INLINE_MCP_TOOLS, inspectedToolFor } from '../lib/mcp-delivery.mjs';
import { discoverMcpRegistrations } from '../lib/mcp-registrations.mjs';
import { storeMcpInspection } from '../lib/mcp-inspect.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'bin/cli.mjs');
const tool = name => ({ name, inputSchema: { type: 'object', required: ['tenant_id'], properties: { tenant_id: { type: 'string' } } } });
const record = (label, tools = [tool('api_request')], name = 'own_server', version = '1') => ({
  at: '2026-09-07T00:00:00.000Z', server: { label, name, version },
  declared: { tools, resources: [], prompts: [] }, measured: [],
});
const hosts = ['claude-code', 'codex', 'cursor', 'vscode'];
const keys = ['own-server', 'own-server-codex', 'own-server-cursor', 'own-server-vscode'];
const registrations = keys.map((key, i) => ({ key, host: hosts[i] }));
const render = records => renderInlineMcp({ mcp_inspections: records }, registrations).join('\n');

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-polish-'));
  const home = mkdtempSync(join(tmpdir(), 'mcp-polish-home-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: root });
  // Exercise delivery into both hosts' full blocks when Claude guidance
  // already exists; a fresh project uses the AGENTS.md bridge instead.
  writeFileSync(join(root, 'CLAUDE.md'), 'Existing Claude project instructions.\n');
  const env = { ...process.env, HOME: home, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', API_EVIDENCE: join(root, 'evidence') };
  const cli = args => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  return { root, cli };
}

test('MCP-1c item 1 four connected hosts keep four records and deliver one own-server block', t => {
  const { root, cli } = project(t);
  mkdirSync(join(root, '.cursor')); mkdirSync(join(root, '.vscode'));
  cli(['connect', '--json']);
  // Keep connect's actual launch instructions, giving each host its own label.
  for (const [i, file, container] of [[0, '.mcp.json', 'mcpServers'], [2, '.cursor/mcp.json', 'mcpServers'], [3, '.vscode/mcp.json', 'servers']]) {
    const path = join(root, file), config = JSON.parse(readFileSync(path, 'utf8'));
    config[container][keys[i]] = config[container][MCP_SERVER_KEY]; delete config[container][MCP_SERVER_KEY];
    writeFileSync(path, JSON.stringify(config));
  }
  const codex = join(root, '.codex/config.toml');
  writeFileSync(codex, readFileSync(codex, 'utf8').replaceAll(`${MCP_SERVER_KEY}:managed-mcp`, `${keys[1]}:managed-mcp`)
    .replaceAll(`mcp_servers.${MCP_SERVER_KEY}`, `mcp_servers.${keys[1]}`));
  const wired = discoverMcpRegistrations(root);
  assert.equal(wired.length, 4);
  for (const registration of wired) assert.ok(registration.args.some(arg => arg === join(ROOT, 'server.mjs')));
  cli(['mcp', 'inspect', '--json']); cli(['mcp', 'inspect', '--json']);
  const records = JSON.parse(readFileSync(join(root, LAYOUT.context), 'utf8')).mcp_inspections;
  assert.deepEqual(records.map(row => row.server.label).sort(), [...keys, ...keys].sort());
  assert.ok(records.every(row => row.measured.length === 0));
  // The declaration reader remains legacy; authoring the refreshed pointer
  // uses the exact same saved inspections in a real current stack.
  createFixtureStack(root);
  writeFileSync(fixtureContextFile(root), readFileSync(join(root, LAYOUT.context)));
  cli(['learn', '--agents', '--json']);
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const pointer = readFileSync(join(root, file), 'utf8');
    assert.equal(pointer.match(/^Server:/gm)?.length, 1);
    assert.match(pointer, /registered as: `own-server` \(Claude Code\), `own-server-codex` \(Codex\), `own-server-cursor` \(Cursor\), `own-server-vscode` \(VS Code \/ Copilot\)/);
    assert.equal(pointer.match(/\| `api_request` \|/g)?.length, 1);
    assert.doesNotMatch(pointer, /Last diff|comparison unavailable|list failed/);
  }
  assert.equal(JSON.parse(cli(['show', 'api_request'])).tool, 'api_request');
});

test('MCP-1c item 1 inline budget counts unique declarations after identity grouping', () => {
  const tools = Array.from({ length: MAX_INLINE_MCP_TOOLS }, (_, i) => tool(`tool_${i}`));
  const pointer = render(keys.map(key => record(key, tools)));
  assert.equal(pointer.match(/^Server:/gm)?.length, 1);
  assert.equal(pointer.match(/^\| `tool_/gm)?.length, MAX_INLINE_MCP_TOOLS);
  assert.doesNotMatch(pointer, /more tools/);
});

test('MCP-1c item 1 identity grouping includes name, version and canonical tool declaration digest', () => {
  const a = record(keys[0]), b = record(keys[1]);
  b.declared.tools[0] = { inputSchema: b.declared.tools[0].inputSchema, name: 'api_request' };
  assert.equal(render([a, b]).match(/^Server:/gm)?.length, 1, 'object insertion order does not change identity');
  for (const variant of [record(keys[1], undefined, 'other'), record(keys[1], undefined, undefined, '2'), record(keys[1], [tool('different')])]) {
    assert.equal(render([a, variant]).match(/^Server:/gm)?.length, 2);
  }
  assert.equal(render([record(keys[0], undefined, null), record(keys[1], undefined, null)]).match(/^Server:/gm)?.length, 2, 'unknown identity is not proof of equivalence');
  assert.equal(inspectedToolFor({ mcp_inspections: [a, b] }, 'api_request').tool, 'api_request');
});

test('MCP-1c item 2 pointer identifiers are literal code spans with table-safe pipes and newlines', t => {
  const { root, cli } = project(t);
  const names = ['api_request', 'pipe|tool', 'line\nbreak', 'tick`<img>'];
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'own-server': { command: process.execPath, args: [join(ROOT, 'server.mjs')] } } }));
  storeMcpInspection(root, record(keys[0], names.map(tool)));
  cli(['connect', '--json']);
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const pointer = readFileSync(join(root, file), 'utf8');
    assert.match(pointer, /Server: `own_server` `1`/);
    assert.match(pointer, /\| `api_request` \|/);
    assert.match(pointer, /`tenant_id`/);
    assert.match(pointer, /\| `pipe\\\|tool` \|/);
    assert.match(pointer, /\| `line break` \|/);
    assert.match(pointer, /\| ``tick`<img>`` \|/);
    assert.doesNotMatch(pointer, /&#95;|&#96;|&lt;/);
    for (const row of pointer.split('\n').filter(row => row.startsWith('| `'))) assert.equal(row.split(/(?<!\\)\|/).length, 5, row);
  }
  const shown = JSON.parse(cli(['show', 'api_request']));
  assert.equal(shown.tool, 'api_request'); assert.equal(shown.server.name, 'own_server');
  assert.deepEqual(shown.declaration.inputSchema.required, ['tenant_id']);
});

test('MCP-1c item 3 pointer shows meaningful declaration changes only and names required input drift', () => {
  const row = record(keys[0]);
  row.diff = { since: row.at, tools: { added: [], removed: [], changed: [], unavailable: ['previous tools list failed'] }, resources: { state: 'not_declared' }, prompts: { state: 'not_declared' } };
  assert.doesNotMatch(render([row]), /Last diff|comparison unavailable/);
  row.diff.tools = { added: ['new_tool'], removed: [], changed: [{ name: 'api_request', changes: ['input required field added: tenant_id'] }] };
  assert.match(render([row]), /Last diff since .*: 1 tool added \(`new_tool`\); required inputs changed on `api_request` \(added: `tenant_id`\)/);
});

test('MCP-1c missing tool evidence cannot merge with a known empty declaration', () => {
  const missing = record(keys[0], []); delete missing.declared.tools;
  assert.equal(render([missing, record(keys[1], [])]).match(/^Server:/gm)?.length, 2);
});

test('MCP-1c diff budget bounds individual changes and quotes all field/error identifiers', () => {
  const row = record(keys[0]);
  row.diff = { since: row.at, tools: { changed: Array.from({ length: 6 }, (_, i) => ({ name: `tool_${i}`, changes: Array.from({ length: 100 }, (_, j) => `input required field added: ${'x'.repeat(160)}_${j}`) })) } };
  const line = render([row]).split('\n').find(line => line.startsWith('Last diff'));
  assert.ok(line.length < 2500, line.length);
  assert.match(line, /594 more changes omitted/);
  row.diff.tools.changed = [{ name: 'api_request', changes: ['input field type changed: tenant_id', 'output field added: <img src=x>'] }];
  row.declared.resources_error = { code: -32000, message: '<img src=x>' };
  const pointer = render([row]);
  assert.match(pointer, /input field type changed: `tenant_id`/);
  assert.match(pointer, /output field added: `<img src=x>`/);
  assert.match(pointer, /Resource declaration coverage gap: `-32000` — `<img src=x>`/);
});
