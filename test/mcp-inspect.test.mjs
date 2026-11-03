import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectMcp } from "../lib/mcp-inspect.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "mcp-inspect-server.mjs");

test("MCP inspection enumerates declarations without calling tools", async () => {
  const out = await inspectMcp({ command: process.execPath, args: [fixture] });
  assert.equal(out.declared.tools.length, 2);
  assert.equal(out.declared.resources.length, 1);
  assert.equal(out.declared.prompts.length, 1);
  assert.deepEqual(out.measured, []);
});

test("MCP execution is per-tool and read-only gated", async () => {
  const out = await inspectMcp({ command: process.execPath, args: [fixture], execute: ["read_status"] });
  assert.equal(out.measured.length, 1);
  await assert.rejects(() => inspectMcp({ command: process.execPath, args: [fixture], execute: ["mutate"] }), { code: "MCP_TOOL_NOT_READ_ONLY" });
  const unsafe = await inspectMcp({ command: process.execPath, args: [fixture], execute: ["mutate"], executeUnsafe: true });
  assert.equal(unsafe.measured.length, 1);
});

test("MCP declaration facts can be stored without a prior API context", async () => {
  const { storeMcpInspection } = await import("../lib/mcp-inspect.mjs");
  const root = mkdtempSync(join(tmpdir(), "mcp-store-"));
  const inspection = await inspectMcp({ command: process.execPath, args: [fixture] });
  storeMcpInspection(root, inspection);
  const stored = JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8"));
  assert.equal(stored.mcp_inspections[0].declared.tools.length, 2);
  assert.equal(JSON.stringify(stored).includes(fixture), false, "server command must not be stored");
});

test("MCP-1a complete HTTP inspection uses the session and SSE for declared and measured facts", async () => {
  const { startMcpHttpFixture } = await import('./fixtures/mcp-http-session-server.mjs');
  const fixture = await startMcpHttpFixture({ mode: 'inspection' });
  try {
    const out = await inspectMcp({ url: fixture.url, execute: ['read_status'], toolArgs: { read_status: { count: 2 } } });
    assert.equal(out.server.name, 'http-session');
    assert.equal(out.server.transport, 'streamable-http');
    assert.equal(out.declared.tools.length, 1);
    assert.equal(out.declared.resources_error, undefined);
    assert.equal(out.declared.prompts_error, undefined);
    assert.equal(out.measured[0].observed.matches_output_schema, true);
    assert.deepEqual(out.declared.resources, { state: 'not_declared' });
    assert.deepEqual(out.declared.prompts, { state: 'not_declared' });
    assert.deepEqual(fixture.seen.map(message => message.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(JSON.stringify(out).includes('fixture-session'), false);
  } finally { await fixture.close(); }
});
