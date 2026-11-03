// Integration test: a long wait_for must not hold its host's concurrency slot.
// Requires editorial-api on 127.0.0.1:8787. Skips cleanly if it is not running.
//   node --test test/lane.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:8787";
// Probe at module scope: node:test evaluates `skip` eagerly, and passing a
// function there is always truthy, which silently skips the whole suite.
let up = false, writeKey = null;
try {
  const h = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
  up = h.ok;
  if (up) {
    const r = await fetch(`${BASE}/api-keys`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "lane-test", scopes: ["read", "write"] }),
    });
    writeKey = (await r.json()).key;
  }
} catch { up = false; }

test("wait_for releases the host slot between polls", { skip: up ? false : "editorial-api not running on 127.0.0.1:8787" }, async () => {
  const child = spawn("node", ["server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, API_BASE_URL: BASE, API_CONCURRENCY: "1",
           API_AUTH: "header:X-API-Key:LANE_TEST_KEY", LANE_TEST_KEY: writeKey,
           API_USAGE_LOG: "/dev/null" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const t0 = Date.now();
  const seen = [];
  child.stdout.on("data", (d) => {
    for (const l of String(d).split("\n").filter(Boolean)) {
      try { const m = JSON.parse(l); if (m.id >= 100) seen.push({ id: m.id, at: Date.now() - t0 }); } catch { }
    }
  });

  const msgs = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }];
  // A multi-second poll...
  msgs.push({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: {
    v: 2, requests: [
      { id: "start", method: "POST", path: "/operations/bulk-import",
        body: { pieces: Array.from({ length: 4 }, (_, i) => ({
          title: `lane-test ${Date.now()}-${i}`, lane: "evergreen", format: "blog" })),
          stagger_ms: 800 },
        capture: { opId: "id" } },
      { id: "await", method: "GET", path: "/operations/{opId}",
        wait_for: { json: "state", in: ["succeeded", "failed"], timeout_ms: 20000, interval_ms: 500 } },
    ] } } });
  // ...with ordinary calls to the SAME host queued right behind it.
  for (let i = 0; i < 3; i++)
    msgs.push({ jsonrpc: "2.0", id: 101 + i, method: "tools/call",
      params: { name: "api_request", arguments: { path: "/health", params: { probe: i } } } });

  child.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await new Promise((r) => setTimeout(r, 14000));
  child.kill();

  const wait = seen.find((s) => s.id === 100);
  const probes = seen.filter((s) => s.id > 100);
  assert.ok(wait, "the wait_for envelope never completed");
  assert.equal(probes.length, 3, "not all probes responded");
  // The point: probes must not be stuck behind a multi-second poll at concurrency 1.
  for (const p of probes)
    assert.ok(p.at < wait.at,
      `probe ${p.id} finished at ${p.at}ms, after the wait at ${wait.at}ms — the slot was held`);
  assert.ok(Math.max(...probes.map((p) => p.at)) < 2000,
    "probes should complete promptly, not merely before the wait");
});
