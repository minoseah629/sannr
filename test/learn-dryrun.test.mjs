import { LAYOUT } from "../lib/layout.mjs";
import { createFixtureStack, fixtureContextFile } from "./helpers/stack-fixture.mjs";
// DRY-RUN PROMOTION — `sannr learn --dry-run` executes the safe reads but
// writes NOTHING, and reports exactly what WOULD be promoted into the committed
// file and what would be REFUSED and why. It is the gate a human or CI runs
// before letting anything land in the repo.
//
//   node --test test/learn-dryrun.test.mjs
//
// The load-bearing property is the negative one: sannr.json must be
// byte-identical before and after, so the preview can never quietly become a
// write. Written before the flag exists (S1): learn currently ignores
// --dry-run and writes, so the byte-identical assertion fails first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const cliAsync = async (cwd, ...args) =>
  (await promisify(execFile)("node", [CLI, ...args], { cwd, encoding: "utf8" })).stdout;

// A contract that declares one enum field (tier) and leaves the rest open, over
// the fixture's collection endpoint /paginate/page — so a real learn has both a
// would-promote (tier values) and a would-refuse (name, id) to show.
function sandbox(origin) {
  const dir = mkdtempSync(join(tmpdir(), "learn-dryrun-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0",
    "info: { title: fixture, version: '1' }",
    "paths:",
    "  /paginate/page:",
    "    get:",
    "      summary: rows",
    "      responses:",
    "        '200':",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: object",
    "                properties:",
    "                  data:",
    "                    type: array",
    "                    items:",
    "                      type: object",
    "                      properties:",
    "                        id: { type: integer }",
    "                        name: { type: string }",
    "                        tier: { type: string, enum: [basic, pro] }",
    "",
  ].join("\n"));
  createFixtureStack(dir, { baseUrl: origin, contract: "openapi.yaml" });
  return dir;
}

function mixedSandbox(origin) {
  const dir = mkdtempSync(join(tmpdir(), "learn-mixed-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0",
    "info: { title: fixture, version: '1' }",
    "paths:",
    "  /paginate/page:",
    "    get:",
    "      responses: { '200': { description: ok } }",
    "  /orders:",
    "    post:",
    "      responses: { '201': { description: created } }",
    "  /orders/{id}:",
    "    get:",
    "      responses: { '200': { description: ok } }",
    "",
  ].join("\n"));
  createFixtureStack(dir, { baseUrl: origin, contract: "openapi.yaml" });
  return dir;
}

const ctxBytes = (dir) => readFileSync(fixtureContextFile(dir));

test("learn --dry-run leaves sannr.json byte-identical", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");
    const before = ctxBytes(dir);
    await cliAsync(dir, "learn", "--dry-run");
    const after = ctxBytes(dir);
    assert.ok(before.equals(after),
      "a dry run must write nothing — the file is the gate, not the outcome");
  } finally { await f.close(); }
});

test("learn --dry-run reports the would-promote and would-refuse diff", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");
    const out = JSON.parse(await cliAsync(dir, "learn", "--dry-run", "--json"));
    assert.equal(out.dry_run, true);
    const op = out.operations.find((o) => o.op === "GET /paginate/page");
    assert.ok(op, "the executed read is reported");
    // tier is a declared enum → its values would be promoted.
    assert.deepEqual([...op.would_promote.fields.tier.values].sort(), ["basic", "pro"]);
    // name/id are not declared enums → refused, WITH a reason.
    const refusedFields = op.would_refuse.map((r) => r.field);
    assert.ok(refusedFields.includes("name"));
    const nameRefusal = op.would_refuse.find((r) => r.field === "name");
    assert.match(nameRefusal.reason, /enum|declared/i,
      "a refusal must be explainable in a security review, not a silent drop");
  } finally { await f.close(); }
});

test("learn --dry-run never leaks a refused value into its own report", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");
    const raw = await cliAsync(dir, "learn", "--dry-run", "--json");
    // name values (item-0, item-1, …) are refused; the report shows the field
    // and the reason, never the values themselves.
    assert.ok(!/item-\d/.test(raw), "a would-refuse report must not print the refused values");
  } finally { await f.close(); }
});

test("a real learn AFTER a dry run promotes exactly what the dry run predicted", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");
    const preview = JSON.parse(await cliAsync(dir, "learn", "--dry-run", "--json"))
      .operations.find((o) => o.op === "GET /paginate/page");
    await cliAsync(dir, "learn");
    const entry = JSON.parse(readFileSync(fixtureContextFile(dir), "utf8"))
      .operations["GET /paginate/page"];
    // The dry run is a faithful preview: what it said would promote is what a
    // real learn wrote — same code path, no divergence.
    assert.deepEqual(entry.fields.tier.values, preview.would_promote.fields.tier.values);
    assert.equal(entry.withheld, preview.would_refuse.length);
  } finally { await f.close(); }
});

test("learn names skipped writes and parameterized reads in text and json output", async () => {
  const f = await start();
  try {
    for (const args of [["learn", "--env", "local"], ["learn", "--env", "local", "--json"]]) {
      const dir = mixedSandbox(f.origin);
      await cliAsync(dir, "init");
      const out = JSON.parse(await cliAsync(dir, ...args));
      assert.equal(out.executed, 1);
      assert.equal(out.learned, 1);
      assert.equal(out.drift_found, 0);
      assert.equal(out.skipped.length, 2);
      assert.deepEqual(out.skipped.find((s) => s.op === "POST /orders"), {
        op: "POST /orders",
        reason: "write — needs --agents",
        unblock: "Use an explicitly authorized agent probe or suite; learn executes GET/HEAD only.",
      });
      assert.deepEqual(out.skipped.find((s) => s.op === "GET /orders/{id}"), {
        op: "GET /orders/{id}",
        reason: "no id available",
        unblock: "Provide a concrete identifier and run that operation explicitly.",
      });
    }
  } finally { await f.close(); }
});

// --- learn --agents: the flag IS the opt-in (QA setup-path bug, 2026-08-24) --

// Three surfaces promise `learn --agents` wires the pointer block — this
// command's own --help example, doctor's wiring fix line, SETUP.md — and the
// code ignored the flag whenever no block existed yet: exit 0, an empty
// pointers_refreshed, nothing on disk. A user following doctor's own
// remediation got a silent green. Pinned here in both directions: the flag
// creates-or-refreshes unconditionally, and its ABSENCE stays exactly as
// non-intrusive as it always was.

import { POINTER_BEGIN, POINTER_CLI_NAME } from "../lib/brand.mjs";
import { POINTER_FILES } from "../lib/capabilities.mjs";

const blockCount = (dir, name) => {
  const p = join(dir, name);
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf8").split(POINTER_BEGIN).length - 1;
};

test("learn --agents on a never-wired repo creates canonical guidance and the Claude bridge, and reports both", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");                       // knowledge file only: no pointers yet
    for (const n of POINTER_FILES) assert.equal(existsSync(join(dir, n)), false);
    const out = JSON.parse(await cliAsync(dir, "learn", "--env", "local", "--agents"));
    assert.equal(blockCount(dir, "AGENTS.md"), 1, "AGENTS.md must carry exactly one pointer block");
    assert.equal(blockCount(dir, "CLAUDE.md"), 0, "the new Claude file must not duplicate the shared block");
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    // The same act init --agents performs reports under the same key, in the
    // same {file, action} shape — one vocabulary across both commands.
    assert.deepEqual(out.pointers_written, POINTER_FILES.map((file) => ({ file, action: "created" })));
    assert.deepEqual(out.pointers_refreshed, [], "nothing pre-existed, so nothing was refreshed");
    assert.deepEqual(out.omitted, POINTER_FILES.map((surface) => ({
      surface, command: POINTER_CLI_NAME,
      reason: out.command_resolution.portable.reason,
      remedy: out.command_resolution.portable.remedy,
    })), "learn --agents must name the same missing portable command on both pointer surfaces");
  } finally { await f.close(); }
});

test("learn --dry-run --agents previews the same omissions without wiring pointers", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");
    const out = JSON.parse(await cliAsync(dir, "learn", "--env", "local", "--dry-run", "--agents", "--json"));
    assert.deepEqual(out.pointers, POINTER_FILES.map((file) => ({ file, action: "would write" })));
    assert.deepEqual(out.omitted.map(({ surface }) => surface), POINTER_FILES);
    for (const file of POINTER_FILES) assert.equal(existsSync(join(dir, file)), false);
  } finally { await f.close(); }
});

test("learn preflights a read-only second pointer before requests or any write", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = sandbox(origin);
  try {
    await cliAsync(dir, "init");
    const before = ctxBytes(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "team-owned\n");
    chmodSync(join(dir, "CLAUDE.md"), 0o400);
    let error;
    try { await cliAsync(dir, "learn", "--agents", "--json"); }
    catch (caught) { error = caught; }
    assert.ok(error, "learn unexpectedly crossed a known write conflict");
    assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, /WRITE_PLAN_CONFLICT|not writable/i);
    assert.equal(requests, 0, "learn executed a request before completing its write plan");
    assert.ok(ctxBytes(dir).equals(before), "learn changed context before the pointer write failed");
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "team-owned\n");
  } finally {
    chmodSync(join(dir, "CLAUDE.md"), 0o600);
    rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("learn WITHOUT --agents on a never-wired repo creates nothing: the non-intrusive default stays pinned", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init");
    const out = JSON.parse(await cliAsync(dir, "learn", "--env", "local"));
    for (const n of POINTER_FILES)
      assert.equal(existsSync(join(dir, n)), false, `${n} must not spring into being uninvited`);
    assert.deepEqual(out.pointers_refreshed, []);
    assert.equal(out.pointers_written, undefined, "no opt-in, no written report to imply one");
  } finally { await f.close(); }
});

test("learn --agents over an existing block refreshes it in place: one block, never a duplicate", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "Existing Claude project instructions.\n");
    await cliAsync(dir, "init", "--agents");           // wired at birth
    for (const n of POINTER_FILES) assert.equal(blockCount(dir, n), 1);
    const out = JSON.parse(await cliAsync(dir, "learn", "--env", "local", "--agents"));
    for (const n of POINTER_FILES)
      assert.equal(blockCount(dir, n), 1, `${n} must still carry exactly one block after a re-wire`);
    assert.deepEqual(out.pointers_written, POINTER_FILES.map((file) => ({ file, action: "updated" })));
    assert.deepEqual(out.pointers_refreshed, POINTER_FILES,
      "the refreshed list keeps meaning what it always meant");
  } finally { await f.close(); }
});

test("learn without --agents still refreshes an existing block: today's behavior, unchanged", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    writeFileSync(join(dir, "CLAUDE.md"), "Existing Claude project instructions.\n");
    await cliAsync(dir, "init", "--agents");
    const out = JSON.parse(await cliAsync(dir, "learn", "--env", "local"));
    assert.deepEqual(out.pointers_refreshed, POINTER_FILES);
    assert.equal(out.pointers_written, undefined);
    for (const n of POINTER_FILES) assert.equal(blockCount(dir, n), 1);
  } finally { await f.close(); }
});

test("flagless learn that resurrects a deleted sibling SAYS so: pointers_written names the created file (QA repro)", async () => {
  // The silent half of the one-wired nuance (QA ruling, 2026-08-24): the
  // creation is defensible — the repo opted in once, and the measured lesson
  // says both files matter — but a CLAUDE.md deleted on purpose coming back
  // on every flagless learn, invisibly, forever, is the silent-green class
  // this codebase refuses everywhere else. Behavior stays; the JSON names
  // what materialized.
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await cliAsync(dir, "init", "--agents");
    execFileSync("rm", [join(dir, "CLAUDE.md")]);
    const out = JSON.parse(await cliAsync(dir, "learn", "--env", "local"));
    assert.equal(blockCount(dir, "CLAUDE.md"), 0, "a restored missing sibling uses a bridge without duplicating the block");
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
    assert.deepEqual(out.pointers_written, [{ file: "CLAUDE.md", action: "created" }],
      "what appeared on disk is named, nothing more");
    assert.deepEqual(out.pointers_refreshed, ["AGENTS.md"],
      "refreshed keeps its exact meaning: the block that pre-existed this run");
  } finally { await f.close(); }
});
