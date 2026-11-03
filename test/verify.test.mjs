import { LAYOUT } from "../lib/layout.mjs";
// `sannr verify` — committed suites as conformance probes (T2).
//
//   node --test test/verify.test.mjs
//
// A saved suite is a set of claims about an API, and claims rot. `verify` runs
// every suite as a READ-side conformance check and reports what NO LONGER
// holds — each failing assertion as drift, expected-vs-actual — so stale
// knowledge goes red on a Tuesday in CI instead of quietly misleading the next
// agent. The command's own contract: it writes nothing (no sannr.json,
// no promotion, no suite rewrite), and against a production environment it
// never becomes the thing that mutated prod.
//
// Every test here failed against the pre-change CLI, which printed the help
// text and exited 1 for the unknown `verify` command.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// A sandbox that is a git repo of its own, so repoRoot() resolves to it and
// nothing this test writes can land in the checkout the runner sits in.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "verify-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function cli(dir, args, { input } = {}) {
  try {
    const out = execFileSync("node", [CLI, ...args],
      { cwd: dir, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// verify fetches from a server in THIS process, so the CLI must run async —
// execFileSync blocks the event loop the server needs to answer with.
const execFileP = promisify(execFile);
async function cliAsync(dir, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileP("node", [CLI, ...args], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, API_USAGE_LOG: "/dev/null", API_CONTEXT_OFF: "1",
             API_EVIDENCE: join(dir, "evidence"), ...env },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// A deterministic API that RECORDS every request it serves, because half of
// this file's assertions are about which requests verify must NOT send.
function startApi() {
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const send = (status, body) => {
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
      res.end(buf);
    };
    if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok" });
    if (req.method === "GET" && req.url === "/pieces") return send(200, { data: [{ id: 1, status: "active" }], total: 1 });
    if (req.method === "GET" && req.url === "/pieces/1") return send(200, { id: 1, status: "active", title: "first" });
    if (req.method === "GET" && req.url === "/wide-text") return send(200, { text: "a".repeat(5000) });
    if (req.method === "POST" && req.url === "/pieces") return send(201, { id: 9, status: "draft" });
    return send(404, { error: "no route" });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve({ hits, origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() })));
}

const GREEN = { v: 2, requests: [
  { id: "health", method: "GET", path: "/health",
    expect: [{ status: 200 }, { json: "status", equals: "ok" }] },
  { id: "pieces", method: "GET", path: "/pieces",
    expect: [{ status: 200 }, { json: "data.0.id", equals: 1 }] },
] };

// A claim the server no longer satisfies: the drift verify exists to name.
const STALE = { v: 2, requests: [
  { id: "one", method: "GET", path: "/pieces/1",
    expect: [{ status: 200 }, { json: "status", equals: "archived" }] },
] };

// Reads and a write in one suite, the shape a CRUD smoke suite actually has.
const MIXED = { v: 2, requests: [
  { id: "health", method: "GET", path: "/health", expect: [{ status: 200 }] },
  { id: "create", method: "POST", path: "/pieces", body: { title: "t" },
    expect: [{ status: 201 }] },
  { id: "list", method: "GET", path: "/pieces", expect: [{ status: 200 }] },
] };

// --- conformance ------------------------------------------------------------

test("verify runs every saved suite and exits 0 when the API still matches", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
    const r = await cliAsync(dir, ["verify"], { API_BASE_URL: api.origin });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /smoke/);
    assert.match(r.out, /2\/2/, "the summary counts verified claims, not vibes");
  } finally { api.close(); }
});

test("a claim the API no longer satisfies is reported as drift with expected-vs-actual, exit 1", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    cli(dir, ["suite", "save", "stale"], { input: JSON.stringify(STALE) });
    const r = await cliAsync(dir, ["verify", "stale"], { API_BASE_URL: api.origin });
    assert.equal(r.code, 1, "drift must fail the process, or the schedule cannot see it");
    assert.match(r.out, /drift/i, "the report must call rot by its name");
    assert.match(r.out, /archived/, "what the suite still claims");
    assert.match(r.out, /active/, "what the API now does");
  } finally { api.close(); }
});

test("--ci --json: machine-readable drift, non-zero exit; green world exits 0", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
    cli(dir, ["suite", "save", "stale"], { input: JSON.stringify(STALE) });
    const red = await cliAsync(dir, ["verify", "--ci", "--json"], { API_BASE_URL: api.origin });
    assert.equal(red.code, 1);
    const parsed = JSON.parse(red.out);
    assert.equal(parsed.ok, false);
    assert.ok(Array.isArray(parsed.drift) && parsed.drift.length === 1, "one failing assertion, one drift entry");
    assert.equal(parsed.drift[0].expected, "archived");
    assert.equal(parsed.drift[0].actual, "active");
    assert.equal(parsed.drift[0].suite, "stale");

    const green = await cliAsync(dir, ["verify", "smoke", "--ci"], { API_BASE_URL: api.origin });
    assert.equal(green.code, 0, green.out);
  } finally { api.close(); }
});

test("verify --json preserves refused operators and their code in flattened drift", async () => {
  const api = await startApi();
  const dir = sandbox();
  const cases = [
    { id: "refused-conjunction", expect: [{ json: "text", matches: "^a", type: "string" }] },
    { id: "failed-and-refused", expect: [{ json: "text", equals: "b", matches: "^a" }] },
    { id: "refused-single", expect: [{ json: "text", matches: "^a" }] },
  ];
  try {
    const saved = cli(dir, ["suite", "save", "refusals"], { input: JSON.stringify({ v: 2,
      requests: cases.map(c => ({ ...c, method: "GET", path: "/wide-text" })) }) });
    assert.equal(saved.code, 0, saved.out);
    const result = await cliAsync(dir, ["verify", "refusals", "--ci", "--json"], { API_BASE_URL: api.origin });
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.ok, false);
    assert.deepEqual(api.hits, cases.map(() => "GET /wide-text"));
    assert.equal(report.drift.length, 3);
    for (const { id } of cases) {
      const failure = report.suites[0].steps.find(s => s.id === id).failures[0];
      const drift = report.drift.find(d => d.step === id);
      assert.equal(failure.code, "ASSERTION_INPUT_OVERSIZED", "the client actually refused evaluation");
      assert.equal(drift.code, "ASSERTION_INPUT_OVERSIZED", "flattening must not turn a refusal into a comparison");
      if (id !== "refused-single") assert.deepEqual(drift.refused_ops, ["matches"]);
    }
    const mixed = report.drift.find(d => d.step === "failed-and-refused");
    assert.equal(mixed.check, "equals", "the first failed comparison must remain actionable");
    assert.deepEqual(mixed.checks, ["equals", "matches"]);
    assert.deepEqual(mixed.refused_ops, ["matches"], "the code belongs to the later refused operator");
  } finally { api.close(); }
});

test("a dead host is unverifiable, which is red — named transport cause, no stack trace", async () => {
  const api = await startApi();
  const { origin } = api;
  await new Promise((r) => { api.close(); setTimeout(r, 50); });
  const dir = sandbox();
  cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
  const r = await cliAsync(dir, ["verify", "--ci"], { API_BASE_URL: origin });
  assert.equal(r.code, 1, "claims that cannot be checked have not been verified");
  assert.match(r.out, /ECONNREFUSED/);
  assert.doesNotMatch(r.out, /triggerUncaughtException|node:internal/);
});

test("verify of a suite that does not exist names the ones that do", async () => {
  const dir = sandbox();
  cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
  const r = await cliAsync(dir, ["verify", "nope"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /SUITE_NOT_FOUND/);
  assert.match(r.out, /smoke/);
});

// --- --read-only ------------------------------------------------------------

test("--read-only runs the GET steps and never sends the suite's write", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    cli(dir, ["suite", "save", "crud"], { input: JSON.stringify(MIXED) });
    const r = await cliAsync(dir, ["verify", "--read-only"], { API_BASE_URL: api.origin });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /skip/i, "a skipped write is reported, not silently dropped");
    assert.ok(!api.hits.some((h) => h.startsWith("POST")),
      `--read-only must send no writes; server saw: ${api.hits.join(", ")}`);
    assert.ok(api.hits.some((h) => h === "GET /pieces"), "the reads still verify");
  } finally { api.close(); }
});

test("--read-only cascades: a read fed by a skipped write's capture is skipped, not false drift", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    const chained = { v: 2, requests: [
      { id: "create", method: "POST", path: "/pieces", capture: { pieceId: "id" },
        expect: [{ status: 201 }] },
      { id: "read-back", method: "GET", path: "/pieces/{pieceId}",
        expect: [{ status: 200 }] },
      { id: "health", method: "GET", path: "/health", expect: [{ status: 200 }] },
    ] };
    cli(dir, ["suite", "save", "chain"], { input: JSON.stringify(chained) });
    const r = await cliAsync(dir, ["verify", "chain", "--read-only"], { API_BASE_URL: api.origin });
    assert.equal(r.code, 0,
      `an orphaned {pieceId} must be a skip, not an UNRESOLVED_PLACEHOLDER red: ${r.out}`);
    assert.doesNotMatch(r.out, /UNRESOLVED_PLACEHOLDER/);
    assert.match(r.out, /pieceId/, "the skip names the capture the step lost");
    assert.ok(api.hits.every((h) => h === "GET /health"), `server saw: ${api.hits.join(", ")}`);
  } finally { api.close(); }
});

test("a suite that is all writes under --read-only says nothing was verified, and passes nothing off as green", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    const writes = { v: 2, requests: [
      { id: "create", method: "POST", path: "/pieces", expect: [{ status: 201 }] },
    ] };
    cli(dir, ["suite", "save", "writes"], { input: JSON.stringify(writes) });
    const r = await cliAsync(dir, ["verify", "writes", "--read-only"], { API_BASE_URL: api.origin });
    assert.equal(r.code, 0, "an explicit skip is not drift");
    assert.match(r.out, /nothing.*verif|0 of|no read/i, "the report must admit it checked nothing");
    assert.equal(api.hits.length, 0, "no request of any kind may leave");
  } finally { api.close(); }
});

// --- verify writes nothing --------------------------------------------------

test("verify leaves sannr.json byte-identical and rewrites no suite file", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
    const ctxFile = join(dir, LAYOUT.context);
    writeFileSync(ctxFile, JSON.stringify({ v: 1, api: { name: "t" }, operations: {} }, null, 1));
    const ctxBefore = readFileSync(ctxFile, "utf8");
    const suiteBefore = readFileSync(join(dir, LAYOUT.suites, "smoke.json"), "utf8");
    // API_CONTEXT_OFF cleared on purpose: the client must LOAD the context and
    // still not write it — verify observes, learn promotes.
    const r = await cliAsync(dir, ["verify"], { API_BASE_URL: api.origin, API_CONTEXT_OFF: "" });
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(ctxFile, "utf8"), ctxBefore, "verify must never promote into sannr.json");
    assert.equal(readFileSync(join(dir, LAYOUT.suites, "smoke.json"), "utf8"), suiteBefore);
  } finally { api.close(); }
});

test("verify creates no sannr.json where none exists", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify({ ...GREEN, requests: GREEN.requests.map(request => ({ ...request, capture_context: true })) }) });
    const r = await cliAsync(dir, ["verify"], { API_BASE_URL: api.origin, API_CONTEXT_OFF: "" });
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(join(dir, LAYOUT.context)), "verify must suppress even a suite entry’s explicit shared capture");
  } finally { api.close(); }
});

// --- production -------------------------------------------------------------

test("against a production environment the suite's write is refused and prod is never touched by a write", async () => {
  const api = await startApi();
  const dir = sandbox();
  try {
    writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
      v: 1, default: "prod",
      environments: { prod: { baseUrl: api.origin, production: true } },
    }));
    cli(dir, ["suite", "save", "crud"], { input: JSON.stringify(MIXED) });
    const full = await cliAsync(dir, ["verify", "--ci"]);
    // The write step goes red under the client's production guard — verify
    // reports that honestly rather than pretending the suite was checked.
    assert.equal(full.code, 1);
    assert.match(full.out, /PRODUCTION_WRITE_REFUSED/);
    assert.ok(!api.hits.some((h) => h.startsWith("POST")),
      `the guard must fire before the wire; server saw: ${api.hits.join(", ")}`);

    // --read-only is the posture that makes verify green against prod: the
    // write is skipped by plan, the reads verify, nothing mutates.
    api.hits.length = 0;
    const ro = await cliAsync(dir, ["verify", "--ci", "--read-only"]);
    assert.equal(ro.code, 0, ro.out);
    assert.ok(!api.hits.some((h) => h.startsWith("POST")));
  } finally { api.close(); }
});
