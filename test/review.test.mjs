import { LAYOUT } from "../lib/layout.mjs";
// Curation as a quick pass: `review` surfaces landfill candidates with WHY and
// the confidence reason; `confirm` re-dates one, `drop`/`prune` removes only a
// NAMED entry, and nothing is deleted without an explicit action. --dry-run
// writes nothing. A healthy, fresh, in-contract entry is never a candidate.
//
//   node --test test/review.test.mjs
//
// The four candidate kinds are orthogonal signals a reader acts on differently:
//   age-stale     last confirmed past the staleness horizon (source-independent)
//   source-moved  the mapped source file no longer exists at that path
//   shape-diverged the recorded response shape stopped matching the baseline
//   superseded    the operation is no longer declared in the contract

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewCandidates } from "../lib/curate.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const cli = (cwd, ...args) =>
  execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const cliFail = (cwd, ...args) => {
  try { execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return e; }
  throw new Error("expected the command to exit non-zero");
};

const TODAY = new Date().toISOString();           // a genuinely fresh confirmation
const RECENT = "2026-08-10";                       // days ago, well inside the horizon
const OLD = "2026-01-01";                          // > 180 days before 2026-08-15

// A repo whose history is backdated, so freshnessFor reads exact dates, with a
// contract on disk and one real source file.
function repoWith({ files = [], contractOps = ["/keep"] }) {
  const root = mkdtempSync(join(tmpdir(), "review-test-"));
  const git = (args, date) => execFileSync("git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env,
      GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` } });
  git(["init", "-q"], "2025-11-01");
  const spec = ["openapi: 3.0.0", "info:", "  title: t", '  version: "1"', "paths:"];
  for (const p of contractOps) spec.push(`  ${p}:`, "    get:", "      summary: s");
  writeFileSync(join(root, "openapi.yaml"), spec.join("\n") + "\n");
  for (const { file, content } of files) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  git(["add", "."], "2025-12-01");
  git(["commit", "-q", "-m", "init"], "2025-12-01");
  return root;
}

const sha = (s) => `sha256:${execFileSync("node", ["-e",
  `process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex").slice(0,16))`,
  s], { encoding: "utf8" })}`;

function writeCtx(root, operations) {
  const digest = sha(join(root, "openapi.yaml"));
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({
    v: 0, api: { name: "t", contract: "openapi.yaml", contract_digest: digest },
    generated_at: "2026-08-01", operations,
  }, null, 2) + "\n");
  return digest;
}

const healthy = (source_file, digest) => ({
  source_file, verified_at: RECENT, contract_digest: digest,
  shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {},
});

// --- reviewCandidates (pure) -----------------------------------------------

test("age-stale surfaces as a candidate with its reason and the confidence reason", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/a"] });
  const digest = sha(join(root, "openapi.yaml"));
  const ctx = { api: { contract_digest: digest }, operations: {
    "GET /a": { source_file: "src/a.py", verified_at: OLD, contract_digest: digest,
      shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} } } };
  const cands = reviewCandidates(ctx, root, { digest, contractOps: new Set(["GET /a"]) });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].op, "GET /a");
  assert.ok(cands[0].reasons.some((r) => r.kind === "age-stale"),
    "the age-stale kind is present");
  assert.match(cands[0].reasons.find((r) => r.kind === "age-stale").why, /past the .*horizon/);
  assert.match(cands[0].confidenceReason, /verified 2026-01-01/);
});

test("source-moved surfaces when the mapped source file no longer exists", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/b"] });
  const digest = sha(join(root, "openapi.yaml"));
  const ctx = { api: { contract_digest: digest }, operations: {
    "GET /b": { ...healthy("src/gone.py", digest) } } };
  const cands = reviewCandidates(ctx, root, { digest, contractOps: new Set(["GET /b"]) });
  assert.equal(cands.length, 1);
  assert.ok(cands[0].reasons.some((r) => r.kind === "source-moved"));
  assert.match(cands[0].reasons.find((r) => r.kind === "source-moved").why, /src\/gone\.py/);
});

test("shape-diverged surfaces from a recorded divergence", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/c"] });
  const digest = sha(join(root, "openapi.yaml"));
  const ctx = { api: { contract_digest: digest }, operations: {
    "GET /c": { ...healthy("src/a.py", digest), shape_diverged_at: "2026-07-01" } } };
  const cands = reviewCandidates(ctx, root, { digest, contractOps: new Set(["GET /c"]) });
  assert.equal(cands.length, 1);
  assert.ok(cands[0].reasons.some((r) => r.kind === "shape-diverged"));
});

test("superseded surfaces a real entry the contract dropped, but spares a note-only undeclared op", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/keep"] });
  const digest = sha(join(root, "openapi.yaml"));
  const ctx = { api: { contract_digest: digest }, operations: {
    "GET /keep": { ...healthy("src/a.py", digest) },
    "GET /removed": { ...healthy(null, digest) },              // was real, now not in contract
    "POST /note-only": { source_file: null, verified_at: null, contract_digest: null,
      shape_hash: null, status_codes: [], effect: null, fields: {}, notes: ["a gotcha"] },
  } };
  const contractOps = new Set(["GET /keep"]);
  const cands = reviewCandidates(ctx, root, { digest, contractOps });
  const ops = cands.map((c) => c.op);
  assert.ok(ops.includes("GET /removed"), "the dropped real op is superseded");
  assert.ok(cands.find((c) => c.op === "GET /removed").reasons.some((r) => r.kind === "superseded"));
  assert.ok(!ops.includes("POST /note-only"), "a note-only undeclared op is kept knowledge, not landfill");
  assert.ok(!ops.includes("GET /keep"), "a healthy in-contract op is never a candidate");
});

test("a healthy fresh in-contract entry is NOT a candidate", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/keep"] });
  const digest = sha(join(root, "openapi.yaml"));
  const ctx = { api: { contract_digest: digest }, operations: {
    "GET /keep": { ...healthy("src/a.py", digest) } } };
  const cands = reviewCandidates(ctx, root, { digest, contractOps: new Set(["GET /keep"]) });
  assert.equal(cands.length, 0);
});

// --- the CLI: review / confirm / drop / prune ------------------------------

function sandbox({ contractOps, operations }) {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps });
  writeCtx(root, operations);
  return root;
}

test("review lists candidates and writes nothing to the file", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/keep"] });
  const digest = writeCtx(root, {
    "GET /keep": { source_file: "src/a.py", verified_at: RECENT, contract_digest: null,
      shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} },
    "GET /removed": { source_file: null, verified_at: RECENT, contract_digest: null,
      shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} },
  });
  const before = readFileSync(join(root, LAYOUT.context), "utf8");
  const out = cli(root, "review");
  assert.match(out, /GET \/removed/, "the superseded op is surfaced");
  assert.match(out, /superseded/);
  assert.doesNotMatch(out, /GET \/keep\b/, "the healthy op is not listed as a candidate");
  assert.equal(readFileSync(join(root, LAYOUT.context), "utf8"), before,
    "review never writes");
});

test("drop removes only the named entry, and needs the op to exist", () => {
  const root = sandbox({ contractOps: ["/keep"], operations: {
    "GET /keep": { source_file: "src/a.py", verified_at: RECENT, contract_digest: null,
      shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} },
    "GET /removed": { source_file: null, verified_at: RECENT, contract_digest: null,
      shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} },
  } });
  cli(root, "review", "--drop", "GET /removed");
  const ops = JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8")).operations;
  assert.ok(!("GET /removed" in ops), "the named entry is gone");
  assert.ok("GET /keep" in ops, "no other entry was touched");

  const err = cliFail(root, "review", "--drop", "GET /does-not-exist");
  assert.match(err.stdout + err.stderr, /OPERATION_NOT_FOUND/);
});

test("confirm re-dates a candidate so it is fresh again", () => {
  const root = repoWith({ files: [{ file: "src/a.py", content: "a" }], contractOps: ["/a"] });
  writeCtx(root, {
    "GET /a": { source_file: "src/a.py", verified_at: OLD, contract_digest: null,
      shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {}, shape_diverged_at: "2026-07-01" },
  });
  // Before: it IS a candidate (age-stale + shape-diverged).
  assert.match(cli(root, "review"), /GET \/a/);
  cli(root, "review", "--confirm", "GET /a");
  const e = JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8")).operations["GET /a"];
  assert.equal(e.shape_diverged_at, undefined, "confirm clears a recorded divergence");
  assert.ok(Date.parse(e.verified_at) > Date.parse(OLD), "confirm re-dates the entry");
  // After: no longer an age/shape candidate.
  assert.doesNotMatch(cli(root, "review"), /GET \/a/);
});

test("prune --dry-run writes nothing; prune removes the named candidate", () => {
  const make = () => {
    const root = sandbox({ contractOps: ["/keep"], operations: {
      "GET /keep": { source_file: "src/a.py", verified_at: RECENT, contract_digest: null,
        shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} },
      "GET /removed": { source_file: null, verified_at: RECENT, contract_digest: null,
        shape_hash: "sha256:bb", status_codes: [200], effect: "read", fields: {} },
    } });
    return root;
  };
  const dry = make();
  const before = readFileSync(join(dry, LAYOUT.context), "utf8");
  cli(dry, "prune", "GET /removed", "--dry-run");
  assert.equal(readFileSync(join(dry, LAYOUT.context), "utf8"), before,
    "--dry-run changes nothing on disk");

  const real = make();
  cli(real, "prune", "GET /removed");
  const ops = JSON.parse(readFileSync(join(real, LAYOUT.context), "utf8")).operations;
  assert.ok(!("GET /removed" in ops) && "GET /keep" in ops);
});
