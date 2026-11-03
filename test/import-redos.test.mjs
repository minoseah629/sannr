// Security review finding 2 (2026-09-04): the header `include()` escaper in the
// Postman script translator was double-escaped source — a no-op — so an
// imported test like `pm.expect(...headers.get("etag")).to.include("(a+)+$")`
// landed VERBATIM as a `matches` pattern in a committed suite, and
// `lib/assertions.mjs` compiled it with `new RegExp` on every `suite run`.
// Measured: 117 s on a 31-character header. A ReDoS that detonates in CI.
//
// Three locks, each pinned here with the reviewer's own specimen:
//   1. the translator escapes metacharacters (the fix at the source);
//   2. normalizeSuite refuses a nested-quantifier or over-long pattern, so a
//      hand-edited suite cannot reintroduce it (the committed-file belt);
//   3. the assertion runner refuses such a pattern instead of compiling it,
//      so an old suite already on disk cannot hang a run (the last line).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { translateTests } from "../lib/import.mjs";
import { normalizeSuite, loadSuite, SUITE_DIR } from "../lib/suites.mjs";
import { OPERATORS, unsafePattern } from "../lib/assertions.mjs";

test("loadSuite refuses a hand-edited bomb on disk before any request is sent", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-redos-"));
  mkdirSync(join(root, SUITE_DIR), { recursive: true });
  writeFileSync(join(root, SUITE_DIR, "evil.json"), JSON.stringify({ v: 2, name: "evil", requests: [
    { method: "GET", path: "/things", expect: [{ header: "etag", matches: "^.*(a+)+$.*$" }] },
  ] }));
  assert.throws(() => loadSuite(root, "evil"), { code: "SUITE_PATTERN_REFUSED" });
});

const SPECIMEN = 'pm.test("h", () => { pm.expect(pm.response.headers.get("etag")).to.include("(a+)+$"); });';
const BOMB = "^.*(a+)+$.*$";

test("a header include() with regex metacharacters is escaped, never compiled raw", () => {
  const out = translateTests([SPECIMEN]);
  const clause = out.expect.find((c) => c.header === "etag");
  assert.ok(clause, "the header assertion translated");
  assert.equal(clause.matches, "^.*\\(a\\+\\)\\+\\$.*$");
  assert.equal(unsafePattern(clause.matches), null, "the escaped pattern is safe to compile");
});

test("normalizeSuite refuses a nested-quantifier matches pattern in a committed suite", () => {
  const { problems } = normalizeSuite("evil", { requests: [
    { method: "GET", path: "/things", expect: [{ header: "etag", matches: BOMB }] },
  ] });
  assert.equal(problems[0]?.code, "SUITE_PATTERN_REFUSED");
  assert.match(problems[0].message, /nested quantifier/);
});

test("normalizeSuite refuses an over-long matches pattern", () => {
  const { problems } = normalizeSuite("long", { requests: [
    { method: "GET", path: "/things", expect: [{ json: "id", matches: "a".repeat(201) }] },
  ] });
  assert.equal(problems[0]?.code, "SUITE_PATTERN_REFUSED");
});

test("the assertion runner refuses the bomb instead of compiling it", () => {
  const started = Date.now();
  const ok = OPERATORS.matches("a".repeat(40) + "b", BOMB);
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 1000, "refusal is immediate, not a backtracking hang");
  assert.equal(OPERATORS.matches("hello", "^h.*o$"), true, "ordinary patterns still work");
});
