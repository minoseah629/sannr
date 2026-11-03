import { LAYOUT } from "../lib/layout.mjs";
// `sannr receipt` — the savings receipt (F6c, PRD Track A2).
//
//   node --test test/receipt.test.mjs
//
// The agent will not advocate for the tool (F6c, measured), so the tool must
// emit its own value as numbers a human reads to justify the spend. The one
// rule that matters here is HONESTY: the receipt counts only what the log
// actually recorded. A fresh log reports zero. A note added to the context
// file AFTER a request was made is not retroactively claimed as "served".
// These tests pin both directions: real savings are summed correctly, and
// absent savings are reported as absent, never invented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync, realpathSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { start } from "./fixture-server.mjs";
import { HOME_ENV_NAME } from "../lib/brand.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// A minimal repo with an sannr.json carrying notes, so the receipt can
// show WHICH gotchas were reused, not just how many.
//
// The repo is nested one level deep, at a fixed basename ("t"), because
// receipt/feedback now scope the usage log to basename(repoRoot()) —
// USAGE_LOG is machine-wide, so a receipt read standing in one repo must
// not silently answer for every other project on the machine. row()'s
// fixture rows below are all tagged project:"t" to match; the nesting is
// what makes that tag true rather than a lie the fixture tells the code
// under test.
function repoWithNotes(notesByOp = {}) {
  const parent = mkdtempSync(join(tmpdir(), "receipt-test-"));
  const dir = join(parent, "t");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  const operations = {};
  for (const [op, notes] of Object.entries(notesByOp))
    operations[op] = { source_file: null, verified_at: "2026-08-01", contract_digest: null,
      shape_hash: null, status_codes: [200], effect: "read", fields: {}, notes };
  writeFileSync(join(dir, LAYOUT.context),
    JSON.stringify({ version: 0, api: { name: "t" }, operations }, null, 2));
  return dir;
}

// One realistic usage row, as lib/client.mjs writes them. Overrides on top.
function row(over = {}) {
  return {
    ts: new Date().toISOString(), project: "t", origin: "own", host: "127.0.0.1",
    method: "GET", path: "/orders", queryKeys: [], status: 200, ok: true,
    mode: "summary", authUsed: null, tokenRefreshed: false, idempotencyKeySent: false,
    environment: null, rateLimitRemaining: null, laneWidth: 4, throttled: false,
    throttleWaitMs: 0, rawBytes: 4000, envelopeBytes: 800, tokensSaved: 800,
    contractLoaded: false, pagesFetched: null, drift: [], friction: null,
    knownOp: null, knownNotes: 0, knownProviderHash: null, ms: 12, runId: "run-x", ...over,
  };
}

function writeLog(dir, rows) {
  const log = join(dir, "usage.jsonl");
  writeFileSync(log, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  return log;
}

// Never throws on non-zero exit; the receipt's exit code is part of the contract.
function receipt(dir, log, args = []) {
  try {
    const out = execFileSync("node", [CLI, "receipt", ...args],
      { cwd: dir, encoding: "utf8", env: { ...process.env, API_USAGE_LOG: log } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// --- honesty: nothing in the log means nothing claimed ----------------------

test("a missing log reports zero honestly and exits 0", () => {
  const dir = repoWithNotes();
  const r = receipt(dir, join(dir, "nope.jsonl"));
  assert.equal(r.code, 0, "an empty history is a boring answer, not an error");
  assert.match(r.out, /0 tokens saved/);
  assert.match(r.out, /0 gotchas reused/);
});

test("an empty log reports zero via --json with no fabricated value", () => {
  const dir = repoWithNotes({ "GET /orders": ["cursor is opaque"] });
  const log = writeLog(dir, []);
  const r = receipt(dir, log, ["--json"]);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.calls, 0);
  assert.equal(j.tokens.saved, 0);
  assert.equal(j.gotchas.notes_delivered, 0);
  assert.equal(j.drift.calls, 0);
  assert.match(j.bottom_line, /0 tokens saved/);
});

test("a note in the context file is NOT counted unless the log recorded its delivery", () => {
  // The trap: the context file has a note for the exact op the log shows, but
  // the rows predate delivery logging (no knownNotes field). Reconstructing
  // "it would have matched" from the current file would claim value for a note
  // that may not have existed when the request ran. Count zero.
  const dir = repoWithNotes({ "GET /orders": ["429s lie; retry-after is in minutes"] });
  const legacy = row(); delete legacy.knownOp; delete legacy.knownNotes;
  const log = writeLog(dir, [legacy]);
  const j = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(j.gotchas.notes_delivered, 0,
    "a gotcha counts only when the log says it was served at request time");
  assert.equal(j.gotchas.requests_served, 0);
});

// --- the numbers: summed from the log, nothing else -------------------------

test("tokens saved, gotchas served, and drift are aggregated from real rows", () => {
  const dir = repoWithNotes({ "GET /orders": ["cursor is opaque; do not decode it", "page cap is 100"] });
  const log = writeLog(dir, [
    row({ tokensSaved: 500, knownOp: "GET /orders", knownNotes: 2 }),
    row({ tokensSaved: 300, knownOp: "GET /orders", knownNotes: 2 }),
    row({ tokensSaved: -20, path: "/tiny", drift: ["undeclared-path"] }),
  ]);
  const j = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(j.calls, 3);
  assert.equal(j.tokens.saved, 780, "net of the row where the envelope cost more");
  assert.equal(j.tokens.calls_where_envelope_cost_more, 1);
  assert.equal(j.gotchas.requests_served, 2);
  assert.equal(j.gotchas.notes_delivered, 4);
  const op = j.gotchas.operations.find((o) => o.op === "GET /orders");
  assert.ok(op, "per-op breakdown names the operation");
  assert.equal(op.requests, 2);
  assert.ok(op.notes.includes("cursor is opaque; do not decode it"),
    "the receipt shows WHICH gotchas were reused, pulled from the context file");
  assert.equal(j.drift.calls, 1);
  assert.equal(j.drift.kinds["undeclared-path"], 1);
  assert.match(j.bottom_line, /~780 tokens saved/);
  assert.match(j.bottom_line, /4 gotchas reused/);
});

test("receipt separates grant-delivered gotchas using provider hashes only", () => {
  const dir = repoWithNotes({ "GET /orders": ["local note"] });
  const providerPath = "/private/provider/should-never-appear";
  const log = writeLog(dir, [
    row({ knownOp: "GET /orders", knownNotes: 1 }),
    row({ knownOp: "GET /orders", knownNotes: 2,
      knownProviderHash: "sha256:provider-test-hash" }),
    row({ knownOp: "GET /orders", knownNotes: 1 }),
  ]);
  const j = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(j.gotchas.notes_delivered, 4);
  assert.equal(j.gotchas.grant_delivered.requests_served, 1);
  assert.equal(j.gotchas.grant_delivered.notes_delivered, 2);
  assert.deepEqual(j.gotchas.grant_delivered.providers, [{
    provider_hash: "sha256:provider-test-hash", requests_served: 1, notes_delivered: 2,
  }]);
  assert.ok(!JSON.stringify(j).includes(providerPath), "receipt never carries provider paths");
  const text = receipt(dir, log).out;
  assert.match(text, /gotchas delivered through grants: 2/);
  assert.match(text, /sha256:provider-test-hash/);
});

test("a net token LOSS is reported as a loss, not clamped to zero", () => {
  const dir = repoWithNotes();
  const log = writeLog(dir, [row({ tokensSaved: -120, rawBytes: 40 })]);
  const j = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(j.tokens.saved, -120, "an honest receipt shows the envelope costing more when it did");
  assert.match(j.bottom_line, /-120|cost/i);
});

test("--since windows the log by timestamp", () => {
  const dir = repoWithNotes();
  const old = row({ ts: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), tokensSaved: 9999 });
  const recent = row({ tokensSaved: 100, knownOp: "GET /orders", knownNotes: 1 });
  const log = writeLog(dir, [old, recent]);
  const j = JSON.parse(receipt(dir, log, ["--json", "--since", "24h"]).out);
  assert.equal(j.calls, 1, "rows outside the window are excluded");
  assert.equal(j.tokens.saved, 100);
  const all = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(all.calls, 2, "no --since means the whole log");
});

test("an unparseable --since is a usage error, not a silent full-log answer", () => {
  const dir = repoWithNotes();
  const log = writeLog(dir, [row()]);
  const r = receipt(dir, log, ["--since", "banana"]);
  assert.notEqual(r.code, 0, "a wrong window silently ignored would misreport the value");
});

test("receipt works without an sannr.json (counts hold, note texts absent)", () => {
  const parent = mkdtempSync(join(tmpdir(), "receipt-noctx-"));
  const dir = join(parent, "t");
  mkdirSync(dir);
  const log = writeLog(dir, [row({ tokensSaved: 50, knownOp: "GET /orders", knownNotes: 1 })]);
  const j = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(j.gotchas.notes_delivered, 1, "the log alone carries the counts");
});

// --- scope: a global log answers for ONE repo, not the whole machine --------
//
// Found 2026-08-23 via a real alpha feedback report: a two-route repo's
// receipt claimed 1,339 calls and 92 gotchas reused, because USAGE_LOG is
// shared across every project on the tester's machine and nothing scoped it.

test("rows from other projects on the same log are excluded, and named as excluded", () => {
  const dir = repoWithNotes({ "GET /orders": ["cursor is opaque"] });
  const log = writeLog(dir, [
    row({ project: "t", tokensSaved: 100, knownOp: "GET /orders", knownNotes: 1 }),
    row({ project: "some-other-repo", tokensSaved: 99999, knownOp: "GET /orders", knownNotes: 50 }),
    row({ project: "yet-another-one", tokensSaved: 88888 }),
  ]);
  const j = JSON.parse(receipt(dir, log, ["--json"]).out);
  assert.equal(j.calls, 1, "only this repo's row is counted");
  assert.equal(j.tokens.saved, 100, "the other projects' huge numbers must not leak in");
  assert.equal(j.gotchas.notes_delivered, 1);
  assert.deepEqual(j.scope, { project: "t", rows_this_project: 1, rows_total_machine: 3 });
  const text = receipt(dir, log, []).out;
  assert.match(text, /scoped to this repo: 1 of 3 calls machine-wide/,
    "the text form must say plainly that other projects were excluded, not just be quietly right");
});

test("with nothing to exclude, the text form stays quiet about scope", () => {
  const dir = repoWithNotes();
  const log = writeLog(dir, [row({ project: "t" })]);
  const text = receipt(dir, log, []).out;
  assert.ok(!text.includes("scoped to this repo"),
    "a note that never fires would train readers to ignore it when it matters");
});

// --- the sensor: the client must LOG the delivery it makes ------------------

test("a request served a known block with notes logs knownNotes in its usage row", async () => {
  // Without this row field the receipt has nothing honest to count: delivery
  // must be recorded at the moment it happens, by the client that did it.
  const f = await start();
  const ctxDir = repoWithNotes({ "GET /json": ["fixture note: ids are not stable"] });
  const log = join(ctxDir, "usage.jsonl");
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn("node", ["server.mjs"], {
        cwd: ROOT,
        env: { ...process.env, API_BASE_URL: f.origin, API_USAGE_LOG: log,
               API_CONTEXT_DIR: ctxDir, API_EVIDENCE: join(ctxDir, "ev") },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buf = "", done = false;
      const finish = (fn, v) => { if (done) return; done = true; child.kill(); fn(v); };
      child.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) {
          try { if (JSON.parse(l).id === 100) finish(resolvePromise); } catch { /* not ours */ }
        }
      });
      child.stdin.write(`${[
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: { path: "/json" } } },
      ].map((m) => JSON.stringify(m)).join("\n")}\n`);
      setTimeout(() => finish(reject, new Error("timed out")), 20_000);
    });
    const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const last = rows.at(-1);
    assert.equal(last.knownOp, "GET /json", "the row names the operation whose known block was served");
    assert.equal(last.knownNotes, 1, "the row counts the notes actually delivered");
  } finally { f.close(); }
});

test("a cross-delivered known block logs a provider hash, never its root", async () => {
  const f = await start();
  const consumer = repoWithNotes();
  const providerParent = mkdtempSync(join(tmpdir(), "receipt-provider-"));
  const provider = join(providerParent, "provider");
  mkdirSync(provider);
  execFileSync("git", ["init", "-q", "."], { cwd: provider });
  writeFileSync(join(provider, LAYOUT.context), JSON.stringify({ version: 0,
    api: { name: "provider" }, operations: {
      "GET /json": { source_file: null, verified_at: "2026-08-01", contract_digest: null,
        shape_hash: null, status_codes: [200], effect: "read", fields: {},
        notes: ["provider note"] },
    } }, null, 2));
  const home = mkdtempSync(join(tmpdir(), "receipt-home-"));
  const log = join(consumer, "usage.jsonl");
  const env = { ...process.env, [HOME_ENV_NAME]: home };
  execFileSync("node", [CLI, "grant", provider], { cwd: consumer, env,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn("node", ["server.mjs"], {
        cwd: ROOT,
        env: { ...env, API_BASE_URL: f.origin, API_USAGE_LOG: log,
               API_CONTEXT_DIR: consumer, API_EVIDENCE: join(consumer, "ev") },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let buf = "", done = false;
      const finish = (fn, v) => { if (done) return; done = true; child.kill(); fn(v); };
      child.stdout.on("data", (d) => {
        buf += d;
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          try { if (JSON.parse(line).id === 100) finish(resolvePromise); } catch { /* not ours */ }
        }
      });
      child.stdin.write(`${[
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: { path: "/json" } },
        },
      ].map((m) => JSON.stringify(m)).join("\n")}\n`);
      setTimeout(() => finish(reject, new Error("timed out")), 20_000);
    });
    const last = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse).at(-1);
    const expected = `sha256:${createHash("sha256").update(realpathSync(provider)).digest("hex").slice(0, 16)}`;
    assert.equal(last.knownNotes, 1);
    assert.equal(last.knownProviderHash, expected);
    assert.ok(!JSON.stringify(last).includes(provider), "the usage row never carries the provider root");
  } finally { f.close(); }
});
