import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectMcp, storeMcpInspection } from '../lib/mcp-inspect.mjs';
import { diffMcpInspection } from '../lib/mcp-history.mjs';
import { renderInlineMcp, inspectedToolFor } from '../lib/mcp-delivery.mjs';
import { renderMcpReport } from '../lib/mcp-report.mjs';

const source = readFileSync(new URL('./fixtures/mcp-memory-server.mjs', import.meta.url), 'utf8');
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-digest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('MCP-1c identity digest distinguishes enum declarations whose promoted schemas are identical', async t => {
  const root = scratch(t), path = join(root, 'server.mjs');
  writeFileSync(path, source);
  const first = await inspectMcp({ command: process.execPath, args: [path], cwd: root });
  writeFileSync(path, source.replaceAll('ENUM_VALUE_NOT_STORED', 'OTHER_ENUM_VALUE_NOT_STORED'));
  const second = await inspectMcp({ command: process.execPath, args: [path], cwd: root });
  assert.deepEqual(first.declared.tools, second.declared.tools);
  assert.match(first.tool_declarations_digest, /^[a-f0-9]{64}$/);
  assert.notEqual(first.tool_declarations_digest, second.tool_declarations_digest);
  first.server.label = 'first'; second.server.label = 'second';
  const ctx = { mcp_inspections: [first, second] };
  assert.equal(renderInlineMcp(ctx, [{ key: 'first' }, { key: 'second' }]).filter(line => line.startsWith('Server:')).length, 2);
  assert.equal(inspectedToolFor(ctx, 'constrained').code, 'MCP_TOOL_AMBIGUOUS');
  const diff = diffMcpInspection(first, second);
  assert.equal(diff.tool_declarations, 'tool declarations changed (details not retained)');
  assert.match(renderMcpReport({ ...second, diff }), /tool declarations changed \(details not retained\)/);
  assert.match(renderInlineMcp({ mcp_inspections: [{ ...second, diff }] }, [{ key: 'second' }]).join('\n'), /Last diff.*tool declarations changed \(details not retained\)/);
  const record = storeMcpInspection(root, second, { returnRecord: true });
  assert.equal(record.tool_declarations_digest, second.tool_declarations_digest);
  assert.doesNotMatch(readFileSync(join(root, LAYOUT.context), 'utf8'), /ENUM_VALUE_NOT_STORED/);
});

test('MCP-1c tool digest canonicalizes object keys and tool ordering and bounds traversal', async () => {
  const { mcpToolDeclarationsDigest } = await import('../lib/mcp-history.mjs');
  assert.equal(typeof mcpToolDeclarationsDigest, 'function');
  const tools = [{ name: 'alpha', inputSchema: { type: 'object', properties: { query: { type: 'string', enum: ['one'] } } } }, { name: 'beta' }];
  const reordered = [{ name: 'beta' }, { inputSchema: { properties: { query: { enum: ['one'], type: 'string' } }, type: 'object' }, name: 'alpha' }];
  assert.equal(mcpToolDeclarationsDigest(tools), mcpToolDeclarationsDigest(reordered));
  let nested = { type: 'string' };
  for (let i = 0; i < 70; i++) nested = { items: nested };
  assert.throws(() => mcpToolDeclarationsDigest([{ name: 'nested', inputSchema: nested }]), { code: 'MCP_OVERSIZED' });
  assert.throws(() => mcpToolDeclarationsDigest(Array.from({ length: 101 }, () => ({ name: 'tool' }))), { code: 'MCP_OVERSIZED' });
});

test('MCP-1c undeclared or failed tools have no contract digest', async t => {
  const root = scratch(t), path = join(root, 'server.mjs');
  for (const fixture of [source.replace('capabilities: { tools: {}, resources: {}, prompts: {} }', 'capabilities: {}'), source.replace('send(msg.id, { tools });', 'fail(msg.id, "fixture list unavailable");')]) {
    writeFileSync(path, fixture);
    const out = await inspectMcp({ command: process.execPath, args: [path], cwd: root });
    assert.equal(out.tool_declarations_digest, undefined);
  }
});

test('MCP-1c storage only retains well-formed complete tool declaration digests', t => {
  const root = scratch(t);
  const inspection = { server: { name: 'fixture' }, declared: { tools: [] } };
  for (const invalid of ['not-a-digest', 'a'.repeat(63), 'A'.repeat(64), { value: 'DO_NOT_STORE' }]) {
    assert.equal(storeMcpInspection(root, { ...inspection, tool_declarations_digest: invalid }, { returnRecord: true }).tool_declarations_digest, undefined);
  }
  for (const declared of [{ tools: { state: 'not_declared' } }, { tools: [], tools_error: { code: -32000, message: 'list failed' } }]) {
    assert.equal(storeMcpInspection(root, { ...inspection, declared, tool_declarations_digest: 'a'.repeat(64) }, { returnRecord: true }).tool_declarations_digest, undefined);
  }
});
