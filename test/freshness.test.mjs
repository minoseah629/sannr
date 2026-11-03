// Graded freshness: the label (verified / suspect / unverified) plus the WHY.
//
//   node --test test/freshness.test.mjs
//
// The grade combines everything a claim depends on — source_file commits,
// verified_at, the contract digest, the recorded shape hash — and the reasons
// are the point: "verified, source unchanged" and "verified April, source
// changed twice since, shape hash diverged" must be distinguishable without
// reading git yourself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshnessFor, confidenceFor } from "../lib/context.mjs";
import { baselineFindings } from "../lib/checks.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A repo whose history is under our control: every commit is backdated, so the
// string-comparable YYYY-MM-DD dates freshnessFor reads are exact.
function repoWith(commits) {
  const root = mkdtempSync(join(tmpdir(), "freshness-test-"));
  const git = (args, date) => execFileSync("git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env,
      GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` } });
  git(["init", "-q"], "2026-01-01");
  for (const { file, content, date } of commits) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
    git(["add", "."], date);
    git(["commit", "-q", "-m", `at ${date}`], date);
  }
  return root;
}

test("missing verification grades unverified without denying execution elsewhere", () => {
  const { confidence, reasons } = freshnessFor({ source_file: "src/server.mjs" }, ".", "sha256:aa");
  assert.equal(confidence, "unverified");
  assert.match(reasons.join("; "), /no execution verification recorded in this context/);
  assert.match(reasons.join("; "), /mapped to src\/server\.mjs/);
  assert.doesNotMatch(reasons.join("; "), /never executed/);
});

test("verified with an unmoved source says the source is unchanged, in commits", () => {
  const root = repoWith([{ file: "src/server.mjs", content: "a", date: "2026-01-10" }]);
  const entry = { verified_at: "2026-02-01", source_file: "src/server.mjs",
    contract_digest: "sha256:aa", shape_hash: "sha256:bb" };
  const { confidence, reasons } = freshnessFor(entry, root, "sha256:aa");
  assert.equal(confidence, "verified");
  const why = reasons.join("; ");
  assert.match(why, /verified 2026-02-01 \(0 commits ago\)/);
  assert.match(why, /contract unchanged/);
  assert.match(why, /source unchanged/);
});

test("source commits after verification grade suspect, counted and dated", () => {
  const root = repoWith([
    { file: "src/server.mjs", content: "a", date: "2026-01-10" },
    { file: "src/server.mjs", content: "b", date: "2026-03-05" },
    { file: "src/server.mjs", content: "c", date: "2026-04-01" },
  ]);
  const entry = { verified_at: "2026-02-01", source_file: "src/server.mjs", contract_digest: "sha256:aa" };
  const { confidence, reasons } = freshnessFor(entry, root, "sha256:aa");
  assert.equal(confidence, "suspect");
  const why = reasons.join("; ");
  assert.match(why, /verified 2026-02-01 \(2 commits ago\)/);
  assert.match(why, /src\/server\.mjs changed 2 times since, last 2026-04-01/);
});

test("a moved contract digest grades suspect and shows both digests", () => {
  const root = repoWith([{ file: "src/server.mjs", content: "a", date: "2026-01-10" }]);
  const entry = { verified_at: "2026-02-01", source_file: "src/server.mjs",
    contract_digest: "sha256:aaaaaaaaaaaaaaaa" };
  const { confidence, reasons } = freshnessFor(entry, root, "sha256:bbbbbbbbbbbbbbbb");
  assert.equal(confidence, "suspect");
  assert.match(reasons.join("; "), /contract digest diverged \(aaaaaaaa… → bbbbbbbb…\)/);
});

test("a recorded shape divergence grades suspect even with source and contract still", () => {
  const root = repoWith([{ file: "src/server.mjs", content: "a", date: "2026-01-10" }]);
  const entry = { verified_at: "2026-02-01", source_file: "src/server.mjs",
    contract_digest: "sha256:aa", shape_hash: "sha256:old", shape_diverged_at: "2026-04-09" };
  const { confidence, reasons } = freshnessFor(entry, root, "sha256:aa");
  assert.equal(confidence, "suspect");
  assert.match(reasons.join("; "), /shape hash diverged .*2026-04-09/);
});

test("a commit later the same day as a date-only verification grades suspect", () => {
  // YYYY-MM-DD strings compared with strict `>` could never see a commit made
  // later the SAME DAY as the verification. A date-only verified_at parses as
  // UTC midnight, so the ambiguous same-day case reads as "moved", never as
  // "fine" — the honest direction for a grade whose job is trust.
  const root = repoWith([{ file: "src/server.mjs", content: "a", date: "2026-02-01" }]);
  const entry = { verified_at: "2026-02-01", source_file: "src/server.mjs", contract_digest: "sha256:aa" };
  const { confidence, reasons } = freshnessFor(entry, root, "sha256:aa");
  assert.equal(confidence, "suspect");
  assert.match(reasons.join("; "), /src\/server\.mjs changed 1 time since/);
});

test("a full-timestamp verification after a same-day commit stays verified", () => {
  // The other half of the same-day fix: precision must not cry wolf. A learn
  // that ran AFTER the day's commit records the time, and the comparison
  // respects it.
  const root = repoWith([{ file: "src/server.mjs", content: "a", date: "2026-02-01" }]);
  const entry = { verified_at: "2026-02-01T23:59:00-08:00", source_file: "src/server.mjs",
    contract_digest: "sha256:aa" };
  const { confidence, reasons } = freshnessFor(entry, root, "sha256:aa");
  assert.equal(confidence, "verified");
  const why = reasons.join("; ");
  assert.match(why, /verified 2026-02-01/, "reasons show the date, not the full timestamp");
  assert.match(why, /source unchanged/);
});

test("confidenceFor stays the label of the graded answer", () => {
  const root = repoWith([{ file: "src/server.mjs", content: "a", date: "2026-01-10" }]);
  const entry = { verified_at: "2026-02-01", source_file: "src/server.mjs", contract_digest: "sha256:aa" };
  assert.equal(confidenceFor(entry, root, "sha256:aa"),
    freshnessFor(entry, root, "sha256:aa").confidence);
});

test("the edge shapes grade without crashing: no source_file, no git history, a null shape_hash", () => {
  const empty = mkdtempSync(join(tmpdir(), "freshness-edges-"));
  execFileSync("git", ["init", "-q"], { cwd: empty });
  // no source_file: verified, and the reasons carry no source line to explain.
  const a = freshnessFor({ verified_at: "2026-02-01", contract_digest: "sha256:aa", source_file: null }, empty, "sha256:aa");
  assert.equal(a.confidence, "verified");
  assert.doesNotMatch(a.reasons.join(";"), /source/);
  // a null shape_hash is the absence of a baseline, not a divergence: ignored.
  const b = freshnessFor({ verified_at: "2026-02-01", source_file: null, shape_hash: null }, empty, null);
  assert.equal(b.confidence, "verified");
  // an empty repo has no HEAD: the commit-distance query fails, comes back null,
  // and the "(N commits ago)" clause is simply omitted rather than throwing.
  const c = freshnessFor({ verified_at: "2026-02-01", source_file: "src/x.py" }, empty, null);
  assert.equal(c.confidence, "verified");
  assert.match(c.reasons.join(";"), /verified 2026-02-01/);
  assert.doesNotMatch(c.reasons.join(";"), /commits ago/);
});

test("the audit's baseline pass records a shape divergence for later grading", () => {
  const ctx = { operations: { "GET /a": { shape_hash: "sha256:old", verified_at: "2026-02-01" } } };
  const { findings, dirty } = baselineFindings(ctx, [{ op: "GET /a", hash: "sha256:new", rows: null, full: false }]);
  assert.equal(findings.length, 1, "the divergence is still a finding");
  assert.equal(ctx.operations["GET /a"].shape_hash, "sha256:old",
    "the stale baseline is the evidence; never overwritten here");
  assert.match(ctx.operations["GET /a"].shape_diverged_at ?? "", /^\d{4}-\d{2}-\d{2}$/,
    "the divergence date is remembered so freshness can be graded without probing");
  assert.equal(dirty, true);
});
