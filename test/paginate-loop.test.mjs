// A self-cycling paginator must not double-count the page it loops back to.
//
//   node --test test/paginate-loop.test.mjs
//
// Found in the F1-F6 QA pass: the follow loop's seen-set started empty, so a
// next link cycling back to the ORIGINAL page was not recognised on the first
// check — page 1's rows were accumulated a second time before the loop guard
// fired. Fixed by seeding the seen-set with the original page URL. This test
// fails against the empty-set version.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function call(base, args) {
  return new Promise((resolve, reject) => {
    const c = spawn("node", ["server.mjs"], { cwd: ROOT,
      env: { ...process.env, API_BASE_URL: base, API_USAGE_LOG: "/dev/null", API_CONTEXT_OFF: "1", API_EVIDENCE: ("/" + "tmp/ploop-ev") },
      stdio: ["pipe", "pipe", "ignore"] });
    let buf = "", done = false;
    const fin = (fn, v) => { if (done) return; done = true; c.kill(); fn(v); };
    c.stdout.on("data", (d) => { buf += d; const l = buf.split("\n"); buf = l.pop() ?? "";
      for (const x of l) { try { const m = JSON.parse(x); if (m.id === 100) fin(resolve, JSON.parse(m.result.content[0].text)); } catch { /**/ } } });
    c.stdin.write(`${[{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: args } }].map((m) => JSON.stringify(m)).join("\n")}\n`);
    setTimeout(() => fin(reject, new Error("timeout")), 15000);
  });
}

test("a next link cycling back to page 1 does not double-count its rows", async () => {
  // page 1 (no cursor) returns 3 rows and a next cursor; page 2 returns 3 rows
  // and a next cursor that points BACK to page 1 (cursor absent).
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const cursor = u.searchParams.get("cursor");
    // Page 2's ONLY next signal points back to page 1, so the loop guard is the
    // only thing that can stop it. An empty seen-set re-fetches page 1 (rows
    // inflate to 9) before catching the cycle; a seeded one stops at 6.
    const body = cursor === "p2"
      ? { data: [{ id: 4 }, { id: 5 }, { id: 6 }], next: "/loop" }
      : { data: [{ id: 1 }, { id: 2 }, { id: 3 }], next: "/loop?cursor=p2" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const e = await call(base, { path: "/loop", paginate: "all" });
    const rows = e.discovery?.count ?? (Array.isArray(e.data) ? e.data.length : null);
    assert.ok(rows <= 6, `rows must not be inflated by re-fetching page 1; got ${rows}`);
    assert.equal(e.discovery?.pages?.stopped_early, "loop", "the cycle must be reported as a loop stop");
  } finally { server.close(); }
});
