// A baseline of accepted findings and a --ci diff against it: the difference
// between an audit a team runs once and one a team keeps running. The contract
// under test: --baseline writes the accepted state to a committed file, --ci
// exits non-zero ONLY on findings that file has never seen, and every finding
// carries a severity so a live /admin shadow route outranks a trailing-slash
// redirect.
//
//   node --test test/audit-ci.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync,  rmSync, existsSync, readFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { severityFor, ciFindings, diffBaseline, writeBaselineFile, readBaselineFile,
  BASELINE_FILE } from "../lib/ci.mjs";

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "cli.mjs");

// --- severity --------------------------------------------------------------

test("severity: a live /admin shadow route outranks a trailing-slash redirect", () => {
  assert.equal(severityFor({ kind: "shadow-route", op: "POST /admin/reindex" }), "high");
  assert.equal(severityFor({ kind: "shadow-route", op: "GET /internal/debug" }), "high");
  assert.equal(severityFor({ kind: "shadow-route", op: "GET /tags" }), "medium",
    "an undocumented route that is not sensitive is drift, not a backdoor");
  assert.equal(severityFor({ kind: "schema-mismatch" }), "high");
  assert.equal(severityFor({ kind: "missing" }), "high");
  assert.equal(severityFor({ kind: "redirect" }), "low");
  assert.equal(severityFor({ kind: "some-future-kind" }), "medium",
    "an unknown kind must not silently rank low");
});

test("ciFindings flattens surfaces + platform, sorts by severity, dedupes by key", () => {
  const results = [{
    name: "svc", kind: "documented",
    findings: [
      { op: "GET /a", kind: "redirect", detail: "documented at /a; server 308 → /a/" },
      { op: "GET /b", kind: "schema-mismatch", detail: "b.x: declared string, server returns object" },
      { op: "GET /a", kind: "redirect", detail: "documented at /a; server 308 → /a/" },  // duplicate
    ],
    shadowRoutes: [
      { method: "POST", path: "/admin/reset", file: "src/app.mjs", infra: false },
      { method: "GET", path: "/healthz", file: "src/app.mjs", infra: true },   // infra: never a finding
    ],
  }];
  const platform = [{ dimension: "error-shape", detail: "2 conventions across 3 services" }];
  const recs = ciFindings(results, platform);
  assert.deepEqual(recs.map((r) => r.severity), ["high", "high", "medium", "low"],
    "sorted high → low; infra shadow routes excluded");
  assert.equal(recs.filter((r) => r.kind === "redirect").length, 1, "identical findings collapse to one key");
  assert.ok(recs.some((r) => r.kind === "shadow-route" && r.op === "POST /admin/reset"));
  assert.ok(recs.some((r) => r.service === "platform" && r.kind === "platform-inconsistency"));
});

test("keys are stable across runs: a sampled id in the detail does not churn the baseline", () => {
  const runA = ciFindings([{ name: "svc", kind: "documented", findings: [
    { op: "GET /things/{id}", kind: "missing", detail: "documented but the server returns 404 for a listed id (abc-1)" }], shadowRoutes: [] }], []);
  const runB = ciFindings([{ name: "svc", kind: "documented", findings: [
    { op: "GET /things/{id}", kind: "missing", detail: "documented but the server returns 404 for a listed id (zzz-9)" }], shadowRoutes: [] }], []);
  assert.equal(runA[0].key, runB[0].key,
    "the volatile sampled id must not make an accepted finding read as new");
  const { added, resolved } = diffBaseline(runB, { findings: runA });
  assert.deepEqual([added, resolved], [[], []]);
});

test("diffBaseline reports only what changed, in both directions", () => {
  const mk = (op, kind) => ciFindings([{ name: "s", kind: "documented",
    findings: [{ op, kind, detail: "d" }], shadowRoutes: [] }], [])[0];
  const base = { findings: [mk("GET /a", "redirect"), mk("GET /b", "missing")] };
  const current = [mk("GET /b", "missing"), mk("GET /c", "erroring")];
  const { added, resolved, unchanged } = diffBaseline(current, base);
  assert.deepEqual(added.map((f) => f.op), ["GET /c"]);
  assert.deepEqual(resolved.map((f) => f.op), ["GET /a"]);
  assert.equal(unchanged, 1);
});

// --- the baseline file -----------------------------------------------------

test("writeBaselineFile / readBaselineFile round-trip; absence reads as null", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-base-"));
  assert.equal(readBaselineFile(dir), null, "no baseline yet is a state, not an error");
  const recs = ciFindings([{ name: "s", kind: "documented",
    findings: [{ op: "GET /a", kind: "redirect", detail: "d" }], shadowRoutes: [] }], []);
  const wrote = writeBaselineFile(dir, recs);
  assert.equal(wrote, join(dir, BASELINE_FILE));
  const back = readBaselineFile(dir);
  assert.equal(back.findings.length, 1);
  assert.equal(back.findings[0].key, recs[0].key, "the key survives the round-trip verbatim");
  rmSync(dir, { recursive: true, force: true });
});

test("readBaselineFile: a corrupt baseline throws a NAMED error, not a bare parse crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-corrupt-"));
  writeFileSync(join(dir, BASELINE_FILE), "{ not json");
  assert.throws(() => readBaselineFile(dir), (e) =>
    e.code === "BASELINE_CORRUPT" && e.path === join(dir, BASELINE_FILE) && e.message.includes(dir),
    "unparseable JSON carries the code, the path, and the parse detail");
  // Parses fine, but is not a baseline this tool wrote: same named failure —
  // a diff against { } would grade every accepted finding as new drift.
  writeFileSync(join(dir, BASELINE_FILE), JSON.stringify({ version: 1 }));
  assert.throws(() => readBaselineFile(dir), (e) => e.code === "BASELINE_CORRUPT",
    "valid JSON with no findings array is corrupt, not an empty baseline");
  rmSync(dir, { recursive: true, force: true });
});

// --- end to end through the CLI --------------------------------------------
//
// A real tree: one documented service whose source defines a route the spec
// never declares. No api-environments.json, so nothing is probed — the shadow
// route is the only finding, which makes exit codes unambiguous.

const SPEC = JSON.stringify({
  openapi: "3.0.0", info: { title: "widgets" },
  paths: { "/things": { get: { responses: { 200: { description: "ok" } } } } },
});

function tree() {
  const root = mkdtempSync(join(tmpdir(), "ci-e2e-"));
  const svc = join(root, "widgets");
  mkdirSync(join(svc, "src"), { recursive: true });
  writeFileSync(join(svc, "openapi.json"), SPEC);
  writeFileSync(join(svc, "src", "app.mjs"),
    `app.get("/things", h);\napp.get("/tags", h);\n`);
  return { root, svc };
}

const run = (args, cwd) => {
  try { return { code: 0, out: execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};

test("e2e: --baseline then --ci exits 0; a new sensitive route exits non-zero naming ONLY it", () => {
  const { root, svc } = tree();

  const base = run(["audit", root, "--baseline", "--no-execute"], root);
  assert.equal(base.code, 0);
  assert.ok(existsSync(join(root, BASELINE_FILE)), "--baseline writes the committed file");
  const stored = JSON.parse(readFileSync(join(root, BASELINE_FILE), "utf8"));
  assert.ok(stored.findings.some((f) => f.kind === "shadow-route" && f.op === "GET /tags"),
    "the pre-existing shadow route is the accepted state");

  const clean = run(["audit", root, "--ci", "--no-execute"], root);
  assert.equal(clean.code, 0, `an unchanged tree must exit 0:\n${clean.out}`);
  assert.ok(!/GET \/tags/.test(clean.out), "accepted findings are not re-printed in --ci");

  // The Tuesday-morning commit: someone lands an /admin route.
  writeFileSync(join(svc, "src", "app.mjs"),
    `app.get("/things", h);\napp.get("/tags", h);\napp.post("/admin/reset", h);\n`);
  const red = run(["audit", root, "--ci", "--no-execute"], root);
  assert.notEqual(red.code, 0, "a new finding must fail the build");
  assert.ok(/POST \/admin\/reset/.test(red.out), "the new finding is named");
  assert.ok(/high/.test(red.out), "and carries its severity");
  assert.ok(!/GET \/tags/.test(red.out.replace(/resolved[\s\S]*/, "")),
    "the accepted finding is not re-reported as new");

  // --ci --json: machine-readable, same verdict.
  const json = run(["audit", root, "--ci", "--json", "--no-execute"], root);
  assert.notEqual(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.new.length, 1);
  assert.equal(parsed.new[0].op, "POST /admin/reset");
  assert.equal(parsed.new[0].severity, "high");

  // Revert the commit: the finding resolves, the build goes green again.
  writeFileSync(join(svc, "src", "app.mjs"), `app.get("/things", h);\n`);
  const green = run(["audit", root, "--ci", "--no-execute"], root);
  assert.equal(green.code, 0, "resolved findings never fail the build");
  assert.ok(/GET \/tags/.test(green.out), "a resolved finding is reported so the baseline gets re-cut");

  rmSync(root, { recursive: true, force: true });
});

test("e2e: --ci without a baseline names the fix instead of diffing against nothing", () => {
  const { root } = tree();
  const r = run(["audit", root, "--ci", "--no-execute"], root);
  assert.notEqual(r.code, 0);
  assert.ok(/BASELINE_NOT_FOUND/.test(r.out), "a missing baseline is a named error, not an empty diff");
  assert.ok(/--baseline/.test(r.out), "the error says how to create one");
  rmSync(root, { recursive: true, force: true });
});

test("e2e: --ci against a corrupt baseline dies named, exit 1, no stack trace", () => {
  const { root } = tree();
  writeFileSync(join(root, BASELINE_FILE), "{ definitely not json");
  const r = run(["audit", root, "--ci", "--no-execute"], root);
  assert.equal(r.code, 1, "fail-safe stays fail-safe");
  assert.ok(/BASELINE_CORRUPT/.test(r.out), "a corrupt baseline is a named error, not a raw crash");
  assert.ok(r.out.includes(BASELINE_FILE), "the error names the file");
  assert.ok(/--baseline/.test(r.out), "and says to regenerate it");
  assert.ok(!/^\s+at /m.test(r.out), "a stranger's first CI run never sees a stack trace");
  rmSync(root, { recursive: true, force: true });
});

test("e2e: findings carry severity in --json audit output, sorted high first", () => {
  const { svc } = tree();
  // A sensitive and a benign shadow route in one service.
  writeFileSync(join(svc, "src", "app.mjs"),
    `app.get("/things", h);\napp.get("/tags", h);\napp.post("/admin/reset", h);\n`);
  const r = run(["audit", svc, "--json", "--no-execute"], svc);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.out);
  const shadows = parsed.surfaces[0].shadowRoutes.filter((s) => !s.infra);
  assert.ok(shadows.every((s) => ["high", "medium", "low"].includes(s.severity)),
    "every non-infra shadow route carries a severity");
  assert.equal(shadows.find((s) => s.path === "/admin/reset").severity, "high");
  assert.equal(shadows.find((s) => s.path === "/tags").severity, "medium");
  rmSync(dirname(svc), { recursive: true, force: true });
});
