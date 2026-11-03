// Strict, local stdio fixture: one initialize and initialized notification per process.
const mode = process.argv[2] ?? "normal";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let buffer = "", initialized = false, notified = false, calls = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n"); buffer = lines.pop();
  for (const line of lines) {
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (mode === "no-initialize") { process.stdout.write('not json\n{"wrong":"rpc"}\n'); continue; }
      if (mode === "exit") { process.exit(0); }
      if (mode === "initialize-error") { send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "private fixture detail" } }); continue; }
      if (initialized) { send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "already initialized" } }); continue; }
      initialized = true;
      send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "strict-session", version: "1" } } });
    } else if (message.method === "notifications/initialized") notified = true;
    else if (mode === "list-timeout") continue;
    else if (mode === "oversized") process.stdout.write("x".repeat(1024 * 1024 + 1));
    else if (mode === "cumulative") {
      for (let i = 0; i < 20; i++) send({ jsonrpc: "2.0", method: "notifications/progress", params: { padding: "x".repeat(65536) } });
    } else if (!initialized || !notified) send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "initialize first" } });
    else if (message.method === "tools/call") send({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { call: ++calls } } });
    else {
      if (mode === "malformed") {
        process.stdout.write('broken\n{"jsonrpc":"2.0","id":1}\n');
        send({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
      }
      if (mode === "list-error") send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "fixture list unsupported" } });
      else send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    }
  }
});
