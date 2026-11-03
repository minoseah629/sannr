// The friction prompt must never break the budget.
//
//   node --test test/friction-budget.test.mjs
//
// Found by measurement, not by reasoning: with a 200 token budget the envelope
// came back at 229 because `learned` is ~110 tokens of prose and nothing in the
// shrink ladder touched it. The stress suite did not catch it, because friction
// never fires there — every host starts with a clean log and no failure runs.
//
// "Never exceeds N tokens" is written in the tool description the agent reads.
// A promise the tool makes about itself is exactly the kind of claim this
// project exists to check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./fixture-server.mjs";
import { ENVELOPE_FLOOR } from "../lib/client.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Pre-seed a failure run so the next success is a learning moment, without
// having to actually fail against a server first.
function seedFailures(host, method, path, statuses) {
  const dir = mkdtempSync(join(tmpdir(), "friction-budget-"));
  const log = join(dir, "usage.jsonl");
  const now = Date.now();
  writeFileSync(log, `${statuses.map((status, i) =>
    JSON.stringify({ ts: new Date(now - (statuses.length - i) * 60_000).toISOString(),
                     host, method, path, status })).join("\n")}\n`);
  return log;
}

function call(base, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_BASE_URL: base, API_CONTEXT_OFF: "1",
             API_EVIDENCE: ("/" + "tmp/friction-budget-ev"), ...env },
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
          // The MCP text IS what the agent receives, so measure that exact string.
          if (m.id === 100) finish(resolve, m.result.content[0].text);
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

const tok = (s) => Math.ceil(s.length / 4);

test("friction fires on a seeded failure run", async () => {
  const f = await start();
  try {
    const log = seedFailures("127.0.0.1", "GET", "/json", [409, 409, 422]);
    const raw = await call(f.origin, { path: "/json" }, { API_USAGE_LOG: log });
    const e = JSON.parse(raw);
    assert.ok(e.learned, "sanity check: the rest of this file is meaningless if this does not fire");
    assert.equal(e.learned.pattern, "409 409 422 200");
  } finally { await f.close(); }
});

for (const budget of [800, 400, 200, 150]) {
  test(`the envelope stays within a ${budget} token budget with friction present`, async () => {
    const f = await start();
    try {
      const log = seedFailures("127.0.0.1", "GET", "/stream/40", [409, 409, 422]);
      // A large collection AND a friction prompt on the same response: the two
      // things competing for the budget, which is the case that broke.
      const raw = await call(f.origin, { path: "/stream/40" },
        { API_USAGE_LOG: log, API_BUDGET: String(budget) });
      assert.ok(tok(raw) <= budget,
        `envelope was ${tok(raw)} tokens against a ${budget} budget`);
    } finally { await f.close(); }
  });
}

test("the envelope floor is real, and is what a sub-floor budget actually gets", async () => {
  // Not a friction bug: with data, shape, facets and the prompt all stripped, the
  // always-present keys still cost ~130 tokens. Asserting a 120 budget was
  // asserting something impossible. Pinned here so the floor cannot creep up
  // silently, since the tool description quotes it to every agent.
  const f = await start();
  try {
    const log = seedFailures("127.0.0.1", "GET", "/stream/40", [409, 409, 422]);
    const raw = await call(f.origin, { path: "/stream/40" },
      { API_USAGE_LOG: log, API_BUDGET: "40" });
    const e = JSON.parse(raw);
    assert.equal(e.learned, null, "everything droppable must be dropped before the floor is reached");
    assert.equal(e.data, null);
    assert.ok(tok(raw) <= ENVELOPE_FLOOR,
      `the floor moved: ${tok(raw)} tokens, ENVELOPE_FLOOR says ${ENVELOPE_FLOOR}`);
  } finally { await f.close(); }
});

test("under pressure the prompt degrades to the pointer before it disappears", async () => {
  const f = await start();
  try {
    const log = seedFailures("127.0.0.1", "GET", "/json", [409, 409, 422]);
    // Tight enough to force the prose out, loose enough to keep the pointer.
    const raw = await call(f.origin, { path: "/json" },
      { API_USAGE_LOG: log, API_BUDGET: "150" });
    const e = JSON.parse(raw);
    assert.ok(tok(raw) <= 150);
    if (e.learned) {
      assert.ok(e.learned.op && e.learned.write_it,
        "a degraded prompt keeps the operation and the command; those are the actionable parts");
    }
  } finally { await f.close(); }
});
