import { LAYOUT } from "../lib/layout.mjs";
import { createFixtureStack, fixtureContextFile } from "./helpers/stack-fixture.mjs";
// Provenance on every written claim, and AGE as a second staleness axis
// distinct from source drift (D1).
//
//   node --test test/provenance-decay.test.mjs
//
// Two gaps this closes:
//   1. PROVENANCE — a note, a verdict, and a promoted observation each record
//      WHO wrote them and WHEN, so a reader years later can weigh them. The
//      author is a marker (API_AUTHOR / git user.name / "agent"), never PII: an
//      email or a credential-shaped token degrades to the anonymous default
//      rather than landing, permanently, in a committed and cloned file.
//   2. AGE-BASED DECAY — confidenceFor grades whether the SOURCE moved (git);
//      an API can change under a client whose source never moved, so a claim
//      confirmed long ago is stale even when git shows nothing. Age travels as
//      its own axis, never conflated with the source reason, and show reports
//      both with the day count.
//
// Each property failed by construction before the feature: provenance fields
// did not exist, and freshnessFor returned no age axis.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freshnessFor, ageReason, authorMarker, provenanceStamp, learnFromResponse,
  inspectNoteHistory,
} from "../lib/context.mjs";

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "cli.mjs");

function repoWithContext() {
  const dir = mkdtempSync(join(tmpdir(), "prov-test-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  createFixtureStack(dir);
  writeFileSync(fixtureContextFile(dir),
    JSON.stringify({ v: 0, api: { name: "t" }, operations: {} }));
  return dir;
}

// A committed repo with a single backdated commit, so a VERIFIED op whose
// verified_at sits after that commit is genuinely source-unchanged.
function committedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "prov-committed-"));
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

const cli = (dir, args, env = {}) => {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }) };
  } catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};
const ctxOf = (dir) => JSON.parse(readFileSync(fixtureContextFile(dir), "utf8"));

// --- provenance: the author marker -----------------------------------------

test("authorMarker prefers API_AUTHOR, falls back, and never yields PII", () => {
  const saved = process.env.API_AUTHOR;
  try {
    process.env.API_AUTHOR = "Ada Lovelace";
    assert.equal(authorMarker("."), "Ada Lovelace");
    // An email is PII and must never be committed as an author.
    process.env.API_AUTHOR = "bob@customer.example.com";
    assert.equal(authorMarker("."), "agent", "an email author degrades to the anonymous marker");
    // A credential-shaped token likewise.
    process.env.API_AUTHOR = "xoxbREALLYLONGCREDENTIALSHAPEDTOKENVALUE1234567890";
    assert.equal(authorMarker("."), "agent");
    process.env.API_AUTHOR = "";
    assert.equal(typeof authorMarker("."), "string", "empty falls through to git/agent, always a string");
  } finally {
    if (saved === undefined) delete process.env.API_AUTHOR; else process.env.API_AUTHOR = saved;
  }
});

test("provenanceStamp is {by, at} with a date-only day", () => {
  const s = provenanceStamp(".", "2026-08-15");
  assert.equal(s.at, "2026-08-15");
  assert.equal(typeof s.by, "string");
});

// --- provenance: a note ----------------------------------------------------

test("a new note records who wrote it and when", () => {
  const dir = repoWithContext();
  const r = cli(dir, ["note", "POST /pieces/{id}/transition", "states are strictly sequential"],
    { API_AUTHOR: "Ada Lovelace" });
  assert.equal(r.code, 0, r.out);
  const e = ctxOf(dir).operations["POST /pieces/{id}/transition"];
  assert.deepEqual(e.notes, ["states are strictly sequential"]);
  assert.equal(e.notes_provenance[0].by, "Ada Lovelace");
  assert.match(e.notes_provenance[0].at, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(e.noted_by, "Ada Lovelace");
});

test("a note author that is an email never lands in the committed file", () => {
  const dir = repoWithContext();
  const r = cli(dir, ["note", "GET /x", "a gotcha"], { API_AUTHOR: "sterling@example.com" });
  assert.equal(r.code, 0, r.out);
  const raw = readFileSync(fixtureContextFile(dir), "utf8");
  assert.ok(!raw.includes("sterling@example.com"), "the email author must not be committed");
  assert.equal(ctxOf(dir).operations["GET /x"].notes_provenance[0].by, "agent");
});

test("adding a note to an op that predates provenance aligns by index and does not crash", () => {
  const dir = repoWithContext();
  // A file written before provenance existed: a note, no notes_provenance.
  const ctx = ctxOf(dir);
  ctx.operations["GET /legacy"] = { source_file: null, verified_at: null, contract_digest: null,
    shape_hash: null, status_codes: [], effect: null, fields: {}, notes: ["an old, unattributed note"] };
  writeFileSync(fixtureContextFile(dir), JSON.stringify(ctx));
  const reviewed = cli(dir, ["review", "--accept-notes", "GET /legacy", "--if-notes",
    inspectNoteHistory(ctx.operations["GET /legacy"]).digest], { API_AUTHOR: "Grace" });
  assert.equal(reviewed.code, 0, reviewed.out);
  const r = cli(dir, ["note", "GET /legacy", "a fresh attributed note", "--alongside"], { API_AUTHOR: "Grace" });
  assert.equal(r.code, 0, r.out);
  const e = ctxOf(dir).operations["GET /legacy"];
  assert.equal(e.notes.length, 2);
  assert.equal(e.notes_provenance[0], null, "the pre-existing note stays unattributed, not back-dated to Grace");
  assert.equal(e.notes_provenance[1].by, "Grace", "and the new note carries its own author, aligned by index");
});

// --- provenance: a verdict -------------------------------------------------

test("a new verdict records who wrote it and when, distinct from held_by", () => {
  const dir = repoWithContext();
  const r = cli(dir, ["verdict", "twilio/verify", "--verdict", "rejected",
    "--reason", "429 at 10 req/s sustained", "--class", "measured"], { API_AUTHOR: "Ada Lovelace" });
  assert.equal(r.code, 0, r.out);
  const v = ctxOf(dir).verdicts["twilio/verify"];
  assert.equal(v.recorded_by, "Ada Lovelace");
  assert.match(v.recorded_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(cli(dir, ["verdict", "show"]).out, /recorded by Ada Lovelace/);
});

// --- provenance: a promoted observation ------------------------------------

test("learnFromResponse stamps verified_by when an author is supplied, omits it otherwise", () => {
  const base = { op: "GET /x", method: "GET", path: "/x", body: { a: 1 }, status: 200,
    contract: undefined, environment: {}, contractDigest: null };
  assert.equal(learnFromResponse({ ...base, author: "agent" }).verified_by, "agent");
  assert.ok(!("verified_by" in learnFromResponse(base)), "no author, no field — pre-provenance shape preserved");
});

// --- age: a second staleness axis ------------------------------------------

test("freshnessFor returns an age axis, stale past the horizon, without touching confidence", () => {
  const saved = process.env.API_STALE_DAYS;
  try {
    process.env.API_STALE_DAYS = "100";
    const today = Date.parse("2026-08-15T00:00:00Z");
    // Source-unchanged (no source_file, matching digest): confidence is verified.
    const entry = { verified_at: "2026-01-01", source_file: null, contract_digest: "sha256:aa" };
    const r = freshnessFor(entry, ".", "sha256:aa", today);
    assert.equal(r.confidence, "verified", "age never flips the source-based label");
    assert.ok(r.age.days > 100, `expected >100 days, got ${r.age.days}`);
    assert.equal(r.age.stale, true, "a claim confirmed 226 days ago is past a 100-day horizon");
    // A recently confirmed claim is not age-stale.
    const fresh = freshnessFor({ verified_at: "2026-08-10", source_file: null, contract_digest: "sha256:aa" }, ".", "sha256:aa", today);
    assert.equal(fresh.age.stale, false);
    // Never executed carries no age.
    assert.equal(freshnessFor({ source_file: null }, ".", "sha256:aa", today).age, null);
  } finally {
    if (saved === undefined) delete process.env.API_STALE_DAYS; else process.env.API_STALE_DAYS = saved;
  }
});

test("the age clause is worded so it cannot be read as the source reason", () => {
  const clause = ageReason({ days: 214, horizon: 180, stale: true });
  assert.match(clause, /last confirmed 214 days ago/);
  assert.match(clause, /source-independent/);
  assert.doesNotMatch(clause, /source unchanged|source .* changed/, "must not collide with the source-drift wording");
});

test("show reports age-staleness SEPARATELY from source-staleness, with the day count", () => {
  const dir = committedRepo();
  const raw = readFileSync(join(dir, "openapi.yaml"), "utf8");
  const sha = execFileSync("node", ["-e",
    'const c=require("crypto");process.stdout.write("sha256:"+c.createHash("sha256").update(require("fs").readFileSync(process.argv[1],"utf8")).digest("hex").slice(0,16))',
    join(dir, "openapi.yaml")], { encoding: "utf8" });
  writeFileSync(join(dir, LAYOUT.context), `${JSON.stringify({
    v: 0, api: { name: "fixture", contract: "openapi.yaml", contract_digest: sha },
    generated_at: "2026-02-01",
    operations: { "GET /json": {
      source_file: "src/json.py", verified_at: "2026-02-01", contract_digest: sha,
      shape_hash: "sha256:aa", status_codes: [200], effect: "read", fields: {},
    } },
  }, null, 2)}\n`);

  // Horizon well below the ~195-day age: the op is source-unchanged but age-stale.
  const shown = JSON.parse(cli(dir, ["show", "GET /json"], { API_STALE_DAYS: "30" }).out);
  assert.equal(shown.confidence, "verified", "source grade is unchanged: still verified, not suspect");
  assert.match(shown.why.join("; "), /source unchanged/, "the source axis is still stated");
  assert.equal(shown.age.stale, true, "age remains its own axis");
  assert.match(shown.why.join("; "), /last confirmed \d+ days ago/, "with the day count");
});

test("show surfaces the age axis as its own field and in why, without conflation", () => {
  const dir = committedRepo();
  const sha = execFileSync("node", ["-e",
    'const c=require("crypto");process.stdout.write("sha256:"+c.createHash("sha256").update(require("fs").readFileSync(process.argv[1],"utf8")).digest("hex").slice(0,16))',
    join(dir, "openapi.yaml")], { encoding: "utf8" });
  writeFileSync(join(dir, LAYOUT.context), `${JSON.stringify({
    v: 0, api: { name: "fixture", contract: "openapi.yaml", contract_digest: sha },
    generated_at: "2026-02-01",
    operations: { "GET /json": {
      source_file: "src/json.py", verified_at: "2026-02-01", contract_digest: sha,
      shape_hash: "sha256:aa", status_codes: [200], effect: "read", fields: {},
    } },
  }, null, 2)}\n`);
  const shown = JSON.parse(cli(dir, ["show", "GET /json"], { API_STALE_DAYS: "30" }).out);
  assert.equal(shown.confidence, "verified");
  assert.equal(shown.age.stale, true);
  assert.ok(shown.why.some((w) => /source unchanged/.test(w)), "source reason present");
  assert.ok(shown.why.some((w) => /last confirmed \d+ days ago/.test(w)), "age reason present and separate");
});

// --- pre-provenance files still load ---------------------------------------

test("a file with notes-but-no-provenance and a verdict-but-no-recorded_by still loads", () => {
  const dir = repoWithContext();
  const ctx = ctxOf(dir);
  ctx.operations["GET /old"] = { source_file: null, verified_at: "2026-02-01", contract_digest: null,
    shape_hash: null, status_codes: [200], effect: "read", fields: {}, notes: ["legacy note, no provenance"] };
  ctx.verdicts = { "old/api": { verdict: "rejected", reason: "legacy verdict", class: "measured", last_confirmed: "2026-08-01", held_by: "org", revisable: false } };
  writeFileSync(fixtureContextFile(dir), JSON.stringify(ctx, null, 2));
  assert.equal(cli(dir, ["show", "GET /old"]).code, 0,
    "show must not crash on a pre-provenance file");
  const shown = cli(dir, ["verdict", "show"]);
  assert.equal(shown.code, 0);
  assert.match(shown.out, /old\/api/);
  assert.doesNotMatch(shown.out, /recorded by/, "no provenance to show, and none invented");
});
