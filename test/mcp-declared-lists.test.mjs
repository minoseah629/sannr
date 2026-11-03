import { LAYOUT } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMcp, storeMcpInspection } from '../lib/mcp-inspect.mjs';
import { diffMcpInspection } from '../lib/mcp-history.mjs';
import { renderMcpReport } from '../lib/mcp-report.mjs';

const ownServer = fileURLToPath(new URL('../server.mjs', import.meta.url));
const memorySource = readFileSync(new URL('./fixtures/mcp-memory-server.mjs', import.meta.url), 'utf8');
const notDeclared = { state: 'not_declared' };
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-declared-lists-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(root, transform = source => source) {
  const server = join(root, 'server.mjs'), log = join(root, 'calls.log');
  writeFileSync(server, transform(memorySource));
  return { command: process.execPath, args: [server, 'normal', log], cwd: root, log };
}
const ownInspection = root => inspectMcp({ command: process.execPath, args: [ownServer], cwd: root });

test('MCP-1c own server inspector report names undeclared resources and prompts without list errors', async t => {
  const out = await ownInspection(project(t));
  const report = renderMcpReport(out);
  assert.match(report, /Resources: not declared by this server/);
  assert.match(report, /Prompts: not declared by this server/);
  assert.doesNotMatch(report, /List failed: (?:resources|prompts)/);
  assert.equal(out.declared.resources_error, undefined);
  assert.equal(out.declared.prompts_error, undefined);
});

test('MCP-1c own server record persists not_declared states and stable diffs do not compare absent lists', async t => {
  const root = project(t), out = await ownInspection(root);
  const first = storeMcpInspection(root, out, { returnRecord: true });
  const second = storeMcpInspection(root, out, { returnRecord: true });
  for (const list of ['resources', 'resourceTemplates', 'prompts']) {
    assert.deepEqual(first.declared[list], notDeclared, list);
    assert.equal(first.declared[`${list}_error`], undefined);
  }
  assert.deepEqual(second.diff.resources, notDeclared);
  assert.deepEqual(second.diff.prompts, notDeclared);
  assert.doesNotMatch(JSON.stringify(second.diff), /comparison unavailable|list failed|unavailable/);
  assert.match(renderMcpReport(second), /no declaration changes/);
  assert.doesNotMatch(renderMcpReport(second), /comparison incomplete|comparison unavailable/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, LAYOUT.context), 'utf8')).mcp_inspections[1], second);
});

test('MCP-1c no undeclared list is requested, including tools and resource templates', async t => {
  const root = project(t);
  const target = fixture(root, source => source.replace('capabilities: { tools: {}, resources: {}, prompts: {} }', 'capabilities: {}'));
  const out = await inspectMcp(target);
  const methods = readFileSync(target.log, 'utf8').trim().split('\n');
  assert.equal(methods[0], 'initialize');
  assert.deepEqual(methods.filter(method => method.endsWith('/list')), []);
  for (const key of ['tools', 'resources', 'resourceTemplates', 'prompts']) assert.deepEqual(out.declared[key], notDeclared);
  assert.match(renderMcpReport(out), /Tools: not declared by this server/);
  assert.deepEqual(storeMcpInspection(root, out, { returnRecord: true }).declared.tools, notDeclared);
  await assert.rejects(() => inspectMcp({ ...target, execute: ['lookup'], toolArgs: { lookup: { query: 'value' } } }), { code: 'MCP_TOOL_NOT_DECLARED' });
});

test('MCP-1c memory fixture still enumerates all three declared capabilities and compares their lists', async t => {
  const root = project(t), target = fixture(root);
  const out = await inspectMcp(target);
  assert.deepEqual(readFileSync(target.log, 'utf8').trim().split('\n'), ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
  for (const key of ['tools', 'resources', 'resourceTemplates', 'prompts']) assert.ok(Array.isArray(out.declared[key]), key);
  const report = renderMcpReport(out);
  assert.match(report, /Resources \(1\)/);
  assert.match(report, /Prompts \(1\)/);
  assert.doesNotMatch(report, /not declared by this server|List failed/);
  const first = storeMcpInspection(root, out, { returnRecord: true });
  const diff = diffMcpInspection(first, out);
  for (const key of ['tools', 'resources', 'prompts']) assert.deepEqual(diff[key], { added: [], removed: [], changed: [] });
});

test('MCP-1c a declared list failing at call time remains a named report, record and diff error', async t => {
  const root = project(t);
  const target = fixture(root, source => source.replace('send(msg.id, { resources: [{ name: "status", uri: "fixture://reader:ordinary-password@local/status", mimeType: "application/json" }] });', 'fail(msg.id, "fixture resources unavailable");'));
  const out = await inspectMcp(target);
  assert.ok(Array.isArray(out.declared.resources));
  assert.deepEqual(out.declared.resources_error, { code: 'MCP_LIST_FAILED', message: 'MCP server rejected the list request' });
  const first = storeMcpInspection(root, out, { returnRecord: true });
  const second = storeMcpInspection(root, out, { returnRecord: true });
  assert.deepEqual(first.declared.resources_error, out.declared.resources_error);
  assert.deepEqual(second.diff.resources.unavailable, ['previous resources list failed', 'current resources list failed']);
  const report = renderMcpReport(second);
  assert.match(report, /List failed: resources\/list — MCP_LIST_FAILED: MCP server rejected the list request/);
  assert.match(report, /resources comparison unavailable/);
  assert.doesNotMatch(report, /Resources: not declared by this server/);
});

test('MCP-1c capability declaration transitions are explicit, including empty lists', () => {
  const previous = { at: '2026-09-07T00:00:00.000Z', declared: { tools: notDeclared, resources: notDeclared, resourceTemplates: notDeclared, prompts: notDeclared } };
  const current = { ...previous, declared: { tools: [], resources: [], resourceTemplates: [], prompts: [] } };
  const diff = diffMcpInspection(previous, current);
  for (const key of ['tools', 'resources', 'prompts']) {
    assert.deepEqual(diff[key].declaration, { previous: 'not_declared', current: 'declared' });
    assert.deepEqual(diffMcpInspection(current, previous)[key].declaration, { previous: 'declared', current: 'not_declared' });
  }
  const report = renderMcpReport({ ...current, diff });
  assert.match(report, /resources capability: not declared → declared/);
  assert.doesNotMatch(report, /no declaration changes/);
});

test('MCP-1c first reinspection ignores legacy failed lists for capabilities that were never declared', async t => {
  const root = project(t), current = await ownInspection(root);
  const previous = structuredClone(current);
  previous.at = '2026-09-07T00:00:00.000Z';
  for (const key of ['resources', 'resourceTemplates', 'prompts']) previous.declared[key] = [];
  for (const key of ['resources', 'prompts']) previous.declared[`${key}_error`] = { code: -32601, message: 'Method not found' };
  const immutable = JSON.stringify(previous);
  const diff = diffMcpInspection(previous, current);
  assert.deepEqual(diff.resources, notDeclared);
  assert.deepEqual(diff.prompts, notDeclared);
  assert.equal(JSON.stringify(previous), immutable);
  assert.doesNotMatch(renderMcpReport({ ...current, diff }), /comparison unavailable|capability:|list failed/);
});
