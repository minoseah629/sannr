import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summaryCell } from "../lib/ci.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "test/fixtures/mcp-inspect-server.mjs");
const example = () => ({
  at: "2026-09-07T00:00:00.000Z",
  server: { name: "fixture", version: "2", protocolVersion: "2025-11-25", transport: "stdio", label: "team fixture" },
  initialized: true, transport: "stdio", capabilities: { tools: {} }, instructions: "Read the declarations.", malformed_frames: 0,
  declared: {
    tools: [{ name: "lookup", inputSchema: { type: "object", required: ["id"], properties: {
      id: { type: "string", examples: ["DO_NOT_RENDER_EXAMPLE"] }, count: { type: "integer", default: 987654 },
    } }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }],
    resources: [{ uri: "fixture://status", mimeType: "application/json" }],
    resourceTemplates: [{ uriTemplate: "fixture://items/{id}", mimeType: "text/plain" }],
    prompts: [{ name: "explain", arguments: [{ name: "topic", required: true }, { name: "style" }] }],
  }, measured: [],
});
const render = async (record, options) => (await import("../lib/mcp-report.mjs")).renderMcpReport(record, options);

test("MCP-1a report renders identity, every declaration and annotation as claims, without example values", async () => {
  const out = await render(example());
  for (const value of ["fixture", "team fixture", "2025-11-25", "Read the declarations.", "lookup", "claims read-only", "claims not destructive", "claims idempotent", "claims not open-world", "id: string", "count: integer", "fixture://status", "fixture://items/{id}", "application/json", "explain", "topic", "style"])
    assert.ok(out.includes(value), value);
  assert.match(out, /Required inputs/); assert.match(out, /Optional inputs/); assert.match(out, /Output schema/);
  assert.doesNotMatch(out, /DO_NOT_RENDER_EXAMPLE|987654|is read-only/);
});

test("MCP report explicitly identifies missing server identity and unclaimed hints", async () => {
  const record = example(); record.server = { name: null }; record.declared.tools[0].annotations = {};
  const out = await render(record);
  assert.match(out, /identity unavailable/i);
  for (const hint of ["read-only", "destructive", "idempotent", "open-world"]) assert.ok(out.includes(`no ${hint} claim`));
});

test("MCP summary escapes all server cells through the CI escaper and redacts URI userinfo", async () => {
  const record = example(); const hostile = "pipe|<script>_tool_\nnext";
  record.declared.tools[0].name = hostile;
  record.declared.resources[0].uri = "https://person:private@example.invalid/resource";
  const out = await render(record, { gfm: true });
  assert.ok(out.includes(summaryCell(hostile)));
  assert.doesNotMatch(out, /person:private|<script>|\|<script>/);
  assert.match(out, /example.invalid\/resource/);
});

test("MCP report handles a long declaration string without quadratic URI scanning", () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { renderMcpReport } from "./lib/mcp-report.mjs"; renderMcpReport({ server: { name: "a".repeat(100000) } });'], { cwd: root, encoding: "utf8", timeout: 2000 });
  assert.equal(run.status, 0, run.error?.code ?? run.stderr);
});

test("MCP report names changes, failed lists, malformed frames and observed schema drift", async () => {
  const record = example(); record.malformed_frames = 2;
  record.declared.prompts_error = { code: -32601, message: "Method not found" };
  record.diff = { since: "2026-09-06T00:00:00.000Z", tools: { added: ["new_tool"], removed: ["old_tool"], changed: [{ name: "lookup", changes: ["required field added: id", "readOnlyHint changed: false → true"] }] }, resources: { added: [], removed: [], changed: [] }, prompts: { added: [], removed: [], changed: [] } };
  record.measured = [{ tool: "lookup", observed: { matches_output_schema: false, missing: ["status"], unexpected: ["extra"], result_kind: "structured" } }];
  const out = await render(record);
  for (const value of ["since 2026-09-06T00:00:00.000Z", "new_tool", "old_tool", "required field added: id", "readOnlyHint changed", "prompts/list", "-32601", "Method not found", "malformed_frames: 2", "status", "extra", "structured"])
    assert.ok(out.includes(value), value);
  assert.match(out, /false|mismatch/);
});

test("MCP report makes an unchanged re-inspection readable", async () => {
  const record = example(); const unchanged = { added: [], removed: [], changed: [] };
  record.diff = { since: "2026-09-06T00:00:00.000Z", tools: unchanged, resources: unchanged, prompts: unchanged };
  assert.match(await render(record), /since 2026-09-06T00:00:00.000Z: no declaration changes/);
});

test("MCP diff reports incomplete comparisons and initialization metadata changes", async () => {
  const record = example(); const unchanged = { added: [], removed: [], changed: [] };
  record.diff = { since: "2026-09-06T00:00:00.000Z", tools: unchanged, resources: { ...unchanged, unavailable: ["previous resources list failed", "current resources list failed"] }, prompts: unchanged, server: ["version changed"], capabilities: "capabilities changed", instructions: "instructions changed" };
  const out = await render(record);
  for (const value of ["comparison incomplete", "previous resources list failed", "current resources list failed", "version changed", "capabilities changed", "instructions changed"]) assert.ok(out.includes(value), value);
  assert.doesNotMatch(out, /no declaration changes/);
});

test("MCP argument options parse objects without prototype hazards or printing invalid values", async () => {
  const { parseMcpInspectOptions } = await import("../lib/mcp-options.mjs");
  const parsed = parseMcpInspectOptions(["node", "server.mjs", "--execute", "__proto__", "--args", '__proto__={"id":"kept-in-memory"}', "--label", "team", "--json", "--summary", "report.md"]);
  assert.equal(Object.getPrototypeOf(parsed.toolArgs), null);
  assert.equal(parsed.toolArgs.__proto__.id, "kept-in-memory");
  assert.deepEqual(parsed.args, ["server.mjs"]); assert.equal(parsed.label, "team");
  for (const raw of ["lookup=private-invalid-json", "lookup=[]", "lookup=null", "lookup=3"]) {
    assert.throws(() => parseMcpInspectOptions(["node", "server.mjs", "--args", raw]), (e) => e.code === "MCP_ARGS_INVALID" && !e.message.includes("private-invalid-json"));
  }
});

test("MCP CLI --json emits one stored-identity document with a data diff and --summary writes escaped GFM", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-report-cli-")));
  try {
    const args = [join(root, "bin/cli.mjs"), "mcp", "inspect", process.execPath, fixture, "--label", "report fixture", "--json", "--summary", join(dir, "summary.md")];
    const first = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(first.stdout); assert.equal(report.server.label, "report fixture");
    assert.match(readFileSync(join(dir, "summary.md"), "utf8"), /\| Tool \|/);
    const second = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    const later = JSON.parse(second.stdout); assert.equal(later.diff.since, report.at); assert.equal(later.diff_from, report.at);
    assert.equal(JSON.stringify(later).includes(fixture), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP summary refuses the context file and symlink/hardlink destinations before inspection", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-report-paths-")));
  try {
    const args = [join(root, "bin/cli.mjs"), "mcp", "inspect", process.execPath, fixture];
    const first = spawnSync(process.execPath, [...args, "--json"], { cwd: dir, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const context = readFileSync(join(dir, CONTEXT_FILE), "utf8");
    const victim = join(dir, "victim.txt"); writeFileSync(victim, "untouched");
    const symlink = join(dir, "private-summary-symlink"); symlinkSync(victim, symlink);
    const hardlink = join(dir, "private-summary-hardlink"); linkSync(victim, hardlink);
    mkdirSync(join(dir, "destination"));
    const alias = join(dir, "private-summary-parent"); symlinkSync(join(dir, "destination"), alias);
    for (const path of [join(dir, CONTEXT_FILE), symlink, hardlink, join(alias, "report.md")]) {
      const out = spawnSync(process.execPath, [...args, "--summary", path], { cwd: dir, encoding: "utf8" });
      assert.notEqual(out.status, 0, "unsafe summary destination must fail");
      assert.match(out.stderr, /MCP_SUMMARY_UNSAFE_PATH/);
      assert.equal(`${out.stdout}${out.stderr}`.includes(path), false, "unsafe path must not be printed");
      assert.equal(readFileSync(join(dir, CONTEXT_FILE), "utf8"), context, "invalid summary path must fail before recording");
      assert.equal(readFileSync(victim, "utf8"), "untouched");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("MCP worked example agrees with the identity and complete input declaration announced by the checked-in server", async () => {
  const { inspectMcp } = await import("../lib/mcp-inspect.mjs");
  const inspected = await inspectMcp({ command: process.execPath, args: [join(root, "server.mjs")] });
  const doc = readFileSync(join(root, "docs/mcp.md"), "utf8");
  assert.ok(doc.includes(`server announces \`${inspected.server.name}\``), "document the initialize identity, not an inferred product name");
  const requestTool = inspected.declared.tools.find(tool => tool.name === "api_request");
  assert.ok(requestTool, "the worked example describes the API request tool");
  assert.ok(inspected.declared.tools.some(tool => tool.name === "api_saved_requests"), "saved requests are also discoverable");
  const names = Object.keys(requestTool.inputSchema.properties);
  assert.ok(doc.includes(`${names.length} input fields`));
  for (const name of names) assert.ok(doc.includes(`| ${name} |`), `missing documented input field ${name}`);
});
