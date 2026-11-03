// Node-only, loopback streamable-HTTP fixture. Never connects to another host.
import { createServer } from "node:http";

export async function startMcpHttpFixture({ mode = "sse" } = {}) {
  const seen = [];
  let initialized = false, notified = false, calls = 0;
  const sessionId = "fixture-session";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    seen.push({ method: message.method, headers: req.headers, params: message.params });
    const sendJson = (value) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (message.method === "initialize") {
      if (mode === "initialize-timeout") return;
      if (mode === "initialize-malformed") { res.writeHead(200, { "content-type": "application/json" }); res.end("not-json"); return; }
      initialized = true;
      res.setHeader("Mcp-Session-Id", sessionId);
      sendJson({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "http-session", version: "1" } } });
      return;
    }
    if (!initialized || req.headers["mcp-session-id"] !== sessionId) { res.writeHead(400); res.end(); return; }
    if (message.method === "notifications/initialized") { notified = true; res.writeHead(202); res.end(); return; }
    if (!notified) { res.writeHead(400); res.end(); return; }
    if (mode === "list-timeout") return;
    if (mode === "http-error") { res.writeHead(503); res.end("private fixture detail"); return; }
    if (mode === "oversized") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${"x".repeat(1024 * 1024 + 1)}`); return; }
    let result = message.method === "tools/call" ? { structuredContent: { call: ++calls } } : { tools: [] };
    if (mode === "inspection" && message.method !== "tools/call") {
      result = message.method === "tools/list" ? { tools: [{ name: "read_status", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] }, outputSchema: { type: "object", properties: { call: { type: "integer" } }, required: ["call"] } }] }
        : message.method === "resources/list" ? { resources: [] } : { prompts: [] };
    }
    const reply = { jsonrpc: "2.0", id: message.id, result };
    if (mode === "json") { sendJson(reply); return; }
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    let frames = [
      ": keepalive\r\n\r\n",
      ...(mode === "malformed" ? ['data: malformed\r\n\r\n', 'data: {"wrong":"rpc"}\r\n\r\n'] : []),
      'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\n',
      `data: ${JSON.stringify({ ...reply, id: 99999 })}\r\n\r\n`,
      `data: {"jsonrpc":"2.0",\r\ndata: "id":${message.id},"result":${JSON.stringify(result)}}\r\n\r\n`,
    ].join("");
    if (mode === "sse-cr") frames = frames.replaceAll("\r\n", "\r");
    if (mode === "sse-bom") frames = `\uFEFF${frames}`;
    if (mode === "cumulative") frames = Array.from({ length: 20 }, () => `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { padding: "x".repeat(65536) } })}\n\n`).join("");
    // Fragment across SSE delimiters and JSON boundaries; keep response open so
    // a client must finish on its matching response rather than wait for EOF.
    const split = frames.indexOf("\r") + 1;
    res.write(frames.slice(0, split));
    setImmediate(() => { if (!res.destroyed) res.write(frames.slice(split)); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`, seen,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
