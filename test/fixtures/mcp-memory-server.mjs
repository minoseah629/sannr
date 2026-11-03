#!/usr/bin/env node
// Local-only MCP fixture: payload values are intentionally distinctive so tests
// can prove that only field names/types cross the inspection storage boundary.
import { appendFileSync } from "node:fs";

const [mode = "normal", log] = process.argv.slice(2);
let initialized = false;
let notified = false;
let buffer = "";
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const fail = (id, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
const empty = { type: "object", properties: {} };
const tools = [
  { name: "lookup", description: "Find a fixture entry", annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", examples: ["EXAMPLE_VALUE_NOT_STORED"], default: "DEFAULT_VALUE_NOT_STORED" }, limit: { type: "integer" }, enabled: { type: "boolean" }, ratio: { type: "number" }, absent: { type: "null" } } }, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" }, label: { type: "string" } } } },
  { name: "mismatch", annotations: { readOnlyHint: true }, inputSchema: empty, outputSchema: { type: "object", required: ["count", "missing"], properties: { count: { type: "integer" }, missing: { type: "string" } } } },
  { name: "wrongtype", annotations: { readOnlyHint: true }, inputSchema: empty, outputSchema: { type: "object", required: ["count"], properties: { count: { type: "integer" } } } },
  { name: "text", annotations: { readOnlyHint: true }, inputSchema: empty },
  { name: "error", annotations: { readOnlyHint: true }, inputSchema: empty },
  { name: "loose", annotations: { readOnlyHint: true }, inputSchema: empty },
  { name: "constrained", annotations: { readOnlyHint: true }, inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", enum: ["ENUM_VALUE_NOT_STORED"] } } } },
  { name: "optional_constrained", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { choice: { type: "string", enum: ["ENUM_VALUE_NOT_STORED"] } } } },
  { name: "credentials", annotations: { readOnlyHint: true }, inputSchema: { type: "object", required: ["password"], properties: { password: { type: "string" } } } },
  { name: "false_output", annotations: { readOnlyHint: true }, inputSchema: empty, outputSchema: false },
];
if (mode === "malformed-schema") tools.push({ name: "malformed_schema", inputSchema: { type: { sample: "DECLARED_VALUE_NOT_STORED" }, required: [{ sample: "DECLARED_VALUE_NOT_STORED" }] } });

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (log) appendFileSync(log, `${msg.method}\n`);
    if (msg.method === "initialize") {
      if (initialized) { fail(msg.id, "initialize must happen once"); continue; }
      initialized = true;
      send(msg.id, { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: "Only declarations are safe by default.", ...(mode === "anonymous" ? {} : { serverInfo: { name: "memory-fixture", version: "1.2.3" } }) });
    } else if (msg.method === "notifications/initialized") {
      notified = true;
    } else if (msg.method === "tools/list") {
      send(msg.id, { tools });
    } else if (msg.method === "resources/list") {
      send(msg.id, { resources: [{ name: "status", uri: "fixture://reader:ordinary-password@local/status", mimeType: "application/json" }] });
    } else if (msg.method === "resources/templates/list") {
      send(msg.id, { resourceTemplates: [] });
    } else if (msg.method === "prompts/list") {
      send(msg.id, { prompts: [{ name: "explain", arguments: [{ name: "topic", required: true }] }] });
    } else if (msg.method === "tools/call") {
      if (!initialized || !notified) { fail(msg.id, "calls require the initialized session"); continue; }
      switch (msg.params.name) {
        case "constrained":
        case "optional_constrained": send(msg.id, { structuredContent: { accepted: true }, content: [] }); break;
        case "lookup":
          if (msg.params.arguments.query !== "ARGUMENT_VALUE_NOT_STORED") { send(msg.id, { isError: true, content: [{ type: "text", text: "required argument was not forwarded" }] }); break; }
          send(msg.id, { structuredContent: { count: 2, label: "RESULT_VALUE_NOT_STORED" }, content: [] }); break;
        case "mismatch": send(msg.id, { structuredContent: { count: "WRONG_VALUE_NOT_STORED", extra: true }, content: [] }); break;
        case "wrongtype": send(msg.id, { structuredContent: { count: "WRONG_VALUE_NOT_STORED" }, content: [] }); break;
        case "text": send(msg.id, { content: [{ type: "text", text: "TEXT_VALUE_NOT_STORED" }] }); break;
        case "error": send(msg.id, { isError: true, content: [{ type: "text", text: "ERROR_VALUE_NOT_STORED" }] }); break;
        case "loose": send(msg.id, { structuredContent: { count: 2, info: { hidden: "NESTED_VALUE_NOT_STORED" }, labels: ["ARRAY_VALUE_NOT_STORED"] }, content: [] }); break;
        case "false_output": send(msg.id, { structuredContent: {}, content: [] }); break;
        default: fail(msg.id, "unexpected fixture tool");
      }
    } else fail(msg.id, "unknown fixture method");
  }
});
