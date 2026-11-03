import { LAYOUT } from "../lib/layout.mjs";
// Codex-facing MCP and runtime compatibility. These tests exercise the wire
// schema a strict MCP host sees and the client plumbing that batch execution
// used to bypass or silently drop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,  readFileSync, readdirSync, existsSync,
} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL } from "../lib/client.mjs";
import { TOOL_NAME } from "../lib/brand.mjs";
import { readOnlyTool } from "../lib/librarian.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function isolatedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "API_AUTH", "API_BASE_URL", "API_CONFIG", "API_ENV",
    "API_ALLOW_PRODUCTION_WRITES", "API_EVIDENCE", "API_USAGE_LOG", "SANNR_ALLOW_SAVE_OUTSIDE",
  ]) delete env[key];
  Object.assign(env, {
    API_CONTEXT_OFF: "1",
    API_USAGE_LOG: "/dev/null",
    ...overrides,
  });
  return env;
}

/** Send several newline-delimited JSON-RPC messages to the real stdio server. */
function rpc(messages, env = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
      cwd: ROOT,
      env: isolatedEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const wanted = messages.filter((message) => message.id !== undefined).length;
    const replies = [];
    let stdout = "", stderr = "", settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject,
      new Error(`MCP server timed out; stderr: ${stderr}`)), timeoutMs);
    child.on("error", (error) => finish(reject, error));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { replies.push(JSON.parse(line)); } catch { /* ignore non-RPC output */ }
      }
      if (replies.length >= wanted) finish(resolve, replies);
    });
    child.stdin.end(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  });
}

const byId = (replies, id) => replies.find((reply) => reply.id === id);
const envelope = (reply) => JSON.parse(reply.result.content[0].text);

function httpFixture(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("the MCP tool schema admits path, curl, and batch-only calls", () => {
  assert.equal(TOOL.name, TOOL_NAME);
  assert.equal(TOOL.inputSchema.required, undefined,
    "an unconditional path requirement makes curl-only and batch-only calls invalid");
  assert.deepEqual(TOOL.inputSchema.anyOf.map((branch) => branch.required), [
    ["path"], ["curl"], ["requests"],
  ]);
  assert.deepEqual(TOOL.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.match(TOOL.description, /APIs the repository owns or consumes/);
  assert.match(TOOL.description, /including familiar endpoints, simple GET or POST calls, and health checks/);
  assert.match(TOOL.description, /Exclude incidental web research, package downloads, source-control administration/);
  assert.doesNotMatch(TOOL.description, /ordinary HTTP tooling may be simpler/);
});

test("the stdio server negotiates Codex-era MCP, advertises instructions, and rejects unknown tools", async () => {
  const replies = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "codex-test", version: "1" },
      capabilities: {},
    } },
    { jsonrpc: "2.0", id: 2, method: "ping", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "not_api_request", arguments: { path: "/must-not-run" },
    } },
  ]);

  assert.equal(byId(replies, 1).result.protocolVersion, "2025-06-18");
  assert.match(byId(replies, 1).result.instructions, /never pass literal credentials/);
  assert.equal(byId(replies, 1).result.serverInfo.version,
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  assert.match(byId(replies, 1).result.instructions, /routine requests and health checks/);
  assert.doesNotMatch(byId(replies, 1).result.instructions, /ordinary HTTP tooling may be simpler/);
  assert.deepEqual(byId(replies, 2).result, {});
  const listed = byId(replies, 3).result.tools[0];
  assert.equal(listed.name, TOOL_NAME);
  assert.deepEqual(listed.annotations, TOOL.annotations);
  assert.ok(listed.inputSchema.anyOf, "the schema alternatives did not reach tools/list");
  const inputs = listed.inputSchema.properties;
  const step = inputs.requests.items;
  const grammar = value => JSON.parse(JSON.stringify(value, (key, item) => key === 'description' ? undefined : item));
  assert.equal(step.additionalProperties, false);
  for (const field of ['path', 'upstream', 'graphql', 'grpc', 'expect', 'paginate', 'headers', 'save_to'])
    assert.deepEqual(step.properties[field], grammar(inputs[field]), `batch discovery lost ${field}`);
  assert.deepEqual(step.properties.capture.additionalProperties, { type: 'string' });
  assert.deepEqual(step.properties.wait_for.oneOf.map(branch => branch.required),
    [['equals'], ['in'], ['exists']]);
  assert.equal(inputs.expect.items.additionalProperties, false);
  assert.deepEqual(inputs.expect.items.allOf[0].oneOf.map(branch => branch.required),
    [['status'], ['json'], ['header']]);
  const restricted = readOnlyTool(listed).inputSchema.properties.requests.items.properties;
  assert.deepEqual(restricted.capture, step.properties.capture);
  assert.deepEqual(restricted.wait_for, step.properties.wait_for);
  for (const write of ['save_to', 'body', 'files', 'grpc']) assert.equal(restricted[write], undefined);
  assert.equal(byId(replies, 4).error.code, -32602);
  assert.match(byId(replies, 4).error.message, /Unknown tool/);

  const current = await rpc([
    { jsonrpc: "2.0", id: 10, method: "initialize", params: {
      protocolVersion: "2025-11-25",
      clientInfo: { name: "current-mcp-test", version: "1" },
      capabilities: {},
    } },
  ]);
  assert.equal(byId(current, 10).result.protocolVersion, "2025-11-25");
});

test("batch steps preserve headers, encodings, files, and binary destinations", async () => {
  const seen = [];
  const fixture = await httpFixture(async (req, res) => {
    const body = await bodyOf(req);
    seen.push({ url: req.url, headers: { ...req.headers }, body });
    if (req.url === "/download") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from("saved-from-batch"));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const scratch = mkdtempSync(join(tmpdir(), "codex-batch-"));
  const upload = join(scratch, "upload.txt");
  const download = join(scratch, "download.bin");
  writeFileSync(upload, "uploaded-from-batch");
  try {
    const replies = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
      } },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { requests: [
          { method: "POST", path: "/form", body_type: "form",
            headers: { "X-Batch-Test": "forwarded" }, body: { alpha: "beta" } },
          { method: "POST", path: "/upload", body_type: "multipart",
            body: { label: "batch" }, files: { upload } },
          { method: "GET", path: "/download", save_to: download },
        ] },
      } },
    ], {
      API_BASE_URL: fixture.origin,
      API_EVIDENCE: join(scratch, "evidence"),
      SANNR_ALLOW_SAVE_OUTSIDE: "1",
    });
    const result = envelope(byId(replies, 100));
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
    assert.equal(seen.length, 3);

    const form = seen.find((request) => request.url === "/form");
    assert.equal(form.headers["x-batch-test"], "forwarded");
    assert.match(form.headers["content-type"], /application\/x-www-form-urlencoded/);
    assert.equal(form.body.toString(), "alpha=beta");

    const multipart = seen.find((request) => request.url === "/upload");
    assert.match(multipart.headers["content-type"], /multipart\/form-data; boundary=/);
    assert.match(multipart.body.toString(), /uploaded-from-batch/);
    assert.match(multipart.body.toString(), /name="label"/);
    assert.equal(readFileSync(download, "utf8"), "saved-from-batch");
  } finally {
    await fixture.close();
  }
});

test("wait_for only polls GET or HEAD and never fetches again to format the result", async () => {
  const seen = [];
  const fixture = await httpFixture((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "HEAD") { res.end(); return; }
    res.end(req.url === "/ready" ? '{"state":"done"}' : '{"state":"pending"}');
  });
  const scratch = mkdtempSync(join(tmpdir(), "codex-wait-"));
  try {
    const replies = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
      } },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { on_failure: "continue", requests: [
          { method: "POST", path: "/unsafe", wait_for: {
            json: "state", equals: "done", timeout_ms: 0,
          } },
          { method: "HEAD", path: "/head", expect: [{ status: 200 }], wait_for: {
            json: "state", exists: false, timeout_ms: 1_000, interval_ms: 100,
          } },
          { method: "GET", path: "/ready", expect: [{ status: 200 }], wait_for: {
            json: "state", equals: "done", timeout_ms: 1_000, interval_ms: 100,
          } },
          { method: "GET", path: "/never", expect: [{ status: 200 }], wait_for: {
            json: "state", equals: "done", timeout_ms: 0, interval_ms: 100,
          } },
        ] },
      } },
    ], {
      API_BASE_URL: fixture.origin,
      API_EVIDENCE: join(scratch, "evidence"),
    });
    const result = envelope(byId(replies, 100));
    assert.equal(result.results[0].error.code, "INVALID_WAIT_FOR_METHOD");
    assert.equal(result.results[1].polls, 1);
    assert.equal(result.results[1].ok, true);
    assert.equal(result.results[2].polls, 1);
    assert.equal(result.results[2].ok, true);
    assert.equal(result.results[3].polls, 1);
    assert.equal(result.results[3].ok, false);
    assert.equal(result.results[3].error.code, "WAIT_FOR_TIMEOUT");
    assert.deepEqual(seen, ["/head", "/ready", "/never"],
      "terminal, timeout, or unsafe waits made an extra request");
  } finally {
    await fixture.close();
  }
});

test("wait_for does not treat a binary response as a satisfied condition", async () => {
  const seen = [];
  const fixture = await httpFixture((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.from("not-json-and-not-ready"));
  });
  const scratch = mkdtempSync(join(tmpdir(), "codex-binary-wait-"));
  try {
    const replies = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
      } },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { requests: [{ method: "GET", path: "/artifact", wait_for: {
          json: "state", equals: "done", timeout_ms: 0, interval_ms: 100,
        } }] },
      } },
    ], {
      API_BASE_URL: fixture.origin,
      API_EVIDENCE: join(scratch, "evidence"),
    });
    const result = envelope(byId(replies, 100));
    assert.equal(result.ok, false);
    assert.equal(result.results[0].mode, "error");
    assert.equal(result.results[0].error.code, "WAIT_FOR_TIMEOUT");
    assert.equal(result.results[0].polls, 1);
    assert.deepEqual(seen, ["/artifact"], "binary polling made an extra request");
  } finally {
    await fixture.close();
  }
});

test("literal credential headers and query parameters are refused without a request or echo", async () => {
  const seen = [];
  const fixture = await httpFixture((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const scratch = mkdtempSync(join(tmpdir(), "codex-secret-"));
  const evidenceDir = join(scratch, "evidence");
  try {
    const replies = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
      } },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { path: "/secret", headers: {
          "X-Vault-Token": "literal-header-do-not-echo",
          Authorization: "Bearer literal-auth-do-not-echo",
        }, params: { api_key: "literal-param-do-not-echo" } },
      } },
      { jsonrpc: "2.0", id: 101, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { path: "/secret?access_token=literal-url-do-not-echo" },
      } },
      { jsonrpc: "2.0", id: 102, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { path: fixture.origin.replace(
          "http://", "http://user:userinfo-do-not-echo@") + "/secret" },
      } },
    ], {
      API_BASE_URL: fixture.origin,
      API_EVIDENCE: evidenceDir,
    });
    for (const id of [100, 101, 102]) {
      const replyText = byId(replies, id).result.content[0].text;
      const result = JSON.parse(replyText);
      assert.equal(result.error.code, "CREDENTIAL_IN_REQUEST");
      assert.doesNotMatch(replyText, /do-not-echo/);
    }
    assert.deepEqual(seen, []);
    assert.equal(existsSync(evidenceDir) &&
      readdirSync(evidenceDir).some((name) => name.startsWith("run-")), false,
    "a refused credential request must not create an evidence run");
  } finally {
    await fixture.close();
  }
});

test("a named production upstream refuses writes but still permits reads", async () => {
  const seen = [];
  const fixture = await httpFixture((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  const scratch = mkdtempSync(join(tmpdir(), "codex-prod-"));
  const config = join(scratch, LAYOUT.environments);
  writeFileSync(config, JSON.stringify({
    v: 1,
    hosts: { productionVendor: { baseUrl: fixture.origin, production: true } },
  }));
  try {
    const replies = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
      } },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { method: "POST", path: "/write", upstream: "productionVendor",
          body_type: "multipart", body: { value: 1 },
          files: { upload: join(scratch, "must-not-be-read.txt") } },
      } },
      { jsonrpc: "2.0", id: 101, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { method: "GET", path: "/read", upstream: "productionVendor" },
      } },
      { jsonrpc: "2.0", id: 102, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { method: "DELETE", path: `${fixture.origin}/delete` },
      } },
    ], {
      API_CONFIG: config,
      API_BASE_URL: "http://127.0.0.1:1",
      API_ALLOW_PRODUCTION_WRITES: "0",
      API_EVIDENCE: join(scratch, "evidence"),
    });
    const write = envelope(byId(replies, 100));
    const read = envelope(byId(replies, 101));
    const fullUrlWrite = envelope(byId(replies, 102));
    assert.equal(write.error.code, "PRODUCTION_WRITE_REFUSED");
    assert.equal(write.error.details.environment, "productionVendor");
    assert.equal(fullUrlWrite.error.code, "PRODUCTION_WRITE_REFUSED",
      "a full URL must not bypass its configured host's production marker");
    assert.equal(read.status, 200, JSON.stringify(read).slice(0, 400));
    assert.deepEqual(seen, [{ method: "GET", url: "/read" }]);
  } finally {
    await fixture.close();
  }
});

test("a same-origin redirect cannot move a write from a dev base path into production", async () => {
  const seen = [];
  let origin;
  const fixture = await httpFixture((req, res) => {
    seen.push({ method: req.method, url: req.url });
    if (req.url === "/dev/record") {
      res.writeHead(307, { location: `${origin}/prod/record` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"deleted":true}');
  });
  origin = fixture.origin;
  const scratch = mkdtempSync(join(tmpdir(), "codex-prod-redirect-"));
  const config = join(scratch, LAYOUT.environments);
  writeFileSync(config, JSON.stringify({
    v: 1,
    hosts: { productionPath: { baseUrl: `${origin}/prod`, production: true } },
  }));
  try {
    const replies = await rpc([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-06-18",
      } },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: TOOL_NAME,
        arguments: { method: "DELETE", path: "/record" },
      } },
    ], {
      API_CONFIG: config,
      API_BASE_URL: `${origin}/dev`,
      API_ALLOW_PRODUCTION_WRITES: "0",
      API_EVIDENCE: join(scratch, "evidence"),
    });
    const result = envelope(byId(replies, 100));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PRODUCTION_WRITE_REFUSED");
    assert.equal(result.error.details.environment, "productionPath");
    assert.deepEqual(seen, [{ method: "DELETE", url: "/dev/record" }],
      "the redirected write reached the production base path");
    assert.ok((result.contract_delta ?? []).some((d) =>
      d.kind === "production-redirect-refused"));
  } finally {
    await fixture.close();
  }
});
