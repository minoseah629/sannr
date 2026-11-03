import { LAYOUT, layoutFor } from "../lib/layout.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMcp, storeMcpInspection } from '../lib/mcp-inspect.mjs';
import { summaryCell } from '../lib/ci.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const fixtureSource = readFileSync(new URL('./fixtures/mcp-memory-server.mjs', import.meta.url), 'utf8');
const git = (root, args) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root, stdio: 'pipe' });
const cli = (root, args) => spawnSync(process.execPath, [CLI, 'audit', '.', '--ci', '--no-execute', ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });

async function project(t, { key = 'fixture-reader', commitRecord = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'fixture.mjs'), log = join(root, 'calls.log');
  writeFileSync(fixture, fixtureSource);
  const registration = { command: process.execPath, args: [fixture, 'normal', log] };
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { [key]: registration } }));
  const inspection = await inspectMcp({ ...registration, label: key });
  storeMcpInspection(root, inspection);
  git(root, ['init', '-q']);
  git(root, ['add', '.mcp.json', 'fixture.mjs', ...(commitRecord ? [LAYOUT.context] : [])]);
  git(root, ['commit', '-qm', 'accepted fixture declarations']);
  writeFileSync(log, '');
  return { root, fixture, log, key };
}

function changeDeclarations(fixture) {
  writeFileSync(fixture, fixtureSource
    .replace('readOnlyHint: true, destructiveHint: false', 'readOnlyHint: false, destructiveHint: true')
    .replace('required: ["query"]', 'required: ["query", "limit"]')
    .replace('name: "wrongtype"', 'name: "new_tool"')
    .replace('description: "Find a fixture entry"', 'description: "Changed fixture declaration"'));
}

test('MCP-1b audit --ci enumerates against committed declarations, reports tool/hint/required drift and never rewrites records', async (t) => {
  const { root, fixture, log } = await project(t);
  changeDeclarations(fixture);
  const contextPath = join(root, LAYOUT.context);
  // A newer, uncommitted inspection must not silently bless the changed declarations.
  storeMcpInspection(root, await inspectMcp({ command: process.execPath, args: [fixture], label: 'fixture-reader' }));
  const before = readFileSync(contextPath, 'utf8');
  const summary = join(root, 'summary.md');
  const report = cli(root, ['--report-only', '--json', '--summary', summary]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const out = JSON.parse(report.stdout);
  assert.equal(out.mcp.baseline, `HEAD:${LAYOUT.context}`);
  assert.equal(out.mcp.checked, 1);
  assert.deepEqual(out.mcp.drift.map(row => row.kind).sort(), ['mcp-tool-added', 'mcp-tool-changed', 'mcp-tool-removed']);
  assert.equal(out.mcp.drift.find(row => row.kind === 'mcp-tool-added').op, 'new_tool');
  assert.equal(out.mcp.drift.find(row => row.kind === 'mcp-tool-removed').op, 'wrongtype');
  const changed = out.mcp.drift.find(row => row.kind === 'mcp-tool-changed');
  assert.equal(changed.op, 'lookup');
  assert.match(changed.detail, /claim readOnlyHint changed: true → false/);
  assert.match(changed.detail, /claim destructiveHint changed: false → true/);
  assert.match(changed.detail, /input required field added: limit/);
  assert.equal(out.would_fail, 3);
  const enforcing = cli(root, ['--json']);
  assert.equal(enforcing.status, 1, enforcing.stdout + enforcing.stderr);
  assert.equal(readFileSync(contextPath, 'utf8'), before);
  assert.equal(readFileSync(log, 'utf8').includes('tools/call'), false);
  assert.match(readFileSync(log, 'utf8'), /tools\/list/);
  assert.match(readFileSync(summary, 'utf8'), /MCP declaration witness/);
  assert.match(readFileSync(summary, 'utf8'), /claim readOnlyHint changed: true → false/);
  assert.equal(JSON.stringify(out.mcp).includes(fixture), false, 'launch args stay out of reports');
});

test('MCP-1b audit --ci names missing commands as coverage gaps and keeps enforcing green', async (t) => {
  const { root } = await project(t);
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'fixture-reader': { command: 'sannr-fixture-command-does-not-exist', args: [] } } }));
  const report = cli(root, ['--json']);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const out = JSON.parse(report.stdout);
  assert.equal(out.mcp.drift.length, 0);
  assert.equal(out.mcp.coverage_gaps[0].server, 'fixture-reader');
  assert.equal(out.mcp.coverage_gaps[0].code, 'MCP_COMMAND_NOT_FOUND');
  assert.ok(out.mcp.coverage_gaps[0].reason);
});

test('MCP-1b audit --ci names records that are not committed and does not spawn their servers', async (t) => {
  const { root, log } = await project(t, { commitRecord: false });
  const report = cli(root, ['--json']);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const out = JSON.parse(report.stdout);
  assert.equal(out.mcp.checked, 0);
  assert.equal(out.mcp.coverage_gaps[0].code, 'MCP_RECORD_NOT_COMMITTED');
  assert.equal(readFileSync(log, 'utf8'), '');
});

test('MCP-1b audit --ci uses the summary escaper for MCP labels and drift details', async (t) => {
  const key = 'fixture|<tag>*[claim]';
  const { root, fixture } = await project(t, { key });
  changeDeclarations(fixture);
  const summary = join(root, 'summary.md');
  const report = cli(root, ['--report-only', '--summary', summary]);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const markdown = readFileSync(summary, 'utf8');
  assert.ok(markdown.includes(summaryCell(key)));
  assert.equal(markdown.includes(key), false);
  assert.ok(report.stdout.includes(summaryCell(key)), 'terminal witness uses the same escaper');
});

test('MCP-1b audit --ci refuses a summary that would rewrite the inspected store or registration', async (t) => {
  const { root } = await project(t);
  for (const name of [LAYOUT.context, '.mcp.json']) {
    const path = join(root, name), before = readFileSync(path, 'utf8');
    const report = cli(root, ['--report-only', '--summary', path]);
    assert.equal(report.status, 1);
    assert.match(report.stderr + report.stdout, /SUMMARY_TARGET_PROTECTED/);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('MCP-1b a failed tools/list is a named comparison gap, never a removed-tool finding', async (t) => {
  const { root, fixture } = await project(t);
  writeFileSync(fixture, fixtureSource.replace('send(msg.id, { tools });', 'fail(msg.id, "fixture list unavailable");'));
  const report = cli(root, ['--json']);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const out = JSON.parse(report.stdout);
  assert.deepEqual(out.mcp.drift, []);
  assert.equal(out.mcp.coverage_gaps[0].code, 'MCP_TOOLS_COMPARISON_UNAVAILABLE');
  assert.match(out.mcp.coverage_gaps[0].reason, /current tools list failed/);
});

test('MCP-1b resources/list failure does not prevent a complete tools witness', async (t) => {
  const { root, fixture } = await project(t);
  writeFileSync(fixture, fixtureSource.replace('send(msg.id, { resources: [{ name: "status", uri: "fixture://reader:ordinary-password@local/status", mimeType: "application/json" }] });', 'fail(msg.id, "fixture resources unavailable");'));
  const report = cli(root, ['--json']);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  const out = JSON.parse(report.stdout);
  assert.equal(out.mcp.checked, 1);
  assert.deepEqual(out.mcp.coverage_gaps, []);
});

test('MCP-1b an accepted HTTP finding baseline cannot accept MCP declaration drift', async (t) => {
  const { root, fixture } = await project(t);
  changeDeclarations(fixture);
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'fixture' }, paths: { '/status': { get: { responses: { 200: { description: 'ok' } } } } } }));
  const initial = cli(root, ['--json']);
  assert.equal(initial.status, 1);
  assert.match(initial.stdout + initial.stderr, /BASELINE_NOT_FOUND/);
  writeFileSync(join(root, LAYOUT.baseline), JSON.stringify({ version: 1, findings: [] }));
  const { mcp } = JSON.parse(cli(root, ['--report-only', '--json']).stdout);
  // Copy the exact same drift keys into the HTTP baseline. The MCP witness is
  // independently tied to the committed inspection, so these never bless it.
  writeFileSync(join(root, LAYOUT.baseline), JSON.stringify({ version: 1, findings: mcp.drift }));
  const report = cli(root, ['--json']);
  assert.equal(report.status, 1, report.stdout + report.stderr);
  assert.equal(JSON.parse(report.stdout).mcp.drift.length, 3);
});

test('MCP-1b committed inspection baseline resolves from a nested project directory', async (t) => {
  const { root, fixture } = await project(t);
  const nested = join(root, 'nested');
  mkdirSync(nested);
  for (const name of ['.mcp.json', LAYOUT.context]) writeFileSync(join(nested, name), readFileSync(join(root, name)));
  git(root, ['add', 'nested']);
  git(root, ['commit', '-qm', 'nested accepted declarations']);
  changeDeclarations(fixture);
  const report = cli(nested, ['--report-only', '--json']);
  assert.equal(report.status, 0, report.stdout + report.stderr);
  assert.equal(JSON.parse(report.stdout).mcp.drift.length, 3);
});

test('MCP-1b renamed CI witness reads the renamed committed context through the brand seam', async (t) => {
  const { root, fixture } = await project(t);
  const renamedLayout = layoutFor('seamreader');
  const layoutUrl = new URL('../lib/layout.mjs', import.meta.url).href;
  const migrated = spawnSync(process.execPath, ['--input-type=module','-e',
    `const {migrateLayout}=await import(${JSON.stringify(layoutUrl)}); console.log(JSON.stringify(migrateLayout(process.cwd())));`], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, API_CONTEXT_PRODUCT_NAME: 'seamreader' },
  });
  assert.equal(migrated.status, 0, migrated.stdout + migrated.stderr);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'renamed accepted declarations']);
  changeDeclarations(fixture);
  const report = spawnSync(process.execPath, [CLI, 'audit', '.', '--ci', '--no-execute', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, API_CONTEXT_PRODUCT_NAME: 'seamreader' },
  });
  assert.equal(report.status, 1, report.stdout + report.stderr);
  const out = JSON.parse(report.stdout);
  assert.equal(out.mcp.baseline, `HEAD:${renamedLayout.context}`);
  assert.equal(out.mcp.checked, 1);
  assert.equal(out.mcp.drift.length, 3);
  assert.deepEqual(out.mcp.coverage_gaps, []);
});
