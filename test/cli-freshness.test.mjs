import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
// CLI-level freshness invariants that unit tests on freshnessFor cannot see:
// what `learn` writes back, and which contract digest `show` grades
// against.
//
//   node --test test/cli-freshness.test.mjs
//
// Two real bugs live here:
//   - `learn` merged {...entry, ...learnFromResponse()} and learnFromResponse
//     never emits shape_diverged_at, so an audit-recorded divergence survived
//     re-learning forever — while learn DID overwrite shape_hash, destroying
//     the evidence the flag pointed at. Re-learning must clear the flag.
//   - `show` graded entries against the STORED ctx.api.contract_digest,
//     so an edited openapi.yaml was invisible until the next init/learn
//     refreshed the stored value. Drift detection must read the file on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync,  readFileSync, appendFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const sha = (s) => `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 16)}`;

const cli = (cwd, ...args) =>
  execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// The learn test's fixture server lives in THIS process, so the CLI must run
// asynchronously — execFileSync blocks the event loop and the child's fetch
// would wait forever on a server that can never answer.
const cliAsync = async (cwd, ...args) =>
  (await promisify(execFile)("node", [CLI, ...args], { cwd, encoding: "utf8" })).stdout;

// A sandbox that is a git repo of its own, so repoRoot() resolves to it and
// never escapes into whatever repo the test runner happens to sit in.
function sandbox(origin) {
  const dir = mkdtempSync(join(tmpdir(), "cli-freshness-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0",
    "info:",
    "  title: fixture",
    '  version: "1"',
    "paths:",
    "  /json:",
    "    get:",
    "      summary: sample",
    "",
  ].join("\n"));
  if (origin)
    writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
      v: 1, default: "local", environments: { local: { baseUrl: origin } },
    }));
  return dir;
}

const ctxOf = (dir) => JSON.parse(readFileSync(fixtureContextFile(dir), "utf8"));

test("re-learning clears a recorded shape divergence", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  createFixtureStack(dir, { baseUrl: f.origin, contract: "openapi.yaml" });
  try {
    await cliAsync(dir, "init");
    await cliAsync(dir, "learn");

    // Simulate the audit's baseline pass: the live shape stopped matching the
    // recorded hash, so the divergence date was written next to the entry.
    const ctx = ctxOf(dir);
    ctx.operations["GET /json"].shape_hash = "sha256:deadbeefdeadbeef";
    ctx.operations["GET /json"].shape_diverged_at = "2026-08-01";
    writeFileSync(fixtureContextFile(dir), JSON.stringify(ctx, null, 2));

    await cliAsync(dir, "learn");
    const entry = ctxOf(dir).operations["GET /json"];
    assert.equal(entry.shape_diverged_at, undefined,
      "a fresh execution IS the new baseline; the stale flag must not survive");
    assert.notEqual(entry.shape_hash, "sha256:deadbeefdeadbeef", "learn re-baselines the hash");

    const shown = JSON.parse(await cliAsync(dir, "show", "GET /json"));
    assert.equal(shown.confidence, "verified",
      "after re-learning, nothing the claim depends on has moved");
  } finally { await f.close(); }
});

test("show grades against the contract ON DISK, not the stored digest", () => {
  const dir = sandbox(null);
  const raw = readFileSync(join(dir, "openapi.yaml"), "utf8");
  const digest = sha(raw);
  writeFileSync(join(dir, LAYOUT.context), `${JSON.stringify({
    v: 0,
    api: { name: "fixture", contract: "openapi.yaml", contract_digest: digest },
    generated_at: "2026-08-01",
    operations: { "GET /json": {
      source_file: null, verified_at: "2026-08-01", contract_digest: digest,
      shape_hash: "sha256:aa", status_codes: [200], effect: "read", fields: {},
    } },
  }, null, 2)}\n`);

  assert.equal(JSON.parse(cli(dir, "show", "GET /json")).confidence, "verified",
    "untouched contract grades verified");

  // Edit the contract WITHOUT running init or learn. The stored digest still
  // matches the entry; only the file on disk knows the contract moved.
  appendFileSync(join(dir, "openapi.yaml"), "# a drive-by edit nobody re-learned\n");
  const shown = JSON.parse(cli(dir, "show", "GET /json"));
  assert.equal(shown.confidence, "suspect");
  assert.match(shown.why.join("; "), /contract digest diverged/);
});

// A repo with real backdated history, so a VERIFIED op is genuinely verified
// (its verified_at sits after the last commit) and the graded reason is exact.
function committedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cli-fresh-reason-"));
  const git = (args, date) => execFileSync("git",
    ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: dir, env: { ...process.env,
      GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` } });
  git(["init", "-q"], "2026-01-01");
  writeFileSync(join(dir, "openapi.yaml"),
    "openapi: 3.0.0\ninfo:\n  title: t\npaths:\n  /json:\n    get:\n      summary: s\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "json.py"), 'def json(): return {}  # "/json"\n');
  git(["add", "."], "2026-01-10");
  git(["commit", "-q", "-m", "init"], "2026-01-10");
  return dir;
}

test("show carries the graded REASON for a verified op", () => {
  const dir = committedRepo();
  const digest = sha(readFileSync(join(dir, "openapi.yaml"), "utf8"));
  writeFileSync(join(dir, LAYOUT.context), `${JSON.stringify({
    v: 0, api: { name: "fixture", contract: "openapi.yaml", contract_digest: digest },
    generated_at: "2026-02-01",
    operations: { "GET /json": {
      source_file: "src/json.py", verified_at: "2026-02-01", contract_digest: digest,
      shape_hash: "sha256:aa", status_codes: [200], effect: "read", fields: {},
    } },
  }, null, 2)}\n`);

  const shown = JSON.parse(cli(dir, "show", "GET /json"));
  assert.equal(shown.confidence, "verified");
  assert.match(shown.why.join("; "), /verified 2026-02-01.*source unchanged/,
    "the graded reason remains visible on the supported detail command");
});

test("show grades the edge shapes without crashing: no source_file, a null shape_hash", () => {
  const dir = committedRepo();
  const digest = sha(readFileSync(join(dir, "openapi.yaml"), "utf8"));
  writeFileSync(join(dir, LAYOUT.context), `${JSON.stringify({
    v: 0, api: { name: "fixture", contract: "openapi.yaml", contract_digest: digest },
    generated_at: "2026-02-01",
    operations: {
      "GET /json": { source_file: null, verified_at: "2026-02-01", contract_digest: digest,
        shape_hash: null, status_codes: [200], effect: "read", fields: {} },
      "GET /nope": { source_file: "src/missing.py", status_codes: [], effect: "read", fields: {} },
    },
  }, null, 2)}\n`);

  const sourceLess = JSON.parse(cli(dir, "show", "GET /json"));
  const missing = JSON.parse(cli(dir, "show", "GET /nope"));
  assert.equal(sourceLess.confidence, "verified");
  assert.match(sourceLess.why.join("; "), /verified 2026-02-01/,
    "the source-less verified op still shows its reason, minus a source line");
  assert.equal(missing.confidence, "unverified");
});
