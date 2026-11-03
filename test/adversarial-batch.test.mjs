import { LAYOUT } from "../lib/layout.mjs";
// Defects found by an independent adversarial suite (2026-08-14) that attacked
// the input space our own tests never entered. Each test here was confirmed to
// FAIL against the pre-fix code before the fix landed.
//
//   node --test test/adversarial-batch.test.mjs
//
// The through-line: every one lived in client.mjs core plumbing — interpolation,
// numeric coercion, lane state, error-envelope shape — the code our suite only
// exercised through adapters, never head-on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync,  rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { runEnvelope } from "../lib/client.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Drive the real MCP adapter against a given base URL, one call, return the
// envelope. This is what an agent actually receives.
function call(base, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_BASE_URL: base, API_USAGE_LOG: "/dev/null",
             API_CONTEXT_OFF: "1", API_EVIDENCE: ("/" + "tmp/adv-ev"), ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "", done = false;
    let timer;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); child.kill(); fn(v); };
    child.stdout.on("data", (d) => {
      buf += d; const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) { try { const m = JSON.parse(l); if (m.id === 100) finish(resolve, JSON.parse(m.result.content[0].text)); } catch { /**/ } }
    });
    child.stdin.write(`${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: args } },
    ].map((m) => JSON.stringify(m)).join("\n")}\n`);
    timer = setTimeout(() => finish(reject, new Error("timed out")), 25_000);
  });
}
const server = (handler) => new Promise((res) => {
  const s = createServer(handler);
  s.listen(0, "127.0.0.1", () => res({ origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => s.close(r)), server: s }));
});

test("MCP assertions and HTTP polling accept an empty blockers array by value", async () => {
  let requests = 0;
  const s = await server((req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"blockers":[],"details":{"eligible":true}}');
  });
  try {
    const result = await call(s.origin, { requests: [{ path: "/eligibility",
      wait_for: { json: "blockers", equals: [], timeout_ms: 500, interval_ms: 100 },
      expect: [{ status: 200 }, { json: "blockers", equals: [] },
        { json: "details", equals: { eligible: true } }],
    }] });
    assert.equal(requests, 1, "a matching condition must not poll until timeout");
    assert.equal(result.results[0].error, undefined);
    assert.equal(result.results[0].assertions.passed, 3);
    assert.equal(result.results[0].assertions.failed, 0);
  } finally { await s.close(); }
});

// #4 — the critical one. A captured value must not steer the next request.
test("a captured value cannot smuggle the next request to another path", async () => {
  const seen = [];
  const s = await server((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/thing" ? '{"id":"42/../../admin?elevate=1"}' : '{"ok":true}');
  });
  try {
    await call(s.origin, { requests: [
      { path: "/thing", capture: { thingId: "id" } },
      { path: "/things/{thingId}" },
    ] });
    assert.ok(!seen.some((u) => u.includes("/admin")),
      `request was smuggled to ${seen.find((u) => u.includes("/admin"))}`);
    assert.ok(seen.some((u) => u.includes("%2F") || u.includes("things")),
      "the captured value must land encoded, inside its path segment");
  } finally { await s.close(); }
});

// #5 — a placeholder the resolver does not recognise must error, not go out raw.
test("a hyphenated placeholder errors instead of being sent literally", async () => {
  const r = await runEnvelope({ v: 2, requests: [{ path: "/ops/{op-id}" }] });
  assert.equal(r.results[0].error?.code, "UNRESOLVED_PLACEHOLDER");
});

// #6 — a non-numeric timeout must be rejected, not turned into an infinite poll.
test("wait_for with a non-numeric timeout is rejected, not looped forever", async () => {
  const s = await server((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"state":"pending"}'); });
  try {
    const started = Date.now();
    // wait_for is a batch capability, so it is invoked through `requests`.
    const r = await call(s.origin, { requests: [{ path: "/op",
      wait_for: { json: "state", in: ["done"], timeout_ms: "soon", interval_ms: 100 } }] });
    assert.ok(Date.now() - started < 20_000, "a garbage timeout must fail fast, not poll indefinitely");
    assert.equal(r.results?.[0]?.error?.code, "INVALID_WAIT_FOR");
  } finally { await s.close(); }
});

// #9 — a 429 that carries only Retry-After still reports the throttle.
test("a 429 without RateLimit-* headers still reports the throttle", async () => {
  const s = await server((req, res) => { res.writeHead(429, { "retry-after": "120" }); res.end("slow down"); });
  try {
    const e = await call(s.origin, { path: "/x" });
    assert.equal(e.status, 429);
    assert.ok(e.rate_limit, "the one call where the agent most needs the number must not drop it");
    assert.equal(e.rate_limit.retry_after_ms, 120_000);
  } finally { await s.close(); }
});

// #11 — error envelopes keep the keys-always-present contract.
test("an error envelope carries the discovery key like every other envelope", async () => {
  const e = (await runEnvelope({ v: 2, requests: [{ path: "/x/{missing}" }] })).results[0];
  assert.ok("discovery" in e, "the keys-always-present contract must hold on error paths");
  assert.ok(!("count" in e), "the pre-ADR-0031 flat keys must be gone");
});

test("an error envelope carries recorded known context without inventing unknown knowledge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "known-error-"));
  writeFileSync(join(dir, LAYOUT.context), JSON.stringify({
    v: 0,
    api: { name: "fixture", contract: null, contract_digest: null },
    generated_at: "2026-08-24",
    operations: { "POST /orders": { notes: ["429 after ~60 req/min per org"] } },
  }));
  try {
    const e = await call("http://127.0.0.1:1", { requests: [{
      method: "POST", path: "/orders",
      wait_for: { json: "state", equals: "ready" },
    }] }, { API_CONTEXT_DIR: dir, API_CONTEXT_OFF: "" });
    assert.equal(e.results[0].error?.code, "INVALID_WAIT_FOR_METHOD");
    assert.deepEqual(e.results[0].known?.notes, ["429 after ~60 req/min per org"]);

    const unknown = await call("http://127.0.0.1:1", { requests: [{
      method: "POST", path: "/unknown",
      wait_for: { json: "state", equals: "ready" },
    }] }, { API_CONTEXT_DIR: dir, API_CONTEXT_OFF: "" });
    assert.equal(unknown.results[0].known, null, "an unknown operation must not inherit another operation's notes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// #14 — a 302 with no Location must not claim a truncated chain.
test("a 302 with no Location does not claim it stopped after N redirects", async () => {
  const s = await server((req, res) => { res.writeHead(302); res.end(); });   // no Location
  try {
    const e = await call(s.origin, { path: "/x" });
    const truncated = (e.contract_delta ?? []).some((d) => d.kind === "redirect-chain-truncated");
    assert.ok(!truncated, "zero hops were followed; claiming 5 is a false statement");
  } finally { await s.close(); }
});
