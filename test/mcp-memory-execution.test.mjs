import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectMcp, storeMcpInspection } from "../lib/mcp-inspect.mjs";

const fixture = fileURLToPath(new URL("./fixtures/mcp-memory-server.mjs", import.meta.url));
const scratch = (t) => { const dir = mkdtempSync(join(tmpdir(), "mcp-memory-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const inspect = (options = {}) => inspectMcp({ command: process.execPath, args: [fixture], ...options });
const stored = (root) => JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8")).mcp_inspections;
const record = (root, inspection) => storeMcpInspection(root, inspection, { returnRecord: true });
const sample = (name = "alpha") => ({ server: { name, version: "1", protocolVersion: "2025-11-25", transport: "stdio", label: name }, transport: "stdio", initialized: true, declared: { tools: [], resources: [], prompts: [] }, measured: [] });

test("MCP-1a identity comes from initialize and an explicit label never stores the launch command", async (t) => {
  const root = scratch(t);
  const out = await inspect({ label: "local-reader" });
  assert.deepEqual(out.server, { name: "memory-fixture", version: "1.2.3", protocolVersion: "2025-11-25", transport: "stdio", label: "local-reader" });
  assert.equal(out.instructions, "Only declarations are safe by default.");
  assert.deepEqual(out.capabilities, { tools: {}, resources: {}, prompts: {} });
  const saved = record(root, out);
  assert.deepEqual(saved.server, out.server);
  assert.equal(JSON.stringify(stored(root)).includes(fixture), false);
  assert.equal(JSON.stringify(stored(root)).includes(process.execPath), false);
});

test("MCP-1a missing server identity is explicit and anonymous inspections do not match", async (t) => {
  const root = scratch(t);
  const out = await inspect({ args: [fixture, "anonymous"] });
  assert.equal(out.server.name, null);
  const first = record(root, out);
  const second = record(root, out);
  assert.equal(first.server.name, null);
  assert.equal(second.diff_from ?? null, null);
});

test("MCP-1a diff names tool declaration changes and resource/prompt additions, removals and changes", (t) => {
  const root = scratch(t);
  const before = sample();
  before.declared.tools = [{ name: "lookup", description: "before", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } }, { name: "old_tool", inputSchema: { type: "object" } }];
  before.declared.resources = [{ name: "status", uri: "fixture://status", mimeType: "text/plain" }, { name: "old", uri: "fixture://old" }];
  before.declared.prompts = [{ name: "explain", arguments: [{ name: "topic" }] }, { name: "old_prompt" }];
  const first = record(root, before);
  const snapshot = JSON.stringify(stored(root)[0]);
  const after = structuredClone(before);
  after.declared.tools = [{ name: "lookup", description: "after", inputSchema: { type: "object", required: ["tenant"], properties: { query: { type: "string" }, tenant: { type: "string" } } }, annotations: { readOnlyHint: false }, outputSchema: { type: "object" } }, { name: "new_tool", inputSchema: { type: "object" } }];
  after.declared.resources = [{ name: "status", uri: "fixture://status", mimeType: "application/json" }, { name: "new", uri: "fixture://new" }];
  after.declared.prompts = [{ name: "explain", arguments: [{ name: "subject", required: true }] }, { name: "new_prompt" }];
  const second = record(root, after);
  assert.equal(second.diff_from, first.at);
  assert.equal(second.diff.since, first.at);
  assert.deepEqual(second.diff.tools.added, ["new_tool"]);
  assert.deepEqual(second.diff.tools.removed, ["old_tool"]);
  assert.equal(second.diff.tools.changed[0].name, "lookup");
  const changes = second.diff.tools.changed[0].changes.join("\n");
  assert.match(changes, /description/i);
  assert.match(changes, /required[^\n]*tenant|tenant[^\n]*required/i);
  assert.match(changes, /required[^\n]*query|query[^\n]*required/i);
  assert.match(changes, /readOnlyHint|read.only/i);
  assert.match(changes, /outputSchema|output.schema/i);
  assert.equal(second.diff.resources.added.length, 1);
  assert.equal(second.diff.resources.removed.length, 1);
  assert.match(second.diff.resources.changed[0].changes.join(" "), /mimeType|mime.type/i);
  assert.deepEqual(second.diff.prompts.added, ["new_prompt"]);
  assert.deepEqual(second.diff.prompts.removed, ["old_prompt"]);
  assert.match(second.diff.prompts.changed[0].changes.join(" "), /argument|subject|topic/i);
  assert.equal(JSON.stringify(stored(root)[0]), snapshot, "prior records are immutable");
});

test("MCP-1a same identity has an unchanged diff and distinct labels have independent histories", (t) => {
  const root = scratch(t);
  const first = record(root, sample());
  const other = sample(); other.server.label = "second-deployment";
  const isolated = record(root, other);
  assert.equal(isolated.diff_from ?? null, null);
  const second = record(root, sample());
  assert.equal(second.diff_from, first.at);
  for (const kind of ["tools", "resources", "prompts"]) assert.deepEqual(second.diff[kind], { added: [], removed: [], changed: [] });
});

test("MCP-1a validated arguments reach the tool in the initialized session and values are never recorded", async (t) => {
  const root = scratch(t); const log = join(root, "calls.log");
  const out = await inspect({ args: [fixture, "normal", log], execute: ["lookup", "text"], toolArgs: { lookup: { query: "ARGUMENT_VALUE_NOT_STORED", limit: 2, enabled: true, ratio: 0.5, absent: null } } });
  assert.equal(out.measured[0].observed.matches_output_schema, true);
  assert.equal(out.measured[0].observed.result_kind, "structured");
  assert.deepEqual(out.measured[0].observed.missing, []);
  assert.deepEqual(out.measured[0].observed.unexpected, []);
  const methods = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(methods.filter((method) => method === "initialize").length, 1);
  assert.equal(methods.filter((method) => method === "notifications/initialized").length, 1);
  assert.ok(methods.indexOf("notifications/initialized") < methods.indexOf("tools/list"));
  assert.equal(methods.filter((method) => method === "tools/call").length, 2);
  record(root, out);
  const persisted = JSON.stringify(stored(root));
  assert.doesNotMatch(persisted, /ARGUMENT_VALUE_NOT_STORED|RESULT_VALUE_NOT_STORED|TEXT_VALUE_NOT_STORED|EXAMPLE_VALUE_NOT_STORED|DEFAULT_VALUE_NOT_STORED|ENUM_VALUE_NOT_STORED/);
});

for (const [title, value, field] of [
  ["required field", {}, "query"],
  ["string type", { query: 4 }, "query"],
  ["integer type", { query: "q", limit: 0.5 }, "limit"],
  ["boolean type", { query: "q", enabled: "yes" }, "enabled"],
  ["number type", { query: "q", ratio: "half" }, "ratio"],
  ["null type", { query: "q", absent: false }, "absent"],
  ["object arguments", [], "lookup|arguments|\\$"],
]) test(`MCP-1a invalid ${title} refuses the whole batch before any tool call`, async (t) => {
  const root = scratch(t); const log = join(root, "calls.log");
  await assert.rejects(() => inspect({ args: [fixture, "normal", log], execute: ["text", "lookup"], toolArgs: { lookup: value } }), (error) => error.code === "MCP_ARGS_INVALID" && new RegExp(field).test(error.message));
  const methods = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.doesNotMatch(methods, /tools\/call/);
});

test("MCP-1c enum non-members fail closed naming their field and constraint", async (t) => {
  const root = scratch(t); const log = join(root, "calls.log");
  await assert.rejects(() => inspect({ args: [fixture, "normal", log], execute: ["constrained"], toolArgs: { constrained: { query: "NON_MEMBER_NOT_STORED" } } }), (error) => error.code === "MCP_ARGS_INVALID" && /query/.test(error.message) && /enum/.test(error.message) && !error.message.includes("NON_MEMBER_NOT_STORED"));
  assert.doesNotMatch(readFileSync(log, "utf8"), /tools\/call/);
});

test("MCP-1a declared output drift records missing and unexpected fields without result values", async (t) => {
  const root = scratch(t);
  const out = await inspect({ execute: ["mismatch"] });
  const observed = out.measured[0].observed;
  assert.equal(observed.matches_output_schema, false);
  assert.equal(observed.result_kind, "structured");
  assert.ok(observed.missing.includes("missing"));
  assert.ok(observed.unexpected.includes("extra"));
  record(root, out);
  assert.equal(stored(root)[0].measured[0].observed.matches_output_schema, false);
  assert.doesNotMatch(JSON.stringify(stored(root)), /WRONG_VALUE_NOT_STORED/);
});

test("MCP-1a text and error outcomes remain distinct from structured observations", async () => {
  const out = await inspect({ execute: ["text", "error"] });
  assert.deepEqual(out.measured.map((m) => m.observed.result_kind), ["text", "error"]);
  assert.deepEqual(out.measured.map((m) => m.observed.matches_output_schema), [null, null]);
});

test("MCP-1a a type-only output mismatch is measured even when all declared fields exist", async () => {
  const out = await inspect({ execute: ["wrongtype"] });
  assert.equal(out.measured[0].observed.matches_output_schema, false);
  assert.deepEqual(out.measured[0].observed.missing, []);
  assert.deepEqual(out.measured[0].observed.unexpected, []);
});

test("MCP-1a absent output schema promotes only measured field names and types", async (t) => {
  const root = scratch(t);
  const out = await inspect({ execute: ["loose"] });
  assert.equal(out.measured[0].observed.matches_output_schema, null);
  assert.equal(out.measured[0].observed.result_kind, "structured");
  const fields = out.measured[0].observed.fields;
  assert.ok(["number", "integer"].includes(fields.find((field) => field.name === "count")?.type));
  assert.equal(fields.find((field) => field.name === "info")?.type, "object");
  assert.equal(fields.find((field) => field.name === "labels")?.type, "array");
  assert.ok(fields.every((field) => Object.keys(field).every((key) => ["name", "type"].includes(key))));
  record(root, out);
  assert.doesNotMatch(JSON.stringify(stored(root)), /NESTED_VALUE_NOT_STORED|ARRAY_VALUE_NOT_STORED/);
});

test("MCP-1a enumeration never executes even when every hint claims read-only", async (t) => {
  const root = scratch(t); const log = join(root, "calls.log");
  const out = await inspect({ args: [fixture, "normal", log], toolArgs: { lookup: { query: "unused" } } });
  assert.deepEqual(out.measured, []);
  assert.doesNotMatch(readFileSync(log, "utf8"), /tools\/call/);
});

test("MCP-1a retention keeps the last twenty per server with no age deletion or prior-record rewrite", (t) => {
  const root = scratch(t);
  record(root, sample("old-server"));
  const context = JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8"));
  context.mcp_inspections[0].at = "2000-01-01T00:00:00.000Z";
  writeFileSync(join(root, LAYOUT.context), `${JSON.stringify(context, null, 2)}\n`);
  const old = context.mcp_inspections[0];
  const oldSnapshot = JSON.stringify(old);
  for (let n = 0; n < 23; n += 1) { const next = sample("active-server"); next.server.version = String(n); record(root, next); }
  const records = stored(root);
  assert.equal(records.length, 21);
  assert.equal(records.filter((r) => r.server.name === "active-server").length, 20);
  assert.equal(records.filter((r) => r.server.name === "active-server")[0].server.version, "3");
  assert.equal(JSON.stringify(records.find((r) => r.server.name === "old-server")), oldSnapshot);
});

test("MCP-1a URI credentials are redacted even when they do not resemble a secret token", async (t) => {
  const root = scratch(t);
  const out = await inspect();
  assert.doesNotMatch(JSON.stringify(out), /reader:ordinary-password@/);
  record(root, out);
  assert.doesNotMatch(JSON.stringify(stored(root)), /reader|ordinary-password/);
});

test("MCP-1a stored strings and object keys are bounded", (t) => {
  const root = scratch(t);
  const out = sample();
  out.instructions = "i".repeat(400);
  out.declared.tools = [{ name: "t".repeat(400), description: "d".repeat(400), inputSchema: { type: "object", properties: { ["f".repeat(400)]: { type: "string" } } } }];
  const saved = record(root, out);
  assert.equal(saved.instructions.length, 200);
  const visit = (value) => { if (typeof value === "string") assert.ok(value.length <= 200); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { assert.ok(key.length <= 200); visit(child); } };
  visit(saved);
});

test("MCP-1a secret scan runs before truncation and refuses the write atomically", (t) => {
  const root = scratch(t);
  record(root, sample());
  const before = readFileSync(join(root, LAYOUT.context), "utf8");
  const out = sample(); out.instructions = `${"x".repeat(300)} sk_abcdefghijklmnopqrstuvwx`;
  assert.throws(() => record(root, out), { code: "MCP_LITERAL_SECRET_REFUSED" });
  assert.equal(readFileSync(join(root, LAYOUT.context), "utf8"), before);
});

test("MCP-1a adversarial schema constraint names survive storage without constraint values", async (t) => {
  const root = scratch(t);
  const out = await inspect();
  const declared = out.declared.tools.find((tool) => tool.name === "constrained").inputSchema;
  assert.deepEqual(declared.properties.query.constraints, ["enum"]);
  const saved = record(root, out);
  assert.deepEqual(saved.declared.tools.find((tool) => tool.name === "constrained").inputSchema, declared);
  assert.doesNotMatch(JSON.stringify(saved), /ENUM_VALUE_NOT_STORED/);
});

test("MCP-1c absent optional enum inputs permit explicit execution", async (t) => {
  const root = scratch(t); const log = join(root, "calls.log");
  const out = await inspect({ args: [fixture, "normal", log], execute: ["optional_constrained"] });
  assert.equal(out.measured[0].observed.result_kind, "structured");
  assert.equal(readFileSync(log, "utf8").split("\n").filter((method) => method === "tools/call").length, 1);
});

test("MCP-1a adversarial plain literal credential arguments are refused without a call", async (t) => {
  const root = scratch(t); const log = join(root, "calls.log");
  await assert.rejects(() => inspect({ args: [fixture, "normal", log], execute: ["credentials"], toolArgs: { credentials: { password: "ordinary-password" } } }), (error) => error.code === "MCP_LITERAL_SECRET_REFUSED" && !error.message.includes("ordinary-password"));
  assert.doesNotMatch(existsSync(log) ? readFileSync(log, "utf8") : "", /tools\/call/);
});

test("MCP-1a adversarial malformed schema type and required entries never promote payload values", async (t) => {
  const root = scratch(t);
  const out = await inspect({ args: [fixture, "malformed-schema"] });
  assert.doesNotMatch(JSON.stringify(out), /DECLARED_VALUE_NOT_STORED/);
  record(root, out);
  assert.doesNotMatch(JSON.stringify(stored(root)), /DECLARED_VALUE_NOT_STORED/);
});

test("MCP-1a adversarial observed fields are whitelisted at the final storage boundary", (t) => {
  const root = scratch(t);
  const out = sample();
  out.measured = [{ tool: "read", observed: { matches_output_schema: null, missing: [], unexpected: [], result_kind: "structured", fields: [{ name: "count", type: "number", value: "PAYLOAD_VALUE_NOT_STORED" }] } }];
  const saved = record(root, out);
  assert.deepEqual(saved.measured[0].observed.fields, [{ name: "count", type: "number" }]);
  assert.doesNotMatch(JSON.stringify(saved), /PAYLOAD_VALUE_NOT_STORED/);
});

test("MCP-1a adversarial a false output schema remains declared and cannot match a result", async (t) => {
  const root = scratch(t);
  const out = await inspect({ execute: ["false_output"] });
  assert.equal(out.declared.tools.find((tool) => tool.name === "false_output").outputSchema, false);
  assert.equal(out.measured[0].observed.matches_output_schema, false);
  assert.equal(record(root, out).declared.tools.find((tool) => tool.name === "false_output").outputSchema, false);
});

test("MCP-1a adversarial failed lists cannot imply removed or newly added declarations", (t) => {
  const root = scratch(t);
  const before = sample();
  before.declared.tools = [{ name: "lookup", inputSchema: { type: "object" } }];
  record(root, before);
  const failed = sample();
  failed.declared.tools_error = { code: -32000, message: "fixture list unavailable" };
  const failure = record(root, failed);
  assert.deepEqual(failure.diff.tools.removed, []);
  assert.deepEqual(failure.diff.tools.added, []);
  assert.ok(failure.diff.tools.unavailable.length);
  const recovery = record(root, before);
  assert.deepEqual(recovery.diff.tools.added, []);
  assert.ok(recovery.diff.tools.unavailable.length);
});

test("MCP-1a adversarial nested required-field drift names the changed field", (t) => {
  const root = scratch(t);
  const before = sample();
  before.declared.tools = [{ name: "lookup", inputSchema: { type: "object", properties: { filter: { type: "object", properties: { region: { type: "string" } } } } } }];
  record(root, before);
  const after = structuredClone(before);
  after.declared.tools[0].inputSchema.properties.filter.required = ["region"];
  const changed = record(root, after).diff.tools.changed[0].changes.join("\n");
  assert.match(changed, /required[^\n]*filter\.region|filter\.region[^\n]*required/i);
});

test("MCP-1a adversarial resources sharing a display name keep distinct URI identities", (t) => {
  const root = scratch(t);
  const before = sample();
  before.declared.resources = [{ name: "document", uri: "fixture://one" }, { name: "document", uri: "fixture://two" }];
  record(root, before);
  const after = sample();
  after.declared.resources = [{ name: "document", uri: "fixture://two" }, { name: "document", uri: "fixture://three" }];
  const diff = record(root, after).diff.resources;
  assert.deepEqual(diff.added, ["fixture://three"]);
  assert.deepEqual(diff.removed, ["fixture://one"]);
  assert.deepEqual(diff.changed, []);
});
