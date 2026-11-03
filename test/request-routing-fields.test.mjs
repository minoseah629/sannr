import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const runFile = promisify(execFile);
const clientUrl = new URL("../lib/client.mjs", import.meta.url).href;
const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));
async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "request-routing-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url); response.setHeader("content-type", "application/json"); response.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: "local",
    environments: { local: { baseUrl: origin } }, hosts: { peer: { baseUrl: `${origin}/peer` } } }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_|SANNR_)/.test(key))),
    API_CONFIG: join(root, LAYOUT.environments), API_CONTEXT_DIR: root, API_EVIDENCE: join(root, "evidence"),
    SANNR_HOME: join(root, "home"), API_USAGE_LOG: "", API_FRICTION_OFF: "1" };
  return { root, env, origin, calls };
}

test("ambiguous target keys refuse HTTP, curl and protocols before execution; envelope validation is atomic", async t => {
  const f = await fixture(t);
  const invocations = [];
  for (const field of ["host", "baseUrl", "base_url", "url", "origin"]) {
    invocations.push(["apiRequest", { path: "/health", [field]: "private-target-value" }]);
    invocations.push(["runEnvelope", { [field]: "private-target-value", requests: [{ path: "/health" }] }]);
    invocations.push(["runEnvelope", { on_failure: "continue", requests: [
      { method: "POST", path: "/write", body: { change: true } },
      { path: "/health", [field]: "private-target-value" },
    ] }]);
  }
  invocations.push(["apiRequest", { curl: `curl ${f.origin}/health`, host: "peer" }]);
  invocations.push(["apiRequest", { protocol: "graphql", path: "/graphql", host: "peer",
    graphql: { document: "query Health { health }" } }]);
  const script = `const client=await import(${JSON.stringify(clientUrl)});const results=[];
    for(const [name,args] of ${JSON.stringify(invocations)}) results.push(await client[name](args));
    process.stdout.write(JSON.stringify(results));`;
  const result = await runFile(process.execPath, ["--input-type=module", "-e", script],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 20000 });
  const results = JSON.parse(result.stdout);
  assert.equal(results.length, invocations.length);
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "REQUEST_ROUTING_FIELD_UNSUPPORTED");
    assert.match(result.error.next, /upstream/);
    assert.doesNotMatch(JSON.stringify(result), /private-target-value/);
    if (result.results) { assert.equal(result.attempted, 0); assert.deepEqual(result.results, []); }
  }
  assert.equal(f.calls.length, 0);
});

test("MCP preserves routing refusals and a corrected upstream request reaches only that provider", async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [serverPath], { cwd: f.root, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const pending = new Map(); let buffer = "";
  child.stdout.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line); const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  const call = async (id, args) => {
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP request timed out")), 10000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "api_request", arguments: args } }) + "\n");
    return JSON.parse((await reply).result.content[0].text);
  };
  const single = await call(1, { path: "/health", host: "peer" });
  assert.equal(single.error.code, "REQUEST_ROUTING_FIELD_UNSUPPORTED");
  const batch = await call(2, { requests: [{ path: "/health" }, { path: "/health", host: "peer" }] });
  assert.equal(batch.error.code, "REQUEST_ROUTING_FIELD_UNSUPPORTED");
  assert.equal(batch.attempted, 0);
  assert.equal(f.calls.length, 0);
  const fixed = await call(3, { path: "/health", upstream: "peer", expect: [{ status: 200 }] });
  assert.equal(fixed.ok, true);
  assert.deepEqual(f.calls, ["/peer/health"]);
});
