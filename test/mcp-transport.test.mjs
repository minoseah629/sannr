import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createMcpSession } from "../lib/mcp-transport.mjs";
import { startMcpHttpFixture } from "./fixtures/mcp-http-session-server.mjs";

const fixture = fileURLToPath(new URL("./fixtures/mcp-session-server.mjs", import.meta.url));
// Deadlines include fixture start-up. Successful calls never wait for them, so the defaults are generous;
// tests that expect a deadline to fire use 2,000 ms, which held at load average ~25 on 10 cores.
const stdio = (mode = "normal", timeoutMs = 5000) => createMcpSession({ command: process.execPath, args: [fixture, mode], timeoutMs });
async function initialize(session) {
  const response = await session.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture-test", version: "1" } });
  await session.notify("notifications/initialized");
  return response;
}

test("MCP-1a stdio initializes once and reuses one notified session across tool calls", async (t) => {
  const session = stdio(); t.after(() => session.close());
  assert.equal((await initialize(session)).result.serverInfo.name, "strict-session");
  assert.deepEqual((await session.request("tools/list")).result, { tools: [] });
  assert.equal((await session.request("tools/call", { name: "read" })).result.structuredContent.call, 1);
  assert.equal((await session.request("tools/call", { name: "read" })).result.structuredContent.call, 2);
  assert.equal(session.malformed_frames, 0);
});

test("MCP-1a stdio counts malformed JSON and invalid RPC while accepting notifications", async (t) => {
  const session = stdio("malformed"); t.after(() => session.close());
  await initialize(session);
  assert.deepEqual((await session.request("tools/list")).result, { tools: [] });
  assert.equal(session.malformed_frames, 2);
});

// The deadline covers the fixture child starting up, writing its frames and (not) answering. 150 ms
// failed under machine load (load average ~28 on 10 cores): the child had not written its frames yet.
test("MCP-1a unanswered initialize names MCP_NOT_INITIALIZED with malformed-frame evidence", async (t) => {
  const session = stdio("no-initialize", 2000); t.after(() => session.close());
  await assert.rejects(() => session.request("initialize"), { code: "MCP_NOT_INITIALIZED", malformed_frames: 2 });
});

for (const mode of ["exit", "initialize-error"]) test(`MCP-1a initialize ${mode} has a safe named failure`, async (t) => {
  const session = stdio(mode); t.after(() => session.close());
  await assert.rejects(() => session.request("initialize"), (error) => error.code === "MCP_NOT_INITIALIZED" && !error.message.includes("private") && !error.message.includes(fixture));
});

// Initialize must succeed and only the list may time out, so the deadline must cover child startup.
test("MCP-1a list timeout is distinct from initialization failure", async (t) => {
  const session = stdio("list-timeout", 2000); t.after(() => session.close());
  await initialize(session);
  await assert.rejects(() => session.request("tools/list"), { code: "MCP_TIMEOUT" });
});

test("MCP-1a list JSON-RPC errors remain available as per-list evidence", async (t) => {
  const session = stdio("list-error"); t.after(() => session.close());
  await initialize(session);
  assert.equal((await session.request("tools/list")).error.code, -32601);
});

for (const mode of ["oversized", "cumulative"]) test(`MCP-1a stdio caps ${mode} response bytes at 1 MB`, async (t) => {
  const session = stdio(mode); t.after(() => session.close());
  await initialize(session);
  await assert.rejects(() => session.request("tools/list"), { code: "MCP_OVERSIZED" });
});

for (const mode of ["sse", "sse-cr", "sse-bom", "json"]) test(`MCP-1a HTTP ${mode} uses session headers and initialized notification for lists and calls`, async (t) => {
  const server = await startMcpHttpFixture({ mode }); t.after(() => server.close());
  const session = createMcpSession({ url: server.url, timeoutMs: 5000 }); t.after(() => session.close());
  await initialize(session);
  assert.deepEqual((await session.request("tools/list")).result, { tools: [] });
  assert.equal((await session.request("tools/call", { name: "read" })).result.structuredContent.call, 1);
  assert.equal((await session.request("tools/call", { name: "read" })).result.structuredContent.call, 2);
  assert.deepEqual(server.seen.map((item) => item.method), ["initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call"]);
  for (const item of server.seen.slice(1)) {
    assert.equal(item.headers["mcp-session-id"], "fixture-session");
    assert.match(item.headers.accept, /application\/json/);
    assert.match(item.headers.accept, /text\/event-stream/);
  }
});

test("MCP-1a HTTP SSE counts malformed frames and matches the requested response ID", async (t) => {
  const server = await startMcpHttpFixture({ mode: "malformed" }); t.after(() => server.close());
  const session = createMcpSession({ url: server.url }); t.after(() => session.close());
  await initialize(session);
  assert.equal((await session.request("tools/list")).id, 2);
  assert.equal(session.malformed_frames, 2);
});

for (const mode of ["initialize-timeout", "initialize-malformed"]) test(`MCP-1a HTTP ${mode} names initialization failure`, async (t) => {
  const server = await startMcpHttpFixture({ mode }); t.after(() => server.close());
  const session = createMcpSession({ url: server.url, timeoutMs: 2000 }); t.after(() => session.close());
  await assert.rejects(() => session.request("initialize"), { code: "MCP_NOT_INITIALIZED", malformed_frames: mode === "initialize-malformed" ? 1 : 0 });
});

for (const [mode, code] of [["list-timeout", "MCP_TIMEOUT"], ["oversized", "MCP_OVERSIZED"], ["cumulative", "MCP_OVERSIZED"], ["http-error", "MCP_HTTP_FAILED"]]) test(`MCP-1a HTTP ${mode} is bounded and named`, async (t) => {
  const server = await startMcpHttpFixture({ mode }); t.after(() => server.close());
  const session = createMcpSession({ url: server.url, timeoutMs: 2000 }); t.after(() => session.close());
  await initialize(session);
  await assert.rejects(() => session.request("tools/list"), (error) => error.code === code && !error.message.includes(server.url) && !error.message.includes("private"));
});

test("MCP-1a transport refuses userinfo without exposing the URL", () => {
  assert.throws(() => createMcpSession({ url: "http://credential:password@127.0.0.1/mcp" }), (error) => error.code === "MCP_TARGET_INVALID" && !error.message.includes("credential"));
});

test("MCP-1a failed spawn does not expose the server command", async (t) => {
  const session = createMcpSession({ command: "/no-such-mcp-private-command" }); t.after(() => session.close());
  await assert.rejects(() => session.request("initialize"), (error) => error.code === "MCP_SPAWN_FAILED" && !error.message.includes("private-command"));
});
