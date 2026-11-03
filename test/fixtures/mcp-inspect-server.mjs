#!/usr/bin/env node
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "fixture", version: "1" } } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "read_status", description: "safe fixture read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      { name: "mutate", description: "unsafe fixture write", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
    ] } });
    else if (msg.method === "resources/list") send({ jsonrpc: "2.0", id: msg.id, result: { resources: [{ uri: "fixture://status", name: "status" }] } });
    else if (msg.method === "resources/templates/list") send({ jsonrpc: "2.0", id: msg.id, result: { resourceTemplates: [] } });
    else if (msg.method === "prompts/list") send({ jsonrpc: "2.0", id: msg.id, result: { prompts: [{ name: "explain" }] } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
  }
});
