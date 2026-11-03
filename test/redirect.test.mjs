// Redirect handling is a correctness boundary AND a credential boundary.
//
//   node --test test/redirect.test.mjs
//
// Both of the behaviours checked here were bugs found by pointing the suite at
// a local fixture after the public one went down. The client followed exactly
// one hop, so a two-hop chain returned the intermediate 302 as the answer; and
// it forwarded the configured credential to whatever host a server named in
// Location, which means any upstream could harvest the token by answering 302.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Drive the real MCP adapter rather than the core, so what is asserted is what
// an agent would actually receive.
function call(base, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_BASE_URL: base, API_USAGE_LOG: "/dev/null",
             API_CONTEXT_OFF: "1", API_EVIDENCE: ("/" + "tmp/redirect-evidence"), ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "", done = false;
    const finish = (fn, v) => { if (done) return; done = true; child.kill(); fn(v); };
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        try {
          const m = JSON.parse(l);
          if (m.id === 100) finish(resolve, JSON.parse(m.result.content[0].text));
        } catch { /* not our line */ }
      }
    });
    child.stdin.write(`${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: args } },
    ].map((m) => JSON.stringify(m)).join("\n")}\n`);
    setTimeout(() => finish(reject, new Error("timed out")), 20_000);
  });
}

test("a multi-hop redirect chain resolves to the final response", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/redirect/3" });
    assert.equal(e.status, 200, "the chain must resolve, not return an intermediate 302");
    assert.equal(e.mode, "passthrough");
    const hops = (e.contract_delta ?? []).filter((d) => d.kind === "redirect");
    assert.equal(hops.length, 3, "every hop is reported, because each one is contract drift");
  } finally { await f.close(); }
});

test("a redirect loop stops and says so", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/loop" });
    const stopped = (e.contract_delta ?? []).some((d) => d.kind === "redirect-loop" || d.kind === "redirect-chain-truncated");
    assert.ok(stopped, `expected the loop to be reported, got ${JSON.stringify(e.contract_delta)}`);
  } finally { await f.close(); }
});

test("the hop limit is reported rather than silently returning a 3xx", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/redirect/9" }, { API_MAX_REDIRECTS: "2" });
    assert.ok((e.contract_delta ?? []).some((d) => d.kind === "redirect-chain-truncated"),
      "a truncated chain must be labelled, or a 302 reads as the answer");
  } finally { await f.close(); }
});

test("a credential is NOT forwarded across origins", async () => {
  const f = await start();
  // A second origin standing in for whatever host the redirect names.
  const seen = [];
  const hostile = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => hostile.listen(0, "127.0.0.1", r));
  // A different port is a different origin, which is the boundary being tested.
  const other = `http://127.0.0.1:${hostile.address().port}`;
  try {
    const e = await call(f.origin, { path: "/redirect-to", params: { url: `${other}/collect` } },
      { API_AUTH: "bearer:REDIRECT_TEST_TOKEN", REDIRECT_TEST_TOKEN: "sk-live-must-not-travel" });
    assert.equal(e.status, 200);
    assert.equal(seen.length, 1, "the cross-origin hop should have been followed");
    assert.equal(seen[0].authorization, undefined,
      "the credential must not reach a host the original server chose");
    assert.ok(!JSON.stringify(seen[0]).includes("sk-live-must-not-travel"),
      "no header may carry the token to another origin");
    assert.ok((e.contract_delta ?? []).some((d) => d.kind === "cross-origin-redirect"),
      "crossing origins is reported, so the agent knows the credential was dropped");
  } finally { await f.close(); await new Promise((r) => hostile.close(r)); }
});

test("an ARBITRARY custom header is not forwarded across origins", async () => {
  // Red-team finding: cross-origin stripping used a denylist of known credential
  // headers, so custom headers travelled to the host the server named. Literal
  // credential-shaped headers are now refused before the first request; use
  // ordinary custom headers here to isolate and retain the redirect allowlist
  // guarantee. A denylist cannot enumerate arbitrary names.
  const f = await start();
  const seen = [];
  const hostile = createServer((req, res) => {
    seen.push(req.headers);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => hostile.listen(0, "127.0.0.1", r));
  const other = `http://127.0.0.1:${hostile.address().port}`;
  try {
    const e = await call(f.origin, { path: "/redirect-to", params: { url: `${other}/collect` },
      headers: { "X-Vault-Route": "vault-must-not-travel", "X-Company-Key": "co-must-not-travel" } });
    assert.equal(e.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]["x-vault-route"], undefined, "a custom header must not reach a server-chosen host");
    assert.equal(seen[0]["x-company-key"], undefined);
    assert.ok(!JSON.stringify(seen[0]).includes("must-not-travel"), "no supplied header may cross origins");
    // And the note must not claim safety it did not deliver — the original bug
    // printed "credentials were not forwarded" on the request that forwarded them.
    const note = (e.contract_delta ?? []).find((d) => d.kind === "cross-origin-redirect");
    assert.ok(note && /dropped/.test(note.note), "the note must state what actually happened to the headers");
  } finally { await f.close(); await new Promise((r) => hostile.close(r)); }
});

test("a cross-origin body-preserving redirect cannot exfiltrate an uploaded local file", async () => {
  const received = [];
  const hostile = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => hostile.listen(0, "127.0.0.1", r));
  const hostileOrigin = `http://127.0.0.1:${hostile.address().port}`;
  const source = createServer(async (req, res) => {
    for await (const _ of req) { /* consume the configured-origin upload */ }
    res.writeHead(307, { location: `${hostileOrigin}/collect` });
    res.end();
  });
  await new Promise((r) => source.listen(0, "127.0.0.1", r));
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "redirect-upload-"));
  const upload = join(dir, "private.txt");
  writeFileSync(upload, "local-file-must-not-cross-origins");
  try {
    const e = await call(sourceOrigin, { method: "POST", path: "/upload",
      body_type: "multipart", files: { artifact: upload } });
    assert.equal(e.status, 307, "the client should stop at the refusing redirect response");
    assert.equal(received.length, 0, "the unconfigured redirect origin received upload bytes");
    assert.ok((e.contract_delta ?? []).some((d) =>
      d.kind === "cross-origin-body-redirect-refused"),
    "the refusal must be visible instead of looking like a successful follow");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => source.close(r));
    await new Promise((r) => hostile.close(r));
  }
});

test("a bodyless write is not replayed across an origin redirect", async () => {
  let destinationHits = 0;
  const destination = createServer((req, res) => {
    destinationHits += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"deleted":true}');
  });
  await new Promise((r) => destination.listen(0, "127.0.0.1", r));
  const destinationOrigin = `http://127.0.0.1:${destination.address().port}`;
  const source = createServer((req, res) => {
    res.writeHead(307, { location: `${destinationOrigin}/records/1` });
    res.end();
  });
  await new Promise((r) => source.listen(0, "127.0.0.1", r));
  const sourceOrigin = `http://127.0.0.1:${source.address().port}`;
  try {
    const e = await call(sourceOrigin, { method: "DELETE", path: "/records/1" });
    assert.equal(e.ok, false);
    assert.equal(e.error.code, "CROSS_ORIGIN_WRITE_REDIRECT_REFUSED");
    assert.equal(destinationHits, 0, "the redirected DELETE reached another origin");
    assert.ok((e.contract_delta ?? []).some((d) =>
      d.kind === "cross-origin-write-redirect-refused"));
  } finally {
    await new Promise((r) => source.close(r));
    await new Promise((r) => destination.close(r));
  }
});

test("a same-origin redirect still carries the credential", async () => {
  const f = await start();
  try {
    const args = { path: "/redirect-to", params: { url: "/headers" } };
    const env = { API_AUTH: "bearer:REDIRECT_TEST_TOKEN", REDIRECT_TEST_TOKEN: "same-origin-ok" };
    const e = await call(f.origin, args, env);
    assert.equal(e.status, 200);
    assert.match(e.data?.headers?.authorization ?? "", /^\[withheld: secret; salted-sha256:[a-f0-9]{64}\]$/,
      "the returned credential must not survive in the agent-facing echo");
    assert.equal(JSON.stringify(e).includes(env.REDIRECT_TEST_TOKEN), false);
    // Assertions execute on the original response, proving the destination
    // received the complete credential without revealing it in presentation.
    const checked = await call(f.origin, { ...args, expect: [
      { json: "headers.authorization", equals: "Bearer same-origin-ok" },
    ] }, env);
    assert.equal(checked.status, 200);
    assert.equal(checked.ok, true, "same-origin redirects must keep authentication intact");
    assert.equal(checked.assertions.passed, 1);
    assert.equal(checked.assertions.failed, 0);
  } finally { await f.close(); }
});

test("cookies set during a redirect are sent to the next hop", async () => {
  const f = await start();
  try {
    // POST /login → 302 + Set-Cookie → GET is the ordinary shape of a login.
    const e = await call(f.origin, { path: "/cookies/set", params: { session: "abc123" } });
    assert.equal(e.status, 200);
    assert.equal(e.data?.cookies?.session, "[redacted]",
      "the redirect must receive the cookie, and its response echo must be scrubbed");
  } finally { await f.close(); }
});

test("a destination cookie is never copied back into the redirecting host's jar", async () => {
  const sourceCookies = [];
  const destination = createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "destination_session=must-stay-on-destination; Path=/",
    });
    res.end('{"ok":true}');
  });
  await new Promise((r) => destination.listen(0, "127.0.0.1", r));
  const destinationOrigin = `http://127.0.0.1:${destination.address().port}`;
  const source = createServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: `${destinationOrigin}/set-cookie` });
      res.end();
      return;
    }
    sourceCookies.push(req.headers.cookie ?? null);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  // Listen dual-stack so `localhost` and the destination's explicit IPv4
  // address are distinct cookie hostnames without relying on external DNS.
  await new Promise((r) => source.listen(0, r));
  const sourceOrigin = `http://localhost:${source.address().port}`;
  try {
    const result = await call(sourceOrigin, { requests: [
      { method: "GET", path: "/start" },
      { method: "GET", path: "/inspect" },
    ] });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
    assert.deepEqual(sourceCookies, [null],
      "the final response cookie was incorrectly stored under the original hostname");
  } finally {
    await new Promise((r) => source.close(r));
    await new Promise((r) => destination.close(r));
  }
});
