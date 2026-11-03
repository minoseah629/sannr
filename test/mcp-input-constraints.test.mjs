import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArgs, schemaFacts } from "../lib/mcp-facts.mjs";
import { inspectMcp, storeMcpInspection } from "../lib/mcp-inspect.mjs";
import { parseMcpInspectOptions } from "../lib/mcp-options.mjs";

const fixture = fileURLToPath(new URL("./fixtures/mcp-memory-server.mjs", import.meta.url));
const contract = (field) => ({ type: "object", properties: { query: field }, required: ["query"] });
const validate = (value, schema) => validateToolArgs({ query: value }, contract(schema));
const refused = (value, schema, keyword) => assert.throws(() => validate(value, schema), (error) => {
  assert.equal(error.code, "MCP_ARGS_INVALID");
  assert.match(error.message, /'query(?:\[\])?'/);
  assert.ok(error.message.includes(keyword), error.message);
  assert.doesNotMatch(error.message, /PRIVATE_|ENUM_VALUE_NOT_STORED/);
  return true;
});
const scratch = (t) => { const root = mkdtempSync(join(tmpdir(), "mcp-constraints-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };

test("MCP-1c enum opt-in reaches the memory fixture; arguments and enum members never enter records", async (t) => {
  const root = scratch(t), log = join(root, "calls.log");
  const options = parseMcpInspectOptions([process.execPath, fixture, "normal", log, "--execute", "constrained", "--args", 'constrained={"query":"ENUM_VALUE_NOT_STORED"}']);
  const inspection = await inspectMcp(options);
  assert.equal(inspection.measured[0].observed.result_kind, "structured");
  assert.equal(readFileSync(log, "utf8").split("\n").filter((method) => method === "tools/call").length, 1);
  storeMcpInspection(root, inspection);
  assert.doesNotMatch(JSON.stringify(inspection), /ENUM_VALUE_NOT_STORED/);
  assert.doesNotMatch(readFileSync(join(root, LAYOUT.context), "utf8"), /ENUM_VALUE_NOT_STORED/);
  assert.deepEqual(inspection.declared.tools.find((tool) => tool.name === "constrained").inputSchema.properties.query, { type: "string", constraints: ["enum"] });
});

test("MCP-1c enum non-member refuses the complete opt-in batch without echoing the value", async (t) => {
  const root = scratch(t), log = join(root, "calls.log");
  await assert.rejects(() => inspectMcp({ command: process.execPath, args: [fixture, "normal", log], execute: ["text", "constrained"], toolArgs: { constrained: { query: "PRIVATE_NONMEMBER" } } }), (error) => error.code === "MCP_ARGS_INVALID" && /enum/.test(error.message) && /query/.test(error.message) && !/PRIVATE_NONMEMBER/.test(error.message));
  assert.doesNotMatch(readFileSync(log, "utf8"), /tools\/call/);
});

for (const [title, schema, accepted, rejected, keyword] of [
  ["enum", { type: "string", enum: ["PRIVATE_MEMBER"] }, "PRIVATE_MEMBER", "PRIVATE_NONMEMBER", "enum"],
  ["const", { type: "string", const: "PRIVATE_CONSTANT" }, "PRIVATE_CONSTANT", "PRIVATE_OTHER", "const"],
  ["minimum", { type: "number", minimum: 2 }, 2, 1.5, "minimum"],
  ["maximum", { type: "number", maximum: 4 }, 4, 4.5, "maximum"],
  ["minLength", { type: "string", minLength: 2 }, "ab", "a", "minLength"],
  ["maxLength", { type: "string", maxLength: 2 }, "ab", "abc", "maxLength"],
  ["pattern", { type: "string", pattern: "^PUBLIC_[A-Z]+$" }, "PUBLIC_OK", "PRIVATE_PATTERN_MISMATCH", "pattern"],
]) test(`MCP-1c validates ${title} with field-only failure details`, () => {
  assert.doesNotThrow(() => validate(accepted, schema));
  refused(rejected, schema, keyword);
});

test("MCP-1c enum and const compare structured JSON values without order-dependent object equality", () => {
  const expected = { label: "PRIVATE_DECLARED", flags: [true, null, 2] };
  for (const constraint of [{ enum: [expected] }, { const: expected }]) {
    assert.doesNotThrow(() => validate({ flags: [true, null, 2], label: "PRIVATE_DECLARED" }, constraint));
    refused({ flags: [true, null, 3], label: "PRIVATE_DECLARED" }, constraint, Object.keys(constraint)[0]);
  }
});

test("MCP-1c string length counts Unicode code points and pattern uses JSON Schema substring matching", () => {
  assert.doesNotThrow(() => validate("😀", { type: "string", minLength: 1, maxLength: 1 }));
  refused("😀", { type: "string", minLength: 2 }, "minLength");
  assert.doesNotThrow(() => validate("before PUBLIC after", { type: "string", pattern: "PUBLIC" }));
});

for (const [type, member, nonmember] of [["string", "a", 1], ["number", 1.5, "1"], ["integer", 1, 1.5], ["boolean", true, 1], ["null", null, false]]) {
  test(`MCP-1c array items enforce primitive ${type} types`, () => {
    const schema = { type: "array", items: { type } };
    assert.doesNotThrow(() => validate([member, member], schema));
    refused([member, nonmember], schema, "type mismatch");
  });
}

test("MCP-1c primitive array items also validate enum and bounds", () => {
  const schema = { type: "array", items: { type: "integer", enum: [1, 2, 3], minimum: 2, maximum: 3 } };
  assert.doesNotThrow(() => validate([2, 3], schema));
  refused([1], schema, "minimum");
  refused([4], schema, "enum");
});

test("MCP-1c unsafe patterns are refused by field before compilation, even on absent optional fields", (t) => {
  const NativeRegExp = globalThis.RegExp;
  const compiled = [];
  t.mock.method(globalThis, "RegExp", function (...args) { compiled.push(args[0]); return new NativeRegExp(...args); });
  for (const pattern of ["(a+)+$", "a".repeat(201)]) {
    refused("PRIVATE_PATTERN_INPUT", { type: "string", pattern }, "unsafe pattern");
    assert.throws(() => validateToolArgs({}, { type: "object", properties: { query: { type: "string", pattern } } }), (error) => error.code === "MCP_ARGS_INVALID" && /unsafe pattern/.test(error.message) && /query/.test(error.message));
  }
  assert.deepEqual(compiled, [], "neither definition nor value validation compiles an unsafe pattern");
});

for (const [keyword, schema] of [
  ["enum", { enum: [] }], ["enum", { enum: "PRIVATE_INVALID_ENUM" }],
  ["minimum", { minimum: "PRIVATE_INVALID_MINIMUM" }], ["maximum", { maximum: true }],
  ["minLength", { minLength: -1 }], ["maxLength", { maxLength: 1.5 }],
  ["pattern", { pattern: "[" }], ["pattern", { pattern: false }],
]) test(`MCP-1c malformed ${keyword} declarations fail closed by keyword`, () => refused("PRIVATE_ARGUMENT", schema, keyword));

test("MCP-1c unsupported keywords remain named even in absent optional fields and array items", () => {
  for (const keyword of ["oneOf", "allOf", "$ref", "format", "minItems", "uniqueItems"]) {
    const schema = { [keyword]: "PRIVATE_SCHEMA_VALUE" };
    assert.throws(() => validateToolArgs({}, { properties: { query: schema } }), (error) => error.code === "MCP_ARGS_INVALID" && error.message.includes(`unsupported schema keyword: ${keyword} at 'query'`) && !error.message.includes("PRIVATE_SCHEMA_VALUE"));
    refused([], { type: "array", items: schema }, `unsupported schema keyword: ${keyword}`);
  }
});

test("MCP-1c supported constraints preserve the existing declaration-value promotion boundary", () => {
  const schema = contract({ type: "array", items: { type: "string", enum: ["PRIVATE_ENUM"], const: "PRIVATE_CONSTANT", minLength: 1, maxLength: 9, pattern: "PRIVATE_PATTERN" }, minItems: 1 });
  const facts = schemaFacts(schema);
  assert.deepEqual(facts.properties.query.items.constraints, ["enum", "const", "minLength", "maxLength", "pattern"]);
  assert.doesNotMatch(JSON.stringify(facts), /PRIVATE_/);
});
